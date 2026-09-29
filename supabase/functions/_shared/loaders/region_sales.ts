import { addDays, dailyFrom, ymdSplit } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { fboHistoryStart_ } from "./fbo.ts";
import { asNum, asText, asTs, extraOf, extractList, wbFetch } from "../wb.ts";

const HOST = "https://seller-analytics-api.wildberries.ru";
const WINDOW_DAYS = 1; // API агрегирует за запрошенный период; по 1 дню = дневная детализация
const DAILY_DAYS = 2;

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

function regionSaleId_(
  dateFrom: string,
  dateTo: string,
  o: Record<string, unknown>,
): string {
  const region = asText(o.regionName) ?? "";
  const nm = asText(o.nmID) ?? asText(o.nmId) ?? "";
  const city = asText(o.cityName) ?? "";
  const sa = asText(o.sa) ?? asText(o.supplierArticle) ?? "";
  return `${dateFrom}:${dateTo}:${region}:${nm}:${city}:${sa}`;
}

export async function loadRegionSales(
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

  const dateTo = String(ctx.cursor.dateTo ?? minYmd(addDays(start, WINDOW_DAYS - 1), hardEnd));
  const cursorBase = { dateFrom: start, dateTo };
  const url = `${HOST}/api/v1/analytics/region-sale?dateFrom=${start}&dateTo=${dateTo}`;
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
      error: `region sales ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const items = extractList(res.data, "report");
  const rows = items.map((o) => {
    const saleId = regionSaleId_(start, dateTo, o);
    const cost = asNum(o.saleInvoiceCostPrice);
    return {
      seller_id: ctx.seller.id,
      sale_id: saleId,
      sale_dt: asTs(start),
      region_name: asText(o.regionName),
      country_name: asText(o.countryName),
      nm_id: asText(o.nmID) ?? asText(o.nmId),
      supplier_article: asText(o.sa) ?? asText(o.supplierArticle),
      barcode: asText(o.barcode),
      total_price: cost,
      finished_price: cost,
      extra: extraOf(o, [
        "regionName", "countryName", "nmID", "nmId", "sa", "supplierArticle", "barcode",
        "saleInvoiceCostPrice", "dateFrom", "dateTo",
      ]),
      payload: { ...o, dateFrom: start, dateTo },
    };
  }).filter((r) => r.sale_id);
  const n = await upsertRows(db, "region_sales", rows, "seller_id,sale_id");
  const split = ymdSplit(rows.map((r) => r.sale_dt), ctx.yesterday);

  const next = addDays(dateTo, 1);
  if (next > hardEnd) return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n, ...split };
  return { done: false, cursor: { dateFrom: next }, rowsIn: items.length, rowsUpserted: n, ...split };
}
