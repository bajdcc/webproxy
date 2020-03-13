const http = require('http'),
    https = require('https'),
    fs = require('fs'),
    path = require('path'),
    co = require('co'),
    color = require('colorful'),
    util = require('./lib/util'),
    zlib = require('zlib'),
    logUtil = require('./lib/log'),
    async = require('async'),
    brotliTorb = require('brotli'),
    { SD, SS, RD, RS, CommonReadableStream, DEFAULT_CHUNK_COLLECT_THRESHOLD } = require('./lib/dirs');


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
        //send request

        logUtil.printLog('req: ' + options.url);

        const proxyReq = (/https/i.test(protocol) ? https : http).request(options, (res) => {
            res.headers = util.getHeaderFromRawHeaders(res.rawHeaders);
            //deal response header
            const statusCode = res.statusCode;
            const resHeader = res.headers;
            let resDataChunks = []; // array of data chunks or stream
            const rawResChunks = []; // the original response chunks
            let resDataStream = null;
            let resSize = 0;

            logUtil.printLog('success: ' + options.url);

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
                        };

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
                        statusCode: statusCode,
                        header: resHeader,
                        body: serverResData
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
        proxyReq.end(Buffer.from(reqData.data));
    });
}

let read_ = {};

setTimeout(function rec() {
    fs.readdir(SS, (err, ds) => {
        if (err) {
            logUtil.printLog(color.green('err'));
            setTimeout(rec, 1000);
            return;
        }
        if (!ds.length) {
            //logUtil.printLog(color.green('waiting'));
            setTimeout(rec, 1000);
            return;
        }
        setTimeout(rec, 2000);
        async.mapLimit(ds, 100, function(file, callback) {
            if (read_[file]) return;
            read_[file] = true;
            setTimeout(() => {
                if (read_[file]) delete read_[file];
            }, 3000);
            logUtil.printLog('watch: ' + file);
            fs.unlink(path.join(SS, file), () => null);
            co(() => new Promise((resolve, reject) => {
                fs.readFile(path.join(SD, file), (err, data) => {
                    fs.unlink(path.join(SD, file), () => null);
                    logUtil.printLog('read: ' + file);
                    if (err) return reject(err);
                    try {
                        const obj = JSON.parse(Buffer.from(data).toString('utf-8'));
                        resolve(obj);
                    } catch (err) {
                        reject(err);
                    }
                });
            })).then(co.wrap(function*(userConfig) {
                logUtil.printLog('fetch: ' + userConfig.options.url);
                return yield fetchRemoteResponse(userConfig.protocol, userConfig.options, userConfig.reqData, userConfig.config);
            })).then(_data => new Promise((_resolve, _reject) => {
                logUtil.printLog('success: ' + file);
                fs.writeFile(path.join(RD, file), JSON.stringify(_data), (err, data) => {
                    if (err) return _reject(err);
                    _resolve(data);
                });
            })).then(_data => new Promise((_resolve, _reject) => {
                fs.writeFile(path.join(RS, file), "", (err, data) => {
                    if (err) return _reject(err);
                    _resolve(data);
                });
            })).then(_data => new Promise((_resolve, _reject) => {
                callback();
            })).catch(err => {
                logUtil.printLog(color.green('err: ' + err));
                callback();
            });
        }, function(err, result) {});
    });
}, 1000);