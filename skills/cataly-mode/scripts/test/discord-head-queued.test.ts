import { expect, test } from "bun:test";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { discordSourceFingerprint } from "../src/messenger/discord-source-fingerprint.ts";
import { ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

const posix = test.skipIf(typeof process.getuid !== "function");

const source = toInbound(ownerMessage("105"));
const original = {
  identity: "99:10:20:105",
  fingerprint: discordSourceFingerprint(source),
  headFile: "/head/original.jsonl",
  headPid: process.pid,
  source,
};

posix("an unknown native attempt also fences upstream exact-ID acknowledgement", () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir, true);
  try {
    queue.storeFor("20").save("102");
    queue.push("message", ownerMessage("105"), "102");
    queue.push("message", ownerMessage("106", { channel_id: "21" }), "102");
    queue.attempt(original);
    expect(() => queue.acknowledge("20", "105")).toThrow("HEAD_ADMISSION_UNRESOLVED");
    expect(() => queue.acknowledge("21", "106")).toThrow("HEAD_ADMISSION_UNRESOLVED");
    expect(queue.has("20", "105")).toBe(true);
    expect(queue.has("21", "106")).toBe(true);
    expect(queue.storeFor("20").load()).toBe("102");
  } finally {
    queue.close();
    state.done();
  }
});
