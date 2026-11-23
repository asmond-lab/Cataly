import { randomUUID } from "node:crypto";
import {
  nextSchedule,
  readScheduleDocument,
  ScheduleError,
  scheduleTrigger,
  type ScheduledJob,
} from "./schedule-types.ts";

export type ScheduleInput = Pick<
  ScheduledJob,
  "name" | "cron" | "tz" | "at" | "condition" | "timeoutSeconds" | "argv" | "cwd" | "deliver"
>;
/** Build and validate without touching state or spawning the command. */
export function prepareSchedule(input: ScheduleInput, now: number): ScheduledJob {
  const watch = input.condition === undefined ? {} : { watch: { armed: true, consecutiveErrors: 0 } };
  scheduleTrigger({ ...input, ...watch });
  if (input.at !== undefined && input.at <= now) throw new ScheduleError("--at must be in the future");
  const job: ScheduledJob = {
    ...input,
    ...watch,
    ...(input.condition === undefined ? {} : { timeoutSeconds: input.timeoutSeconds ?? 30 }),
    id: randomUUID(),
    paused: false,
    nextAt: input.condition === undefined ? (input.at ?? nextSchedule(input.cron!, input.tz!, now)) : now,
    missed: 0,
  };
  readScheduleDocument({ version: job.condition === undefined ? 1 : 2, jobs: [job], adopted: [] });
  return job;
}
/** An at job has one instant; condition times are ideal idle poll estimates, not promises. */
export function schedulePreview(job: ScheduledJob, count = 5): number[] {
  const times = [job.nextAt];
  if (job.at !== undefined) return times;
  while (times.length < count) {
    const previous = times.at(-1)!;
    times.push(
      job.condition === undefined
        ? nextSchedule(job.cron!, job.tz!, previous)
        : previous + job.condition.everySeconds * 1000,
    );
  }
  return times;
}
