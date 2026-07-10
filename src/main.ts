import * as utils from "@iobroker/adapter-core";
import { GiraClient, codeToMessage } from "./lib/GiraClient";
import { randomUUID } from "crypto";
import { format } from "util";
import { decodeAckValue, decodeCoValue, encodeUidValue, TextEncoding } from "./lib/valueConversion";
import { parseAdapterConfig, ForwardMapping, ReverseMapping, UpdateOnStartSource, ArchiveQueryDefaults } from "./lib/configParser";
import { buildLastArchiveQuery, isExecutableArchiveQuery, normalizeArchiveCols, normalizeArchiveQuery } from "./lib/archiveQuery";

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
    | {
        key: string;
        name?: string;
        bool?: boolean;
        updateOnStart?: boolean;
        enabled?: boolean;
        textEncoding?: TextEncoding;
      }[]
    | string;
  endpointGroups?: {
    group?: string;
    keys: {
      key: string;
      name?: string;
      bool?: boolean;
      updateOnStart?: boolean;
      enabled?: boolean;
      textEncoding?: TextEncoding;
    }[];
  }[];
  updateLastEvent?: boolean;
  mappings?: {
    stateId: string;
    key: string;
    name?: string;
    toEndpoint?: boolean;
    toState?: boolean;
    bool?: boolean;
    ack?: boolean;
    updateOnStart?: boolean;
    enabled?: boolean;
    textEncoding?: TextEncoding;
  }[]; // legacy support
  mappingGroups?: {
    group?: string;
    mappings: {
      stateId: string;
      key: string;
      name?: string;
      toEndpoint?: boolean;
      toState?: boolean;
      bool?: boolean;
      ack?: boolean;
      updateOnStart?: boolean;
      enabled?: boolean;
      textEncoding?: TextEncoding;
    }[];
  }[];
  dataArchives?:
    | string[]
    | {
        key: string;
        name?: string;
        startat?: string;
        cnt?: number;
        size?: number;
        cols?: string[] | string;
        mode?: "manual" | "last";
        lastCnt?: number;
        blockSize?: number;
        start?: string;
        end?: string;
        columns?: string[] | string;
        enabled?: boolean;
      }[]
    | string;
}


class GiraEndpointAdapter extends utils.Adapter {
  private client?: GiraClient;
  private endpointKeys: string[] = [];
  private keyIdMap = new Map<string, string>();
  private idKeyMap = new Map<string, string>();
  private keyDescMap = new Map<string, string>();
  private keyCaseMap = new Map<string, string>();
  private forwardMap = new Map<string, ForwardMapping>();
  private keyTextEncodingMap = new Map<string, TextEncoding>();
  private reverseMap = new Map<string, ReverseMapping>();
  private boolKeys = new Set<string>();
  private suppressStateChange = new Set<string>();
  private pendingUpdates = new Map<string, any>();
  private skipInitialUpdate = new Set<string>();
  private initialSkipUpdate = new Set<string>();
  private updateOnStartSources: UpdateOnStartSource[] = [];
  private pendingSubscriptions = new Set<string>();
  private isConnected = false;
  private pendingHsRestart = false;
  private archiveKeys: string[] = [];
  private archiveKeyIdMap = new Map<string, string>();
  private archiveIdKeyMap = new Map<string, string>();
  private archiveDescMap = new Map<string, string>();
  private archiveQueryDefaults = new Map<string, ArchiveQueryDefaults>();
  private fetchedMeta = new Set<string>();


  private formatLogValue(value: any, maxLength = 200): string {
    let text: string;
    try {
      text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
    } catch {
      text = String(value);
    }
    if (text === undefined) text = String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }

  private logOutgoingCoValue(args: {
    source: "direct" | "mapping" | "updateOnStart";
    stateId?: string;
    key: string;
    method: "set" | "toggle";
    ackVal: any;
    uidValue: string;
    bool: boolean;
    textEncoding: TextEncoding;
  }): void {
    const statePart = args.stateId ? ` stateId=${args.stateId}` : "";
    this.log.debug(
      `Sending CO value source=${args.source}${statePart} key=${args.key} method=${args.method} ackVal=${this.formatLogValue(args.ackVal)} uidValue=${this.formatLogValue(args.uidValue)} bool=${args.bool} textEncoding=${args.textEncoding}`
    );
  }

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
    const origTranslate = (this as any).translate;
    (this as any).translate = (
      text: string,
      ...args: any[]
    ): string => {
      if (typeof origTranslate === "function") {
        return origTranslate.call(this, text, ...args);
      }
      return args.length ? format(text, ...args) : text;
    };
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
  }

  private async onReady(): Promise<void> {
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

      const cfg = this.config as unknown as AdapterConfig;
      const parsed = parseAdapterConfig(cfg, {
        normalizeKey: this.normalizeKey.bind(this),
        normalizeArchiveKey: this.normalizeArchiveKey.bind(this),
        makeEndpointBaseId: this.makeEndpointBaseId.bind(this),
      });
      const {
        host,
        port,
        ssl,
        path,
        username,
        password,
        authHeader,
        pingIntervalMs,
        reconnect,
        ca,
        cert,
        key,
        rejectUnauthorized,
      } = parsed.connection;

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
        if (!this.keyDescMap.has(key)) this.keyDescMap.set(key, key);
      }

      const endpointKeysText = this.endpointKeys.length
        ? this.endpointKeys.join(", ")
        : this.translate("(none)");
      this.log.info(
        this.translate("Configured endpoint keys: %s", endpointKeysText)
      );
      const archiveKeysText = this.archiveKeys.length
        ? this.archiveKeys.join(", ")
        : this.translate("(none)");
      this.log.info(
        this.translate("Configured data archive keys: %s", archiveKeysText)
      );
      if (this.forwardMap.size) {
        this.log.info(
          this.translate(
            "Configured forward mappings: %s",
            Array.from(this.forwardMap.entries())
              .map(([s, m]) => `${s}→${m.key}`)
              .join(", ")
          )
        );
        for (const stateId of this.forwardMap.keys()) {
          this.subscribeForeignStates(stateId);
        }
      }
      if (this.reverseMap.size) {
        this.log.info(
          this.translate(
            "Configured reverse mappings: %s",
            Array.from(this.reverseMap.entries())
              .map(([k, m]) => `${k}→${m.stateId}`)
              .join(", ")
          )
        );
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
        this.log.debug(
          this.translate("Pre-created endpoint channel %s", baseId)
        );
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

      const validBaseIds = new Set(
        this.endpointKeys.map((k) => this.makeEndpointBaseId(k))
      );
      const validArchiveBases = new Set(
        this.archiveKeys.map((k) => `DA@.${this.sanitizeArchiveId(k)}`)
      );
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
        } else if (id.startsWith("DA@.")) {
          const base = id.split(".").slice(0, 2).join(".");
          if (!validArchiveBases.has(base)) {
            const msg = this.translate(
              "Deleting stale data archive state %s",
              id
            );
            this.log.info(msg);
            this.notifyAdmin(msg);
            await this.delObjectAsync(id, { recursive: true });
          }
        } else if (id.startsWith("info.subscriptions")) {
          const msg = this.translate(
            "Deleting legacy subscription state %s",
            id
          );
          this.log.info(msg);
          this.notifyAdmin(msg);
          await this.delObjectAsync(id, { recursive: true });
        } else if (id.startsWith("objekte.")) {
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
      } catch {
        /* ignore */
      }

      const tls = {
        ca: ca ? String(ca) : undefined,
        cert: cert ? String(cert) : undefined,
        key: key ? String(key) : undefined,
        rejectUnauthorized:
          rejectUnauthorized !== undefined
            ? Boolean(rejectUnauthorized)
            : undefined,
      };

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
          this.pendingSubscriptions = new Set(
            this.endpointKeys.map((k) => this.normalizeKey(k))
          );
          this.client!.subscribe(this.endpointKeys);
        } else {
          this.log.info(
            this.translate("Subscribing to all endpoint events (no keys configured)")
          );
          this.pendingSubscriptions.clear();
          this.client!.subscribe([]);
        }
        for (const [key, params] of this.archiveQueryDefaults.entries()) {
          const baseId = this.archiveKeyIdMap.get(key);
          if (!baseId) continue;
          if (params.mode === "last") continue;
          const queryParams = normalizeArchiveQuery(params);
          if (!isExecutableArchiveQuery(queryParams)) continue;
          const prom = this.client!.call(key, "get", queryParams, this.makeTag("get"));
          if (prom) {
            prom
              .then((resp: any) => {
                this.setState(`${baseId}.data`, {
                  val: JSON.stringify(resp.data),
                  ack: true,
                });
                this.setState(`${baseId}.lastResult`, {
                  val: JSON.stringify(resp.data),
                  ack: true,
                });
              })
              .catch((err: any) => {
                this.log.error(
                  this.translate(
                    "Get call failed for %s: %s",
                    key,
                    err?.message || err
                  )
                );
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

      this.client.on("close", (info: any) => {
        const msg = this.translate(
          "Connection closed (%s) %s",
          info?.code || "?",
          info?.reason || ""
        );
        this.log.warn(msg);
        this.isConnected = false;
        this.setState("info.connection", false, true);
        this.getStatesAsync("CO@.*.subscription")
          .then((states: Record<string, ioBroker.State | null>) => {
            for (const id of Object.keys(states)) {
              this.setState(id, { val: false, ack: true });
            }
          })
          .catch(() => {
            /* ignore */
          });
      });

      this.client.on("error", (err: any) => {
        const msg = this.translate("Client error: %s", err?.message || err);
        this.log.error(msg);
        this.setState("info.lastError", String(err?.message || err), true);
        this.notifyAdmin(msg);
      });

      this.client.on("event", async (payload: any) => {
        // Provide full event information for debugging
        this.log.debug(
          this.translate("Received event: %s", JSON.stringify(payload))
        );
        if (this.config.updateLastEvent) {
          await this.setStateAsync("info.lastEvent", {
            val: JSON.stringify(payload),
            ack: true,
          });
        }

        const data = payload?.data;
        if (!data) return;

        const tag = payload?.tag;
        if (typeof tag === "string" && tag.startsWith("meta_")) {
          // Responses for meta calls are handled separately
          return;
        }

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
            this.rememberKeyCase(normalized, String(key));
            const baseId =
              this.keyIdMap.get(normalized) ?? this.makeEndpointBaseId(normalized);
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
            const message = codeToMessage(item.code ?? payload.code ?? 0);
            const statusText =
              typeof this.translate === "function"
                ? this.translate(message)
                : message;
            await this.setStateAsync(`${baseId}.status`, {
              val: statusText,
              ack: true,
            });
            if (item.code !== undefined && item.code !== 0) {
              const msg = this.translate(
                "Unsubscribe failed for %s (%s)",
                normalized,
                item.code
              );
              this.log.warn(msg);
              this.notifyAdmin(msg);
            }
          }
          return;
        }

        const entries: Array<{ key: string; data: any; code?: number }> = [];

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
            this.rememberKeyCase(normalized, String(key));
            const baseId =
              this.keyIdMap.get(normalized) ?? this.makeEndpointBaseId(normalized);
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
              let msg = this.translate(
                "Subscription failed for %s",
                normalized
              );
              if (item.code !== undefined) {
                const message = codeToMessage(item.code);
                const statusText =
                  typeof this.translate === "function"
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
              const baseId =
                this.keyIdMap.get(key) ?? this.makeEndpointBaseId(key);
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
          for (const key of pending) this.pendingSubscriptions.delete(key);
          // Case 2: push event with subscription key
        } else if (payload?.subscription?.key && typeof data === "object" && "value" in data) {
          entries.push({ key: String(payload.subscription.key), data, code: payload.code });

          // Case 3: array of events
        } else if (Array.isArray(data)) {
          for (const item of data) {
            if (!item) continue;
            const key =
              item.uid !== undefined ? String(item.uid) : item.key !== undefined ? String(item.key) : undefined;
            if (key === undefined) continue;
            entries.push({ key, data: item, code: item.code });
          }
          // Case 4: object containing key/uid or generic key-value pairs
        } else if (typeof data === "object") {
          if ((data as any).uid !== undefined || (data as any).key !== undefined) {
            const key = (data as any).uid !== undefined ? String((data as any).uid) : String((data as any).key);
            const value = (data as any).data ?? { value: (data as any).value };
            entries.push({ key, data: value, code: (data as any).code });
          } else {
            for (const [key, val] of Object.entries(data)) {
              if (!key.includes("@")) {
                this.log.debug(
                  this.translate("Ignoring property %s without @", key)
                );
                continue;
              }
              const obj = typeof val === "object" && val !== null ? val : { value: val };
              entries.push({ key, data: obj, code: (val as any)?.code });
            }
          }
        }

        for (const { key, data, code } of entries) {
          const normalized = this.normalizeKey(key);
          this.rememberKeyCase(normalized, String(key));
          if (this.skipInitialUpdate.has(normalized)) {
            this.log.debug(
              this.translate("Skipping initial update for %s", normalized)
            );
            this.skipInitialUpdate.delete(normalized);
            continue;
          }
          const boolKey = this.boolKeys.has(normalized);
          const textEncoding = this.keyTextEncodingMap.get(normalized) ?? "utf8";
          const rawVal = data.value;
          const decoded = decodeCoValue(rawVal, boolKey, textEncoding);
          const value = decoded.value;
          const type = decoded.type;

          const pending = this.pendingUpdates.get(normalized);
          if (
            pending !== undefined &&
            (pending === value || pending == (value as any))
          ) {
            this.log.debug(
              this.translate(
                "Ignoring echoed event for %s -> %s",
                normalized,
                JSON.stringify(value)
              )
            );
            this.pendingUpdates.delete(normalized);
            continue;
          }
          this.pendingUpdates.delete(normalized);

          const baseId =
            this.keyIdMap.get(normalized) ?? this.makeEndpointBaseId(normalized);
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
            let msg = this.translate(
              "Subscription failed for %s",
              normalized
            );
            if (code !== undefined) {
              const message = codeToMessage(code);
              const statusText =
                typeof this.translate === "function"
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

          const message = codeToMessage(code ?? payload.code ?? 0);
          const statusText =
            typeof this.translate === "function"
              ? this.translate(message)
              : message;
          await this.setStateAsync(`${baseId}.status`, {
            val: statusText,
            ack: true,
          });

          for (const [prop, raw] of Object.entries(data)) {
            const isValue = prop === "value";
            let val: any = raw;
            let stateType: ioBroker.StateCommon["type"];
            let role = "state";
            if (isValue) {
              val = value;
              stateType = type;
            } else if (typeof raw === "object") {
              val = JSON.stringify(raw);
              stateType = "string";
              role = "json";
            } else if (typeof raw === "boolean") {
              stateType = "boolean";
            } else if (typeof raw === "number") {
              stateType = "number";
            } else {
              stateType = "string";
            }
            const propId = `${baseId}.${this.sanitizeProp(prop)}`;
            await this.extendObjectAsync(propId, {
              type: "state",
              common: { name: prop, type: stateType, role, read: true, write: isValue },
              native: {},
            });
            if (isValue) this.subscribeStates(propId);
            this.log.debug(
              this.translate(
                "Updating state %s -> %s",
                propId,
                JSON.stringify(val)
              )
            );
            await this.setStateAsync(propId, { val, ack: true });
            if (isValue) {
              const mappedForeign = this.reverseMap.get(normalized);
              if (mappedForeign) {
                let mappedVal = decodeAckValue(val, mappedForeign.bool).value;
                this.log.debug(
                  this.translate(
                    "Updating mapped foreign state %s -> %s",
                    mappedForeign.stateId,
                    JSON.stringify(mappedVal)
                  )
                );
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
    } catch (e: any) {
      this.log.error(
        this.translate("onReady failed: %s", e?.message || e)
      );
    }
  }

  private normalizeKey(k: string): string {
    k = k.trim().toUpperCase();
    return k.startsWith("CO@") ? k : `CO@${k}`;
  }

  private rememberKeyCase(normalized: string, original: string): void {
    if (!normalized) return;
    const trimmed = String(original ?? "").trim();
    if (!trimmed) return;
    const suffix = trimmed.replace(/^CO@/i, "");
    this.keyCaseMap.set(normalized, `CO@${suffix}`);
  }

  private getCasePreservedKey(normalized: string): string {
    return this.keyCaseMap.get(normalized) ?? normalized;
  }

  private makeEndpointBaseId(normalized: string): string {
    const casedKey = this.getCasePreservedKey(normalized);
    const sanitized = this.sanitizeId(casedKey);
    return `CO@.${sanitized}`;
  }

  private sanitizeId(s: string): string {
    return s.replace(/^CO@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_");
  }

  private normalizeArchiveKey(k: string): string {
    k = k.trim().toUpperCase();
    return k.startsWith("DA@") ? k : `DA@${k}`;
  }

  private sanitizeArchiveId(s: string): string {
    return s.replace(/^DA@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
  }

  private sanitizeProp(s: string): string {
    return s.replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
  }

  private makeTag(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }

  private async applyMeta(
    key: string,
    baseId: string,
    meta: any,
    archive = false
  ): Promise<void> {
    if (!meta || typeof meta !== "object") return;
    const name = meta.desc || meta.name || meta.label;
    if (!name) return;
    if (archive) {
      this.archiveDescMap.set(key, name);
    } else {
      this.keyDescMap.set(key, name);
    }
    await this.extendObjectAsync(baseId, {
      type: "channel",
      common: { name },
      native: {},
    });
  }

  private async fetchMeta(key: string, baseId: string): Promise<void> {
    if (!this.client) return;
    try {
      const metaResp = await this.client.call(
        key,
        "meta",
        undefined,
        this.makeTag("meta")
      );
      if (metaResp?.data !== undefined) {
        await this.applyMeta(key, baseId, metaResp.data);
        await this.setStateAsync(`${baseId}.meta`, {
          val: JSON.stringify(metaResp.data),
          ack: true,
        });
      }
    } catch (err: any) {
      this.log.error(
        this.translate("Meta call failed for %s: %s", key, err?.message || err)
      );
    }
  }

  private async triggerUpdateOnStart(): Promise<void> {
    if (!this.client || !this.isConnected) {
      this.pendingHsRestart = true;
      this.log.warn(
        this.translate(
          "Cannot resend update-on-start values because client is not connected"
        )
      );
      return;
    }

    this.log.info(
      this.translate("Resending update-on-start states after HomeServer restart")
    );

    for (const src of this.updateOnStartSources) {
      try {
        const state = src.foreign
          ? await this.getForeignStateAsync(src.stateId)
          : await this.getStateAsync(src.stateId);
        if (!state) continue;

        const { uidValue, ackVal, method } = encodeUidValue(state.val, src.bool, src.textEncoding);
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
          const mappedVal = decodeAckValue(ackVal, mappedForeign.bool).value;
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
      } catch (err: any) {
        this.log.warn(
          this.translate(
            "Failed to resend update-on-start value for %s: %s",
            src.stateId,
            err?.message || err
          )
        );
      }
    }
  }

  private async onUnload(callback: () => void): Promise<void> {
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
        } catch (err) {
          this.log.error(
            this.translate("Unsubscribe failed: %s", err)
          );
        }
        this.client.close();
      }
    } catch (e) {
      this.log.error(this.translate("onUnload error: %s", e));
    } finally {
      callback();
    }
  }

  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (id.startsWith(this.namespace + ".")) {
      id = id.substring(this.namespace.length + 1);
    }

    if (id === "command.hsRestart") {
      this.handleHsRestartTrigger(id, state);
      return;
    }

    if (!state || !this.client) return;

    const mapped = this.forwardMap.get(id);
    if (mapped && this.handleMappedStateChange(id, state, mapped)) return;

    if (this.handleArchiveStateChange(id, state)) return;

    if (this.handleDirectCoStateChange(id, state)) return;
  }

  private handleMappedStateChange(
    id: string,
    state: ioBroker.State,
    mapped: ForwardMapping
  ): boolean {
    if (this.suppressStateChange.has(id)) {
      this.log.debug(
        this.translate(
          "Ignoring state change for %s because it was just updated from endpoint",
          id
        )
      );
      return true;
    }
    const { uidValue, ackVal, method } = encodeUidValue(state.val, mapped.bool, mapped.textEncoding);
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
    this.client!.call(mapped.key, method, uidValue);
    const baseId =
      this.keyIdMap.get(mapped.key) ?? this.makeEndpointBaseId(mapped.key);
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

  private handleArchiveStateChange(id: string, state: ioBroker.State): boolean {
    if (!id.startsWith("DA@.")) return false;
    if (state.ack) return true;
    const parts = id.split(".");
    const action = parts.pop();
    const baseId = parts.join(".");
    const key = this.archiveIdKeyMap.get(baseId);
    if (!key || !action) return true;

    if (action === "meta") {
      const prom = this.client!.call(key, "meta", undefined, this.makeTag("meta"));
      if (prom) {
        prom
          .then(async (resp: any) => {
            await this.applyMeta(key, baseId, resp.data, true);
            await this.setStateAsync(id, {
              val: JSON.stringify(resp.data),
              ack: true,
            });
          })
          .catch((err: any) => {
            this.log.error(
              this.translate(
                "Meta call failed for %s: %s",
                key,
                err?.message || err
              )
            );
          });
      }
      return true;
    }

    if (action === "last") {
      if (state.val !== true) return true;
      void this.handleLastArchiveQuery(key, baseId, id);
      return true;
    }

    if (action === "query") {
      let params: any;
      try {
        params = typeof state.val === "string" ? JSON.parse(state.val) : state.val;
        if (!params || typeof params !== "object") throw new Error();
      } catch {
        this.log.warn(
          this.translate("Invalid query parameters for %s: %s", id, state.val)
        );
        return true;
      }
      const queryParams = normalizeArchiveQuery(params);
      if (!isExecutableArchiveQuery(queryParams)) {
        this.log.warn(
          this.translate("Invalid archive query for %s: startat, cnt and size are required", id)
        );
        return true;
      }
      const prom = this.client!.call(key, "get", queryParams, this.makeTag("get"));
      if (prom) {
        prom
          .then((resp: any) => {
            this.setState(id, { val: JSON.stringify(queryParams), ack: true });
            const data = JSON.stringify(resp.data);
            this.setState(`${baseId}.data`, { val: data, ack: true });
            this.setState(`${baseId}.lastResult`, { val: data, ack: true });
          })
          .catch((err: any) => {
            this.log.error(
              this.translate("Get call failed for %s: %s", key, err?.message || err)
            );
          });
      }
      return true;
    }

    return true;
  }

  private async readNumberState(id: string, fallback: number): Promise<number> {
    const state = await this.getStateAsync(id);
    const num = Number(state?.val);
    return Number.isFinite(num) ? num : fallback;
  }

  private async readColsState(id: string, fallback: string[]): Promise<string[]> {
    const state = await this.getStateAsync(id);
    if (typeof state?.val === "string") {
      try {
        const parsed = JSON.parse(state.val);
        return normalizeArchiveCols(parsed) ?? fallback;
      } catch {
        return normalizeArchiveCols(state.val) ?? fallback;
      }
    }
    return normalizeArchiveCols(state?.val) ?? fallback;
  }

  private async handleLastArchiveQuery(key: string, baseId: string, id: string): Promise<void> {
    try {
      await this.setStateAsync(id, { val: false, ack: true });
      const defaults = this.archiveQueryDefaults.get(key);
      const metaResp = await this.client!.call(key, "meta", undefined, this.makeTag("meta"));
      if (metaResp?.data !== undefined) {
        await this.applyMeta(key, baseId, metaResp.data, true);
        await this.setStateAsync(`${baseId}.meta`, { val: JSON.stringify(metaResp.data), ack: true });
      }
      const lastCnt = await this.readNumberState(`${baseId}.lastCnt`, defaults?.lastCnt ?? 50);
      const blockSize = await this.readNumberState(`${baseId}.blockSize`, defaults?.blockSize ?? defaults?.size ?? 1);
      const cols = await this.readColsState(`${baseId}.cols`, defaults?.cols ?? []);
      const queryParams = buildLastArchiveQuery(metaResp, lastCnt, blockSize, cols);
      if (!queryParams) {
        this.log.warn(this.translate("Cannot build last archive query for %s because meta.stat.last is missing", key));
        return;
      }
      const resp = await this.client!.call(key, "get", queryParams, this.makeTag("get"));
      const data = JSON.stringify(resp.data);
      await this.setStateAsync(`${baseId}.data`, { val: data, ack: true });
      await this.setStateAsync(`${baseId}.lastResult`, { val: data, ack: true });
      await this.setStateAsync(`${baseId}.query`, { val: JSON.stringify(queryParams), ack: true });
    } catch (err: any) {
      this.log.error(this.translate("Last archive query failed for %s: %s", key, err?.message || err));
    }
  }

  private handleDirectCoStateChange(id: string, state: ioBroker.State): boolean {
    if (state.ack) return false;
    if (!id.startsWith("CO@.")) return false;
    const parts = id.split(".");
    if (parts[parts.length - 1] === "meta") {
      const baseId = parts.slice(0, parts.length - 1).join(".");
      const key =
        this.idKeyMap.get(baseId) ??
        this.normalizeKey(parts.slice(1, parts.length - 1).join("."));
      if (!key) return true;
      const prom = this.client!.call(key, "meta", undefined, this.makeTag("meta"));
      if (prom) {
        prom
          .then(async (resp: any) => {
            await this.applyMeta(key, baseId, resp.data);
            await this.setStateAsync(id, {
              val: JSON.stringify(resp.data),
              ack: true,
            });
          })
          .catch((err: any) => {
            this.log.error(
              this.translate(
                "Meta call failed for %s: %s",
                key,
                err?.message || err
              )
            );
          });
      }
      return true;
    }
    if (parts[parts.length - 1] !== "value") return false;
    const baseId = parts.slice(0, parts.length - 1).join(".");
    const key =
      this.idKeyMap.get(baseId) ??
      this.normalizeKey(parts.slice(1, parts.length - 1).join("."));
    const boolKey = this.boolKeys.has(key);
    const textEncoding = this.keyTextEncodingMap.get(key) ?? "utf8";
    const { uidValue, ackVal, method } = encodeUidValue(state.val, boolKey, textEncoding);
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
    this.client!.call(key, method, uidValue);
    const mappedForeign = this.reverseMap.get(key);
    if (mappedForeign) {
      let mappedVal = decodeAckValue(ackVal, mappedForeign.bool).value;
      this.log.debug(
        `Updating mapped foreign state ${mappedForeign.stateId} -> ${JSON.stringify(mappedVal)}`
      );
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

  private handleHsRestartTrigger(
    id: "command.hsRestart",
    state: ioBroker.State | null | undefined
  ): void {
    this.log.debug(
      this.translate(
        "HomeServer restart trigger received (val=%s, ack=%s)",
        state?.val,
        state?.ack
      )
    );
    if (state?.ack) return;
    const shouldTrigger =
      state?.val === true ||
      state?.val === 1 ||
      state?.val === "true" ||
      state?.val === "1";
    if (shouldTrigger) {
      if (!this.isConnected) {
        this.pendingHsRestart = true;
        this.log.warn(
          this.translate(
            "HomeServer restart trigger queued until connection is restored"
          )
        );
        this.setState(id, { val: false, ack: true });
      } else {
        this.triggerUpdateOnStart().finally(() => {
          this.setState(id, { val: false, ack: true });
        });
      }
    } else {
      this.setState(id, { val: !!state?.val, ack: true });
    }
  }
}

if (module.parent) {
  module.exports = (options: any) => new GiraEndpointAdapter(options);
  (module.exports as any).encodeUidValue = encodeUidValue;
  (module.exports as any).decodeAckValue = decodeAckValue;
  (module.exports as any).decodeCoValue = decodeCoValue;
} else {
  (() => new GiraEndpointAdapter())();
}
