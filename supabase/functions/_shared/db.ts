import { createClient } from "npm:@supabase/supabase-js@2";

export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("DB URL or service key missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Db = ReturnType<typeof serviceClient>;

export function assertServiceRequest(req: Request): Response | null {
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token && (token === expected || (cronSecret && token === cronSecret))) return null;
  return json({ error: "unauthorized" }, 401);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function getSellerToken(db: Db, slug: string): Promise<string> {
  const envKey = `WB_TOKEN_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const fromEnv = Deno.env.get(envKey) || (slug === "main" ? Deno.env.get("WB_TOKEN") : undefined);
  if (fromEnv) return fromEnv;

  const { data, error } = await db.rpc("get_seller_wb_token", { p_slug: slug });
  if (error) throw new Error(`get_seller_wb_token: ${error.message}`);
  if (!data) throw new Error(`WB token not found for slug=${slug} (set vault wb_token_${slug} or secret ${envKey})`);
  return String(data);
}

function dedupeRowsByConflict(
  rows: Record<string, unknown>[],
  onConflict: string,
): Record<string, unknown>[] {
  const keys = onConflict.split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length || rows.length < 2) return rows;
  const seen = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = keys.map((k) => String(row[k] ?? "")).join("\0");
    seen.set(key, row);
  }
  return seen.size === rows.length ? rows : [...seen.values()];
}

export async function upsertRows(
  db: Db,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  chunk = 200,
): Promise<number> {
  if (!rows.length) return 0;
  const deduped = dedupeRowsByConflict(rows, onConflict);
  let n = 0;
  for (let i = 0; i < deduped.length; i += chunk) {
    const part = deduped.slice(i, i + chunk);
    const { error, count } = await db.from(table).upsert(part, {
      onConflict,
      count: "exact",
    });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
    n += count ?? part.length;
  }
  return n;
}
