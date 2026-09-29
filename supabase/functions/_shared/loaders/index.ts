import type { Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import {
  loadFbsOffices,
  loadFbsWarehouses,
  loadProductPrices,
  loadProducts,
} from "./catalogs.ts";
import { loadAdvStats, loadFinance } from "./finance.ts";
import { loadFboOrders, loadFboSales, loadFboStocks } from "./fbo.ts";
import { loadFbwSupplies } from "./fbw.ts";
import { loadFbsOrders, loadFbsStocks, loadFbsSupplies } from "./fbs.ts";
import { loadFeedbacks } from "./feedbacks.ts";
import { loadGoodsReturns } from "./goods_returns.ts";
import { loadOrderFeed } from "./order_feed.ts";
import { loadQuestions } from "./questions.ts";
import { loadRegionSales } from "./region_sales.ts";
import { loadSearchQueries } from "./search_queries.ts";
import { loadSalesFunnel } from "./sales_funnel.ts";
import { loadTariffs } from "./tariffs.ts";
import { loadWbRetentions } from "./wb_retentions.ts";
import { loadWarehouseServices } from "./warehouse_services.ts";
import { loadClaims } from "./claims.ts";
import { loadPromos } from "./promos.ts";
import { loadStocksLk } from "./stocks_lk.ts";

const LOADERS: Record<
  string,
  (db: Db, ctx: LoaderContext) => Promise<LoaderResult>
> = {
  products: loadProducts,
  product_prices: loadProductPrices,
  finance: loadFinance,
  adv_stats: loadAdvStats,
  fbo_orders: loadFboOrders,
  fbo_sales: loadFboSales,
  region_sales: loadRegionSales,
  goods_returns: loadGoodsReturns,
  order_feed: loadOrderFeed,
  feedbacks: loadFeedbacks,
  questions: loadQuestions,
  search_queries: loadSearchQueries,
  tariffs: loadTariffs,
  wb_retentions: loadWbRetentions,
  warehouse_services: loadWarehouseServices,
  claims: loadClaims,
  promos: loadPromos,
  fbo_stocks: loadFboStocks,
  stocks_lk: loadStocksLk,
  fbw_supplies: loadFbwSupplies,
  fbs_warehouses: loadFbsWarehouses,
  fbs_offices: loadFbsOffices,
  fbs_stocks: loadFbsStocks,
  fbs_orders: loadFbsOrders,
  fbs_supplies: loadFbsSupplies,
  sales_funnel: loadSalesFunnel,
};

export const DATASET_NAMES = Object.keys(LOADERS);

const SNAPSHOT_DATASETS = new Set(["fbo_stocks", "fbs_stocks", "stocks_lk"]);
const CATALOG_DATASETS = new Set([
  "products",
  "tariffs",
  "fbs_warehouses",
  "fbs_offices",
  "promos",
]);

export async function runLoader(
  db: Db,
  dataset: string,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const fn = LOADERS[dataset];
  if (!fn) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: `unknown dataset ${dataset}` };
  const result = await fn(db, ctx);
  if (result.rowsYesterday == null && result.rowsOld == null) {
    const n = result.rowsUpserted || 0;
    if (SNAPSHOT_DATASETS.has(dataset)) {
      result.rowsYesterday = n;
      result.rowsOld = 0;
    } else if (CATALOG_DATASETS.has(dataset)) {
      result.rowsYesterday = 0;
      result.rowsOld = n;
    }
  }
  return result;
}
