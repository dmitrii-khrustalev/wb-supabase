import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asNum, asText, extraOf, wbFetch } from "../wb.ts";

const HOST = "https://common-api.wildberries.ru";
const SUPPLIES_HOST = "https://supplies-api.wildberries.ru";

type TariffStage = "commission" | "box" | "pallet" | "return" | "acceptance";

const STAGES: TariffStage[] = ["commission", "box", "pallet", "return", "acceptance"];

function nextStage(stage: TariffStage): TariffStage | null {
  const i = STAGES.indexOf(stage);
  return i < 0 || i >= STAGES.length - 1 ? null : STAGES[i + 1];
}

function parseRate(v: unknown): number | null {
  const s = asText(v);
  if (!s) return asNum(v);
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function warehouseList(data: unknown, key = "warehouseList"): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const resp = root.response;
  if (resp && typeof resp === "object") {
    const block = (resp as Record<string, unknown>).data;
    if (block && typeof block === "object") {
      const list = (block as Record<string, unknown>)[key];
      if (Array.isArray(list)) return list as Record<string, unknown>[];
    }
  }
  return [];
}

function commissionList(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const list = root.report;
  return Array.isArray(list) ? list as Record<string, unknown>[] : [];
}

function acceptanceList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const root = data as Record<string, unknown>;
    if (Array.isArray(root.data)) return root.data as Record<string, unknown>[];
  }
  return [];
}

function rowKey_(parts: string[]): string {
  return parts.filter(Boolean).join(":");
}

function tariffFingerprint(row: Record<string, unknown>): string {
  return JSON.stringify({
    rate_value: row.rate_value ?? null,
    subject_name: row.subject_name ?? null,
    description: row.description ?? null,
    warehouse_name: row.warehouse_name ?? null,
    box_type: row.box_type ?? null,
    extra: row.extra ?? null,
    payload: row.payload ?? null,
  });
}

async function latestTariffFingerprints(
  db: Db,
  sellerId: string,
  kind: string,
  rowKeys: string[],
): Promise<Map<string, string>> {
  const keys = [...new Set(rowKeys.filter(Boolean))];
  if (!keys.length) return new Map();

  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 500) {
    const part = keys.slice(i, i + 500);
    const { data, error } = await db
      .from("tariffs")
      .select(
        "row_key, rate_value, subject_name, description, warehouse_name, box_type, extra, payload, tariff_dt",
      )
      .eq("seller_id", sellerId)
      .eq("kind", kind)
      .in("row_key", part)
      .order("tariff_dt", { ascending: false });
    if (error) throw new Error(`tariffs latest: ${error.message}`);
    for (const row of data ?? []) {
      const key = String(row.row_key ?? "");
      if (!key || out.has(key)) continue;
      out.set(key, tariffFingerprint(row as Record<string, unknown>));
    }
  }
  return out;
}

function filterChangedRows(
  rows: Record<string, unknown>[],
  latest: Map<string, string>,
): Record<string, unknown>[] {
  return rows.filter((row) => {
    const key = String(row.row_key ?? "");
    const fp = tariffFingerprint(row);
    const prev = latest.get(key);
    return prev === undefined || prev !== fp;
  });
}

async function loadCommission(
  sellerId: string,
  tariffDt: string,
  token: string,
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const res = await wbFetch(token, "GET", `${HOST}/api/v1/tariffs/commission?locale=ru`);
  if (res.status !== 200) {
    return { rows: [], error: `tariffs commission ${res.status} ${res.text.slice(0, 200)}` };
  }
  const known = [
    "kgvpBooking", "kgvpMarketplace", "kgvpPickup", "kgvpSupplier", "kgvpSupplierExpress",
    "paidStorageKgvp", "parentID", "parentName", "subjectID", "subjectName",
  ];
  const rows = commissionList(res.data).map((o) => {
    const subjectId = asText(o.subjectID) ?? asText(o.subjectId) ?? "";
    return {
      seller_id: sellerId,
      tariff_dt: tariffDt,
      kind: "commission",
      warehouse_name: "",
      box_type: "",
      row_key: rowKey_(["commission", subjectId]),
      subject_name: asText(o.subjectName),
      description: asText(o.parentName),
      rate_value: parseRate(o.paidStorageKgvp) ?? parseRate(o.kgvpMarketplace),
      extra: extraOf(o, known),
      payload: o,
    };
  }).filter((r) => r.row_key);
  return { rows };
}

async function loadWarehouseTariff(
  sellerId: string,
  tariffDt: string,
  token: string,
  kind: "box" | "pallet" | "return",
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const path = kind === "return"
    ? `${HOST}/api/v1/tariffs/return?date=${tariffDt}`
    : `${HOST}/api/v1/tariffs/${kind}?date=${tariffDt}`;
  const res = await wbFetch(token, "GET", path);
  if (res.status !== 200) {
    return { rows: [], error: `tariffs ${kind} ${res.status} ${res.text.slice(0, 200)}` };
  }
  const items = warehouseList(res.data);
  const rows = items.map((o) => {
    const wh = asText(o.warehouseName) ?? "";
    const rate = kind === "box"
      ? parseRate(o.boxDeliveryBase)
      : kind === "pallet"
      ? parseRate(o.palletDeliveryValueBase)
      : parseRate(o.deliveryDumpSupOfficeBase);
    return {
      seller_id: sellerId,
      tariff_dt: tariffDt,
      kind,
      warehouse_name: wh,
      box_type: kind === "box" ? "box" : kind === "pallet" ? "pallet" : "",
      row_key: rowKey_([kind, wh]),
      subject_name: null,
      description: asText(o.geoName),
      rate_value: rate,
      extra: extraOf(o, ["warehouseName", "geoName"]),
      payload: o,
    };
  }).filter((r) => r.row_key);
  return { rows };
}

async function loadAcceptance(
  sellerId: string,
  tariffDt: string,
  token: string,
): Promise<{ rows: Record<string, unknown>[]; error?: string; skipped?: boolean }> {
  const urls = [
    `${HOST}/api/tariffs/v1/acceptance/coefficients`,
    `${SUPPLIES_HOST}/api/v1/acceptance/coefficients`,
  ];
  let res = { status: 0, data: null as unknown, text: "" };
  for (const url of urls) {
    res = await wbFetch(token, "GET", url);
    if (res.status === 200) break;
    if (res.status === 404) continue;
    return { rows: [], error: `tariffs acceptance ${res.status} ${res.text.slice(0, 200)}` };
  }
  if (res.status !== 200) {
    return { rows: [], skipped: true };
  }
  const known = [
    "warehouseID", "warehouseId", "warehouseName", "date", "coefficient", "allowUnload",
    "boxTypeID", "boxTypeName", "deliveryCoef", "storageCoef",
  ];
  const rows = acceptanceList(res.data).map((o) => {
    const whId = asText(o.warehouseID) ?? asText(o.warehouseId) ?? "";
    const wh = asText(o.warehouseName) ?? "";
    const dt = asText(o.date)?.slice(0, 10) ?? tariffDt;
    const boxType = asText(o.boxTypeName) ?? asText(o.boxTypeID) ?? "";
    return {
      seller_id: sellerId,
      tariff_dt: dt,
      kind: "acceptance",
      warehouse_name: wh,
      box_type: boxType,
      row_key: rowKey_(["acceptance", whId, dt, boxType]),
      subject_name: null,
      description: wh,
      rate_value: parseRate(o.coefficient),
      extra: extraOf(o, known),
      payload: o,
    };
  }).filter((r) => r.row_key);
  return { rows };
}

async function loadTariffStage(
  db: Db,
  ctx: LoaderContext,
  stage: TariffStage,
  tariffDt: string,
): Promise<LoaderResult> {
  const cursorBase = { stage, tariffDt };

  let pack: { rows: Record<string, unknown>[]; error?: string; skipped?: boolean };
  if (stage === "commission") pack = await loadCommission(ctx.seller.id, tariffDt, ctx.token);
  else if (stage === "box") pack = await loadWarehouseTariff(ctx.seller.id, tariffDt, ctx.token, "box");
  else if (stage === "pallet") pack = await loadWarehouseTariff(ctx.seller.id, tariffDt, ctx.token, "pallet");
  else if (stage === "return") pack = await loadWarehouseTariff(ctx.seller.id, tariffDt, ctx.token, "return");
  else pack = await loadAcceptance(ctx.seller.id, tariffDt, ctx.token);

  if (pack.error) {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: pack.error,
    };
  }
  if (pack.skipped) {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      note: "acceptance unavailable (404)",
    };
  }

  const kind = String(pack.rows[0]?.kind ?? stage);
  const rowKeys = pack.rows.map((row) => String(row.row_key ?? ""));
  const latest = rowKeys.length
    ? await latestTariffFingerprints(db, ctx.seller.id, kind, rowKeys)
    : new Map<string, string>();
  const changed = filterChangedRows(pack.rows, latest);

  const n = changed.length
    ? await upsertRows(db, "tariffs", changed, "seller_id,tariff_dt,kind,row_key")
    : 0;

  const note = changed.length < pack.rows.length
    ? `tariffs ${stage} (${changed.length}/${pack.rows.length} changed)`
    : `tariffs ${stage}`;

  return {
    done: false,
    cursor: cursorBase,
    rowsIn: pack.rows.length,
    rowsUpserted: n,
    note,
  };
}

export async function loadTariffs(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const tariffDt = ctx.today;
  let stage = String(ctx.cursor.stage ?? "commission") as TariffStage;
  let rowsIn = 0;
  let rowsUpserted = 0;
  const notes: string[] = [];

  while (stage) {
    const step = await loadTariffStage(db, ctx, stage, tariffDt);
    rowsIn += step.rowsIn ?? 0;
    rowsUpserted += step.rowsUpserted ?? 0;
    if (step.note) notes.push(step.note);
    if (step.error) {
      return {
        done: false,
        cursor: step.cursor ?? { stage, tariffDt },
        rowsIn,
        rowsUpserted,
        error: step.error,
        note: notes.join("; "),
      };
    }

    const next = nextStage(stage);
    if (!next) {
      return {
        done: true,
        cursor: {},
        rowsIn,
        rowsUpserted,
        note: notes.join("; ") || "tariffs done",
      };
    }
    stage = next;
  }

  return { done: true, cursor: {}, rowsIn, rowsUpserted, note: notes.join("; ") || "tariffs done" };
}
