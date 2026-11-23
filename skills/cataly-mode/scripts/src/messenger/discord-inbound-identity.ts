import type { Request } from "./discord-inbound-api.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

/** Requires an authenticated bot distinct from the configured owner and enabled for owner messages. */
export const verifyDiscordInboundIdentity = async (request: Request, ownerId: string) => {
  const me = await request<{ id?: string; bot?: boolean; avatar?: unknown }>("/users/@me");
  if (me?.bot !== true || !isDiscordSnowflake(me.id)) {
    throw new MessengerError("Discord inbound requires an authenticated bot identity; use a bot token", 401);
  }
  const botId = me.id;
  if (botId === ownerId)
    throw new MessengerError("CATALY_DISCORD_OWNER_ID must identify the human owner, not the bot", 0);
  const application = await request<{ flags?: number }>("/applications/@me");
  const flags = application?.flags;
  if (typeof flags !== "number" || !Number.isSafeInteger(flags) || (flags & ((1 << 18) | (1 << 19))) === 0) {
    throw new MessengerError(
      "Discord inbound needs Message Content Intent enabled for this bot in the Developer Portal",
      403,
    );
  }
  return { botId, missingAvatar: me.avatar === null };
};
