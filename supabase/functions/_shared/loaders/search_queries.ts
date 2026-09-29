import { addDays, dailyFrom, minYmd } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asNum, asText, extraOf, wbFetch } from "../wb.ts";

const HOST = "https://seller-analytics-api.wildberries.ru";
const URL = `${HOST}/api/v2/search-report/product/search-texts`;
const NM_BATCH = 50;
const WINDOW_DAYS = 7;
const DAILY_DAYS = 2;
const QUERY_LIMIT = 30;
const MAX_HISTORY_DAYS = 90;

function metricCurrent(v: unknown): number | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const cur = (v as Record<string, unknown>).current;
    if (cur !== undefined) return asNum(cur);
  }
  return asNum(v);
}

function unpackItems(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const block = (root.data && typeof root.data === "object"
    ? root.data
    : root) as Record<string, unknown>;
  const list = block.items;
  return Array.isArray(list) ? list as Record<string, unknown>[] : [];
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

function historyStart_(ctx: LoaderContext): string {
  const cap = addDays(ctx.yesterday, 1 - MAX_HISTORY_DAYS);
  const from = String(ctx.seller.history_from || cap);
  return from < cap ? cap : from;
}

export async function loadSearchQueries(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const hardEnd = ctx.yesterday;
  const winFrom = String(
    ctx.cursor.dateFrom ?? (
      ctx.mode === "daily"
        ? dailyFrom(ctx.yesterday, DAILY_DAYS)
        : historyStart_(ctx)
    ),
  );
  if (winFrom > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const winTo = String(ctx.cursor.dateTo ?? minYmd(addDays(winFrom, WINDOW_DAYS - 1), hardEnd));
  const nmOffset = Number(ctx.cursor.nmOffset ?? 0);
  const cursorBase = { dateFrom: winFrom, dateTo: winTo, nmOffset };

  const nmIds = await nmBatch(db, ctx.seller.id, nmOffset);
  if (!nmIds.length) {
    const total = await productCount(db, ctx.seller.id);
    if (total === 0) {
      return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, note: "wait products" };
    }
    if (nmOffset >= total) {
      const nextFrom = addDays(winTo, 1);
      if (nextFrom > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };
      return { done: false, cursor: { dateFrom: nextFrom, nmOffset: 0 }, rowsIn: 0, rowsUpserted: 0 };
    }
  }

  const body = {
    currentPeriod: { start: winFrom, end: winTo },
    nmIds,
    topOrderBy: "orders",
    includeSubstitutedSKUs: true,
    includeSearchTexts: true,
    orderBy: { field: "orders", mode: "desc" },
    limit: QUERY_LIMIT,
  };

  const res = await wbFetch(ctx.token, "POST", URL, body);
  if (res.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (res.status === 403) {
    return {
      done: true,
      cursor: {},
      rowsIn: 0,
      rowsUpserted: 0,
      error: "skipped: Jam subscription required (403)",
    };
  }
  if (res.status !== 200) {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: `search queries ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const known = [
    "text", "nmId", "nmID", "subjectName", "brandName", "vendorCode", "name",
    "frequency", "weekFrequency", "medianPosition", "avgPosition", "openCard",
    "addToCart", "openToCart", "orders", "cartToOrder", "visibility", "price",
    "isCardRated", "rating", "feedbackRating", "isAdvertised", "isSubstitutedSKU",
  ];
  const items = unpackItems(res.data);
  const rows = items.map((o) => {
    const text = asText(o.text) ?? "";
    const nm = asText(o.nmId) ?? asText(o.nmID) ?? "";
    return {
      seller_id: ctx.seller.id,
      stat_date: winTo,
      nm_id: nm,
      query_text: text,
      level: "top",
      supplier_article: asText(o.vendorCode),
      subject_name: asText(o.subjectName),
      brand_name: asText(o.brandName),
      avg_position: metricCurrent(o.avgPosition) ?? metricCurrent(o.medianPosition),
      open_count: metricCurrent(o.openCard),
      cart_count: metricCurrent(o.addToCart),
      order_count: metricCurrent(o.orders),
      visibility: metricCurrent(o.visibility),
      frequency: metricCurrent(o.frequency),
      extra: extraOf(o, known),
      payload: o,
    };
  }).filter((r) => r.nm_id && r.query_text);

  const n = await upsertRows(
    db,
    "search_queries",
    rows,
    "seller_id,stat_date,nm_id,query_text,level",
  );

  const total = await productCount(db, ctx.seller.id);
  const nextOffset = nmOffset + nmIds.length;
  if (nextOffset < total) {
    return {
      done: false,
      cursor: { dateFrom: winFrom, dateTo: winTo, nmOffset: nextOffset },
      rowsIn: items.length,
      rowsUpserted: n,
    };
  }

  const nextFrom = addDays(winTo, 1);
  if (nextFrom > hardEnd) {
    return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
  }
  return {
    done: false,
    cursor: { dateFrom: nextFrom, nmOffset: 0 },
    rowsIn: items.length,
    rowsUpserted: n,
  };
}
