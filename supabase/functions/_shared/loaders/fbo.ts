import { addDays, dailyFrom, maxYmd, moscowYmdFromIso, ymdSplit } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asBool, asNum, asText, asTs, extraOf, extractList, wbFetch } from "../wb.ts";

/** History: не крутить пустые дни до первых заказов FBW (или финансов, если заказов ещё нет). */
export async function fboHistoryStart_(
  db: Db,
  sellerId: string,
  historyFrom: string,
): Promise<string> {
  const { data: ord } = await db
    .from("fbo_orders")
    .select("order_dt")
    .eq("seller_id", sellerId)
    .order("order_dt", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (ord?.order_dt) {
    return maxYmd(historyFrom, moscowYmdFromIso(String(ord.order_dt)));
  }

  const { data: fin } = await db
    .from("finance_rows")
    .select("rr_dt")
    .eq("seller_id", sellerId)
    .order("rr_dt", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (fin?.rr_dt) {
    return maxYmd(historyFrom, String(fin.rr_dt).slice(0, 10));
  }

  return historyFrom;
}

async function fboDayFrom_(
  db: Db,
  ctx: LoaderContext,
): Promise<string> {
  const start = ctx.mode === "daily"
    ? dailyFrom(ctx.yesterday, 3)
    : await fboHistoryStart_(db, ctx.seller.id, ctx.seller.history_from);
  const cur = ctx.cursor.date ? String(ctx.cursor.date) : "";
  if (!cur) return start;
  return maxYmd(cur, start);
}

export async function loadFboOrders(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const date = await fboDayFrom_(db, ctx);
  const end = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  if (date > end) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${date}&flag=1`;
  const res = await wbFetch(ctx.token, "GET", url);
  if (res.retry) return { done: false, cursor: { date }, rowsIn: 0, rowsUpserted: 0, retry: true };
  if (res.status !== 200) {
    return { done: false, cursor: { date }, rowsIn: 0, rowsUpserted: 0, error: `fbo orders ${res.status} ${res.text.slice(0, 300)}` };
  }

  const items = extractList(res.data);
  const rows = items.map((o) => {
    const srid = asText(o.srid) ?? asText(o.odid) ?? `${asText(o.gNumber) ?? ""}-${asText(o.barcode) ?? ""}-${asText(o.date) ?? date}`;
    return {
      seller_id: ctx.seller.id,
      srid,
      order_dt: asTs(o.date),
      last_change_dt: asTs(o.lastChangeDate),
      nm_id: asText(o.nmId),
      supplier_article: asText(o.supplierArticle),
      barcode: asText(o.barcode),
      warehouse_name: asText(o.warehouseName),
      total_price: asNum(o.totalPrice),
      finished_price: asNum(o.finishedPrice),
      is_cancel: asBool(o.isCancel),
      extra: extraOf(o, ["srid", "odid", "date", "lastChangeDate", "nmId", "supplierArticle", "barcode", "warehouseName", "totalPrice", "finishedPrice", "isCancel"]),
      payload: o,
    };
  }).filter((r) => r.srid);
  const n = await upsertRows(db, "fbo_orders", rows, "seller_id,srid");
  const split = ymdSplit(rows.map((r) => r.order_dt), ctx.yesterday);

  const next = addDays(date, 1);
  if (next > end) return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n, ...split };
  return { done: false, cursor: { date: next }, rowsIn: items.length, rowsUpserted: n, ...split };
}

export async function loadFboSales(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const date = await fboDayFrom_(db, ctx);
  const end = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  if (date > end) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${date}&flag=1`;
  const res = await wbFetch(ctx.token, "GET", url);
  if (res.retry) return { done: false, cursor: { date }, rowsIn: 0, rowsUpserted: 0, retry: true };
  if (res.status !== 200) {
    return {
      done: false,
      cursor: { date },
      rowsIn: 0,
      rowsUpserted: 0,
      error: `fbo sales ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const items = extractList(res.data);
  const rows = items.map((o) => {
    const saleId = asText(o.saleID) ?? asText(o.saleId) ?? asText(o.srid) ??
      `${asText(o.gNumber) ?? ""}-${asText(o.barcode) ?? ""}-${asText(o.date) ?? date}`;
    return {
      seller_id: ctx.seller.id,
      sale_id: saleId,
      srid: asText(o.srid),
      sale_dt: asTs(o.date),
      last_change_dt: asTs(o.lastChangeDate),
      nm_id: asText(o.nmId),
      supplier_article: asText(o.supplierArticle),
      barcode: asText(o.barcode),
      warehouse_name: asText(o.warehouseName),
      total_price: asNum(o.totalPrice),
      finished_price: asNum(o.finishedPrice),
      price_with_disc: asNum(o.priceWithDisc),
      discount_percent: asNum(o.discountPercent),
      spp: asNum(o.spp),
      is_supply: asBool(o.isSupply),
      is_realization: asBool(o.isRealization),
      extra: extraOf(o, [
        "saleID", "saleId", "srid", "date", "lastChangeDate", "nmId", "supplierArticle", "barcode",
        "warehouseName", "totalPrice", "finishedPrice", "priceWithDisc", "discountPercent", "spp",
        "isSupply", "isRealization",
      ]),
      payload: o,
    };
  }).filter((r) => r.sale_id);
  const n = await upsertRows(db, "fbo_sales", rows, "seller_id,sale_id");
  const split = ymdSplit(rows.map((r) => r.sale_dt), ctx.yesterday);

  const next = addDays(date, 1);
  if (next > end) return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n, ...split };
  return { done: false, cursor: { date: next }, rowsIn: items.length, rowsUpserted: n, ...split };
}

export async function loadFboStocks(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const offset = Number(ctx.cursor.offset ?? 0);
  const res = await wbFetch(
    ctx.token,
    "POST",
    "https://seller-analytics-api.wildberries.ru/api/analytics/v1/stocks-report/wb-warehouses",
    { limit: 100000, offset },
  );
  if (res.retry) return { done: false, cursor: { offset }, rowsIn: 0, rowsUpserted: 0, retry: true };
  if (res.status !== 200) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: `fbo stocks ${res.status}` };
  }
  const items = extractList(res.data, "items");
  const rows = items.map((item) => ({
    seller_id: ctx.seller.id,
    snapshot_date: ctx.today,
    nm_id: asText(item.nmId) ?? "",
    warehouse_name: asText(item.warehouseName) ?? "",
    quantity: asNum(item.quantity),
    extra: extraOf(item, ["nmId", "warehouseName", "quantity"]),
    payload: item,
  })).filter((r) => r.nm_id && r.warehouse_name);
  const n = await upsertRows(db, "fbo_stocks", rows, "seller_id,snapshot_date,nm_id,warehouse_name");
  if (items.length === 100000) {
    return { done: false, cursor: { offset: offset + 100000 }, rowsIn: items.length, rowsUpserted: n };
  }
  return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
}
