import { EventEmitter } from "events";
import WebSocket from "ws";

// Kein Listener-Limit (verhindert MaxListeners-Warnungen global hier)
EventEmitter.defaultMaxListeners = 0;

const BACKOFF_FACTOR = 1.7;
const BACKOFF_JITTER = 0.2;

interface ReconnectOptions {
  minMs: number;
  maxMs: number;
}

export interface GiraClientOptions {
  host: string;
  port: number;
  ssl: boolean;
  path: string;
  username?: string;
  password?: string;
  /**
   * Sends the auth token as HTTP header instead of query parameter when true.
   */
  authHeader?: boolean;
  pingIntervalMs?: number;
  reconnect?: Partial<ReconnectOptions>;
  tls?: {
    ca?: string | Buffer | Array<string | Buffer>;
    cert?: string | Buffer;
    key?: string | Buffer;
    rejectUnauthorized?: boolean;
  };
}

type ResolvedGiraClientOptions = Omit<GiraClientOptions, "reconnect"> & {
  reconnect: ReconnectOptions;
  username: string;
  password: string;
  authHeader: boolean;
  pingIntervalMs: number;
  tls: NonNullable<GiraClientOptions["tls"]>;
};

export class GiraClient extends EventEmitter {
  private ws?: WebSocket & { ping: () => void; terminate: () => void };
  private closedByUser = false;
  private opts: ResolvedGiraClientOptions;
  private backoffMs: number;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private awaitingPong = false;

  constructor(opts: GiraClientOptions) {
    super();
    // Defaults + Merge ohne doppelte Literal-Keys (TS2783 vermeiden)
    const defaults: ResolvedGiraClientOptions = {
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

  public connect(): void {
    this.closedByUser = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer as any);
      this.reconnectTimer = undefined;
    }
    const scheme = this.opts.ssl ? "wss" : "ws";

    const headers: Record<string, string> = {};
    const token = Buffer.from(
      `${this.opts.username ?? ""}:${this.opts.password ?? ""}`
    ).toString("base64");
    const encodedToken = encodeURIComponent(token);
    const path = this.opts.path.startsWith("/") ? this.opts.path : `/${this.opts.path}`;
    const query = this.opts.username && !this.opts.authHeader ? `?authorization=${encodedToken}` : "";
    const url = `${scheme}://${this.opts.host}:${this.opts.port}${path}${query}`;
    if (this.opts.username && this.opts.authHeader) {
      headers.Authorization = `Basic ${token}`;
    }

    const wsOpts: any = { headers, ...this.opts.tls };
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const HttpsProxyAgent = require("https-proxy-agent");
        wsOpts.agent = new HttpsProxyAgent(proxy);
      } catch (err) {
        this.emit("error", err);
      }
    }

    const ws = (this.ws = new WebSocket(url, wsOpts) as any);

    ws.on("open", () => {
      this.emit("open");
      this.backoffMs = this.opts.reconnect.minMs;
      this.awaitingPong = false;
      this.startPing();
    });

    ws.on("pong", () => {
      this.awaitingPong = false;
    });

    ws.on("message", (data: any) => {
      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        // Gira-Event-Format: hier anpassen. Wir nehmen zunächst JSON an.
        let payload: any;
        try { payload = JSON.parse(text); } catch {
          payload = { raw: text };
        }
        if (
          payload &&
          typeof payload === "object" &&
          payload.code !== undefined &&
          payload.code !== 0
        ) {
          const msg =
            (payload as any).message ||
            (payload as any).error ||
            `Error code ${payload.code}`;
          this.emit("error", new Error(msg));
          return;
        }
        this.normalizeData(payload?.data);
        this.emit("event", payload);
      } catch (err) {
        this.emit("error", err);
      }
    });

    ws.on("close", (code: any, reason: any) => {
      this.stopPing();
      this.emit("close", { code, reason: reason.toString() });
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.on("error", (err: any) => {
      this.emit("error", err);
      // ws löst danach "close" aus → Reconnect wird dort geplant
    });
  }

  public send(obj: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const data = typeof obj === "string" ? obj : JSON.stringify(obj);
      this.ws.send(data);
    }
  }

  public subscribe(keys: string[]): void {
    this.send({ type: "subscribe", param: { keys } });
  }

  public unsubscribe(keys: string[]): void {
    this.send({ type: "unsubscribe", param: { keys } });
  }

  public close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer as any);
      this.reconnectTimer = undefined;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  private normalizeValue(v: any): any {
    if (typeof v === "string") {
      const num = Number(v);
      if (!isNaN(num)) {
        v = num;
      } else {
        try {
          v = Buffer.from(v, "base64").toString("utf8");
        } catch {
          // ignorieren, wenn keine gültige Base64
        }
      }
    }
    if (v === 1 || v === "1") v = true;
    else if (v === 0 || v === "0") v = false;
    return v;
  }

  private normalizeData(obj: any): void {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) this.normalizeData(item);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(obj, "value")) {
      obj.value = this.normalizeValue(obj.value);
    }
    for (const key of Object.keys(obj)) {
      this.normalizeData(obj[key]);
    }
  }

  private startPing(): void {
    this.stopPing();
    if (!this.opts.pingIntervalMs || this.opts.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        try { this.ws.terminate(); } catch { /* ignore */ }
        return;
      }
      try {
        this.awaitingPong = true;
        this.ws.ping();
      } catch { /* ignore */ }
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.awaitingPong = false;
  }

  private scheduleReconnect(): void {
    const { maxMs } = this.opts.reconnect;
    const jitterDelta = this.backoffMs * BACKOFF_JITTER * (Math.random() * 2 - 1);
    const delay = Math.min(maxMs, Math.max(0, this.backoffMs + jitterDelta));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer as any);
      this.reconnectTimer = undefined;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closedByUser) this.connect();
    }, delay);
    this.backoffMs = Math.min(maxMs, Math.max(this.opts.reconnect.minMs, this.backoffMs * BACKOFF_FACTOR));
  }
}
