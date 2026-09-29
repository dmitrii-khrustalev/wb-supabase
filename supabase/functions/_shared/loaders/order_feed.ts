import { addDays, dailyFrom, moscowDayStartIso } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asBool, asNum, asText, asTs, extraOf, wbFetch } from "../wb.ts";

const HOST = "https://seller-analytics-api.wildberries.ru";
const URL = `${HOST}/api/analytics/v1/order-feed`;
const WINDOW_DAYS = 30; // API max 31 день за запрос
const PAGE_LIMIT = 1000;
const DAILY_DAYS = 4;
const MAX_HISTORY_DAYS = 31; // API: только последние 31 день, не полная история

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

type FeedBlock = {
  snapshotTime?: unknown;
  orders?: unknown;
};

function unpackFeed(data: unknown): { snapshotTime: string | null; orders: Record<string, unknown>[] } {
  if (!data || typeof data !== "object") return { snapshotTime: null, orders: [] };
  const root = data as Record<string, unknown>;
  const block = (root.data && typeof root.data === "object"
    ? root.data
    : root) as FeedBlock;
  const orders = Array.isArray(block.orders)
    ? block.orders as Record<string, unknown>[]
    : [];
  return { snapshotTime: asText(block.snapshotTime), orders };
}

function dedupeRows_<T extends { seller_id: string }>(
  rows: T[],
  keyFn: (r: T) => string,
): T[] {
  const out = new Map<string, T>();
  for (const row of rows) out.set(keyFn(row), row);
  return [...out.values()];
}

export async function loadOrderFeed(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const hardEnd = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  const dateFrom = String(
    ctx.cursor.dateFrom ?? (
      ctx.mode === "daily"
        ? dailyFrom(ctx.yesterday, DAILY_DAYS)
        : dailyFrom(hardEnd, MAX_HISTORY_DAYS)
    ),
  );
  if (dateFrom > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const dateTo = String(ctx.cursor.dateTo ?? minYmd(addDays(dateFrom, WINDOW_DAYS), hardEnd));
  const offset = Number(ctx.cursor.offset ?? 0);
  const snapshotTime = ctx.cursor.snapshotTime ? String(ctx.cursor.snapshotTime) : undefined;
  const cursorBase = { dateFrom, dateTo, offset, ...(snapshotTime ? { snapshotTime } : {}) };

  const pagination: Record<string, unknown> = { offset, limit: PAGE_LIMIT };
  if (snapshotTime && offset > 0) pagination.snapshotTime = snapshotTime;

  const body = {
    selectedPeriod: {
      start: moscowDayStartIso(dateFrom),
      end: moscowDayStartIso(dateTo),
    },
    nmIds: [] as number[],
    subjectIds: [] as number[],
    brandNames: [] as string[],
    tagIds: [] as number[],
    pagination,
  };

  const res = await wbFetch(ctx.token, "POST", URL, body);

  if (res.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (res.status !== 200) {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: `order feed ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const { snapshotTime: snap, orders } = unpackFeed(res.data);
  if (!orders.length) {
    const next = addDays(dateTo, 1);
    if (next > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };
    return { done: false, cursor: { dateFrom: next }, rowsIn: 0, rowsUpserted: 0 };
  }

  const rows = dedupeRows_(orders.map((o, idx) => {
    const eventId = asText(o.srid) ??
      `${asText(o.nmId) ?? ""}-${asText(o.chrtId) ?? ""}-${asText(o.updatedAt) ?? dateFrom}-${idx}`;
    return {
      seller_id: ctx.seller.id,
      event_id: eventId,
      status_updated_at: asTs(o.updatedAt),
      created_at: asTs(o.createdAt),
      srid: asText(o.srid),
      nm_id: asText(o.nmId),
      chrt_id: asText(o.chrtId),
      status_name: asText(o.status),
      cancel_type: asText(o.cancelType),
      warehouse_name: asText(o.warehouseName),
      warehouse_region: asText(o.warehouseRegion),
      destination_city: asText(o.destinationCity),
      destination_district: asText(o.destinationDistrict),
      seller_price: asNum(o.sellerPrice),
      is_mp: asBool(o.isMp),
      is_b2b: asBool(o.isB2b),
      extra: extraOf(o, [
        "srid", "nmId", "chrtId", "createdAt", "updatedAt", "status", "cancelType",
        "warehouseName", "warehouseRegion", "destinationCity", "destinationDistrict",
        "sellerPrice", "isMp", "isB2b",
      ]),
      payload: o,
    };
  }).filter((r) => r.event_id), (r) => `${r.seller_id}:${r.event_id}`);
  const n = await upsertRows(db, "order_feed", rows, "seller_id,event_id");

  if (orders.length >= PAGE_LIMIT) {
    const nextOffset = offset + orders.length;
    const nextSnap = snap ?? snapshotTime;
    return {
      done: false,
      cursor: {
        dateFrom,
        dateTo,
        offset: nextOffset,
        ...(nextSnap ? { snapshotTime: nextSnap } : {}),
      },
      rowsIn: orders.length,
      rowsUpserted: n,
    };
  }

  const next = addDays(dateTo, 1);
  if (next > hardEnd) return { done: true, cursor: {}, rowsIn: orders.length, rowsUpserted: n };
  return { done: false, cursor: { dateFrom: next }, rowsIn: orders.length, rowsUpserted: n };
}
