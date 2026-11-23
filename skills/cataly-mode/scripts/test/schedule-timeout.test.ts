import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";
import { ScheduleStore } from "../src/schedule-store.ts";
import { scheduleTimeout } from "../src/schedule-timeout.ts";
import type { Subprocess } from "bun";
import { scheduleView } from "../src/schedule-view.ts";

let dir: string;
let store: ScheduleStore;
let scheduler: Scheduler | undefined;
const now = Date.parse("2026-11-23T12:00:00Z");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cataly-timeout-"));
  store = new ScheduleStore(dir);
});
afterEach(async () => {
  await scheduler?.close();
  scheduler = undefined;
  rmSync(dir, { recursive: true, force: true });
});
const input = (code: string) => ({
  name: "bounded",
  at: now,
  timeoutSeconds: 1,
  cwd: dir,
  argv: [process.execPath, "-e", code],
  deliver: "log" as const,
});
async function run(code: string) {
  await store.add(input(code), now - 1);
  scheduler = new Scheduler(store, () => now);
  await scheduler.open();
  await scheduler.tick();
  await scheduler.settle();
  return store.read().jobs[0]!;
}

test("a timed-out command records termination, remains consumed and exposes timed-out state", async () => {
  const job = await run("setInterval(() => {}, 100)");
  expect(job).toMatchObject({
    paused: true,
    timeoutSeconds: 1,
    last: { status: "exited", timedOut: true, delivery: "logged" },
  });
  expect(job.last?.code).not.toBe(0);
  const view = await scheduleView(store, async () => ({ code: 0, out: "", err: "" }), now);
  expect(view.jobs[0]?.state).toBe("timed-out");
  await scheduler!.tick();
  expect(store.read().jobs[0]?.last?.id).toBe(job.last?.id);
}, 10_000);

test("a fast command completes without a timeout receipt", async () => {
  const job = await run("console.log('done')");
  expect(job.last).toMatchObject({ code: 0, delivery: "logged" });
  expect(job.last?.timedOut).toBeUndefined();
});

// POSIX-only: Windows does not implement a catchable SIGTERM handler.
test.skipIf(process.platform === "win32")(
  "SIGTERM-resistant foreground child is killed after the grace period",
  async () => {
    const job = await run("process.on('SIGTERM', () => {}); setInterval(() => {}, 100)");
    expect(job.last).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  },
  15_000,
);

test.each([0, -1, 1.5, 86401, NaN, Infinity])(
  "invalid time limit is refused before persistence: %s",
  async (timeoutSeconds) => {
    await expect(store.add({ ...input(""), timeoutSeconds }, now - 1)).rejects.toThrow();
    expect(store.read().jobs).toEqual([]);
  },
);

test("corrupt timeout and timeout receipt fields fail closed without rewriting", async () => {
  const job = await store.add(input(""), now - 1);
  for (const patch of [
    { timeoutSeconds: "1" },
    { timeoutSeconds: [1] },
    { last: { id: job.id, at: now, startedAt: now, status: "running", delivery: "pending", timedOut: "true" } },
  ]) {
    const raw = JSON.stringify({ version: 1, jobs: [{ ...job, ...patch }], adopted: [] });
    writeFileSync(store.path, raw);
    expect(() => store.read()).toThrow();
    expect(readFileSync(store.path, "utf8")).toBe(raw);
  }
});

test.each([
  { exitCode: 0, signalCode: null },
  { exitCode: null, signalCode: "SIGTERM" },
])("already-ended children do not become timed out: %j", async (ended) => {
  let killed = false;
  const proc = {
    ...ended,
    kill: () => {
      killed = true;
    },
  } as unknown as Subprocess;
  const deadline = scheduleTimeout(proc, 0.001);
  try {
    await Bun.sleep(20);
    expect(deadline.expired()).toBe(false);
    expect(killed).toBe(false);
  } finally {
    deadline.clear();
  }
});

test("timeout with ambiguous delivery exposes both facts without retry", async () => {
  await store.add(input("setInterval(() => {}, 100)"), now - 1);
  scheduler = new Scheduler(
    store,
    () => now,
    () => {},
    async () => {
      throw Error("uncertain post");
    },
  );
  await scheduler.open();
  await scheduler.tick();
  await scheduler.settle();
  const view = await scheduleView(store, async () => ({ code: 0, out: "", err: "" }), now);
  expect(view.jobs[0]).toMatchObject({ state: "delivery-unknown", last: { timedOut: true, delivery: "unknown" } });
}, 10_000);
