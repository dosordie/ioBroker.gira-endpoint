"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPERIMENTAL_MESSAGE_ARCHIVE_METHODS = void 0;
exports.extractMessageArchiveTokens = extractMessageArchiveTokens;
exports.getMessageArchiveItems = getMessageArchiveItems;
exports.sanitizeArchiveId = sanitizeArchiveId;
exports.getMessageArchiveEntryKey = getMessageArchiveEntryKey;
exports.getLatestMessageArchiveItem = getLatestMessageArchiveItem;
exports.getLastMessageArchiveState = getLastMessageArchiveState;
exports.getMessageArchiveEventItems = getMessageArchiveEventItems;
exports.messageArchiveEntryFingerprint = messageArchiveEntryFingerprint;
exports.findNewMessageArchiveItems = findNewMessageArchiveItems;
exports.buildMessageArchiveWriteRequest = buildMessageArchiveWriteRequest;
exports.messageArchiveWriteCreated = messageArchiveWriteCreated;
exports.getMessageArchiveSubscriptionKey = getMessageArchiveSubscriptionKey;
exports.buildSubscriptionKeys = buildSubscriptionKeys;
exports.isMessageArchiveKey = isMessageArchiveKey;
exports.EXPERIMENTAL_MESSAGE_ARCHIVE_METHODS = [
    "add",
    "write",
    "insert",
    "set",
    "add_entry",
    "add_message",
    "trigger",
    "call",
];
function extractMessageArchiveTokens(meta) {
    const tokens = new Set();
    const visit = (value, key) => {
        if (value === null || value === undefined)
            return;
        if (key === "token" && (typeof value === "string" || typeof value === "number")) {
            const token = String(value).trim();
            if (token)
                tokens.add(token);
        }
        if (key === "tokens") {
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (typeof item === "string" || typeof item === "number") {
                        const token = String(item).trim();
                        if (token)
                            tokens.add(token);
                    }
                }
            }
            else if (value && typeof value === "object") {
                for (const token of Object.keys(value))
                    if (token.trim())
                        tokens.add(token.trim());
            }
        }
        if (Array.isArray(value)) {
            for (const item of value)
                visit(item);
        }
        else if (typeof value === "object") {
            for (const [childKey, child] of Object.entries(value))
                visit(child, childKey);
        }
    };
    visit(meta);
    return Array.from(tokens);
}
function getMessageArchiveItems(response) {
    const candidates = [response?.data?.items, response?.items, response?.data?.data?.items, response?.data];
    return candidates.find(Array.isArray) ?? [];
}
function sanitizeArchiveId(value) {
    return value.replace(/^(DA|MA)@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
}
function getMessageArchiveEntryKey(item) {
    const value = item?.key ?? item?.token;
    if (value === undefined || value === null)
        return undefined;
    return String(value);
}
function getLatestMessageArchiveItem(items) {
    return items.reduce((latest, item) => {
        const timestamp = Number(item?.ts);
        if (!Number.isFinite(timestamp))
            return latest;
        return !latest || timestamp > Number(latest.ts) ? item : latest;
    }, undefined);
}
function getLastMessageArchiveState(items) {
    const item = getLatestMessageArchiveItem(items);
    if (!item)
        return undefined;
    const key = getMessageArchiveEntryKey(item);
    const timestamp = Number(item.ts);
    return {
        ...(key !== undefined ? { key } : {}),
        ...(item.text !== undefined && item.text !== null ? { text: String(item.text) } : {}),
        ...(Number.isFinite(timestamp)
            ? { ts: timestamp, time: new Date(timestamp * 1000).toLocaleString() }
            : {}),
    };
}
function getMessageArchiveEventItems(payload) {
    const items = getMessageArchiveItems(payload);
    if (items.length)
        return items;
    const candidates = [payload?.data?.item, payload?.data?.stat, payload?.data?.data, payload?.data, payload?.item, payload];
    return candidates.filter((item) => item && typeof item === "object" && !Array.isArray(item) &&
        getMessageArchiveEntryKey(item) !== undefined && (item.text !== undefined || item.ts !== undefined));
}
function messageArchiveEntryFingerprint(item) {
    return JSON.stringify({ ts: item?.ts, key: getMessageArchiveEntryKey(item), text: item?.text });
}
function findNewMessageArchiveItems(beforeResponse, afterResponse) {
    const beforeCounts = new Map();
    for (const item of getMessageArchiveItems(beforeResponse)) {
        const fingerprint = messageArchiveEntryFingerprint(item);
        beforeCounts.set(fingerprint, (beforeCounts.get(fingerprint) ?? 0) + 1);
    }
    return getMessageArchiveItems(afterResponse).filter((item) => {
        const fingerprint = messageArchiveEntryFingerprint(item);
        const count = beforeCounts.get(fingerprint) ?? 0;
        if (count <= 0)
            return true;
        beforeCounts.set(fingerprint, count - 1);
        return false;
    });
}
function buildMessageArchiveWriteRequest(key, method, token) {
    return { type: "call", param: { key, method, token } };
}
function messageArchiveWriteCreated(beforeResponse, afterResponse, token) {
    return findNewMessageArchiveItems(beforeResponse, afterResponse)
        .some((item) => getMessageArchiveEntryKey(item) === token);
}
/** Returns the configured MA key when a response/event belongs to an MA subscription. */
function getMessageArchiveSubscriptionKey(payload, configuredKeys) {
    const configured = new Map(configuredKeys.map((key) => [key.toLowerCase(), key]));
    const direct = payload?.subscription?.key ?? payload?.data?.key ?? payload?.data?.uid;
    if (direct !== undefined) {
        const match = configured.get(String(direct).toLowerCase());
        if (match)
            return match;
    }
    const requestKeys = payload?.request?.param?.keys ?? payload?.request?.keys;
    if (Array.isArray(requestKeys)) {
        const matches = requestKeys.map((key) => configured.get(String(key).toLowerCase())).filter(Boolean);
        if (matches.length === requestKeys.length && matches.length > 0)
            return matches[0];
    }
    return undefined;
}
/** Builds the single, de-duplicated key list used for a connection cycle. */
function buildSubscriptionKeys(endpointKeys, messageArchiveKeys) {
    const result = new Map();
    for (const key of [...endpointKeys, ...messageArchiveKeys]) {
        const trimmed = String(key ?? "").trim();
        if (trimmed && !result.has(trimmed.toLowerCase()))
            result.set(trimmed.toLowerCase(), trimmed);
    }
    return Array.from(result.values());
}
function isMessageArchiveKey(key, configuredKeys) {
    if (key === undefined || key === null)
        return false;
    const candidate = String(key).toLowerCase();
    return configuredKeys.some((configured) => configured.toLowerCase() === candidate);
}
