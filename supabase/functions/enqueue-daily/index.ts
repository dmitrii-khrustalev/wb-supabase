import { assertServiceRequest, json, serviceClient } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const denied = assertServiceRequest(req);
  if (denied) return denied;

  const db = serviceClient();
  const { data, error } = await db.rpc("enqueue_daily_jobs");
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, enqueued: data });
});
