import * as utils from "@iobroker/adapter-core";
import { GiraClient } from "./lib/GiraClient";

// Configuration options provided by ioBroker's admin interface
// (extend as needed when more options are supported)
interface AdapterConfig extends ioBroker.AdapterConfig {
  host?: string;
  port?: number;
  ssl?: boolean;
  path?: string;
  username?: string;
  password?: string;
  pingIntervalMs?: number;
  reconnect?: { minMs?: number; maxMs?: number };
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
  endpointKeys?: string[] | { key: string; name?: string }[] | string;
  updateLastEvent?: boolean;
  forwardMappings?: { stateId: string; key: string; name?: string }[];
}

class GiraEndpointAdapter extends utils.Adapter {
  private client?: GiraClient;
  private endpointKeys: string[] = [];
  private keyIdMap = new Map<string, string>();
  private keyDescMap = new Map<string, string>();
  private forwardMap = new Map<string, string>();

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

      await this.setObjectNotExistsAsync("objekte", {
        type: "channel",
        common: { name: "Objekte" },
        native: {},
      });

        const cfg = this.config as unknown as AdapterConfig;
        const host = String(cfg.host ?? "").trim();
        const port = Number(cfg.port ?? 80);
        const ssl = Boolean(cfg.ssl ?? false);
        const path = String(cfg.path ?? "/endpoints/ws").trim() || "/endpoints/ws";
      const username = String(cfg.username ?? "");
      const password = String(cfg.password ?? "");
      const pingIntervalMs = Number(cfg.pingIntervalMs ?? 30000);

      const rawKeys = cfg.endpointKeys;
      const endpointKeys: string[] = [];
      if (Array.isArray(rawKeys)) {
        for (const k of rawKeys) {
          if (typeof k === "object" && k) {
            const key = this.normalizeKey(String((k as any).key ?? "").trim());
            if (!key) continue;
            const name = String((k as any).name ?? "").trim();
            if (name) this.keyDescMap.set(key, name);
            endpointKeys.push(key);
          } else {
            const key = this.normalizeKey(String(k).trim());
            if (!key) continue;
            endpointKeys.push(key);
          }
        }
      } else {
        const arr = String(rawKeys ?? "")
          .split(/[,;\s]+/)
          .map((k) => k.trim())
          .filter((k) => k)
          .map((k) => this.normalizeKey(k));
        endpointKeys.push(...arr);
      }
      for (const key of endpointKeys) {
        if (!this.keyDescMap.has(key)) this.keyDescMap.set(key, key);
      }
      this.endpointKeys = endpointKeys;

      this.log.info(
        `Configured endpoint keys: ${
          this.endpointKeys.length ? this.endpointKeys.join(", ") : "(none)"
        }`
      );

      const forwardMap = new Map<string, string>();
      if (Array.isArray(cfg.forwardMappings)) {
        for (const m of cfg.forwardMappings) {
          if (typeof m !== "object" || !m) continue;
          const stateId = String((m as any).stateId ?? "").trim();
          const key = this.normalizeKey(String((m as any).key ?? "").trim());
          if (!stateId || !key) continue;
          const name = String((m as any).name ?? "").trim();
          if (name) this.keyDescMap.set(key, name);
          forwardMap.set(stateId, key);
        }
      }
      this.forwardMap = forwardMap;
      if (this.forwardMap.size) {
        this.log.info(
          `Configured forward mappings: ${Array.from(this.forwardMap.entries())
            .map(([s, k]) => `${s}→${k}`)
            .join(", ")}`
        );
        for (const stateId of this.forwardMap.keys()) {
          this.subscribeForeignStates(stateId);
        }
      }

      // Pre-create configured endpoint states so they appear immediately in ioBroker
      for (const key of this.endpointKeys) {
        const id = `objekte.${this.sanitizeId(key)}`;
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
          this.client!.subscribe(this.endpointKeys);
        } else {
          this.log.info("Subscribing to all endpoint events (no keys configured)");
          this.client!.subscribe([]);
        }
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
        // Provide full event information for debugging
        this.log.debug(`Received event: ${JSON.stringify(payload)}`);
        if (this.config.updateLastEvent) {
          await this.setStateAsync("info.lastEvent", {
            val: JSON.stringify(payload),
            ack: true,
          });
        }

        const data = payload?.data;
        if (!data) return;

        const entries: Array<{ key: string; value: any }> = [];

        // Case 1: subscription result lists multiple items
        if (typeof data === "object" && Array.isArray((data as any).items)) {
          for (const item of (data as any).items) {
            if (!item) continue;
            const key =
              item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
            if (key === undefined) continue;
            const value = item.data?.value !== undefined ? item.data.value : item.data ?? item.value;
            entries.push({ key, value });
          }
          // Case 2: push event with subscription key
        } else if (payload?.subscription?.key && typeof data === "object" && "value" in data) {
          entries.push({ key: String(payload.subscription.key), value: (data as any).value });

          // Case 3: array of events
        } else if (Array.isArray(data)) {
          for (const item of data) {
            if (!item) continue;
            const key =
              item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
            if (key === undefined) continue;
            entries.push({ key, value: item.value });
          }
          // Case 4: object containing key/uid or generic key-value pairs
        } else if (typeof data === "object") {
          if ((data as any).uid !== undefined || (data as any).key !== undefined) {
            const key = (data as any).uid !== undefined ? String((data as any).uid) : String((data as any).key);
            const value = (data as any).data?.value !== undefined ? (data as any).data.value : (data as any).value;
            entries.push({ key, value });
          } else {
            for (const [key, val] of Object.entries(data)) {
              const value = (val as any)?.value !== undefined ? (val as any).value : val;
              entries.push({ key, value });
            }
          }
        }

        for (const { key, value: val } of entries) {
          const normalized = this.normalizeKey(key);
          const id =
            this.keyIdMap.get(normalized) ?? `objekte.${this.sanitizeId(normalized)}`;
          this.keyIdMap.set(normalized, id);
          let value: any = val;
          let type: ioBroker.StateCommon["type"] = "mixed";
          if (typeof val === "boolean") {
            type = "number";
            value = val ? 1 : 0;
          } else if (typeof val === "number") type = "number";
          else if (typeof val === "string") type = "string";
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
    } catch (e: any) {
      this.log.error(`onReady failed: ${e?.message || e}`);
    }
  }

  private normalizeKey(k: string): string {
    k = k.trim().toUpperCase();
    return k.startsWith("CO@") ? k : `CO@${k}`;
  }

  private sanitizeId(s: string): string {
    return s.replace(/[^a-z0-9@_\-\.]/gi, "_").toUpperCase();
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
    if (!state || !this.client) return;

    const mappedKey = this.forwardMap.get(id);
    if (mappedKey) {
      let uidValue: any = state.val;
      if (typeof uidValue === "boolean") {
        uidValue = uidValue ? "1" : "0";
      } else if (typeof uidValue === "string") {
        if (uidValue === "true" || uidValue === "false") {
          uidValue = uidValue === "true" ? "1" : "0";
        } else if (isNaN(Number(uidValue))) {
          uidValue = Buffer.from(uidValue, "utf8").toString("base64");
        }
      }
      this.client.send({ type: "call", param: { key: mappedKey, method: "set", value: uidValue } });
      return;
    }

    if (state.ack) return;
    const key = id.split(".").pop();
    if (!key) return;
    if (key === "subscribe" || key === "unsubscribe") {
      const keys = String(state.val || "")
        .split(/[,;\s]+/)
        .map((k) => k.trim())
        .filter((k) => k)
        .map((k) => this.normalizeKey(k));
      if (!keys.length) return;
      if (key === "subscribe") {
        this.client.subscribe(keys);
      } else {
        this.client.unsubscribe(keys);
      }
      this.setState(id, { val: state.val, ack: true });
      return;
    }

    let uidValue: any = state.val;
    let method = "set";
    let ackVal: any = state.val;
    if (typeof uidValue === "boolean") {
      ackVal = uidValue ? 1 : 0;
      uidValue = uidValue ? "1" : "0";
    } else if (typeof uidValue === "string") {
      if (uidValue === "true" || uidValue === "false") {
        ackVal = uidValue === "true" ? 1 : 0;
        uidValue = uidValue === "true" ? "1" : "0";
      } else if (uidValue === "toggle") {
        uidValue = "1";
        method = "toggle";
      } else if (isNaN(Number(uidValue))) {
        uidValue = Buffer.from(uidValue, "utf8").toString("base64");
      }
    }
    this.client.send({ type: "call", param: { key, method, value: uidValue } });
    this.setState(id, { val: ackVal, ack: true });
  }
}

if (module.parent) {
  module.exports = (options: any) => new GiraEndpointAdapter(options);
} else {
  (() => new GiraEndpointAdapter())();
}
