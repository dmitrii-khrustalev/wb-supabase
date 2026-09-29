import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asNum, asText, extraOf, extractList, wbFetch } from "../wb.ts";

const CONTENT = "https://content-api.wildberries.ru";
const PRICES = "https://discounts-prices-api.wildberries.ru";
const MP = "https://marketplace-api.wildberries.ru";

function ok(partial: Partial<LoaderResult> & { cursor: Record<string, unknown> }): LoaderResult {
  return { done: false, rowsIn: 0, rowsUpserted: 0, ...partial };
}

export async function loadProducts(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const phase = String(ctx.cursor.phase ?? "cards");
  const sellerId = ctx.seller.id;

  if (phase === "cards") {
    const payload: Record<string, unknown> = {
      settings: {
        cursor: { limit: 100 },
        filter: { withPhoto: -1 },
      },
    };
    if (ctx.cursor.updatedAt && ctx.cursor.nmID) {
      (payload.settings as Record<string, unknown>).cursor = {
        limit: 100,
        updatedAt: ctx.cursor.updatedAt,
        nmID: ctx.cursor.nmID,
      };
    }
    const res = await wbFetch(ctx.token, "POST", `${CONTENT}/content/v2/get/cards/list`, payload);
    if (res.retry) return ok({ cursor: ctx.cursor, retry: true, note: `cards ${res.status}` });
    if (res.status !== 200) return ok({ cursor: ctx.cursor, done: true, error: `cards ${res.status} ${res.text.slice(0, 400)}` });

    const cards = extractList(res.data, "cards");
    const productRows = [];
    const sizeRows = [];
    for (const card of cards) {
      const nmId = asText(card.nmID ?? card.nmId);
      if (!nmId) continue;
      const sizes = Array.isArray(card.sizes) ? card.sizes as Record<string, unknown>[] : [];
      const skus = sizes.flatMap((s) => Array.isArray(s.skus) ? s.skus as string[] : []);
      productRows.push({
        seller_id: sellerId,
        nm_id: nmId,
        vendor_code: asText(card.vendorCode),
        title: asText(card.title),
        brand: asText(card.brand),
        subject_name: asText(card.subjectName),
        imt_id: asText(card.imtID ?? card.imtId),
        barcode: asText(card.barcode) ?? (skus[0] ? String(skus[0]) : null),
        sizes,
        extra: extraOf(card, ["nmID", "nmId", "vendorCode", "title", "brand", "subjectName", "imtID", "imtId", "barcode", "sizes"]),
        payload: card,
      });
      for (const size of sizes) {
        const chrtId = asText(size.chrtID ?? size.chrtId ?? size.chrt_id);
        if (!chrtId) continue;
        sizeRows.push({
          seller_id: sellerId,
          chrt_id: chrtId,
          nm_id: nmId,
          vendor_code: asText(card.vendorCode),
          title: asText(card.title),
          brand: asText(card.brand),
          subject_name: asText(card.subjectName),
          tech_size: asText(size.techSize),
          wb_size: asText(size.wbSize),
          skus: Array.isArray(size.skus) ? (size.skus as string[]).join(", ") : asText(size.skus),
          payload: size,
        });
      }
    }
    const n = await upsertRows(db, "products", productRows, "seller_id,nm_id");
    await upsertRows(db, "product_sizes", sizeRows, "seller_id,chrt_id");

    const cursorObj = (res.data && typeof res.data === "object")
      ? (res.data as Record<string, unknown>).cursor as Record<string, unknown> | undefined
      : undefined;
    const more = cards.length === 100 && cursorObj?.updatedAt && cursorObj?.nmID;
    if (more) {
      return ok({
        cursor: { phase: "cards", updatedAt: cursorObj.updatedAt, nmID: cursorObj.nmID },
        rowsIn: cards.length,
        rowsUpserted: n,
      });
    }
    return ok({
      cursor: { phase: "prices", offset: 0 },
      rowsIn: cards.length,
      rowsUpserted: n,
      note: "cards done, prices next",
    });
  }

  const offset = Number(ctx.cursor.offset ?? 0);
  const res = await wbFetch(
    ctx.token,
    "GET",
    `${PRICES}/api/v2/list/goods/filter?limit=1000&offset=${offset}`,
  );
  if (res.retry) return ok({ cursor: ctx.cursor, retry: true, note: `prices ${res.status}` });
  if (res.status !== 200) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: `prices ${res.status}` };
  }
  const goods = extractList(res.data, "listGoods");
  const priceRows = [];
  const historyRows = [];
  const priceDate = ctx.today;
  for (const item of goods) {
    const nmId = asText(item.nmID ?? item.nmId);
    if (!nmId) continue;
    const sizes = Array.isArray(item.sizes) ? item.sizes as Record<string, unknown>[] : [];
    const size0 = sizes[0] ?? {};
    const price = asNum(size0.price);
    const discounted = asNum(size0.discountedPrice);
    const club = asNum(size0.clubDiscountedPrice);
    const discount = price && discounted ? Math.round((1 - discounted / price) * 100) : null;
    const currency = asText(item.currencyIsoCode4217) ?? "RUB";
    priceRows.push({
      seller_id: sellerId,
      nm_id: nmId,
      price,
      discounted_price: discounted,
      club_discounted_price: club,
      discount_percent: discount,
      currency,
    });
    historyRows.push({
      seller_id: sellerId,
      nm_id: nmId,
      price_date: priceDate,
      price,
      discounted_price: discounted,
      club_discounted_price: club,
      discount_percent: discount,
      currency,
    });
  }
  const updated = await upsertRows(db, "products", priceRows, "seller_id,nm_id");
  const historyN = await upsertRows(
    db,
    "product_prices_daily",
    historyRows,
    "seller_id,nm_id,price_date",
  );
  if (goods.length < 1000) {
    return {
      done: true,
      cursor: {},
      rowsIn: goods.length,
      rowsUpserted: updated + historyN,
      note: `prices done, history ${historyN}`,
    };
  }
  return ok({
    cursor: { phase: "prices", offset: offset + 1000 },
    rowsIn: goods.length,
    rowsUpserted: updated + historyN,
    note: `prices history ${historyN}`,
  });
}

export async function loadProductPrices(
  _db: Db,
  _ctx: LoaderContext,
): Promise<LoaderResult> {
  return {
    done: true,
    cursor: {},
    rowsIn: 0,
    rowsUpserted: 0,
    note: "sheet-only: product_prices_daily filled by products sync",
  };
}

export async function loadFbsWarehouses(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const res = await wbFetch(ctx.token, "GET", `${MP}/api/v3/warehouses`);
  if (res.retry) return ok({ cursor: ctx.cursor, retry: true });
  if (res.status !== 200) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: `fbs warehouses ${res.status}` };
  const items = Array.isArray(res.data) ? res.data as Record<string, unknown>[] : extractList(res.data);
  const rows = items.map((w) => ({
    seller_id: ctx.seller.id,
    warehouse_id: asText(w.id ?? w.ID) ?? "",
    name: asText(w.name),
    office_id: asText(w.officeId),
    cargo_type: asNum(w.cargoType),
    delivery_type: asNum(w.deliveryType),
    extra: extraOf(w, ["id", "ID", "name", "officeId", "cargoType", "deliveryType"]),
    payload: w,
  })).filter((r) => r.warehouse_id);
  const n = await upsertRows(db, "fbs_warehouses", rows, "seller_id,warehouse_id");
  return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
}

export async function loadFbsOffices(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const res = await wbFetch(ctx.token, "GET", `${MP}/api/v3/offices`);
  if (res.retry) return ok({ cursor: ctx.cursor, retry: true });
  if (res.status !== 200) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: `offices ${res.status}` };
  const items = extractList(res.data, "offices");
  const rows = items.map((o) => ({
    seller_id: ctx.seller.id,
    office_id: asText(o.id) ?? "",
    name: asText(o.name),
    address: asText(o.address),
    city: asText(o.city),
    extra: extraOf(o, ["id", "name", "address", "city"]),
    payload: o,
  })).filter((r) => r.office_id);
  const n = await upsertRows(db, "fbs_offices", rows, "seller_id,office_id");
  return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
}
