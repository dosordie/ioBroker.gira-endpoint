"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEQUENCE_ACTION_METHODS = exports.SCENE_ACTION_METHODS = exports.sanitizeSequenceId = exports.sanitizeSceneId = exports.normalizeSequenceKey = exports.normalizeSceneKey = void 0;
exports.extractRunning = extractRunning;
exports.extractTimestamp = extractTimestamp;
exports.isSceneModified = isSceneModified;
exports.getScenePushRefreshMethod = getScenePushRefreshMethod;
function normalize(raw, prefix) {
    const suffix = String(raw ?? "").trim().replace(new RegExp(`^${prefix}`, "i"), "");
    return suffix ? `${prefix}${suffix.toUpperCase()}` : "";
}
function sanitize(raw, prefix) {
    return normalize(raw, prefix).slice(3).replace(/[^a-z0-9@_-]/gi, "_");
}
const normalizeSceneKey = (key) => normalize(key, "SC@");
exports.normalizeSceneKey = normalizeSceneKey;
const normalizeSequenceKey = (key) => normalize(key, "SQ@");
exports.normalizeSequenceKey = normalizeSequenceKey;
const sanitizeSceneId = (key) => sanitize(key, "SC@");
exports.sanitizeSceneId = sanitizeSceneId;
const sanitizeSequenceId = (key) => sanitize(key, "SQ@");
exports.sanitizeSequenceId = sanitizeSequenceId;
exports.SCENE_ACTION_METHODS = {
    call: "call",
    learn: "learn",
    offsetPlus: "offset_plus",
    offsetMinus: "offset_minus",
    listNext: "list_next",
    listPrevious: "list_prev",
};
exports.SEQUENCE_ACTION_METHODS = {
    start: "start",
    stop: "stop",
};
function extractRunning(value) {
    const candidate = value?.running ?? value?.state?.running ?? value?.data?.running;
    return typeof candidate === "boolean" ? candidate : undefined;
}
function extractTimestamp(value) {
    const candidate = value?.ts ?? value?.timestamp ?? value?.modifiedAt ?? value?.data?.ts;
    if (candidate === null || candidate === undefined || String(candidate).trim() === "")
        return undefined;
    const number = Number(candidate);
    if (!Number.isFinite(number) || number < 0)
        return undefined;
    // Gira normally uses Unix seconds (including fractional seconds), while
    // ioBroker's value.time role expects JavaScript milliseconds.
    return Math.round(number < 1000000000000 ? number * 1000 : number);
}
function isSceneModified(value) {
    return value?.modified === true || value?.data?.modified === true;
}
function getScenePushRefreshMethod(value) {
    return isSceneModified(value) ? "get_items" : undefined;
}
