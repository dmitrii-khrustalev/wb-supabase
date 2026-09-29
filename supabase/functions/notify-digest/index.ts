import { assertServiceRequest, json, serviceClient } from "../_shared/db.ts";
import { moscowYmd } from "../_shared/dates.ts";
import {
  buildDigestText,
  buildMorningBaseText,
  dailyHasProblems,
  MORNING_BASE,
  morningAdd,
  morningHas,
} from "../_shared/digest.ts";
import { bottomKeyboard, sendTelegram } from "../_shared/telegram.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const denied = assertServiceRequest(req);
  if (denied) return denied;

  try {
    const db = serviceClient();
    const today = moscowYmd();
    const { data: row } = await db
      .from("sheet_morning")
      .select("run_date, status_text")
      .eq("id", 1)
      .maybeSingle();
    const sameDay = String(row?.run_date ?? "") === today;
    let flags = sameDay ? String(row?.status_text ?? "") : "";
    const morningSent = sameDay && morningHas(flags, MORNING_BASE);
    let morningFallback = false;
    if (!morningSent) {
      const text = await buildMorningBaseText(db);
      const sent = await sendTelegram(text, undefined, bottomKeyboard());
      if (sent.ok) {
        morningFallback = true;
        flags = morningAdd(flags, MORNING_BASE);
        await db.from("sheet_morning").upsert({
          id: 1,
          run_date: today,
          daily_text: text.slice(0, 3500),
          status_text: flags,
          updated_at: new Date().toISOString(),
        });
      }
    }
    const problems = await dailyHasProblems(db);
    if (!problems) {
      return json({ ok: true, sent: morningFallback, errors: false, morningFallback });
    }
    const text = await buildDigestText(db);
    const sent = await sendTelegram(text, undefined, bottomKeyboard());
    if (!sent.ok) return json({ error: sent.error, text }, 500);
    return json({ ok: true, sent: true, errors: true, morningFallback });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
