import { addDays, dailyFrom, minYmd } from "../dates.ts";
import { upsertRows, type Db } from "../db.ts";
import type { LoaderContext, LoaderResult } from "../types.ts";
import { asBool, asText, asTs, wbFetch } from "../wb.ts";
import {
  COMM_HOST,
  COMM_TAKE,
  type CommStage,
  dedupeRows_,
  extraFrom,
  mapAnswerFields,
  mapProductFields,
  productDetails,
  questionKnownKeys,
  unpackCommList,
  ymdUnix,
} from "./communications.ts";

const DAILY_DAYS = 14;
const WINDOW_DAYS = 90;

function nextStage(stage: CommStage): CommStage | null {
  return stage === "unanswered" ? "answered" : null;
}

function buildQuestionsUrl(
  stage: CommStage,
  skip: number,
  dateFrom: string,
  dateTo: string,
): string {
  const params = new URLSearchParams({
    isAnswered: String(stage === "answered"),
    take: String(COMM_TAKE),
    skip: String(skip),
    order: "dateDesc",
    dateFrom: String(ymdUnix(dateFrom)),
    dateTo: String(ymdUnix(dateTo, true)),
  });
  return `${COMM_HOST}/api/v1/questions?${params}`;
}

export async function loadQuestions(
  db: Db,
  ctx: LoaderContext,
): Promise<LoaderResult> {
  const hardEnd = ctx.mode === "daily" ? ctx.yesterday : ctx.today;
  const winFrom = String(
    ctx.cursor.dateFrom ?? (
      ctx.mode === "daily"
        ? dailyFrom(ctx.yesterday, DAILY_DAYS)
        : ctx.seller.history_from
    ),
  );
  if (winFrom > hardEnd) return { done: true, cursor: {}, rowsIn: 0, rowsUpserted: 0 };

  const winTo = String(ctx.cursor.dateTo ?? minYmd(addDays(winFrom, WINDOW_DAYS), hardEnd));
  const stage = String(ctx.cursor.stage ?? "unanswered") as CommStage;
  const skip = Number(ctx.cursor.skip ?? 0);
  const cursorBase = { dateFrom: winFrom, dateTo: winTo, stage, skip };

  const url = buildQuestionsUrl(stage, skip, winFrom, winTo);
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
      error: `questions ${res.status} ${res.text.slice(0, 300)}`,
    };
  }

  const items = unpackCommList(res.data, "questions");
  const known = questionKnownKeys();
  const rows = dedupeRows_(items.map((o) => {
    const pd = productDetails(o);
    const ans = mapAnswerFields(o);
    return {
      seller_id: ctx.seller.id,
      question_id: asText(o.id) ?? "",
      question_dt: asTs(o.createdDate),
      ...mapProductFields(pd),
      text: asText(o.text),
      state: asText(o.state),
      is_answered: ans.is_answered,
      answer_text: ans.answer_text,
      was_viewed: asBool(o.wasViewed),
      is_warned: asBool(o.isWarned),
      extra: extraFrom(o, known),
      payload: o,
    };
  }).filter((r) => r.question_id), (r) => `${r.seller_id}:${r.question_id}`);
  const n = await upsertRows(db, "questions", rows, "seller_id,question_id");

  if (items.length >= COMM_TAKE) {
    return {
      done: false,
      cursor: { ...cursorBase, skip: skip + items.length },
      rowsIn: items.length,
      rowsUpserted: n,
    };
  }

  const next = nextStage(stage);
  if (next) {
    return {
      done: false,
      cursor: { dateFrom: winFrom, dateTo: winTo, stage: next, skip: 0 },
      rowsIn: items.length,
      rowsUpserted: n,
    };
  }

  const nextFrom = addDays(winTo, 1);
  if (nextFrom > hardEnd) {
    return { done: true, cursor: {}, rowsIn: items.length, rowsUpserted: n };
  }
  return {
    done: false,
    cursor: { dateFrom: nextFrom, stage: "unanswered", skip: 0 },
    rowsIn: items.length,
    rowsUpserted: n,
  };
}
