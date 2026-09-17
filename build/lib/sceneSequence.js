"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEQUENCE_ACTION_METHODS = exports.SCENE_ACTION_METHODS = exports.sanitizeSequenceId = exports.sanitizeSceneId = exports.normalizeSequenceKey = exports.normalizeSceneKey = void 0;
exports.extractRunning = extractRunning;
exports.extractTimestamp = extractTimestamp;
function normalize(raw, prefix) {
    const suffix = String(raw ?? "").trim().replace(new RegExp(`^${prefix}`, "i"), "");
    return suffix ? `${prefix}${suffix}` : "";
}
function sanitize(raw, prefix) {
    return normalize(raw, prefix).slice(3).replace(/[^a-z0-9@_.-]/gi, "_");
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
    const number = Number(candidate);
    return Number.isFinite(number) ? number : undefined;
}
