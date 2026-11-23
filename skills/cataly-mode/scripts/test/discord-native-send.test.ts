import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sentReceipts } from "../src/owes.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

test.skipIf(process.platform === "win32")(
  "an installed native binary is selected by default for presence and confirmed Discord replies",
  async () => {
    await withDiscordCli(async (f) => {
      const home = join(f.tmp, "..");
      mkdirSync(join(home, "bin"));
      const bin = join(home, "bin", "cataly-native");
      writeFileSync(
        bin,
        `#!${process.execPath}
const [command, destination, channel, reply, message] = process.argv.slice(2);
if (command === "discord-presence") {
  console.log("PRESENCE_READY discord event=READY");
  process.exit(0);
}
const input = await Bun.stdin.text();
if (command !== "discord-send" || destination !== "--thread" || reply !== "--reply" || input !== "answer from stdin") process.exit(91);
console.log(JSON.stringify({ channel, ids: [message === "50" ? "71" : "72"], replyConfirmed: message === "50" }));
`,
        { mode: 0o700 },
      );
      const environment = { CATALY_HOME: home };
      const presence = await f.invoke(["presence", "discord"], { environment });
      expect([presence.code, presence.out, presence.keys]).toEqual([0, "PRESENCE_READY discord event=READY", []]);
      for (const [message, remote] of [
        [ids.message, "71"],
        [ids.starter, "72"],
      ] as const) {
        const r = await f.invoke(["send", "discord", "--thread", ids.thread, "--reply", message, "--text-file", "-"], {
          stdin: "answer from stdin\n",
          environment,
        });
        expect([r.code, r.out, r.keys]).toEqual([0, `SENT ${remote}`, []]);
      }
      expect(sentReceipts(join(f.tmp, ".."))).toEqual([
        expect.objectContaining({ channel: ids.thread, requestId: `${ids.thread}:${ids.message}`, remoteIds: ["71"] }),
      ]);
    });
  },
  25_000,
);
