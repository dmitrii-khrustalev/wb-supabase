import type { Db } from "./db.ts";
import { moscowYmd } from "./dates.ts";
import {
  buildInfoText,
  DATASET_LABELS,
  datasetLabel,
  MARK_BAD,
  MARK_OK,
  MARK_WAIT,
} from "./digest.ts";
import { bottomKeyboard, sendTelegram, type InlineKeyboard } from "./telegram.ts";

export type HealthRow = {
  slug: string;
  dataset: string;
  job_status: string | null;
  job_error: string | null;
  job_updated_at: string | null;
  last_success_at: string | null;
  data_date: string | null;
  expected_date: string | null;
  fresh: boolean | null;
  note: string | null;
};

export type ControlResult = {
  text: string;
  markup?: InlineKeyboard;
  edit?: boolean;
};

export const DAILY_DATASETS = Object.keys(DATASET_LABELS);

export const REPLY_ACTIONS: Record<string, string> = {
  Цифры: "inf",
  "Обновить всё": "dly",
  "Один блок": "ds",
  Отменить: "cnl",
  Обновить: "dly",
  Проверить: "chk",
  "Отменить всё": "cnl",
  Кусок: "ds",
  "Повторить ошибки": "rty",
  Меню: "mnu",
};

export const MENU_TEXT = [
  "Кнопки внизу: Цифры, Обновить всё, Один блок, Отменить.",
  "",
  "Цифры — вчера, как утром",
  "Обновить всё — база, потом загрузите в Google",
  "Один блок — например только остатки",
  "Отменить — очередь",
].join("\n");

function btn(text: string, data: string) {
  return { text, callback_data: data };
}

export function menuKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [btn("Цифры", "inf"), btn("Обновить всё", "dly")],
      [btn("Один блок", "ds"), btn("Отменить", "cnl")],
    ],
  };
}

export function datasetsKeyboard(): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < DAILY_DATASETS.length; i += 2) {
    const a = DAILY_DATASETS[i];
    const b = DAILY_DATASETS[i + 1];
    const row = [btn(datasetLabel(a), `ld:${a}`)];
    if (b) row.push(btn(datasetLabel(b), `ld:${b}`));
    rows.push(row);
  }
  rows.push([btn("Закрыть", "cls")]);
  return { inline_keyboard: rows };
}

export function afterActionKeyboard(problems: boolean): InlineKeyboard {
  if (!problems) return { inline_keyboard: [] };
  return {
    inline_keyboard: [
      [btn("Повторить", "rty"), btn("Один блок", "ds")],
    ],
  };
}

export function healthHasProblems(rows: HealthRow[]): boolean {
  return rows.some((r) => r.fresh === false || r.job_status === "error");
}

export async function fetchHealth(db: Db): Promise<HealthRow[]> {
  const { data, error } = await db.rpc("load_health");
  if (error) throw new Error(error.message);
  return (data ?? []) as HealthRow[];
}

export function formatHealth(rows: HealthRow[]): string {
  const today = new Date().toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
  const lines = ["Проверка", `Сегодня ${today}`, ""];
  if (!rows.length) {
    lines.push("Активных кабинетов нет.");
    return lines.join("\n");
  }

  const slugs = [...new Set(rows.map((r) => r.slug))];
  const many = slugs.length > 1;
  let current = "";
  for (const row of rows) {
    if (many && row.slug !== current) {
      current = row.slug;
      lines.push("", current);
    }
    const name = datasetLabel(row.dataset);
    const mark = row.job_status === "queued" || row.job_status === "running"
      ? MARK_WAIT
      : row.fresh === false || row.job_status === "error"
      ? MARK_BAD
      : MARK_OK;
    const extra = row.note ? `  ${row.note}` : row.data_date ? `  до ${fmtDate(row.data_date)}` : "";
    lines.push(`${mark}  ${name}${extra}`);
  }

  const bad = rows.filter((r) => r.fresh === false || r.job_status === "error");
  if (bad.length) {
    lines.push("", `Проблем: ${bad.length} — можно повторить или взять один блок`);
  } else {
    lines.push("", `${MARK_OK} Всё свежее`);
  }
  return lines.join("\n").slice(0, 3500);
}

export async function handleControl(
  db: Db,
  data: string,
): Promise<ControlResult> {
  if (data === "mnu" || data === "menu") {
    return { text: MENU_TEXT, edit: true };
  }
  if (data === "inf" || data === "info") {
    return { text: await buildInfoText(db) };
  }
  if (data === "chk" || data === "check") {
    const rows = await fetchHealth(db);
    const problems = healthHasProblems(rows);
    return {
      text: formatHealth(rows),
      markup: problems ? afterActionKeyboard(true) : undefined,
      edit: true,
    };
  }
  if (data === "ds") {
    return { text: "Что обновить в базе?", markup: datasetsKeyboard(), edit: true };
  }
  if (data === "cls") {
    return { text: "Ок.", edit: true, markup: { inline_keyboard: [] } };
  }
  if (data === "rty" || data === "retry") {
    const { data: n, error } = await db.rpc("retry_failed_jobs");
    if (error) throw new Error(error.message);
    const count = Number(n ?? 0);
    const text = count
      ? `Повторяю ${count} ошибок. Тик подхватит в течение минуты.`
      : "Ошибок в очереди нет.";
    return { text };
  }
  if (data === "cnl" || data === "cancel") {
    const { data: n, error } = await db.rpc("cancel_sheet_work");
    if (error) throw new Error(error.message);
    const row = (n ?? {}) as { requests?: number; jobs?: number; silenced?: number };
    const req = Number(row.requests ?? 0);
    const jobs = Number(row.jobs ?? 0);
    const hush = Number(row.silenced ?? 0);
    const text = req || jobs || hush
      ? `Снял очередь: заявок ${req}, джоб ${jobs}. Бот по ним больше не напишет.`
      : "Очереди нет — отменять нечего.";
    return { text, edit: true };
  }
  if (data === "dly" || data === "daily_now") {
    const text = await enqueueAndRequest_(db, "all");
    return { text };
  }
  if (data.startsWith("ld:")) {
    const dataset = data.slice(3);
    if (!DAILY_DATASETS.includes(dataset)) {
      return { text: `Неизвестный блок: ${dataset}`, markup: datasetsKeyboard(), edit: true };
    }
    const text = await enqueueAndRequest_(db, dataset);
    return { text };
  }
  return { text: MENU_TEXT, edit: true };
}

export async function notifyMarkup(db: Db): Promise<InlineKeyboard> {
  try {
    const rows = await fetchHealth(db);
    return afterActionKeyboard(healthHasProblems(rows));
  } catch {
    return menuKeyboard();
  }
}

async function enqueueAndRequest_(
  db: Db,
  scope: string,
): Promise<string> {
  const name = scope === "all" ? "Все блоки" : datasetLabel(scope);
  if (scope === "all") {
    const { error } = await db.rpc("enqueue_daily_jobs");
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db.rpc("enqueue_dataset", { p_dataset: scope });
    if (error) throw new Error(error.message);
  }
  const { error: reqErr } = await db.rpc("request_bot_load", { p_scope: scope });
  if (reqErr) throw new Error(reqErr.message);
  return `${name}: база в очереди. Напишу, когда будет готово.`;
}

export async function notifyBotLoads(db: Db): Promise<void> {
  const { error: settleErr } = await db.rpc("bot_load_settle");
  if (settleErr) {
    console.error("bot load settle", settleErr.message);
    return;
  }
  const { data: rows, error } = await db
    .from("bot_load_requests")
    .select("id, scope, status, error")
    .eq("notified", false)
    .in("status", ["done", "error"])
    .order("id", { ascending: true })
    .limit(20);
  if (error || !rows?.length) return;
  const skip = new Set(["отменено", "заменено"]);
  const live = rows.filter((row) => !skip.has(String(row.error || "")));
  const hushIds = rows.filter((row) => skip.has(String(row.error || ""))).map((row) => row.id);
  if (hushIds.length) {
    await db.from("bot_load_requests").update({ notified: true }).in("id", hushIds);
  }
  if (!live.length) return;
  const lines: string[] = [];
  for (const row of live) {
    const name = row.scope === "all" ? "все блоки" : datasetLabel(row.scope);
    if (row.status === "done") {
      lines.push(
        row.scope === "all"
          ? `${MARK_OK} База обновила все блоки. Загрузите листы в Google.`
          : `${MARK_OK} База обновила: ${name}. Загрузите лист в Google.`,
      );
    } else {
      lines.push(`${MARK_BAD} База не обновила ${name}: ${String(row.error || "ошибка").slice(0, 180)}`);
    }
  }
  const sent = await sendTelegram(lines.join("\n"), undefined, bottomKeyboard());
  if (!sent.ok) {
    console.error("bot load notify", sent.error);
    return;
  }
  await db.from("bot_load_requests").update({ notified: true }).in("id", live.map((row) => row.id));
}

export async function notifyMorningPipeline(db: Db): Promise<void> {
  const today = moscowYmd();
  const { data: rows, error } = await db
    .from("gas_morning_status")
    .select("book_slug, notified, finished")
    .eq("run_date", today)
    .eq("finished", true)
    .eq("notified", false);
  if (error || !rows?.length) return;

  for (const row of rows) {
    const { data: text, error: textErr } = await db.rpc("morning_sheet_book_text", {
      p_book_slug: row.book_slug,
      p_run_date: today,
    });
    if (textErr || !text) {
      console.error("morning book text", row.book_slug, textErr?.message);
      continue;
    }
    const sent = await sendTelegram(String(text), undefined, bottomKeyboard());
    if (!sent.ok) {
      console.error("morning book notify", row.book_slug, sent.error);
      continue;
    }
    await db
      .from("gas_morning_status")
      .update({ notified: true })
      .eq("run_date", today)
      .eq("book_slug", row.book_slug);
  }
}

function fmtDate(iso: string): string {
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split("-");
  if (!y || !m || !day) return iso;
  return `${day}.${m}`;
}
