import type { CatalyConfig } from "./config.ts";
import { hasTerminalScope, leadAddress } from "./lead-ref.ts";
import { Registry } from "./registry.ts";
import { type ChosenRuntimes, type Runner, runtimesFor } from "./run.ts";
import { ALIVE_STATUSES, listWatched, readScreen } from "./sessions.ts";

/** Unrecognised ticks in a row before one alert names the pane. */
export const UNRECOGNISED_ALERT_AFTER = 3;

/** Per-pane memory across ticks: the CLI keeps one of these for the life of the loop. */
export type DeadPaneState = { readonly unknown: Map<string, number>; readonly lastTail: Map<string, string> };
export const newDeadPaneState = (): DeadPaneState => ({ unknown: new Map(), lastTail: new Map() });

/**
 * A pane is alive when its runtime reports a running agent status for it; that wins over any screen text. Otherwise it
 * is dead only when this tick's tail carries a configured dead marker AND equals the previous tick's tail, so the two
 * reads are a full loop interval apart and a screen mid-redraw never counts. A marker seen once is pending. Anything
 * else is unrecognised, counted per pane, with one alert after UNRECOGNISED_ALERT_AFTER ticks in a row.
 */
export const deadPaneTick = async (
  run: Runner,
  config: CatalyConfig,
  seen: Set<string>,
  hourKey: string,
  state: DeadPaneState = newDeadPaneState(),
  rts: ChosenRuntimes = runtimesFor(config, process.env, run),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string[]> => {
  const out: string[] = [];
  const marked = (tail: string) => config.deadPanePatterns.some((p) => tail.includes(p.toLowerCase()));
  const lanes = await new Registry(config.stateDir).open();
  const target = leadAddress(config, env);
  const lead = "ref" in target ? target.ref : undefined;
  if (!hasTerminalScope(rts.choice?.kind, lanes, lead))
    return [rts.choice ? "WARN dead-panes skipped (no terminal session scope)" : "WARN dead-panes runtime unavailable"];
  const skip = new Set([lead?.id ?? config.leadPane, ...config.ignorePanes]);
  // Do not prune on a partial or failed listing: every watched group/runtime must succeed first.
  const scopes = lead ? [...lanes, { sessionRef: lead }] : lanes;
  const sessions = (await listWatched(rts, config.workspaces, scopes, true)).filter(
    (session) => !skip.has(session.ref.id),
  );
  const live = new Set(sessions.map((session) => session.ref.id));
  for (const map of [state.unknown, state.lastTail]) for (const id of map.keys()) if (!live.has(id)) map.delete(id);
  const currentMarks = new Set(sessions.map((session) => `${session.ref.id} ${hourKey}`));
  for (const mark of seen) if (!currentMarks.has(mark)) seen.delete(mark);
  for (const session of sessions) {
    const id = session.ref.id;
    if (session.status && ALIVE_STATUSES.has(session.status)) {
      state.unknown.delete(id);
      state.lastTail.delete(id);
      continue;
    }
    const tail = (await readScreen(rts, session.ref, 6)).toLowerCase();
    const previous = state.lastTail.get(id);
    state.lastTail.set(id, tail);
    if (marked(tail)) {
      state.unknown.delete(id);
      if (previous !== tail) continue;
      const mark = `${id} ${hourKey}`;
      if (seen.has(mark)) continue;
      seen.add(mark);
      out.push(`DEAD_PANE ${id}`);
      continue;
    }
    const n = (state.unknown.get(id) ?? 0) + 1;
    state.unknown.set(id, n);
    if (n === UNRECOGNISED_ALERT_AFTER)
      out.push(`UNRECOGNISED_PANE ${id} dead-panes: no alive status and no dead marker for ${n} ticks`);
  }
  return out;
};
