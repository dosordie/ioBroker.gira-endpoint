"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeRequestKey = makeRequestKey;
exports.makeMinimalRequest = makeMinimalRequest;
exports.makeRequestKeys = makeRequestKeys;
function makeRequestKey(obj) {
    if (!obj || typeof obj !== "object")
        return String(obj);
    const keys = Object.keys(obj).sort();
    const sorted = {};
    for (const k of keys)
        sorted[k] = obj[k];
    return JSON.stringify(sorted);
}
function makeMinimalRequest(value) {
    const key = value?.key;
    const method = value?.method;
    if (key === undefined || method === undefined)
        return undefined;
    return { key, method };
}
function makeRequestKeys(value) {
    const keys = [makeRequestKey(value)];
    const minimalRequest = makeMinimalRequest(value);
    if (minimalRequest) {
        const minimalKey = makeRequestKey(minimalRequest);
        if (!keys.includes(minimalKey))
            keys.push(minimalKey);
    }
    return keys;
}
