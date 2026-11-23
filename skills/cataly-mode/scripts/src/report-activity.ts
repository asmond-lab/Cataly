import type { AgentStatus } from "../../../../src/runtime/types.ts";
import type { Activity, Progress } from "./reports.ts";

export function reportActivity(
  key: string,
  progress: Progress,
  screen: string,
  now: number,
  staleAfterMs: number,
  resumeOnWorking: boolean,
  nativeStatus: AgentStatus | undefined,
): Activity | undefined {
  if (progress.state !== "running" && progress.state !== "stalled") return undefined;
  const visible = Bun.stripANSI(screen);
  const lastAt = (pattern: RegExp): number => {
    let at = -1;
    for (const match of visible.matchAll(pattern)) at = match.index;
    return at;
  };
  const workingAt = lastAt(/^\s*[^\w\n]*(?:Working|Running)\b/gim);
  const working = nativeStatus === undefined ? workingAt >= 0 : nativeStatus === "working";
  // A failure counts only when no Working line follows it: an old error above a recovered lane is history.
  const failed =
    nativeStatus === undefined &&
    lastAt(
      /compaction (?:failed|failure|error)|failed to compact|error (?:during|in) compaction|auto-?compaction failed/gi,
    ) > workingAt;
  // A headless idle session is still deliverable, unlike an idle terminal prompt.
  const idle = nativeStatus === undefined && /^\s*[❯>]\s*$/m.test(visible);
  const stale = now - Date.parse(progress.lastReport?.at ?? progress.lastEvent.at) >= staleAfterMs;
  const state =
    failed || (idle && !working && stale) ? "stalled" : working && resumeOnWorking ? "running" : progress.state;
  if (state === progress.state) return undefined;
  const { generation, provenance } = progress.lastEvent;
  return {
    type: "activity",
    key,
    at: new Date(now).toISOString(),
    state,
    ...(generation === undefined ? {} : { generation }),
    ...(provenance === undefined ? {} : { provenance }),
    text: failed
      ? "compaction failed"
      : state === "stalled"
        ? "idle prompt without Working or a fresh report"
        : "Working activity resumed",
  };
}
