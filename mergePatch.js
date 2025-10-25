function isObj(x){ return x && typeof x==='object' && !Array.isArray(x); }
function applyMergePatch(target, patch){
    if (!isObj(patch)) return patch;
    if (!isObj(target)) target = {};
    const out = { ...target };
    for (const [k,v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = applyMergePatch(out[k], v);
    else out[k] = v;
    }
    return out;
}
module.exports = { applyMergePatch };