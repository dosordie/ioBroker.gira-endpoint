import * as utils from "@iobroker/adapter-core";
import { GiraClient } from "./lib/GiraClient";

// Configuration options provided by ioBroker's admin interface
// (extend as needed when more options are supported)
type NativeConfig = {
  host?: string;
  port?: number;
  ssl?: boolean;
  path?: string;
  username?: string;
  password?: string;
  queryAuth?: boolean;
  pingIntervalMs?: number;
  reconnect?: { minMs?: number; maxMs?: number; factor?: number; jitter?: number };
};

class GiraEndpointAdapter extends utils.Adapter {
  private client?: GiraClient;

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "gira-endpoint",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  private async onReady(): Promise<void> {
    try {
      await this.setStateAsync("info.connection", { val: false, ack: true });

      const cfg = this.config as unknown as NativeConfig;
      const host = String(cfg.host ?? "").trim();
      const port = Number(cfg.port ?? 80);
      const ssl = Boolean(cfg.ssl ?? false);
      const queryAuth = Boolean(cfg.queryAuth ?? false);
      const path = queryAuth ? "/endpoints/ws" : String(cfg.path ?? "/").trim() || "/";
      const username = String(cfg.username ?? "");
      const password = String(cfg.password ?? "");
      const pingIntervalMs = Number(cfg.pingIntervalMs ?? 30000);

      this.client = new GiraClient({ host, port, ssl, path, username, password, pingIntervalMs, queryAuth });

      this.client.on("open", () => {
        this.log.info(`Connected to ${ssl ? "wss" : "ws"}://${host}:${port}${path}`);
        this.setState("info.connection", true, true);
      });

      this.client.on("close", (info: any) => {
        this.log.warn(`Connection closed (${info?.code || "?"}) ${info?.reason || ""}`);
        this.setState("info.connection", false, true);
      });

      this.client.on("error", (err: any) => {
        this.log.error(`Client error: ${err?.message || err}`);
        this.setState("info.lastError", String(err?.message || err), true);
      });

      this.client.on("event", async (payload: any) => {
        // TODO: Mapping auf echte Gira-Events
        await this.setStateAsync("info.lastEvent", { val: JSON.stringify(payload), ack: true });
        // Beispiel: wenn payload {topic:"sensor/xyz", value:123}
        if (payload && payload.topic) {
          const id = this.sanitizeId(String(payload.topic));
          await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { name: id, type: "mixed", role: "state", read: true, write: false },
            native: {},
          });
          await this.setStateAsync(id, { val: payload.value ?? payload, ack: true });
        }
      });

      this.client.connect();
    } catch (e: any) {
      this.log.error(`onReady failed: ${e?.message || e}`);
    }
  }

  private sanitizeId(s: string): string {
    return s.replace(/[^a-z0-9_\-\.]/gi, "_");
  }

  private async onUnload(callback: () => void): Promise<void> {
    try {
      this.log.info("Shutting down...");
      this.client?.removeAllListeners();
      this.client?.close();
    } catch (e) {
      this.log.error(`onUnload error: ${e}`);
    } finally {
      callback();
    }
  }
}

if (module.parent) {
  module.exports = (options: any) => new GiraEndpointAdapter(options);
} else {
  (() => new GiraEndpointAdapter())();
}
