"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GiraClient = void 0;
const events_1 = require("events");
const ws_1 = __importDefault(require("ws"));
// Kein Listener-Limit (verhindert MaxListeners-Warnungen global hier)
events_1.EventEmitter.defaultMaxListeners = 0;
const BACKOFF_FACTOR = 1.7;
const BACKOFF_JITTER = 0.2;
class GiraClient extends events_1.EventEmitter {
    constructor(opts) {
        super();
        this.closedByUser = false;
        this.awaitingPong = false;
        // Defaults + Merge ohne doppelte Literal-Keys (TS2783 vermeiden)
        const defaults = {
            host: "",
            port: 80,
            ssl: false,
            path: "/",
            username: "",
            password: "",
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
        const path = this.opts.path.startsWith("/") ? this.opts.path : `/${this.opts.path}`;
        const query = this.opts.username ? `?authorization=${token}` : "";
        const url = `${scheme}://${this.opts.host}:${this.opts.port}${path}${query}`;
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
                this.normalizeData(payload?.data);
                this.emit("event", payload);
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
        if (v === 1 || v === "1")
            v = true;
        else if (v === 0 || v === "0")
            v = false;
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
