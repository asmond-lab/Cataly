import { expect, test } from "bun:test";
import { conditionResult, runOutcome, validateCondition, type ScheduleWatch } from "../src/schedule-condition.ts";
import type { ScheduleRun } from "../src/schedule-types.ts";
const policy = { everySeconds: 30, onSuccess: "edge" as const, suppressUnchanged: false };
const fresh = (): ScheduleWatch => ({ armed: true, consecutiveErrors: 0 });
const receipt = (code = 0, patch: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: "12345678-1234-1234-1234-123456789abc",
  at: 1,
  startedAt: 1,
  finishedAt: 2,
  status: "exited",
  code,
  signal: null,
  delivery: "pending",
  ...patch,
});

test("initial success fires, repeated success holds, normal failure rearms", () => {
  let next = conditionResult(policy, fresh(), receipt(), "a");
  expect(next.fire).toBe(true);
  next = conditionResult(policy, next.watch, receipt(), "b");
  expect(next.fire).toBe(false);
  next = conditionResult(policy, next.watch, receipt(1), "");
  expect(next.watch.armed).toBe(true);
  next = conditionResult(policy, next.watch, receipt(), "c");
  expect(next.fire).toBe(true);
});

test("errors neither rearm nor consume initial edge; alert once per consecutive-error streak", () => {
  let next = conditionResult(policy, fresh(), receipt(1, { timedOut: true }), "");
  expect(next).toMatchObject({ fire: false, warn: true, watch: { armed: true, consecutiveErrors: 1 } });
  next = conditionResult(policy, next.watch, receipt(127, { error: "spawn failed" }), "");
  expect(next.warn).toBe(false);
  next = conditionResult(policy, next.watch, receipt(), "a");
  expect(next.fire).toBe(true);
  next = conditionResult(policy, next.watch, receipt(143, { signal: "SIGTERM" }), "");
  expect(next).toMatchObject({ warn: true, watch: { armed: false } });
  expect(conditionResult(policy, next.watch, receipt(), "b").fire).toBe(false);
});

test("every-success compares the last fired digest including A-B-A and empty stdout", () => {
  const p = { ...policy, onSuccess: "every" as const, suppressUnchanged: true };
  let watch = fresh();
  for (const [digest, fire] of [
    ["a", true],
    ["a", false],
    ["b", true],
    ["a", true],
    ["", true],
    ["", false],
  ] as const) {
    const next = conditionResult(p, watch, receipt(), digest);
    expect(next.fire).toBe(fire);
    watch = next.watch;
  }
});

test("a suppressed rising edge is still consumed until a normal failure", () => {
  const p = { ...policy, suppressUnchanged: true };
  let next = conditionResult(p, fresh(), receipt(), "a");
  next = conditionResult(p, next.watch, receipt(1), "");
  next = conditionResult(p, next.watch, receipt(), "a");
  expect(next.fire).toBe(false);
  expect(conditionResult(p, next.watch, receipt(), "b").fire).toBe(false);
  next = conditionResult(p, next.watch, receipt(1), "");
  expect(conditionResult(p, next.watch, receipt(), "b").fire).toBe(true);
});

test("policy and watch reject unknown keys, malformed counts and enum arrays", () => {
  for (const patch of [
    { everySeconds: 0 },
    { everySeconds: 29 },
    { everySeconds: 1.5 },
    { onSuccess: ["edge"] },
    { suppressUnchanged: "true" },
    { extra: true },
  ])
    expect(() => validateCondition({ ...policy, ...patch }, fresh())).toThrow();
  for (const patch of [
    { armed: [] },
    { consecutiveErrors: -1 },
    { lastDigest: "not-a-digest" },
    { lastFiredRunId: "../" },
    { lastCheckedAt: -1 },
  ])
    expect(() => validateCondition(policy, { ...fresh(), ...patch })).toThrow();
  expect(runOutcome(receipt())).toBe("ok");
  expect(runOutcome(receipt(1))).toBe("fail");
  expect(runOutcome(receipt(0, { timedOut: true }))).toBe("error");
});
