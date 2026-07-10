"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEndpointAndMappingConfig = parseEndpointAndMappingConfig;
exports.parseAdapterConfig = parseAdapterConfig;
const valueConversion_1 = require("./valueConversion");
const archiveQuery_1 = require("./archiveQuery");
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
function parseArchiveConfig(cfg, helpers) {
    const archiveDescMap = new Map();
    const archiveQueryDefaults = new Map();
    const rawArchives = cfg.dataArchives;
    const archiveKeys = [];
    if (Array.isArray(rawArchives)) {
        for (const a of rawArchives) {
            if (typeof a === "object" && a) {
                if (a.enabled === false)
                    continue;
                const key = helpers.normalizeArchiveKey(String(a.key ?? "").trim());
                if (!key)
                    continue;
                const name = String(a.name ?? "").trim();
                if (name)
                    archiveDescMap.set(key, name);
                const params = {};
                const startat = String(a.startat ?? "").trim();
                const legacyStart = String(a.start ?? "").trim();
                if ((0, archiveQuery_1.isArchiveStartAt)(startat)) {
                    params.startat = startat;
                }
                else if ((0, archiveQuery_1.isArchiveStartAt)(legacyStart)) {
                    params.startat = legacyStart;
                }
                const cnt = Number(a.cnt);
                if (Number.isFinite(cnt))
                    params.cnt = cnt;
                const size = Number(a.size);
                if (Number.isFinite(size))
                    params.size = size;
                const cols = (0, archiveQuery_1.normalizeArchiveCols)(a.cols ?? a.columns);
                if (cols)
                    params.cols = cols;
                const rawLastCnt = Number(a.lastCnt);
                params.lastCnt = Number.isFinite(rawLastCnt) ? rawLastCnt : 50;
                const rawBlockSize = Number(a.blockSize);
                params.blockSize = Number.isFinite(rawBlockSize)
                    ? rawBlockSize
                    : params.size ?? 1;
                const mode = a.mode;
                params.mode = mode === "manual" || mode === "last"
                    ? mode
                    : a.lastCnt !== undefined || a.blockSize !== undefined
                        ? "last"
                        : "manual";
                archiveQueryDefaults.set(key, params);
                archiveKeys.push(key);
            }
            else {
                const key = helpers.normalizeArchiveKey(String(a).trim());
                if (!key)
                    continue;
                archiveKeys.push(key);
            }
        }
    }
    else {
        const arr = String(rawArchives ?? "")
            .split(/[,;\s]+/)
            .map((k) => k.trim())
            .filter((k) => k)
            .map((k) => helpers.normalizeArchiveKey(k));
        archiveKeys.push(...arr);
    }
    for (const key of archiveKeys) {
        if (!archiveDescMap.has(key))
            archiveDescMap.set(key, key);
    }
    return { archiveKeys, archiveDescMap, archiveQueryDefaults };
}
function parseAdapterConfig(cfg, helpers) {
    const endpointMapping = parseEndpointAndMappingConfig(cfg, helpers);
    const archiveConfig = parseArchiveConfig(cfg, helpers);
    return {
        ...endpointMapping,
        ...archiveConfig,
        connection: {
            host: String(cfg.host ?? "").trim(),
            port: Number(cfg.port ?? 80),
            ssl: Boolean(cfg.ssl ?? false),
            path: "/endpoints/ws",
            username: String(cfg.username ?? ""),
            password: String(cfg.password ?? ""),
            authHeader: Boolean(cfg.authHeader),
            pingIntervalMs: Number(cfg.pingIntervalMs ?? 30000),
            reconnect: cfg.reconnect,
            ca: cfg.ca,
            cert: cfg.cert,
            key: cfg.key,
            rejectUnauthorized: cfg.rejectUnauthorized,
        },
    };
}
