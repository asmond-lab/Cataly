import { isAbsolute } from "node:path";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";

export async function nativeDiscordSend(
  binary: string,
  target: { readonly to: string } | { readonly thread: string },
  options: { readonly text: string; readonly edit: string | undefined; readonly reply: string | undefined },
): Promise<{ readonly channel: string; readonly ids: string[]; readonly replyConfirmed: boolean }> {
  if (!isAbsolute(binary)) throw new Error("CATALY_DISCORD_NATIVE_BIN must be absolute");
  const argv = [binary, "discord-send", ...("thread" in target ? ["--thread", target.thread] : ["--to", target.to])];
  if (options.edit !== undefined) argv.push("--edit", options.edit);
  if (options.reply !== undefined) argv.push("--reply", options.reply);
  const child = Bun.spawn(argv, { stdin: new TextEncoder().encode(options.text), stdout: "pipe", stderr: "inherit" });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) throw new Error(`Native Discord send exited with status ${code}`);
  const result: unknown = JSON.parse(output);
  if (
    !result ||
    typeof result !== "object" ||
    !("channel" in result) ||
    !isDiscordSnowflake(result.channel) ||
    !("ids" in result) ||
    !Array.isArray(result.ids) ||
    !result.ids.every(isDiscordSnowflake) ||
    !("replyConfirmed" in result) ||
    typeof result.replyConfirmed !== "boolean" ||
    (options.reply === undefined && result.replyConfirmed) ||
    (options.edit === undefined ? result.ids.length === 0 : result.ids.length !== 0) ||
    ("thread" in target && result.channel !== target.thread) ||
    ("to" in target && /^\d+$/.test(target.to) && result.channel !== target.to)
  )
    throw new Error("Invalid native Discord delivery receipt; inspect the destination before retrying");
  return { channel: result.channel, ids: result.ids, replyConfirmed: result.replyConfirmed };
}
