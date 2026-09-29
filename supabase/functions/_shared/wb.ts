export type WbResponse = {
  status: number;
  data: unknown;
  text: string;
  retry: boolean;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function wbFetch(
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<WbResponse> {
  const headers: Record<string, string> = {
    Authorization: token,
    "Content-Type": "application/json",
  };

  let last: WbResponse = { status: 0, data: null, text: "no attempt", retry: true };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      const retry = RETRYABLE.has(res.status);
      last = { status: res.status, data, text, retry };
      if (res.status === 204) return { status: 204, data: [], text: "", retry: false };
      // Do not sleep on 429 — the next cron tick continues.
      if (!retry) return last;
    } catch (e) {
      last = { status: 0, data: null, text: String(e), retry: true };
    }
  }
  return last;
}

export function extractList(data: unknown, key?: string): Record<string, unknown>[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (key && Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  for (const k of ["cards", "orders", "supplies", "stocks", "items", "listGoods", "trbxes", "stickers", "offices", "goods", "feedbacks", "questions"]) {
    if (Array.isArray(obj[k])) return obj[k] as Record<string, unknown>[];
  }
  if (obj.data && typeof obj.data === "object") return extractList(obj.data, key);
  return [];
}

export function extractIds(data: unknown, key = "orderIds"): string[] {
  if (!data) return [];
  if (Array.isArray(data)) return data.map((x) => String(x));
  if (typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj[key])) return (obj[key] as unknown[]).map((x) => String(x));
  return [];
}

export function extraOf(obj: Record<string, unknown>, known: string[]): Record<string, unknown> {
  const skip = new Set(known);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!skip.has(k)) extra[k] = v;
  }
  return extra;
}

/** WB sometimes wraps a single object in data/supply/details or a one-element array. */
export function unwrapRecord(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data)) {
    const first = data[0];
    return first && typeof first === "object" && !Array.isArray(first)
      ? first as Record<string, unknown>
      : null;
  }
  const obj = data as Record<string, unknown>;
  for (const key of ["data", "supply", "details", "result"]) {
    const inner = obj[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return obj;
}

export function pickWarehouseName(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null;
  return asText(obj.warehouseName)
    ?? asText(obj.WarehouseName)
    ?? asText(obj.actualWarehouseName)
    ?? asText(obj.ActualWarehouseName)
    ?? asText(obj.transitWarehouseName)
    ?? asText(obj.TransitWarehouseName)
    ?? asText(obj.warehouse);
}

export function pickWarehouseId(obj: Record<string, unknown> | null | undefined): string | null {
  if (!obj) return null;
  return asText(
    obj.warehouseID ?? obj.warehouseId ?? obj.actualWarehouseID ?? obj.actualWarehouseId,
  );
}

export function asText(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

/** WB statistics/content often send Moscow datetime without offset. Persist timestamptz. */
export function asTs(v: unknown): string | null {
  const s = asText(v);
  if (!s) return null;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/[zZ]$/.test(t) || /[+-]\d{2}:\d{2}$/.test(t) || /[+-]\d{4}$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    const iso = t.indexOf("T") >= 0 ? t : t.replace(" ", "T");
    return iso + "+03:00";
  }
  return t;
}

export function asNum(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function asBool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  return null;
}

export function stripFile<T extends Record<string, unknown>>(obj: T): T {
  const copy = { ...obj };
  if ("file" in copy) delete copy.file;
  return copy;
}

export function kopecksToRub(v: unknown): number | null {
  const n = asNum(v);
  if (n === null) return null;
  return n / 100;
}
