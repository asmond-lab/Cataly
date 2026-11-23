import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import type { HostSample } from "../src/host-guard.ts";
import type { LaunchInput } from "../src/launch-input.ts";
import type { Lane } from "../src/registry.ts";
import { agentIn, depsFor, laneState, newWorld, withState, type TestState, type World } from "./fakes.ts";

export type QueueFixture = {
  state: TestState;
  world: World;
  deps: FlowDeps;
  input: LaunchInput;
  prior: Lane;
  creates: () => number;
  advance: (ms: number) => void;
  failStart: () => void;
};
export const roomy = async (): Promise<HostSample> => ({
  load1: 0,
  memFreePct: 90,
  diskFreeGb: 100,
  swapFreeGb: 10,
  panes: 0,
});

export const queueFixture = async ({ failGoalSample = false } = {}): Promise<QueueFixture> => {
  const state = withState();
  const world = newWorld();
  let at = Date.parse("2026-01-01T12:00:00Z");
  let creates = 0;
  let startFails = false;
  let processSamples = 0;
  const clock = {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
      await Bun.sleep(1);
    },
  };
  const base = depsFor(world, clock, state.dir, {
    defaultCwd: state.dir,
    agentCommand: failGoalSample ? ["sh", "-c", 'exec omp "$1"', "fixture", "{prompt}"] : ["omo", "{prompt}"],
    goalMarker: failGoalSample ? "Pursuing goal" : "",
  });
  const deps: FlowDeps = {
    ...base,
    env: { CATALY_CONFIG: join(state.dir, "config.json") },
    run: async (argv, options) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create") {
        creates++;
        world.calls.push([...argv]);
        world.panes.push({
          pane_id: "w1:p9",
          workspace_id: "w1",
          agent: failGoalSample ? "omp" : "pi",
          agent_status: "idle",
        });
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" }, tab_id: "w1:t9" } }),
          err: "",
        };
      }
      if (startFails && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run")
        return { code: 1, out: "", err: "start failed" };
      if (failGoalSample && argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
        agentIn(world, "w1:p9");
        laneState(state.dir, "w1:p9", { cwd: state.dir });
      }
      if (failGoalSample && argv[0] === "ps" && argv[3] === "pid=,ppid=,command=") {
        const sample = await base.run(argv, options);
        // The live readiness probe gets valid evidence; only the separate goal verification sample fails.
        if (++processSamples === 2) return { ...sample, code: 1, err: "synthetic sample diagnostic" };
        return sample;
      }
      return base.run(argv, options);
    },
  };
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# Implement the recorded request\n");
  const input: LaunchInput = { key: "next-lane", title: "Next lane", brief, done: "closed acme/app#2" };
  const prior: Lane = {
    key: "prior-lane",
    title: "Prior lane",
    thread: "none",
    brief,
    done: "closed acme/app#1",
    openedAt: new Date(at).toISOString(),
    status: "closed",
    closedAt: new Date(at).toISOString(),
    receipt: { checks: [{ signal: "closed acme/app#1", ok: true }] },
  };
  await deps.registry.write(prior);
  return {
    state,
    world,
    deps,
    input,
    prior,
    creates: () => creates,
    advance: (ms) => {
      at += ms;
    },
    failStart: () => {
      startFails = true;
    },
  };
};
