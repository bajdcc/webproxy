const
    fs = require('fs'),
    path = require('path'),
    Readable = require('stream').Readable;

const DATA = "data";

if (!fs.existsSync(DATA)) {
    fs.mkdirSync(DATA);
}

const SD = path.join(DATA, "send_data");

if (!fs.existsSync(SD)) {
    fs.mkdirSync(SD);
}

const RD = path.join(DATA, "recv_data");

if (!fs.existsSync(RD)) {
    fs.mkdirSync(RD);
}

const SS = path.join(DATA, "send_signal");

if (!fs.existsSync(SS)) {
    fs.mkdirSync(SS);
}

const RS = path.join(DATA, "recv_signal");

if (!fs.existsSync(RS)) {
    fs.mkdirSync(RS);
}

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

module.exports = {
    SD: SD,
    SS: SS,
    RD: RD,
    RS: RS,
    CommonReadableStream: CommonReadableStream,
    DEFAULT_CHUNK_COLLECT_THRESHOLD: DEFAULT_CHUNK_COLLECT_THRESHOLD
};