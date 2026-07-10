"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEndpointAndMappingConfig = parseEndpointAndMappingConfig;
const valueConversion_1 = require("./valueConversion");
function rememberKeyCase(keyCaseMap, normalized, original) {
    if (!normalized)
        return;
    const trimmed = String(original ?? "").trim();
    if (!trimmed)
        return;
    const suffix = trimmed.replace(/^CO@/i, "");
    keyCaseMap.set(normalized, `CO@${suffix}`);
}
function sanitizeEndpointId(s) {
    return s.replace(/^CO@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_");
}
function makeCasePreservedEndpointBaseId(key, keyCaseMap, fallback) {
    const casedKey = keyCaseMap.get(key);
    if (!casedKey)
        return fallback(key);
    return `CO@.${sanitizeEndpointId(casedKey)}`;
}
function parseEndpointAndMappingConfig(cfg, helpers) {
    const boolKeys = new Set();
    const skipInitialUpdate = new Set();
    const updateOnStartSources = [];
    const keyTextEncodingMap = new Map();
    const keyDescMap = new Map();
    const keyCaseMap = new Map();
    const rawKeys = Array.isArray(cfg.endpointGroups)
        ? cfg.endpointGroups.flatMap((g) => Array.isArray(g?.keys) ? g.keys : [])
        : cfg.endpointKeys;
    const endpointKeys = [];
    if (Array.isArray(rawKeys)) {
        for (const k of rawKeys) {
            if (typeof k === "object" && k) {
                if (k.enabled === false)
                    continue;
                const rawKey = String(k.key ?? "").trim();
                const key = helpers.normalizeKey(rawKey);
                if (!key)
                    continue;
                rememberKeyCase(keyCaseMap, key, rawKey || key);
                const name = String(k.name ?? "").trim();
                if (name)
                    keyDescMap.set(key, name);
                const bool = Boolean(k.bool);
                if (bool)
                    boolKeys.add(key);
                const textEncoding = (0, valueConversion_1.normalizeTextEncoding)(k.textEncoding);
                keyTextEncodingMap.set(key, textEncoding);
                const updateOnStart = k.updateOnStart !== false;
                if (!updateOnStart)
                    skipInitialUpdate.add(key);
                if (updateOnStart) {
                    const baseId = makeCasePreservedEndpointBaseId(key, keyCaseMap, helpers.makeEndpointBaseId);
                    updateOnStartSources.push({
                        key,
                        stateId: `${baseId}.value`,
                        bool,
                        foreign: false,
                        textEncoding,
                    });
                }
                endpointKeys.push(key);
            }
            else {
                const rawKey = String(k).trim();
                const key = helpers.normalizeKey(rawKey);
                if (!key)
                    continue;
                rememberKeyCase(keyCaseMap, key, rawKey || key);
                endpointKeys.push(key);
            }
        }
    }
    else {
        const arr = String(rawKeys ?? "")
            .split(/[,;\s]+/)
            .map((k) => k.trim())
            .filter((k) => k);
        for (const rawKey of arr) {
            const key = helpers.normalizeKey(rawKey);
            if (!key)
                continue;
            rememberKeyCase(keyCaseMap, key, rawKey);
            endpointKeys.push(key);
        }
    }
    const forwardMap = new Map();
    const reverseMap = new Map();
    const mappingGroups = Array.isArray(cfg.mappingGroups)
        ? cfg.mappingGroups
        : Array.isArray(cfg.mappings)
            ? [{ mappings: cfg.mappings }]
            : [];
    for (const g of mappingGroups) {
        if (!g || typeof g !== "object")
            continue;
        const list = g.mappings;
        if (!Array.isArray(list))
            continue;
        for (const m of list) {
            if (typeof m !== "object" || !m)
                continue;
            if (m.enabled === false)
                continue;
            const stateId = String(m.stateId ?? "").trim();
            const rawKey = String(m.key ?? "").trim();
            const key = helpers.normalizeKey(rawKey);
            if (!stateId || !key)
                continue;
            rememberKeyCase(keyCaseMap, key, rawKey || key);
            const name = String(m.name ?? "").trim();
            if (name)
                keyDescMap.set(key, name);
            const toEndpoint = m.toEndpoint !== false;
            const toState = Boolean(m.toState);
            const bool = Boolean(m.bool);
            const ack = m.ack !== false;
            const textEncoding = (0, valueConversion_1.normalizeTextEncoding)(m.textEncoding);
            if (!keyTextEncodingMap.has(key)) {
                keyTextEncodingMap.set(key, textEncoding);
            }
            const updateOnStart = m.updateOnStart !== false;
            if (!updateOnStart)
                skipInitialUpdate.add(key);
            if (toEndpoint) {
                forwardMap.set(stateId, { key, bool, textEncoding });
                if (bool)
                    boolKeys.add(key);
                if (updateOnStart) {
                    updateOnStartSources.push({
                        key,
                        stateId,
                        bool,
                        foreign: true,
                        textEncoding,
                    });
                }
            }
            if (toState) {
                reverseMap.set(key, { stateId, bool, ack });
                if (bool)
                    boolKeys.add(key);
            }
            if (!endpointKeys.includes(key))
                endpointKeys.push(key);
        }
    }
    const uniqueSources = new Map();
    for (const src of updateOnStartSources) {
        const key = `${src.key}|${src.stateId}|${src.foreign ? "1" : "0"}`;
        if (!uniqueSources.has(key))
            uniqueSources.set(key, src);
    }
    return {
        endpointKeys,
        forwardMap,
        reverseMap,
        boolKeys,
        keyTextEncodingMap,
        keyDescMap,
        keyCaseMap,
        skipInitialUpdate,
        updateOnStartSources: Array.from(uniqueSources.values()),
    };
}
