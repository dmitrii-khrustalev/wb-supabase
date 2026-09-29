import { assertServiceRequest, getSellerToken, json, serviceClient, type Db } from "../_shared/db.ts";
import { moscowYmd, moscowDayStartIso, addDays } from "../_shared/dates.ts";
import { buildMorningBaseText, MORNING_BASE, morningAdd, morningHas } from "../_shared/digest.ts";
import { notifyBotLoads, notifyMorningPipeline } from "../_shared/control.ts";
import { runLoader } from "../_shared/loaders/index.ts";
import { bottomKeyboard, sendTelegram } from "../_shared/telegram.ts";
import type { JobMode, Seller, SyncJob } from "../_shared/types.ts";

const STALE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const SAME_DAY_DATA = new Set([
  "fbo_stocks",
  "stocks_lk",
  "fbs_stocks",
  "products",
  "fbs_warehouses",
  "fbs_offices",
  "claims",
  "promos",
  "tariffs",
]);
const FACT_DATASETS = new Set([
  "finance",
  "adv_stats",
  "fbo_orders",
  "fbs_orders",
  "fbo_stocks",
  "fbs_stocks",
]);

function dataDateFor(dataset: string, today: string, yesterday: string): string {
  return SAME_DAY_DATA.has(dataset) ? today : yesterday;
}

async function datasetRowCount(
  db: Db,
  sellerId: string,
  dataset: string,
): Promise<number | null> {
  const { data, error } = await db.rpc("dataset_row_count", {
    p_seller_id: sellerId,
    p_dataset: dataset,
  });
  if (error) {
    console.error("dataset_row_count", dataset, error.message);
    return null;
  }
  if (data == null) return null;
  return Number(data);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const denied = assertServiceRequest(req);
  if (denied) return denied;

  const t0 = Date.now();
  const db = serviceClient();
  const { data: dailyOrderRaw } = await db.rpc("daily_datasets");
  const dailyOrder = Array.isArray(dailyOrderRaw) ? (dailyOrderRaw as string[]) : [];

  await db
    .from("sync_jobs")
    .update({ status: "queued" })
    .eq("status", "running")
    .lt("updated_at", new Date(Date.now() - STALE_MS).toISOString());

  // Finish the in-flight job before starting another dataset.
  const { data: runningJobs, error: runningErr } = await db
    .from("sync_jobs")
    .select("*")
    .eq("status", "running")
    .order("updated_at", { ascending: true })
    .limit(1);
  if (runningErr) return json({ error: runningErr.message }, 500);

  let job = (runningJobs?.[0] ?? null) as SyncJob | null;
  if (!job) {
    const { data: queuedJobs, error: queuedErr } = await db
      .from("sync_jobs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(30);
    if (queuedErr) return json({ error: queuedErr.message }, 500);
    const queued = (queuedJobs ?? []) as SyncJob[];
    queued.sort((a, b) => {
      const ta = new Date(a.created_at ?? 0).getTime();
      const tb = new Date(b.created_at ?? 0).getTime();
      if (ta !== tb) return ta - tb;
      const ia = dailyOrder.indexOf(a.dataset);
      const ib = dailyOrder.indexOf(b.dataset);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    job = queued[0] ?? null;
  }
  if (!job) {
    await maybeNotifyDailyDone(db, "daily", "done");
    await notifyMorningPipeline(db);
    await notifyBotLoads(db);
    return json({ ok: true, idle: true });
  }
  const { data: seller, error: sellerErr } = await db
    .from("sellers")
    .select("id, name, slug, is_active, history_from")
    .eq("id", job.seller_id)
    .maybeSingle();
  if (sellerErr || !seller) {
    await failJob(db, job.id, sellerErr?.message ?? "seller missing");
    await maybeNotifyDailyDone(db, job.mode);
    await notifyMorningPipeline(db);
    await notifyBotLoads(db);
    return json({ error: "seller missing", jobId: job.id }, 500);
  }

  let token: string;
  try {
    token = await getSellerToken(db, seller.slug);
  } catch (e) {
    await failJob(db, job.id, String(e));
    await maybeNotifyDailyDone(db, job.mode);
    await notifyMorningPipeline(db);
    await notifyBotLoads(db);
    return json({ error: String(e), jobId: job.id }, 500);
  }

  await db.from("sync_jobs").update({
    status: "running",
    started_at: job.started_at ?? new Date().toISOString(),
    attempts: (job.attempts ?? 0) + 1,
  }).eq("id", job.id);

  const today = moscowYmd();
  const runStarted = new Date().toISOString();
  const countBefore = await datasetRowCount(db, job.seller_id, job.dataset);
  let result;
  try {
    result = await runLoader(db, job.dataset, {
      seller: seller as Seller,
      token,
      mode: job.mode as JobMode,
      cursor: (job.cursor ?? {}) as Record<string, unknown>,
      today,
      yesterday: addDays(today, -1),
    });
  } catch (e) {
    result = {
      done: true,
      cursor: job.cursor ?? {},
      rowsIn: 0,
      rowsUpserted: 0,
      error: String(e),
    };
  }

  const attempts = (job.attempts ?? 0) + 1;
  let status: string;
  if (result.retry) status = "queued";
  else if (result.error && result.done) status = "error";
  else if (result.error && attempts >= MAX_ATTEMPTS) status = "error";
  else if (result.done) status = "done";
  else status = "running";

  await db.from("sync_jobs").update({
    status,
    cursor: result.cursor ?? {},
    error: result.error ?? null,
    finished_at: status === "done" || status === "error" ? new Date().toISOString() : null,
  }).eq("id", job.id);

  if (status === "done" || (!result.retry && !result.error)) {
    await db.from("sync_state").upsert({
      seller_id: job.seller_id,
      dataset: job.dataset,
      cursor: result.cursor ?? {},
      last_success_at: new Date().toISOString(),
      data_date: dataDateFor(job.dataset, today, addDays(today, -1)),
      updated_at: new Date().toISOString(),
    }, { onConflict: "seller_id,dataset" });
  }

  if (status === "done") {
    if (FACT_DATASETS.has(job.dataset)) {
      const from = job.mode === "history" ? addDays(today, -90) : addDays(today, -16);
      const { error: factsErr } = await db.rpc("refresh_info_facts", {
        p_seller_id: job.seller_id,
        p_from: from,
        p_to: today,
      });
      if (factsErr) console.error("refresh_info_facts", factsErr.message);
    }
  }

  let rowsInserted = 0;
  if (countBefore != null) {
    const countAfter = await datasetRowCount(db, job.seller_id, job.dataset);
    if (countAfter != null) {
      rowsInserted = Math.max(0, countAfter - countBefore);
    }
  }

  let bytesInserted = 0;
  if (rowsInserted > 0) {
    const { data: state } = await db
      .from("sync_state")
      .select("row_count, row_bytes")
      .eq("seller_id", job.seller_id)
      .eq("dataset", job.dataset)
      .maybeSingle();
    const totalRows = Number(state?.row_count ?? 0);
    const totalBytes = Number(state?.row_bytes ?? 0);
    if (totalRows > 0 && totalBytes > 0) {
      bytesInserted = Math.round((rowsInserted * totalBytes) / totalRows);
    }
  }

  await db.from("load_runs").insert({
    seller_id: job.seller_id,
    dataset: job.dataset,
    mode: job.mode,
    job_id: job.id,
    rows_in: result.rowsIn,
    rows_upserted: result.rowsUpserted,
    rows_yesterday: result.rowsYesterday ?? 0,
    rows_old: result.rowsOld ?? 0,
    rows_inserted: rowsInserted,
    bytes_inserted: bytesInserted,
    error: result.error ?? null,
    note: result.note ?? (result.retry ? "retry 429" : null),
    started_at: runStarted,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
  });

  await maybeNotifyDailyDone(db, job.mode, status);
  await notifyMorningPipeline(db);
  await notifyBotLoads(db);

  return json({
    ok: true,
    jobId: job.id,
    dataset: job.dataset,
    mode: job.mode,
    slug: seller.slug,
    status,
    rowsIn: result.rowsIn,
    rowsUpserted: result.rowsUpserted,
    rowsInserted,
    bytesInserted,
    note: result.note,
    error: result.error,
    ms: Date.now() - t0,
  });
});

async function failJob(
  db: Db,
  jobId: string,
  error: string,
) {
  await db.from("sync_jobs").update({
    status: "error",
    error,
    finished_at: new Date().toISOString(),
  }).eq("id", jobId);
}

const STALE_OPEN_MS = 4 * 60 * 60 * 1000;

function warehouseNewNames_(data: unknown): string[] {
  const sellers = (data as { sellers?: { new_unmatched?: string[] }[] } | null)?.sellers;
  if (!Array.isArray(sellers)) return [];
  const out: string[] = [];
  for (const s of sellers) {
    for (const name of s.new_unmatched ?? []) {
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

async function maybeNotifyDailyDone(
  db: Db,
  mode: string,
  status?: string,
) {
  if (mode !== "daily") return;
  if (status && status !== "done" && status !== "error") return;

  const today = moscowYmd();
  const since = moscowDayStartIso(today);
  const { data: todayJobs, error: todayErr } = await db
    .from("sync_jobs")
    .select("id")
    .eq("mode", "daily")
    .gte("updated_at", since)
    .limit(1);
  if (todayErr || !todayJobs?.length) return;

  const { data: open, error } = await db
    .from("sync_jobs")
    .select("id, updated_at")
    .eq("mode", "daily")
    .in("status", ["queued", "running"]);
  if (error) return;

  const now = Date.now();
  const freshOpen = (open ?? []).filter((j) => {
    const t = new Date(String(j.updated_at ?? "")).getTime();
    return Number.isFinite(t) && now - t < STALE_OPEN_MS;
  });
  if (freshOpen.length) return;

  const { data: row } = await db
    .from("sheet_morning")
    .select("run_date, status_text, daily_text")
    .eq("id", 1)
    .maybeSingle();
  const sameDay = String(row?.run_date ?? "") === today;
  let flags = sameDay ? String(row?.status_text ?? "") : "";
  const dailySent = sameDay && morningHas(flags, MORNING_BASE);
  if (dailySent) return;

  const factsFrom = addDays(today, -16);
  const { error: factsErr } = await db.rpc("refresh_info_facts_all", {
    p_from: factsFrom,
    p_to: today,
  });
  if (factsErr) console.error("refresh_info_facts_all", factsErr);

  const { data: whDict, error: whErr } = await db.rpc("warehouse_dict_refresh_all");
  if (whErr) console.error("warehouse_dict_refresh_all", whErr);

  let text = await buildMorningBaseText(db);
  const newWh = warehouseNewNames_(whDict);
  if (newWh.length) {
    text += "\nсклады +" + newWh.length + ": " + newWh.slice(0, 8).join(", ");
  }
  const sent = await sendTelegram(text, undefined, bottomKeyboard());
  if (!sent.ok) {
    console.error("daily notify", sent.error);
    return;
  }
  flags = morningAdd(flags, MORNING_BASE);
  await db.from("sheet_morning").upsert({
    id: 1,
    run_date: today,
    daily_text: text.slice(0, 3500),
    status_text: flags,
    updated_at: new Date().toISOString(),
  });
}
