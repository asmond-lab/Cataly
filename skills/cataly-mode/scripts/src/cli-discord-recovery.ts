import { type Command, die } from "./cli-context.ts";
import { discordInboundQueue } from "./messenger/discord-inbound-queue.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";

/** Local recovery only: never authenticate to Discord or open a native session. */
export const abandonDiscordInbound: Command = async ({ key, positionals, strings, config }) => {
  if (key !== "discord") die("inbound-abandon supports discord only");
  const identity = positionals[1];
  const ids = identity?.split(":");
  if (positionals.length !== 2 || !identity || ids?.length !== 4 || !ids.every(isDiscordSnowflake))
    return die("inbound-abandon requires the exact bot:owner:channel:message source identity");
  const reasons = strings("reason");
  const reason = reasons[0]?.trim();
  if (reasons.length !== 1 || !reason) return die("--reason needs one explicit operator abandonment reason");
  const queue = discordInboundQueue(config.stateDir);
  try {
    const { source: _source, ...decision } = queue.abandon(identity, reason);
    console.log(`ADMISSION_ABANDONED ${JSON.stringify(decision)}`);
  } finally {
    queue.close();
  }
};
