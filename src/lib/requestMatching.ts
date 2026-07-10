export function makeRequestKey(obj: any): string {
  if (!obj || typeof obj !== "object") return String(obj);
  const keys = Object.keys(obj).sort();
  const sorted: any = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export function makeMinimalRequest(value: any): any | undefined {
  const key = value?.key;
  const method = value?.method;
  if (key === undefined || method === undefined) return undefined;
  return { key, method };
}

export function makeRequestKeys(value: any): string[] {
  const keys = [makeRequestKey(value)];
  const minimalRequest = makeMinimalRequest(value);
  if (minimalRequest) {
    const minimalKey = makeRequestKey(minimalRequest);
    if (!keys.includes(minimalKey)) keys.push(minimalKey);
  }
  return keys;
}
