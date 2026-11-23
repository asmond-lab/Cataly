import type { Runner } from "./run.ts";
import { scheduleOutput, ScheduleStore } from "./schedule-store.ts";
import type { ScheduledJob } from "./schedule-types.ts";
import { observeSystemd } from "./schedule-systemd.ts";

function scheduleState(job: ScheduledJob): string {
  if (job.at !== undefined) {
    if (job.last?.status === "running") return "running";
    if (job.last?.status === "interrupted") return "interrupted";
    if (job.last?.delivery === "pending") return "delivering";
    if (job.last?.delivery === "unknown") return "delivery-unknown";
    if (job.last?.timedOut) return "timed-out";
    if (job.last) return job.last.code === 0 ? "completed" : "failed";
    if (job.missed > 0) return "missed";
  }
  return job.paused ? "paused" : "scheduled";
}

export async function scheduleView(store: Pick<ScheduleStore, "read" | "stateDir">, run: Runner, now: number) {
  const document = store.read();
  const adopted = [];
  for (const entry of document.adopted) {
    try {
      adopted.push(await observeSystemd(entry, run, now));
    } catch (error) {
      adopted.push({ ...entry, observedAt: new Date(now).toISOString(), error: String(error), readOnly: true });
    }
  }
  return {
    jobs: document.jobs.map((job) => ({
      ...job,
      state: scheduleState(job),
      ...(job.watch?.diagnosticRunId
        ? {
            diagnostic: {
              output: scheduleOutput(store.stateDir, job.watch.diagnosticRunId),
              stderr: scheduleOutput(store.stateDir, job.watch.diagnosticRunId) + ".stderr",
            },
          }
        : {}),
      next: job.paused ? null : new Date(job.nextAt).toISOString(),
      ...(job.last
        ? {
            last: {
              ...job.last,
              ...(job.last.conditionFired === false && job.watch?.diagnosticRunId !== job.last.id
                ? {}
                : { output: scheduleOutput(store.stateDir, job.last.id) }),
              ...(job.condition && (job.last.conditionFired !== false || job.watch?.diagnosticRunId === job.last.id)
                ? { stderr: scheduleOutput(store.stateDir, job.last.id) + ".stderr" }
                : {}),
              pidIsLive: "unverified",
            },
          }
        : {}),
    })),
    adopted,
  };
}
export async function scheduleBoot(
  stateDir: string,
  run: Runner,
  now: number,
): Promise<{ lines: string[]; failed: boolean }> {
  try {
    const view = await scheduleView(new ScheduleStore(stateDir), run, now);
    const lines = view.jobs.map(
      (job) =>
        "SCHEDULE " +
        job.name +
        (job.at === undefined ? "" : " state=" + job.state) +
        " paused=" +
        job.paused +
        " next=" +
        (job.next ?? "paused") +
        " last=" +
        (job.last?.status ?? "never") +
        " delivery=" +
        (job.last?.delivery ?? "none") +
        " missed=" +
        job.missed,
    );
    for (const unit of view.adopted) lines.push("SCHEDULE_SYSTEMD " + JSON.stringify(unit));
    return { lines, failed: view.adopted.some((entry) => "error" in entry) };
  } catch (error) {
    return { lines: ["SCHEDULES unreadable: " + String(error)], failed: true };
  }
}
