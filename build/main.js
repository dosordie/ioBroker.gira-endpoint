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
const crypto_1 = require("crypto");
const util_1 = require("util");
const valueConversion_1 = require("./lib/valueConversion");
const configParser_1 = require("./lib/configParser");
const archiveQuery_1 = require("./lib/archiveQuery");
class GiraEndpointAdapter extends utils.Adapter {
    formatLogValue(value, maxLength = 200) {
        let text;
        try {
            text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
        }
        catch {
            text = String(value);
        }
        if (text === undefined)
            text = String(value);
        return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
    }
    logOutgoingCoValue(args) {
        const statePart = args.stateId ? ` stateId=${args.stateId}` : "";
        this.log.debug(`Sending CO value source=${args.source}${statePart} key=${args.key} method=${args.method} ackVal=${this.formatLogValue(args.ackVal)} uidValue=${this.formatLogValue(args.uidValue)} bool=${args.bool} textEncoding=${args.textEncoding}`);
    }
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
        this.keyCaseMap = new Map();
        this.forwardMap = new Map();
        this.keyTextEncodingMap = new Map();
        this.reverseMap = new Map();
        this.boolKeys = new Set();
        this.suppressStateChange = new Set();
        this.pendingUpdates = new Map();
        this.skipInitialUpdate = new Set();
        this.initialSkipUpdate = new Set();
        this.updateOnStartSources = [];
        this.pendingSubscriptions = new Set();
        this.isConnected = false;
        this.pendingHsRestart = false;
        this.archiveKeys = [];
        this.archiveKeyIdMap = new Map();
        this.archiveIdKeyMap = new Map();
        this.archiveDescMap = new Map();
        this.archiveQueryDefaults = new Map();
        this.fetchedMeta = new Set();
        const origTranslate = this.translate;
        this.translate = (text, ...args) => {
            if (typeof origTranslate === "function") {
                return origTranslate.call(this, text, ...args);
            }
            return args.length ? (0, util_1.format)(text, ...args) : text;
        };
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
    }
    async onReady() {
        try {
            await this.setObjectNotExistsAsync("info", {
                type: "channel",
                common: { name: this.translate("Info") },
                native: {},
            });
            await this.setObjectNotExistsAsync("info.connection", {
                type: "state",
                common: {
                    name: this.translate("Connection"),
                    type: "boolean",
                    role: "indicator.connected",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync("info.lastError", {
                type: "state",
                common: {
                    name: this.translate("Last error"),
                    type: "string",
                    role: "text",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setObjectNotExistsAsync("info.lastEvent", {
                type: "state",
                common: {
                    name: this.translate("Last event"),
                    type: "string",
                    role: "json",
                    read: true,
                    write: false,
                },
                native: {},
            });
            await this.setStateAsync("info.connection", { val: false, ack: true });
            await this.setObjectNotExistsAsync("command", {
                type: "channel",
                common: { name: this.translate("Commands") },
                native: {},
            });
            await this.setObjectNotExistsAsync("command.hsRestart", {
                type: "state",
                common: {
                    name: this.translate("HomeServer restart trigger"),
                    type: "boolean",
                    role: "button",
                    read: true,
                    write: true,
                    def: false,
                },
                native: {},
            });
            this.subscribeStates("command.hsRestart");
            this.log.debug(this.translate("Pre-created info states"));
            await this.setObjectNotExistsAsync("CO@", {
                type: "channel",
                common: { name: this.translate("CO@") },
                native: {},
            });
            await this.setObjectNotExistsAsync("DA@", {
                type: "channel",
                common: { name: this.translate("DA@") },
                native: {},
            });
            const cfg = this.config;
            const parsed = (0, configParser_1.parseAdapterConfig)(cfg, {
                normalizeKey: this.normalizeKey.bind(this),
                normalizeArchiveKey: this.normalizeArchiveKey.bind(this),
                makeEndpointBaseId: this.makeEndpointBaseId.bind(this),
            });
            const { host, port, ssl, path, username, password, authHeader, pingIntervalMs, reconnect, ca, cert, key, rejectUnauthorized, } = parsed.connection;
            this.forwardMap = parsed.forwardMap;
            this.reverseMap = parsed.reverseMap;
            this.boolKeys = parsed.boolKeys;
            this.keyDescMap = parsed.keyDescMap;
            this.keyCaseMap = parsed.keyCaseMap;
            this.skipInitialUpdate = parsed.skipInitialUpdate;
            this.initialSkipUpdate = new Set(parsed.skipInitialUpdate);
            this.updateOnStartSources = parsed.updateOnStartSources;
            this.endpointKeys = parsed.endpointKeys;
            this.keyTextEncodingMap = parsed.keyTextEncodingMap;
            this.archiveKeys = parsed.archiveKeys;
            this.archiveDescMap = parsed.archiveDescMap;
            this.archiveQueryDefaults = parsed.archiveQueryDefaults;
            for (const key of this.endpointKeys) {
                if (!this.keyDescMap.has(key))
                    this.keyDescMap.set(key, key);
            }
            const endpointKeysText = this.endpointKeys.length
                ? this.endpointKeys.join(", ")
                : this.translate("(none)");
            this.log.info(this.translate("Configured endpoint keys: %s", endpointKeysText));
            const archiveKeysText = this.archiveKeys.length
                ? this.archiveKeys.join(", ")
                : this.translate("(none)");
            this.log.info(this.translate("Configured data archive keys: %s", archiveKeysText));
            if (this.forwardMap.size) {
                this.log.info(this.translate("Configured forward mappings: %s", Array.from(this.forwardMap.entries())
                    .map(([s, m]) => `${s}→${m.key}`)
                    .join(", ")));
                for (const stateId of this.forwardMap.keys()) {
                    this.subscribeForeignStates(stateId);
                }
            }
            if (this.reverseMap.size) {
                this.log.info(this.translate("Configured reverse mappings: %s", Array.from(this.reverseMap.entries())
                    .map(([k, m]) => `${k}→${m.stateId}`)
                    .join(", ")));
            }
            // Pre-create configured endpoint states so they appear immediately in ioBroker
            for (const key of new Set(this.endpointKeys)) {
                const baseId = this.makeEndpointBaseId(key);
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
                    common: {
                        name: this.translate("value"),
                        type: "mixed",
                        role: "state",
                        read: true,
                        write: true,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.subscription`, {
                    type: "state",
                    common: {
                        name: this.translate("subscription"),
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
                    common: {
                        name: this.translate("status"),
                        type: "string",
                        role: "state",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.meta`, {
                    type: "state",
                    common: {
                        name: this.translate("meta"),
                        type: "string",
                        role: "json",
                        read: true,
                        write: true,
                    },
                    native: {},
                });
                this.log.debug(this.translate("Pre-created endpoint channel %s", baseId));
                this.subscribeStates(`${baseId}.value`);
                this.subscribeStates(`${baseId}.meta`);
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
                    common: {
                        name: this.translate("meta"),
                        type: "string",
                        role: "json",
                        read: true,
                        write: true,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.query`, {
                    type: "state",
                    common: {
                        name: this.translate("query"),
                        type: "string",
                        role: "json",
                        read: true,
                        write: true,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.data`, {
                    type: "state",
                    common: {
                        name: this.translate("data"),
                        type: "string",
                        role: "json",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                const defaults = this.archiveQueryDefaults.get(key);
                await this.setObjectNotExistsAsync(`${baseId}.last`, {
                    type: "state",
                    common: {
                        name: this.translate("last"),
                        type: "boolean",
                        role: "button",
                        read: true,
                        write: true,
                        def: false,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.lastCnt`, {
                    type: "state",
                    common: {
                        name: this.translate("lastCnt"),
                        type: "number",
                        role: "value",
                        read: true,
                        write: true,
                        def: defaults?.lastCnt ?? 50,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.blockSize`, {
                    type: "state",
                    common: {
                        name: this.translate("blockSize"),
                        type: "number",
                        role: "value",
                        read: true,
                        write: true,
                        def: defaults?.blockSize ?? defaults?.size ?? 1,
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.cols`, {
                    type: "state",
                    common: {
                        name: this.translate("cols"),
                        type: "string",
                        role: "json",
                        read: true,
                        write: true,
                        def: JSON.stringify(defaults?.cols ?? []),
                    },
                    native: {},
                });
                await this.setObjectNotExistsAsync(`${baseId}.lastResult`, {
                    type: "state",
                    common: {
                        name: this.translate("lastResult"),
                        type: "string",
                        role: "json",
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                await this.setStateAsync(`${baseId}.last`, { val: false, ack: true });
                await this.setStateAsync(`${baseId}.lastCnt`, { val: defaults?.lastCnt ?? 50, ack: true });
                await this.setStateAsync(`${baseId}.blockSize`, { val: defaults?.blockSize ?? defaults?.size ?? 1, ack: true });
                await this.setStateAsync(`${baseId}.cols`, { val: JSON.stringify(defaults?.cols ?? []), ack: true });
                this.subscribeStates(`${baseId}.meta`);
                this.subscribeStates(`${baseId}.query`);
                this.subscribeStates(`${baseId}.last`);
            }
            const validBaseIds = new Set(this.endpointKeys.map((k) => this.makeEndpointBaseId(k)));
            const validArchiveBases = new Set(this.archiveKeys.map((k) => `DA@.${this.sanitizeArchiveId(k)}`));
            const objs = await this.getAdapterObjectsAsync();
            for (const fullId of Object.keys(objs)) {
                const id = fullId.startsWith(this.namespace + ".")
                    ? fullId.slice(this.namespace.length + 1)
                    : fullId;
                if (id.startsWith("CO@.")) {
                    const base = id.split(".").slice(0, 2).join(".");
                    if (!validBaseIds.has(base)) {
                        const msg = this.translate("Deleting stale endpoint state %s", id);
                        this.log.info(msg);
                        this.notifyAdmin(msg);
                        await this.delObjectAsync(id, { recursive: true });
                    }
                }
                else if (id.startsWith("DA@.")) {
                    const base = id.split(".").slice(0, 2).join(".");
                    if (!validArchiveBases.has(base)) {
                        const msg = this.translate("Deleting stale data archive state %s", id);
                        this.log.info(msg);
                        this.notifyAdmin(msg);
                        await this.delObjectAsync(id, { recursive: true });
                    }
                }
                else if (id.startsWith("info.subscriptions")) {
                    const msg = this.translate("Deleting legacy subscription state %s", id);
                    this.log.info(msg);
                    this.notifyAdmin(msg);
                    await this.delObjectAsync(id, { recursive: true });
                }
                else if (id.startsWith("objekte.")) {
                    const msg = this.translate("Deleting legacy object %s", id);
                    this.log.info(msg);
                    this.notifyAdmin(msg);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
            try {
                const msg = this.translate('Deleting legacy object root "objekte"');
                this.log.info(msg);
                this.notifyAdmin(msg);
                await this.delObjectAsync("objekte", { recursive: true });
            }
            catch {
                /* ignore */
            }
            const tls = {
                ca: ca ? String(ca) : undefined,
                cert: cert ? String(cert) : undefined,
                key: key ? String(key) : undefined,
                rejectUnauthorized: rejectUnauthorized !== undefined
                    ? Boolean(rejectUnauthorized)
                    : undefined,
            };
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
                    minMs: reconnect?.minMs ?? 1000,
                    maxMs: reconnect?.maxMs ?? 30000,
                },
                tls,
            });
            this.client.on("open", () => {
                const url = `${ssl ? "wss" : "ws"}://${host}:${port}${path}`;
                this.log.info(this.translate("Connected to %s", url));
                this.isConnected = true;
                this.setState("info.connection", true, true);
                this.fetchedMeta.clear();
                this.skipInitialUpdate = new Set(this.initialSkipUpdate);
                if (this.endpointKeys.length) {
                    this.pendingSubscriptions = new Set(this.endpointKeys.map((k) => this.normalizeKey(k)));
                    this.client.subscribe(this.endpointKeys);
                }
                else {
                    this.log.info(this.translate("Subscribing to all endpoint events (no keys configured)"));
                    this.pendingSubscriptions.clear();
                    this.client.subscribe([]);
                }
                for (const [key, params] of this.archiveQueryDefaults.entries()) {
                    const baseId = this.archiveKeyIdMap.get(key);
                    if (!baseId)
                        continue;
                    if (params.mode === "last" && !params.startat)
                        continue;
                    const queryParams = (0, archiveQuery_1.normalizeArchiveQuery)(params);
                    const prom = this.client.call(key, "get", queryParams, this.makeTag("get"));
                    if (prom) {
                        prom
                            .then((resp) => {
                            this.setState(`${baseId}.data`, {
                                val: JSON.stringify(resp.data),
                                ack: true,
                            });
                            this.setState(`${baseId}.lastResult`, {
                                val: JSON.stringify(resp.data),
                                ack: true,
                            });
                        })
                            .catch((err) => {
                            this.log.error(this.translate("Get call failed for %s: %s", key, err?.message || err));
                        });
                    }
                    this.setState(`${baseId}.query`, {
                        val: JSON.stringify(queryParams),
                        ack: true,
                    });
                }
                if (this.pendingHsRestart) {
                    this.pendingHsRestart = false;
                    void this.triggerUpdateOnStart();
                }
            });
            this.client.on("close", (info) => {
                const msg = this.translate("Connection closed (%s) %s", info?.code || "?", info?.reason || "");
                this.log.warn(msg);
                this.isConnected = false;
                this.setState("info.connection", false, true);
                this.getStatesAsync("CO@.*.subscription")
                    .then((states) => {
                    for (const id of Object.keys(states)) {
                        this.setState(id, { val: false, ack: true });
                    }
                })
                    .catch(() => {
                    /* ignore */
                });
            });
            this.client.on("error", (err) => {
                const msg = this.translate("Client error: %s", err?.message || err);
                this.log.error(msg);
                this.setState("info.lastError", String(err?.message || err), true);
                this.notifyAdmin(msg);
            });
            this.client.on("event", async (payload) => {
                // Provide full event information for debugging
                this.log.debug(this.translate("Received event: %s", JSON.stringify(payload)));
                if (this.config.updateLastEvent) {
                    await this.setStateAsync("info.lastEvent", {
                        val: JSON.stringify(payload),
                        ack: true,
                    });
                }
                const data = payload?.data;
                if (!data)
                    return;
                const tag = payload?.tag;
                if (typeof tag === "string" && tag.startsWith("meta_")) {
                    // Responses for meta calls are handled separately
                    return;
                }
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
                        this.rememberKeyCase(normalized, String(key));
                        const baseId = this.keyIdMap.get(normalized) ?? this.makeEndpointBaseId(normalized);
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
                                name: this.translate("subscription"),
                                type: "boolean",
                                role: "indicator",
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(subId, { val: false, ack: true });
                        const message = (0, GiraClient_1.codeToMessage)(item.code ?? payload.code ?? 0);
                        const statusText = typeof this.translate === "function"
                            ? this.translate(message)
                            : message;
                        await this.setStateAsync(`${baseId}.status`, {
                            val: statusText,
                            ack: true,
                        });
                        if (item.code !== undefined && item.code !== 0) {
                            const msg = this.translate("Unsubscribe failed for %s (%s)", normalized, item.code);
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
                        this.rememberKeyCase(normalized, String(key));
                        const baseId = this.keyIdMap.get(normalized) ?? this.makeEndpointBaseId(normalized);
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
                                name: this.translate("subscription"),
                                type: "boolean",
                                role: "indicator",
                                read: true,
                                write: false,
                            },
                            native: {},
                        });
                        await this.setStateAsync(subId, { val: success, ack: true });
                        if (!success) {
                            let msg = this.translate("Subscription failed for %s", normalized);
                            if (item.code !== undefined) {
                                const message = (0, GiraClient_1.codeToMessage)(item.code);
                                const statusText = typeof this.translate === "function"
                                    ? this.translate(message)
                                    : message;
                                msg += ` (${item.code} ${statusText})`;
                            }
                            this.log.warn(msg);
                            this.notifyAdmin(msg);
                            continue;
                        }
                        const value = item.data ?? { value: item.value };
                        entries.push({ key, data: value, code: item.code });
                    }
                    const pending = Array.from(this.pendingSubscriptions);
                    for (const key of pending) {
                        if (!received.has(key)) {
                            const baseId = this.keyIdMap.get(key) ?? this.makeEndpointBaseId(key);
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
                                    name: this.translate("subscription"),
                                    type: "boolean",
                                    role: "indicator",
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });
                            await this.setStateAsync(subId, { val: false, ack: true });
                            const msg = this.translate("No subscription response for %s", key);
                            this.log.warn(msg);
                            this.notifyAdmin(msg);
                        }
                    }
                    for (const key of pending)
                        this.pendingSubscriptions.delete(key);
                    // Case 2: push event with subscription key
                }
                else if (payload?.subscription?.key && typeof data === "object" && "value" in data) {
                    entries.push({ key: String(payload.subscription.key), data, code: payload.code });
                    // Case 3: array of events
                }
                else if (Array.isArray(data)) {
                    for (const item of data) {
                        if (!item)
                            continue;
                        const key = item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
                        if (key === undefined)
                            continue;
                        entries.push({ key, data: item, code: item.code });
                    }
                    // Case 4: object containing key/uid or generic key-value pairs
                }
                else if (typeof data === "object") {
                    if (data.uid !== undefined || data.key !== undefined) {
                        const key = data.uid !== undefined ? String(data.uid) : String(data.key);
                        const value = data.data ?? { value: data.value };
                        entries.push({ key, data: value, code: data.code });
                    }
                    else {
                        for (const [key, val] of Object.entries(data)) {
                            if (!key.includes("@")) {
                                this.log.debug(this.translate("Ignoring property %s without @", key));
                                continue;
                            }
                            const obj = typeof val === "object" && val !== null ? val : { value: val };
                            entries.push({ key, data: obj, code: val?.code });
                        }
                    }
                }
                for (const { key, data, code } of entries) {
                    const normalized = this.normalizeKey(key);
                    this.rememberKeyCase(normalized, String(key));
                    if (this.skipInitialUpdate.has(normalized)) {
                        this.log.debug(this.translate("Skipping initial update for %s", normalized));
                        this.skipInitialUpdate.delete(normalized);
                        continue;
                    }
                    const boolKey = this.boolKeys.has(normalized);
                    const textEncoding = this.keyTextEncodingMap.get(normalized) ?? "utf8";
                    const rawVal = data.value;
                    const decoded = (0, valueConversion_1.decodeCoValue)(rawVal, boolKey, textEncoding);
                    const value = decoded.value;
                    const type = decoded.type;
                    const pending = this.pendingUpdates.get(normalized);
                    if (pending !== undefined &&
                        (pending === value || pending == value)) {
                        this.log.debug(this.translate("Ignoring echoed event for %s -> %s", normalized, JSON.stringify(value)));
                        this.pendingUpdates.delete(normalized);
                        continue;
                    }
                    this.pendingUpdates.delete(normalized);
                    const baseId = this.keyIdMap.get(normalized) ?? this.makeEndpointBaseId(normalized);
                    this.keyIdMap.set(normalized, baseId);
                    this.idKeyMap.set(baseId, normalized);
                    const name = this.keyDescMap.get(normalized) || normalized;
                    this.keyDescMap.set(normalized, name);
                    await this.extendObjectAsync(baseId, {
                        type: "channel",
                        common: { name },
                        native: {},
                    });
                    // Ensure standard states exist for dynamically discovered keys
                    const subId = `${baseId}.subscription`;
                    await this.extendObjectAsync(subId, {
                        type: "state",
                        common: {
                            name: this.translate("subscription"),
                            type: "boolean",
                            role: "indicator",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    const success = code === undefined || code === 0;
                    await this.setStateAsync(subId, { val: success, ack: true });
                    if (!success) {
                        let msg = this.translate("Subscription failed for %s", normalized);
                        if (code !== undefined) {
                            const message = (0, GiraClient_1.codeToMessage)(code);
                            const statusText = typeof this.translate === "function"
                                ? this.translate(message)
                                : message;
                            msg += ` (${code} ${statusText})`;
                        }
                        this.log.warn(msg);
                        this.notifyAdmin(msg);
                    }
                    await this.extendObjectAsync(`${baseId}.status`, {
                        type: "state",
                        common: {
                            name: this.translate("status"),
                            type: "string",
                            role: "state",
                            read: true,
                            write: false,
                        },
                        native: {},
                    });
                    await this.extendObjectAsync(`${baseId}.meta`, {
                        type: "state",
                        common: {
                            name: this.translate("meta"),
                            type: "string",
                            role: "json",
                            read: true,
                            write: true,
                        },
                        native: {},
                    });
                    this.subscribeStates(`${baseId}.value`);
                    this.subscribeStates(`${baseId}.meta`);
                    if (!this.fetchedMeta.has(normalized)) {
                        this.fetchedMeta.add(normalized);
                        this.fetchMeta(normalized, baseId);
                    }
                    const message = (0, GiraClient_1.codeToMessage)(code ?? payload.code ?? 0);
                    const statusText = typeof this.translate === "function"
                        ? this.translate(message)
                        : message;
                    await this.setStateAsync(`${baseId}.status`, {
                        val: statusText,
                        ack: true,
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
                        this.log.debug(this.translate("Updating state %s -> %s", propId, JSON.stringify(val)));
                        await this.setStateAsync(propId, { val, ack: true });
                        if (isValue) {
                            const mappedForeign = this.reverseMap.get(normalized);
                            if (mappedForeign) {
                                let mappedVal = (0, valueConversion_1.decodeAckValue)(val, mappedForeign.bool).value;
                                this.log.debug(this.translate("Updating mapped foreign state %s -> %s", mappedForeign.stateId, JSON.stringify(mappedVal)));
                                this.suppressStateChange.add(mappedForeign.stateId);
                                await this.setForeignStateAsync(mappedForeign.stateId, {
                                    val: mappedVal,
                                    ack: mappedForeign.ack,
                                });
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
            this.log.error(this.translate("onReady failed: %s", e?.message || e));
        }
    }
    normalizeKey(k) {
        k = k.trim().toUpperCase();
        return k.startsWith("CO@") ? k : `CO@${k}`;
    }
    rememberKeyCase(normalized, original) {
        if (!normalized)
            return;
        const trimmed = String(original ?? "").trim();
        if (!trimmed)
            return;
        const suffix = trimmed.replace(/^CO@/i, "");
        this.keyCaseMap.set(normalized, `CO@${suffix}`);
    }
    getCasePreservedKey(normalized) {
        return this.keyCaseMap.get(normalized) ?? normalized;
    }
    makeEndpointBaseId(normalized) {
        const casedKey = this.getCasePreservedKey(normalized);
        const sanitized = this.sanitizeId(casedKey);
        return `CO@.${sanitized}`;
    }
    sanitizeId(s) {
        return s.replace(/^CO@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_");
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
    makeTag(prefix) {
        return `${prefix}_${(0, crypto_1.randomUUID)()}`;
    }
    async applyMeta(key, baseId, meta, archive = false) {
        if (!meta || typeof meta !== "object")
            return;
        const name = meta.desc || meta.name || meta.label;
        if (!name)
            return;
        if (archive) {
            this.archiveDescMap.set(key, name);
        }
        else {
            this.keyDescMap.set(key, name);
        }
        await this.extendObjectAsync(baseId, {
            type: "channel",
            common: { name },
            native: {},
        });
    }
    async fetchMeta(key, baseId) {
        if (!this.client)
            return;
        try {
            const metaResp = await this.client.call(key, "meta", undefined, this.makeTag("meta"));
            if (metaResp?.data !== undefined) {
                await this.applyMeta(key, baseId, metaResp.data);
                await this.setStateAsync(`${baseId}.meta`, {
                    val: JSON.stringify(metaResp.data),
                    ack: true,
                });
            }
        }
        catch (err) {
            this.log.error(this.translate("Meta call failed for %s: %s", key, err?.message || err));
        }
    }
    async triggerUpdateOnStart() {
        if (!this.client || !this.isConnected) {
            this.pendingHsRestart = true;
            this.log.warn(this.translate("Cannot resend update-on-start values because client is not connected"));
            return;
        }
        this.log.info(this.translate("Resending update-on-start states after HomeServer restart"));
        for (const src of this.updateOnStartSources) {
            try {
                const state = src.foreign
                    ? await this.getForeignStateAsync(src.stateId)
                    : await this.getStateAsync(src.stateId);
                if (!state)
                    continue;
                const { uidValue, ackVal, method } = (0, valueConversion_1.encodeUidValue)(state.val, src.bool, src.textEncoding);
                this.logOutgoingCoValue({
                    source: "updateOnStart",
                    stateId: src.stateId,
                    key: src.key,
                    method,
                    ackVal,
                    uidValue,
                    bool: src.bool,
                    textEncoding: src.textEncoding,
                });
                this.client.call(src.key, method, uidValue);
                const baseId = this.keyIdMap.get(src.key) ?? this.makeEndpointBaseId(src.key);
                this.keyIdMap.set(src.key, baseId);
                this.idKeyMap.set(baseId, src.key);
                await this.setStateAsync(`${baseId}.value`, { val: ackVal, ack: true });
                const mappedForeign = this.reverseMap.get(src.key);
                if (mappedForeign) {
                    const mappedVal = (0, valueConversion_1.decodeAckValue)(ackVal, mappedForeign.bool).value;
                    this.suppressStateChange.add(mappedForeign.stateId);
                    await this.setForeignStateAsync(mappedForeign.stateId, {
                        val: mappedVal,
                        ack: mappedForeign.ack,
                    });
                    const timer = this.setTimeout(() => {
                        this.suppressStateChange.delete(mappedForeign.stateId);
                        this.clearTimeout(timer);
                    }, 1000);
                }
                this.pendingUpdates.set(src.key, ackVal);
                const timer = this.setTimeout(() => {
                    this.pendingUpdates.delete(src.key);
                    this.clearTimeout(timer);
                }, 1000);
            }
            catch (err) {
                this.log.warn(this.translate("Failed to resend update-on-start value for %s: %s", src.stateId, err?.message || err));
            }
        }
    }
    async onUnload(callback) {
        try {
            this.log.info(this.translate("Shutting down..."));
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
                    this.log.error(this.translate("Unsubscribe failed: %s", err));
                }
                this.client.close();
            }
        }
        catch (e) {
            this.log.error(this.translate("onUnload error: %s", e));
        }
        finally {
            callback();
        }
    }
    onStateChange(id, state) {
        if (id.startsWith(this.namespace + ".")) {
            id = id.substring(this.namespace.length + 1);
        }
        if (id === "command.hsRestart") {
            this.handleHsRestartTrigger(id, state);
            return;
        }
        if (!state || !this.client)
            return;
        const mapped = this.forwardMap.get(id);
        if (mapped && this.handleMappedStateChange(id, state, mapped))
            return;
        if (this.handleArchiveStateChange(id, state))
            return;
        if (this.handleDirectCoStateChange(id, state))
            return;
    }
    handleMappedStateChange(id, state, mapped) {
        if (this.suppressStateChange.has(id)) {
            this.log.debug(this.translate("Ignoring state change for %s because it was just updated from endpoint", id));
            return true;
        }
        const { uidValue, ackVal, method } = (0, valueConversion_1.encodeUidValue)(state.val, mapped.bool, mapped.textEncoding);
        this.logOutgoingCoValue({
            source: "mapping",
            stateId: id,
            key: mapped.key,
            method,
            ackVal,
            uidValue,
            bool: mapped.bool,
            textEncoding: mapped.textEncoding,
        });
        this.client.call(mapped.key, method, uidValue);
        const baseId = this.keyIdMap.get(mapped.key) ?? this.makeEndpointBaseId(mapped.key);
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
        return true;
    }
    handleArchiveStateChange(id, state) {
        if (!id.startsWith("DA@."))
            return false;
        if (state.ack)
            return true;
        const parts = id.split(".");
        const action = parts.pop();
        const baseId = parts.join(".");
        const key = this.archiveIdKeyMap.get(baseId);
        if (!key || !action)
            return true;
        if (action === "meta") {
            const prom = this.client.call(key, "meta", undefined, this.makeTag("meta"));
            if (prom) {
                prom
                    .then(async (resp) => {
                    await this.applyMeta(key, baseId, resp.data, true);
                    await this.setStateAsync(id, {
                        val: JSON.stringify(resp.data),
                        ack: true,
                    });
                })
                    .catch((err) => {
                    this.log.error(this.translate("Meta call failed for %s: %s", key, err?.message || err));
                });
            }
            return true;
        }
        if (action === "last") {
            if (state.val !== true)
                return true;
            void this.handleLastArchiveQuery(key, baseId, id);
            return true;
        }
        if (action === "query") {
            let params;
            try {
                params = typeof state.val === "string" ? JSON.parse(state.val) : state.val;
                if (!params || typeof params !== "object")
                    throw new Error();
            }
            catch {
                this.log.warn(this.translate("Invalid query parameters for %s: %s", id, state.val));
                return true;
            }
            const queryParams = (0, archiveQuery_1.normalizeArchiveQuery)(params);
            const prom = this.client.call(key, "get", queryParams, this.makeTag("get"));
            if (prom) {
                prom
                    .then((resp) => {
                    this.setState(id, { val: JSON.stringify(queryParams), ack: true });
                    const data = JSON.stringify(resp.data);
                    this.setState(`${baseId}.data`, { val: data, ack: true });
                    this.setState(`${baseId}.lastResult`, { val: data, ack: true });
                })
                    .catch((err) => {
                    this.log.error(this.translate("Get call failed for %s: %s", key, err?.message || err));
                });
            }
            return true;
        }
        return true;
    }
    async readNumberState(id, fallback) {
        const state = await this.getStateAsync(id);
        const num = Number(state?.val);
        return Number.isFinite(num) ? num : fallback;
    }
    async readColsState(id, fallback) {
        const state = await this.getStateAsync(id);
        if (typeof state?.val === "string") {
            try {
                const parsed = JSON.parse(state.val);
                return (0, archiveQuery_1.normalizeArchiveCols)(parsed) ?? fallback;
            }
            catch {
                return (0, archiveQuery_1.normalizeArchiveCols)(state.val) ?? fallback;
            }
        }
        return (0, archiveQuery_1.normalizeArchiveCols)(state?.val) ?? fallback;
    }
    async handleLastArchiveQuery(key, baseId, id) {
        try {
            await this.setStateAsync(id, { val: false, ack: true });
            const defaults = this.archiveQueryDefaults.get(key);
            const metaResp = await this.client.call(key, "meta", undefined, this.makeTag("meta"));
            if (metaResp?.data !== undefined) {
                await this.applyMeta(key, baseId, metaResp.data, true);
                await this.setStateAsync(`${baseId}.meta`, { val: JSON.stringify(metaResp.data), ack: true });
            }
            const lastCnt = await this.readNumberState(`${baseId}.lastCnt`, defaults?.lastCnt ?? 50);
            const blockSize = await this.readNumberState(`${baseId}.blockSize`, defaults?.blockSize ?? defaults?.size ?? 1);
            const cols = await this.readColsState(`${baseId}.cols`, defaults?.cols ?? []);
            const queryParams = (0, archiveQuery_1.buildLastArchiveQuery)(metaResp, lastCnt, blockSize, cols);
            if (!queryParams) {
                this.log.warn(this.translate("Cannot build last archive query for %s because meta.stat.last is missing", key));
                return;
            }
            const resp = await this.client.call(key, "get", queryParams, this.makeTag("get"));
            const data = JSON.stringify(resp.data);
            await this.setStateAsync(`${baseId}.data`, { val: data, ack: true });
            await this.setStateAsync(`${baseId}.lastResult`, { val: data, ack: true });
            await this.setStateAsync(`${baseId}.query`, { val: JSON.stringify(queryParams), ack: true });
        }
        catch (err) {
            this.log.error(this.translate("Last archive query failed for %s: %s", key, err?.message || err));
        }
    }
    handleDirectCoStateChange(id, state) {
        if (state.ack)
            return false;
        if (!id.startsWith("CO@."))
            return false;
        const parts = id.split(".");
        if (parts[parts.length - 1] === "meta") {
            const baseId = parts.slice(0, parts.length - 1).join(".");
            const key = this.idKeyMap.get(baseId) ??
                this.normalizeKey(parts.slice(1, parts.length - 1).join("."));
            if (!key)
                return true;
            const prom = this.client.call(key, "meta", undefined, this.makeTag("meta"));
            if (prom) {
                prom
                    .then(async (resp) => {
                    await this.applyMeta(key, baseId, resp.data);
                    await this.setStateAsync(id, {
                        val: JSON.stringify(resp.data),
                        ack: true,
                    });
                })
                    .catch((err) => {
                    this.log.error(this.translate("Meta call failed for %s: %s", key, err?.message || err));
                });
            }
            return true;
        }
        if (parts[parts.length - 1] !== "value")
            return false;
        const baseId = parts.slice(0, parts.length - 1).join(".");
        const key = this.idKeyMap.get(baseId) ??
            this.normalizeKey(parts.slice(1, parts.length - 1).join("."));
        const boolKey = this.boolKeys.has(key);
        const textEncoding = this.keyTextEncodingMap.get(key) ?? "utf8";
        const { uidValue, ackVal, method } = (0, valueConversion_1.encodeUidValue)(state.val, boolKey, textEncoding);
        this.logOutgoingCoValue({
            source: "direct",
            stateId: id,
            key,
            method,
            ackVal,
            uidValue,
            bool: boolKey,
            textEncoding,
        });
        this.client.call(key, method, uidValue);
        const mappedForeign = this.reverseMap.get(key);
        if (mappedForeign) {
            let mappedVal = (0, valueConversion_1.decodeAckValue)(ackVal, mappedForeign.bool).value;
            this.log.debug(`Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`);
            this.suppressStateChange.add(mappedForeign.stateId);
            this.setForeignState(mappedForeign.stateId, {
                val: mappedVal,
                ack: mappedForeign.ack,
            });
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
        return true;
    }
    handleHsRestartTrigger(id, state) {
        this.log.debug(this.translate("HomeServer restart trigger received (val=%s, ack=%s)", state?.val, state?.ack));
        if (state?.ack)
            return;
        const shouldTrigger = state?.val === true ||
            state?.val === 1 ||
            state?.val === "true" ||
            state?.val === "1";
        if (shouldTrigger) {
            if (!this.isConnected) {
                this.pendingHsRestart = true;
                this.log.warn(this.translate("HomeServer restart trigger queued until connection is restored"));
                this.setState(id, { val: false, ack: true });
            }
            else {
                this.triggerUpdateOnStart().finally(() => {
                    this.setState(id, { val: false, ack: true });
                });
            }
        }
        else {
            this.setState(id, { val: !!state?.val, ack: true });
        }
    }
}
if (module.parent) {
    module.exports = (options) => new GiraEndpointAdapter(options);
    module.exports.encodeUidValue = valueConversion_1.encodeUidValue;
    module.exports.decodeAckValue = valueConversion_1.decodeAckValue;
    module.exports.decodeCoValue = valueConversion_1.decodeCoValue;
}
else {
    (() => new GiraEndpointAdapter())();
}
