import { unzipSync } from "npm:fflate@0.8.2";
import { addDays, dailyFrom, ymdSplit } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asNum, asText, wbFetch } from "../wb.ts";

const ANALYTICS = "https://seller-analytics-api.wildberries.ru";
const HISTORY_JSON_URL = `${ANALYTICS}/api/analytics/v3/sales-funnel/products/history`;
const CSV_CREATE_URL = `${ANALYTICS}/api/v2/nm-report/downloads`;
const CSV_LIST_URL = `${ANALYTICS}/api/v2/nm-report/downloads`;

const FUNNEL_HISTORY_START = "2026-03-25";
const NM_BATCH = 20;
const DAILY_DAYS = 2;
const CSV_CHUNK_DAYS = 31;
const CALLS_PER_TICK = 2;
const RATE_PAUSE_MS = 21_000;

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wbFetchBytes(
  token: string,
  url: string,
): Promise<{ status: number; data: Uint8Array | null; text: string; retry: boolean }> {
  const headers: Record<string, string> = { Authorization: token };
  try {
    const res = await fetch(url, { method: "GET", headers });
    const retry = [429, 500, 502, 503, 504].includes(res.status);
    if (res.status === 200) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, data: buf, text: "", retry: false };
    }
    const text = await res.text();
    return { status: res.status, data: null, text, retry };
  } catch (e) {
    return { status: 0, data: null, text: String(e), retry: true };
  }
}

async function productCount(db: Db, sellerId: string): Promise<number> {
  const { count, error } = await db
    .from("products")
    .select("nm_id", { count: "exact", head: true })
    .eq("seller_id", sellerId);
  if (error) throw new Error(`products count: ${error.message}`);
  return count ?? 0;
}

async function nmBatch(db: Db, sellerId: string, offset: number): Promise<number[]> {
  const { data, error } = await db
    .from("products")
    .select("nm_id")
    .eq("seller_id", sellerId)
    .order("nm_id", { ascending: true })
    .range(offset, offset + NM_BATCH - 1);
  if (error) throw new Error(`products list: ${error.message}`);
  return (data ?? [])
    .map((r) => Number(asText((r as { nm_id?: unknown }).nm_id)))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function unpackHistory(data: unknown): Array<{
  product: Record<string, unknown>;
  history: Record<string, unknown>[];
}> {
  if (Array.isArray(data)) {
    return data as Array<{ product: Record<string, unknown>; history: Record<string, unknown>[] }>;
  }
  if (data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: Array<{ product: Record<string, unknown>; history: Record<string, unknown>[] }> }).data;
  }
  return [];
}

function dayRow(
  sellerId: string,
  nmId: string,
  statDate: string,
  src: Record<string, unknown>,
  product?: Record<string, unknown>,
): Record<string, unknown> {
  const p = product ?? {};
  return {
    seller_id: sellerId,
    stat_date: statDate,
    nm_id: nmId,
    vendor_code: asText(p.vendorCode),
    title: asText(p.title),
    brand_name: asText(p.brandName),
    subject_name: asText(p.subjectName),
    open_count: asNum(src.openCount ?? src.openCardCount),
    cart_count: asNum(src.cartCount ?? src.addToCartCount),
    order_count: asNum(src.orderCount ?? src.ordersCount),
    order_sum: asNum(src.orderSum ?? src.ordersSumRub),
    buyout_count: asNum(src.buyoutCount ?? src.buyoutsCount),
    buyout_sum: asNum(src.buyoutSum ?? src.buyoutsSumRub),
    buyout_percent: asNum(src.buyoutPercent),
    add_to_cart_conversion: asNum(src.addToCartConversion),
    cart_to_order_conversion: asNum(src.cartToOrderConversion),
    add_to_wishlist_count: asNum(src.addToWishlistCount ?? src.addToWishlist),
    extra: {},
    payload: src,
  };
}

function historyJsonRows(
  sellerId: string,
  items: Array<{ product: Record<string, unknown>; history: Record<string, unknown>[] }>,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    const p = item.product ?? {};
    const nmId = asText(p.nmId ?? p.nmID);
    if (!nmId) continue;
    for (const day of item.history ?? []) {
      const statDate = asText(day.date)?.slice(0, 10);
      if (!statDate) continue;
      rows.push(dayRow(sellerId, nmId, statDate, day, p));
    }
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === "," && !q) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseFunnelCsv(sellerId: string, csv: string): Record<string, unknown>[] {
  const text = csv.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iNm = idx("nmID");
  const iDt = idx("dt");
  if (iNm < 0 || iDt < 0) throw new Error(`csv header: ${header.join(",")}`);

  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const nmId = asText(cols[iNm]);
    const statDate = asText(cols[iDt])?.slice(0, 10);
    if (!nmId || !statDate) continue;
    const src: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) src[header[c]] = cols[c];
    rows.push(dayRow(sellerId, nmId, statDate, src));
  }
  return rows;
}

function csvFromZip(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".csv"));
  if (!name) throw new Error("zip without csv");
  return new TextDecoder("utf-8").decode(files[name]);
}

function csvList(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const obj = data as { data?: unknown };
  return Array.isArray(obj.data) ? obj.data as Record<string, unknown>[] : [];
}

function historyChunkEnd(dateFrom: string, hardEnd: string): string {
  return minYmd(addDays(dateFrom, CSV_CHUNK_DAYS - 1), hardEnd);
}

async function jsonRecentStep(
  db: Db,
  ctx: LoaderContext,
  cursor: Record<string, unknown>,
): Promise<LoaderResult> {
  const dateFrom = dailyFrom(ctx.yesterday, 7);
  const periodEnd = ctx.yesterday;
  const nmOffset = Number(cursor.nmOffset ?? 0);
  const nmIds = await nmBatch(db, ctx.seller.id, nmOffset);

  if (!nmIds.length) {
    const total = await productCount(db, ctx.seller.id);
    if (total === 0) {
      return { done: false, cursor: { jsonRecent: true, nmOffset: 0 }, rowsIn: 0, rowsUpserted: 0, note: "wait products" };
    }
    if (nmOffset >= total) {
      return {
        done: true,
        cursor: {},
        rowsIn: 0,
        rowsUpserted: 0,
        note: "json recent done (7d, без Jam полная история недоступна)",
      };
    }
  }

  const res = await wbFetch(ctx.token, "POST", HISTORY_JSON_URL, {
    selectedPeriod: { start: dateFrom, end: periodEnd },
    nmIds,
    skipDeletedNm: true,
    aggregationLevel: "day",
  });
  const baseCursor = { jsonRecent: true, nmOffset };

  if (res.retry) return { done: false, cursor: baseCursor, rowsIn: 0, rowsUpserted: 0, retry: true };
  if (res.status !== 200) {
    return {
      done: res.status === 401 || res.status === 403,
      cursor: baseCursor,
      rowsIn: 0,
      rowsUpserted: 0,
      retry: res.status === 429,
      error: `sales_funnel ${res.status} ${res.text.slice(0, 400)}`,
    };
  }

  const rows = historyJsonRows(ctx.seller.id, unpackHistory(res.data));
  const n = await upsertRows(db, "sales_funnel_daily", rows, "seller_id,stat_date,nm_id");
  const split = ymdSplit(rows.map((r) => r.stat_date), ctx.yesterday);
  return {
    done: false,
    cursor: { jsonRecent: true, nmOffset: nmOffset + nmIds.length },
    rowsIn: rows.length,
    rowsUpserted: n,
    note: `json recent ${dateFrom}..${periodEnd} nm+${nmIds.length}`,
    ...split,
  };
}

async function jsonStep(
  db: Db,
  ctx: LoaderContext,
  cursor: Record<string, unknown>,
): Promise<LoaderResult & { advance?: boolean }> {
  const dateFrom = dailyFrom(ctx.yesterday, DAILY_DAYS);
  const periodEnd = ctx.yesterday;
  const nmOffset = Number(cursor.nmOffset ?? 0);
  const nmIds = await nmBatch(db, ctx.seller.id, nmOffset);

  if (!nmIds.length) {
    const total = await productCount(db, ctx.seller.id);
    if (total === 0) {
      return { done: false, cursor: { nmOffset: 0 }, rowsIn: 0, rowsUpserted: 0, note: "wait products" };
    }
    if (nmOffset >= total) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "funnel daily done" };
    }
  }

  const res = await wbFetch(ctx.token, "POST", HISTORY_JSON_URL, {
    selectedPeriod: { start: dateFrom, end: periodEnd },
    nmIds,
    skipDeletedNm: true,
    aggregationLevel: "day",
  });
  const baseCursor = { nmOffset };

  if (res.retry) return { done: false, cursor: { ...baseCursor, nmOffset }, rowsIn: 0, rowsUpserted: 0, retry: true };
  if (res.status !== 200) {
    return {
      done: res.status === 401 || res.status === 403,
      cursor: baseCursor,
      rowsIn: 0,
      rowsUpserted: 0,
      retry: res.status === 429,
      error: `sales_funnel ${res.status} ${res.text.slice(0, 400)}`,
    };
  }

  const rows = historyJsonRows(ctx.seller.id, unpackHistory(res.data));
  const n = await upsertRows(db, "sales_funnel_daily", rows, "seller_id,stat_date,nm_id");
  const split = ymdSplit(rows.map((r) => r.stat_date), ctx.yesterday);
  return {
    done: false,
    cursor: { nmOffset: nmOffset + nmIds.length },
    rowsIn: rows.length,
    rowsUpserted: n,
    note: `json ${dateFrom}..${periodEnd} nm+${nmIds.length}`,
    ...split,
  };
}

async function csvStep(
  db: Db,
  ctx: LoaderContext,
  cursor: Record<string, unknown>,
): Promise<LoaderResult> {
  const hardEnd = ctx.yesterday;
  const dateFrom = String(cursor.dateFrom ?? FUNNEL_HISTORY_START);
  if (dateFrom > hardEnd) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "funnel history done" };
  }
  const chunkEnd = String(cursor.chunkEnd ?? historyChunkEnd(dateFrom, hardEnd));
  const phase = String(cursor.phase ?? "create");
  const downloadId = String(cursor.downloadId ?? "");

  if (phase === "create") {
    const id = crypto.randomUUID();
    const res = await wbFetch(ctx.token, "POST", CSV_CREATE_URL, {
      id,
      reportType: "DETAIL_HISTORY_REPORT",
      userReportName: `funnel ${dateFrom}..${chunkEnd}`,
      params: {
        startDate: dateFrom,
        endDate: chunkEnd,
        timezone: "Europe/Moscow",
        aggregationLevel: "day",
        skipDeletedNm: true,
      },
    });
    if (res.retry) {
      return { done: false, cursor: { phase: "create", dateFrom, chunkEnd }, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status === 402 || res.status === 403) {
      return {
        done: false,
        cursor: { jsonRecent: true, nmOffset: 0 },
        rowsIn: 0,
        rowsUpserted: 0,
        note: "Jam нет — JSON только за последние 7 дней",
      };
    }
    if (res.status !== 200) {
      return {
        done: false,
        cursor: { phase: "create", dateFrom, chunkEnd },
        rowsIn: 0,
        rowsUpserted: 0,
        error: `sales_funnel csv create ${res.status} ${res.text.slice(0, 400)}`,
      };
    }
    return {
      done: false,
      cursor: { phase: "poll", dateFrom, chunkEnd, downloadId: id, pollAttempts: 0 },
      rowsIn: 0,
      rowsUpserted: 0,
      note: `csv queued ${dateFrom}..${chunkEnd}`,
    };
  }

  if (phase === "poll") {
    const url = `${CSV_LIST_URL}?filter[downloadIds]=${encodeURIComponent(downloadId)}`;
    const res = await wbFetch(ctx.token, "GET", url);
    if (res.retry) {
      return { done: false, cursor, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status !== 200) {
      return {
        done: false,
        cursor,
        rowsIn: 0,
        rowsUpserted: 0,
        error: `sales_funnel csv poll ${res.status} ${res.text.slice(0, 400)}`,
      };
    }
    const item = csvList(res.data)[0];
    const status = String(item?.status ?? "").toUpperCase();
    if (status === "FAILED") {
      return {
        done: false,
        cursor: { phase: "create", dateFrom, chunkEnd },
        rowsIn: 0,
        rowsUpserted: 0,
        error: "sales_funnel csv FAILED",
      };
    }
    if (status !== "SUCCESS") {
      const polls = Number(cursor.pollAttempts ?? 0) + 1;
      if (polls > 120) {
        return { done: false, cursor: { phase: "create", dateFrom, chunkEnd }, rowsIn: 0, rowsUpserted: 0, error: "csv poll timeout" };
      }
      return {
        done: false,
        cursor: { ...cursor, pollAttempts: polls },
        rowsIn: 0,
        rowsUpserted: 0,
        note: `csv ${status || "WAIT"} ${dateFrom}..${chunkEnd}`,
      };
    }
    return {
      done: false,
      cursor: { phase: "fetch", dateFrom, chunkEnd, downloadId },
      rowsIn: 0,
      rowsUpserted: 0,
      note: "csv ready",
    };
  }

  if (phase === "fetch") {
    const url = `${ANALYTICS}/api/v2/nm-report/downloads/file/${encodeURIComponent(downloadId)}`;
    const res = await wbFetchBytes(ctx.token, url);
    if (res.retry) {
      return { done: false, cursor, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status === 402) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: "sales_funnel: нужна Jam" };
    }
    if (res.status !== 200 || !res.data) {
      return {
        done: false,
        cursor: { phase: "poll", dateFrom, chunkEnd, downloadId },
        rowsIn: 0,
        rowsUpserted: 0,
        error: `sales_funnel csv fetch ${res.status} ${res.text.slice(0, 200)}`,
      };
    }

    const rows = parseFunnelCsv(ctx.seller.id, csvFromZip(res.data));
    const n = await upsertRows(db, "sales_funnel_daily", rows, "seller_id,stat_date,nm_id");
    const split = ymdSplit(rows.map((r) => r.stat_date), ctx.yesterday);
    const nextFrom = addDays(chunkEnd, 1);
    if (nextFrom > hardEnd) {
      return { done: true, cursor: {}, rowsIn: rows.length, rowsUpserted: n, note: `csv done through ${chunkEnd}`, ...split };
    }
    const nextEnd = historyChunkEnd(nextFrom, hardEnd);
    return {
      done: false,
      cursor: { phase: "create", dateFrom: nextFrom, chunkEnd: nextEnd },
      rowsIn: rows.length,
      rowsUpserted: n,
      note: `csv ${dateFrom}..${chunkEnd} → next ${nextFrom}`,
      ...split,
    };
  }

  return { done: false, cursor: { phase: "create", dateFrom, chunkEnd }, rowsIn: 0, rowsUpserted: 0, note: "csv reset" };
}

export async function loadSalesFunnel(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  let cursor = { ...(ctx.cursor ?? {}) } as Record<string, unknown>;
  let rowsIn = 0;
  let rowsUpserted = 0;
  let lastNote: string | undefined;

  const stepFn = ctx.mode === "daily"
    ? (c: Record<string, unknown>) => jsonStep(db, ctx, c)
    : (c: Record<string, unknown>) => (
      c.jsonRecent
        ? jsonRecentStep(db, ctx, c)
        : csvStep(db, ctx, c)
    );

  const maxCalls = ctx.mode === "daily" || cursor.jsonRecent ? CALLS_PER_TICK : 1;

  for (let call = 0; call < maxCalls; call++) {
    const step = await stepFn(cursor);
    rowsIn += step.rowsIn;
    rowsUpserted += step.rowsUpserted;
    lastNote = step.note;
    cursor = (step.cursor ?? {}) as Record<string, unknown>;

    if (step.done) {
      return { done: true, cursor: {}, rowsIn, rowsUpserted, note: step.note, error: step.error };
    }
    if (step.retry) {
      return { done: false, cursor, rowsIn, rowsUpserted, retry: true, note: lastNote };
    }
    if (step.error) {
      return { done: step.done, cursor, rowsIn, rowsUpserted, error: step.error, retry: step.retry };
    }
    if (ctx.mode === "history" && step.note?.startsWith("csv WAIT")) break;
    if (call + 1 < maxCalls) await sleep(RATE_PAUSE_MS);
  }

  return { done: false, cursor, rowsIn, rowsUpserted, note: lastNote };
}
