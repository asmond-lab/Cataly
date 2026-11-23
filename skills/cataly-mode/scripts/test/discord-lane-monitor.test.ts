import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { openDiscordLaneInbox } from "../src/messenger/discord-lane-inbox.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { nativeDiscordBinary } from "./discord-loopback.ts";
import { laneState } from "./fakes.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

const identity = { bot: "721", owner: "941" };
// Real intake runs in the native binary; without it this public-CLI scenario is skipped, never faked.
const native = test.skipIf(process.platform === "win32" || !nativeDiscordBinary());

native.each([false, true])("owner ingress queues a paused lane with auto-reply opt-in %s", async (enabled) => {
  const f = await lifecycleFixture();
  const { dir } = f.state;
  const message = ownerMessage("301");
  const channel = message.channel_id;
  const config = join(dir, "config.json");
  const reacted = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "PUT" && pathname.startsWith(`/channels/${channel}/messages/301/reactions/`)) {
        reacted.resolve();
        return new Response(null, { status: 204 });
      }
      if (pathname === "/users/@me") return Response.json({ id: identity.bot, bot: true });
      if (pathname === "/applications/@me") return Response.json({ flags: 1 << 19 });
      if (pathname === `/channels/${channel}/messages`) return Response.json([message]);
      return new Response(null, { status: 404 });
    },
  });
  const inbox = openDiscordLaneInbox(dir);
  try {
    await f.deps.registry.write({ ...f.lane, thread: `discord:${channel}`, status: "paused" });
    laneState(dir, "w1:p7", { sessionId: f.session, pid: 0, discordLaneInbox: true, goal: { status: "paused" } });
    writeFileSync(config, JSON.stringify({ stateDir: dir, runtime: "herdr" }));
    fileDiscordInboundStore(dir, channel).save("300");
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "inbound",
        "discord",
        ...(enabled ? ["--wake-lanes"] : []),
      ],
      {
        env: {
          HOME: dir,
          PATH: "/usr/bin:/bin",
          CATALY_CONFIG: config,
          CATALY_DISCORD_API_BASE: `http://127.0.0.1:${server.port}`,
          CATALY_DISCORD_TOKEN: "synthetic-loopback-token",
          CATALY_DISCORD_OWNER_ID: message.author.id,
          CATALY_DISCORD_CHANNEL_ID: channel,
          CATALY_DISCORD_THREADS: "off",
          CATALY_DISCORD_NATIVE_BIN: nativeDiscordBinary()!,
          CATALY_MESSENGER_PROFILE_DEFAULTS: "off",
        },
        stdout: "ignore",
        stderr: "pipe",
        timeout: 3_500,
      },
    );
    const errors = new Response(child.stderr).text();
    try {
      await Promise.race([
        reacted.promise,
        child.exited.then(async (code) => {
          throw new Error(`Receiver stopped with ${code}: ${await errors}`);
        }),
      ]);
      expect(inbox.next(f.session, channel)).toMatchObject({ id: "301" });
      expect(inbox.pendingSessions({ bot: identity.bot, owner: message.author.id })).toEqual(
        enabled ? [{ session: f.session, channel, hasInput: true }] : [],
      );
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    inbox.close();
    server.stop(true);
    f.state.done();
  }
});
