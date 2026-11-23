import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { Discord } from "../src/messenger/discord.ts";
import { inboundRequest } from "../src/messenger/discord-inbound-api.ts";
import { fetchHttp, withBackoff } from "../src/messenger/http.ts";
import { fakeClock } from "./fakes.ts";

test("owned metadata cancellation aborts an actual loopback fetch and closes its unfinished response", async () => {
  const entered = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  let requests = 0;
  let unfinished = false;
  const server = createServer((_request, response) => {
    requests++;
    response.once("close", () => {
      unfinished = !response.writableEnded;
      disconnected.resolve();
    });
    entered.resolve(); // Deliberately do not produce a response body.
  });
  const controller = new AbortController();
  const reason = new Error("owned metadata stop");
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server has no TCP address");
    const request = inboundRequest(new Discord(fetchHttp, fakeClock(0), "offline", `http://127.0.0.1:${address.port}`));
    const outcome = request("/channels/50", undefined, controller.signal).catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    await disconnected.promise;
    expect(requests).toBe(1);
    expect(unfinished).toBe(true);
  } finally {
    controller.abort(reason);
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  }
});

test("optional HTTP backoff cancellation clears its owned wait without changing nonsignaled clock behavior", async () => {
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("owned backoff stop");
  let attempts = 0;
  const outcome = withBackoff(
    async () => {
      attempts++;
      entered.resolve();
      return { status: 429, headers: { "retry-after": "60" }, body: "{}" };
    },
    {
      now: () => 0,
      sleep: async () => {
        throw new Error("uncancellable clock sleep used");
      },
    },
    {
      method: "GET",
      url: "http://127.0.0.1/unused",
      signal: controller.signal,
    },
  ).catch((error: unknown) => error);
  await entered.promise;
  controller.abort(reason);
  expect(await outcome).toBe(reason);
  expect(attempts).toBe(1);
  const waits: number[] = [];
  const clock = {
    now: () => 0,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
  let ordinary = 0;
  const response = await withBackoff(
    async () => ({
      status: ++ordinary === 1 ? 429 : 200,
      headers: {},
      body: "{}",
    }),
    clock,
    { method: "GET", url: "http://127.0.0.1/unused" },
  );
  expect(response.status).toBe(200);
  expect(waits).toEqual([1000]);
});

test("request normalization does not convert an unrelated AbortError into a transient network retry", async () => {
  const fault = new DOMException("unrelated transport abort", "AbortError");
  const request = inboundRequest(
    new Discord(
      async () => {
        throw fault;
      },
      fakeClock(0),
      "offline",
    ),
  );
  expect(await request("/channels/50", undefined, new AbortController().signal).catch((error: unknown) => error)).toBe(
    fault,
  );
});
