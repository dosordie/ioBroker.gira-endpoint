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

export function messageArchiveEntryFingerprint(item: any): string {
  return JSON.stringify({ ts: item?.ts, token: item?.token, text: item?.text });
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
