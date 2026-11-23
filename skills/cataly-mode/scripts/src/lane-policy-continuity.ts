import { readFileSync, realpathSync } from "node:fs";
import { object } from "../../../../src/runtime/headless-protocol.ts";
import { isDiscordWakePending } from "./discord-lane-wake-pending.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type BoundPolicy, policyBinding } from "./lane-policy-store.ts";
import { runContext } from "./lane-run.ts";
import { resumeFile } from "./lifecycle-session.ts";
import { type Lane, sessionOf } from "./registry.ts";
import { Reports } from "./reports.ts";
import { runtimesOf } from "./run.ts";
import { isCatalyEntry } from "./session-compat.ts";
import { trustedPaneState } from "./session-id.ts";

function activePolicyBinding(file: string, session: string): unknown {
  const entries = new Map<string, { entry: Record<string, unknown>; parent: string | null }>();
  let header = false;
  let leaf: string | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = object(JSON.parse(line));
    if (!entry) return;
    if (entry["type"] === "session") {
      if (header || entry["id"] !== session) return;
      header = true;
      continue;
    }
    if (!header && entry["type"] !== "title") return;
    const id = entry["id"];
    const parent = entry["parentId"];
    const activeLeafId = entry["activeLeafId"];
    if (typeof id !== "string" || (parent !== null && typeof parent !== "string")) continue;
    if (entries.has(id)) return;
    entries.set(id, { entry, parent });
    leaf = activeLeafId === null || typeof activeLeafId === "string" ? activeLeafId : id;
  }
  if (!header) return;
  const seen = new Set<string>();
  while (leaf !== null) {
    const found = entries.get(leaf);
    if (!found || seen.has(leaf)) return;
    seen.add(leaf);
    const { entry, parent } = found;
    if (entry["type"] === "custom" && isCatalyEntry(entry["customType"], "omp-cataly:lane-policy"))
      return entry["data"];
    leaf = parent;
  }
}

/** Reopen/wake may preserve the exact protected OMP transcript while rotating the report generation and run. */
export async function verifiedPolicyContinuation(deps: FlowDeps, lane: Lane, policy: BoundPolicy): Promise<boolean> {
  const { session, sessionFile } = lane;
  const ref = sessionOf(lane);
  const prior = policy.snapshot.provenance;
  if (
    !ref ||
    !session ||
    !sessionFile ||
    lane.nativeCloseIntent ||
    isDiscordWakePending(lane.lifecycleEpoch) ||
    prior?.requestId !== lane.requestId
  )
    return false;
  try {
    const live = await trustedPaneState(deps.run, deps.config.stateDir, ref, runtimesOf(deps));
    if (
      live?.role !== "lane" ||
      live.sessionId !== session ||
      !live.sessionFile ||
      realpathSync(live.cwd) !== realpathSync(lane.cwd ?? deps.config.defaultCwd)
    )
      return false;
    const file = await resumeFile(deps, lane);
    if (realpathSync(live.sessionFile) !== file || activePolicyBinding(file, session) !== policyBinding(policy))
      return false;
    if (prior === undefined) return true;

    const reports = new Reports(deps.config.stateDir);
    const source = runContext(reports, lane, prior.runId);
    const current = runContext(reports, lane, lane.runId);
    const target = current?.provenance?.nativeRef;
    return (
      source?.generation === policy.snapshot.generation &&
      source?.provenance?.nativeRef?.sessionId === session &&
      current?.generation === lane.lifecycleEpoch &&
      target?.sessionId === session &&
      target.ref.runtime === ref.runtime &&
      target.ref.id === ref.id
    );
  } catch {
    return false; // Missing native ownership, corrupt transcript or report evidence never authorizes a grant.
  }
}
