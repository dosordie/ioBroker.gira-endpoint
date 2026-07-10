import { normalizeTextEncoding, TextEncoding } from "./valueConversion";
import { isArchiveStartAt, normalizeArchiveCols } from "./archiveQuery";

export type AdapterConfigLike = {
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
  }[];
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
};

export type ConnectionConfig = {
  host: string;
  port: number;
  ssl: boolean;
  path: string;
  username: string;
  password: string;
  authHeader: boolean;
  pingIntervalMs: number;
  reconnect?: { minMs?: number; maxMs?: number };
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
};

export type ArchiveQueryDefaults = {
  startat?: string;
  cnt?: number;
  size?: number;
  cols?: string[];
  mode?: "manual" | "last";
  lastCnt?: number;
  blockSize?: number;
};

export type ParsedAdapterConfig = ParsedEndpointMappingConfig & {
  connection: ConnectionConfig;
  archiveKeys: string[];
  archiveDescMap: Map<string, string>;
  archiveQueryDefaults: Map<string, ArchiveQueryDefaults>;
};

export type ConfigParserHelpers = {
  normalizeKey: (rawKey: string) => string;
  normalizeArchiveKey: (rawKey: string) => string;
  makeEndpointBaseId: (key: string) => string;
};

export type ForwardMapping = {
  key: string;
  bool: boolean;
  textEncoding: TextEncoding;
};

export type ReverseMapping = {
  stateId: string;
  bool: boolean;
  ack: boolean;
};

export type UpdateOnStartSource = {
  key: string;
  stateId: string;
  bool: boolean;
  foreign: boolean;
  textEncoding: TextEncoding;
};

export type ParsedEndpointMappingConfig = {
  endpointKeys: string[];
  forwardMap: Map<string, ForwardMapping>;
  reverseMap: Map<string, ReverseMapping>;
  boolKeys: Set<string>;
  keyTextEncodingMap: Map<string, TextEncoding>;
  keyDescMap: Map<string, string>;
  keyCaseMap: Map<string, string>;
  skipInitialUpdate: Set<string>;
  updateOnStartSources: UpdateOnStartSource[];
};

function rememberKeyCase(
  keyCaseMap: Map<string, string>,
  normalized: string,
  original: string
): void {
  if (!normalized) return;
  const trimmed = String(original ?? "").trim();
  if (!trimmed) return;
  const suffix = trimmed.replace(/^CO@/i, "");
  keyCaseMap.set(normalized, `CO@${suffix}`);
}

function sanitizeEndpointId(s: string): string {
  return s.replace(/^CO@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_");
}

function makeCasePreservedEndpointBaseId(
  key: string,
  keyCaseMap: Map<string, string>,
  fallback: (key: string) => string
): string {
  const casedKey = keyCaseMap.get(key);
  if (!casedKey) return fallback(key);
  return `CO@.${sanitizeEndpointId(casedKey)}`;
}

export function parseEndpointAndMappingConfig(
  cfg: AdapterConfigLike,
  helpers: {
    normalizeKey: (rawKey: string) => string;
    makeEndpointBaseId: (key: string) => string;
  }
): ParsedEndpointMappingConfig {
  const boolKeys = new Set<string>();
  const skipInitialUpdate = new Set<string>();
  const updateOnStartSources: UpdateOnStartSource[] = [];
  const keyTextEncodingMap = new Map<string, TextEncoding>();
  const keyDescMap = new Map<string, string>();
  const keyCaseMap = new Map<string, string>();

  const rawKeys = Array.isArray(cfg.endpointGroups)
    ? cfg.endpointGroups.flatMap((g: any) =>
        Array.isArray(g?.keys) ? g.keys : []
      )
    : cfg.endpointKeys;
  const endpointKeys: string[] = [];
  if (Array.isArray(rawKeys)) {
    for (const k of rawKeys) {
      if (typeof k === "object" && k) {
        if ((k as any).enabled === false) continue;
        const rawKey = String((k as any).key ?? "").trim();
        const key = helpers.normalizeKey(rawKey);
        if (!key) continue;
        rememberKeyCase(keyCaseMap, key, rawKey || key);
        const name = String((k as any).name ?? "").trim();
        if (name) keyDescMap.set(key, name);
        const bool = Boolean((k as any).bool);
        if (bool) boolKeys.add(key);
        const textEncoding = normalizeTextEncoding((k as any).textEncoding);
        keyTextEncodingMap.set(key, textEncoding);
        const updateOnStart = (k as any).updateOnStart !== false;
        if (!updateOnStart) skipInitialUpdate.add(key);
        if (updateOnStart) {
          const baseId = makeCasePreservedEndpointBaseId(
            key,
            keyCaseMap,
            helpers.makeEndpointBaseId
          );
          updateOnStartSources.push({
            key,
            stateId: `${baseId}.value`,
            bool,
            foreign: false,
            textEncoding,
          });
        }
        endpointKeys.push(key);
      } else {
        const rawKey = String(k).trim();
        const key = helpers.normalizeKey(rawKey);
        if (!key) continue;
        rememberKeyCase(keyCaseMap, key, rawKey || key);
        endpointKeys.push(key);
      }
    }
  } else {
    const arr = String(rawKeys ?? "")
      .split(/[,;\s]+/)
      .map((k) => k.trim())
      .filter((k) => k);
    for (const rawKey of arr) {
      const key = helpers.normalizeKey(rawKey);
      if (!key) continue;
      rememberKeyCase(keyCaseMap, key, rawKey);
      endpointKeys.push(key);
    }
  }

  const forwardMap = new Map<string, ForwardMapping>();
  const reverseMap = new Map<string, ReverseMapping>();
  const mappingGroups = Array.isArray(cfg.mappingGroups)
    ? cfg.mappingGroups
    : Array.isArray(cfg.mappings)
    ? [{ mappings: cfg.mappings }]
    : [];
  for (const g of mappingGroups) {
    if (!g || typeof g !== "object") continue;
    const list = (g as any).mappings;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (typeof m !== "object" || !m) continue;
      if ((m as any).enabled === false) continue;
      const stateId = String((m as any).stateId ?? "").trim();
      const rawKey = String((m as any).key ?? "").trim();
      const key = helpers.normalizeKey(rawKey);
      if (!stateId || !key) continue;
      rememberKeyCase(keyCaseMap, key, rawKey || key);
      const name = String((m as any).name ?? "").trim();
      if (name) keyDescMap.set(key, name);
      const toEndpoint = (m as any).toEndpoint !== false;
      const toState = Boolean((m as any).toState);
      const bool = Boolean((m as any).bool);
      const ack = (m as any).ack !== false;
      const textEncoding = normalizeTextEncoding((m as any).textEncoding);
      if (!keyTextEncodingMap.has(key)) {
        keyTextEncodingMap.set(key, textEncoding);
      }
      const updateOnStart = (m as any).updateOnStart !== false;
      if (!updateOnStart) skipInitialUpdate.add(key);
      if (toEndpoint) {
        forwardMap.set(stateId, { key, bool, textEncoding });
        if (bool) boolKeys.add(key);
        if (updateOnStart) {
          updateOnStartSources.push({
            key,
            stateId,
            bool,
            foreign: true,
            textEncoding,
          });
        }
      }
      if (toState) {
        reverseMap.set(key, { stateId, bool, ack });
        if (bool) boolKeys.add(key);
      }
      if (!endpointKeys.includes(key)) endpointKeys.push(key);
    }
  }

  const uniqueSources = new Map<string, UpdateOnStartSource>();
  for (const src of updateOnStartSources) {
    const key = `${src.key}|${src.stateId}|${src.foreign ? "1" : "0"}`;
    if (!uniqueSources.has(key)) uniqueSources.set(key, src);
  }

  return {
    endpointKeys,
    forwardMap,
    reverseMap,
    boolKeys,
    keyTextEncodingMap,
    keyDescMap,
    keyCaseMap,
    skipInitialUpdate,
    updateOnStartSources: Array.from(uniqueSources.values()),
  };
}


function parseArchiveConfig(
  cfg: AdapterConfigLike,
  helpers: Pick<ConfigParserHelpers, "normalizeArchiveKey">
): Pick<ParsedAdapterConfig, "archiveKeys" | "archiveDescMap" | "archiveQueryDefaults"> {
  const archiveDescMap = new Map<string, string>();
  const archiveQueryDefaults = new Map<string, ArchiveQueryDefaults>();
  const rawArchives = cfg.dataArchives;
  const archiveKeys: string[] = [];
  if (Array.isArray(rawArchives)) {
    for (const a of rawArchives) {
      if (typeof a === "object" && a) {
        if ((a as any).enabled === false) continue;
        const key = helpers.normalizeArchiveKey(String((a as any).key ?? "").trim());
        if (!key) continue;
        const name = String((a as any).name ?? "").trim();
        if (name) archiveDescMap.set(key, name);
        const params: ArchiveQueryDefaults = {};
        const startat = String((a as any).startat ?? "").trim();
        const legacyStart = String((a as any).start ?? "").trim();
        if (isArchiveStartAt(startat)) {
          params.startat = startat;
        } else if (isArchiveStartAt(legacyStart)) {
          params.startat = legacyStart;
        }
        const cnt = Number((a as any).cnt);
        if (Number.isFinite(cnt)) params.cnt = cnt;
        const size = Number((a as any).size);
        if (Number.isFinite(size)) params.size = size;
        const cols = normalizeArchiveCols((a as any).cols ?? (a as any).columns);
        if (cols) params.cols = cols;
        const rawLastCnt = Number((a as any).lastCnt);
        params.lastCnt = Number.isFinite(rawLastCnt) ? rawLastCnt : 50;
        const rawBlockSize = Number((a as any).blockSize);
        params.blockSize = Number.isFinite(rawBlockSize)
          ? rawBlockSize
          : params.size ?? 1;
        const mode = (a as any).mode;
        params.mode = mode === "manual" || mode === "last"
          ? mode
          : (a as any).lastCnt !== undefined || (a as any).blockSize !== undefined
          ? "last"
          : "manual";
        archiveQueryDefaults.set(key, params);
        archiveKeys.push(key);
      } else {
        const key = helpers.normalizeArchiveKey(String(a).trim());
        if (!key) continue;
        archiveKeys.push(key);
      }
    }
  } else {
    const arr = String(rawArchives ?? "")
      .split(/[,;\s]+/)
      .map((k) => k.trim())
      .filter((k) => k)
      .map((k) => helpers.normalizeArchiveKey(k));
    archiveKeys.push(...arr);
  }
  for (const key of archiveKeys) {
    if (!archiveDescMap.has(key)) archiveDescMap.set(key, key);
  }
  return { archiveKeys, archiveDescMap, archiveQueryDefaults };
}

export function parseAdapterConfig(
  cfg: AdapterConfigLike,
  helpers: ConfigParserHelpers
): ParsedAdapterConfig {
  const endpointMapping = parseEndpointAndMappingConfig(cfg, helpers);
  const archiveConfig = parseArchiveConfig(cfg, helpers);

  return {
    ...endpointMapping,
    ...archiveConfig,
    connection: {
      host: String(cfg.host ?? "").trim(),
      port: Number(cfg.port ?? 80),
      ssl: Boolean(cfg.ssl ?? false),
      path: "/endpoints/ws",
      username: String(cfg.username ?? ""),
      password: String(cfg.password ?? ""),
      authHeader: Boolean(cfg.authHeader),
      pingIntervalMs: Number(cfg.pingIntervalMs ?? 30000),
      reconnect: cfg.reconnect,
      ca: cfg.ca,
      cert: cfg.cert,
      key: cfg.key,
      rejectUnauthorized: cfg.rejectUnauthorized,
    },
  };
}
