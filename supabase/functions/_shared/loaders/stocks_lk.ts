import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asNum, asText, extraOf, wbFetch } from "../wb.ts";

const HOST = "https://seller-analytics-api.wildberries.ru";
const CREATE_URL =
  `${HOST}/api/v1/warehouse_remains?locale=ru&groupByNm=true&groupBySa=true&groupBySize=true`;

/** Сводные «склады» ЛК — не физические точки, в остатках не храним. */
const LK_VIRTUAL_WAREHOUSES = [
  "В пути до получателей",
  "В пути возвраты на склад WB",
  "Всего находится на складах",
];

function isLkVirtualWarehouse(name: string): boolean {
  const key = name.trim().toLowerCase();
  return LK_VIRTUAL_WAREHOUSES.some((v) => v.toLowerCase() === key);
}

function taskId(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const o = data as Record<string, unknown>;
  if (o.taskId) return asText(o.taskId) ?? "";
  const inner = o.data;
  if (inner && typeof inner === "object" && (inner as Record<string, unknown>).taskId) {
    return asText((inner as Record<string, unknown>).taskId) ?? "";
  }
  return "";
}

function taskStatus(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const o = data as Record<string, unknown>;
  if (o.status) return String(o.status).toLowerCase();
  const inner = o.data;
  if (inner && typeof inner === "object" && (inner as Record<string, unknown>).status) {
    return String((inner as Record<string, unknown>).status).toLowerCase();
  }
  return "";
}

function unpackItems(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: Array<Record<string, unknown>> }).data;
  }
  return [];
}

function rowsFromReport(
  sellerId: string,
  snapshotDate: string,
  items: Array<Record<string, unknown>>,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    const nmId = asText(item.nmId ?? item.nmID);
    if (!nmId) continue;
    const techSize = asText(item.techSize) ?? "";
    const base = {
      vendor_code: asText(item.vendorCode),
      brand_name: asText(item.brand),
      subject_name: asText(item.subjectName),
      barcode: asText(item.barcode),
      volume: asNum(item.volume),
    };
    const whs = Array.isArray(item.warehouses) ? item.warehouses : [];
    for (const wh of whs) {
      if (!wh || typeof wh !== "object") continue;
      const w = wh as Record<string, unknown>;
      const warehouseName = asText(w.warehouseName);
      if (!warehouseName || isLkVirtualWarehouse(warehouseName)) continue;
      const quantity = asNum(w.quantity);
      rows.push({
        seller_id: sellerId,
        snapshot_date: snapshotDate,
        nm_id: nmId,
        tech_size: techSize,
        warehouse_name: warehouseName,
        quantity,
        ...base,
        extra: extraOf(item, [
          "nmId", "nmID", "vendorCode", "brand", "subjectName", "barcode", "techSize", "volume",
        ]),
        payload: { item, warehouse: w },
      });
    }
  }
  return rows;
}

export async function loadStocksLk(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  if (ctx.mode === "history") {
    return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "stocks_lk — только daily" };
  }

  const phase = String(ctx.cursor.phase ?? "create");
  const task = String(ctx.cursor.taskId ?? "");
  const polls = Number(ctx.cursor.pollAttempts ?? 0);
  const snapshotDate = ctx.today;

  if (phase === "create") {
    const res = await wbFetch(ctx.token, "GET", CREATE_URL);
    if (res.retry) {
      return { done: false, cursor: { phase: "create" }, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status === 429) {
      return { done: false, cursor: { phase: "create" }, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status !== 200) {
      return {
        done: res.status === 401 || res.status === 403,
        cursor: { phase: "create" },
        rowsIn: 0,
        rowsUpserted: 0,
        retry: res.status === 429,
        error: `stocks_lk create ${res.status} ${res.text.slice(0, 400)}`,
      };
    }
    const id = taskId(res.data);
    if (!id) {
      return {
        done: false,
        cursor: { phase: "create" },
        rowsIn: 0,
        rowsUpserted: 0,
        error: `stocks_lk: нет taskId ${res.text.slice(0, 200)}`,
      };
    }
    return {
      done: false,
      cursor: { phase: "poll", taskId: id, pollAttempts: 0 },
      rowsIn: 0,
      rowsUpserted: 0,
      note: "lk report queued",
    };
  }

  if (phase === "poll") {
    const url = `${HOST}/api/v1/warehouse_remains/tasks/${encodeURIComponent(task)}/status`;
    const res = await wbFetch(ctx.token, "GET", url);
    if (res.retry) {
      return { done: false, cursor: ctx.cursor, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status === 429) {
      return { done: false, cursor: ctx.cursor, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status !== 200) {
      return {
        done: false,
        cursor: ctx.cursor,
        rowsIn: 0,
        rowsUpserted: 0,
        error: `stocks_lk poll ${res.status} ${res.text.slice(0, 400)}`,
      };
    }
    const status = taskStatus(res.data);
    if (status === "done") {
      return {
        done: false,
        cursor: { phase: "fetch", taskId: task },
        rowsIn: 0,
        rowsUpserted: 0,
        note: "lk report ready",
      };
    }
    if (/error|fail|cancel/.test(status)) {
      return {
        done: false,
        cursor: { phase: "create" },
        rowsIn: 0,
        rowsUpserted: 0,
        error: `stocks_lk status ${status}`,
      };
    }
    const nextPolls = polls + 1;
    if (nextPolls > 90) {
      return { done: false, cursor: { phase: "create" }, rowsIn: 0, rowsUpserted: 0, error: "stocks_lk poll timeout" };
    }
    return {
      done: false,
      cursor: { phase: "poll", taskId: task, pollAttempts: nextPolls },
      rowsIn: 0,
      rowsUpserted: 0,
      note: `lk ${status || "wait"}`,
    };
  }

  if (phase === "fetch") {
    const url = `${HOST}/api/v1/warehouse_remains/tasks/${encodeURIComponent(task)}/download`;
    const res = await wbFetch(ctx.token, "GET", url);
    if (res.retry) {
      return { done: false, cursor: ctx.cursor, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (res.status === 204) {
      return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0, note: "stocks_lk empty" };
    }
    if (res.status !== 200) {
      return {
        done: false,
        cursor: { phase: "poll", taskId: task },
        rowsIn: 0,
        rowsUpserted: 0,
        error: `stocks_lk fetch ${res.status} ${res.text.slice(0, 300)}`,
      };
    }
    const items = unpackItems(res.data);
    const rows = rowsFromReport(ctx.seller.id, snapshotDate, items);
    await db
      .from("fbo_stocks_lk")
      .delete()
      .eq("seller_id", ctx.seller.id)
      .in("warehouse_name", LK_VIRTUAL_WAREHOUSES);
    const n = await upsertRows(
      db,
      "fbo_stocks_lk",
      rows,
      "seller_id,snapshot_date,nm_id,tech_size,warehouse_name",
    );
    return {
      done: true,
      cursor: {},
      rowsIn: rows.length,
      rowsUpserted: n,
      note: `stocks_lk ${snapshotDate} items ${items.length}`,
    };
  }

  return { done: false, cursor: { phase: "create" }, rowsIn: 0, rowsUpserted: 0, note: "stocks_lk reset" };
}
