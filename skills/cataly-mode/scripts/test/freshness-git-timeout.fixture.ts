import { expect, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run, type Runner } from "../src/run.ts";
import type { Observation } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld } from "./fakes.ts";

export const T0 = Date.parse("2026-01-01T12:00:00Z");
export const MIN = 60_000;
export const key = "freshness-git-timeout";
export const probes = ["rev-parse", "status"] as const;
type Probe = (typeof probes)[number];

export const setup = async (home: string, budget: boolean, watch = false) => {
  const repo = join(home, "repo");
  const cwd = join(repo, "app");
  // Error fixtures require a writer exclusion. The nested watch must also work with state outside the repository.
  const stateDir = join(watch ? home : repo, "cataly-state");
  mkdirSync(cwd, { recursive: true });
  const git = async (...args: string[]) => {
    const result = await run(["git", "-C", repo, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}`);
  };
  await git("init", "--quiet");
  await git("config", "core.excludesFile", "/dev/null");
  writeFileSync(join(repo, ".git", "info", "exclude"), "/cataly-state/\n");
  writeFileSync(join(cwd, "work.txt"), "staged work\n");
  await git("add", "--", "app/work.txt");

  const lane: Lane = {
    key,
    title: "Freshness Git timeout",
    thread: budget ? "none" : "123",
    pane: "w:p1",
    brief: "/b.md",
    done: "",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
    cwd,
  };
  const clock = fakeClock(T0);
  const wall = Date.now();
  const world = newWorld();
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
  const deps = depsFor(world, clock, stateDir, {
    nudgeAfterMin: 999,
    postAfterMin: 22,
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
    supervision: {
      hungAfterMinutes: 20,
      staleAfterMinutes: 20,
      ...(watch ? { activityPaths: ["work.txt"], usageArgv: ["fixture-usage"] } : {}),
      ...(budget ? { defaults: { wallMinutes: 5, tokens: 10 }, usageArgv: ["fixture-usage"] } : {}),
    },
  });
  await deps.registry.write(lane);
  const reports = new Reports(stateDir);
  const journalPath = reports.path(key);
  reports.report(key, "milestone", "staged the initial change", T0);
  const posted: string[][] = [];
  let usageReads = 0;
  let usageHold: (() => Promise<void>) | undefined;
  return {
    reports,
    source: join(cwd, "work.txt"),
    status: async () => (await run(["git", "-C", cwd, "status", "--porcelain=v1", "-z"])).out,
    posted,
    edit: () => writeFileSync(join(cwd, "work.txt"), "unstaged work after the verified sample\n"),
    stage: () => git("add", "--", "app/work.txt"),
    holdUsage: (hold: () => Promise<void>) => {
      usageHold = hold;
    },
    usageReads: () => usageReads,
    stored: () => deps.registry.read(key),
    journal: () => readFileSync(journalPath, "utf8"),
    observation: (): Observation => JSON.parse(readFileSync(join(dirname(journalPath), "supervision.json"), "utf8")),
    tick: async (minutes: number, failure?: Probe, code = 124) => {
      let injected = false;
      const runner: Runner = (argv, opts) => {
        if (argv[0] === "git") {
          if (!injected && failure !== undefined && argv[3] === failure) {
            injected = true;
            return Promise.resolve({ code, out: "", err: code === 124 ? "timeout" : "fatal: index file corrupt" });
          }
          return run(argv, opts);
        }
        if (argv[0] === "notify") posted.push([...argv.slice(1)]);
        if (argv[0] === "fixture-usage") {
          usageReads++;
          return Promise.resolve(usageHold?.()).then(() => ({
            code: 0,
            out: JSON.stringify({ tokens: minutes < 5 ? 1 : 10 }),
            err: "",
          }));
        }
        return deps.run(argv, opts);
      };
      clock.at = T0 + minutes * MIN;
      world.screen = `Working ${21 + minutes}m`;
      const now = spyOn(Date, "now").mockImplementation(() => wall + minutes * MIN);
      try {
        const acts = await freshnessTick({ ...deps, run: runner }, home);
        expect(injected).toBe(failure !== undefined);
        return acts;
      } finally {
        now.mockRestore();
      }
    },
  };
};
