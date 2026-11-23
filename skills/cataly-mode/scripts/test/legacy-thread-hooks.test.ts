import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyDiscordFixture, legacyDiscordRecipe } from "../../../../test/fixtures/legacy-discord-recipe.ts";
import { loadConfig } from "../src/config.ts";
import { closeLane, type FlowDeps } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { Registry, type Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T12:21:00Z");
const lane: Lane = {
  key: "demo-lane",
  title: "demo",
  thread: "discord:40",
  pane: "w:p1",
  brief: "/briefs/demo.md",
  done: "merged acme/app#1",
  cwd: "/repo",
  openedAt: "2026-01-01T12:00:00.000Z",
  lastNudgeAt: now,
  reportProtocol: "jsonl-v1",
};

test.skipIf(process.platform === "win32").each(["threadReply", "threadDone"] as const)(
  "the saved %s Discord recipe delivers using only the selected config and its explicit token file",
  async (hook) => {
    const home = withState();
    try {
      const fixture = legacyDiscordFixture(home.dir, hook === "threadReply" ? join(home.dir, "settings") : home.dir);
      const saved = JSON.stringify({
        stateDir: fixture.stateDir,
        sessionRuntime: "herdr",
        ompUlwPath: "",
        hooks: { [hook]: legacyDiscordRecipe[hook] },
      });
      writeFileSync(fixture.configFile, saved);
      const env = {
        ...fixture.env,
        ...(hook === "threadReply" ? { CATALY_DISCORD_TOKEN: "", DORI_DISCORD_TOKEN: "" } : {}),
      };
      const config = await loadConfig(fixture.configFile, home.dir, {
        ...env,
        CATALY_HOME: hook === "threadReply" ? home.dir : undefined,
      });
      const world = newWorld();
      // A quiet thread can still have an actively working pane. An idle pane this old is held as stalled.
      if (hook === "threadReply") world.screen = "Working (2m)\n❯ ";
      const deps = depsFor(world, fakeClock(now), fixture.stateDir);
      const registry = new Registry(fixture.stateDir);
      const flow: FlowDeps = {
        ...deps,
        config,
        registry,
        env,
        run: (argv, options) =>
          argv[0] === "bash" ? run(argv, { ...options, timeoutMs: 5_000 }) : deps.run(argv, options),
      };
      await registry.write(lane);
      if (hook === "threadReply") {
        await new Reports(config.stateDir).report(lane.key, "milestone", "all checks green", Date.parse(lane.openedAt));
        expect((await freshnessTick(flow, home.dir)).map((act) => act.kind)).toEqual(["posted"]);
        expect(JSON.parse(readFileSync(fixture.fetchLog, "utf8"))).toMatchObject({
          key: "POST /channels/40/messages",
          body: { content: expect.stringContaining("all checks green") },
        });
      } else {
        const result = await closeLane(flow, lane, "verified complete");
        expect(result.closed).toBe(true);
        expect((await registry.read(lane.key))?.receipt).toMatchObject({
          cleanup: expect.arrayContaining(["thread marked done"]),
        });
        expect(JSON.parse(readFileSync(fixture.fetchLog, "utf8"))).toEqual({
          key: "PATCH /channels/40",
          body: { archived: true },
        });
      }
      expect(readFileSync(fixture.configFile, "utf8")).toBe(saved);
    } finally {
      home.done();
    }
  },
  10_000,
);
