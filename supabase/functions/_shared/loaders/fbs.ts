import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asBool, asNum, asText, asTs, extraOf, extractIds, extractList, stripFile, wbFetch } from "../wb.ts";

const MP = "https://marketplace-api.wildberries.ru";
const DAILY_ORDER_DAYS = 14;
const HISTORY_ORDER_DAYS = 30;
const SUPPLY_DETAILS_PER_TICK = 3;
const STATUS_BATCH_SIZE = 1000;
const STATUS_BATCHES_PER_TICK = 3;
const FINAL_WB_STATUSES = [
  "sold",
  "canceled_by_client",
  "declined_by_client",
  "defect",
  "canceled",
  "cancelled",
];

export async function loadFbsStocks(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const { data: warehouses, error: whErr } = await db
    .from("fbs_warehouses")
    .select("warehouse_id, name, office_id, cargo_type, delivery_type")
    .eq("seller_id", ctx.seller.id);
  if (whErr) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: whErr.message };
  if (!warehouses?.length) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "no fbs warehouses yet — run fbs_warehouses first" };
  }

  const { data: sizes, error: szErr } = await db
    .from("product_sizes")
    .select("chrt_id, nm_id, vendor_code, title, brand, subject_name, tech_size, wb_size, skus")
    .eq("seller_id", ctx.seller.id);
  if (szErr) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: szErr.message };
  if (!sizes?.length) {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "no product_sizes — run products first" };
  }

  const idx = Number(ctx.cursor.warehouseIdx ?? 0);
  if (idx >= warehouses.length) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const wh = warehouses[idx];
  const chrtIds = sizes.map((s) => Number(s.chrt_id)).filter((n) => Number.isFinite(n));
  const sizeMap = new Map(sizes.map((s) => [String(s.chrt_id), s]));
  let upserted = 0;
  let rowsIn = 0;

  for (let i = 0; i < chrtIds.length; i += 1000) {
    const batch = chrtIds.slice(i, i + 1000);
    const res = await wbFetch(ctx.token, "POST", `${MP}/api/v3/stocks/${wh.warehouse_id}`, { chrtIds: batch });
    if (res.retry) {
      return { done: false, cursor: { warehouseIdx: idx }, rowsIn: 0, rowsUpserted: upserted, retry: true };
    }
    if (res.status !== 200) {
      return { done: false, cursor: { warehouseIdx: idx + 1 }, rowsIn: 0, rowsUpserted: 0, note: `stocks ${wh.warehouse_id} ${res.status}` };
    }
    const items = extractList(res.data, "stocks");
    rowsIn += items.length;
    const rows = items.map((st) => {
      const chrtId = asText(st.chrtId ?? st.chrtID) ?? "";
      const info = sizeMap.get(chrtId);
      return {
        seller_id: ctx.seller.id,
        snapshot_date: ctx.today,
        warehouse_id: String(wh.warehouse_id),
        chrt_id: chrtId,
        amount: asNum(st.amount),
        sku: asText(st.sku) ?? info?.skus ?? null,
        nm_id: info?.nm_id ?? null,
        extra: {
          ...extraOf(st, ["chrtId", "chrtID", "amount", "sku"]),
          warehouseName: wh.name,
          officeId: wh.office_id,
          vendorCode: info?.vendor_code,
          title: info?.title,
        },
        payload: st,
      };
    }).filter((r) => r.chrt_id);
    upserted += await upsertRows(db, "fbs_stocks", rows, "seller_id,snapshot_date,warehouse_id,chrt_id");
  }

  const next = idx + 1;
  if (next >= warehouses.length) {
    return { done: true, cursor: {}, rowsIn, rowsUpserted: upserted };
  }
  return { done: false, cursor: { warehouseIdx: next }, rowsIn, rowsUpserted: upserted };
}

export async function loadFbsOrders(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const phase = String(ctx.cursor.phase ?? "new");
  const sellerId = ctx.seller.id;

  if (phase === "new") {
    const res = await wbFetch(ctx.token, "GET", `${MP}/api/v3/orders/new`);
    if (res.retry) return retryCursor(ctx, { phase: "new" });
    const orders = extractList(res.data, "orders");
    const n = await upsertOrderList(db, sellerId, orders, "new");
    return {
      done: false,
      cursor: { phase: "list", next: 0 },
      rowsIn: orders.length,
      rowsUpserted: n,
    };
  }

  if (phase === "list") {
    const daily = ctx.mode === "daily";
    const next = Number(ctx.cursor.next ?? 0);
    const nowSec = Math.floor(Date.now() / 1000);
    const days = daily ? DAILY_ORDER_DAYS : HISTORY_ORDER_DAYS;
    const fromSec = nowSec - days * 24 * 3600;
    const url = `${MP}/api/v3/orders?limit=1000&next=${next}&dateFrom=${fromSec}&dateTo=${nowSec}`;
    const res = await wbFetch(ctx.token, "GET", url);
    if (res.retry) return retryCursor(ctx, { phase: "list", next });
    if (res.status !== 200) {
      return { done: false, cursor: { phase: "statuses" }, rowsIn: 0, rowsUpserted: 0, note: `orders list ${res.status}` };
    }
    const orders = extractList(res.data, "orders");
    const n = await upsertOrderList(db, sellerId, orders, daily ? `orders_${DAILY_ORDER_DAYS}d` : "orders_30d");
    const newNext = (res.data && typeof res.data === "object")
      ? (res.data as Record<string, unknown>).next
      : null;
    if (orders.length && newNext !== null && newNext !== undefined && Number(newNext) !== next) {
      return { done: false, cursor: { phase: "list", next: Number(newNext) }, rowsIn: orders.length, rowsUpserted: n };
    }
    const nextPhase = ctx.mode === "daily" ? "statuses" : "archive";
    return { done: false, cursor: { phase: nextPhase, archNext: 0, archBack: 0 }, rowsIn: orders.length, rowsUpserted: n };
  }

  if (phase === "archive") {
    const back = Number(ctx.cursor.archBack ?? 0);
    if (back >= 18) return { done: false, cursor: { phase: "statuses" }, rowsIn: 0, rowsUpserted: 0 };
    const d = new Date();
    d.setMonth(d.getMonth() - back);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const next = Number(ctx.cursor.archNext ?? 0);
    const res = await wbFetch(
      ctx.token,
      "GET",
      `${MP}/api/marketplace/v3/fbs/orders/archive?year=${year}&month=${month}&limit=1000&next=${next}`,
    );
    if (res.retry) return retryCursor(ctx, { phase: "archive", archBack: back, archNext: next });
    const orders = extractList(res.data, "orders");
    const n = await upsertOrderList(db, sellerId, orders, "archive");
    const newNext = (res.data && typeof res.data === "object")
      ? (res.data as Record<string, unknown>).next
      : null;
    if (orders.length && newNext !== null && newNext !== undefined && Number(newNext) !== next) {
      return {
        done: false,
        cursor: { phase: "archive", archBack: back, archNext: Number(newNext) },
        rowsIn: orders.length,
        rowsUpserted: n,
      };
    }
    return {
      done: false,
      cursor: { phase: "archive", archBack: back + 1, archNext: 0 },
      rowsIn: orders.length,
      rowsUpserted: n,
    };
  }

  if (phase === "statuses") {
    const daily = ctx.mode === "daily";
    const after = String(ctx.cursor.afterId ?? "");
    const days = daily ? DAILY_ORDER_DAYS : HISTORY_ORDER_DAYS;
    const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    let rowsIn = 0;
    let rowsUpserted = 0;
    let lastAfterId = after;
    const maxBatches = daily ? STATUS_BATCHES_PER_TICK : 1;

    for (let batch = 0; batch < maxBatches; batch++) {
      let q = db
        .from("fbs_orders")
        .select("order_id")
        .eq("seller_id", sellerId)
        .order("order_id", { ascending: true })
        .limit(STATUS_BATCH_SIZE);
      if (daily) {
        q = q.gte("created_at", sinceIso);
        q = q.or("supplier_status.is.null,supplier_status.in.(new,confirm,complete)");
        q = q.or(`wb_status.is.null,wb_status.not.in.(${FINAL_WB_STATUSES.join(",")})`);
        q = q.neq("supplier_status", "cancel");
        if (lastAfterId) q = q.gt("order_id", lastAfterId);
      } else {
        q = q.is("supplier_status", null);
      }

      const { data: need, error } = await q;
      if (error) return { done: true, cursor: {}, rowsIn, rowsUpserted, error: error.message };
      if (!need?.length) {
        return { done: false, cursor: { phase: "reship" }, rowsIn, rowsUpserted };
      }

      const ids = need.map((r) => Number(r.order_id)).filter((n) => Number.isFinite(n));
      const res = await wbFetch(ctx.token, "POST", `${MP}/api/v3/orders/status`, { orders: ids });
      if (res.retry) {
        return retryCursor(ctx, daily ? { phase: "statuses", afterId: lastAfterId } : { phase: "statuses" });
      }
      const items = extractList(res.data, "orders");
      const statusRows = items.map((st) => ({
        seller_id: sellerId,
        order_id: asText(st.id) ?? "",
        supplier_status: asText(st.supplierStatus),
        wb_status: asText(st.wbStatus),
      })).filter((r) => r.order_id);
      const updated = statusRows.length
        ? await upsertRows(db, "fbs_orders", statusRows, "seller_id,order_id")
        : 0;
      rowsIn += items.length;
      rowsUpserted += updated;
      lastAfterId = String(need[need.length - 1].order_id);

      if (need.length < STATUS_BATCH_SIZE) {
        return { done: false, cursor: { phase: "reship" }, rowsIn, rowsUpserted };
      }
    }

    return {
      done: false,
      cursor: { phase: "statuses", afterId: lastAfterId },
      rowsIn,
      rowsUpserted,
      note: "statuses continue",
    };
  }

  if (phase === "reship") {
    const res = await wbFetch(ctx.token, "GET", `${MP}/api/v3/supplies/orders/reshipment`);
    if (res.retry) return retryCursor(ctx, { phase: "reship" });
    const orders = extractList(res.data, "orders");
    const rows = orders.map((o) => ({
      seller_id: sellerId,
      order_id: asText(o.id) ?? "",
      extra: extraOf(o, ["id"]),
      payload: o,
    })).filter((r) => r.order_id);
    const n = await upsertRows(db, "fbs_order_reshipment", rows, "seller_id,order_id");
    const nextPhase = ctx.mode === "daily" ? "done" : "stickers";
    if (nextPhase === "done") return { done: true, cursor: {}, rowsIn: orders.length, rowsUpserted: n };
    return { done: false, cursor: { phase: "stickers" }, rowsIn: orders.length, rowsUpserted: n };
  }

  if (phase === "stickers") {
    const { data: ids, error } = await db
      .from("fbs_orders")
      .select("order_id")
      .eq("seller_id", sellerId)
      .in("supplier_status", ["confirm", "complete"])
      .limit(100);
    if (error) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: error.message };
    if (!ids?.length) return { done: false, cursor: { phase: "clients" }, rowsIn: 0, rowsUpserted: 0 };

    const numeric = ids.map((r) => Number(r.order_id)).filter((n) => Number.isFinite(n));
    const res = await wbFetch(
      ctx.token,
      "POST",
      `${MP}/api/v3/orders/stickers?type=png&width=58&height=40`,
      { orders: numeric },
    );
    if (res.retry) return retryCursor(ctx, { phase: "stickers" });
    const stickers = extractList(res.data, "stickers").map(stripFile);
    const rows = stickers.map((s) => ({
      seller_id: sellerId,
      order_id: asText(s.orderId ?? s.id) ?? "",
      barcode: asText(s.barcode),
      part_a: asText(s.partA),
      part_b: asText(s.partB),
      extra: extraOf(s, ["orderId", "id", "barcode", "partA", "partB", "file"]),
      payload: s,
    })).filter((r) => r.order_id);
    const n = await upsertRows(db, "fbs_order_stickers", rows, "seller_id,order_id");
    return { done: false, cursor: { phase: "clients" }, rowsIn: stickers.length, rowsUpserted: n };
  }

  if (phase === "clients") {
    const { data: xb } = await db
      .from("fbs_orders")
      .select("order_id, extra")
      .eq("seller_id", sellerId)
      .limit(5000);
    const xbIds = (xb ?? [])
      .filter((r) => Number((r.extra as Record<string, unknown> | null)?.crossBorderType) === 1)
      .map((r) => Number(r.order_id))
      .filter((n) => Number.isFinite(n))
      .slice(0, 100);
    if (!xbIds.length) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "no cross-border" };

    const clientRes = await wbFetch(ctx.token, "POST", `${MP}/api/v3/orders/client`, { orders: xbIds });
    if (clientRes.retry) return retryCursor(ctx, { phase: "clients" });
    const clients = extractList(clientRes.data, "orders");
    const clientRows = clients.map((c) => ({
      seller_id: sellerId,
      order_id: asText(c.id) ?? "",
      extra: extraOf(c, ["id"]),
      payload: c,
    })).filter((r) => r.order_id);
    const n1 = await upsertRows(db, "fbs_order_clients", clientRows, "seller_id,order_id");

    const histRes = await wbFetch(ctx.token, "POST", `${MP}/api/v3/orders/status/history`, { orders: xbIds });
    const hist = extractList(histRes.data, "orders");
    const histRows = hist.map((h) => ({
      seller_id: sellerId,
      order_id: asText(h.id) ?? "",
      extra: extraOf(h, ["id"]),
      payload: h,
    })).filter((r) => r.order_id);
    const n2 = await upsertRows(db, "fbs_order_history", histRows, "seller_id,order_id");
    return { done: true, cursor: {}, rowsIn: clients.length + hist.length, rowsUpserted: n1 + n2 };
  }

  return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };
}

export async function loadFbsSupplies(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const phase = String(ctx.cursor.phase ?? "list");
  const sellerId = ctx.seller.id;

  if (phase === "list") {
    const next = Number(ctx.cursor.next ?? 0);
    const res = await wbFetch(ctx.token, "GET", `${MP}/api/v3/supplies?limit=1000&next=${next}`);
    if (res.retry) return retryCursor(ctx, { phase: "list", next });
    if (res.status !== 200) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: `supplies ${res.status}` };
    }
    const items = extractList(res.data, "supplies");
    const rows = items.map((s) => ({
      seller_id: sellerId,
      supply_id: asText(s.id) ?? "",
      name: asText(s.name),
      done: asBool(s.done),
      extra: extraOf(s, ["id", "name", "done"]),
      payload: s,
    })).filter((r) => r.supply_id);
    await mergeExistingSupplyExtra(db, sellerId, rows);
    const n = await upsertRows(db, "fbs_supplies", rows, "seller_id,supply_id");
    const newNext = (res.data && typeof res.data === "object")
      ? (res.data as Record<string, unknown>).next
      : null;
    if (items.length && newNext !== null && newNext !== undefined && Number(newNext) !== next) {
      return { done: false, cursor: { phase: "list", next: Number(newNext) }, rowsIn: items.length, rowsUpserted: n };
    }
    if (ctx.mode === "daily") {
      await queueOpenFbsSupplies(db, sellerId);
    }
    return { done: false, cursor: { phase: "details" }, rowsIn: items.length, rowsUpserted: n };
  }

  const { data: pending, error } = await db
    .from("fbs_supplies")
    .select("supply_id, done")
    .eq("seller_id", sellerId)
    .eq("details_loaded", false)
    .limit(SUPPLY_DETAILS_PER_TICK);
  if (error) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, error: error.message };
  if (!pending?.length) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "supply details done" };

  let rowsIn = 0;
  let rowsUpserted = 0;
  const notes: string[] = [];

  for (const row of pending) {
    const pack = await loadFbsSupplyDetails(db, ctx.token, sellerId, String(row.supply_id), row.done === true);
    if (pack.retry) return retryCursor(ctx, { phase: "details" });
    if (pack.error) {
      return {
        done: true,
        cursor: {},
        rowsIn,
        rowsUpserted,
        error: pack.error,
        note: notes.join(", "),
      };
    }
    rowsIn += pack.rowsIn;
    rowsUpserted += pack.rowsUpserted;
    notes.push(pack.note);
  }

  return {
    done: false,
    cursor: { phase: "details" },
    rowsIn,
    rowsUpserted,
    note: notes.join(", "),
  };
}

async function loadFbsSupplyDetails(
  db: Db,
  token: string,
  sellerId: string,
  supplyId: string,
  closed: boolean,
): Promise<{ rowsIn: number; rowsUpserted: number; note: string; retry?: boolean; error?: string }> {
  const oidRes = await wbFetch(
    token,
    "GET",
    `${MP}/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/order-ids`,
  );
  if (oidRes.retry) return { rowsIn: 0, rowsUpserted: 0, note: supplyId, retry: true };
  const orderIds = extractIds(oidRes.data, "orderIds");
  await upsertRows(
    db,
    "fbs_supply_orders",
    orderIds.map((orderId) => ({ seller_id: sellerId, supply_id: supplyId, order_id: String(orderId) })),
    "seller_id,supply_id,order_id",
  );

  const trbxRes = await wbFetch(token, "GET", `${MP}/api/v3/supplies/${encodeURIComponent(supplyId)}/trbx`);
  if (trbxRes.retry) return { rowsIn: 0, rowsUpserted: 0, note: supplyId, retry: true };
  const boxes = extractList(trbxRes.data, "trbxes");
  const trbxIds: string[] = [];
  const trbxRows = boxes.map((b) => {
    const trbxId = asText(b.id ?? b.trbxId) ?? "";
    if (trbxId) trbxIds.push(trbxId);
    return {
      seller_id: sellerId,
      supply_id: supplyId,
      trbx_id: trbxId,
      extra: extraOf(b, ["id", "trbxId"]),
      payload: b,
    };
  }).filter((r) => r.trbx_id);
  await upsertRows(db, "fbs_supply_trbx", trbxRows, "seller_id,supply_id,trbx_id");

  if (closed) {
    const qrRes = await wbFetch(
      token,
      "GET",
      `${MP}/api/v3/supplies/${encodeURIComponent(supplyId)}/barcode?type=png`,
    );
    if (qrRes.retry) return { rowsIn: 0, rowsUpserted: 0, note: supplyId, retry: true };
    if (qrRes.status === 200 && qrRes.data && typeof qrRes.data === "object") {
      const qr = stripFile(qrRes.data as Record<string, unknown>);
      await upsertRows(db, "fbs_supply_qr", [{
        seller_id: sellerId,
        supply_id: supplyId,
        barcode: asText(qr.barcode),
        extra: extraOf(qr, ["barcode", "file"]),
        payload: qr,
      }], "seller_id,supply_id");
    }
  }

  if (trbxIds.length) {
    const stRes = await wbFetch(
      token,
      "POST",
      `${MP}/api/v3/supplies/${encodeURIComponent(supplyId)}/trbx/stickers?type=png`,
      { trbxIds: trbxIds.slice(0, 100) },
    );
    if (stRes.retry) return { rowsIn: 0, rowsUpserted: 0, note: supplyId, retry: true };
    const stickers = extractList(stRes.data, "stickers").map(stripFile);
    for (const s of stickers) {
      const trbxId = asText(s.id ?? s.trbxId);
      if (!trbxId) continue;
      await db.from("fbs_supply_trbx").update({
        barcode: asText(s.barcode),
        extra: extraOf(s, ["id", "trbxId", "barcode", "file"]),
        payload: s,
      }).eq("seller_id", sellerId).eq("supply_id", supplyId).eq("trbx_id", trbxId);
    }
  }

  const { error: markErr } = await db.from("fbs_supplies")
    .update({ details_loaded: true })
    .eq("seller_id", sellerId)
    .eq("supply_id", supplyId);
  if (markErr) {
    return { rowsIn: 1, rowsUpserted: orderIds.length + trbxRows.length, note: supplyId, error: markErr.message };
  }

  return {
    rowsIn: 1,
    rowsUpserted: orderIds.length + trbxRows.length,
    note: `supply ${supplyId}`,
  };
}

async function upsertOrderList(
  db: Db,
  sellerId: string,
  orders: Record<string, unknown>[],
  source: string,
): Promise<number> {
  const rows = orders.map((o) => {
    const orderId = asText(o.id) ?? "";
    return {
      seller_id: sellerId,
      order_id: orderId,
      rid: asText(o.rid),
      order_uid: asText(o.orderUid),
      created_at: asTs(o.createdAt),
      article: asText(o.article),
      nm_id: asText(o.nmId ?? o.nmID),
      chrt_id: asText(o.chrtId),
      warehouse_id: asText(o.warehouseId),
      supply_id: asText(o.supplyId),
      source,
      extra: extraOf(o, [
        "id", "rid", "orderUid", "createdAt", "article", "nmId", "nmID", "chrtId",
        "warehouseId", "supplyId",
      ]),
      payload: o,
    };
  }).filter((r) => r.order_id);
  return await upsertRows(db, "fbs_orders", rows, "seller_id,order_id");
}

function retryCursor(
  ctx: LoaderContext,
  cursor: Record<string, unknown>,
): LoaderResult {
  return { done: false, cursor, rowsIn: 0, rowsUpserted: 0, retry: true };
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function mergeExistingSupplyExtra(
  db: Db,
  sellerId: string,
  rows: { supply_id: string; extra: Record<string, unknown> }[],
): Promise<void> {
  const ids = rows.map((r) => r.supply_id);
  if (!ids.length) return;
  const { data } = await db
    .from("fbs_supplies")
    .select("supply_id, extra")
    .eq("seller_id", sellerId)
    .in("supply_id", ids);
  const prev = new Map((data ?? []).map((r) => [String(r.supply_id), r.extra]));
  for (const row of rows) {
    const old = prev.get(row.supply_id);
    if (isPlain(old)) row.extra = { ...old, ...row.extra };
  }
}

async function queueOpenFbsSupplies(db: Db, sellerId: string): Promise<void> {
  const { error } = await db.rpc("fbs_queue_open_supplies", { p_seller_id: sellerId });
  if (error) {
    await db.from("fbs_supplies")
      .update({ details_loaded: false })
      .eq("seller_id", sellerId)
      .eq("done", false);
  }
}
