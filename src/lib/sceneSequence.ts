export type NamedEndpointConfig = { key: string; name?: string; enabled?: boolean };

function normalize(raw: string, prefix: "SC@" | "SQ@"): string {
  const suffix = String(raw ?? "").trim().replace(new RegExp(`^${prefix}`, "i"), "");
  return suffix ? `${prefix}${suffix.toUpperCase()}` : "";
}

function sanitize(raw: string, prefix: "SC@" | "SQ@"): string {
  return normalize(raw, prefix).slice(3).replace(/[^a-z0-9@_-]/gi, "_");
}

export const normalizeSceneKey = (key: string): string => normalize(key, "SC@");
export const normalizeSequenceKey = (key: string): string => normalize(key, "SQ@");
export const sanitizeSceneId = (key: string): string => sanitize(key, "SC@");
export const sanitizeSequenceId = (key: string): string => sanitize(key, "SQ@");

export const SCENE_ACTION_METHODS: Readonly<Record<string, string>> = {
  call: "call",
  learn: "learn",
  offsetPlus: "offset_plus",
  offsetMinus: "offset_minus",
  listNext: "list_next",
  listPrevious: "list_prev",
};

export const SEQUENCE_ACTION_METHODS: Readonly<Record<string, string>> = {
  start: "start",
  stop: "stop",
};

export function extractRunning(value: any): boolean | undefined {
  const candidate = value?.running ?? value?.state?.running ?? value?.data?.running;
  return typeof candidate === "boolean" ? candidate : undefined;
}

export function extractTimestamp(value: any): number | undefined {
  const candidate = value?.ts ?? value?.timestamp ?? value?.modifiedAt ?? value?.data?.ts;
  if (candidate === null || candidate === undefined || String(candidate).trim() === "") return undefined;
  const number = Number(candidate);
  if (!Number.isFinite(number) || number < 0) return undefined;
  // Gira normally uses Unix seconds (including fractional seconds), while
  // ioBroker's value.time role expects JavaScript milliseconds.
  return Math.round(number < 1_000_000_000_000 ? number * 1000 : number);
}

export function isSceneModified(value: any): boolean {
  return value?.modified === true || value?.data?.modified === true;
}

export function getScenePushRefreshMethod(value: any): "get_items" | undefined {
  return isSceneModified(value) ? "get_items" : undefined;
}
