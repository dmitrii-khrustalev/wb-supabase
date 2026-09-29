import { addDays, dailyFrom, maxYmd, minYmd, moscowDayStartIso, moscowYmdFromIso } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { fboHistoryStart_ } from "./fbo.ts";
import { asNum, asText, asTs, extraOf, extractList, wbFetch } from "../wb.ts";

const HOST = "https://seller-analytics-api.wildberries.ru";
const WINDOW_DAYS = 30;
const DAILY_DAYS = 31;
const DAILY_EMPTY_DAYS = 7; // этап без строк в базе — только недавние дни
const DAILY_OVERLAP_DAYS = 3; // этап с данными — догон с небольшим перекрытием
const MAX_EMPTY_STAGES_PER_TICK = 4; // daily: несколько пустых этапов за один тик
const PAGE_LIMIT = 1000;

type RetentionStage = "measurement" | "substitution" | "labeling" | "excise" | "antifraud";

const STAGES: RetentionStage[] = [
  "measurement",
  "substitution",
  "labeling",
  "excise",
  "antifraud",
];

function nextStage(stage: RetentionStage): RetentionStage | null {
  const i = STAGES.indexOf(stage);
  return i < 0 || i >= STAGES.length - 1 ? null : STAGES[i + 1];
}

function rowKey_(parts: string[]): string {
  return parts.filter(Boolean).join(":");
}

function pagedReports(data: unknown): { items: Record<string, unknown>[]; total: number } {
  if (!data || typeof data !== "object") return { items: [], total: 0 };
  const root = data as Record<string, unknown>;
  const block = root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : root;
  const list = block.reports;
  const items = Array.isArray(list) ? list as Record<string, unknown>[] : [];
  const total = Number(block.total ?? items.length);
  return { items, total };
}

function exciseList(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const resp = root.response;
  if (resp && typeof resp === "object") {
    const block = (resp as Record<string, unknown>).data;
    if (Array.isArray(block)) return block as Record<string, unknown>[];
  }
  return extractList(data, "data");
}

function isoRangeFrom_(dateFrom: string, dateTo: string): { from: string; to: string } {
  return {
    from: moscowDayStartIso(dateFrom),
    to: `${dateTo}T23:59:59+03:00`,
  };
}

function mapMeasurement(sellerId: string, o: Record<string, unknown>) {
  const nm = asText(o.nmId) ?? "";
  const dimId = asText(o.dimId) ?? "";
  const known = [
    "nmId", "subjectName", "dimId", "prcOver", "volume", "width", "length", "height",
    "volumeSup", "widthSup", "lengthSup", "heightSup", "photoUrls", "dtBonus",
    "isValid", "isValidDt", "reversalAmount", "penaltyAmount",
  ];
  return {
    seller_id: sellerId,
    retention_dt: asTs(o.dtBonus),
    kind: "measurement",
    row_key: rowKey_(["measurement", dimId || nm, asText(o.dtBonus)]),
    nm_id: nm,
    subject_name: asText(o.subjectName),
    description: asText(o.subjectName),
    amount: asNum(o.penaltyAmount),
    supplier_article: null,
    barcode: null,
    shk_id: null,
    income_id: null,
    extra: extraOf(o, known),
    payload: o,
  };
}

function mapSubstitution(sellerId: string, o: Record<string, unknown>) {
  const nm = asText(o.nmId) ?? "";
  const known = [
    "dtBonus", "nmId", "oldShkId", "oldColor", "oldSize", "oldSku", "oldVendorCode",
    "newShkId", "newColor", "newSize", "newSku", "newVendorCode", "bonusSumm",
    "bonusType", "photoUrls",
  ];
  return {
    seller_id: sellerId,
    retention_dt: asTs(o.dtBonus),
    kind: "substitution",
    row_key: rowKey_([
      "substitution",
      nm,
      asText(o.dtBonus),
      asText(o.oldShkId),
      asText(o.newShkId),
    ]),
    nm_id: nm,
    subject_name: null,
    description: asText(o.bonusType),
    amount: asNum(o.bonusSumm),
    supplier_article: asText(o.oldVendorCode),
    barcode: asText(o.oldSku) ?? asText(o.newSku),
    shk_id: asText(o.oldShkId) ?? asText(o.newShkId),
    income_id: null,
    extra: extraOf(o, known),
    payload: o,
  };
}

function mapLabeling(sellerId: string, o: Record<string, unknown>) {
  const nm = asText(o.nmID) ?? asText(o.nmId) ?? "";
  const known = ["amount", "date", "incomeId", "nmID", "nmId", "photoUrls", "shkID", "shkId", "sku"];
  return {
    seller_id: sellerId,
    retention_dt: asTs(o.date),
    kind: "labeling",
    row_key: rowKey_([
      "labeling",
      nm,
      asText(o.shkID) ?? asText(o.shkId),
      asText(o.date),
      asText(o.incomeId),
    ]),
    nm_id: nm,
    subject_name: null,
    description: "Маркировка",
    amount: asNum(o.amount),
    supplier_article: null,
    barcode: asText(o.sku),
    shk_id: asText(o.shkID) ?? asText(o.shkId),
    income_id: asText(o.incomeId),
    extra: extraOf(o, known),
    payload: o,
  };
}

function mapExcise(sellerId: string, o: Record<string, unknown>) {
  const nm = asText(o.nm_id) ?? asText(o.nmId) ?? asText(o.nmID) ?? "";
  const known = [
    "name", "price", "currency_name_short", "excise_short", "barcode", "nm_id", "nmId",
    "operation_type_id", "fiscal_doc_number", "fiscal_dt", "fiscal_drive_number", "rid", "srid",
  ];
  return {
    seller_id: sellerId,
    retention_dt: asTs(o.fiscal_dt),
    kind: "excise",
    row_key: rowKey_(["excise", asText(o.srid) ?? asText(o.rid), asText(o.fiscal_dt), nm]),
    nm_id: nm,
    subject_name: asText(o.name),
    description: asText(o.name),
    amount: asNum(o.price),
    supplier_article: null,
    barcode: asText(o.barcode),
    shk_id: null,
    income_id: null,
    extra: extraOf(o, known),
    payload: o,
  };
}

function mapAntifraud(sellerId: string, o: Record<string, unknown>) {
  const nm = asText(o.nmID) ?? asText(o.nmId) ?? "";
  const known = ["nmID", "nmId", "sum", "currency", "dateFrom", "dateTo"];
  return {
    seller_id: sellerId,
    retention_dt: asTs(o.dateFrom) ?? asTs(o.dateTo),
    kind: "antifraud",
    row_key: rowKey_(["antifraud", nm, asText(o.dateFrom), asText(o.dateTo)]),
    nm_id: nm,
    subject_name: null,
    description: "Самовыкуп",
    amount: asNum(o.sum),
    supplier_article: null,
    barcode: null,
    shk_id: null,
    income_id: null,
    extra: extraOf(o, known),
    payload: o,
  };
}

async function historyStart_(db: Db, ctx: LoaderContext): Promise<string> {
  const from = await fboHistoryStart_(db, ctx.seller.id, String(ctx.seller.history_from || "2023-08-01"));
  if (from < "2023-08-01") return "2023-08-01";
  return from;
}

async function dailyStageStart_(
  db: Db,
  sellerId: string,
  kind: string,
  defaultFrom: string,
  yesterday: string,
): Promise<string> {
  const { data } = await db
    .from("wb_retentions")
    .select("retention_dt")
    .eq("seller_id", sellerId)
    .eq("kind", kind)
    .order("retention_dt", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data?.retention_dt) {
    return maxYmd(defaultFrom, dailyFrom(yesterday, DAILY_EMPTY_DAYS));
  }
  const maxDt = moscowYmdFromIso(String(data.retention_dt));
  return maxYmd(defaultFrom, addDays(maxDt, -DAILY_OVERLAP_DAYS));
}

async function loadMeasurement(
  sellerId: string,
  token: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
): Promise<{ rows: Record<string, unknown>[]; total: number; error?: string }> {
  const range = isoRangeFrom_(dateFrom, dateTo);
  const qs = new URLSearchParams({
    dateFrom: range.from,
    dateTo: range.to,
    limit: String(PAGE_LIMIT),
    offset: String(offset),
  });
  const res = await wbFetch(token, "GET", `${HOST}/api/analytics/v1/measurement-penalties?${qs}`);
  if (res.status !== 200) {
    return { rows: [], total: 0, error: `measurement ${res.status} ${res.text.slice(0, 200)}` };
  }
  const pack = pagedReports(res.data);
  return {
    rows: pack.items.map((o) => mapMeasurement(sellerId, o)).filter((r) => r.row_key),
    total: pack.total,
  };
}

async function loadSubstitution(
  sellerId: string,
  token: string,
  dateFrom: string,
  dateTo: string,
  offset: number,
): Promise<{ rows: Record<string, unknown>[]; total: number; error?: string }> {
  const range = isoRangeFrom_(dateFrom, dateTo);
  const qs = new URLSearchParams({
    dateFrom: range.from,
    dateTo: range.to,
    limit: String(PAGE_LIMIT),
    offset: String(offset),
  });
  const res = await wbFetch(token, "GET", `${HOST}/api/analytics/v1/deductions?${qs}`);
  if (res.status !== 200) {
    return { rows: [], total: 0, error: `substitution ${res.status} ${res.text.slice(0, 200)}` };
  }
  const pack = pagedReports(res.data);
  return {
    rows: pack.items.map((o) => mapSubstitution(sellerId, o)).filter((r) => r.row_key),
    total: pack.total,
  };
}

async function loadLabeling(
  sellerId: string,
  token: string,
  dateFrom: string,
  dateTo: string,
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const url = `${HOST}/api/v1/analytics/goods-labeling?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await wbFetch(token, "GET", url);
  if (res.status === 204) return { rows: [] };
  if (res.status !== 200) {
    return { rows: [], error: `labeling ${res.status} ${res.text.slice(0, 200)}` };
  }
  const items = extractList(res.data, "report");
  return {
    rows: items.map((o) => mapLabeling(sellerId, o)).filter((r) => r.row_key),
  };
}

async function loadExcise(
  sellerId: string,
  token: string,
  dateFrom: string,
  dateTo: string,
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const url = `${HOST}/api/v1/analytics/excise-report?dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await wbFetch(token, "POST", url, {});
  if (res.status === 204) return { rows: [] };
  if (res.status !== 200) {
    return { rows: [], error: `excise ${res.status} ${res.text.slice(0, 200)}` };
  }
  const items = exciseList(res.data);
  return {
    rows: items.map((o) => mapExcise(sellerId, o)).filter((r) => r.row_key),
  };
}

async function loadAntifraud(
  sellerId: string,
  token: string,
  date: string | null,
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const url = date
    ? `${HOST}/api/v1/analytics/antifraud-details?date=${date}`
    : `${HOST}/api/v1/analytics/antifraud-details`;
  const res = await wbFetch(token, "GET", url);
  if (res.status === 204) return { rows: [] };
  if (res.status !== 200) {
    return { rows: [], error: `antifraud ${res.status} ${res.text.slice(0, 200)}` };
  }
  const items = extractList(res.data, "details");
  return {
    rows: items.map((o) => mapAntifraud(sellerId, o)).filter((r) => r.row_key),
  };
}

export async function loadWbRetentions(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const hardEnd = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  let stage = String(ctx.cursor.stage ?? "measurement") as RetentionStage;
  let offset = Number(ctx.cursor.offset ?? 0);
  const defaultFrom = ctx.mode === "daily"
    ? dailyFrom(ctx.yesterday, DAILY_DAYS)
    : await historyStart_(db, ctx);
  let dateFrom = String(
    ctx.cursor.dateFrom ?? (
      ctx.mode === "daily" && stage !== "antifraud"
        ? await dailyStageStart_(db, ctx.seller.id, stage, defaultFrom, ctx.yesterday)
        : defaultFrom
    ),
  );
  let dateTo = String(ctx.cursor.dateTo ?? minYmd(addDays(dateFrom, WINDOW_DAYS - 1), hardEnd));
  let rowsIn = 0;
  let rowsUpserted = 0;
  let emptyStagesBundled = 0;
  const bundleEmpty = ctx.mode === "daily";

  async function restartStage(next: RetentionStage): Promise<void> {
    const restartDefault = ctx.mode === "daily"
      ? dailyFrom(ctx.yesterday, DAILY_DAYS)
      : await historyStart_(db, ctx);
    stage = next;
    offset = 0;
    dateFrom = ctx.mode === "daily"
      ? await dailyStageStart_(db, ctx.seller.id, next, restartDefault, ctx.yesterday)
      : restartDefault;
    dateTo = minYmd(addDays(dateFrom, WINDOW_DAYS - 1), hardEnd);
  }

  while (true) {
    const cursorBase = { stage, dateFrom, dateTo, offset };

    if (stage === "antifraud") {
      const date = ctx.mode === "daily" ? ctx.yesterday : null;
      const pack = await loadAntifraud(ctx.seller.id, ctx.token, date);
      if (pack.error) {
        return { done: false, cursor: cursorBase, rowsIn, rowsUpserted, error: pack.error };
      }
      const n = pack.rows.length
        ? await upsertRows(db, "wb_retentions", pack.rows, "seller_id,kind,row_key")
        : 0;
      return {
        done: true,
        cursor: {},
        rowsIn: rowsIn + pack.rows.length,
        rowsUpserted: rowsUpserted + n,
      };
    }

    if (dateFrom > hardEnd) {
      const next = nextStage(stage);
      if (!next) {
        return { done: true, cursor: {}, rowsIn, rowsUpserted };
      }
      await restartStage(next);
      if (bundleEmpty && ++emptyStagesBundled < MAX_EMPTY_STAGES_PER_TICK) continue;
      return { done: false, cursor: { stage, dateFrom, offset: 0 }, rowsIn, rowsUpserted };
    }

    let pack: { rows: Record<string, unknown>[]; total?: number; error?: string };
    if (stage === "measurement") {
      pack = await loadMeasurement(ctx.seller.id, ctx.token, dateFrom, dateTo, offset);
    } else if (stage === "substitution") {
      pack = await loadSubstitution(ctx.seller.id, ctx.token, dateFrom, dateTo, offset);
    } else if (stage === "labeling") {
      pack = await loadLabeling(ctx.seller.id, ctx.token, dateFrom, dateTo);
      pack.total = pack.rows.length;
    } else {
      pack = await loadExcise(ctx.seller.id, ctx.token, dateFrom, dateTo);
      pack.total = pack.rows.length;
    }

    if (pack.error?.includes("429") || pack.error?.includes("503")) {
      return { done: false, cursor: cursorBase, rowsIn, rowsUpserted, retry: true };
    }

    if (pack.error) {
      return { done: false, cursor: cursorBase, rowsIn, rowsUpserted, error: pack.error };
    }

    const n = pack.rows.length
      ? await upsertRows(db, "wb_retentions", pack.rows, "seller_id,kind,row_key")
      : 0;
    rowsIn += pack.rows.length;
    rowsUpserted += n;

    const total = pack.total ?? pack.rows.length;
    const nextOffset = offset + pack.rows.length;
    if (stage === "measurement" || stage === "substitution") {
      if (nextOffset < total) {
        return {
          done: false,
          cursor: { stage, dateFrom, dateTo, offset: nextOffset },
          rowsIn,
          rowsUpserted,
        };
      }
    }

    const nextFrom = addDays(dateTo, 1);
    if (nextFrom <= hardEnd) {
      dateFrom = nextFrom;
      offset = 0;
      dateTo = minYmd(addDays(dateFrom, WINDOW_DAYS - 1), hardEnd);
      return {
        done: false,
        cursor: { stage, dateFrom, dateTo, offset: 0 },
        rowsIn,
        rowsUpserted,
      };
    }

    const next = nextStage(stage);
    if (!next) {
      return { done: true, cursor: {}, rowsIn, rowsUpserted };
    }
    await restartStage(next);
    if (bundleEmpty && pack.rows.length === 0 && ++emptyStagesBundled < MAX_EMPTY_STAGES_PER_TICK) {
      continue;
    }
    return {
      done: false,
      cursor: { stage, dateFrom, offset: 0 },
      rowsIn,
      rowsUpserted,
      note: `retentions ${stage}`,
    };
  }
}
