import { asText, extraOf } from "../wb.ts";

export const COMM_HOST = "https://feedbacks-api.wildberries.ru";
export const COMM_TAKE = 1000;

export type CommStage = "unanswered" | "answered" | "archive";

export function ymdUnix(ymd: string, endOfDay = false): number {
  const iso = endOfDay ? `${ymd}T23:59:59+03:00` : `${ymd}T00:00:00+03:00`;
  return Math.floor(new Date(iso).getTime() / 1000);
}

export function unpackCommList(
  data: unknown,
  listKey: "feedbacks" | "questions",
): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  if (root.error === true) return [];
  const block = (root.data && typeof root.data === "object"
    ? root.data
    : root) as Record<string, unknown>;
  const list = block[listKey];
  return Array.isArray(list) ? list as Record<string, unknown>[] : [];
}

export function productDetails(o: Record<string, unknown>): Record<string, unknown> {
  const pd = o.productDetails;
  return pd && typeof pd === "object" ? pd as Record<string, unknown> : {};
}

export function answerOf(o: Record<string, unknown>): Record<string, unknown> | null {
  const a = o.answer;
  return a && typeof a === "object" ? a as Record<string, unknown> : null;
}

export function dedupeRows_<T extends { seller_id: string }>(
  rows: T[],
  keyFn: (r: T) => string,
): T[] {
  const out = new Map<string, T>();
  for (const row of rows) out.set(keyFn(row), row);
  return [...out.values()];
}

export function feedbackKnownKeys(): string[] {
  return [
    "id", "text", "pros", "cons", "productValuation", "createdDate", "answer", "state",
    "productDetails", "userName", "orderStatus", "wasViewed",
    "isAbleSupplierFeedbackValuation", "isAbleSupplierProductValuation",
    "returnProductOrdersDate", "lastOrderShkId", "lastOrderCreatedAt", "color", "subjectId",
  ];
}

export function questionKnownKeys(): string[] {
  return [
    "id", "text", "createdDate", "state", "answer", "productDetails", "wasViewed", "isWarned",
  ];
}

export function mapProductFields(pd: Record<string, unknown>) {
  return {
    nm_id: asText(pd.nmId),
    supplier_article: asText(pd.supplierArticle),
    product_name: asText(pd.productName),
    brand_name: asText(pd.brandName),
  };
}

export function mapAnswerFields(o: Record<string, unknown>) {
  const ans = answerOf(o);
  return {
    is_answered: ans !== null,
    answer_text: ans ? asText(ans.text) : null,
  };
}

export function extraFrom(o: Record<string, unknown>, known: string[]): Record<string, unknown> {
  const ans = answerOf(o);
  const extra = extraOf(o, known);
  if (ans) {
    for (const [k, v] of Object.entries(ans)) {
      if (!known.includes(k) && k !== "text") extra[`answer_${k}`] = v;
    }
  }
  return extra;
}
