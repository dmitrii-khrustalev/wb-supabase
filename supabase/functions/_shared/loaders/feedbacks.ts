import { dailyFrom } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asBool, asNum, asText, asTs, wbFetch } from "../wb.ts";
import {
  COMM_HOST,
  COMM_TAKE,
  type CommStage,
  dedupeRows_,
  extraFrom,
  feedbackKnownKeys,
  mapAnswerFields,
  mapProductFields,
  productDetails,
  unpackCommList,
  ymdUnix,
} from "./communications.ts";

const DAILY_DAYS = 14;

function nextStage(stage: CommStage, mode: "history" | "daily"): CommStage | null {
  if (stage === "unanswered") return "answered";
  if (stage === "answered") return mode === "history" ? "archive" : null;
  return null;
}

function buildFeedbacksUrl(
  stage: CommStage,
  skip: number,
  dateFrom: string | null,
  dateTo: string | null,
): string {
  if (stage === "archive") {
    return `${COMM_HOST}/api/v1/feedbacks/archive?take=${COMM_TAKE}&skip=${skip}`;
  }
  const params = new URLSearchParams({
    isAnswered: String(stage === "answered"),
    take: String(COMM_TAKE),
    skip: String(skip),
    order: "dateDesc",
  });
  if (dateFrom && dateTo) {
    params.set("dateFrom", String(ymdUnix(dateFrom)));
    params.set("dateTo", String(ymdUnix(dateTo, true)));
  }
  return `${COMM_HOST}/api/v1/feedbacks?${params}`;
}

export async function loadFeedbacks(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const stage = String(ctx.cursor.stage ?? "unanswered") as CommStage;
  const skip = Number(ctx.cursor.skip ?? 0);
  const dateFrom = ctx.mode === "daily"
    ? String(ctx.cursor.dateFrom ?? dailyFrom(ctx.yesterday, DAILY_DAYS))
    : null;
  const dateTo = ctx.mode === "daily"
    ? String(ctx.cursor.dateTo ?? ctx.yesterday)
    : null;
  const cursorBase = {
    stage,
    skip,
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };

  const url = buildFeedbacksUrl(stage, skip, dateFrom, dateTo);
  const res = await wbFetch(ctx.token, "GET", url);

  if (res.retry) {
    return { done: false, cursor: cursorBase, rowsIn: 0, rowsUpserted: 0, retry: true };
  }
  if (res.status !== 200) {
    return {
      done: false,
      cursor: cursorBase,
      rowsIn: 0,
      rowsUpserted: 0,
      error: `feedbacks ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const items = unpackCommList(res.data, "feedbacks");
  const known = feedbackKnownKeys();
  const rows = dedupeRows_(items.map((o) => {
    const pd = productDetails(o);
    const ans = mapAnswerFields(o);
    return {
      seller_id: ctx.seller.id,
      feedback_id: asText(o.id) ?? "",
      feedback_dt: asTs(o.createdDate),
      ...mapProductFields(pd),
      product_valuation: asNum(o.productValuation),
      text: asText(o.text),
      pros: asText(o.pros),
      cons: asText(o.cons),
      state: asText(o.state),
      is_answered: ans.is_answered,
      answer_text: ans.answer_text,
      user_name: asText(o.userName),
      order_status: asText(o.orderStatus),
      was_viewed: asBool(o.wasViewed),
      extra: extraFrom(o, known),
      payload: o,
    };
  }).filter((r) => r.feedback_id), (r) => `${r.seller_id}:${r.feedback_id}`);
  const n = await upsertRows(db, "feedbacks", rows, "seller_id,feedback_id");

  if (items.length >= COMM_TAKE) {
    return {
      done: false,
      cursor: { ...cursorBase, skip: skip + items.length },
      rowsIn: items.length,
      rowsUpserted: n,
    };
  }

  const next = nextStage(stage, ctx.mode);
  if (next) {
    return {
      done: false,
      cursor: {
        stage: next,
        skip: 0,
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
      },
      rowsIn: items.length,
      rowsUpserted: n,
    };
  }

  return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
}
