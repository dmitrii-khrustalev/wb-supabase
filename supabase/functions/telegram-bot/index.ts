import { assertServiceRequest, json, serviceClient } from "../_shared/db.ts";
import {
  handleControl,
  MENU_TEXT,
  REPLY_ACTIONS,
} from "../_shared/control.ts";
import { buildInfoText } from "../_shared/digest.ts";
import {
  answerCallback,
  bottomKeyboard,
  editTelegram,
  sendTelegram,
  syncBotCommands,
  telegramApi,
  type InlineKeyboard,
  type ReplyMarkup,
} from "../_shared/telegram.ts";

const CLEAR_INLINE: InlineKeyboard = { inline_keyboard: [] };

function sendMarkup(inline?: InlineKeyboard): ReplyMarkup {
  if (inline?.inline_keyboard?.length) return inline;
  return bottomKeyboard();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const url = new URL(req.url);
  if (url.searchParams.get("setup") === "1") {
    const denied = assertServiceRequest(req);
    if (denied) return denied;
    try {
      const hookUrl = webhookUrl();
      await telegramApi("setWebhook", { url: hookUrl });
      try {
        await syncBotCommands();
      } catch (e) {
        console.error("syncBotCommands", e);
      }
      const ping = await sendTelegram(MENU_TEXT, undefined, bottomKeyboard());
      return json({
        ok: true,
        webhook: hookUrl,
        menu_sent: ping.ok,
        commands: [],
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  let update: Record<string, unknown> = {};
  try {
    update = await req.json();
  } catch {
    return json({ ok: true, ignored: "not json" });
  }

  if (update.probe === "info") {
    const denied = assertServiceRequest(req);
    if (denied) return denied;
    try {
      const text = await buildInfoText(serviceClient());
      const sent = await sendTelegram(text, undefined, bottomKeyboard());
      return json({ ok: sent.ok, error: sent.error });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  const callback = update.callback_query as Record<string, unknown> | undefined;
  const message = (update.message ?? callback?.message) as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const fromId = String(chat?.id ?? "");
  const allowed = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
  if (!fromId || fromId !== allowed) return json({ ok: true, ignored: "chat" });

  try {
    const db = serviceClient();

    if (callback) {
      const cbId = String(callback.id ?? "");
      const data = String(callback.data ?? "");
      const messageId = Number((callback.message as Record<string, unknown> | undefined)?.message_id ?? 0);
      try {
        const result = await handleControl(db, data);
        if (cbId) {
          await answerCallback(cbId, result.edit ? undefined : "ок");
        }
        if (result.edit && messageId) {
          const edited = await editTelegram(fromId, messageId, result.text, result.markup ?? CLEAR_INLINE);
          if (!edited.ok) {
            const sent = await sendTelegram(result.text, fromId, sendMarkup(result.markup));
            if (!sent.ok) return json({ error: sent.error }, 500);
          }
        } else {
          const sent = await sendTelegram(result.text, fromId, sendMarkup(result.markup));
          if (!sent.ok) return json({ error: sent.error }, 500);
        }
        return json({ ok: true });
      } catch (e) {
        if (cbId) {
          try {
            await answerCallback(cbId, "ошибка");
          } catch {
            // ignore
          }
        }
        await sendTelegram(`Не смог выполнить: ${String(e).slice(0, 200)}`, fromId, bottomKeyboard());
        return json({ error: String(e) }, 500);
      }
    }

    const raw = String(message?.text ?? "").trim();
    const cmd = raw.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
    const replyData = REPLY_ACTIONS[raw];

    let text = MENU_TEXT;
    let markup: ReplyMarkup = bottomKeyboard();
    if (replyData) {
      const result = await handleControl(db, replyData);
      text = result.text;
      markup = sendMarkup(result.markup);
    } else if (cmd === "/start") {
      try {
        await syncBotCommands();
      } catch (e) {
        console.error("syncBotCommands", e);
      }
      text = MENU_TEXT;
      markup = bottomKeyboard();
    } else if (raw) {
      text = MENU_TEXT;
    }
    const sent = await sendTelegram(text, fromId, markup);
    if (!sent.ok) return json({ error: sent.error }, 500);
    return json({ ok: true });
  } catch (e) {
    await sendTelegram(`Не смог проверить выгрузку: ${String(e).slice(0, 200)}`, fromId, bottomKeyboard());
    return json({ error: String(e) }, 500);
  }
});

function webhookUrl(): string {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!base || !anon) throw new Error("DB URL or anon key missing");
  return `${base}/functions/v1/telegram-bot?apikey=${encodeURIComponent(anon)}`;
}
