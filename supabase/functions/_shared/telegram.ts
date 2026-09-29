export type InlineKeyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

export type ReplyKeyboard = {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
};

export type ReplyMarkup = InlineKeyboard | ReplyKeyboard;

export function bottomKeyboard(): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: "Цифры" }, { text: "Обновить всё" }],
      [{ text: "Один блок" }, { text: "Отменить" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "кнопка внизу",
  };
}

export async function sendTelegram(
  text: string,
  chatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "",
  replyMarkup?: ReplyMarkup,
): Promise<{ ok: boolean; error?: string }> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (!token || !chatId) return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing" };

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (/<[bi]>/.test(text)) payload.parse_mode = "HTML";
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, error: `${res.status} ${body.slice(0, 300)}` };
  return { ok: true };
}

export async function editTelegram(
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    };
    if (/<[bi]>/.test(text)) payload.parse_mode = "HTML";
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await telegramApi("editMessageText", payload);
    return { ok: true };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("message is not modified")) return { ok: true };
    return { ok: false, error: msg };
  }
}

export async function answerCallback(id: string, text?: string): Promise<void> {
  const payload: Record<string, unknown> = { callback_query_id: id };
  if (text) payload.text = text;
  await telegramApi("answerCallbackQuery", payload);
}

export async function telegramApi(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || data?.ok === false) {
    throw new Error(`${method}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

/** Clear the slash-command menu. Do not call this on every message — Telegram rate-limits it. */
export async function syncBotCommands(): Promise<void> {
  await telegramApi("deleteMyCommands", {});
  await telegramApi("setChatMenuButton", { menu_button: { type: "default" } });
}
