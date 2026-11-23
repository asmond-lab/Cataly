import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import * as goals from "../src/goal-record.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { queueFixture } from "./launch-queue-fixture.ts";

test("a working agent quoting a failure checks its recorded goal once before rejection", async () => {
  const state = withState();
  const world = newWorld();
  world.screen = "Error: Cannot find module '/repo/dist/cli.js'";
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# private brief\n");
  const goal = spyOn(goals, "laneGoalActive").mockResolvedValue(false);
  try {
    const base = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), state.dir, {
      agentCommand: ["omo", "--model", "{model}", "{prompt}"],
      goalMarker: "Pursuing goal",
    });
    const deps = {
      ...base,
      run: async (argv: readonly string[]) => {
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
          return {
            code: 0,
            out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
            err: "",
          };
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list")
          return {
            code: 0,
            out: JSON.stringify({
              result: { panes: [{ pane_id: "w:p9", workspace_id: "w", agent: "pi", agent_status: "working" }] },
            }),
            err: "",
          };
        return base.run(argv);
      },
    };
    const result = await launchLane(deps, {
      key: "goal-proof-once",
      title: "private regression",
      brief,
      done: "closed acme/app#3",
    });
    expect(result.startup).toBe("STARTUP_ERROR goal-proof-once w:p9: Cannot find module");
    expect(goal).toHaveBeenCalledTimes(1);
  } finally {
    goal.mockRestore();
    state.done();
  }
});

test("direct launch retains its registered pane and an unconfirmed receipt when the goal sample fails", async () => {
  const f = await queueFixture({ failGoalSample: true });
  try {
    const result = await launchLane(f.deps, f.input);
    expect(result.lane).toMatchObject({ key: f.input.key, pane: "w1:p9" });
    expect(result.startup).toBe(
      `STARTUP_UNCONFIRMED ${f.input.key} w1:p9: process table unavailable while verifying its goal`,
    );
    expect(await f.deps.registry.read(f.input.key)).toMatchObject({ pane: "w1:p9" });
    expect(f.creates()).toBe(1);
    expect(f.world.calls.filter((argv) => argv.slice(0, 3).join(" ") === "herdr pane run")).toHaveLength(1);
  } finally {
    f.state.done();
  }
});
