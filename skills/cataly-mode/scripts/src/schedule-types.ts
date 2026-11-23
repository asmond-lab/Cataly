import { Cron } from "croner";
import { isAbsolute } from "node:path";
import { scheduleDestination } from "./schedule-destination.ts";
export { scheduleDestination } from "./schedule-destination.ts";
import { validateCondition, type ScheduleCondition, type ScheduleWatch } from "./schedule-condition.ts";

import { ScheduleError } from "./schedule-error.ts";
export { ScheduleError } from "./schedule-error.ts";
export type ScheduleDelivery = "wake" | "log" | `post:${string}`;
export type ScheduleRun = {
  id: string;
  at: number;
  startedAt: number;
  finishedAt?: number;
  pid?: number;
  status: "running" | "exited" | "interrupted";
  code?: number;
  signal?: string | null;
  error?: string;
  timedOut?: boolean;
  conditionFired?: boolean;
  delivery: "pending" | "logged" | "wake-emitted" | "posted" | "unknown";
  deliveryError?: string;
  receipts?: string[];
};
export type ScheduledJob = {
  id: string;
  name: string;
  cron?: string;
  tz?: string;
  at?: number;
  condition?: ScheduleCondition;
  watch?: ScheduleWatch;
  timeoutSeconds?: number;
  argv: string[];
  cwd: string;
  deliver: ScheduleDelivery;
  paused: boolean;
  nextAt: number;
  missed: number;
  last?: ScheduleRun;
};
export type AdoptedSchedule = { name: string; unit: string; system: boolean };
export type ScheduleDocument = { version: 1 | 2; jobs: ScheduledJob[]; adopted: AdoptedSchedule[] };
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const instant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
const record = (value: unknown, keys: string): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.split(" ").includes(key));

export function scheduleName(name: string): void {
  if (!NAME.test(name))
    throw new ScheduleError(
      "schedule name must be 1..128 letters, digits, dot, @, underscore or hyphen, starting with a letter or digit",
    );
}
export function systemdUnit(unit: string): void {
  if (!NAME.test(unit) || !/\.(timer|service)$/.test(unit))
    throw new ScheduleError("--systemd must name a .timer or .service unit, not a path or option");
}
export function scheduleCron(cron: string, tz: string): Cron {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new ScheduleError("invalid schedule timezone: " + tz);
  }
  if (!tz.trim()) throw new ScheduleError("schedule timezone is required");
  if (cron.trim().split(/\s+/).length !== 5 || cron.includes("?"))
    throw new ScheduleError("cron must have five fields; time-dependent ? substitution is not supported");
  try {
    return new Cron(cron, { timezone: tz, mode: "5-part", paused: true });
  } catch (error) {
    throw new ScheduleError("invalid cron: " + String(error));
  }
}
export function nextSchedule(cron: string, tz: string, after: number): number {
  const next = scheduleCron(cron, tz).nextRun(new Date(after));
  if (!next) throw new ScheduleError("cron has no future occurrence");
  return next.getTime();
}

/** One-shot instants must carry an offset; never infer the operator's local timezone. */
export function scheduleAt(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const at = Date.parse(value);
  const local = match ? Date.parse(match[1] + "T" + match[2] + "." + (match[3] ?? "0").padEnd(3, "0") + "Z") : NaN;
  if (
    !match ||
    !Number.isFinite(at) ||
    !Number.isFinite(local) ||
    new Date(local).toISOString().slice(0, 19) !== match[1] + "T" + match[2]
  )
    throw new ScheduleError("--at needs a valid ISO instant with seconds and Z or an explicit offset");
  return at;
}
export function scheduleTrigger(job: Pick<ScheduledJob, "cron" | "tz" | "at" | "condition" | "watch">): void {
  if (job.condition !== undefined) {
    if (job.at !== undefined || job.cron !== undefined || job.tz !== undefined)
      throw new ScheduleError("condition cannot be combined with at/cron/tz");
    validateCondition(job.condition, job.watch);
  } else if (job.at !== undefined) {
    if (job.watch !== undefined) throw new ScheduleError("watch requires condition");
    if (!instant(job.at) || job.cron !== undefined || job.tz !== undefined)
      throw new ScheduleError("one-shot schedules need a valid at instant without cron or tz");
  } else {
    if (job.watch !== undefined) throw new ScheduleError("watch requires condition");
    if (typeof job.cron !== "string" || typeof job.tz !== "string")
      throw new ScheduleError("cron schedules need cron and tz");
    scheduleCron(job.cron, job.tz);
  }
}

export function readScheduleDocument(value: unknown): ScheduleDocument {
  const bad = (): never => {
    throw new ScheduleError("invalid schedule.json; preserve it and repair the recorded state before running");
  };
  if (
    !record(value, "version jobs adopted") ||
    (value["version"] !== 1 && value["version"] !== 2) ||
    !Array.isArray(value["jobs"]) ||
    !Array.isArray(value["adopted"])
  )
    return bad();
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const raw of value["jobs"]) {
    if (
      !record(raw, "id name cron tz at condition watch timeoutSeconds argv cwd deliver paused nextAt missed last") ||
      typeof raw["id"] !== "string" ||
      !UUID.test(raw["id"]) ||
      ids.has(raw["id"]) ||
      typeof raw["name"] !== "string" ||
      !Array.isArray(raw["argv"]) ||
      raw["argv"].length === 0 ||
      !raw["argv"].every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
      !raw["argv"][0] ||
      typeof raw["cwd"] !== "string" ||
      !isAbsolute(raw["cwd"]) ||
      raw["cwd"].includes("\0") ||
      typeof raw["deliver"] !== "string" ||
      typeof raw["paused"] !== "boolean" ||
      (raw["timeoutSeconds"] !== undefined &&
        (!Number.isSafeInteger(raw["timeoutSeconds"]) ||
          Number(raw["timeoutSeconds"]) < 1 ||
          Number(raw["timeoutSeconds"]) > 86400)) ||
      !instant(raw["nextAt"]) ||
      !Number.isSafeInteger(raw["missed"]) ||
      Number(raw["missed"]) < 0
    )
      return bad();
    scheduleName(raw["name"]);
    if (names.has(raw["name"])) return bad();
    names.add(raw["name"]);
    ids.add(raw["id"]);
    scheduleTrigger(raw as unknown as ScheduledJob);
    if (raw["condition"] !== undefined && (value["version"] !== 2 || raw["timeoutSeconds"] === undefined)) return bad();
    if (raw["condition"] === undefined && raw["watch"] !== undefined) return bad();
    if (raw["at"] !== undefined && raw["at"] !== raw["nextAt"]) return bad();
    scheduleDestination(raw["deliver"]);
    if (raw["last"] !== undefined) {
      const last = raw["last"];
      if (
        !record(
          last,
          "id at startedAt finishedAt pid status code signal error timedOut conditionFired delivery deliveryError receipts",
        ) ||
        typeof last["id"] !== "string" ||
        !UUID.test(last["id"]) ||
        !instant(last["at"]) ||
        !instant(last["startedAt"]) ||
        typeof last["status"] !== "string" ||
        !["running", "exited", "interrupted"].includes(last["status"]) ||
        typeof last["delivery"] !== "string" ||
        !["pending", "logged", "wake-emitted", "posted", "unknown"].includes(last["delivery"]) ||
        (last["finishedAt"] !== undefined && !instant(last["finishedAt"])) ||
        (last["pid"] !== undefined && (!Number.isSafeInteger(last["pid"]) || Number(last["pid"]) <= 0)) ||
        (last["code"] !== undefined && (!Number.isSafeInteger(last["code"]) || Number(last["code"]) < 0)) ||
        (last["signal"] !== undefined && last["signal"] !== null && typeof last["signal"] !== "string") ||
        (last["conditionFired"] !== undefined &&
          (value["version"] !== 2 || typeof last["conditionFired"] !== "boolean")) ||
        (last["timedOut"] !== undefined && typeof last["timedOut"] !== "boolean") ||
        (last["error"] !== undefined && typeof last["error"] !== "string") ||
        (last["deliveryError"] !== undefined && typeof last["deliveryError"] !== "string") ||
        (last["receipts"] !== undefined &&
          (!Array.isArray(last["receipts"]) || !last["receipts"].every((r) => typeof r === "string")))
      )
        return bad();
      if (last["status"] === "exited" && (last["finishedAt"] === undefined || last["code"] === undefined)) return bad();
    }
  }
  for (const raw of value["adopted"]) {
    if (
      !record(raw, "name unit system") ||
      typeof raw["name"] !== "string" ||
      typeof raw["unit"] !== "string" ||
      typeof raw["system"] !== "boolean"
    )
      return bad();
    scheduleName(raw["name"]);
    systemdUnit(raw["unit"]);
    if (names.has(raw["name"])) return bad();
    names.add(raw["name"]);
  }
  return value as ScheduleDocument;
}
