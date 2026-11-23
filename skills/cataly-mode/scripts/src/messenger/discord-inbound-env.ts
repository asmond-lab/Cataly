import type { DiscordInboundOptions } from "./discord-inbound.ts";
import { discordInboundEnv } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

type ResolvedOptions = Required<DiscordInboundOptions>;

/** Shared owner, channel and thread settings for inbound-scoped commands. */
export const discordInboundOptions = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedOptions => {
  const ownerId = discordInboundEnv("CATALY_DISCORD_OWNER_ID", env["CATALY_DISCORD_OWNER_ID"]);
  const scope = env["CATALY_DISCORD_SCOPE"]?.trim();
  if (scope !== undefined && scope !== "" && scope !== "all")
    throw new MessengerError("CATALY_DISCORD_SCOPE must be all or unset", 0);
  const all = scope === "all";
  const setting = env["CATALY_DISCORD_THREADS"]?.trim().toLowerCase();
  if (setting !== undefined && setting !== "" && setting !== "off" && setting !== "on")
    throw new MessengerError("CATALY_DISCORD_THREADS must be on, off or unset", 0);
  const channelIds = ["CATALY_DISCORD_CHANNEL_ID", "CATALY_DISCORD_CHANNEL_IDS"].flatMap((name) =>
    (env[name] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "")
      .map((id) => discordInboundEnv(name, id)),
  );
  if (!all && channelIds.length === 0) discordInboundEnv("CATALY_DISCORD_CHANNEL_ID", env["CATALY_DISCORD_CHANNEL_ID"]);
  return { ownerId, channelIds: [...new Set(channelIds)], all, threads: setting !== "off" };
};
