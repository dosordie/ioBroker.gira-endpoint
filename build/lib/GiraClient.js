"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GiraClient = void 0;
exports.codeToMessage = codeToMessage;
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
// Kein Listener-Limit (verhindert MaxListeners-Warnungen global hier)
events_1.EventEmitter.defaultMaxListeners = 0;
const BACKOFF_FACTOR = 1.7;
const BACKOFF_JITTER = 0.2;
const STATUS_CODE_MESSAGES = {
    0: "Ok",
    400: "Ungültige Anfrage (Forbidden).",
    403: "Zugriff verweigert (Bad Request).",
    404: "Das angefragte HS-Objekt existiert in dem aufgerufenen Kontext nicht.",
    500: "Beim Erzeugen der Antwort ist im Server ein Fehler aufgetreten.",
    901: "Der angegebene Schlüssel ist ungültig.",
    902: "reserviert",
    903: "Die Objekt-Parameter sind ungültig.",
    904: "Das Objekt ist nicht abonniert.",
};
function codeToMessage(code) {
    return STATUS_CODE_MESSAGES[code] || `Error code ${code}`;
}
class GiraClient extends events_1.EventEmitter {
    constructor(opts) {
        super();
        this.closedByUser = false;
        this.awaitingPong = false;
        this.tagResolvers = new Map();
        this.requestTags = new Map();
        // Defaults + Merge ohne doppelte Literal-Keys (TS2783 vermeiden)
        const defaults = {
            host: "",
            port: 80,
            ssl: false,
            path: "/",
            username: "",
            password: "",
            authHeader: false,
            pingIntervalMs: 30000,
            reconnect: { minMs: 1000, maxMs: 30000 },
            tls: {},
        };
        this.opts = {
            ...defaults,
            ...opts,
            reconnect: { ...defaults.reconnect, ...(opts.reconnect || {}) },
        };
        this.backoffMs = this.opts.reconnect.minMs;
    }
    connect() {
        this.closedByUser = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        const scheme = this.opts.ssl ? "wss" : "ws";
        const headers = {};
        const token = Buffer.from(`${this.opts.username ?? ""}:${this.opts.password ?? ""}`).toString("base64");
        const encodedToken = encodeURIComponent(token);
        const path = this.opts.path.startsWith("/") ? this.opts.path : `/${this.opts.path}`;
        const query = this.opts.username && !this.opts.authHeader ? `?authorization=${encodedToken}` : "";
        const url = `${scheme}://${this.opts.host}:${this.opts.port}${path}${query}`;
        if (this.opts.username && this.opts.authHeader) {
            headers.Authorization = `Basic ${token}`;
        }
        const wsOpts = { headers, ...this.opts.tls };
        const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        if (proxy) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const HttpsProxyAgent = require("https-proxy-agent");
                wsOpts.agent = new HttpsProxyAgent(proxy);
            }
            catch (err) {
                this.emit("error", err);
            }
        }
        const ws = (this.ws = new ws_1.default(url, wsOpts));
        ws.on("open", () => {
            this.emit("open");
            this.backoffMs = this.opts.reconnect.minMs;
            this.awaitingPong = false;
            this.startPing();
        });
        ws.on("pong", () => {
            this.awaitingPong = false;
        });
        ws.on("message", (data) => {
            try {
                const text = typeof data === "string" ? data : data.toString("utf8");
                // Gira-Event-Format: hier anpassen. Wir nehmen zunächst JSON an.
                let payload;
                try {
                    payload = JSON.parse(text);
                }
                catch {
                    payload = { raw: text };
                }
                if (payload &&
                    typeof payload === "object" &&
                    payload.code !== undefined &&
                    payload.code !== 0) {
                    const msg = payload.message ||
                        payload.error ||
                        codeToMessage(payload.code);
                    const tag = payload.tag;
                    const err = new Error(msg);
                    err.code = payload.code;
                    if (tag && this.tagResolvers.has(tag)) {
                        const resolver = this.tagResolvers.get(tag);
                        if (resolver?.timer)
                            clearTimeout(resolver.timer);
                        resolver?.reject(err);
                        this.tagResolvers.delete(tag);
                        if (payload?.request) {
                            const reqKey = this.makeRequestKey(payload.request);
                            this.requestTags.delete(reqKey);
                        }
                    }
                    else if (payload?.request) {
                        const reqKey = this.makeRequestKey(payload.request);
                        const t = this.requestTags.get(reqKey);
                        if (t && this.tagResolvers.has(t)) {
                            const resolver = this.tagResolvers.get(t);
                            if (resolver?.timer)
                                clearTimeout(resolver.timer);
                            resolver?.reject(err);
                            this.tagResolvers.delete(t);
                            this.requestTags.delete(reqKey);
                        }
                    }
                    this.emit("error", err);
                    return;
                }
                this.normalizeData(payload?.data);
                this.emit("event", payload);
                const tag = payload?.tag;
                if (tag && this.tagResolvers.has(tag)) {
                    const resolver = this.tagResolvers.get(tag);
                    if (resolver?.timer)
                        clearTimeout(resolver.timer);
                    resolver?.resolve(payload);
                    this.tagResolvers.delete(tag);
                    if (payload?.request) {
                        const reqKey = this.makeRequestKey(payload.request);
                        this.requestTags.delete(reqKey);
                    }
                }
                else if (payload?.request) {
                    const reqKey = this.makeRequestKey(payload.request);
                    const t = this.requestTags.get(reqKey);
                    if (t && this.tagResolvers.has(t)) {
                        const resolver = this.tagResolvers.get(t);
                        if (resolver?.timer)
                            clearTimeout(resolver.timer);
                        resolver?.resolve(payload);
                        this.tagResolvers.delete(t);
                        this.requestTags.delete(reqKey);
                    }
                }
            }
            catch (err) {
                this.emit("error", err);
            }
        });
        ws.on("close", (code, reason) => {
            this.stopPing();
            this.emit("close", { code, reason: reason.toString() });
            if (!this.closedByUser)
                this.scheduleReconnect();
        });
        ws.on("error", (err) => {
            this.emit("error", err);
            // ws löst danach "close" aus → Reconnect wird dort geplant
        });
    }
    send(obj) {
        if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
            const data = typeof obj === "string" ? obj : JSON.stringify(obj);
            this.ws.send(data);
        }
    }
    makeRequestKey(obj) {
        if (!obj || typeof obj !== "object")
            return String(obj);
        const keys = Object.keys(obj).sort();
        const sorted = {};
        for (const k of keys)
            sorted[k] = obj[k];
        return JSON.stringify(sorted);
    }
    call(key, method, params, tag, timeoutMs = 10000) {
        const param = { key, method };
        if (params !== undefined) {
            if (params && typeof params === "object" && !Array.isArray(params)) {
                Object.assign(param, params);
            }
            else {
                param.value = params;
            }
        }
        const msg = { type: "call", param };
        if (tag) {
            msg.tag = tag;
            const reqKey = this.makeRequestKey(param);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error("Timeout"));
                    this.tagResolvers.delete(tag);
                    this.requestTags.delete(reqKey);
                }, timeoutMs);
                this.tagResolvers.set(tag, { resolve, reject, timer });
                this.requestTags.set(reqKey, tag);
                this.send(msg);
            });
        }
        this.send(msg);
    }
    select(filter, tag, timeoutMs = 10000) {
        const msg = { type: "select", param: filter };
        if (tag) {
            msg.tag = tag;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error("Timeout"));
                    this.tagResolvers.delete(tag);
                }, timeoutMs);
                this.tagResolvers.set(tag, { resolve, reject, timer });
                this.send(msg);
            });
        }
        this.send(msg);
    }
    subscribe(keys) {
        this.send({ type: "subscribe", param: { keys } });
    }
    unsubscribe(keys) {
        this.send({ type: "unsubscribe", param: { keys } });
    }
    close() {
        this.closedByUser = true;
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.ws && this.ws.readyState === ws_1.default.OPEN)
            this.ws.close();
    }
    normalizeValue(v) {
        if (typeof v === "string") {
            const num = Number(v);
            if (!isNaN(num)) {
                v = num;
            }
            else {
                try {
                    v = Buffer.from(v, "base64").toString("utf8");
                }
                catch {
                    // ignorieren, wenn keine gültige Base64
                }
            }
        }
        return v;
    }
    normalizeData(obj) {
        if (!obj || typeof obj !== "object")
            return;
        if (Array.isArray(obj)) {
            for (const item of obj)
                this.normalizeData(item);
            return;
        }
        if (Object.prototype.hasOwnProperty.call(obj, "value")) {
            obj.value = this.normalizeValue(obj.value);
        }
        for (const key of Object.keys(obj)) {
            this.normalizeData(obj[key]);
        }
    }
    startPing() {
        this.stopPing();
        if (!this.opts.pingIntervalMs || this.opts.pingIntervalMs <= 0)
            return;
        this.pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== ws_1.default.OPEN)
                return;
            if (this.awaitingPong) {
                try {
                    this.ws.terminate();
                }
                catch { /* ignore */ }
                return;
            }
            try {
                this.awaitingPong = true;
                this.ws.ping();
            }
            catch { /* ignore */ }
        }, this.opts.pingIntervalMs);
    }
    stopPing() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        this.pingTimer = undefined;
        this.awaitingPong = false;
    }
    scheduleReconnect() {
        const { maxMs } = this.opts.reconnect;
        const jitterDelta = this.backoffMs * BACKOFF_JITTER * (Math.random() * 2 - 1);
        const delay = Math.min(maxMs, Math.max(0, this.backoffMs + jitterDelta));
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (!this.closedByUser)
                this.connect();
        }, delay);
        this.backoffMs = Math.min(maxMs, Math.max(this.opts.reconnect.minMs, this.backoffMs * BACKOFF_FACTOR));
    }
}
exports.GiraClient = GiraClient;
