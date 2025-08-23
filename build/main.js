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
const utils = __importStar(require("@iobroker/adapter-core"));
const GiraClient_1 = require("./lib/GiraClient");
class GiraEndpointAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "gira-endpoint",
        });
        this.endpointKeys = [];
        this.keyIdMap = new Map();
        this.keyDescMap = new Map();
        this.forwardMap = new Map();
        this.reverseMap = new Map();
        this.boolKeys = new Set();
        this.suppressStateChange = new Set();
        this.pendingUpdates = new Map();
        this.skipInitialUpdate = new Set();
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
            const cfg = this.config;
            const host = String(cfg.host ?? "").trim();
            const port = Number(cfg.port ?? 80);
            const ssl = Boolean(cfg.ssl ?? false);
            const path = "/endpoints/ws";
            const username = String(cfg.username ?? "");
            const password = String(cfg.password ?? "");
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
            for (const key of endpointKeys) {
                if (!this.keyDescMap.has(key))
                    this.keyDescMap.set(key, key);
            }
            this.endpointKeys = endpointKeys;
            this.log.info(`Configured endpoint keys: ${this.endpointKeys.length ? this.endpointKeys.join(", ") : "(none)"}`);
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
                const id = `CO@.${this.sanitizeId(key)}`;
                this.keyIdMap.set(key, id);
                const name = this.keyDescMap.get(key) || key;
                await this.setObjectNotExistsAsync(id, {
                    type: "state",
                    common: { name, type: "mixed", role: "state", read: true, write: true },
                    native: {},
                });
                this.log.debug(`Pre-created endpoint state ${id}`);
                this.subscribeStates(id);
            }
            const validIds = new Set(this.keyIdMap.values());
            const objs = await this.getAdapterObjectsAsync();
            for (const fullId of Object.keys(objs)) {
                const id = fullId.startsWith(this.namespace + ".")
                    ? fullId.slice(this.namespace.length + 1)
                    : fullId;
                if (id.startsWith("CO@.")) {
                    if (!validIds.has(id)) {
                        await this.delObjectAsync(id, { recursive: true });
                        this.log.debug(`Removed stale endpoint state ${id}`);
                    }
                }
                else if (id.startsWith("objekte.")) {
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
            try {
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
                    this.client.subscribe(this.endpointKeys);
                }
                else {
                    this.log.info("Subscribing to all endpoint events (no keys configured)");
                    this.client.subscribe([]);
                }
            });
            this.client.on("close", (info) => {
                this.log.warn(`Connection closed (${info?.code || "?"}) ${info?.reason || ""}`);
                this.setState("info.connection", false, true);
            });
            this.client.on("error", (err) => {
                this.log.error(`Client error: ${err?.message || err}`);
                this.setState("info.lastError", String(err?.message || err), true);
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
                const entries = [];
                // Case 1: subscription result lists multiple items
                if (typeof data === "object" && Array.isArray(data.items)) {
                    for (const item of data.items) {
                        if (!item)
                            continue;
                        const key = item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
                        if (key === undefined)
                            continue;
                        const value = item.data?.value !== undefined ? item.data.value : item.data ?? item.value;
                        entries.push({ key, value });
                    }
                    // Case 2: push event with subscription key
                }
                else if (payload?.subscription?.key && typeof data === "object" && "value" in data) {
                    entries.push({ key: String(payload.subscription.key), value: data.value });
                    // Case 3: array of events
                }
                else if (Array.isArray(data)) {
                    for (const item of data) {
                        if (!item)
                            continue;
                        const key = item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
                        if (key === undefined)
                            continue;
                        entries.push({ key, value: item.value });
                    }
                    // Case 4: object containing key/uid or generic key-value pairs
                }
                else if (typeof data === "object") {
                    if (data.uid !== undefined || data.key !== undefined) {
                        const key = data.uid !== undefined ? String(data.uid) : String(data.key);
                        const value = data.data?.value !== undefined ? data.data.value : data.value;
                        entries.push({ key, value });
                    }
                    else {
                        for (const [key, val] of Object.entries(data)) {
                            const value = val?.value !== undefined ? val.value : val;
                            entries.push({ key, value });
                        }
                    }
                }
                for (const { key, value: val } of entries) {
                    const normalized = this.normalizeKey(key);
                    if (this.skipInitialUpdate.has(normalized)) {
                        this.log.debug(`Skipping initial update for ${normalized}`);
                        this.skipInitialUpdate.delete(normalized);
                        continue;
                    }
                    const boolKey = this.boolKeys.has(normalized);
                    let value = val;
                    let type = "mixed";
                    if (boolKey) {
                        type = "boolean";
                        if (typeof val === "number")
                            value = val !== 0;
                        else if (typeof val === "string")
                            value = val !== "0";
                        else
                            value = Boolean(val);
                    }
                    else {
                        if (typeof val === "boolean") {
                            type = "number";
                            value = val ? 1 : 0;
                        }
                        else if (typeof val === "number")
                            type = "number";
                        else if (typeof val === "string")
                            type = "string";
                    }
                    const pending = this.pendingUpdates.get(normalized);
                    if (pending !== undefined &&
                        (pending === value || pending == value)) {
                        this.log.debug(`Ignoring echoed event for ${normalized} -> ${JSON.stringify(value)}`);
                        this.pendingUpdates.delete(normalized);
                        continue;
                    }
                    this.pendingUpdates.delete(normalized);
                    const id = this.keyIdMap.get(normalized) ?? `CO@.${this.sanitizeId(normalized)}`;
                    this.keyIdMap.set(normalized, id);
                    const name = this.keyDescMap.get(normalized) || normalized;
                    this.keyDescMap.set(normalized, name);
                    await this.extendObjectAsync(id, {
                        type: "state",
                        common: { name, type, role: "state", read: true, write: true },
                        native: {},
                    });
                    this.subscribeStates(id);
                    this.log.debug(`Updating state ${id} -> ${JSON.stringify(value)}`);
                    await this.setStateAsync(id, { val: value, ack: true });
                    const mappedForeign = this.reverseMap.get(normalized);
                    if (mappedForeign) {
                        let mappedVal = value;
                        if (mappedForeign.bool) {
                            if (typeof mappedVal === "number")
                                mappedVal = mappedVal !== 0;
                            else if (typeof mappedVal === "string")
                                mappedVal = mappedVal !== "0";
                        }
                        this.log.debug(`Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`);
                        this.suppressStateChange.add(mappedForeign.stateId);
                        await this.setForeignStateAsync(mappedForeign.stateId, { val: mappedVal, ack: true });
                        const timer = this.setTimeout(() => {
                            this.suppressStateChange.delete(mappedForeign.stateId);
                            this.clearTimeout(timer);
                        }, 1000);
                    }
                }
            });
            await this.setObjectNotExistsAsync("control", {
                type: "channel",
                common: { name: "Control" },
                native: {},
            });
            await this.setObjectNotExistsAsync("control.subscribe", {
                type: "state",
                common: { name: "Subscribe keys", type: "string", role: "state", read: false, write: true },
                native: {},
            });
            await this.setObjectNotExistsAsync("control.unsubscribe", {
                type: "state",
                common: { name: "Unsubscribe keys", type: "string", role: "state", read: false, write: true },
                native: {},
            });
            this.log.debug("Created control states");
            this.subscribeStates("control.subscribe");
            this.subscribeStates("control.unsubscribe");
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
    async onUnload(callback) {
        try {
            this.log.info("Shutting down...");
            this.client?.removeAllListeners();
            this.client?.close();
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
        const mapped = this.forwardMap.get(id);
        if (mapped) {
            if (this.suppressStateChange.has(id)) {
                this.log.debug(`Ignoring state change for ${id} because it was just updated from endpoint`);
                return;
            }
            if (state.ack)
                return;
            let uidValue = state.val;
            let ackVal = state.val;
            if (mapped.bool) {
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
                    else if (isNaN(Number(uidValue))) {
                        uidValue = Buffer.from(uidValue, "utf8").toString("base64");
                    }
                }
            }
            this.client.send({ type: "call", param: { key: mapped.key, method: "set", value: uidValue } });
            const mappedId = this.keyIdMap.get(mapped.key) ?? `CO@.${this.sanitizeId(mapped.key)}`;
            this.keyIdMap.set(mapped.key, mappedId);
            this.setState(mappedId, { val: ackVal, ack: true });
            this.pendingUpdates.set(mapped.key, ackVal);
            const timer = this.setTimeout(() => {
                this.pendingUpdates.delete(mapped.key);
                this.clearTimeout(timer);
            }, 1000);
            return;
        }
        if (state.ack)
            return;
        const key = id.split(".").pop();
        if (!key)
            return;
        if (key === "subscribe" || key === "unsubscribe") {
            const keys = String(state.val || "")
                .split(/[,;\s]+/)
                .map((k) => k.trim())
                .filter((k) => k)
                .map((k) => this.normalizeKey(k));
            if (!keys.length)
                return;
            if (key === "subscribe") {
                this.client.subscribe(keys);
            }
            else {
                this.client.unsubscribe(keys);
            }
            this.setState(id, { val: state.val, ack: true });
            return;
        }
        let uidValue = state.val;
        let method = "set";
        let ackVal = state.val;
        const boolKey = this.boolKeys.has(this.normalizeKey(key));
        if (boolKey) {
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
        const normKey = this.normalizeKey(key);
        this.client.send({ type: "call", param: { key, method, value: uidValue } });
        const mappedForeign = this.reverseMap.get(normKey);
        if (mappedForeign) {
            let mappedVal = ackVal;
            if (mappedForeign.bool) {
                if (typeof mappedVal === "number")
                    mappedVal = mappedVal !== 0;
                else if (typeof mappedVal === "string")
                    mappedVal = mappedVal !== "0";
            }
            this.log.debug(`Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`);
            this.suppressStateChange.add(mappedForeign.stateId);
            this.setForeignState(mappedForeign.stateId, { val: mappedVal, ack: true });
            const timer = this.setTimeout(() => {
                this.suppressStateChange.delete(mappedForeign.stateId);
                this.clearTimeout(timer);
            }, 1000);
        }
        this.pendingUpdates.set(normKey, ackVal);
        const timer = this.setTimeout(() => {
            this.pendingUpdates.delete(normKey);
            this.clearTimeout(timer);
        }, 1000);
        this.setState(id, { val: ackVal, ack: true });
    }
}
if (module.parent) {
    module.exports = (options) => new GiraEndpointAdapter(options);
}
else {
    (() => new GiraEndpointAdapter())();
}
