import { realpathSync } from "node:fs";
import { join } from "node:path";
import { laneEntry, readPrivate, type StopReceipt, writePrivate } from "../../../../src/runtime/headless-record.ts";
import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { GoalStatus } from "./lane-state.ts";
import type { Lane } from "./registry.ts";

type LaneReceiver = {
  readonly session: string;
  readonly file: string;
  readonly cwd: string;
  readonly pid: number;
  readonly updatedAt: string;
  readonly retiredGoal?: GoalStatus;
  readonly wakeModel?: string;
};

/** Receiver readiness is opt-in activation by the native extension, not inferred from a generic OMP process. */
export function publishHeadlessDiscordReceiver(
  stateDir: string,
  ref: SessionRef,
  session: string,
  file: string,
  cwd: string,
  retiredGoal?: GoalStatus,
  wakeModel?: string,
): boolean {
  const entry = laneEntry(stateDir, ref);
  if (!entry || (entry.reservation.role ?? "lane") !== "lane" || entry.reservation.cwd !== cwd) return false;
  const path = join(entry.dir, "discord-lane.json");
  const previous = readPrivate<LaneReceiver>(path);
  if (previous && (previous.pid !== process.pid || previous.session !== session || previous.file !== file))
    return false;
  if (retiredGoal && !previous) return false;
  writePrivate(path, {
    session,
    file,
    cwd,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    retiredGoal,
    wakeModel,
  });
  return true;
}

function headlessDiscordReceiver(stateDir: string, lane: Lane) {
  const ref = lane.sessionRef;
  if (ref?.runtime !== "headless" || !lane.session || !lane.sessionFile || !lane.cwd) return;
  const entry = laneEntry(stateDir, ref);
  if (!entry) return;
  const receiver = readPrivate<LaneReceiver>(join(entry.dir, "discord-lane.json"));
  if (
    !receiver ||
    receiver.session !== lane.session ||
    receiver.file !== lane.sessionFile ||
    receiver.cwd !== realpathSync(lane.cwd) ||
    receiver.cwd !== entry.reservation.cwd ||
    !Number.isSafeInteger(receiver.pid) ||
    receiver.pid <= 0 ||
    !(Date.parse(receiver.updatedAt) >= Math.max(Date.parse(entry.reservation.startedAt), Date.parse(lane.openedAt))) ||
    Date.parse(receiver.updatedAt) > Date.now() + 1_000
  )
    return;
  const stopped = readPrivate<StopReceipt>(join(entry.dir, "stopped.json"));
  return { ref, receiver, stopped };
}

export async function headlessDiscordLaneAvailable(
  stateDir: string,
  lane: Lane,
  forDispatch = false,
): Promise<boolean> {
  const binding = headlessDiscordReceiver(stateDir, lane);
  if (!binding) return false;
  const { ref, receiver, stopped } = binding;
  if (stopped)
    return !forDispatch && stopped.closedSessionId === receiver.session && receiver.retiredGoal !== undefined;
  if (receiver.retiredGoal !== undefined) return false;
  const seen = await new HeadlessRuntime(stateDir).observe(ref);
  return (
    seen.ref.runtime === "headless" &&
    seen.ref.id === ref.id &&
    seen.detail === undefined &&
    (seen.status === "idle" || seen.status === "working" || seen.status === "blocked") &&
    seen.role === "lane" &&
    seen.pid === receiver.pid &&
    seen.sessionId === receiver.session &&
    seen.sessionFile === receiver.file &&
    seen.cwd === receiver.cwd &&
    (!forDispatch ||
      (seen.status === "idle" &&
        seen.held === false &&
        seen.dialogs.length === 0 &&
        // A newly bound launch can exist just before its kickoff. Existing resumed/woken sessions own their input.
        !(lane.lifecycleEpoch === ref.id && lane.reportProtocol === "jsonl-v1" && seen.goal?.status === "none")))
  );
}
