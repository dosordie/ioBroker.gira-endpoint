import * as utils from "@iobroker/adapter-core";
import { GiraClient } from "./lib/GiraClient";

// Configuration options provided by ioBroker's admin interface
// (extend as needed when more options are supported)
interface AdapterConfig extends ioBroker.AdapterConfig {
  host?: string;
  port?: number;
  ssl?: boolean;
  username?: string;
  password?: string;
  authHeader?: boolean;
  pingIntervalMs?: number;
  reconnect?: { minMs?: number; maxMs?: number };
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
  endpointKeys?:
    | string[]
    | { key: string; name?: string; bool?: boolean; updateOnStart?: boolean }[]
    | string;
  updateLastEvent?: boolean;
  mappings?: {
    stateId: string;
    key: string;
    name?: string;
    toEndpoint?: boolean;
    toState?: boolean;
    bool?: boolean;
    updateOnStart?: boolean;
  }[];
}

export function encodeUidValue(
  val: any,
  boolMode: boolean
): { uidValue: string; ackVal: any; method: "set" | "toggle" } {
  let method: "set" | "toggle" = "set";
  let uidValue: any = val;
  let ackVal: any = val;
  if (boolMode) {
    if (typeof uidValue === "boolean") {
      ackVal = uidValue;
      uidValue = uidValue ? "1" : "0";
    } else if (typeof uidValue === "number") {
      ackVal = uidValue !== 0;
      uidValue = uidValue ? "1" : "0";
    } else if (typeof uidValue === "string") {
      if (uidValue === "true" || uidValue === "false") {
        ackVal = uidValue === "true";
        uidValue = ackVal ? "1" : "0";
      } else if (uidValue === "toggle") {
        uidValue = "1";
        method = "toggle";
      } else if (!isNaN(Number(uidValue))) {
        const num = Number(uidValue);
        ackVal = num !== 0;
        uidValue = num ? "1" : "0";
      } else {
        ackVal = uidValue;
        uidValue = Buffer.from(uidValue, "utf8").toString("base64");
      }
    }
  } else {
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
  }
  return { uidValue: String(uidValue), ackVal, method };
}

export function decodeAckValue(
  val: any,
  boolMode: boolean
): { value: any; type: ioBroker.StateCommon["type"] } {
  if (boolMode) {
    if (typeof val === "number") return { value: val !== 0, type: "boolean" };
    if (typeof val === "string") return { value: val !== "0", type: "boolean" };
    return { value: Boolean(val), type: "boolean" };
  } else {
    if (typeof val === "boolean") return { value: val ? 1 : 0, type: "number" };
    if (typeof val === "number") return { value: val, type: "number" };
    if (typeof val === "string") return { value: val, type: "string" };
    return { value: val, type: "mixed" };
  }
}

class GiraEndpointAdapter extends utils.Adapter {
  private client?: GiraClient;
  private endpointKeys: string[] = [];
  private keyIdMap = new Map<string, string>();
  private keyDescMap = new Map<string, string>();
  private forwardMap = new Map<string, { key: string; bool: boolean }>();
  private reverseMap = new Map<string, { stateId: string; bool: boolean }>();
  private boolKeys = new Set<string>();
  private suppressStateChange = new Set<string>();
  private pendingUpdates = new Map<string, any>();
  private skipInitialUpdate = new Set<string>();
  private pendingSubscriptions = new Set<string>();

  private notifyAdmin(message: string): void {
    this.sendTo("admin", "messageBox", {
      title: "gira-endpoint",
      message,
    });
  }

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
      await this.setObjectNotExistsAsync("info.subscriptions", {
        type: "channel",
        common: { name: "Subscriptions" },
        native: {},
      });
      await this.setStateAsync("info.connection", { val: false, ack: true });
      this.log.debug("Pre-created info states");

      await this.setObjectNotExistsAsync("CO@", {
        type: "channel",
        common: { name: "CO@" },
        native: {},
      });

        const cfg = this.config as unknown as AdapterConfig;
      const host = String(cfg.host ?? "").trim();
      const port = Number(cfg.port ?? 80);
      const ssl = Boolean(cfg.ssl ?? false);
      const path = "/endpoints/ws";
      const username = String(cfg.username ?? "");
      const password = String(cfg.password ?? "");
      const authHeader = Boolean(cfg.authHeader);
      const pingIntervalMs = Number(cfg.pingIntervalMs ?? 30000);

      const boolKeys = new Set<string>();
      const skipInitial = new Set<string>();

      const rawKeys = cfg.endpointKeys;
      const endpointKeys: string[] = [];
      if (Array.isArray(rawKeys)) {
        for (const k of rawKeys) {
          if (typeof k === "object" && k) {
            const key = this.normalizeKey(String((k as any).key ?? "").trim());
            if (!key) continue;
            const name = String((k as any).name ?? "").trim();
            if (name) this.keyDescMap.set(key, name);
            const bool = Boolean((k as any).bool);
            if (bool) boolKeys.add(key);
            const updateOnStart = (k as any).updateOnStart !== false;
            if (!updateOnStart) skipInitial.add(key);
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

      const forwardMap = new Map<string, { key: string; bool: boolean }>();
      const reverseMap = new Map<string, { stateId: string; bool: boolean }>();
      if (Array.isArray(cfg.mappings)) {
        for (const m of cfg.mappings) {
          if (typeof m !== "object" || !m) continue;
          const stateId = String((m as any).stateId ?? "").trim();
          const key = this.normalizeKey(String((m as any).key ?? "").trim());
          if (!stateId || !key) continue;
          const name = String((m as any).name ?? "").trim();
          if (name) this.keyDescMap.set(key, name);
          const toEndpoint = (m as any).toEndpoint !== false;
          const toState = Boolean((m as any).toState);
          const bool = Boolean((m as any).bool);
          const updateOnStart = (m as any).updateOnStart !== false;
          if (!updateOnStart) skipInitial.add(key);
          if (toEndpoint) {
            forwardMap.set(stateId, { key, bool });
            if (bool) boolKeys.add(key);
          }
          if (toState) {
            reverseMap.set(key, { stateId, bool });
            if (bool) boolKeys.add(key);
          }
          if (!endpointKeys.includes(key)) endpointKeys.push(key);
        }
      }
      this.forwardMap = forwardMap;
      this.reverseMap = reverseMap;
      this.boolKeys = boolKeys;
      this.skipInitialUpdate = skipInitial;

      for (const key of endpointKeys) {
        if (!this.keyDescMap.has(key)) this.keyDescMap.set(key, key);
      }
      this.endpointKeys = endpointKeys;

      this.log.info(
        `Configured endpoint keys: ${
          this.endpointKeys.length ? this.endpointKeys.join(", ") : "(none)"
        }`
      );
      if (this.forwardMap.size) {
        this.log.info(
          `Configured forward mappings: ${Array.from(this.forwardMap.entries())
            .map(([s, m]) => `${s}→${m.key}`)
            .join(", ")}`
        );
        for (const stateId of this.forwardMap.keys()) {
          this.subscribeForeignStates(stateId);
        }
      }
      if (this.reverseMap.size) {
        this.log.info(
          `Configured reverse mappings: ${Array.from(this.reverseMap.entries())
            .map(([k, m]) => `${k}→${m.stateId}`)
            .join(", ")}`
        );
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

        const subId = `info.subscriptions.${this.sanitizeId(key)}`;
        await this.setObjectNotExistsAsync(subId, {
          type: "state",
          common: { name: key, type: "boolean", role: "indicator", read: true, write: false },
          native: {},
        });
        await this.setStateAsync(subId, { val: false, ack: true });
      }

      const validIds = new Set(this.keyIdMap.values());
      const validSubIds = new Set(
        this.endpointKeys.map((k) => `info.subscriptions.${this.sanitizeId(k)}`)
      );
      const objs = await this.getAdapterObjectsAsync();
      for (const fullId of Object.keys(objs)) {
        const id = fullId.startsWith(this.namespace + ".")
          ? fullId.slice(this.namespace.length + 1)
          : fullId;
        if (id.startsWith("CO@.")) {
          if (!validIds.has(id)) {
            const msg = `Deleting stale endpoint state ${id}`;
            this.log.info(msg);
            this.notifyAdmin(msg);
            await this.delObjectAsync(id, { recursive: true });
          }
        } else if (id.startsWith("info.subscriptions.")) {
          if (!validSubIds.has(id)) {
            const msg = `Deleting stale subscription state ${id}`;
            this.log.info(msg);
            this.notifyAdmin(msg);
            await this.delObjectAsync(id, { recursive: true });
          }
        } else if (id.startsWith("objekte.")) {
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
      } catch {
        /* ignore */
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
          this.pendingSubscriptions = new Set(
            this.endpointKeys.map((k) => this.normalizeKey(k))
          );
          this.client!.subscribe(this.endpointKeys);
        } else {
          this.log.info("Subscribing to all endpoint events (no keys configured)");
          this.pendingSubscriptions.clear();
          this.client!.subscribe([]);
        }
      });

      this.client.on("close", (info: any) => {
        this.log.warn(`Connection closed (${info?.code || "?"}) ${info?.reason || ""}`);
        this.setState("info.connection", false, true);
        this.getStatesAsync("info.subscriptions.*").then((states: Record<string, ioBroker.State | null>) => {
          for (const id of Object.keys(states)) {
            this.setState(id, { val: false, ack: true });
          }
        }).catch(() => {/* ignore */});
      });

      this.client.on("error", (err: any) => {
        const msg = `Client error: ${err?.message || err}`;
        this.log.error(msg);
        this.setState("info.lastError", String(err?.message || err), true);
        this.notifyAdmin(msg);
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

        if (payload.type === "unsubscribe" && Array.isArray((data as any).items)) {
          for (const item of (data as any).items) {
            if (!item) continue;
            const key =
              item.uid !== undefined
                ? String(item.uid)
                : item.key !== undefined
                ? String(item.key)
                : undefined;
            if (key === undefined) continue;
            const normalized = this.normalizeKey(key);
            const subId = `info.subscriptions.${this.sanitizeId(normalized)}`;
            await this.extendObjectAsync(subId, {
              type: "state",
              common: {
                name: normalized,
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

        const entries: Array<{ key: string; value: any }> = [];

        // Case 1: subscription result lists multiple items
        if (typeof data === "object" && Array.isArray((data as any).items)) {
          const received = new Set<string>();
          for (const item of (data as any).items) {
            if (!item) continue;
            const key =
              item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
            if (key === undefined) continue;
            const normalized = this.normalizeKey(key);
            received.add(normalized);
            const success =
              item.code !== undefined ? item.code === 0 : !("error" in item);
            const subId = `info.subscriptions.${this.sanitizeId(normalized)}`;
            await this.extendObjectAsync(subId, {
              type: "state",
              common: {
                name: normalized,
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
            const value = item.data?.value !== undefined ? item.data.value : item.data ?? item.value;
            entries.push({ key, value });
          }
          const pending = Array.from(this.pendingSubscriptions);
          for (const key of pending) {
            if (!received.has(key)) {
              const subId = `info.subscriptions.${this.sanitizeId(key)}`;
              await this.extendObjectAsync(subId, {
                type: "state",
                common: {
                  name: key,
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
          for (const key of pending) this.pendingSubscriptions.delete(key);
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
          if (this.skipInitialUpdate.has(normalized)) {
            this.log.debug(`Skipping initial update for ${normalized}`);
            this.skipInitialUpdate.delete(normalized);
            continue;
          }
          const boolKey = this.boolKeys.has(normalized);
          const decoded = decodeAckValue(val, boolKey);
          const value = decoded.value;
          const type = decoded.type;

          const pending = this.pendingUpdates.get(normalized);
          if (
            pending !== undefined &&
            (pending === value || pending == (value as any))
          ) {
            this.log.debug(
              `Ignoring echoed event for ${normalized} -> ${JSON.stringify(value)}`
            );
            this.pendingUpdates.delete(normalized);
            continue;
          }
          this.pendingUpdates.delete(normalized);

          const id =
            this.keyIdMap.get(normalized) ?? `CO@.${this.sanitizeId(normalized)}`;
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
            let mappedVal = decodeAckValue(value, mappedForeign.bool).value;
            this.log.debug(
              `Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`
            );
            this.suppressStateChange.add(mappedForeign.stateId);
            await this.setForeignStateAsync(mappedForeign.stateId, { val: mappedVal, ack: true });
            const timer = this.setTimeout(() => {
              this.suppressStateChange.delete(mappedForeign.stateId);
              this.clearTimeout(timer);
            }, 1000);
          }
        }
      });

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
    return s.replace(/^CO@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
  }

  private async onUnload(callback: () => void): Promise<void> {
    try {
      this.log.info("Shutting down...");
      this.client?.removeAllListeners();
      if (this.client) {
        try {
          this.client.unsubscribe(this.endpointKeys);
          const states = await this.getStatesAsync("info.subscriptions.*");
          for (const id of Object.keys(states)) {
            await this.setStateAsync(id, { val: false, ack: true });
          }
        } catch (err) {
          this.log.error(`Unsubscribe failed: ${err}`);
        }
        this.client.close();
      }
    } catch (e) {
      this.log.error(`onUnload error: ${e}`);
    } finally {
      callback();
    }
  }

  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (!state || !this.client) return;

    const mapped = this.forwardMap.get(id);
    if (mapped) {
      if (this.suppressStateChange.has(id)) {
        this.log.debug(`Ignoring state change for ${id} because it was just updated from endpoint`);
        return;
      }
      const { uidValue, ackVal, method } = encodeUidValue(state.val, mapped.bool);
      this.client.call(mapped.key, method, uidValue);
      const mappedId = this.keyIdMap.get(mapped.key) ?? `CO@.${this.sanitizeId(mapped.key)}`;
      this.keyIdMap.set(mapped.key, mappedId);
      this.setState(mappedId, { val: ackVal, ack: true });
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

    if (state.ack) return;
    const key = id.split(".").pop();
    if (!key) return;
    const boolKey = this.boolKeys.has(this.normalizeKey(key));
    const { uidValue, ackVal, method } = encodeUidValue(state.val, boolKey);
    const normKey = this.normalizeKey(key);
    this.client.call(normKey, method, uidValue);
    const mappedForeign = this.reverseMap.get(normKey);
    if (mappedForeign) {
      let mappedVal = decodeAckValue(ackVal, mappedForeign.bool).value;
      this.log.debug(
        `Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`
      );
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
  module.exports = (options: any) => new GiraEndpointAdapter(options);
  (module.exports as any).encodeUidValue = encodeUidValue;
  (module.exports as any).decodeAckValue = decodeAckValue;
} else {
  (() => new GiraEndpointAdapter())();
}
