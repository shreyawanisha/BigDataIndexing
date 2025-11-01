// store.js
const redis = require('./redis');

const N = {
    plan: 'plan',
    planservice: 'planservice',
    service: 'service',
    membercostshare: 'membercostshare',
};

const keyOf = (ns, id) => `${ns}:${id}`;

async function put(ns, id, data) {
  return redis.setData(keyOf(ns, id), data); // returns etag
}
async function get(ns, id) {
  return redis.getData(keyOf(ns, id)); // { data, etag } | null
}
async function exists(ns, id) {
    return redis.exists(keyOf(ns, id));
}
async function del(ns, id) {
    return redis.deleteData(keyOf(ns, id));
}

module.exports = { N, keyOf, put, get, exists, del };