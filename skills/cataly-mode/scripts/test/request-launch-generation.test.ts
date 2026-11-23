import { expect, test } from "bun:test";
import { startLaunchRun } from "../src/launch-session.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const requestId = "discord:111111111111111111:222222222222222222";
const runA = "00000000-0000-4000-8000-00000000000a";
const runB = "00000000-0000-4000-8000-00000000000b";

test("a run start is refused for a lane whose run or generation moved on", async () => {
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
    const lane: Lane = {
      key: "stale-run",
      title: "t",
      thread: "none",
      brief: "/brief",
      done: "closed acme/app#3",
      openedAt: new Date(T0).toISOString(),
      requestId,
      runId: runA,
    };
    await deps.registry.write(lane);
    expect(await startLaunchRun(deps, { ...lane, runId: runB })).toBeNull();
    expect(await startLaunchRun(deps, { ...lane, openedAt: new Date(T0 + 1).toISOString() })).toBeNull();
    expect(new Reports(state.dir).events(lane.key)).toEqual([]);
    expect(await startLaunchRun(deps, lane)).toEqual({ requestId, runId: runA });
  } finally {
    state.done();
  }
});
