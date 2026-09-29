import { addDays, dailyFrom, ymdSplit } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asNum, asText, extraOf, extractList, wbFetch } from "../wb.ts";

const V1_URL = "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed";
const WINDOW_DAYS = 6; // как короткий период в GAS, не март–август одним запросом
const DAILY_DAYS = 4; // вчера + 3 дня назад: поздние rrd и лаг отчёта
const UPD_DAYS = 31; // лимит /adv/v1/upd — не больше 31 дня за запрос
const FULLSTATS_IDS = 50; // лимит /adv/v3/fullstats — не больше 50 id

async function productTitleMap_(
  db: Db,
  sellerId: string,
  nmIds: string[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(nmIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const out = new Map<string, string>();
  if (!uniq.length) return out;
  for (let i = 0; i < uniq.length; i += 200) {
    const slice = uniq.slice(i, i + 200);
    const { data, error } = await db
      .from("products")
      .select("nm_id, title")
      .eq("seller_id", sellerId)
      .in("nm_id", slice);
    if (error) throw new Error(`products titles: ${error.message}`);
    for (const row of data ?? []) {
      const nm = asText((row as { nm_id?: unknown }).nm_id);
      const title = asText((row as { title?: unknown }).title);
      if (nm && title) out.set(nm, title);
    }
  }
  return out;
}

export async function loadFinance(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const start = String(
    ctx.cursor.dateFrom ?? (ctx.mode === "daily" ? dailyFrom(ctx.yesterday, DAILY_DAYS) : ctx.seller.history_from),
  );
  const hardEnd = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  if (start > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const dateTo = String(ctx.cursor.dateTo ?? minDate(addDays(start, WINDOW_DAYS), hardEnd));
  const rrdId = Number(ctx.cursor.rrdid) || 0;
  const res = await wbFetch(ctx.token, "POST", V1_URL, {
    dateFrom: start,
    dateTo,
    period: "daily",
    rrdId,
  });
  const cursorBase = { dateFrom: start, dateTo, rrdid: ctx.cursor.rrdid };

  if (res.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (res.status === 204 || (res.status === 200 && extractList(res.data).length === 0)) {
    const next = addDays(dateTo, 1);
    if (next > hardEnd) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "finance windows done" };
    }
    return { done: false, cursor: { dateFrom: next }, rowsIn: 0, rowsUpserted: 0, note: `next window ${next}` };
  }
  if (res.status !== 200) {
    return {
      done: res.status === 401 || res.status === 403,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      retry: res.status === 429,
      error: `finance ${res.status} ${res.text.slice(0, 400)}`,
    };
  }

  const rowsIn = extractList(res.data).map(asV5FinanceRow);
  const rows = rowsIn.map((row) => {
    const rrd = asText(row.rrd_id) ?? "";
    return {
      seller_id: ctx.seller.id,
      rrd_id: rrd,
      nm_id: asText(row.nm_id),
      sa_name: asText(row.sa_name),
      barcode: asText(row.barcode),
      doc_type_name: asText(row.doc_type_name),
      quantity: asNum(row.quantity),
      retail_amount: asNum(row.retail_amount),
      office_name: asText(row.office_name),
      supplier_oper_name: asText(row.supplier_oper_name),
      rr_dt: asText(row.rr_dt)?.slice(0, 10) ?? null,
      shk_id: asText(row.shk_id),
      extra: extraOf(row, [
        "rrd_id", "nm_id", "sa_name", "barcode",
        "doc_type_name", "quantity", "retail_amount",
        "office_name", "supplier_oper_name",
        "rr_dt", "shk_id",
      ]),
      payload: {},
    };
  }).filter((r) => r.rrd_id);

  const n = await upsertRows(db, "finance_rows", rows, "seller_id,rrd_id");
  const split = ymdSplit(rows.map((r) => r.rr_dt), ctx.yesterday);
  const kvvRows = rows
    .filter((r) => r.doc_type_name === "Продажа" && r.rr_dt)
    .map((r) => {
      const src = r.extra as Record<string, unknown>;
      return {
        rrd_id: r.rrd_id,
        rr_dt: r.rr_dt,
        ppvz_kvw_prc: asNum(src.ppvz_kvw_prc),
        ppvz_kvw_prc_base: asNum(src.ppvz_kvw_prc_base),
        commission_percent: asNum(src.commission_percent),
      };
    });
  if (kvvRows.length) await upsertRows(db, "finance_kvv", kvvRows, "rrd_id");
  const last = rowsIn[rowsIn.length - 1];
  const nextRrd = last ? asText(last.rrd_id) : null;
  if (nextRrd && nextRrd === String(ctx.cursor.rrdid ?? "")) {
    const next = addDays(dateTo, 1);
    if (next > hardEnd) return { done: true, cursor: {}, rowsIn: rowsIn.length, rowsUpserted: n, ...split };
    return { done: false, cursor: { dateFrom: next }, rowsIn: rowsIn.length, rowsUpserted: n, ...split };
  }
  if (nextRrd && rowsIn.length > 0) {
    return {
      done: false,
      cursor: { dateFrom: start, dateTo, rrdid: nextRrd },
      rowsIn: rowsIn.length,
      rowsUpserted: n,
      ...split,
    };
  }
  const next = addDays(dateTo, 1);
  if (next > hardEnd) return { done: true, cursor: {}, rowsIn: rowsIn.length, rowsUpserted: n, ...split };
  return { done: false, cursor: { dateFrom: next }, rowsIn: rowsIn.length, rowsUpserted: n, ...split };
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/** v1 camelCase + money-as-string → старый v5-shape, чтобы extra/SQL/GAS не трогать. */
const V1_TO_V5: Record<string, string> = {
  retailPrice: "retail_price",
  retailAmount: "retail_amount",
  retailPriceWithDisc: "retail_price_withdisc_rub",
  deliveryService: "delivery_rub",
  sellerPromo: "supplier_promo",
  ppvzSalesCommission: "ppvz_sales_commission",
  forPay: "ppvz_for_pay",
  ppvzReward: "ppvz_reward",
  acquiringFee: "acquiring_fee",
  vw: "ppvz_vw",
  vwNds: "ppvz_vw_nds",
  additionalPayment: "additional_payment",
  paidStorage: "storage_fee",
  paidAcceptance: "acceptance",
  rebillLogisticCost: "rebill_logistic_cost",
  installmentCofinancingAmount: "installment_cofinancing_amount",
  cashbackAmount: "cashback_amount",
  cashbackDiscount: "cashback_discount",
  cashbackCommissionChange: "cashback_commission_change",
  paymentSchedule: "payment_schedule",
  reportId: "realizationreport_id",
  rrdId: "rrd_id",
  giId: "gi_id",
  nmId: "nm_id",
  shkId: "shk_id",
  orderId: "assembly_id",
  vendorCode: "sa_name",
  sku: "barcode",
  techSize: "ts_name",
  orderUid: "order_uid",
  stickerId: "sticker_id",
  trbxId: "trbx_id",
  dateFrom: "date_from",
  dateTo: "date_to",
  createDate: "create_dt",
  fixTariffDateFrom: "fix_tariff_date_from",
  fixTariffDateTo: "fix_tariff_date_to",
  orderDt: "order_dt",
  saleDt: "sale_dt",
  rrDate: "rr_dt",
  salePercent: "sale_percent",
  commissionPercent: "commission_percent",
  dlvPrc: "dlv_prc",
  productDiscountForReport: "product_discount_for_report",
  spp: "ppvz_spp_prc",
  kvwBase: "ppvz_kvw_prc_base",
  kvw: "ppvz_kvw_prc",
  supRatingUp: "sup_rating_prc_up",
  isKgvpV2: "is_kgvp_v2",
  acquiringPercent: "acquiring_percent",
  wibesDiscountPercent: "wibes_wb_discount_percent",
  sellerPromoDiscount: "seller_promo_discount",
  loyaltyDiscount: "loyalty_discount",
  salePricePromocodeDiscountPrc: "sale_price_promocode_discount_prc",
  salePriceAffiliatedDiscountPrc: "sale_price_affiliated_discount_prc",
  agencyVat: "agency_vat",
  salePriceWholesaleDiscountPrc: "sale_price_wholesale_discount_prc",
  currency: "currency_name",
  subjectName: "subject_name",
  brandName: "brand_name",
  docTypeName: "doc_type_name",
  officeName: "office_name",
  sellerOperName: "supplier_oper_name",
  ppvzOfficeName: "ppvz_office_name",
  ppvzSupplierName: "ppvz_supplier_name",
  ppvzSupplierInn: "ppvz_inn",
  acquiringBank: "acquiring_bank",
  paymentProcessing: "payment_processing",
  declarationNumber: "declaration_number",
  bonusTypeName: "bonus_type_name",
  country: "site_country",
  deliveryMethod: "delivery_method",
  rebillLogisticOrg: "rebill_logistic_org",
  giBoxTypeName: "gi_box_type_name",
  uuidPromocode: "uuid_promocode",
  articleSubstitution: "article_substitution",
  srvDbs: "srv_dbs",
  isB2b: "is_legal_entity",
  reportType: "report_type",
  deliveryAmount: "delivery_amount",
  returnAmount: "return_amount",
  ppvzOfficeId: "ppvz_office_id",
  sellerPromoId: "seller_promo_id",
  loyaltyId: "loyalty_id",
};

const MONEY_V5 = new Set([
  "retail_price", "retail_amount", "retail_price_withdisc_rub", "delivery_rub",
  "supplier_promo", "ppvz_sales_commission", "ppvz_for_pay", "ppvz_reward",
  "acquiring_fee", "ppvz_vw", "ppvz_vw_nds", "penalty", "additional_payment",
  "rebill_logistic_cost", "storage_fee", "deduction", "acceptance",
  "installment_cofinancing_amount", "cashback_amount", "cashback_discount",
  "cashback_commission_change", "payment_schedule",
]);

function asV5FinanceRow(row: Record<string, unknown>): Record<string, unknown> {
  if (row.rrd_id != null && row.rrdId == null) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const dest = V1_TO_V5[k] ?? k;
    const money = MONEY_V5.has(dest) ? asNum(v) : null;
    out[dest] = money !== null ? money : v;
  }
  return out;
}

export async function loadAdvStats(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const hardEnd = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  const histFrom = String(ctx.seller.history_from || "2026-03-01").slice(0, 10);

  if (String(ctx.cursor.phase || "") === "upd" || await shouldStartPaymentHistory_(db, ctx, histFrom, hardEnd)) {
    const from = String(ctx.cursor.updFrom || histFrom).slice(0, 10);
    if (from <= hardEnd) {
      const to = min31(from, hardEnd);
      const pay = await patchAdvPaymentWindow_(db, ctx, from, to);
      if (pay.retry) {
        return { done: false, cursor: { phase: "upd", updFrom: from }, rowsIn: 0, rowsUpserted: 0, retry: true };
      }
      const next = addDays(to, 1);
      if (next <= hardEnd) {
        return {
          done: false,
          cursor: { phase: "upd", updFrom: next },
          rowsIn: 0,
          rowsUpserted: pay.patched,
          note: `источник списания ${from}…${to}`,
        };
      }
    }
  }

  const start = String(
    ctx.cursor.dateFrom ?? (ctx.mode === "daily" ? dailyFrom(ctx.yesterday, DAILY_DAYS) : ctx.seller.history_from),
  );
  const windowEnd = start > hardEnd ? hardEnd : (start < hardEnd ? min31(start, hardEnd) : start);
  if (start > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const campRes = await wbFetch(ctx.token, "GET", "https://advert-api.wildberries.ru/adv/v1/promotion/count");
  if (campRes.retry) return { done: false, cursor: { phase: "stats", dateFrom: start }, rowsIn: 0, rowsUpserted: 0, retry: true };
  if (campRes.status !== 200) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: `campaigns ${campRes.status}` };
  }

  const ids: string[] = [];
  const root = campRes.data as Record<string, unknown> | null;
  const adverts = Array.isArray(root?.adverts) ? root!.adverts as Record<string, unknown>[] : [];
  for (const group of adverts) {
    const status = Number(group.status);
    if (![7, 9, 11].includes(status)) continue;
    const list = Array.isArray(group.advert_list) ? group.advert_list as Record<string, unknown>[] : [];
    for (const c of list) {
      if (c.advertId != null) ids.push(String(c.advertId));
    }
  }
  if (!ids.length) {
    const next = addDays(windowEnd, 1);
    const pay = await loadAdvPaymentTypes_(db, ctx, start, windowEnd, hardEnd);
    if (pay.retry) return { done: false, cursor: { phase: "stats", dateFrom: start }, rowsIn: 0, rowsUpserted: 0, retry: true };
    if (ctx.mode === "daily" || next > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "no campaigns" };
    return { done: false, cursor: { phase: "stats", dateFrom: next }, rowsIn: 0, rowsUpserted: 0, note: "no campaigns, next window" };
  }

  const pay = await loadAdvPaymentTypes_(db, ctx, start, windowEnd, hardEnd);
  if (pay.retry) return { done: false, cursor: { phase: "stats", dateFrom: start }, rowsIn: 0, rowsUpserted: 0, retry: true };
  const paymentTypeMap = pay.map;

  const idOff = Math.max(0, Number(ctx.cursor.idOff || 0) || 0);
  const batch = ids.slice(idOff, idOff + FULLSTATS_IDS);
  if (!batch.length) {
    const next = addDays(windowEnd, 1);
    if (ctx.mode === "daily" || next > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };
    return { done: false, cursor: { phase: "stats", dateFrom: next }, rowsIn: 0, rowsUpserted: 0 };
  }
  const statsUrl =
    `https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${batch.join(",")}&beginDate=${start}&endDate=${windowEnd}`;
  const statsRes = await wbFetch(ctx.token, "GET", statsUrl);
  if (statsRes.retry || statsRes.status === 429) {
    return {
      done: false,
      cursor: { phase: "stats", dateFrom: start, idOff },
      rowsIn: 0,
      rowsUpserted: 0,
      retry: true,
    };
  }
  if (statsRes.status !== 200) {
    const limitHit = /limit|лимит|maximum 50|max 50|too many/i.test(statsRes.text);
    return {
      done: false,
      cursor: { phase: "stats", dateFrom: start, idOff },
      rowsIn: 0,
      rowsUpserted: 0,
      retry: true,
      error: limitHit
        ? `fullstats: превышен лимит id (пачка ${batch.length}, сдвиг ${idOff})`
        : `fullstats ${statsRes.status}`,
    };
  }

  const campaigns = Array.isArray(statsRes.data) ? statsRes.data as Record<string, unknown>[] : [];
  const rows: Record<string, unknown>[] = [];
  for (const campaign of campaigns) {
    const advertId = asText(campaign.advertId) ?? "";
    const days = Array.isArray(campaign.days) ? campaign.days as Record<string, unknown>[] : [];
    for (const day of days) {
      const statDate = asText(day.date)?.slice(0, 10) ?? start;
      const apps = Array.isArray(day.apps) ? day.apps as Record<string, unknown>[] : [];
      for (const app of apps) {
        const appType = asText(app.appType) ?? "";
        const nms = Array.isArray(app.nms) ? app.nms as Record<string, unknown>[] : [];
        const targets = nms.length ? nms : [{ nmId: "", name: "ИТОГО по платформе", ...app }];
        for (const nm of targets) {
          rows.push({
            seller_id: ctx.seller.id,
            advert_id: advertId,
            stat_date: statDate,
            app_type: appType,
            nm_id: asText(nm.nmId) ?? "",
            name: asText(nm.name),
            views: asNum(nm.views),
            clicks: asNum(nm.clicks),
            spend: asNum(nm.sum) !== null ? Number(nm.sum) / 100 : null,
            atbs: asNum(nm.atbs),
            orders: asNum(nm.orders),
            shks: asNum(nm.shks),
            cpc: asNum(nm.cpc),
            ctr: asNum(nm.ctr),
            cr: asNum(nm.cr),
            payment_type: paymentTypeMap[`${advertId}_${statDate}`] ?? paymentTypeMap[advertId] ?? null,
            extra: extraOf(nm as Record<string, unknown>, ["nmId", "name", "views", "clicks", "sum", "atbs", "orders", "shks", "cpc", "ctr", "cr"]),
            payload: { advertId, date: day.date, appType, nm },
          });
        }
      }
    }
  }

  const needNm = rows
    .filter((row) => !asText(row.name) && asText(row.nm_id))
    .map((row) => asText(row.nm_id) as string);
  if (needNm.length) {
    const titles = await productTitleMap_(db, ctx.seller.id, needNm);
    for (const row of rows) {
      const nm = asText(row.nm_id);
      if (!nm || asText(row.name)) continue;
      const title = titles.get(nm);
      if (title) row.name = title;
    }
  }

  const n = await upsertRows(db, "adv_stats", rows, "seller_id,advert_id,stat_date,app_type,nm_id");
  const split = ymdSplit(rows.map((r) => r.stat_date), ctx.yesterday);
  const nextOff = idOff + FULLSTATS_IDS;
  if (nextOff < ids.length) {
    return {
      done: false,
      cursor: { phase: "stats", dateFrom: start, idOff: nextOff },
      rowsIn: rows.length,
      rowsUpserted: n,
      ...split,
    };
  }
  const next = addDays(windowEnd, 1);
  if (ctx.mode === "daily" || next > hardEnd) {
    return { done: true, cursor: {}, rowsIn: rows.length, rowsUpserted: n, ...split };
  }
  return { done: false, cursor: { phase: "stats", dateFrom: next }, rowsIn: rows.length, rowsUpserted: n, ...split };
}

function min31(start: string, hardEnd: string): string {
  const end = addDays(start, 30);
  return end < hardEnd ? end : hardEnd;
}

async function shouldStartPaymentHistory_(
  db: Db,
  ctx: LoaderContext,
  histFrom: string,
  hardEnd: string,
): Promise<boolean> {
  if (ctx.mode !== "daily") return false;
  if (ctx.cursor.phase === "stats" || ctx.cursor.dateFrom) return false;
  if (ctx.cursor.phase === "upd") return true;
  const cutoff = dailyFrom(hardEnd, UPD_DAYS);
  const { count, error } = await db
    .from("adv_stats")
    .select("advert_id", { count: "exact", head: true })
    .eq("seller_id", ctx.seller.id)
    .gte("stat_date", histFrom)
    .lt("stat_date", cutoff)
    .is("payment_type", null);
  if (error) return false;
  return (count ?? 0) >= 500;
}

async function patchAdvPaymentWindow_(
  db: Db,
  ctx: LoaderContext,
  from: string,
  to: string,
): Promise<{ map: Record<string, string>; retry: boolean; patched: number }> {
  const res = await wbFetch(
    ctx.token,
    "GET",
    `https://advert-api.wildberries.ru/adv/v1/upd?from=${from}&to=${to}`,
  );
  if (res.retry) return { map: {}, retry: true, patched: 0 };
  const map: Record<string, string> = {};
  if (res.status === 200) {
    for (const u of extractList(res.data)) {
      const id = asText(u.advertId ?? u.advert_id);
      if (!id) continue;
      const pay = asText(u.paymentType ?? u.type) || "Неизвестно";
      const day = asText(u.updTime)?.slice(0, 10);
      if (day) map[`${id}_${day}`] = pay;
      if (!map[id]) map[id] = pay;
    }
  }
  let patched = 0;
  if (Object.keys(map).length) {
    const { data, error } = await db.rpc("patch_adv_payment_types", {
      p_seller_id: ctx.seller.id,
      p_from: from,
      p_to: to,
      p_map: map,
    });
    if (error) throw new Error(`patch_adv_payment_types: ${error.message}`);
    patched = Number(data) || 0;
  }
  return { map, retry: false, patched };
}

async function loadAdvPaymentTypes_(
  db: Db,
  ctx: LoaderContext,
  start: string,
  windowEnd: string,
  hardEnd: string,
): Promise<{ map: Record<string, string>; retry: boolean; patched: number }> {
  const backfill = ctx.mode === "daily" && !ctx.cursor.dateFrom && ctx.cursor.phase !== "stats";
  const from = backfill ? dailyFrom(hardEnd, UPD_DAYS) : start;
  return patchAdvPaymentWindow_(db, ctx, from, windowEnd);
}
