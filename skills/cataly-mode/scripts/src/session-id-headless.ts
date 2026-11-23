import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { PaneState } from "./lane-state.ts";
import { type ChosenRuntimes, type Runner, runtimesFor } from "./run.ts";

export const trustedHeadlessState = async (
  ref: SessionRef,
  { run, stateDir, rts }: { readonly run: Runner; readonly stateDir: string; readonly rts: ChosenRuntimes | undefined },
  requireForeground: boolean,
): Promise<PaneState | null> => {
  const runtime = (rts ?? runtimesFor({ stateDir }, process.env, run)).for(ref);
  if (!(runtime instanceof HeadlessRuntime)) return null;
  const seen = await runtime.observe(ref);
  const { pid, sessionId, sessionFile, goal, status } = seen;
  // The broker can retain transcript fields after a failed live state refresh. They do not attest a session.
  if (
    seen.ref.runtime !== ref.runtime ||
    seen.ref.id !== ref.id ||
    seen.detail !== undefined ||
    (status !== "idle" && status !== "working" && status !== "blocked") ||
    (seen.role !== "lane" && seen.role !== "cataly") ||
    (seen.role === "cataly" && seen.harnessRole !== "lead") ||
    !sessionId ||
    !sessionFile ||
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !goal ||
    (requireForeground && (seen.held !== false || seen.dialogs.length !== 0))
  )
    return null;
  return {
    paneId: ref.id,
    role: seen.role,
    sessionId,
    sessionFile,
    cwd: seen.cwd,
    pid,
    startedAt: seen.startedAt,
    updatedAt: seen.updatedAt,
    goal,
    approvalPending: seen.held,
    ...(status === "idle" || status === "working" ? { agentStatus: status } : {}),
  };
};
