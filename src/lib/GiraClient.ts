import { EventEmitter } from "events";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

// Kein Listener-Limit (verhindert MaxListeners-Warnungen global hier)
EventEmitter.defaultMaxListeners = 0;

export interface GiraClientOptions {
  host: string;
  port: number;
  ssl: boolean;
  path: string;
  username?: string;
  password?: string;
  pingIntervalMs?: number;
  reconnect?: {
    minMs: number; maxMs: number; factor: number; jitter: number;
  };
  tls?: {
    ca?: string | Buffer | Array<string | Buffer>;
    cert?: string | Buffer;
    key?: string | Buffer;
    rejectUnauthorized?: boolean;
  };
}

export class GiraClient extends EventEmitter {
  private ws?: WebSocket;
  private closedByUser = false;
  private opts: Required<GiraClientOptions>;
  private backoffMs: number;
  private pingTimer?: NodeJS.Timeout;

  constructor(opts: GiraClientOptions) {
    super();
    // Defaults + Merge ohne doppelte Literal-Keys (TS2783 vermeiden)
    const defaults: Required<GiraClientOptions> = {
      host: "",
      port: 80,
      ssl: false,
      path: "/",
      username: "",
      password: "",
      pingIntervalMs: 30000,
      reconnect: { minMs: 1000, maxMs: 30000, factor: 1.7, jitter: 0.2 },
      tls: {},
    };
    this.opts = Object.assign({}, defaults, opts);
    this.backoffMs = this.opts.reconnect.minMs;
  }

  public connect(): void {
    this.closedByUser = false;
    const scheme = this.opts.ssl ? "wss" : "ws";
    const path = this.opts.path.startsWith("/") ? this.opts.path : `/${this.opts.path}`;
    const url = `${scheme}://${this.opts.host}:${this.opts.port}${path}`;

    const headers: Record<string, string> = {};
    if (this.opts.username) {
      const token = Buffer.from(`${this.opts.username}:${this.opts.password ?? ""}`).toString("base64");
      headers["Authorization"] = `Basic ${token}`;
    }

    const wsOpts: WebSocket.ClientOptions = { headers, ...this.opts.tls };
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) wsOpts.agent = new HttpsProxyAgent(proxy);

    this.ws = new WebSocket(url, wsOpts);

    this.ws.on("open", () => {
      this.emit("open");
      this.backoffMs = this.opts.reconnect.minMs;
      this.startPing();
    });

    this.ws.on("message", (data) => {
      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        // Gira-Event-Format: hier anpassen. Wir nehmen zunächst JSON an.
        let payload: any;
        try { payload = JSON.parse(text); } catch {
          payload = { raw: text };
        }
        this.emit("event", payload);
      } catch (err) {
        this.emit("error", err);
      }
    });

    this.ws.on("close", (code, reason) => {
      this.stopPing();
      this.emit("close", { code, reason: reason.toString() });
      if (!this.closedByUser) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
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

  public close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  private startPing(): void {
    this.stopPing();
    if (!this.opts.pingIntervalMs || this.opts.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      try { this.send({ type: "ping", ts: Date.now() }); } catch { /* ignore */ }
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private scheduleReconnect(): void {
    const { maxMs, factor, jitter } = this.opts.reconnect;
    const jitterDelta = this.backoffMs * jitter * (Math.random() * 2 - 1);
    const delay = Math.min(maxMs, Math.max(0, this.backoffMs + jitterDelta));
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, delay);
    this.backoffMs = Math.min(maxMs, Math.max(this.opts.reconnect.minMs, this.backoffMs * factor));
  }
}
