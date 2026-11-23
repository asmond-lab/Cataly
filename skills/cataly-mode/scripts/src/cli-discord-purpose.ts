import { type Command, die } from "./cli-context.ts";
import { channelOf, discordClient } from "./cli-discord-ops.ts";
import type { DcChannel } from "./messenger/discord.ts";
import { ChannelPurposeError, DiscordChannels, type PurposeSource, purposeText } from "./messenger/discord-channels.ts";
import { inboundRequest } from "./messenger/discord-inbound-api.ts";
import { discordInboundOptions } from "./messenger/discord-inbound-env.ts";
import { discordInboundEnv, isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { discordSourceIds, verifyDiscordSource } from "./messenger/discord-source.ts";

/** Manual notes remain available; --source restricts an invocation to its verified original conversation. */
export const channelDiscord: Command = async ({ positionals, opt, values, config }) => {
  const action = positionals[1];
  if (action !== "set" && action !== "clear" && action !== "list")
    return die("channel discord needs set, clear or list");
  const raw = positionals[2];
  if (action !== "list" && raw === undefined) die(`channel discord ${action} needs a channel or thread`);
  const purpose = action === "set" ? purposeText(opt("purpose") ?? "") : undefined;
  const store = new DiscordChannels(config.stateDir);
  let origin:
    | {
        channel: DcChannel;
        parent: DcChannel | undefined;
        identity: PurposeSource;
      }
    | undefined;
  const source = values["source"];
  if (source !== undefined) {
    const fail = (message: string) => new ChannelPurposeError(message);
    const ids = discordSourceIds(source, fail);
    if (action === "list" ? raw !== undefined : !isDiscordSnowflake(raw))
      throw new ChannelPurposeError("source-bound purpose targets must use Discord IDs; list takes no target");
    const options = discordInboundOptions();
    const verified = await verifyDiscordSource(discordClient(), ids, options, "purpose", fail);
    let parent: DcChannel | undefined;
    if (verified.parent !== undefined && (action === "list" || raw === verified.parent)) {
      parent = await inboundRequest(verified.client)<DcChannel>(`/channels/${verified.parent}`);
      if (!parent || parent.id !== verified.parent) throw fail("Discord purpose destination identity is invalid");
    }
    origin = { channel: verified.channel, parent, identity: verified.identity };
  }
  const related = (id: string) => origin === undefined || id === origin.channel.id || id === origin.parent?.id;
  if (action === "list") {
    for (const [id, entry] of Object.entries(store.read())) {
      if (!related(id)) continue;
      console.log(
        `CHANNEL ${id} name=${JSON.stringify(entry.name ?? "")} purpose=${JSON.stringify(entry.purpose)} updated=${entry.updatedAt}`,
      );
    }
    return;
  }
  // The non-list destination was required above, before any source lookup.
  const target = raw!;
  if (!related(target)) throw new ChannelPurposeError("purpose destination is unrelated to the original source");
  if (action === "clear") {
    // Manual clear by ID still works without credentials, including deleted channels.
    const id = /^\d+$/.test(target)
      ? discordInboundEnv("channel", target)
      : (await channelOf(discordClient(), target)).id;
    console.log(`${(await store.clear(id, origin?.identity)) ? "PURPOSE_CLEARED" : "PURPOSE_NONE"} ${id}`);
    return;
  }
  const channel =
    origin === undefined
      ? await channelOf(discordClient(), target)
      : origin.channel.id === target
        ? origin.channel
        : origin.parent;
  if (!channel || (isDiscordSnowflake(target) && channel.id !== target))
    throw new ChannelPurposeError("Discord purpose destination identity is invalid");
  const name = typeof channel.name === "string" ? channel.name : undefined;
  const entry = await store.set(channel.id, purpose!, name, Date.now(), origin?.identity);
  console.log(`PURPOSE ${channel.id} ${JSON.stringify(entry.purpose)}`);
};
