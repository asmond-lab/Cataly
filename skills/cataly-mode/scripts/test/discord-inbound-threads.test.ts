import { expect, test } from "bun:test";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { MessengerError } from "../src/messenger/http.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";

const cursorsFor = (initial: Record<string, string> = {}) => {
  const stores = new Map<string, ReturnType<typeof memoryDiscordCursor>>();
  return {
    stores,
    storeFor: (channel: string) => {
      const entry = stores.get(channel) ?? memoryDiscordCursor(initial[channel]);
      stores.set(channel, entry);
      return entry.store;
    },
  };
};

/** One guild with a watched channel 20 and an unwatched channel 21; `threads` are listed as active. */
const threadWorld = (
  messages: ReturnType<typeof ownerMessage>[] = [],
  threads: [id: string, parent: string][] = [],
) => {
  const world = discordRestWorld(messages);
  world.state.guilds = [{ id: "5", channels: ["20", "21"], threads: threads.map(([id]) => id) }];
  for (const [id, parent] of threads) world.state.threadParents.set(id, parent);
  return world;
};

test("a thread under a watched channel is followed and its messages are delivered", async () => {
  const world = threadWorld([ownerMessage("100"), ownerMessage("200", { channel_id: "30" })], [["30", "20"]]);
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["20"] });
  expect(intake.channels().sort()).toEqual(["20", "30"]);
  expect(cursors.storeFor("30").load()).toBe("200"); // Cold start baselines the thread's latest message.
  const received: string[] = [];
  const emit = (message: { channel: string; message: string }) =>
    received.push(`${message.channel}:${message.message}`);
  world.state.messages.push(ownerMessage("201", { channel_id: "30" }));
  await intake.poll(emit);
  expect(received).toEqual(["30:201"]);
  expect(cursors.storeFor("30").load()).toBe("201");
  await intake.poll(emit); // Each thread keeps its own cursor: no replay.
  expect(received).toEqual(["30:201"]);
});

test("a thread under an unwatched channel is never read or delivered", async () => {
  const world = threadWorld([ownerMessage("300", { channel_id: "31" })], [["31", "21"]]);
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["20"] });
  expect(intake.channels()).toEqual(["20"]);
  expect(cursors.stores.has("31")).toBe(false);
  expect(world.requests.some((request) => request.url.includes("/channels/31/messages"))).toBe(false);
});

test("a thread first listed after startup starts at the parent's position, not at its old history", async () => {
  // Thread 40 already holds replies older than the parent's startup position; only replies after it are new.
  const world = threadWorld(
    [ownerMessage("100"), ownerMessage("50", { channel_id: "40" }), ownerMessage("95", { channel_id: "40" })],
    [["30", "20"]],
  );
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["20"] });
  const received: string[] = [];
  const emit = (message: { channel: string; message: string }) =>
    received.push(`${message.channel}:${message.message}`);
  world.state.guilds[0]?.threads.push("40");
  world.state.threadParents.set("40", "20");
  world.state.messages.push(ownerMessage("120", { channel_id: "40" }));
  for (let poll = 0; poll < 9; poll++) await intake.poll(emit);
  await intake.poll(emit); // The tenth poll lists thread 40 for the first time.
  expect(intake.channels().sort()).toEqual(["20", "30", "40"]);
  expect(received).toEqual(["40:120"]);
  expect(cursors.storeFor("40").load()).toBe("120");
});

test("a thread created after startup is picked up on refresh and starts at its first message", async () => {
  const world = threadWorld([ownerMessage("100")], []);
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["20"] });
  expect(intake.channels()).toEqual(["20"]);
  world.state.guilds[0]?.threads.push("40");
  world.state.threadParents.set("40", "20");
  const received: string[] = [];
  const emit = (message: { channel: string; message: string }) =>
    received.push(`${message.channel}:${message.message}`);
  for (let poll = 0; poll < 9; poll++) await intake.poll(emit);
  expect(intake.channels()).toEqual(["20"]);
  world.state.messages.push(ownerMessage("170", { channel_id: "40" }));
  await intake.poll(emit); // The tenth poll refreshes the active-thread list.
  expect(intake.channels().sort()).toEqual(["20", "40"]);
  expect(received).toEqual(["40:170"]);
  expect(cursors.storeFor("40").load()).toBe("170");
});

test("an archived thread is dropped from polling and keeps its cursor for a later reactivation", async () => {
  const world = threadWorld([ownerMessage("200", { channel_id: "30" })], [["30", "20"]]);
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["20"] });
  expect(intake.channels().sort()).toEqual(["20", "30"]);
  world.state.guilds[0]?.threads.splice(0);
  for (let poll = 0; poll < 10; poll++) await intake.poll(() => {});
  expect(intake.channels()).toEqual(["20"]);
  expect(cursors.storeFor("30").load()).toBe("200");
  const requests = world.requests.length;
  await intake.poll(() => {});
  expect(world.requests.slice(requests).some((request) => request.url.includes("/channels/30/messages"))).toBe(false);
});

test("a thread the bot cannot read is skipped like scope-all discovery, not fatal", async () => {
  const world = threadWorld([], [["30", "20"]]);
  world.state.denied.add("30");
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["20"] });
  expect(intake.channels()).toEqual(["20"]);
  await intake.poll(() => {});
  expect(world.requests.filter((request) => request.url.includes("/channels/30/messages"))).toHaveLength(1);
});

test("CATALY_DISCORD_THREADS off watches only the configured ids", async () => {
  const world = threadWorld([ownerMessage("200", { channel_id: "30" })], [["30", "20"]]);
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, {
    ownerId: "10",
    channelIds: ["20"],
    threads: false,
  });
  expect(intake.channels()).toEqual(["20"]);
  expect(cursors.stores.has("30")).toBe(false);
});

test("a configured thread exists without its parent being watched", async () => {
  const world = threadWorld([ownerMessage("200", { channel_id: "31" })], [["31", "21"]]);
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["31"] });
  expect(intake.channels()).toEqual(["31"]);
});

test("an explicit thread keeps its strict failure and a real channel lookup error propagates", async () => {
  const world = threadWorld([], [["30", "20"]]);
  world.state.failure.set("/channels/20", 502);
  const cursors = cursorsFor();
  const error: unknown = await discordInbound(world.discord, cursors.storeFor, {
    ownerId: "10",
    channelIds: ["20"],
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(MessengerError);
  expect((error as MessengerError).status).toBe(502);
});

test("a watched text channel in a Discord category is a parent, not a thread", async () => {
  // Discord reports `parent_id` on every child channel; only thread channel types make it a thread parent.
  const world = threadWorld([ownerMessage("100"), ownerMessage("200", { channel_id: "30" })], [["30", "20"]]);
  world.state.categoryParents.set("20", "60"); // 20 sits in category 60.
  const cursors = cursorsFor();
  const intake = await discordInbound(world.discord, cursors.storeFor, { ownerId: "10", channelIds: ["20"] });
  expect(intake.channels().sort()).toEqual(["20", "30"]);
  const received: string[] = [];
  world.state.messages.push(ownerMessage("201", { channel_id: "30" }));
  await intake.poll((message) => received.push(`${message.channel}:${message.message}`));
  expect(received).toEqual(["30:201"]);
});
