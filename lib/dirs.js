const
  fs = require('fs'),
  path = require('path');

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

module.exports = {
  SD: SD,
  SS: SS,
  RD: RD,
  RS: RS
};