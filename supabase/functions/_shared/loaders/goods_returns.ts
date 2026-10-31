import { addDays, dailyFrom, minYmd, ymdSplit } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { fboHistoryStart_ } from "./fbo.ts";
import { asText, asTs, extraOf, extractList, wbFetch } from "../wb.ts";

// GET /api/analytics/v1/item-returns. Старый /api/v1/analytics/goods-return отключён 26.10.2026.
const HOST = "https://seller-analytics-api.wildberries.ru";
const WINDOW_DAYS = 30; // API max 31 день
const DAILY_DAYS = 7;
const PAGE_LIMIT = 1000;

type ReturnStatus = "active" | "archive";

function returnStatus_(raw: unknown): ReturnStatus {
  return raw === "archive" ? "archive" : "active";
}

function dedupeRows_<T extends { seller_id: string }>(
  rows: T[],
  keyFn: (r: T) => string,
): T[] {
  const out = new Map<string, T>();
  for (const row of rows) out.set(keyFn(row), row);
  return [...out.values()];
}

function skuOf_(o: Record<string, unknown>): string | null {
  return asText(o.sku) ?? asText(o.barcode);
}

function statusOf_(o: Record<string, unknown>): string | null {
  return asText(o.returnStatus) ?? asText(o.status);
}

function reasonOf_(o: Record<string, unknown>): string | null {
  return asText(o.returnReason) ?? asText(o.reason);
}

function returnId_(o: Record<string, unknown>, start: string, idx: number): string {
  const composite = [
    asText(o.orderId),
    asText(o.nmId),
    asText(o.orderDt),
    skuOf_(o),
    asText(o.techSize),
    statusOf_(o),
  ].filter(Boolean).join("-");
  return asText(o.shkId) ?? asText(o.stickerId) ?? asText(o.srid) ??
    (composite || `${start}-${idx}`);
}

function reportCount_(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const direct = Number(obj.count);
  if (Number.isFinite(direct)) return direct;
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    const nested = Number((obj.data as Record<string, unknown>).count);
    if (Number.isFinite(nested)) return nested;
  }
  return null;
}

function afterStatus_(
  status: ReturnStatus,
  dateFrom: string,
  dateTo: string,
  hardEnd: string,
  rowsIn: number,
  rowsUpserted: number,
  split: { rowsYesterday: number; rowsOld: number },
): LoaderResult {
  if (status === "active") {
    return {
      done: false,
      cursor: { dateFrom, dateTo, status: "archive", offset: 0 },
      rowsIn,
      rowsUpserted,
      ...split,
    };
  }
  const next = addDays(dateTo, 1);
  if (next > hardEnd) return { done: true, cursor: {}, rowsIn, rowsUpserted, ...split };
  return { done: false, cursor: { dateFrom: next }, rowsIn, rowsUpserted, ...split };
}

export async function loadGoodsReturns(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const hardEnd = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  const start = String(
    ctx.cursor.dateFrom ?? (
      ctx.mode === "daily"
        ? dailyFrom(ctx.yesterday, DAILY_DAYS)
        : await fboHistoryStart_(db, ctx.seller.id, ctx.seller.history_from)
    ),
  );
  if (start > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const dateTo = String(ctx.cursor.dateTo ?? minYmd(addDays(start, WINDOW_DAYS), hardEnd));
  const status = returnStatus_(ctx.cursor.status);
  const offset = Math.max(0, Number(ctx.cursor.offset ?? 0) || 0);
  const cursorBase = { dateFrom: start, dateTo, status, offset };
  const emptySplit = { rowsYesterday: 0, rowsOld: 0 };

  const params = new URLSearchParams({
    dateFrom: start,
    dateTo,
    status,
    limit: String(PAGE_LIMIT),
    offset: String(offset),
  });
  const res = await wbFetch(
    ctx.token,
    "GET",
    `${HOST}/api/analytics/v1/item-returns?${params}`,
  );

  if (res.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (res.status !== 200 && res.status !== 204) {
    return {
      done: true,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: `goods returns ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const items = res.status === 204 ? [] : extractList(res.data, "report");
  if (!items.length) {
    return afterStatus_(status, start, dateTo, hardEnd, 0, 0, emptySplit);
  }

  const active = status === "active";
  const rows = dedupeRows_(items.map((o, idx) => {
    const extra = extraOf(o, [
      "shkId", "srid", "orderId", "orderDt", "nmId", "sku", "barcode", "techSize",
      "returnStatus", "status", "returnType", "returnReason", "reason", "completedDt",
    ]);
    extra.isStatusActive = active ? 1 : 0;
    return {
      seller_id: ctx.seller.id,
      return_id: returnId_(o, start, idx),
      order_dt: asTs(o.orderDt),
      order_id: asText(o.orderId),
      srid: asText(o.srid),
      shk_id: asText(o.shkId),
      nm_id: asText(o.nmId),
      barcode: skuOf_(o),
      tech_size: asText(o.techSize),
      status_name: statusOf_(o),
      return_type: asText(o.returnType),
      reason: reasonOf_(o),
      completed_dt: asTs(o.completedDt),
      extra,
      payload: o,
    };
  }).filter((r) => r.return_id), (r) => `${r.seller_id}:${r.return_id}`);
  const n = await upsertRows(db, "goods_returns", rows, "seller_id,return_id");
  const split = ymdSplit(rows.map((r) => r.order_dt), ctx.yesterday);

  const nextOffset = offset + items.length;
  const total = reportCount_(res.data);
  if (items.length >= PAGE_LIMIT && (total === null || nextOffset < total)) {
    return {
      done: false,
      cursor: { dateFrom: start, dateTo, status, offset: nextOffset },
      rowsIn: items.length,
      rowsUpserted: n,
      ...split,
    };
  }

  return afterStatus_(status, start, dateTo, hardEnd, items.length, n, split);
}
