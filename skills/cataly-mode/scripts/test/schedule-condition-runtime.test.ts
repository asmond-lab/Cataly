import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishCondition } from "../src/schedule-condition-finish.ts";
import { Scheduler } from "../src/scheduler.ts";
import { ScheduleStore, scheduleOutput } from "../src/schedule-store.ts";

let dir: string;
let store: ScheduleStore;
let now: number;
let scheduler: Scheduler | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cataly-condition-"));
  store = new ScheduleStore(dir);
  now = Date.parse("2026-11-23T12:00:00Z");
});
afterEach(async () => {
  await scheduler?.close();
  scheduler = undefined;
  rmSync(dir, { recursive: true, force: true });
});
const input = (code: string) => ({
  name: "watch",
  condition: { everySeconds: 30, onSuccess: "edge" as const, suppressUnchanged: true },
  argv: [process.execPath, "-e", code],
  cwd: dir,
  deliver: "wake" as const,
});
async function start(lines: string[]) {
  scheduler = new Scheduler(
    store,
    () => now,
    (line) => lines.push(line),
  );
  await scheduler.open();
  return scheduler;
}

test("real polls persist edges before delivery, separate stderr and never burst catch up", async () => {
  const code =
    "const fs=require('node:fs');const n=Number(fs.existsSync('count')?fs.readFileSync('count','utf8'):0)+1;fs.writeFileSync('count',String(n));console.log('stable');console.error('private-diagnostic');process.exit(n===3?1:0)";
  await store.add(input(code), now);
  expect(store.read().version).toBe(2);
  expect(store.read().jobs[0]?.timeoutSeconds).toBe(30);
  const lines: string[] = [];
  const runner = await start(lines);
  await runner.tick();
  await runner.settle();
  let job = store.read().jobs[0]!;
  expect(job.last).toMatchObject({ conditionFired: true, delivery: "wake-emitted" });
  expect(job.watch?.lastFiredRunId).toBe(job.last?.id);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("stable");
  expect(lines[0]).not.toContain("private-diagnostic");
  expect(readFileSync(scheduleOutput(dir, job.last!.id) + ".stderr", "utf8")).toContain("private-diagnostic");
  expect(JSON.stringify(store.read().jobs[0]?.watch)).not.toContain("stable");
  for (let i = 0; i < 3; i++) {
    now += 86_400_000;
    await runner.tick();
    await runner.settle();
  }
  expect(readFileSync(join(dir, "count"), "utf8")).toBe("4");
  expect(lines).toHaveLength(1); // Same last-fired stdout suppresses the second rising edge.
  job = store.read().jobs[0]!;
  expect(job.last?.conditionFired).toBe(false);
  expect(existsSync(scheduleOutput(dir, job.last!.id))).toBe(false);
  expect(job.nextAt).toBe(now + 30_000);
  await store.remove("watch");
  expect(store.read().version).toBe(1);
});

test("pause/resume preserves edge history, interrupted polls pause without replay", async () => {
  const job = await store.add(input("console.log('ok')"), now);
  await store.pause("watch", true, now);
  await store.pause("watch", false, now + 1000);
  expect(store.read().jobs[0]?.nextAt).toBe(now + 31_000);
  await store.update((doc) => {
    doc.jobs[0]!.last = { id: job.id, at: now, startedAt: now, status: "running", delivery: "pending" };
  });
  const runner = await start([]);
  await runner.tick();
  expect(store.read().jobs[0]).toMatchObject({ paused: true, last: { status: "interrupted" }, watch: { armed: true } });
});

test("condition schema rejects version-1 policy, mixed triggers and corrupt watch without rewriting", async () => {
  const job = await store.add(input(""), now);
  for (const [version, patch] of [
    [1, {}],
    [2, { at: now }],
    [2, { cron: "* * * * *", tz: "UTC" }],
    [2, { watch: { armed: true, consecutiveErrors: -1 } }],
    [2, { timeoutSeconds: undefined }],
  ] as const) {
    const raw = JSON.stringify({ version, jobs: [{ ...job, ...patch }], adopted: [] });
    writeFileSync(store.path, raw);
    expect(() => store.read()).toThrow();
    expect(readFileSync(store.path, "utf8")).toBe(raw);
  }
});

test("second runner cannot race a condition claim; backwards clock does not poll early", async () => {
  await store.add(input("console.log('a')"), now);
  const runner = await start([]);
  const other = new Scheduler(store, () => now);
  await expect(other.open()).rejects.toThrow("another scheduler");
  await runner.tick();
  await runner.settle();
  const cursor = store.read().jobs[0]!.nextAt;
  now -= 60_000;
  const before = readFileSync(store.path, "utf8");
  await runner.tick();
  expect(readFileSync(store.path, "utf8")).toBe(before);
  expect(store.read().jobs[0]?.nextAt).toBe(cursor);
});

test("error streak warns once, leaves edge armed, and a removed job leaves no watch inheritance", async () => {
  await store.add({ ...input(""), argv: ["/missing/cataly-probe"] }, now);
  const lines: string[] = [];
  const runner = await start(lines);
  await runner.tick();
  await runner.settle();
  now += 30_000;
  await runner.tick();
  await runner.settle();
  expect(lines).toHaveLength(1);
  expect(store.read().jobs[0]?.watch).toMatchObject({ armed: true, consecutiveErrors: 2 });
  await store.remove("watch");
  await store.add(input("console.log('new')"), now);
  expect(store.read().jobs[0]?.watch).toEqual({ armed: true, consecutiveErrors: 0 });
});

test("failed probe diagnostics are bounded to one run and exposed without stderr disclosure", async () => {
  await store.add(input("console.error('secret diagnostic'); process.exit(1)"), now);
  const lines: string[] = [];
  const runner = await start(lines);
  await runner.tick();
  await runner.settle();
  const first = store.read().jobs[0]!.last!.id;
  expect(existsSync(scheduleOutput(dir, first))).toBe(true);
  now += 30_000;
  await runner.tick();
  await runner.settle();
  const job = store.read().jobs[0]!;
  expect(job.watch?.diagnosticRunId).toBe(job.last?.id);
  expect(existsSync(scheduleOutput(dir, first))).toBe(false);
  expect(readFileSync(scheduleOutput(dir, job.last!.id) + ".stderr", "utf8")).toContain("secret diagnostic");
  expect(lines.join("")).not.toContain("secret diagnostic");
});

test("operator stop leaves watch untouched and sends no fake probe-error warning", async () => {
  await store.add(input("setInterval(() => {}, 100)"), now);
  const lines: string[] = [];
  const runner = await start(lines);
  const before = store.read().jobs[0]!.watch;
  await runner.tick();
  runner.stop();
  await runner.settle();
  expect(store.read().jobs[0]).toMatchObject({ paused: true, last: { status: "interrupted" }, watch: before });
  expect(lines).toEqual([]);
});

test("probe error recovery alerts once with metadata, not private stderr", async () => {
  await store.add({ ...input(""), argv: ["/missing/cataly-probe"] }, now);
  const lines: string[] = [];
  const runner = await start(lines);
  await runner.tick();
  await runner.settle();
  expect(lines[0]).toContain("condition probe error");
  expect(lines[0]).toContain("stderr");
  expect(lines[0]).toContain("127");
  await store.update((doc) => {
    doc.jobs[0]!.argv = [process.execPath, "-e", "process.exit(1)"];
  });
  now += 30_000;
  await runner.tick();
  await runner.settle();
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("condition probe recovered");
  now += 30_000;
  await runner.tick();
  await runner.settle();
  expect(lines).toHaveLength(2);
});

test("digest-read failure becomes a saved probe error rather than stopping all schedules", async () => {
  const job = await store.add(input(""), now);
  const completed = {
    id: job.id,
    at: now,
    startedAt: now,
    finishedAt: now,
    status: "exited" as const,
    code: 0,
    signal: null,
    delivery: "pending" as const,
  };
  await store.update((doc) => {
    doc.jobs[0]!.last = { ...completed, status: "running" };
  });
  const lines: string[] = [];
  expect(await finishCondition(store, { ...job, last: completed }, completed, (line) => lines.push(line))).toBe(false);
  expect(store.read().jobs[0]).toMatchObject({
    watch: { armed: true, consecutiveErrors: 1 },
    last: { conditionFired: false, delivery: "logged" },
  });
  expect(store.read().jobs[0]?.last?.error).toContain("stdout digest failed");
});
