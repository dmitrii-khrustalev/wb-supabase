import { addDays, dailyFrom } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { fboHistoryStart_ } from "./fbo.ts";
import { asText, asTs, extraOf, extractList, wbFetch } from "../wb.ts";

const HOST = "https://seller-analytics-api.wildberries.ru";
const WINDOW_DAYS = 30; // API max 31 день
const DAILY_DAYS = 7;

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

function dedupeRows_<T extends { seller_id: string }>(
  rows: T[],
  keyFn: (r: T) => string,
): T[] {
  const out = new Map<string, T>();
  for (const row of rows) out.set(keyFn(row), row);
  return [...out.values()];
}

function returnId_(o: Record<string, unknown>, start: string, idx: number): string {
  const composite = [
    asText(o.orderId),
    asText(o.nmId),
    asText(o.orderDt),
    asText(o.barcode),
    asText(o.techSize),
    asText(o.status),
  ].filter(Boolean).join("-");
  return asText(o.shkId) ?? asText(o.stickerId) ?? asText(o.srid) ??
    (composite || `${start}-${idx}`);
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
  const cursorBase = { dateFrom: start, dateTo };
  const url = `${HOST}/api/v1/analytics/goods-return?dateFrom=${start}&dateTo=${dateTo}`;
  const res = await wbFetch(ctx.token, "GET", url);

  if (res.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (res.status === 204 || (res.status === 200 && extractList(res.data, "report").length === 0)) {
    const next = addDays(dateTo, 1);
    if (next > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };
    return { done: false, cursor: { dateFrom: next }, rowsIn: 0, rowsUpserted: 0 };
  }
  if (res.status !== 200) {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: `goods returns ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const items = extractList(res.data, "report");
  const rows = dedupeRows_(items.map((o, idx) => {
    const returnId = returnId_(o, start, idx);
    return {
      seller_id: ctx.seller.id,
      return_id: returnId,
      order_dt: asTs(o.orderDt),
      order_id: asText(o.orderId),
      srid: asText(o.srid),
      shk_id: asText(o.shkId),
      nm_id: asText(o.nmId),
      barcode: asText(o.barcode),
      tech_size: asText(o.techSize),
      status_name: asText(o.status),
      return_type: asText(o.returnType),
      reason: asText(o.reason),
      completed_dt: asTs(o.completedDt),
      extra: extraOf(o, [
        "shkId", "srid", "stickerId", "orderId", "orderDt", "nmId", "barcode", "techSize",
        "status", "returnType", "reason", "completedDt",
      ]),
      payload: o,
    };
  }).filter((r) => r.return_id), (r) => `${r.seller_id}:${r.return_id}`);
  const n = await upsertRows(db, "goods_returns", rows, "seller_id,return_id");

  const next = addDays(dateTo, 1);
  if (next > hardEnd) return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
  return { done: false, cursor: { dateFrom: next }, rowsIn: items.length, rowsUpserted: n };
}
