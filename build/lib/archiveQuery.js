"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isArchiveStartAt = isArchiveStartAt;
exports.normalizeArchiveCols = normalizeArchiveCols;
exports.normalizeArchiveQuery = normalizeArchiveQuery;
exports.formatArchiveStartAt = formatArchiveStartAt;
exports.buildLastArchiveQuery = buildLastArchiveQuery;
const STARTAT_RE = /^\d{10}$/;
function isArchiveStartAt(value) {
    return typeof value === "string" && STARTAT_RE.test(value.trim());
}
function normalizeArchiveCols(value) {
    if (Array.isArray(value)) {
        const cols = value.map((c) => String(c).trim()).filter(Boolean);
        return cols.length ? cols : undefined;
    }
    if (typeof value === "string") {
        const cols = value
            .split(/[,;\s]+/)
            .map((c) => c.trim())
            .filter(Boolean);
        return cols.length ? cols : undefined;
    }
    return undefined;
}
function toNumber(value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}
function normalizeArchiveQuery(raw) {
    const query = {};
    if (!raw || typeof raw !== "object")
        return query;
    const startat = String(raw.startat ?? "").trim();
    if (isArchiveStartAt(startat)) {
        query.startat = startat;
    }
    else if (isArchiveStartAt(raw.start)) {
        query.startat = String(raw.start).trim();
    }
    const cnt = toNumber(raw.cnt);
    if (cnt !== undefined)
        query.cnt = cnt;
    const size = toNumber(raw.size);
    if (size !== undefined)
        query.size = size;
    const cols = normalizeArchiveCols(raw.cols ?? raw.columns);
    if (cols)
        query.cols = cols;
    return query;
}
function pad2(value) {
    return String(value).padStart(2, "0");
}
function formatArchiveStartAt(date) {
    return `${pad2(date.getFullYear() % 100)}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}
function parseMetaLast(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime()))
        return value;
    if (typeof value === "number" && Number.isFinite(value)) {
        const millis = value < 1e12 ? value * 1000 : value;
        const date = new Date(millis);
        return Number.isNaN(date.getTime()) ? undefined : date;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed)
            return undefined;
        if (/^\d+$/.test(trimmed))
            return parseMetaLast(Number(trimmed));
        const date = new Date(trimmed);
        return Number.isNaN(date.getTime()) ? undefined : date;
    }
    return undefined;
}
function buildLastArchiveQuery(meta, cnt, size, cols) {
    const last = parseMetaLast(meta?.data?.stat?.last ?? meta?.stat?.last);
    if (!last)
        return undefined;
    const start = new Date(last.getTime() - cnt * size * 60 * 1000);
    const query = {
        startat: formatArchiveStartAt(start),
        cnt,
        size,
    };
    if (cols && cols.length)
        query.cols = cols;
    return query;
}
