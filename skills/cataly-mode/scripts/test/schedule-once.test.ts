import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "../src/schedule-store.ts";
import { Scheduler } from "../src/scheduler.ts";
import { scheduleView, scheduleBoot } from "../src/schedule-view.ts";
import { scheduleAt } from "../src/schedule-types.ts";

let dir: string;
let store: ScheduleStore;
let runner: Scheduler | undefined;
const now = Date.parse("2026-11-23T10:00:00Z");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cataly-schedule-once-"));
  store = new ScheduleStore(dir);
});
afterEach(async () => {
  await runner?.close();
  runner = undefined;
  rmSync(dir, { recursive: true, force: true });
});
const input = () => ({
  name: "once",
  at: now,
  argv: [process.execPath, "-e", "require('node:fs').appendFileSync('runs', 'x')"],
  cwd: dir,
  deliver: "log" as const,
});
async function start(clock = now, lines: string[] = []) {
  runner = new Scheduler(
    store,
    () => clock,
    (line) => lines.push(line),
  );
  await runner.open();
  return runner;
}

test("one-shot claims are durable, execute once and cannot be resumed after restart", async () => {
  await store.add(input(), now - 1);
  const first = await start();
  await first.tick();
  await first.settle();
  expect(store.read().jobs[0]).toMatchObject({
    paused: true,
    at: now,
    nextAt: now,
    last: { at: now, status: "exited", code: 0, delivery: "logged" },
  });
  await first.close();
  const second = await start();
  await second.tick();
  await second.settle();
  expect(readFileSync(join(dir, "runs"), "utf8")).toBe("x");
  await expect(store.pause("once", false, now)).rejects.toThrow("consumed");
});

test("stale one-shots are counted once and never replayed", async () => {
  await store.add(input(), now - 1);
  const lines: string[] = [];
  const clock = await start(now + 60_000, lines);
  await clock.tick();
  await clock.tick();
  expect(store.read().jobs[0]).toMatchObject({ paused: true, missed: 1 });
  expect(store.read().jobs[0]?.last).toBeUndefined();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("SCHEDULE_ERROR");
  expect(lines[0]).toContain("one-shot missed");
  await expect(store.pause("once", false, now + 60_000)).rejects.toThrow("consumed");
});

test("paused future one-shots retain their instant; expired paused jobs cannot resume", async () => {
  await store.add(input(), now - 1000);
  await store.pause("once", true, now - 900);
  await store.pause("once", false, now - 800);
  expect(store.read().jobs[0]).toMatchObject({ nextAt: now, paused: false });
  await store.pause("once", true, now - 700);
  await expect(store.pause("once", false, now + 1)).rejects.toThrow("past");
});

test("invalid instants and conflicting trigger records fail closed", async () => {
  for (const value of ["2026-11-23T10:00:00", "tomorrow", "2026-02-30T00:00:00Z", "2026-11-23T25:00:00Z"]) {
    expect(() => scheduleAt(value)).toThrow();
  }
  expect(scheduleAt("2026-11-23T19:00:00+09:00")).toBe(now);
  expect(scheduleAt("2026-11-23T10:00:00.123Z")).toBe(now + 123);
  await expect(store.add(input(), now)).rejects.toThrow("future");
  const job = await store.add(input(), now - 1);
  for (const patch of [{ cron: "* * * * *", tz: "UTC" }, { at: -1 }, { nextAt: now + 1 }, { at: [now] }]) {
    const raw = JSON.stringify({ version: 1, jobs: [{ ...job, ...patch }], adopted: [] });
    writeFileSync(store.path, raw);
    expect(() => store.read()).toThrow();
    expect(readFileSync(store.path, "utf8")).toBe(raw);
  }
});

test("future one-shots stay idle until their instant", async () => {
  await store.add(input(), now - 1000);
  const clock = await start(now - 1);
  const before = readFileSync(store.path, "utf8");
  await clock.tick();
  await clock.settle();
  expect(readFileSync(store.path, "utf8")).toBe(before);
});

test("interrupted one-shot claims never replay even with acknowledgement", async () => {
  const job = await store.add(input(), now - 1);
  await store.update((document) => {
    document.jobs[0]!.paused = true;
    document.jobs[0]!.last = { id: job.id, at: now, startedAt: now, status: "running", delivery: "pending" };
  });
  const clock = await start();
  await clock.tick();
  expect(store.read().jobs[0]).toMatchObject({ paused: true, last: { status: "interrupted", delivery: "unknown" } });
  await expect(store.pause("once", false, now, true)).rejects.toThrow("consumed");
});

test("59-second-late one-shots still run and expose a completed state", async () => {
  await store.add(input(), now - 1);
  const clock = await start(now + 59_999);
  await clock.tick();
  await clock.settle();
  const run = async () => ({ code: 0, out: "", err: "" });
  expect((await scheduleView(store, run, now)).jobs[0]).toMatchObject({ state: "completed", next: null });
  expect((await scheduleBoot(dir, run, now)).lines[0]).toContain("state=completed");
  expect(readFileSync(join(dir, "runs"), "utf8")).toBe("x");
});

test("missed and user-paused one-shots have different visible states", async () => {
  await store.add(input(), now - 1);
  const run = async () => ({ code: 0, out: "", err: "" });
  await store.pause("once", true, now - 1);
  expect((await scheduleView(store, run, now)).jobs[0]?.state).toBe("paused");
  await store.pause("once", false, now - 1);
  const clock = await start(now + 60_000);
  await clock.tick();
  expect((await scheduleView(store, run, now)).jobs[0]?.state).toBe("missed");
  await store.remove("once");
  expect(store.read().jobs).toEqual([]);
});

test.each([
  { argv: [process.execPath, "-e", "process.exit(7)"], code: 7 },
  { argv: ["/missing/cataly-command"], code: 127 },
])("one-shot command failures remain consumed: %j", async ({ argv, code }) => {
  await store.add({ ...input(), argv: [...argv] }, now - 1);
  const clock = await start();
  await clock.tick();
  await clock.settle();
  await clock.tick();
  expect(store.read().jobs[0]).toMatchObject({ paused: true, last: { code, status: "exited" } });
  const run = async () => ({ code: 0, out: "", err: "" });
  expect((await scheduleView(store, run, now)).jobs[0]?.state).toBe("failed");
});

test("unknown delivery stays distinct from command failure and is never retried", async () => {
  await store.add(input(), now - 1);
  runner = new Scheduler(
    store,
    () => now,
    () => {},
    async () => {
      throw new Error("ambiguous delivery");
    },
  );
  await runner.open();
  await runner.tick();
  await runner.settle();
  await runner.tick();
  const run = async () => ({ code: 0, out: "", err: "" });
  expect((await scheduleView(store, run, now)).jobs[0]).toMatchObject({
    state: "delivery-unknown",
    last: { code: 0, delivery: "unknown" },
  });
  expect((await scheduleBoot(dir, run, now)).lines[0]).toContain("state=delivery-unknown");
  expect(readFileSync(join(dir, "runs"), "utf8")).toBe("x");
});
