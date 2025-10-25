const crypto = require('crypto');

function httpDate(d = new Date()) { return d.toUTCString(); }
function etagFor(obj) { return `W/"${crypto.createHash('sha256').update(JSON.stringify(obj)).digest('base64url')}"`; }

function setMetaHeaders(res, payload) {
    res.set('ETag', etagFor(payload));
    res.set('Last-Modified', httpDate());
    res.set('Cache-Control', 'no-cache');
}

module.exports = { httpDate, etagFor, setMetaHeaders };