import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import {
  asNum,
  asText,
  extraOf,
  extractList,
  pickWarehouseId,
  pickWarehouseName,
  unwrapRecord,
  wbFetch,
} from "../wb.ts";

const HOST = "https://supplies-api.wildberries.ru";
const DETAILS_PER_TICK = 5;

export async function loadFbwSupplies(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const phase = String(ctx.cursor.phase ?? "list");
  const dateFrom = String(ctx.cursor.dateFrom ?? (ctx.mode === "daily" ? addDaysSafe(ctx.today, -30) : ctx.seller.history_from));
  const dateTo = String(ctx.cursor.dateTo ?? ctx.today);

  if (phase === "list") {
    const offset = Number(ctx.cursor.offset ?? 0);
    const res = await wbFetch(ctx.token, "POST", `${HOST}/api/v1/supplies?limit=1000&offset=${offset}`, {
      Type: "FBW",
      dateFrom,
      dateTo,
    });
    if (res.retry) return { done: false, cursor: { phase: "list", offset, dateFrom, dateTo }, rowsIn: 0, rowsUpserted: 0, retry: true };
    if (res.status !== 200) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: `fbw list ${res.status} ${res.text.slice(0, 300)}` };
    }
    const items = extractList(res.data, "supplies");
    const rows = items.map((s) => {
      const supplyId = asText(s.supplyID ?? s.supplyId ?? s.id ?? s.preorderID ?? s.preorderId) ?? "";
      return {
        seller_id: ctx.seller.id,
        supply_id: supplyId,
        extra: extraOf(s, ["supplyID", "supplyId", "id"]),
        payload: s,
      };
    }).filter((r) => r.supply_id);
    await mergeExistingExtra(db, ctx.seller.id, rows);
    const n = await upsertRows(db, "fbw_supplies", rows, "seller_id,supply_id");
    if (ctx.mode === "daily") {
      const refreshError = await queueActiveSupplies(db, ctx.seller.id);
      if (refreshError) {
        return {
          done: true,
          cursor: {},
          rowsIn: items.length,
          rowsUpserted: n,
          error: `fbw active refresh ${refreshError}`,
        };
      }
    }
    if (items.length === 1000) {
      return {
        done: false,
        cursor: { phase: "list", offset: offset + 1000, dateFrom, dateTo },
        rowsIn: items.length,
        rowsUpserted: n,
      };
    }
    return {
      done: false,
      cursor: { phase: "details", dateFrom, dateTo },
      rowsIn: items.length,
      rowsUpserted: n,
      note: "list done, details next",
    };
  }

  const { data: pending, error } = await db
    .from("fbw_supplies")
    .select("supply_id, extra")
    .eq("seller_id", ctx.seller.id)
    .eq("details_loaded", false)
    .limit(DETAILS_PER_TICK);
  if (error) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: error.message };
  if (!pending?.length) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "details done" };

  let warehouseMap: Map<string, string> | null = null;
  let upserted = 0;
  const notes: string[] = [];

  for (const row of pending) {
    const supplyId = String(row.supply_id);
    const listExtra = isPlain(row.extra) ? row.extra : {};
    const preferPreorder = isPreorderId(supplyId, listExtra);

    const det = await fetchSupplyDetails(ctx.token, supplyId, preferPreorder);
    if (det.retry) {
      return { done: false, cursor: { phase: "details", dateFrom, dateTo }, rowsIn: 0, rowsUpserted: upserted, retry: true };
    }

    let details = det.record;
    let preorderQuery = det.preorderQuery;
    if (!pickWarehouseName(details) && !pickWarehouseId(details)) {
      const other = await fetchSupplyDetails(ctx.token, supplyId, !preferPreorder);
      if (other.retry) {
        return { done: false, cursor: { phase: "details", dateFrom, dateTo }, rowsIn: 0, rowsUpserted: upserted, retry: true };
      }
      if (other.record && (pickWarehouseName(other.record) || pickWarehouseId(other.record) || other.status === 200)) {
        details = other.record;
        preorderQuery = other.preorderQuery;
      }
    }

    if (details && looksLikeDetails(details)) {
      const merged = { ...listExtra, ...extraOf(details, []) };
      let name = pickWarehouseName(details) ?? pickWarehouseName(merged);
      const warehouseId = pickWarehouseId(details) ?? pickWarehouseId(merged);
      if (!name && warehouseId) {
        if (!warehouseMap) warehouseMap = await loadWarehouseMap(ctx.token);
        name = warehouseMap.get(warehouseId) ?? null;
      }
      if (name) merged.warehouseName = name;
      if (warehouseId && merged.warehouseID == null && merged.warehouseId == null) {
        merged.warehouseID = Number(warehouseId) || warehouseId;
      }
      const { error: updErr } = await db.from("fbw_supplies").update({
        extra: merged,
        payload: details,
        details_loaded: false,
      }).eq("seller_id", ctx.seller.id).eq("supply_id", supplyId);
      if (updErr) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: upserted, error: updErr.message };
    }

    const goodsRes = await wbFetch(
      ctx.token,
      "GET",
      `${HOST}/api/v1/supplies/${encodeURIComponent(supplyId)}/goods?limit=100&offset=0&isPreorderID=${preorderQuery}`,
    );
    if (goodsRes.retry) {
      return { done: false, cursor: { phase: "details", dateFrom, dateTo }, rowsIn: 0, rowsUpserted: upserted, retry: true };
    }

    if (goodsRes.status !== 200) {
      return {
        done: true,
        cursor: {},
        rowsIn: 0,
        rowsUpserted: upserted,
        error: `fbw goods ${supplyId} ${goodsRes.status} ${goodsRes.text.slice(0, 300)}`,
      };
    }

    const goods = extractList(goodsRes.data, "goods");
    const goodsRows = goods.map((g) => ({
      seller_id: ctx.seller.id,
      supply_id: supplyId,
      nm_id: asText(g.nmID ?? g.nmId) ?? "",
      barcode: asText(g.barcode) ?? "",
      quantity: asNum(g.quantity ?? g.qty),
      extra: extraOf(g, ["nmID", "nmId", "barcode", "quantity", "qty"]),
      payload: g,
    }));
    const { error: deleteError } = await db
      .from("fbw_supply_goods")
      .delete()
      .eq("seller_id", ctx.seller.id)
      .eq("supply_id", supplyId);
    if (deleteError) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: upserted, error: deleteError.message };
    }
    upserted += await upsertRows(db, "fbw_supply_goods", goodsRows, "seller_id,supply_id,nm_id,barcode");
    await db.from("fbw_supplies").update({ details_loaded: true }).eq("seller_id", ctx.seller.id).eq("supply_id", supplyId);
    notes.push(supplyId);
  }

  return {
    done: false,
    cursor: { phase: "details", dateFrom, dateTo },
    rowsIn: pending.length,
    rowsUpserted: upserted,
    note: `details ${notes.join(",")}`,
  };
}

function addDaysSafe(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function looksLikeDetails(obj: Record<string, unknown>): boolean {
  return !!(
    pickWarehouseName(obj) ||
    pickWarehouseId(obj) ||
    obj.phone ||
    obj.statusID != null ||
    obj.statusId != null ||
    obj.boxTypeID != null ||
    obj.createDate
  );
}

function isPreorderId(supplyId: string, extra: Record<string, unknown>): boolean {
  const pre = asText(extra.preorderID ?? extra.preorderId);
  return !!pre && pre === supplyId;
}

async function queueActiveSupplies(
  db: Db,
  sellerId: string,
): Promise<string | null> {
  const { error } = await db.rpc("fbw_queue_open_supplies", { p_seller_id: sellerId });
  return error?.message ?? null;
}

async function fetchSupplyDetails(
  token: string,
  supplyId: string,
  isPreorder: boolean,
): Promise<{ status: number; record: Record<string, unknown> | null; preorderQuery: boolean; retry: boolean }> {
  const res = await wbFetch(
    token,
    "GET",
    `${HOST}/api/v1/supplies/${encodeURIComponent(supplyId)}?isPreorderID=${isPreorder}`,
  );
  if (res.retry) return { status: res.status, record: null, preorderQuery: isPreorder, retry: true };
  if (res.status !== 200) return { status: res.status, record: null, preorderQuery: isPreorder, retry: false };
  return {
    status: 200,
    record: unwrapRecord(res.data),
    preorderQuery: isPreorder,
    retry: false,
  };
}

async function loadWarehouseMap(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const res = await wbFetch(token, "GET", `${HOST}/api/v1/warehouses`);
  if (res.status !== 200) return map;
  const items = extractList(res.data, "warehouses");
  for (const w of items) {
    const id = asText(w.ID ?? w.id ?? w.warehouseID ?? w.warehouseId);
    const name = asText(w.name ?? w.warehouseName ?? w.warehouseName ?? w.address);
    if (id && name) map.set(id, name);
  }
  return map;
}

async function mergeExistingExtra(
  db: Db,
  sellerId: string,
  rows: { supply_id: string; extra: Record<string, unknown> }[],
): Promise<void> {
  const ids = rows.map((r) => r.supply_id);
  if (!ids.length) return;
  const { data } = await db
    .from("fbw_supplies")
    .select("supply_id, extra")
    .eq("seller_id", sellerId)
    .in("supply_id", ids);
  const prev = new Map((data ?? []).map((r) => [String(r.supply_id), r.extra]));
  for (const row of rows) {
    const old = prev.get(row.supply_id);
    if (isPlain(old)) row.extra = { ...old, ...row.extra };
  }
}
