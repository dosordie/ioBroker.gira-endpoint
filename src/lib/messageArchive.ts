export const EXPERIMENTAL_MESSAGE_ARCHIVE_METHODS = [
  "add",
  "write",
  "insert",
  "set",
  "add_entry",
  "add_message",
  "trigger",
  "call",
] as const;

export function extractMessageArchiveTokens(meta: any): string[] {
  const tokens = new Set<string>();
  const visit = (value: any, key?: string): void => {
    if (value === null || value === undefined) return;
    if (key === "token" && (typeof value === "string" || typeof value === "number")) {
      const token = String(value).trim();
      if (token) tokens.add(token);
    }
    if (key === "tokens") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" || typeof item === "number") {
            const token = String(item).trim();
            if (token) tokens.add(token);
          }
        }
      } else if (value && typeof value === "object") {
        for (const token of Object.keys(value)) if (token.trim()) tokens.add(token.trim());
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(meta);
  return Array.from(tokens);
}

export function getMessageArchiveItems(response: any): any[] {
  const candidates = [response?.data?.items, response?.items, response?.data?.data?.items, response?.data];
  return candidates.find(Array.isArray) ?? [];
}

export function sanitizeArchiveId(value: string): string {
  return value.replace(/^(DA|MA)@/i, "").replace(/[^a-z0-9@_\-\.]/gi, "_").toLowerCase();
}

export function getMessageArchiveEntryKey(item: any): string | undefined {
  const value = item?.key ?? item?.token;
  if (value === undefined || value === null) return undefined;
  return String(value);
}

export function getLatestMessageArchiveItem(items: any[]): any | undefined {
  return items.reduce<any | undefined>((latest, item) => {
    const timestamp = Number(item?.ts);
    if (!Number.isFinite(timestamp)) return latest;
    return !latest || timestamp > Number(latest.ts) ? item : latest;
  }, undefined);
}

export function getMessageArchiveEventItems(payload: any): any[] {
  const items = getMessageArchiveItems(payload);
  if (items.length) return items;
  const candidates = [payload?.data?.item, payload?.data?.stat, payload?.data?.data, payload?.data, payload?.item, payload];
  return candidates.filter((item) => item && typeof item === "object" && !Array.isArray(item) &&
    getMessageArchiveEntryKey(item) !== undefined && (item.text !== undefined || item.ts !== undefined));
}

export function messageArchiveEntryFingerprint(item: any): string {
  return JSON.stringify({ ts: item?.ts, key: getMessageArchiveEntryKey(item), text: item?.text });
}

export function findNewMessageArchiveItems(beforeResponse: any, afterResponse: any): any[] {
  const beforeCounts = new Map<string, number>();
  for (const item of getMessageArchiveItems(beforeResponse)) {
    const fingerprint = messageArchiveEntryFingerprint(item);
    beforeCounts.set(fingerprint, (beforeCounts.get(fingerprint) ?? 0) + 1);
  }
  return getMessageArchiveItems(afterResponse).filter((item) => {
    const fingerprint = messageArchiveEntryFingerprint(item);
    const count = beforeCounts.get(fingerprint) ?? 0;
    if (count <= 0) return true;
    beforeCounts.set(fingerprint, count - 1);
    return false;
  });
}

export function buildMessageArchiveWriteRequest(key: string, method: string, token: string): any {
  return { type: "call", param: { key, method, token } };
}

export function messageArchiveWriteCreated(beforeResponse: any, afterResponse: any, token: string): boolean {
  return findNewMessageArchiveItems(beforeResponse, afterResponse)
    .some((item) => getMessageArchiveEntryKey(item) === token);
}

/** Returns the configured MA key when a response/event belongs to an MA subscription. */
export function getMessageArchiveSubscriptionKey(payload: any, configuredKeys: string[]): string | undefined {
  const configured = new Map(configuredKeys.map((key) => [key.toLowerCase(), key]));
  const direct = payload?.subscription?.key ?? payload?.data?.key ?? payload?.data?.uid;
  if (direct !== undefined) {
    const match = configured.get(String(direct).toLowerCase());
    if (match) return match;
  }
  const requestKeys = payload?.request?.param?.keys ?? payload?.request?.keys;
  if (Array.isArray(requestKeys)) {
    const matches = requestKeys.map((key: any) => configured.get(String(key).toLowerCase())).filter(Boolean);
    if (matches.length === requestKeys.length && matches.length > 0) return matches[0];
  }
  return undefined;
}
