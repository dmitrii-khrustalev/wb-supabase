import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asNum, asText, asTs, extraOf, wbFetch } from "../wb.ts";

const HOST = "https://returns-api.wildberries.ru";
const LIMIT = 200;

type ClaimStage = "active" | "archive";

function nextStage(stage: ClaimStage): ClaimStage | null {
  return stage === "active" ? "archive" : null;
}

function unpackClaims(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const list = root.claims;
  return Array.isArray(list) ? list as Record<string, unknown>[] : [];
}

function claimTotal(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const n = Number((data as Record<string, unknown>).total);
  return Number.isFinite(n) ? n : null;
}

function mapClaim(sellerId: string, o: Record<string, unknown>, isArchive: boolean) {
  const known = [
    "id", "claim_type", "status", "status_ex", "nm_id", "user_comment", "wb_comment", "dt",
    "imt_name", "order_dt", "dt_update", "photos", "video_paths", "actions", "price",
    "currency_code", "srid", "origin_id_info", "delivery_dt",
  ];
  return {
    seller_id: sellerId,
    claim_id: asText(o.id) ?? "",
    claim_dt: asTs(o.dt),
    claim_updated_dt: asTs(o.dt_update),
    order_dt: asTs(o.order_dt),
    delivery_dt: asTs(o.delivery_dt),
    nm_id: asText(o.nm_id),
    claim_type: asNum(o.claim_type),
    status: asNum(o.status),
    status_ex: asNum(o.status_ex),
    product_name: asText(o.imt_name),
    user_comment: asText(o.user_comment),
    wb_comment: asText(o.wb_comment),
    price: asNum(o.price),
    currency_code: asText(o.currency_code),
    srid: asText(o.srid),
    is_archive: isArchive,
    extra: extraOf(o, known),
    payload: o,
  };
}

export async function loadClaims(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const stage = String(ctx.cursor.stage ?? "active") as ClaimStage;
  const offset = Number(ctx.cursor.offset ?? 0);
  const isArchive = stage === "archive";
  const cursorBase = { stage, offset };

  const params = new URLSearchParams({
    is_archive: String(isArchive),
    limit: String(LIMIT),
    offset: String(offset),
  });
  const res = await wbFetch(ctx.token, "GET", `${HOST}/api/v1/claims?${params}`);

  if (res.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (res.status !== 200) {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: `claims ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const items = unpackClaims(res.data);
  const rows = items.map((o) => mapClaim(ctx.seller.id, o, isArchive))
    .filter((r) => r.claim_id);
  const n = rows.length
    ? await upsertRows(db, "claims", rows, "seller_id,claim_id")
    : 0;

  const total = claimTotal(res.data);
  const nextOffset = offset + items.length;
  if (items.length >= LIMIT && (total === null || nextOffset < total)) {
    return {
      done: false,
      cursor: { stage, offset: nextOffset },
      rowsIn: items.length,
      rowsUpserted: n,
    };
  }

  const next = nextStage(stage);
  if (next) {
    return {
      done: false,
      cursor: { stage: next, offset: 0 },
      rowsIn: items.length,
      rowsUpserted: n,
    };
  }

  return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
}
