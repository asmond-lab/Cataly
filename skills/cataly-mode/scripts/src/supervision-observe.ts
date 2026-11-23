import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { takeLock } from "./checkpoint-lock.ts";
import type { CatalyConfig } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type Lane, type Registry, sameLaneGeneration, statusOf } from "./registry.ts";
import type { Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";
import { writerDir } from "./supervision-activity.ts";
import type { Observation } from "./supervision-evidence-state.ts";

export type { Observation } from "./supervision-evidence-state.ts";
export { readObservation } from "./supervision-evidence-state.ts";

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly config?: Pick<CatalyConfig, "stateDir" | "sessionsDir" | "defaultCwd">;
  readonly run: Runner;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
} & (
  | { readonly registry: Registry; readonly clock: Clock }
  | { readonly registry?: undefined; readonly clock: Pick<Clock, "now"> }
);

export type SupervisionAlert = { readonly kind: "blocked" | "stalled" | "warning"; readonly detail: string };
export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly alertEvents: readonly SupervisionAlert[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
  readonly heldHung: boolean;
  readonly coverageComplete: boolean;
  readonly lastReportAt: string | null;
  readonly lastEvidenceAt: string | null;
  readonly evidenceError?: string;
  readonly observationError?: string;
  readonly observationIncomplete?: true;
  readonly busy?: true;
};

export type BudgetLimits = {
  readonly wallMinutes?: number | null | undefined;
  readonly tokens?: number | null | undefined;
  readonly costUsd?: number | null | undefined;
};
export type Usage = { readonly tokens: number | null; readonly costUsd: number | null };
export type UsageSnapshot = Usage & {
  readonly key: string;
  readonly at: string;
  readonly openedAt?: string;
  readonly final?: true;
  readonly costBasis?: string;
  readonly issues?: readonly string[];
};

/** Independent of evidence availability: a failed observation must never hide a reached ceiling. */
export const observeBudget = (options: SupervisionOptions, lane: SupervisedLane, now: number, usage: Usage) => {
  const limits = {
    wallMinutes: null,
    tokens: null,
    costUsd: null,
    ...options.defaults,
    ...options.lanes?.[lane.key],
    ...lane.budget,
  };
  const actual = { ...usage, wallMinutes: (now - Date.parse(lane.openedAt)) / 60_000 };
  const violations = (["wallMinutes", "tokens", "costUsd"] as const).flatMap((name) => {
    const ceiling = limits[name];
    const value = actual[name];
    return typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 && value !== null && value >= ceiling
      ? [`${name} ceiling reached (${ceiling})`]
      : [];
  });
  const unavailable = (["tokens", "costUsd"] as const)
    .filter((name) => typeof limits[name] === "number" && usage[name] === null)
    .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
  return { violations, unavailable };
};
export type SupervisedLane = Lane & { readonly activityPaths?: readonly string[]; readonly budget?: BudgetLimits };
export type SupervisionOptions = {
  readonly hungAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
  readonly defaults?: BudgetLimits;
  readonly lanes?: Readonly<Record<string, BudgetLimits>>;
  readonly usageArgv?: readonly string[];
  readonly usage?: "omp";
  readonly recordCostArgv?: readonly string[];
  readonly activityPaths?: readonly string[];
  readonly gitActivity?: boolean;
};
/** The sweep must not act on a paused, closed, replaced or rebound run. */
export const currentSupervisionLane = (seen: SupervisedLane, current: Lane | null): current is Lane =>
  current !== null &&
  statusOf(current) === "working" &&
  !current.nativeCloseIntent &&
  sameLaneGeneration(seen, current) &&
  current.requestId === seen.requestId &&
  current.runId === seen.runId;

/** Serialize planning, settlement and effect baselines without holding up lane delivery. */
export const withSupervisionWriter = async <T>(
  stateDir: string,
  lane: SupervisedLane,
  now: number,
  action: () => Promise<T>,
): Promise<T | undefined> => {
  const directory = writerDir(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = createHash("sha256")
    .update(JSON.stringify([lane.openedAt, lane.lifecycleEpoch, lane.requestId, lane.runId]))
    .digest("hex");
  const fail = (message: string) => new Error(`supervision writer lock ${message}`);
  const release = takeLock(resolve(directory, `${lane.key}.${identity}.lock`), now, fail, { keepLiveOwner: true });
  if (typeof release === "string") return;
  try {
    return await action();
  } finally {
    release();
  }
};

export const withCurrentSupervision = async <T>(
  deps: SupervisionDeps,
  lane: SupervisedLane,
  action: () => T | Promise<T>,
): Promise<T | undefined> => {
  if (statusOf(lane) !== "working" || lane.nativeCloseIntent) return;
  if (deps.registry === undefined) return action();
  const held = await withDeliveryLock(deps, lane.key, async () => {
    if (currentSupervisionLane(lane, await deps.registry.read(lane.key))) return action();
  });
  return held.ok ? held.value : undefined;
};

export type WorkingTimer = { readonly kind: string; readonly seconds: number; readonly step: number };
// Match only an explicit duration on a visible Working/Running line. step is the smallest unit shown, in seconds:
// "25m" is rounded to the minute, so two readings can place the same call's start up to a minute apart.
export const workingTimer = (screen: string): WorkingTimer | null => {
  for (const line of Bun.stripANSI(screen).split("\n")) {
    const kind = /^\s*[^\w\n]*(Working|Running)\b/i.exec(line)?.[1]?.toLowerCase();
    if (!kind) continue;
    const clock = /\b(\d+):(\d{2})(?::(\d{2}))?\b/.exec(line);
    if (clock) {
      const seconds =
        clock[3] === undefined
          ? Number(clock[1]) * 60 + Number(clock[2])
          : Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      return { kind, seconds, step: 1 };
    }
    const parts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi)];
    const unit = (name = ""): number => (/^h/i.test(name) ? 3600 : /^m/i.test(name) ? 60 : 1);
    if (parts.length)
      return {
        kind,
        seconds: parts.reduce((sum, match) => sum + Number(match[1]) * unit(match[2]), 0),
        step: Math.min(...parts.map((match) => unit(match[2]))),
      };
  }
  return null;
};

export const isHungTimer = (
  options: SupervisionOptions,
  previous: Observation | null,
  timer: WorkingTimer | null,
  now: number,
  activeAt: number,
): boolean =>
  previous !== null &&
  timer !== null &&
  previous.timer !== null &&
  timer.kind === previous.timerKind &&
  timer.seconds > previous.timer &&
  // The rounded timer origin distinguishes a continuing call from a new Working/Running call.
  Math.abs(now - timer.seconds * 1000 - (previous.at - previous.timer * 1000)) <= timer.step * 1000 + 2000 &&
  timer.seconds >= (options.hungAfterMinutes ?? 20) * 60 &&
  now - activeAt >= (options.staleAfterMinutes ?? 20) * 60_000;

export const timerFromScreen = (
  screen: string | null,
  now: number,
  activeSince: number | undefined,
): WorkingTimer | null => {
  if (screen === null) return null;
  if (activeSince === undefined) return workingTimer(screen);
  if (!Number.isFinite(activeSince) || activeSince < 0 || activeSince > now) return null;
  return { kind: "native working", seconds: Math.floor((now - activeSince) / 1_000), step: 1 };
};
export const parseUsage = (output: string): Usage => {
  try {
    const value: unknown = JSON.parse(output);
    const metric = (name: keyof Usage): number | null => {
      const n =
        typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : null;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
    };
    return { tokens: metric("tokens"), costUsd: metric("costUsd") };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Malformed external JSON remains unknown, never zero.
    return { tokens: null, costUsd: null };
  }
};
