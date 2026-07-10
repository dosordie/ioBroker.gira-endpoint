export type ArchiveMode = "manual" | "last";

export type NormalizedArchiveQuery = {
  startat?: string;
  cnt?: number;
  size?: number;
  cols?: string[];
};

const STARTAT_RE = /^\d{10}$/;

export function isArchiveStartAt(value: unknown): value is string {
  return typeof value === "string" && STARTAT_RE.test(value.trim());
}

export function normalizeArchiveCols(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const cols = value.map((c) => String(c).trim()).filter(Boolean);
    return cols.length ? cols : undefined;
  }
  if (typeof value === "string") {
    const cols = value
      .split(/[,;\s]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    return cols.length ? cols : undefined;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export function normalizeArchiveQuery(raw: any): NormalizedArchiveQuery {
  const query: NormalizedArchiveQuery = {};
  if (!raw || typeof raw !== "object") return query;

  const startat = String(raw.startat ?? "").trim();
  if (isArchiveStartAt(startat)) {
    query.startat = startat;
  } else if (isArchiveStartAt(raw.start)) {
    query.startat = String(raw.start).trim();
  }

  const cnt = toNumber(raw.cnt);
  if (cnt !== undefined) query.cnt = cnt;
  const size = toNumber(raw.size);
  if (size !== undefined) query.size = size;

  const cols = normalizeArchiveCols(raw.cols ?? raw.columns);
  if (cols) query.cols = cols;

  return query;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatArchiveStartAt(date: Date): string {
  return `${pad2(date.getFullYear() % 100)}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function parseMetaLast(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) return parseMetaLast(Number(trimmed));
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

export function buildLastArchiveQuery(
  meta: any,
  cnt: number,
  size: number,
  cols?: string[]
): NormalizedArchiveQuery | undefined {
  const last = parseMetaLast(meta?.data?.stat?.last ?? meta?.stat?.last);
  if (!last) return undefined;
  const start = new Date(last.getTime() - cnt * size * 60 * 1000);
  const query: NormalizedArchiveQuery = {
    startat: formatArchiveStartAt(start),
    cnt,
    size,
  };
  if (cols && cols.length) query.cols = cols;
  return query;
}
