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
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
  endpointKeys?: string;
};

class GiraEndpointAdapter extends utils.Adapter {
  private client?: GiraClient;
  private endpointKeys: string[] = [];

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "gira-endpoint",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
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
      
      const endpointKeys = String(cfg.endpointKeys ?? "")
        .split(/[,;\s]+/)
        .map((k) => k.trim())
        .filter((k) => k);
      this.endpointKeys = endpointKeys;

      const ca = cfg.ca ? String(cfg.ca) : undefined;
      const cert = cfg.cert ? String(cfg.cert) : undefined;
      const key = cfg.key ? String(cfg.key) : undefined;
      const rejectUnauthorized = cfg.rejectUnauthorized !== undefined ? Boolean(cfg.rejectUnauthorized) : undefined;
      const tls = { ca, cert, key, rejectUnauthorized };

      // Instantiate client once with all relevant options
      this.client = new GiraClient({
        host,
        port,
        ssl,
        path,
        username,
        password,
        pingIntervalMs,
        queryAuth,
        tls,
      });

      this.client.on("open", () => {
        this.log.info(`Connected to ${ssl ? "wss" : "ws"}://${host}:${port}${path}`);
        this.setState("info.connection", true, true);
        if (this.endpointKeys.length) this.client!.subscribe(this.endpointKeys);
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
        const data = payload?.data;
        if (!data || data.uid === undefined) return;
        const id = this.sanitizeId(String(data.uid));
        const val = data.value;
        let type: ioBroker.StateCommon["type"] = "mixed";
        if (typeof val === "boolean") type = "boolean";
        else if (typeof val === "number") type = "number";
        else if (typeof val === "string") type = "string";
        await this.setObjectNotExistsAsync(id, {
          type: "state",
          common: { name: id, type, role: "state", read: true, write: false },
          native: {},
        });
        await this.setStateAsync(id, { val, ack: true });
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
      this.subscribeStates("control.subscribe");
      this.subscribeStates("control.unsubscribe");

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

  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (!state || state.ack || !this.client) return;
    const key = id.split(".").pop();
    const keys = String(state.val || "")
      .split(/[,;\s]+/)
      .map((k) => k.trim())
      .filter((k) => k);
    if (!keys.length) return;
    if (key === "subscribe") {
      this.client.subscribe(keys);
      this.setState(id, { val: state.val, ack: true });
    } else if (key === "unsubscribe") {
      this.client.unsubscribe(keys);
      this.setState(id, { val: state.val, ack: true });
    }
  }
}

if (module.parent) {
  module.exports = (options: any) => new GiraEndpointAdapter(options);
} else {
  (() => new GiraEndpointAdapter())();
}
