import type { CatalyConfig } from "../config.ts";
import { conversationRecall, createRecallScope } from "./recall-ledger.ts";
import type { Telegram } from "./telegram.ts";
import { envInt, type TgInbound } from "./telegram-inbound.ts";

const warn = (message: string) => console.error(`WARN ${message}`);
const turn = (chat: number, topic: number | undefined, id: number, text: string) => ({
  channel: String(chat),
  thread: topic === undefined ? String(chat) : `${chat}/${topic}`,
  ref: String(id),
  text,
});
const ledger = (config: CatalyConfig, bot: number, owner: number) => {
  if (config.recall?.enabled !== true || owner <= 0 || owner === bot) return undefined;
  return conversationRecall({ ...config, scope: createRecallScope("telegram", String(bot), String(owner)) }, warn);
};

export const telegramOwnerRecall = (config: CatalyConfig, bot: number, owner: number) => {
  const recall = ledger(config, bot, owner);
  return (inbound: TgInbound): string | undefined => {
    const { chat, thread, messageId, text } = inbound;
    if (inbound.kind !== "message" || messageId === undefined || !text?.trim()) return undefined;
    return recall?.owner(turn(chat, thread, messageId, text));
  };
};

/** No profile reads or storage unless this is a delivered message in the configured owner conversation. */
export const telegramLeadRecall = async (
  config: CatalyConfig,
  tg: Telegram,
  destination: { chatId: string; threadId?: number },
  id: number,
  text: string,
): Promise<void> => {
  if (config.recall?.enabled !== true) return;
  try {
    const env = process.env;
    const setting = (name: string) => (env[name] === undefined ? undefined : envInt(name, env[name]));
    const owner = setting("CATALY_TELEGRAM_OWNER_ID");
    if (owner === undefined || owner <= 0) return;
    const chat = Number(destination.chatId);
    if (!Number.isSafeInteger(chat) || String(chat) !== destination.chatId) return;
    const group = setting("CATALY_TELEGRAM_GROUP_ID");
    const topic = chat === group ? (destination.threadId ?? 1) : destination.threadId;
    const allowed = chat === owner || (chat === group && (setting("CATALY_TELEGRAM_TOPIC_ID") ?? topic) === topic);
    if (!allowed) return;
    const me = await tg.call<{ id?: unknown; is_bot?: unknown }>("getMe", {});
    if (me?.is_bot !== true || typeof me.id !== "number" || !Number.isSafeInteger(me.id) || me.id <= 0) return;
    ledger(config, me.id, owner)?.lead(turn(chat, topic, id, text));
  } catch {
    warn("recall: Telegram delivery identity or scope was not available");
  }
};
