import type { Db } from "./db.ts";

export const DATASETS = [
  "products",
  "finance",
  "adv_stats",
  "fbo_orders",
  "fbo_sales",
  "region_sales",
  "goods_returns",
  "order_feed",
  "feedbacks",
  "questions",
  "tariffs",
  "wb_retentions",
  "fbo_stocks",
  "stocks_lk",
  "fbw_supplies",
  "fbs_warehouses",
  "fbs_offices",
  "fbs_stocks",
  "fbs_orders",
  "fbs_supplies",
  "sales_funnel",
];

export const DATASET_LABELS: Record<string, string> = {
  products: "Товары",
  finance: "Финансы",
  adv_stats: "Реклама",
  fbo_orders: "Заказы FBW",
  fbo_sales: "Продажи FBW",
  region_sales: "Продажи по регионам",
  goods_returns: "Возвраты товаров",
  order_feed: "Лента заказов",
  feedbacks: "Отзывы",
  questions: "Вопросы",
  tariffs: "Тарифы",
  wb_retentions: "Удержания WB",
  fbo_stocks: "Остатки FBW",
  stocks_lk: "Остатки ЛК",
  fbw_supplies: "Поставки FBW",
  fbs_warehouses: "Склады FBS",
  fbs_offices: "ПВЗ FBS",
  fbs_stocks: "Остатки FBS",
  fbs_orders: "Заказы FBS",
  fbs_supplies: "Поставки FBS",
  sales_funnel: "Воронка продаж",
  warehouse_services: "Складские услуги",
  claims: "Заявки на возврат",
  promos: "Акции",
  product_prices: "История цен",
  search_queries: "Поисковые запросы",
};

export const MARK_OK = "✅";
export const MARK_BAD = "❌";
export const MARK_WAIT = "⏳";

export function datasetLabel(ds: string): string {
  return DATASET_LABELS[ds] ?? ds;
}

export function statusMark(status: string): string {
  if (status === "done") return MARK_OK;
  if (status === "error") return MARK_BAD;
  if (status === "running" || status === "queued") return MARK_WAIT;
  return MARK_WAIT;
}

type Job = {
  dataset: string;
  mode: string;
  status: string;
  error: string | null;
  updated_at: string;
};

type Run = {
  dataset: string;
  mode: string;
  rows_upserted: number | null;
  rows_yesterday?: number | null;
  rows_old?: number | null;
  error: string | null;
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
};

const SNAPSHOT_DATASETS = new Set(["fbo_stocks", "fbs_stocks", "stocks_lk"]);
const CATALOG_DATASETS = new Set([
  "products",
  "tariffs",
  "fbs_warehouses",
  "fbs_offices",
  "promos",
]);

function morningMins(ms: number): number {
  return Math.max(0, Math.round(ms / 60000));
}

function mskHm(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function splitForDataset(ds: string, n: number, y: number, o: number): { y: number; o: number } {
  if (y > 0 || o > 0) return { y, o };
  if (SNAPSHOT_DATASETS.has(ds)) return { y: n, o: 0 };
  if (CATALOG_DATASETS.has(ds)) return { y: 0, o: n };
  return { y: n, o: 0 };
}

export async function buildMorningBaseText(db: Db): Promise<string> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
  const since = `${today}T00:00:00+03:00`;
  const { data: dailyOrderRaw } = await db.rpc("daily_datasets");
  const dailyOrder = Array.isArray(dailyOrderRaw) ? (dailyOrderRaw as string[]) : [];

  const { data: jobs, error: jobsErr } = await db
    .from("sync_jobs")
    .select("dataset, mode, status, error, updated_at")
    .eq("mode", "daily")
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (jobsErr) throw new Error(jobsErr.message);

  const { data: runs, error: runsErr } = await db
    .from("load_runs")
    .select("dataset, mode, rows_upserted, rows_yesterday, rows_old, error, started_at, finished_at, duration_ms")
    .eq("mode", "daily")
    .gte("started_at", since)
    .limit(500);
  if (runsErr) throw new Error(runsErr.message);

  const runList = (runs ?? []) as Run[];
  const rowsByDataset = sumRows(runList);
  const yBy = new Map<string, number>();
  const oBy = new Map<string, number>();
  const startBy = new Map<string, string>();
  const endBy = new Map<string, string>();
  let workMs = 0;
  let firstStart = "";
  let lastEnd = "";
  for (const r of runList) {
    yBy.set(r.dataset, (yBy.get(r.dataset) ?? 0) + (r.rows_yesterday ?? 0));
    oBy.set(r.dataset, (oBy.get(r.dataset) ?? 0) + (r.rows_old ?? 0));
    workMs += Number(r.duration_ms) || 0;
    if (r.started_at && (!startBy.has(r.dataset) || r.started_at < startBy.get(r.dataset)!)) {
      startBy.set(r.dataset, r.started_at);
    }
    const fin = r.finished_at || r.started_at;
    if (fin && (!endBy.has(r.dataset) || fin > endBy.get(r.dataset)!)) {
      endBy.set(r.dataset, fin);
    }
    if (r.started_at && (!firstStart || r.started_at < firstStart)) firstStart = r.started_at;
    if (fin && (!lastEnd || fin > lastEnd)) lastEnd = fin;
  }

  const ran = new Set<string>();
  for (const job of jobs ?? []) if (job.dataset) ran.add(job.dataset);
  for (const r of runList) if (r.dataset) ran.add(r.dataset);

  const seen = new Set<string>();
  const order: string[] = [];
  for (const ds of dailyOrder) {
    if (!ds || seen.has(ds) || !ran.has(ds)) continue;
    seen.add(ds);
    order.push(ds);
  }
  for (const ds of ran) {
    if (seen.has(ds)) continue;
    seen.add(ds);
    order.push(ds);
  }

  const ddmm = today.slice(8, 10) + "." + today.slice(5, 7);
  const lines = [`Утро ${ddmm} база`];
  if (!order.length) {
    lines.push("daily ещё нет");
    return lines.join("\n").slice(0, 4000);
  }
  if (firstStart && lastEnd) {
    const wallMs = Math.max(0, new Date(lastEnd).getTime() - new Date(firstStart).getTime());
    const idleMs = Math.max(0, wallMs - workMs);
    lines.push(`${mskHm(firstStart)} → ${mskHm(lastEnd)} · ${morningMins(wallMs)} мин`);
    lines.push(`работа ${morningMins(workMs)}`);
    if (idleMs >= 30000) lines.push(`простой ${morningMins(idleMs)}`);
    lines.push("");
  }
  for (const ds of order) {
    const n = rowsByDataset.get(ds) ?? 0;
    const split = splitForDataset(ds, n, yBy.get(ds) ?? 0, oBy.get(ds) ?? 0);
    const job = (jobs ?? []).find((j) => j.dataset === ds);
    const errBit = job?.status === "error" ? ` ${short(job.error)}` : "";
    const t0 = startBy.get(ds);
    const t1 = endBy.get(ds);
    if (t0 && t1) {
      lines.push(`${datasetLabel(ds)} ${mskHm(t0)}–${mskHm(t1)} · ${split.y}/${split.o}${errBit}`);
    } else {
      lines.push(`${datasetLabel(ds)} · ${split.y}/${split.o}${errBit}`);
    }
  }
  return lines.join("\n").slice(0, 4000);
}

export async function buildDailyText(db: Db): Promise<string> {
  const { data: jobs, error: jobsErr } = await db
    .from("sync_jobs")
    .select("dataset, mode, status, error, updated_at")
    .eq("mode", "daily")
    .order("updated_at", { ascending: false })
    .limit(80);
  if (jobsErr) throw new Error(jobsErr.message);

  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const { data: runs, error: runsErr } = await db
    .from("load_runs")
    .select("dataset, mode, rows_upserted, error, started_at")
    .eq("mode", "daily")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(500);
  if (runsErr) throw new Error(runsErr.message);

  const latest = latestByDataset(jobs ?? []);
  const rowsByDataset = sumRows(runs ?? []);
  const when = latest.length
    ? moscow(latest.map((j) => j.updated_at).sort().at(-1)!)
    : "ещё не было";

  const lines = [
    "Последняя ежедневная выгрузка",
    `обновление: ${when}`,
    "",
  ];

  if (!latest.length) {
    lines.push("Заданий daily ещё нет. Они ставятся в 05:00 МСК.");
    return lines.join("\n");
  }

  const done = latest.filter((j) => j.status === "done").length;
  const run = latest.filter((j) => j.status === "queued" || j.status === "running").length;
  const err = latest.filter((j) => j.status === "error").length;
  lines.push(`готово ${done} · в работе ${run} · ошибок ${err}`);
  lines.push("");

  for (const ds of DATASETS) {
    const job = latest.find((j) => j.dataset === ds);
    if (!job) continue;
    const n = rowsByDataset.get(ds) ?? 0;
    const rows = ` +${n}`;
    const errBit = job.status === "error" ? ` ${short(job.error)}` : "";
    lines.push(`${statusMark(job.status)} ${datasetLabel(ds)}${rows}${errBit}`);
  }

  return lines.join("\n").slice(0, 3500);
}

export const MORNING_BASE = "base_sent";
export const MORNING_INFO = "info_sent";

export function morningHas(status: string | null | undefined, flag: string): boolean {
  return String(status ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(flag);
}

export function morningAdd(status: string | null | undefined, flag: string): string {
  const parts = String(status ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes(flag)) parts.push(flag);
  return parts.join(",");
}

export async function buildInfoText(db: Db): Promise<string> {
  const { data: sellers, error: sellersErr } = await db
    .from("sellers")
    .select("id, slug")
    .eq("is_active", true)
    .order("slug");
  if (sellersErr) throw new Error(sellersErr.message);
  const seller = (sellers ?? []).find((s) => s.slug === "main") ?? sellers?.[0];
  if (!seller?.id) throw new Error("нет активного кабинета");

  const { data, error } = await db.rpc("report_info_daily", {
    p_seller_id: seller.id,
    p_journal_days: 14,
  });
  if (error) throw new Error(error.message);
  const info = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!info) throw new Error("report_info_daily пусто");

  const kpi = asObj(info.kpi);
  const ads = asObj(info.ads);
  const stocks = asObj(info.stocks);
  const supplies = (info.supplies ?? []) as Record<string, unknown>[];
  const fbo = asObj(info.fbo);
  const fbs = asObj(info.fbs);
  const fbsSup = asObj(info.fbs_supplies);
  const day = shortDate(String(info.day ?? ""));

  const lines = [
    `WB · ${esc(day)}`,
    "",
    "<b>💰 Финансы</b>",
    metric("Продажи", `${fmtN(kpi.qty)} шт`, kpi.qty, kpi.qty_prev),
    metric("Выручка", `${fmtN(kpi.retail)} ₽`, kpi.retail, kpi.retail_prev),
    metric("К перечисл.", `${fmtN(kpi.for_pay)} ₽`, kpi.for_pay, kpi.for_pay_prev),
    "",
    "<b>📢 Реклама</b>",
    metric("Расход", `${fmtN(ads.spend ?? kpi.ads)} ₽`, ads.spend ?? kpi.ads, kpi.ads_prev),
    metric("ДРР", fmtPct(ads.drr ?? kpi.drr)),
    metric("После рекламы", `${fmtN(ads.after_ads)} ₽`, ads.after_ads, ads.after_ads_prev),
    "",
    "<b>🚚 Заказы FBW</b>",
    metric("Заказы", fmtN(fbo.orders), fbo.orders, fbo.orders_prev),
    metric("Отмены", fmtN(fbo.cancels)),
    metric("Сумма", `${fmtN(fbo.sum)} ₽`),
    "",
    "<b>🏬 Заказы FBS</b>",
    metric("Заказы", fmtN(fbs.orders), fbs.orders, fbs.orders_prev),
    metric("Отмены", fmtN(fbs.cancels)),
    metric("Сумма", `${fmtN(fbs.sum)} ₽`),
    "",
    "<b>📦 Остатки</b>",
    metric("FBW", fmtN(stocks.fbo_qty), stocks.fbo_qty, stocks.fbo_qty_prev),
    metric("FBS", fmtN(stocks.fbs_qty)),
    metric("В пути", fmtN(stocks.in_way_to)),
    "",
    "<b>📥 Поставки</b>",
    `Приёмка  ${esc(supplyN(supplies, "4"))} · не запланировано  ${esc(supplyN(supplies, "1"))}`,
    metric("FBS открытые", fmtN(fbsSup.open)),
  ];

  return lines.join("\n").slice(0, 3500);
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function metric(label: string, value: string, cur?: unknown, prev?: unknown): string {
  const delta = prev == null && cur == null ? "" : fmtDelta(cur, prev);
  const tail = delta ? `  ${delta}` : "";
  return `${esc(label)}  ${esc(value)}${tail}`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtN(v: unknown): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(num(v));
}

function fmtPct(v: unknown): string {
  if (v == null || v === "") return "—";
  return `${(num(v) * 100).toFixed(1).replace(".", ",")}%`;
}

function fmtDelta(cur: unknown, base: unknown): string {
  const b = num(base);
  if (!b) return "";
  const p = (num(cur) - b) / b * 100;
  const rounded = Math.round(p);
  if (!rounded) return "0%";
  const sign = rounded > 0 ? "+" : "−";
  return `${sign}${Math.abs(rounded)}%`;
}

function shortDate(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  return iso || "—";
}

function supplyN(rows: Record<string, unknown>[], statusId: string): string {
  const row = rows.find((r) => String(r.status_id ?? "") === statusId);
  return fmtN(row?.supplies ?? 0);
}

export async function buildDigestText(db: Db): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: jobs, error: jobsErr } = await db
    .from("sync_jobs")
    .select("dataset, mode, status, error, updated_at")
    .order("updated_at", { ascending: false })
    .limit(80);
  if (jobsErr) throw new Error(jobsErr.message);

  const { data: runs, error: runsErr } = await db
    .from("load_runs")
    .select("dataset, mode, rows_upserted, error, note, started_at")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(80);
  if (runsErr) throw new Error(runsErr.message);

  const { data: sellers } = await db.from("sellers").select("name, slug, is_active");

  const lines: string[] = [];
  const today = new Date().toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
  lines.push(`WB загрузка ${today}`);

  const active = (sellers ?? []).filter((s) => s.is_active);
  if (active.length) lines.push(`кабинеты: ${active.map((s) => s.slug).join(", ")}`);

  const latest = new Map<string, Job>();
  for (const job of (jobs ?? []) as Job[]) {
    const key = `${job.mode}:${job.dataset}`;
    if (!latest.has(key)) latest.set(key, job);
  }

  const hist = DATASETS.map((ds) => latest.get(`history:${ds}`)).filter(Boolean) as Job[];
  const daily = DATASETS.map((ds) => latest.get(`daily:${ds}`)).filter(Boolean) as Job[];

  lines.push("");
  lines.push(section("История", hist));
  lines.push("");
  lines.push(section("Ежедневное", daily));

  const failedRuns = (runs ?? []).filter((r) => r.error);
  if (failedRuns.length) {
    lines.push("");
    lines.push("Ошибки за 24ч:");
    for (const r of failedRuns.slice(0, 5)) {
      lines.push(`${MARK_BAD} ${datasetLabel(r.dataset)}: ${short(r.error)}`);
    }
  }

  const upserted = (runs ?? []).reduce((n, r) => n + (r.rows_upserted ?? 0), 0);
  lines.push("");
  lines.push(`За 24ч записано строк: ${upserted}`);
  return lines.join("\n").slice(0, 3500);
}

export async function dailyHasProblems(db: Db): Promise<boolean> {
  const jobs = await latestDailyJobs_(db);
  return jobs.some((j) => j.status === "error");
}

export async function buildMorningText(
  db: Db,
): Promise<{ text: string; problems: boolean }> {
  let info = "";
  try {
    info = await buildInfoText(db);
  } catch {
    info = "Цифры вчера не собрались.";
  }
  const base = await buildBaseSummary_(db);
  const parts = [info, "", base.line];
  for (const d of base.details) parts.push(d);
  if (base.problems) parts.push("", "Нажмите «Обновить всё» или «Один блок».");
  return { text: parts.join("\n").slice(0, 3500), problems: base.problems };
}

async function latestDailyJobs_(db: Db): Promise<Job[]> {
  const { data: jobs, error } = await db
    .from("sync_jobs")
    .select("dataset, mode, status, error, updated_at")
    .eq("mode", "daily")
    .order("updated_at", { ascending: false })
    .limit(80);
  if (error) throw new Error(error.message);
  return latestByDataset((jobs ?? []) as Job[]);
}

async function buildBaseSummary_(
  db: Db,
): Promise<{ line: string; details: string[]; problems: boolean }> {
  const latest = await latestDailyJobs_(db);
  if (!latest.length) {
    return { line: `${MARK_WAIT} База — заданий ещё нет`, details: [], problems: false };
  }
  const done = latest.filter((j) => j.status === "done").length;
  const run = latest.filter((j) => j.status === "queued" || j.status === "running").length;
  const err = latest.filter((j) => j.status === "error");
  const n = `${done}/${latest.length}`;
  if (!err.length && !run) {
    return { line: `${MARK_OK} База ${n}`, details: [], problems: false };
  }
  const details = err.map((j) => `${MARK_BAD} ${datasetLabel(j.dataset)} — ${esc(short(j.error))}`);
  if (run) {
    return {
      line: `${MARK_WAIT} База ${n} · ещё идёт ${run}`,
      details,
      problems: err.length > 0,
    };
  }
  return { line: `${MARK_BAD} База ${n}`, details, problems: true };
}

function latestByDataset<T extends { dataset: string }>(rows: T[]): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (!map.has(row.dataset)) map.set(row.dataset, row);
  }
  return [...map.values()];
}

function sumRows(runs: Run[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of runs) {
    map.set(r.dataset, (map.get(r.dataset) ?? 0) + (r.rows_upserted ?? 0));
  }
  return map;
}

function section(title: string, jobs: Job[]): string {
  if (!jobs.length) return `${title}: заданий ещё не было`;
  const done = jobs.filter((j) => j.status === "done").length;
  const run = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const err = jobs.filter((j) => j.status === "error");
  const mark = err.length ? MARK_BAD : run ? MARK_WAIT : MARK_OK;
  const parts = [`${mark} ${title}: ${done}/${jobs.length}`];
  if (run) parts.push(`ещё идёт: ${run}`);
  if (err.length) {
    parts.push("Ошибки: " + err.map((j) => `${datasetLabel(j.dataset)} (${short(j.error)})`).join("; "));
  }
  return parts.join("\n");
}

function moscow(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

function short(s: string | null | undefined): string {
  if (!s) return "без текста";
  return s.replace(/\s+/g, " ").slice(0, 80);
}
