"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeUidValue = encodeUidValue;
exports.decodeAckValue = decodeAckValue;
const utils = __importStar(require("@iobroker/adapter-core"));
const GiraClient_1 = require("./lib/GiraClient");
function encodeUidValue(val, boolMode) {
    let method = "set";
    let uidValue = val;
    let ackVal = val;
    if (boolMode) {
        if (typeof uidValue === "boolean") {
            ackVal = uidValue;
            uidValue = uidValue ? "1" : "0";
        }
        else if (typeof uidValue === "number") {
            ackVal = uidValue !== 0;
            uidValue = uidValue ? "1" : "0";
        }
        else if (typeof uidValue === "string") {
            if (uidValue === "true" || uidValue === "false") {
                ackVal = uidValue === "true";
                uidValue = ackVal ? "1" : "0";
            }
            else if (uidValue === "toggle") {
                uidValue = "1";
                method = "toggle";
            }
            else if (!isNaN(Number(uidValue))) {
                const num = Number(uidValue);
                ackVal = num !== 0;
                uidValue = num ? "1" : "0";
            }
            else {
                ackVal = uidValue;
                uidValue = Buffer.from(uidValue, "utf8").toString("base64");
            }
        }
    }
    else {
        if (typeof uidValue === "boolean") {
            ackVal = uidValue ? 1 : 0;
            uidValue = uidValue ? "1" : "0";
        }
        else if (typeof uidValue === "string") {
            if (uidValue === "true" || uidValue === "false") {
                ackVal = uidValue === "true" ? 1 : 0;
                uidValue = uidValue === "true" ? "1" : "0";
            }
            else if (uidValue === "toggle") {
                uidValue = "1";
                method = "toggle";
            }
            else if (isNaN(Number(uidValue))) {
                uidValue = Buffer.from(uidValue, "utf8").toString("base64");
            }
        }
    }
    return { uidValue: String(uidValue), ackVal, method };
}
function decodeAckValue(val, boolMode) {
    if (boolMode) {
        if (typeof val === "number")
            return { value: val !== 0, type: "boolean" };
        if (typeof val === "string")
            return { value: val !== "0", type: "boolean" };
        return { value: Boolean(val), type: "boolean" };
    }
    else {
        if (typeof val === "boolean")
            return { value: val ? 1 : 0, type: "number" };
        if (typeof val === "number")
            return { value: val, type: "number" };
        if (typeof val === "string")
            return { value: val, type: "string" };
        return { value: val, type: "mixed" };
    }
}
class GiraEndpointAdapter extends utils.Adapter {
    notifyAdmin(message) {
        this.sendTo("admin", "messageBox", {
            title: "gira-endpoint",
            message,
        });
    }
    constructor(options = {}) {
        super({
            ...options,
            name: "gira-endpoint",
        });
        this.endpointKeys = [];
        this.keyIdMap = new Map();
        this.idKeyMap = new Map();
        this.keyDescMap = new Map();
        this.forwardMap = new Map();
        this.reverseMap = new Map();
        this.boolKeys = new Set();
        this.suppressStateChange = new Set();
        this.pendingUpdates = new Map();
        this.skipInitialUpdate = new Set();
        this.pendingSubscriptions = new Set();
        this.archiveKeys = [];
        this.archiveKeyIdMap = new Map();
        this.archiveIdKeyMap = new Map();
        this.archiveDescMap = new Map();
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }
    async onReady() {
        try {
            await this.setObjectNotExistsAsync("info", {
                type: "channel",
                common: { name: "Info" },
                native: {},
            });
            await this.setObjectNotExistsAsync("info.connection", {
                type: "state",
                common: {
                    name: "Connection",
                    type: "boolean",
                    role: "indicator.connected",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync("info.lastError", {
                type: "state",
                common: { name: "Last error", type: "string", role: "text", read: true, write: false },
                native: {},
            });
            await this.setObjectNotExistsAsync("info.lastEvent", {
                type: "state",
                common: { name: "Last event", type: "string", role: "json", read: true, write: false },
                native: {},
            });
            await this.setStateAsync("info.connection", { val: false, ack: true });
            this.log.debug("Pre-created info states");
            await this.setObjectNotExistsAsync("CO@", {
                type: "channel",
                common: { name: "CO@" },
                native: {},
            });
            await this.setObjectNotExistsAsync("DA@", {
                type: "channel",
                common: { name: "DA@" },
                native: {},
            });
            const cfg = this.config;
            const host = String(cfg.host ?? "").trim();
            const port = Number(cfg.port ?? 80);
            const ssl = Boolean(cfg.ssl ?? false);
            const path = "/endpoints/ws";
            const username = String(cfg.username ?? "");
            const password = String(cfg.password ?? "");
            const authHeader = Boolean(cfg.authHeader);
            const pingIntervalMs = Number(cfg.pingIntervalMs ?? 30000);
            const boolKeys = new Set();
            const skipInitial = new Set();
            const rawKeys = cfg.endpointKeys;
            const endpointKeys = [];
            if (Array.isArray(rawKeys)) {
                for (const k of rawKeys) {
                    if (typeof k === "object" && k) {
                        const key = this.normalizeKey(String(k.key ?? "").trim());
                        if (!key)
                            continue;
                        const name = String(k.name ?? "").trim();
                        if (name)
                            this.keyDescMap.set(key, name);
                        const bool = Boolean(k.bool);
                        if (bool)
                            boolKeys.add(key);
                        const updateOnStart = k.updateOnStart !== false;
                        if (!updateOnStart)
                            skipInitial.add(key);
                        endpointKeys.push(key);
                    }
                    else {
                        const key = this.normalizeKey(String(k).trim());
                        if (!key)
                            continue;
                        endpointKeys.push(key);
                    }
                }
            }
            else {
                const arr = String(rawKeys ?? "")
                    .split(/[,;\s]+/)
                    .map((k) => k.trim())
                    .filter((k) => k)
                    .map((k) => this.normalizeKey(k));
                endpointKeys.push(...arr);
            }
            const forwardMap = new Map();
            const reverseMap = new Map();
            if (Array.isArray(cfg.mappings)) {
                for (const m of cfg.mappings) {
                    if (typeof m !== "object" || !m)
                        continue;
                    const stateId = String(m.stateId ?? "").trim();
                    const key = this.normalizeKey(String(m.key ?? "").trim());
                    if (!stateId || !key)
                        continue;
                    const name = String(m.name ?? "").trim();
                    if (name)
                        this.keyDescMap.set(key, name);
                    const toEndpoint = m.toEndpoint !== false;
                    const toState = Boolean(m.toState);
                    const bool = Boolean(m.bool);
                    const updateOnStart = m.updateOnStart !== false;
                    if (!updateOnStart)
                        skipInitial.add(key);
                    if (toEndpoint) {
                        forwardMap.set(stateId, { key, bool });
                        if (bool)
                            boolKeys.add(key);
                    }
                    if (toState) {
                        reverseMap.set(key, { stateId, bool });
                        if (bool)
                            boolKeys.add(key);
                    }
                    if (!endpointKeys.includes(key))
                        endpointKeys.push(key);
                }
            }
            this.forwardMap = forwardMap;
            this.reverseMap = reverseMap;
            this.boolKeys = boolKeys;
            this.skipInitialUpdate = skipInitial;
            const rawArchives = cfg.dataArchives;
            const archiveKeys = [];
            if (Array.isArray(rawArchives)) {
                for (const a of rawArchives) {
                    if (typeof a === "object" && a) {
                        const key = this.normalizeArchiveKey(String(a.key ?? "").trim());
                        if (!key)
                            continue;
                        const name = String(a.name ?? "").trim();
                        if (name)
                            this.archiveDescMap.set(key, name);
                        archiveKeys.push(key);
                    }
                    else {
                        const key = this.normalizeArchiveKey(String(a).trim());
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
                    .map((k) => this.normalizeArchiveKey(k));
                archiveKeys.push(...arr);
            }
            for (const key of archiveKeys) {
                if (!this.archiveDescMap.has(key))
                    this.archiveDescMap.set(key, key);
            }
            this.archiveKeys = archiveKeys;
            for (const key of endpointKeys) {
                if (!this.keyDescMap.has(key))
                    this.keyDescMap.set(key, key);
            }
            this.endpointKeys = endpointKeys;
            this.log.info(`Configured endpoint keys: ${this.endpointKeys.length ? this.endpointKeys.join(", ") : "(none)"}`);
            this.log.info(`Configured data archive keys: ${this.archiveKeys.length ? this.archiveKeys.join(", ") : "(none)"}`);
            if (this.forwardMap.size) {
                this.log.info(`Configured forward mappings: ${Array.from(this.forwardMap.entries())
                    .map(([s, m]) => `${s}→${m.key}`)
                    .join(", ")}`);
                for (const stateId of this.forwardMap.keys()) {
                    this.subscribeForeignStates(stateId);
                }
            }
            if (this.reverseMap.size) {
                this.log.info(`Configured reverse mappings: ${Array.from(this.reverseMap.entries())
                    .map(([k, m]) => `${k}→${m.stateId}`)
                    .join(", ")}`);
            }
            // Pre-create configured endpoint states so they appear immediately in ioBroker
            for (const key of new Set(this.endpointKeys)) {
                const baseId = `CO@.${this.sanitizeId(key)}`;
                this.keyIdMap.set(key, baseId);
                this.idKeyMap.set(baseId, key);
                const name = this.keyDescMap.get(key) || key;
                await this.setObjectNotExistsAsync(baseId, {
                    type: "channel",
                    common: { name },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.value`, {
                    type: "state",
                    common: { name: "value", type: "mixed", role: "state", read: true, write: true },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.subscription`, {
                    type: "state",
                    common: {
                        name: "subscription",
                        type: "boolean",
                        role: "indicator",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                await this.setStateAsync(`${baseId}.subscription`, { val: false, ack: true });
                await this.setObjectNotExistsAsync(`${baseId}.status`, {
                    type: "state",
                    common: { name: "status", type: "string", role: "state", read: true, write: true },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.meta`, {
                    type: "state",
                    common: { name: "meta", type: "string", role: "json", read: true, write: true },
                    native: {},
                });
                this.log.debug(`Pre-created endpoint channel ${baseId}`);
                this.subscribeStates(`${baseId}.value`);
            }
            for (const key of new Set(this.archiveKeys)) {
                const baseId = `DA@.${this.sanitizeArchiveId(key)}`;
                this.archiveKeyIdMap.set(key, baseId);
                this.archiveIdKeyMap.set(baseId, key);
                const name = this.archiveDescMap.get(key) || key;
                await this.setObjectNotExistsAsync(baseId, {
                    type: "channel",
                    common: { name },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.meta`, {
                    type: "state",
                    common: { name: "meta", type: "string", role: "json", read: true, write: true },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.query`, {
                    type: "state",
                    common: { name: "query", type: "string", role: "json", read: true, write: true },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.data`, {
                    type: "state",
                    common: { name: "data", type: "string", role: "json", read: true, write: false },
                    native: {},
                });
                this.subscribeStates(`${baseId}.meta`);
                this.subscribeStates(`${baseId}.query`);
            }
            const validBaseIds = new Set(this.endpointKeys.map((k) => `CO@.${this.sanitizeId(k)}`));
            const validArchiveBases = new Set(this.archiveKeys.map((k) => `DA@.${this.sanitizeArchiveId(k)}`));
            const objs = await this.getAdapterObjectsAsync();
            for (const fullId of Object.keys(objs)) {
                const id = fullId.startsWith(this.namespace + ".")
                    ? fullId.slice(this.namespace.length + 1)
                    : fullId;
                if (id.startsWith("CO@.")) {
                    const base = id.split(".").slice(0, 2).join(".");
                    if (!validBaseIds.has(base)) {
                        const msg = `Deleting stale endpoint state ${id}`;
                        this.log.info(msg);
                        this.notifyAdmin(msg);
                        await this.delObjectAsync(id, { recursive: true });
                    }
                }
                else if (id.startsWith("DA@.")) {
                    const base = id.split(".").slice(0, 2).join(".");
                    if (!validArchiveBases.has(base)) {
                        const msg = `Deleting stale data archive state ${id}`;
                        this.log.info(msg);
                        this.notifyAdmin(msg);
                        await this.delObjectAsync(id, { recursive: true });
                    }
                }
                else if (id.startsWith("info.subscriptions")) {
                    const msg = `Deleting legacy subscription state ${id}`;
                    this.log.info(msg);
                    this.notifyAdmin(msg);
                    await this.delObjectAsync(id, { recursive: true });
                }
                else if (id.startsWith("objekte.")) {
                    const msg = `Deleting legacy object ${id}`;
                    this.log.info(msg);
                    this.notifyAdmin(msg);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
            try {
                const msg = 'Deleting legacy object root "objekte"';
                this.log.info(msg);
                this.notifyAdmin(msg);
                await this.delObjectAsync("objekte", { recursive: true });
            }
            catch {
                /* ignore */
            }
            const ca = cfg.ca ? String(cfg.ca) : undefined;
            const cert = cfg.cert ? String(cfg.cert) : undefined;
            const key = cfg.key ? String(cfg.key) : undefined;
            const rejectUnauthorized = cfg.rejectUnauthorized !== undefined ? Boolean(cfg.rejectUnauthorized) : undefined;
            const tls = { ca, cert, key, rejectUnauthorized };
            // Instantiate client once with all relevant options
            this.client = new GiraClient_1.GiraClient({
                host,
                port,
                ssl,
                path,
                username,
                password,
                authHeader,
                pingIntervalMs,
                reconnect: {
                    minMs: cfg.reconnect?.minMs ?? 1000,
                    maxMs: cfg.reconnect?.maxMs ?? 30000,
                },
                tls,
            });
            this.client.on("open", () => {
                this.log.info(`Connected to ${ssl ? "wss" : "ws"}://${host}:${port}${path}`);
                this.setState("info.connection", true, true);
                if (this.endpointKeys.length) {
                    this.pendingSubscriptions = new Set(this.endpointKeys.map((k) => this.normalizeKey(k)));
                    this.client.subscribe(this.endpointKeys);
                }
                else {
                    this.log.info("Subscribing to all endpoint events (no keys configured)");
                    this.pendingSubscriptions.clear();
                    this.client.subscribe([]);
                }
            });
            this.client.on("close", (info) => {
                this.log.warn(`Connection closed (${info?.code || "?"}) ${info?.reason || ""}`);
                this.setState("info.connection", false, true);
                this.getStatesAsync("CO@.*.subscription").then((states) => {
                    for (const id of Object.keys(states)) {
                        this.setState(id, { val: false, ack: true });
                    }
                }).catch(() => { });
            });
            this.client.on("error", (err) => {
                const msg = `Client error: ${err?.message || err}`;
                this.log.error(msg);
                this.setState("info.lastError", String(err?.message || err), true);
                this.notifyAdmin(msg);
            });
            this.client.on("event", async (payload) => {
                // Provide full event information for debugging
                this.log.debug(`Received event: ${JSON.stringify(payload)}`);
                if (this.config.updateLastEvent) {
                    await this.setStateAsync("info.lastEvent", {
                        val: JSON.stringify(payload),
                        ack: true,
                    });
                }
                const data = payload?.data;
                if (!data)
                    return;
                if (payload.type === "unsubscribe" && Array.isArray(data.items)) {
                    for (const item of data.items) {
                        if (!item)
                            continue;
                        const key = item.uid !== undefined
                            ? String(item.uid)
                            : item.key !== undefined
                                ? String(item.key)
                                : undefined;
                        if (key === undefined)
                            continue;
                        const normalized = this.normalizeKey(key);
                        const baseId = this.keyIdMap.get(normalized) ?? `CO@.${this.sanitizeId(normalized)}`;
                        this.keyIdMap.set(normalized, baseId);
                        this.idKeyMap.set(baseId, normalized);
                        await this.extendObjectAsync(baseId, {
                            type: "channel",
                            common: { name: this.keyDescMap.get(normalized) || normalized },
                            native: {},
                        });
                        const subId = `${baseId}.subscription`;
                        await this.extendObjectAsync(subId, {
                            type: "state",
                            common: {
                                name: "subscription",
                                type: "boolean",
                                role: "indicator",
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(subId, { val: false, ack: true });
                        if (item.code !== undefined && item.code !== 0) {
                            const msg = `Unsubscribe failed for ${normalized} (${item.code})`;
                            this.log.warn(msg);
                            this.notifyAdmin(msg);
                        }
                    }
                    return;
                }
                const entries = [];
                // Case 1: subscription result lists multiple items
                if (typeof data === "object" && Array.isArray(data.items)) {
                    const received = new Set();
                    for (const item of data.items) {
                        if (!item)
                            continue;
                        const key = item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
                        if (key === undefined)
                            continue;
                        const normalized = this.normalizeKey(key);
                        received.add(normalized);
                        const success = item.code !== undefined ? item.code === 0 : !("error" in item);
                        const baseId = this.keyIdMap.get(normalized) ?? `CO@.${this.sanitizeId(normalized)}`;
                        this.keyIdMap.set(normalized, baseId);
                        this.idKeyMap.set(baseId, normalized);
                        await this.extendObjectAsync(baseId, {
                            type: "channel",
                            common: { name: this.keyDescMap.get(normalized) || normalized },
                            native: {},
                        });
                        const subId = `${baseId}.subscription`;
                        await this.extendObjectAsync(subId, {
                            type: "state",
                            common: {
                                name: "subscription",
                                type: "boolean",
                                role: "indicator",
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(subId, { val: success, ack: true });
                        if (!success) {
                            const msg = `Subscription failed for ${normalized}`;
                            this.log.warn(msg);
                            this.notifyAdmin(msg);
                        }
                        const value = item.data ?? { value: item.value };
                        entries.push({ key, data: value });
                    }
                    const pending = Array.from(this.pendingSubscriptions);
                    for (const key of pending) {
                        if (!received.has(key)) {
                            const baseId = this.keyIdMap.get(key) ?? `CO@.${this.sanitizeId(key)}`;
                            this.keyIdMap.set(key, baseId);
                            this.idKeyMap.set(baseId, key);
                            await this.extendObjectAsync(baseId, {
                                type: "channel",
                                common: { name: this.keyDescMap.get(key) || key },
                                native: {},
                            });
                            const subId = `${baseId}.subscription`;
                            await this.extendObjectAsync(subId, {
                                type: "state",
                                common: {
                                    name: "subscription",
                                    type: "boolean",
                                    role: "indicator",
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });
                            await this.setStateAsync(subId, { val: false, ack: true });
                            const msg = `No subscription response for ${key}`;
                            this.log.warn(msg);
                            this.notifyAdmin(msg);
                        }
                    }
                    for (const key of pending)
                        this.pendingSubscriptions.delete(key);
                    // Case 2: push event with subscription key
                }
                else if (payload?.subscription?.key && typeof data === "object" && "value" in data) {
                    entries.push({ key: String(payload.subscription.key), data });
                    // Case 3: array of events
                }
                else if (Array.isArray(data)) {
                    for (const item of data) {
                        if (!item)
                            continue;
                        const key = item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
                        if (key === undefined)
                            continue;
                        entries.push({ key, data: item });
                    }
                    // Case 4: object containing key/uid or generic key-value pairs
                }
                else if (typeof data === "object") {
                    if (data.uid !== undefined || data.key !== undefined) {
                        const key = data.uid !== undefined ? String(data.uid) : String(data.key);
                        const value = data.data ?? { value: data.value };
                        entries.push({ key, data: value });
                    }
                    else {
                        for (const [key, val] of Object.entries(data)) {
                            const obj = typeof val === "object" && val !== null ? val : { value: val };
                            entries.push({ key, data: obj });
                        }
                    }
                }
                for (const { key, data } of entries) {
                    const normalized = this.normalizeKey(key);
                    if (this.skipInitialUpdate.has(normalized)) {
                        this.log.debug(`Skipping initial update for ${normalized}`);
                        this.skipInitialUpdate.delete(normalized);
                        continue;
                    }
                    const boolKey = this.boolKeys.has(normalized);
                    const rawVal = data.value;
                    const decoded = decodeAckValue(rawVal, boolKey);
                    const value = decoded.value;
                    const type = decoded.type;
                    const pending = this.pendingUpdates.get(normalized);
                    if (pending !== undefined &&
                        (pending === value || pending == value)) {
                        this.log.debug(`Ignoring echoed event for ${normalized} -> ${JSON.stringify(value)}`);
                        this.pendingUpdates.delete(normalized);
                        continue;
                    }
                    this.pendingUpdates.delete(normalized);
                    const baseId = this.keyIdMap.get(normalized) ?? `CO@.${this.sanitizeId(normalized)}`;
                    this.keyIdMap.set(normalized, baseId);
                    this.idKeyMap.set(baseId, normalized);
                    const name = this.keyDescMap.get(normalized) || normalized;
                    this.keyDescMap.set(normalized, name);
                    await this.extendObjectAsync(baseId, {
                        type: "channel",
                        common: { name },
                        native: {},
                    });
                    for (const [prop, raw] of Object.entries(data)) {
                        const isValue = prop === "value";
                        let val = raw;
                        let stateType;
                        let role = "state";
                        if (isValue) {
                            val = value;
                            stateType = type;
                        }
                        else if (typeof raw === "object") {
                            val = JSON.stringify(raw);
                            stateType = "string";
                            role = "json";
                        }
                        else if (typeof raw === "boolean") {
                            stateType = "boolean";
                        }
                        else if (typeof raw === "number") {
                            stateType = "number";
                        }
                        else {
                            stateType = "string";
                        }
                        const propId = `${baseId}.${this.sanitizeProp(prop)}`;
                        await this.extendObjectAsync(propId, {
                            type: "state",
                            common: { name: prop, type: stateType, role, read: true, write: isValue },
                            native: {},
                        });
                        if (isValue)
                            this.subscribeStates(propId);
                        this.log.debug(`Updating state ${propId} -> ${JSON.stringify(val)}`);
                        await this.setStateAsync(propId, { val, ack: true });
                        if (isValue) {
                            const mappedForeign = this.reverseMap.get(normalized);
                            if (mappedForeign) {
                                let mappedVal = decodeAckValue(val, mappedForeign.bool).value;
                                this.log.debug(`Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`);
                                this.suppressStateChange.add(mappedForeign.stateId);
                                await this.setForeignStateAsync(mappedForeign.stateId, { val: mappedVal, ack: true });
                                const timer = this.setTimeout(() => {
                                    this.suppressStateChange.delete(mappedForeign.stateId);
                                    this.clearTimeout(timer);
                                }, 1000);
                            }
                        }
                    }
                }
            });
            this.client.connect();
        }
        catch (e) {
            this.log.error(`onReady failed: ${e?.message || e}`);
        }
    }
    normalizeKey(k) {
        k = k.trim().toUpperCase();
        return k.startsWith("CO@") ? k : `CO@${k}`;
    }
    sanitizeId(s) {
        return s.replace(/^CO@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
    }
    normalizeArchiveKey(k) {
        k = k.trim().toUpperCase();
        return k.startsWith("DA@") ? k : `DA@${k}`;
    }
    sanitizeArchiveId(s) {
        return s.replace(/^DA@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
    }
    sanitizeProp(s) {
        return s.replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
    }
    async onUnload(callback) {
        try {
            this.log.info("Shutting down...");
            this.client?.removeAllListeners();
            if (this.client) {
                try {
                    this.client.unsubscribe(this.endpointKeys);
                    const states = await this.getStatesAsync("CO@.*.subscription");
                    for (const id of Object.keys(states)) {
                        await this.setStateAsync(id, { val: false, ack: true });
                    }
                }
                catch (err) {
                    this.log.error(`Unsubscribe failed: ${err}`);
                }
                this.client.close();
            }
        }
        catch (e) {
            this.log.error(`onUnload error: ${e}`);
        }
        finally {
            callback();
        }
    }
    onStateChange(id, state) {
        if (!state || !this.client)
            return;
        // In case we receive a fully qualified id (e.g. from setForeignState),
        // strip the adapter namespace so further processing works as expected.
        if (id.startsWith(this.namespace + ".")) {
            id = id.substring(this.namespace.length + 1);
        }
        const mapped = this.forwardMap.get(id);
        if (mapped) {
            if (this.suppressStateChange.has(id)) {
                this.log.debug(`Ignoring state change for ${id} because it was just updated from endpoint`);
                return;
            }
            const { uidValue, ackVal, method } = encodeUidValue(state.val, mapped.bool);
            this.client.call(mapped.key, method, uidValue);
            const baseId = this.keyIdMap.get(mapped.key) ?? `CO@.${this.sanitizeId(mapped.key)}`;
            this.keyIdMap.set(mapped.key, baseId);
            this.idKeyMap.set(baseId, mapped.key);
            this.setState(`${baseId}.value`, { val: ackVal, ack: true });
            if (!state.ack) {
                this.suppressStateChange.add(id);
                this.setForeignState(id, { val: state.val, ack: true });
                const supTimer = this.setTimeout(() => {
                    this.suppressStateChange.delete(id);
                    this.clearTimeout(supTimer);
                }, 1000);
            }
            this.pendingUpdates.set(mapped.key, ackVal);
            const timer = this.setTimeout(() => {
                this.pendingUpdates.delete(mapped.key);
                this.clearTimeout(timer);
            }, 1000);
            return;
        }
        if (id.startsWith("DA@.")) {
            if (state.ack)
                return;
            const parts = id.split(".");
            const action = parts.pop();
            const baseId = parts.join(".");
            const key = this.archiveIdKeyMap.get(baseId);
            if (!key || !action)
                return;
            if (action === "meta") {
                const prom = this.client.call(key, "meta", undefined, `meta_${Date.now()}`);
                if (prom) {
                    prom
                        .then((resp) => {
                        this.setState(id, { val: JSON.stringify(resp.data), ack: true });
                    })
                        .catch((err) => {
                        this.log.error(`Meta call failed for ${key}: ${err?.message || err}`);
                    });
                }
            }
            else if (action === "query") {
                let params;
                try {
                    params =
                        typeof state.val === "string" ? JSON.parse(state.val) : state.val;
                    if (!params || typeof params !== "object")
                        throw new Error();
                }
                catch {
                    this.log.warn(`Invalid query parameters for ${id}: ${state.val}`);
                    return;
                }
                const prom = this.client.call(key, "get", params, `get_${Date.now()}`);
                if (prom) {
                    prom
                        .then((resp) => {
                        this.setState(id, { val: state.val, ack: true });
                        this.setState(`${baseId}.data`, {
                            val: JSON.stringify(resp.data),
                            ack: true,
                        });
                    })
                        .catch((err) => {
                        this.log.error(`Get call failed for ${key}: ${err?.message || err}`);
                    });
                }
            }
            return;
        }
        if (state.ack)
            return;
        if (!id.startsWith("CO@."))
            return;
        const parts = id.split(".");
        if (parts[parts.length - 1] !== "value")
            return;
        const baseId = parts.slice(0, parts.length - 1).join(".");
        const key = this.idKeyMap.get(baseId) ??
            this.normalizeKey(parts.slice(1, parts.length - 1).join("."));
        const boolKey = this.boolKeys.has(key);
        const { uidValue, ackVal, method } = encodeUidValue(state.val, boolKey);
        this.client.call(key, method, uidValue);
        const mappedForeign = this.reverseMap.get(key);
        if (mappedForeign) {
            let mappedVal = decodeAckValue(ackVal, mappedForeign.bool).value;
            this.log.debug(`Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`);
            this.suppressStateChange.add(mappedForeign.stateId);
            this.setForeignState(mappedForeign.stateId, { val: mappedVal, ack: true });
            const timer = this.setTimeout(() => {
                this.suppressStateChange.delete(mappedForeign.stateId);
                this.clearTimeout(timer);
            }, 1000);
        }
        this.pendingUpdates.set(key, ackVal);
        const timer = this.setTimeout(() => {
            this.pendingUpdates.delete(key);
            this.clearTimeout(timer);
        }, 1000);
        this.setState(id, { val: ackVal, ack: true });
    }
}
if (module.parent) {
    module.exports = (options) => new GiraEndpointAdapter(options);
    module.exports.encodeUidValue = encodeUidValue;
    module.exports.decodeAckValue = decodeAckValue;
}
else {
    (() => new GiraEndpointAdapter())();
}
