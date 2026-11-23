// The boot checks a fresh lead cannot make by itself (#188): a workspace filter that matches no lane, and lanes whose
// session is gone while the registry still calls them open. Each finding is one line and fails the boot.
import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { formatRef, type RuntimeKind, type SessionInfo, type SessionRef } from "../../../../src/runtime/types.ts";
import type { CatalyConfig } from "./config.ts";
import { type BootLane, finished } from "./boot-monitors.ts";
import { reconcilePanes } from "./reconcile.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import type { ChosenRuntimes, Runner } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { ALIVE_STATUSES, listSessions } from "./sessions.ts";

/** Runtimes whose sessions sit in workspaces that `config.workspaces` filters on. hc has none: its group is a label. */
const WORKSPACE_RUNTIMES: ReadonlySet<RuntimeKind> = new Set(["herdr"]);

/**
 * `CONFIG_WARN` when the workspace filter (`dead-panes`, `sync`) would see none of the lanes: `config.workspaces` does
 * not include `laneWorkspace`, or live agent sessions exist (in `laneWorkspace` when set) and none is in
 * `config.workspaces`. Only on a selected runtime that has workspaces; an empty filter watches everything.
 */
export const workspaceCheck = (
  config: Pick<CatalyConfig, "workspaces" | "laneWorkspace" | "leadPane" | "ignorePanes">,
  kind: RuntimeKind | undefined,
  sessions: readonly SessionInfo[] | null,
): string[] => {
  if (kind === undefined || !WORKSPACE_RUNTIMES.has(kind) || config.workspaces.length === 0) return [];
  const filter = `workspaces=[${config.workspaces.join(",")}]`;
  if (config.laneWorkspace && !config.workspaces.includes(config.laneWorkspace))
    return [`CONFIG_WARN ${filter} does not include laneWorkspace=${config.laneWorkspace}`];
  if (!sessions) return [];
  const skip = new Set([config.leadPane, ...config.ignorePanes].filter(Boolean));
  const agents = sessions.filter(
    (s) =>
      s.ref.runtime === kind &&
      !skip.has(s.ref.id) &&
      s.status !== undefined &&
      ALIVE_STATUSES.has(s.status) &&
      (!config.laneWorkspace || s.ref.group === config.laneWorkspace),
  );
  if (agents.length === 0 || agents.some((s) => config.workspaces.includes(s.ref.group ?? ""))) return [];
  const where = config.laneWorkspace ? `in laneWorkspace=${config.laneWorkspace}` : `on ${kind}`;
  return [`CONFIG_WARN ${filter} match none of the ${agents.length} live agent sessions ${where}`];
};

/**
 * `DRIFT n=<count>`: lanes not finished (closed, verified-done, or a done report, the lanes VANISHED skips too) whose session the runtime's own probe reports `gone`. Only lanes the session list
 * no longer shows are probed, so a live lane costs no extra call; a probe that fails is named. Any drift or failed probe fails the boot.
 */
export const driftCheck = async (
  rts: Runtimes,
  lanes: readonly BootLane[],
  sessions: readonly SessionInfo[],
): Promise<{ readonly lines: string[]; readonly failed: boolean }> => {
  const live = new Set(sessions.map((s) => `${s.ref.runtime}:${s.ref.id}`));
  const gone: string[] = [];
  const lines: string[] = [];
  let failed = false;
  for (const lane of lanes) {
    const ref = sessionOf(lane);
    if (!ref || finished(lane) || live.has(`${ref.runtime}:${ref.id}`)) continue;
    try {
      if ((await rts.for(ref).probe(ref)).status === "gone") gone.push(lane.key);
    } catch (e) {
      failed = true;
      lines.push(`DRIFT probe-failed ${lane.key} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return {
    lines: [`DRIFT n=${gone.length}${gone.length ? ` ${gone.join(" ")}` : ""}`, ...lines],
    failed: failed || gone.length > 0,
  };
};

export const bootSessions = async (
  run: Runner,
  config: CatalyConfig,
  rts: ChosenRuntimes,
  registered: readonly Lane[],
  lanes: readonly BootLane[],
  leadRef?: SessionRef,
): Promise<{ lines: string[]; failed: boolean }> => {
  const lines: string[] = [];
  let failed = false;
  let panes: SessionInfo[];
  try {
    const active = registered.filter((lane) => statusOf(lane) !== "closed");
    panes = await listSessions(rts, { lanes: leadRef ? [...active, { sessionRef: leadRef }] : active });
  } catch {
    return {
      lines: ["PANES unavailable (session list failed)", ...workspaceCheck(config, rts.choice?.kind, null)],
      failed: true,
    };
  }
  if (
    panes.some(
      (session) => session.ref.runtime === "headless" && (session.status === "unknown" || session.status === "error"),
    )
  ) {
    failed = true;
    lines.push("SESSIONS native state unavailable for one or more addresses; liveness unverified");
  }
  const lead = leadRef?.runtime === "herdr" ? leadRef.id : leadRef ? formatRef(leadRef) : "unconfigured";
  const leadSeen = leadRef && panes.find((session) => formatRef(session.ref) === formatRef(leadRef));
  let leadState = !leadRef ? "unconfigured" : leadSeen ? "live" : "missing";
  if (leadRef?.runtime === "headless") {
    if (!leadSeen) failed = true;
    else if ((await trustedPaneState(run, config.stateDir, leadRef, rts).catch(() => null))?.role !== "cataly") {
      leadState = "unknown";
      failed = true;
    }
  }
  const result = reconcilePanes(lanes, panes);
  const unregistered = result.unregistered.filter(
    (id) => !(leadRef?.runtime === "headless" && leadState === "live" && id === leadRef.id),
  );
  const done = new Set(lanes.filter(finished).map((lane) => lane.key));
  const vanished = result.lanes.filter((lane) => lane.paneState === "vanished" && !done.has(lane.key));
  lines.push(
    `PANES lead=${lead} leadState=${leadState} registeredLive=${result.lanes.filter((l) => l.paneState === "live" && l.status !== "closed").length} vanished=${vanished.length} unregistered=${unregistered.length}`,
  );
  for (const lane of vanished)
    lines.push(
      `VANISHED ${lane.key} pane=${lane.pane} status=${lane.status}; registry and worktrees preserved; no relaunch`,
    );
  if (unregistered.length) lines.push(`UNREGISTERED ${unregistered.join(" ")}`);
  const drift = await driftCheck(rts, lanes, panes);
  const warnings = workspaceCheck(config, rts.choice?.kind, panes);
  return { lines: [...lines, ...drift.lines, ...warnings], failed: failed || drift.failed || warnings.length > 0 };
};
