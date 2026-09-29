import { assertServiceRequest, json, serviceClient } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const denied = assertServiceRequest(req);
  if (denied) return denied;

  let slug = "main";
  try {
    const body = await req.json();
    if (body?.slug) slug = String(body.slug);
  } catch {
    // empty body is fine
  }

  const db = serviceClient();
  const { data, error } = await db.rpc("enqueue_history_jobs", { p_slug: slug });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, slug, enqueued: data });
});
