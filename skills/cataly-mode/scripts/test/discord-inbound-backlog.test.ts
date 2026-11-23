import { expect, test } from "bun:test";
import { chmodSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

// POSIX-only: the Discord inbound queue requires a private (0700) uid-owned directory.
const posix = test.skipIf(process.platform === "win32");

posix("queue files and sidecars remain private and unsafe paths are rejected", () => {
  const state = withState();
  const path = join(state.dir, "discord-inbound/gateway.sqlite");
  try {
    const queue = discordInboundQueue(state.dir);
    queue.push("message", ownerMessage("101"));
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    queue.close();
    symlinkSync(path, `${path}-journal`);
    expect(() => discordInboundQueue(state.dir)).toThrow("private regular file");
    chmodSync(path, 0o640);
    expect(() => discordInboundQueue(state.dir)).toThrow("private regular file");
  } finally {
    state.done();
  }
});
