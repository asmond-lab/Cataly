import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ScheduleError } from "./schedule-error.ts";
import type { ScheduleRun } from "./schedule-types.ts";

export type ScheduleCondition = { everySeconds: number; onSuccess: "edge" | "every"; suppressUnchanged: boolean };
export type ScheduleWatch = {
  armed: boolean;
  lastOk?: boolean;
  lastDigest?: string;
  lastCheckedAt?: number;
  lastFiredRunId?: string;
  diagnosticRunId?: string;
  consecutiveErrors: number;
};
export function validateCondition(condition: unknown, watch: unknown): void {
  const object = (v: unknown, keys: string): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => keys.split(" ").includes(k));
  const bad = (): never => {
    throw new ScheduleError("invalid conditional schedule policy or watch state");
  };
  if (
    !object(condition, "everySeconds onSuccess suppressUnchanged") ||
    !Number.isSafeInteger(condition["everySeconds"]) ||
    Number(condition["everySeconds"]) < 30 ||
    Number(condition["everySeconds"]) > 86400 ||
    (condition["onSuccess"] !== "edge" && condition["onSuccess"] !== "every") ||
    typeof condition["suppressUnchanged"] !== "boolean"
  )
    bad();
  if (
    !object(watch, "armed lastOk lastDigest lastCheckedAt lastFiredRunId diagnosticRunId consecutiveErrors") ||
    typeof watch["armed"] !== "boolean" ||
    !Number.isSafeInteger(watch["consecutiveErrors"]) ||
    Number(watch["consecutiveErrors"]) < 0 ||
    (watch["lastOk"] !== undefined && typeof watch["lastOk"] !== "boolean") ||
    (watch["lastDigest"] !== undefined &&
      (typeof watch["lastDigest"] !== "string" || !/^[a-f0-9]{64}$/.test(watch["lastDigest"]))) ||
    (watch["lastCheckedAt"] !== undefined &&
      (!Number.isSafeInteger(watch["lastCheckedAt"]) || Number(watch["lastCheckedAt"]) < 0)) ||
    (watch["lastFiredRunId"] !== undefined &&
      (typeof watch["lastFiredRunId"] !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(watch["lastFiredRunId"]))) ||
    (watch["diagnosticRunId"] !== undefined &&
      (typeof watch["diagnosticRunId"] !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(watch["diagnosticRunId"])))
  )
    bad();
}
export function runOutcome(run: ScheduleRun): "ok" | "fail" | "error" {
  if (run.status !== "exited" || run.timedOut || run.error || run.signal || run.code === undefined) return "error";
  return run.code === 0 ? "ok" : "fail";
}
export async function stdoutDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
/** Persist this decision with the receipt before outward delivery. Digest compares exact stdout bytes. */
export function conditionResult(condition: ScheduleCondition, before: ScheduleWatch, run: ScheduleRun, digest: string) {
  const watch = { ...before, lastCheckedAt: run.finishedAt! };
  const outcome = runOutcome(run);
  if (outcome === "error") {
    watch.consecutiveErrors++;
    return { watch, fire: false, warn: watch.consecutiveErrors === 1 };
  }
  watch.consecutiveErrors = 0;
  watch.lastOk = outcome === "ok";
  if (outcome === "fail") {
    watch.armed = true;
    return { watch, fire: false, warn: false };
  }
  const eligible = condition.onSuccess === "every" || watch.armed;
  watch.armed = false;
  const fire = eligible && (!condition.suppressUnchanged || watch.lastDigest !== digest);
  if (fire) {
    watch.lastDigest = digest;
    watch.lastFiredRunId = run.id;
  }
  return { watch, fire, warn: false };
}
