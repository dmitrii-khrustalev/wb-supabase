import { addDays, minYmd, moscowDayStartIso } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asBool, asNum, asText, asTs, extraOf, wbFetch } from "../wb.ts";

const HOST = "https://dp-calendar-api.wildberries.ru";
const LIST_LIMIT = 1000;
const DETAILS_BATCH = 100;
const NOMS_LIMIT = 1000;
const LIST_WINDOW_DAYS = 90;
const DAILY_LIST_PAST_DAYS = 14;
const DAILY_LIST_FUTURE_DAYS = 45;
const FUTURE_DAYS = 120;

type PromoPhase = "list" | "details" | "noms";

function isoZ(ymd: string, end = false): string {
  return end ? `${ymd}T23:59:59Z` : `${ymd}T00:00:00Z`;
}

function promoList(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const block = root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : root;
  const list = block.promotions;
  return Array.isArray(list) ? list as Record<string, unknown>[] : [];
}

function promoDetailsList(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const block = root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : root;
  const list = block.promotions;
  return Array.isArray(list) ? list as Record<string, unknown>[] : [];
}

function nomenclatureList(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const block = root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : root;
  const list = block.nomenclatures;
  return Array.isArray(list) ? list as Record<string, unknown>[] : [];
}

function mapPromoHeader(sellerId: string, o: Record<string, unknown>) {
  const promoId = asText(o.id) ?? "";
  const known = ["id", "name", "startDateTime", "endDateTime", "type"];
  return {
    seller_id: sellerId,
    promo_id: promoId,
    nm_id: "_",
    promo_name: asText(o.name),
    promo_type: asText(o.type),
    start_dt: asTs(o.startDateTime),
    end_dt: asTs(o.endDateTime),
    description: null,
    in_action: null,
    price: null,
    plan_price: null,
    discount: null,
    plan_discount: null,
    nomenclatures_loaded: asText(o.type) === "auto",
    extra: extraOf(o, known),
    payload: o,
  };
}

function mapPromoDetails(sellerId: string, promoId: string, o: Record<string, unknown>) {
  const known = ["id", "name", "description", "startDateTime", "endDateTime", "type"];
  return {
    seller_id: sellerId,
    promo_id: promoId,
    nm_id: "_",
    promo_name: asText(o.name),
    promo_type: asText(o.type),
    start_dt: asTs(o.startDateTime),
    end_dt: asTs(o.endDateTime),
    description: asText(o.description),
    in_action: null,
    price: null,
    plan_price: null,
    discount: null,
    plan_discount: null,
    nomenclatures_loaded: asText(o.type) === "auto",
    extra: extraOf(o, known),
    payload: o,
  };
}

function mapNomenclature(
  sellerId: string,
  promo: Record<string, unknown>,
  o: Record<string, unknown>,
  inAction: boolean,
) {
  const promoId = asText(promo.promo_id) ?? "";
  const nmId = asText(o.id) ?? asText(o.nmId) ?? "";
  const known = ["id", "inAction", "price", "currencyCode", "planPrice", "discount", "planDiscount", "nmId"];
  return {
    seller_id: sellerId,
    promo_id: promoId,
    nm_id: nmId,
    promo_name: asText(promo.promo_name),
    promo_type: asText(promo.promo_type),
    start_dt: asTs(promo.start_dt),
    end_dt: asTs(promo.end_dt),
    description: asText(promo.description),
    in_action: asBool(o.inAction) ?? inAction,
    price: asNum(o.price),
    plan_price: asNum(o.planPrice),
    discount: asNum(o.discount),
    plan_discount: asNum(o.planDiscount),
    nomenclatures_loaded: false,
    extra: extraOf(o, known),
    payload: o,
  };
}

async function loadListPage(
  token: string,
  rangeStart: string,
  rangeEnd: string,
  offset: number,
): Promise<{ items: Record<string, unknown>[]; retry?: boolean; error?: string }> {
  const params = new URLSearchParams({
    startDateTime: isoZ(rangeStart),
    endDateTime: isoZ(rangeEnd, true),
    allPromo: "true",
    limit: String(LIST_LIMIT),
    offset: String(offset),
  });
  const res = await wbFetch(token, "GET", `${HOST}/api/v1/calendar/promotions?${params}`);
  if (res.retry) return { items: [], retry: true };
  if (res.status !== 200) {
    return { items: [], error: `promos list ${res.status} ${res.text.slice(0, 200)}` };
  }
  return { items: promoList(res.data) };
}

async function loadDetailsBatch(
  token: string,
  promoIds: string[],
): Promise<{ items: Record<string, unknown>[]; retry?: boolean; error?: string }> {
  const params = new URLSearchParams();
  for (const id of promoIds) params.append("promotionIDs", id);
  const res = await wbFetch(token, "GET", `${HOST}/api/v1/calendar/promotions/details?${params}`);
  if (res.retry) return { items: [], retry: true };
  if (res.status !== 200) {
    return { items: [], error: `promos details ${res.status} ${res.text.slice(0, 200)}` };
  }
  return { items: promoDetailsList(res.data) };
}

async function loadNomenclaturesPage(
  token: string,
  promoId: string,
  inAction: boolean,
  offset: number,
): Promise<{ items: Record<string, unknown>[]; retry?: boolean; error?: string }> {
  const params = new URLSearchParams({
    promotionID: promoId,
    inAction: String(inAction),
    limit: String(NOMS_LIMIT),
    offset: String(offset),
  });
  const res = await wbFetch(token, "GET", `${HOST}/api/v1/calendar/promotions/nomenclatures?${params}`);
  if (res.retry) return { items: [], retry: true };
  if (res.status === 422) return { items: [] };
  if (res.status !== 200) {
    return { items: [], error: `promos noms ${res.status} ${res.text.slice(0, 200)}` };
  }
  return { items: nomenclatureList(res.data) };
}

type PromoHeaderRow = ReturnType<typeof mapPromoHeader>;

async function preservePromoHeaderFields(
  db: Db,
  sellerId: string,
  rows: PromoHeaderRow[],
  keepDescription = false,
): Promise<void> {
  const ids = rows.map((r) => r.promo_id).filter(Boolean);
  if (!ids.length) return;
  const { data } = await db
    .from("promos")
    .select("promo_id, nomenclatures_loaded, description")
    .eq("seller_id", sellerId)
    .eq("nm_id", "_")
    .in("promo_id", ids);
  const prev = new Map((data ?? []).map((r) => [String(r.promo_id), r]));
  for (const row of rows) {
    const old = prev.get(row.promo_id);
    if (!old) continue;
    row.nomenclatures_loaded = old.nomenclatures_loaded === true;
    if (keepDescription && old.description != null && String(old.description) !== "") {
      row.description = old.description;
    }
  }
}

async function markPromosLoadedWhenNomsExist(db: Db, sellerId: string): Promise<void> {
  const { data: headers, error } = await db
    .from("promos")
    .select("promo_id")
    .eq("seller_id", sellerId)
    .eq("nm_id", "_")
    .eq("nomenclatures_loaded", false)
    .neq("promo_type", "auto");
  if (error || !headers?.length) return;

  const ids = headers.map((r) => String(r.promo_id)).filter(Boolean);
  const { data: noms, error: nomsErr } = await db
    .from("promos")
    .select("promo_id")
    .eq("seller_id", sellerId)
    .neq("nm_id", "_")
    .in("promo_id", ids);
  if (nomsErr || !noms?.length) return;

  const hasNoms = new Set(noms.map((r) => String(r.promo_id)));
  const loaded = ids.filter((id) => hasNoms.has(id));
  if (!loaded.length) return;

  await db.from("promos")
    .update({ nomenclatures_loaded: true })
    .eq("seller_id", sellerId)
    .eq("nm_id", "_")
    .in("promo_id", loaded);
}

export async function loadPromos(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const phase = String(ctx.cursor.phase ?? "list") as PromoPhase;
  const historyFrom = String(ctx.seller.history_from || "2024-01-01");
  const listFrom = ctx.mode === "daily" ? addDays(ctx.today, -DAILY_LIST_PAST_DAYS) : historyFrom;
  const rangeEnd = ctx.mode === "daily"
    ? addDays(ctx.today, DAILY_LIST_FUTURE_DAYS)
    : addDays(ctx.today, FUTURE_DAYS);
  const rangeStart = String(ctx.cursor.rangeStart ?? listFrom);
  const rangeTo = String(
    ctx.cursor.rangeTo ?? minYmd(addDays(rangeStart, LIST_WINDOW_DAYS - 1), rangeEnd),
  );
  const listOffset = Number(ctx.cursor.listOffset ?? 0);
  const inAction = Boolean(ctx.cursor.inAction ?? false);
  const nomsOffset = Number(ctx.cursor.nomsOffset ?? 0);

  if (phase === "list") {
    const cursorBase = { phase, rangeStart, rangeTo, listOffset };
    const pack = await loadListPage(ctx.token, rangeStart, rangeTo, listOffset);
    if (pack.retry) {
      return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (pack.error) {
      return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, error: pack.error };
    }

    const rows = pack.items.map((o) => mapPromoHeader(ctx.seller.id, o))
      .filter((r) => r.promo_id);
    if (rows.length) await preservePromoHeaderFields(db, ctx.seller.id, rows, true);
    const n = rows.length
      ? await upsertRows(db, "promos", rows, "seller_id,promo_id,nm_id")
      : 0;

    if (pack.items.length >= LIST_LIMIT) {
      return {
        done: false,
        cursor: { phase, rangeStart, rangeTo, listOffset: listOffset + pack.items.length },
        rowsIn: pack.items.length,
        rowsUpserted: n,
      };
    }

    const nextStart = addDays(rangeTo, 1);
    if (nextStart <= rangeEnd) {
      return {
        done: false,
        cursor: {
          phase: "list",
          rangeStart: nextStart,
          rangeTo: minYmd(addDays(nextStart, LIST_WINDOW_DAYS - 1), rangeEnd),
          listOffset: 0,
        },
        rowsIn: pack.items.length,
        rowsUpserted: n,
      };
    }

    return {
      done: false,
      cursor: { phase: "details" },
      rowsIn: pack.items.length,
      rowsUpserted: n,
      note: "promos list done",
    };
  }

  if (phase === "details") {
    let pendingQuery = db
        .from("promos")
        .select("promo_id")
        .eq("seller_id", ctx.seller.id)
        .eq("nm_id", "_")
        .is("description", null);
      if (ctx.mode === "daily") {
        pendingQuery = pendingQuery.gte("end_dt", moscowDayStartIso(ctx.today));
      }
      const { data: pending, error } = await pendingQuery.limit(DETAILS_BATCH);
    if (error) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: error.message };
    }
    if (!pending?.length) {
      return {
        done: false,
        cursor: { phase: "noms", inAction: false, nomsOffset: 0 },
        rowsIn: 0,
        rowsUpserted: 0,
        note: "promos details done",
      };
    }

    const ids = pending.map((r) => String(r.promo_id));
    const pack = await loadDetailsBatch(ctx.token, ids);
    if (pack.retry) {
      return { done: false, cursor: { phase: "details" }, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (pack.error) {
      return { done: false, cursor: { phase: "details" }, rowsIn: 0, rowsUpserted: 0, error: pack.error };
    }

    const rows = pack.items.map((o) => mapPromoDetails(ctx.seller.id, asText(o.id) ?? "", o))
      .filter((r) => r.promo_id);
    if (rows.length) await preservePromoHeaderFields(db, ctx.seller.id, rows);
    const n = rows.length
      ? await upsertRows(db, "promos", rows, "seller_id,promo_id,nm_id")
      : 0;

    const got = new Set(rows.map((r) => r.promo_id));
    const missing = ids.filter((id) => !got.has(id));
    if (missing.length) {
      const placeholders = missing.map((promoId) => ({
        seller_id: ctx.seller.id,
        promo_id: promoId,
        nm_id: "_",
        description: "",
      }));
      await upsertRows(db, "promos", placeholders, "seller_id,promo_id,nm_id");
    }

    return {
      done: false,
      cursor: { phase: "details" },
      rowsIn: pack.items.length,
      rowsUpserted: n,
    };
  }

  await markPromosLoadedWhenNomsExist(db, ctx.seller.id);

  let nomsQuery = db
    .from("promos")
    .select("promo_id, promo_name, promo_type, start_dt, end_dt, description")
    .eq("seller_id", ctx.seller.id)
    .eq("nm_id", "_")
    .eq("nomenclatures_loaded", false)
    .neq("promo_type", "auto");
  if (ctx.mode === "daily") {
    nomsQuery = nomsQuery.gte("end_dt", moscowDayStartIso(ctx.today));
  }
  const { data: promoRow, error: promoErr } = await nomsQuery
    .order("start_dt", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (promoErr) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: promoErr.message };
  }
  if (!promoRow) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "promos noms done" };
  }

  const promoId = String(promoRow.promo_id);
  let rowsIn = 0;
  let rowsUpserted = 0;
  let curInAction = inAction;
  let curOffset = nomsOffset;

  for (let pass = 0; pass < 2; pass++) {
    const cursorBase = { phase: "noms", promoId, inAction: curInAction, nomsOffset: curOffset };
    const pack = await loadNomenclaturesPage(ctx.token, promoId, curInAction, curOffset);
    if (pack.retry) {
      return { done: false, cursor: cursorBase, rowsIn, rowsUpserted, retry: true };
    }
    if (pack.error) {
      return { done: false, cursor: cursorBase, rowsIn, rowsUpserted, error: pack.error };
    }

    const rows = pack.items.map((o) => mapNomenclature(ctx.seller.id, promoRow, o, curInAction))
      .filter((r) => r.nm_id);
    const n = rows.length
      ? await upsertRows(db, "promos", rows, "seller_id,promo_id,nm_id")
      : 0;
    rowsIn += pack.items.length;
    rowsUpserted += n;

    if (pack.items.length >= NOMS_LIMIT) {
      return {
        done: false,
        cursor: { phase: "noms", promoId, inAction: curInAction, nomsOffset: curOffset + pack.items.length },
        rowsIn,
        rowsUpserted,
      };
    }

    if (curInAction) break;
    curInAction = true;
    curOffset = 0;
  }

  await db.from("promos")
    .update({ nomenclatures_loaded: true })
    .eq("seller_id", ctx.seller.id)
    .eq("promo_id", promoId)
    .eq("nm_id", "_");

  return {
    done: false,
    cursor: { phase: "noms", inAction: false, nomsOffset: 0 },
    rowsIn,
    rowsUpserted,
    note: `promo ${promoId} noms done`,
  };
}
