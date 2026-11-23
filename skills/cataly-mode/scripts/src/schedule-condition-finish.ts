import { rmSync } from "node:fs";
import { conditionResult, runOutcome, stdoutDigest } from "./schedule-condition.ts";
import { scheduleOutput, type ScheduleStore } from "./schedule-store.ts";
import { ScheduleError, type ScheduledJob, type ScheduleRun } from "./schedule-types.ts";

/** Save the edge/digest and consumption receipt together before attempting any delivery. */
export async function finishCondition(
  store: ScheduleStore,
  job: ScheduledJob,
  completed: ScheduleRun,
  emit: (line: string) => unknown,
): Promise<boolean> {
  const output = scheduleOutput(store.stateDir, completed.id);
  let digest = "";
  try {
    digest = await stdoutDigest(output);
  } catch (cause) {
    completed = { ...completed, error: "stdout digest failed: " + String(cause) };
  }
  const outcome = runOutcome(completed);
  const decision = await store.update((document) => {
    const current = document.jobs.find((entry) => entry.id === job.id);
    if (!current || current.last?.id !== completed.id) throw new ScheduleError("condition claim changed");
    const recovered = current.watch!.consecutiveErrors > 0 && outcome !== "error";
    const previousDiagnostic = current.watch!.diagnosticRunId;
    const result = conditionResult(current.condition!, current.watch!, completed, digest);
    if (outcome !== "ok") result.watch.diagnosticRunId = completed.id;
    current.watch = result.watch;
    current.nextAt = Math.max(completed.finishedAt!, current.nextAt) + current.condition!.everySeconds * 1000;
    current.last = { ...completed, conditionFired: result.fire, delivery: result.fire ? "pending" : "logged" };
    return { ...result, recovered, previousDiagnostic };
  });
  if (decision.warn || decision.recovered)
    await emit(
      "SCHEDULE_ERROR " +
        JSON.stringify({
          name: job.name,
          reason: decision.recovered ? "condition probe recovered" : "condition probe error",
          run: completed.id,
          code: completed.code,
          signal: completed.signal,
          timedOut: completed.timedOut ?? false,
          error: completed.error,
          ...(decision.recovered ? {} : { output, stderr: output + ".stderr" }),
          retried: false,
        }),
    );
  if (outcome !== "ok" && decision.previousDiagnostic && decision.previousDiagnostic !== completed.id) {
    const previous = scheduleOutput(store.stateDir, decision.previousDiagnostic);
    rmSync(previous, { force: true });
    rmSync(previous + ".stderr", { force: true });
  }
  if (!decision.fire && outcome === "ok") {
    rmSync(output, { force: true });
    rmSync(output + ".stderr", { force: true });
  }
  return decision.fire;
}

export async function interruptCondition(
  store: ScheduleStore,
  job: ScheduledJob,
  completed: ScheduleRun,
): Promise<void> {
  await store.update((document) => {
    const current = document.jobs.find((entry) => entry.id === job.id);
    if (!current || current.last?.id !== completed.id) throw new ScheduleError("condition claim changed during stop");
    current.paused = true;
    current.last = {
      ...completed,
      status: "interrupted",
      delivery: "unknown",
      error: "scheduler stopped; probe outcome not applied",
    };
  });
}
