import { addDays, dailyFrom, maxYmd, minYmd, moscowYmdFromIso } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { fboHistoryStart_ } from "./fbo.ts";
import { asNum, asText, asTs, extraOf, unwrapRecord, wbFetch } from "../wb.ts";

const HOST = "https://seller-analytics-api.wildberries.ru";
const STORAGE_WINDOW = 7; // API max 8 дней
const ACCEPTANCE_WINDOW = 31;
const DAILY_STORAGE_DAYS = 10;
const DAILY_ACCEPTANCE_DAYS = 10;
const DAILY_OVERLAP_DAYS = 3; // догон уже загруженного хвоста
const MAX_POLLS_PER_TICK = 12;

type ServiceKind = "paid_storage" | "acceptance";

const KINDS: ServiceKind[] = ["paid_storage", "acceptance"];

function nextKind(kind: ServiceKind): ServiceKind | null {
  const i = KINDS.indexOf(kind);
  return i < 0 || i >= KINDS.length - 1 ? null : KINDS[i + 1];
}

function windowDays(kind: ServiceKind): number {
  return kind === "paid_storage" ? STORAGE_WINDOW : ACCEPTANCE_WINDOW;
}

function rowKey_(parts: string[]): string {
  return parts.filter(Boolean).join(":");
}

function dedupeRows_<T extends { seller_id: string; kind: string; row_key: string }>(
  rows: T[],
): T[] {
  const out = new Map<string, T>();
  for (const row of rows) out.set(`${row.seller_id}:${row.kind}:${row.row_key}`, row);
  return [...out.values()];
}

function taskIdOf(data: unknown): string | null {
  const block = unwrapRecord(data);
  if (!block) return null;
  return asText(block.taskId);
}

function taskStatusOf(data: unknown): string | null {
  const block = unwrapRecord(data);
  if (!block) return null;
  return asText(block.status);
}

function reportList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const block = unwrapRecord(data);
  if (block && Array.isArray(block.reports)) return block.reports as Record<string, unknown>[];
  return [];
}

function pathsFor(kind: ServiceKind) {
  const base = kind === "paid_storage" ? "/api/v1/paid_storage" : "/api/v1/acceptance_report";
  return {
    create: base,
    status: (taskId: string) => `${base}/tasks/${taskId}/status`,
    download: (taskId: string) => `${base}/tasks/${taskId}/download`,
  };
}

function mapPaidStorage(sellerId: string, o: Record<string, unknown>) {
  const nm = asText(o.nmId) ?? "";
  const dt = asText(o.date) ?? asText(o.originalDate);
  const known = [
    "date", "logWarehouseCoef", "officeId", "warehouse", "warehouseCoef", "giId", "chrtId", "size",
    "barcode", "subject", "brand", "vendorCode", "nmId", "volume", "calcType", "warehousePrice",
    "barcodesCount", "palletPlaceCode", "palletCount", "originalDate", "loyaltyDiscount",
    "tariffFixDate", "tariffLowerDate",
  ];
  return {
    seller_id: sellerId,
    kind: "paid_storage",
    row_key: rowKey_([
      "paid_storage",
      dt,
      nm,
      asText(o.chrtId),
      asText(o.warehouse),
      asText(o.giId),
      asText(o.barcode),
      asText(o.calcType),
      asText(o.palletPlaceCode),
      asText(o.warehousePrice),
    ]),
    service_dt: asTs(dt),
    nm_id: nm,
    subject_name: asText(o.subject),
    warehouse_name: asText(o.warehouse),
    amount: asNum(o.warehousePrice),
    quantity: asNum(o.barcodesCount),
    income_id: asText(o.giId),
    supplier_article: asText(o.vendorCode),
    barcode: asText(o.barcode),
    description: asText(o.calcType),
    extra: extraOf(o, known),
    payload: o,
  };
}

function mapAcceptance(sellerId: string, o: Record<string, unknown>) {
  const nm = asText(o.nmID) ?? asText(o.nmId) ?? "";
  const dt = asText(o.shkCreateDate) ?? asText(o.giCreateDate);
  const known = [
    "count", "giCreateDate", "incomeId", "nmID", "nmId", "shkCreateDate", "subjectName", "total",
  ];
  return {
    seller_id: sellerId,
    kind: "acceptance",
    row_key: rowKey_([
      "acceptance",
      asText(o.incomeId),
      nm,
      dt,
      asText(o.count),
    ]),
    service_dt: asTs(dt),
    nm_id: nm,
    subject_name: asText(o.subjectName),
    warehouse_name: null,
    amount: asNum(o.total),
    quantity: asNum(o.count),
    income_id: asText(o.incomeId),
    supplier_article: null,
    barcode: null,
    description: "Платная приёмка",
    extra: extraOf(o, known),
    payload: o,
  };
}

async function historyStart_(db: Db, ctx: LoaderContext): Promise<string> {
  const from = await fboHistoryStart_(db, ctx.seller.id, String(ctx.seller.history_from || "2023-08-01"));
  if (from < "2023-08-01") return "2023-08-01";
  return from;
}

async function dailyServicesFrom_(
  db: Db,
  sellerId: string,
  kind: ServiceKind,
  defaultFrom: string,
): Promise<string> {
  const { data } = await db
    .from("warehouse_services")
    .select("service_dt")
    .eq("seller_id", sellerId)
    .eq("kind", kind)
    .order("service_dt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.service_dt) return defaultFrom;
  const maxDt = moscowYmdFromIso(String(data.service_dt));
  return maxYmd(defaultFrom, addDays(maxDt, -DAILY_OVERLAP_DAYS));
}

async function createTask(
  token: string,
  kind: ServiceKind,
  dateFrom: string,
  dateTo: string,
): Promise<{ taskId?: string; retry?: boolean; error?: string }> {
  const paths = pathsFor(kind);
  const qs = new URLSearchParams({ dateFrom, dateTo });
  const res = await wbFetch(token, "GET", `${HOST}${paths.create}?${qs}`);
  if (res.retry) return { retry: true };
  if (res.status !== 200) {
    return { error: `${kind} create ${res.status} ${res.text.slice(0, 200)}` };
  }
  const taskId = taskIdOf(res.data);
  if (!taskId) return { error: `${kind} create: no taskId` };
  return { taskId };
}

async function pollTask(
  token: string,
  kind: ServiceKind,
  taskId: string,
): Promise<{ status?: string; retry?: boolean; error?: string }> {
  const paths = pathsFor(kind);
  const res = await wbFetch(token, "GET", `${HOST}${paths.status(taskId)}`);
  if (res.retry) return { retry: true };
  if (res.status !== 200) {
    return { error: `${kind} status ${res.status} ${res.text.slice(0, 200)}` };
  }
  const status = taskStatusOf(res.data);
  if (!status) return { error: `${kind} status: empty` };
  return { status };
}

async function downloadTask(
  token: string,
  kind: ServiceKind,
  taskId: string,
): Promise<{ items: Record<string, unknown>[]; retry?: boolean; error?: string }> {
  const paths = pathsFor(kind);
  const res = await wbFetch(token, "GET", `${HOST}${paths.download(taskId)}`);
  if (res.retry) return { items: [], retry: true };
  if (res.status === 204) return { items: [] };
  if (res.status !== 200) {
    return { items: [], error: `${kind} download ${res.status} ${res.text.slice(0, 200)}` };
  }
  const items = reportList(res.data);
  return { items };
}

export async function loadWarehouseServices(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const hardEnd = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  const kind = String(ctx.cursor.kind ?? "paid_storage") as ServiceKind;
  const taskId = asText(ctx.cursor.taskId);
  const defaultFrom = ctx.mode === "daily"
    ? dailyFrom(ctx.yesterday, kind === "paid_storage" ? DAILY_STORAGE_DAYS : DAILY_ACCEPTANCE_DAYS)
    : await historyStart_(db, ctx);
  const dateFrom = String(
    ctx.cursor.dateFrom ?? (
      ctx.mode === "daily"
        ? await dailyServicesFrom_(db, ctx.seller.id, kind, defaultFrom)
        : defaultFrom
    ),
  );
  const win = windowDays(kind);
  const dateTo = String(ctx.cursor.dateTo ?? minYmd(addDays(dateFrom, win - 1), hardEnd));
  const cursorBase = { kind, dateFrom, dateTo, taskId };

  if (dateFrom > hardEnd) {
    const next = nextKind(kind);
    if (!next) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };
    const restartDefault = ctx.mode === "daily"
      ? dailyFrom(ctx.yesterday, windowDays(next) === STORAGE_WINDOW ? DAILY_STORAGE_DAYS : DAILY_ACCEPTANCE_DAYS)
      : await historyStart_(db, ctx);
    const restartFrom = ctx.mode === "daily"
      ? await dailyServicesFrom_(db, ctx.seller.id, next, restartDefault)
      : restartDefault;
    return { done: false, cursor: { kind: next, dateFrom: restartFrom }, rowsIn: 0, rowsUpserted: 0 };
  }

  if (!taskId) {
    const created = await createTask(ctx.token, kind, dateFrom, dateTo);
    if (created.retry) {
      return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (created.error) {
      return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, error: created.error };
    }
    return {
      done: false,
      cursor: { kind, dateFrom, dateTo, taskId: created.taskId },
      rowsIn: 0,
      rowsUpserted: 0,
      note: `${kind} task created`,
    };
  }

  const polled = await pollTask(ctx.token, kind, taskId);
  if (polled.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (polled.error) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, error: polled.error };
  }
  let status = polled.status ?? "";
  for (let i = 1; i < MAX_POLLS_PER_TICK && (status === "new" || status === "processing"); i++) {
    const again = await pollTask(ctx.token, kind, taskId);
    if (again.retry) {
      return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
    }
    if (again.error) {
      return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, error: again.error };
    }
    status = again.status ?? "";
  }
  if (status === "new" || status === "processing") {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      retry: true,
      note: `${kind} ${status}`,
    };
  }
  if (status === "canceled" || status === "purged") {
    const nextFrom = addDays(dateTo, 1);
    if (nextFrom <= hardEnd) {
      return {
        done: false,
        cursor: { kind, dateFrom: nextFrom },
        rowsIn: 0,
        rowsUpserted: 0,
        note: `${kind} task ${status}, skip window`,
      };
    }
    const next = nextKind(kind);
    if (!next) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };
    const restartDefault = ctx.mode === "daily"
      ? dailyFrom(ctx.yesterday, windowDays(next) === STORAGE_WINDOW ? DAILY_STORAGE_DAYS : DAILY_ACCEPTANCE_DAYS)
      : await historyStart_(db, ctx);
    const restartFrom = ctx.mode === "daily"
      ? await dailyServicesFrom_(db, ctx.seller.id, next, restartDefault)
      : restartDefault;
    return { done: false, cursor: { kind: next, dateFrom: restartFrom }, rowsIn: 0, rowsUpserted: 0 };
  }
  if (status !== "done") {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: `${kind} unknown status ${status}`,
    };
  }

  const pack = await downloadTask(ctx.token, kind, taskId);
  if (pack.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (pack.error) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, error: pack.error };
  }

  const rows = dedupeRows_(pack.items.map((o) => (
    kind === "paid_storage" ? mapPaidStorage(ctx.seller.id, o) : mapAcceptance(ctx.seller.id, o)
  )).filter((r) => r.row_key));
  const n = rows.length
    ? await upsertRows(db, "warehouse_services", rows, "seller_id,kind,row_key")
    : 0;

  const nextFrom = addDays(dateTo, 1);
  if (nextFrom <= hardEnd) {
    return {
      done: false,
      cursor: { kind, dateFrom: nextFrom },
      rowsIn: rows.length,
      rowsUpserted: n,
      note: `${kind} window done`,
    };
  }

  const next = nextKind(kind);
  if (!next) {
    return { done: true, cursor: {}, rowsIn: rows.length, rowsUpserted: n };
  }
  const restartDefault = ctx.mode === "daily"
    ? dailyFrom(ctx.yesterday, windowDays(next) === STORAGE_WINDOW ? DAILY_STORAGE_DAYS : DAILY_ACCEPTANCE_DAYS)
    : await historyStart_(db, ctx);
  const restartFrom = ctx.mode === "daily"
    ? await dailyServicesFrom_(db, ctx.seller.id, next, restartDefault)
    : restartDefault;
  return {
    done: false,
    cursor: { kind: next, dateFrom: restartFrom },
    rowsIn: rows.length,
    rowsUpserted: n,
    note: `warehouse_services -> ${next}`,
  };
}
