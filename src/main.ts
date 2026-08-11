import * as utils from "@iobroker/adapter-core";
import { GiraClient, codeToMessage } from "./lib/GiraClient";
import { randomUUID } from "crypto";
import { format } from "util";
import { decodeAckValue, decodeCoValue, encodeUidValue, TextEncoding } from "./lib/valueConversion";
import { parseAdapterConfig, ForwardMapping, ReverseMapping, UpdateOnStartSource, ArchiveQueryDefaults, MessageArchiveConfig } from "./lib/configParser";
import { EXPERIMENTAL_MESSAGE_ARCHIVE_METHODS, buildMessageArchiveWriteRequest, extractMessageArchiveTokens, findNewMessageArchiveItems, getLatestMessageArchiveItem, getMessageArchiveEntryKey, getMessageArchiveEventItems, getMessageArchiveItems, getMessageArchiveSubscriptionKey, messageArchiveWriteCreated, sanitizeArchiveId } from "./lib/messageArchive";
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
  messageArchives?: MessageArchiveConfig[];
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
  private messageArchives: MessageArchiveConfig[] = [];
  private messageArchiveIdKeyMap = new Map<string, string>();
  private messageArchiveConfigMap = new Map<string, MessageArchiveConfig>();
  private messageArchiveWriteRunning = new Set<string>();


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

      await this.setObjectNotExistsAsync("MA@", {
        type: "channel",
        common: { name: this.translate("MA@") },
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
      this.messageArchives = parsed.messageArchives;
      this.messageArchiveConfigMap = new Map(parsed.messageArchives.map((archive) => [archive.key, archive]));

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
            name: this.translate("Daten holen"),
            type: "boolean",
            role: "button",
            read: true,
            write: true,
            def: false,
          },
          native: {},
        });
        await this.extendObjectAsync(`${baseId}.last`, {
          common: {
            name: this.translate("Daten holen"),
            type: "boolean",
            role: "button",
            read: true,
            write: true,
            def: false,
          },
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

      for (const archive of this.messageArchives) {
        const baseId = `MA@.${this.sanitizeArchiveId(archive.key)}`;
        this.messageArchiveIdKeyMap.set(baseId, archive.key);
        await this.setObjectNotExistsAsync(baseId, { type: "channel", common: { name: archive.name }, native: {} });
        const states: Array<[string, ioBroker.StateCommon]> = [
          ["meta", { name: "Metadaten", type: "string", role: "json", read: true, write: false }],
          ["tokens", { name: "Tokens", type: "string", role: "json", read: true, write: false }],
          ["items", { name: "Letzte Meldungen", type: "string", role: "json", read: true, write: false }],
          ["caption", { name: "Bezeichnung", type: "string", role: "text", read: true, write: false }],
          ["description", { name: "Beschreibung", type: "string", role: "text", read: true, write: false }],
          ["size", { name: "Archivgröße", type: "number", role: "value", read: true, write: false }],
          ["count", { name: "Anzahl Meldungen", type: "number", role: "value", read: true, write: false }],
          ["first", { name: "Erster Zeitstempel", type: "number", role: "value", read: true, write: false }],
          ["last", { name: "Letzter Zeitstempel", type: "number", role: "value", read: true, write: false }],
          ["lastMessage.key", { name: "Letzter Meldungsschlüssel", type: "string", role: "text", read: true, write: false }],
          ["lastMessage.text", { name: "Letzter Meldungstext", type: "string", role: "text", read: true, write: false }],
          ["lastMessage.ts", { name: "Letzter Meldungszeitstempel", type: "number", role: "value", read: true, write: false }],
          ["lastMessage.time", { name: "Letzte Meldungszeit", type: "string", role: "text", read: true, write: false }],
          ["lastWriteReport", { name: "Schreibtest-Protokoll", type: "string", role: "json", read: true, write: false }],
          ["read", { name: "Meldungsarchiv lesen", type: "boolean", role: "button", read: true, write: true, def: false }],
          ["testWrite", { name: "Experimentellen Schreibtest starten", type: "boolean", role: "button", read: true, write: true, def: false }],
        ];
        for (const [stateName, common] of states) {
          await this.setObjectNotExistsAsync(`${baseId}.${stateName}`, { type: "state", common, native: {} });
        }
        await this.setStateAsync(`${baseId}.read`, { val: false, ack: true });
        await this.setStateAsync(`${baseId}.testWrite`, { val: false, ack: true });
        this.subscribeStates(`${baseId}.read`);
        this.subscribeStates(`${baseId}.testWrite`);
      }

      const validBaseIds = new Set(
        this.endpointKeys.map((k) => this.makeEndpointBaseId(k))
      );
      const validArchiveBases = new Set(
        this.archiveKeys.map((k) => `DA@.${this.sanitizeArchiveId(k)}`)
      );
      const validMessageArchiveBases = new Set(
        this.messageArchives.map((archive) => `MA@.${this.sanitizeArchiveId(archive.key)}`)
      );
      const objs = await this.getAdapterObjectsAsync();
      const legacyMaCoBases = new Set<string>();
      for (const archive of this.messageArchives) {
        legacyMaCoBases.add(this.makeEndpointBaseId(this.normalizeKey(archive.key)));
        if (archive.testToken) legacyMaCoBases.add(this.makeEndpointBaseId(this.normalizeKey(archive.testToken)));
      }
      for (const fullId of Object.keys(objs)) {
        const id = fullId.startsWith(this.namespace + ".")
          ? fullId.slice(this.namespace.length + 1)
          : fullId;
        if (id.startsWith("CO@.")) {
          const base = id.split(".").slice(0, 2).join(".");
          if (legacyMaCoBases.has(base) && !validBaseIds.has(base)) {
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
        } else if (id.startsWith("MA@.")) {
          const base = id.split(".").slice(0, 2).join(".");
          if (!validMessageArchiveBases.has(base)) {
            const msg = this.translate("Deleting stale message archive state %s", id);
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
        if (this.messageArchives.length) {
          this.client!.subscribe(this.messageArchives.map((archive) => archive.key));
          for (const archive of this.messageArchives) {
            void this.readMessageArchive(archive).catch((err: any) => {
              this.log.error(`MA read failed key=${archive.key}: ${err?.message || err}`);
            });
          }
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

        const subscriptionKey = getMessageArchiveSubscriptionKey(payload, this.messageArchives.map((archive) => archive.key));
        if (subscriptionKey) {
          const archive = this.messageArchiveConfigMap.get(subscriptionKey) ??
            this.messageArchives.find((candidate) => candidate.key.toLowerCase() === subscriptionKey.toLowerCase());
          if (archive) {
            const baseId = `MA@.${this.sanitizeArchiveId(archive.key)}`;
            const items = getMessageArchiveEventItems(payload);
            if (items.length) {
              await this.setStateAsync(`${baseId}.items`, { val: JSON.stringify(items), ack: true });
              await this.updateLastMessageArchiveStates(baseId, items);
            }
            this.log.info(`MA subscription event key=${archive.key} response=${JSON.stringify(payload)}`);
          }
          return;
        }

        const tag = payload?.tag;
        if (typeof tag === "string" && (tag.startsWith("meta_") || tag.startsWith("ma_meta_"))) {
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
    return sanitizeArchiveId(s);
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

    if (this.handleMessageArchiveStateChange(id, state)) return;

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

  private handleMessageArchiveStateChange(id: string, state: ioBroker.State): boolean {
    if (!id.startsWith("MA@.")) return false;
    if (state.ack) return true;
    const parts = id.split(".");
    const action = parts.pop();
    const baseId = parts.join(".");
    const key = this.messageArchiveIdKeyMap.get(baseId);
    const archive = key ? this.messageArchiveConfigMap.get(key) : undefined;
    if (!archive || (action !== "read" && action !== "testWrite")) return true;
    void this.setStateAsync(id, { val: false, ack: true });
    if (state.val !== true) return true;
    if (action === "read") {
      void this.readMessageArchive(archive).catch((err: any) => {
        this.log.error(`MA read failed key=${archive.key}: ${err?.message || err}`);
      });
    }
    else void this.runExperimentalMessageArchiveWrite(archive);
    return true;
  }

  private async readMessageArchive(archive: MessageArchiveConfig): Promise<{ meta: any; get: any; tokens: string[] }> {
    const baseId = `MA@.${this.sanitizeArchiveId(archive.key)}`;
    const meta = await this.client!.call(archive.key, "meta", undefined, this.makeTag("ma_meta"));
    const tokens = extractMessageArchiveTokens(meta?.data);
    await this.cleanupLegacyMessageArchiveCoObjects(archive, tokens);
    await this.setStateAsync(`${baseId}.meta`, { val: JSON.stringify(meta?.data), ack: true });
    await this.setStateAsync(`${baseId}.tokens`, { val: JSON.stringify(tokens), ack: true });
    const metaData = meta?.data;
    const metaStates: Array<[string, any]> = [
      ["caption", metaData?.caption], ["description", metaData?.description], ["size", metaData?.size],
      ["count", metaData?.stat?.count], ["first", metaData?.stat?.first], ["last", metaData?.stat?.last],
    ];
    for (const [name, value] of metaStates) {
      if (value !== undefined && value !== null) await this.setStateAsync(`${baseId}.${name}`, { val: value, ack: true });
    }
    this.log.info(`MA read meta key=${archive.key} response=${JSON.stringify(meta)}`);
    const get = await this.client!.call(archive.key, "get", { count: archive.count }, this.makeTag("ma_get"));
    const items = getMessageArchiveItems(get);
    await this.setStateAsync(`${baseId}.items`, { val: JSON.stringify(items), ack: true });
    await this.updateLastMessageArchiveStates(baseId, items);
    this.log.info(`MA read get key=${archive.key} count=${archive.count} response=${JSON.stringify(get)}`);
    return { meta, get, tokens };
  }

  private async updateLastMessageArchiveStates(baseId: string, items: any[]): Promise<void> {
    const item = getLatestMessageArchiveItem(items);
    if (!item) return;
    const key = getMessageArchiveEntryKey(item);
    const timestamp = Number(item.ts);
    if (key !== undefined) await this.setStateAsync(`${baseId}.lastMessage.key`, { val: key, ack: true });
    if (item.text !== undefined && item.text !== null) await this.setStateAsync(`${baseId}.lastMessage.text`, { val: String(item.text), ack: true });
    if (Number.isFinite(timestamp)) {
      await this.setStateAsync(`${baseId}.lastMessage.ts`, { val: timestamp, ack: true });
      await this.setStateAsync(`${baseId}.lastMessage.time`, { val: new Date(timestamp * 1000).toLocaleString(), ack: true });
    }
  }

  private async cleanupLegacyMessageArchiveCoObjects(archive: MessageArchiveConfig, tokens: string[]): Promise<void> {
    const legitimate = new Set(this.endpointKeys.map((key) => this.makeEndpointBaseId(key)));
    const candidates = new Set([archive.key, archive.testToken, ...tokens].filter((value): value is string => Boolean(value)));
    for (const candidate of candidates) {
      const baseId = this.makeEndpointBaseId(this.normalizeKey(candidate));
      if (legitimate.has(baseId)) continue;
      if (!(await this.getObjectAsync(baseId))) continue;
      this.log.info(`Deleting legacy message-archive CO object ${baseId}`);
      await this.delObjectAsync(baseId, { recursive: true });
    }
  }

  private async runExperimentalMessageArchiveWrite(archive: MessageArchiveConfig): Promise<void> {
    const baseId = `MA@.${this.sanitizeArchiveId(archive.key)}`;
    if (this.messageArchiveWriteRunning.has(archive.key)) return;
    this.messageArchiveWriteRunning.add(archive.key);
    const report: any = { key: archive.key, officialRead: {}, experimentalWrite: [], created: false };
    try {
      if (!archive.experimentalWrite) throw new Error("Experimenteller Schreibtest ist in der Konfiguration nicht freigegeben.");
      const initial = await this.readMessageArchive(archive);
      report.officialRead = { metaCode: initial.meta?.code, getCode: initial.get?.code, tokens: initial.tokens };
      if (!archive.testToken) throw new Error("Kein sicherer Test-Token konfiguriert; es wird kein Token erfunden.");
      if (!initial.tokens.includes(archive.testToken)) throw new Error(`Test-Token ${archive.testToken} ist nicht in meta vorhanden.`);
      let before = initial.get;
      for (const method of EXPERIMENTAL_MESSAGE_ARCHIVE_METHODS) {
        // Deliberately keep every probe minimal. More parameter variants would
        // multiply side effects without adding a safe, documented guarantee.
        const request = buildMessageArchiveWriteRequest(archive.key, method, archive.testToken);
        const attempt: any = { method, request };
        try {
          const response = await this.client!.call(archive.key, method, { token: archive.testToken }, this.makeTag(`ma_${method}`));
          attempt.statusCode = response?.code;
          attempt.statusText = codeToMessage(Number(response?.code));
          attempt.response = response;
        } catch (err: any) {
          attempt.statusCode = err?.code;
          attempt.statusText = codeToMessage(Number(err?.code));
          attempt.response = err?.response ?? { error: err?.message || String(err) };
        }
        this.log.info(`MA experimental write key=${archive.key} method=${method} response=${JSON.stringify(attempt.response)}`);
        const after = await this.client!.call(archive.key, "get", { count: archive.count }, this.makeTag("ma_verify"));
        attempt.verificationResponse = after;
        attempt.newItems = findNewMessageArchiveItems(before, after);
        attempt.created = messageArchiveWriteCreated(before, after, archive.testToken);
        report.experimentalWrite.push(attempt);
        await this.setStateAsync(`${baseId}.items`, { val: JSON.stringify(getMessageArchiveItems(after)), ack: true });
        await this.updateLastMessageArchiveStates(baseId, getMessageArchiveItems(after));
        await this.setStateAsync(`${baseId}.lastWriteReport`, { val: JSON.stringify(report), ack: true });
        if (attempt.created) { report.created = true; report.successfulRequest = request; break; }
        before = after;
      }
    } catch (err: any) {
      report.error = err?.message || String(err);
      this.log.error(`MA experimental write aborted key=${archive.key}: ${report.error}`);
    } finally {
      await this.setStateAsync(`${baseId}.lastWriteReport`, { val: JSON.stringify(report), ack: true });
      this.messageArchiveWriteRunning.delete(archive.key);
    }
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

  private getMetaCols(metaResp: any): string[] {
    const cols = metaResp?.data?.cols;
    if (!Array.isArray(cols)) return [];
    return cols
      .map((col) => String(col?.key ?? "").trim())
      .filter(Boolean);
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
      const queryCols = cols.length ? cols : this.getMetaCols(metaResp);
      const queryParams = buildLastArchiveQuery(metaResp, lastCnt, blockSize, queryCols);
      if (!queryParams) {
        this.log.warn(this.translate("Cannot build last archive query for %s because meta.stat.last is missing", key));
        return;
      }
      await this.setStateAsync(`${baseId}.query`, { val: JSON.stringify(queryParams), ack: true });
      this.log.debug(
        this.translate(
          "Fetching archive data for %s with query %s",
          key,
          JSON.stringify(queryParams)
        )
      );
      const resp = await this.client!.call(key, "get", queryParams, this.makeTag("get"));
      const data = JSON.stringify(resp.data);
      await this.setStateAsync(`${baseId}.data`, { val: data, ack: true });
      await this.setStateAsync(`${baseId}.lastResult`, { val: data, ack: true });
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
