import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { readObservation, type SupervisionOptions } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { commit, git, native, submoduleFixture, tracked } from "./supervision-git-fixtures.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const key = "git-boundary-lane";
const porcelain = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];

async function supervisedLane(home: string, cwd: string, stateDir: string, options: SupervisionOptions = {}) {
  const clock = fakeClock(T0);
  const world = newWorld();
  const lane = {
    key,
    title: "Native Git boundary",
    thread: "none",
    pane: "w:p1",
    brief: "",
    done: "",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
    cwd,
  } satisfies Lane;
  world.panes = [{ pane_id: lane.pane, workspace_id: "w", agent: "omo", agent_status: "working" }];
  const supervision = { hungAfterMinutes: 20, staleAfterMinutes: 20, ...options };
  const deps = depsFor(world, clock, stateDir, { nudgeAfterMin: 999, postAfterMin: 999, hooks: {}, supervision });
  const reports = new Reports(stateDir);
  await deps.registry.write(lane);
  reports.report(key, "milestone", "started", T0);
  const wall = Date.now();
  return {
    state: () => reports.read(key)?.state,
    journal: () => readFileSync(reports.path(key), "utf8"),
    observation: () => readObservation(join(stateDir, "lanes", key, "supervision.json"), lane),
    async tick(minutes: number, runner = native, gitActivity = true) {
      clock.at = T0 + minutes * MIN;
      world.screen = `Working ${21 + minutes}m`;
      const config = { ...deps.config, supervision: { ...supervision, gitActivity } };
      const dispatch: Runner = (argv, opts) => (argv[0] === "git" ? runner(argv, opts) : deps.run(argv, opts));
      const now = spyOn(Date, "now").mockImplementation(() => wall + minutes * MIN);
      try {
        return (await freshnessTick({ ...deps, config, run: dispatch }, home)).map(({ kind, lane }) => [kind, lane]);
      } finally {
        now.mockRestore();
      }
    },
  };
}

const stalled = [["stalled", key]];

test.each(["ceiling", "bare"])("freshness credits file activity without a Git worktree (%s)", async (mode) => {
  const fixture = withState();
  try {
    const repo = join(realpathSync.native(fixture.dir), "repo");
    const ceiling = join(repo, "boundary");
    const cwd = join(ceiling, "lane");
    const watched = join(cwd, "watched.txt");
    mkdirSync(cwd, { recursive: true });
    if (mode === "bare") await git(repo, "init", "--quiet", "--bare", ".git");
    else await git(repo, "init", "--quiet");
    writeFileSync(watched, "initial\n");
    const limited: Runner =
      mode === "bare"
        ? native
        : (argv, opts) => native(argv, { ...opts, env: { ...opts?.env, GIT_CEILING_DIRECTORIES: ceiling } });
    const discover = ["git", "-C", cwd, "rev-parse", "--show-toplevel"];
    if (mode === "ceiling") {
      const unrestricted = await native(discover);
      expect(unrestricted.code, unrestricted.err).toBe(0);
      expect(realpathSync.native(unrestricted.out.replace(/\r?\n$/, ""))).toBe(realpathSync.native(repo));
    }
    expect(await limited(discover)).toMatchObject({
      code: 128,
      err: expect.stringContaining(mode === "bare" ? "must be run in a work tree" : "not a git repository"),
    });

    const lane = await supervisedLane(fixture.dir, cwd, join(repo, "cataly-state"), { activityPaths: ["watched.txt"] });
    expect(await lane.tick(0, limited)).toEqual([]);
    writeFileSync(watched, "real watched progress at the first deadline\n");
    expect(await lane.tick(20, limited)).toEqual([]);
    expect(lane.state()).toBe("running");
    expect(await lane.tick(39, limited)).toEqual([]);
    expect(await lane.tick(40, limited)).toEqual(stalled);
    expect(lane.state()).toBe("stalled");
  } finally {
    fixture.done();
  }
});

test.each(["clean", "untracked", "unstaged", "staged", "new-head"] as const)(
  "freshness distinguishes supervisor state from real submodule work (%s)",
  async (change) => {
    const fixture = withState();
    try {
      const { root, module } = await submoduleFixture(fixture.dir, key);

      const lane = await supervisedLane(fixture.dir, root, join(module, "cataly-state"));
      // The clean control starts from a durable clean stall. The work cases already have native Git enabled at baseline.
      expect(await lane.tick(0, native, change !== "clean")).toEqual([]);
      expect(await lane.tick(20, native, change !== "clean")).toEqual(stalled);
      expect(lane.state()).toBe("stalled");
      expect(await git(root, ...porcelain)).toBe("");
      const journal = lane.journal();
      if (change === "untracked") {
        writeFileSync(join(module, "work/new.txt"), "real new file\n");
        expect(await git(module, ...porcelain)).toBe("?? work/new.txt\0");
      } else if (change === "new-head") {
        writeFileSync(join(module, tracked), "new commit\n");
        await git(module, "add", "--", tracked);
        await commit(module);
        expect(await git(module, ...porcelain)).toBe("");
        expect(await git(root, ...porcelain)).toBe(" M module\0");
      } else if (change !== "clean") {
        writeFileSync(join(module, tracked), "real tracked edit\n");
        if (change === "staged") await git(module, "add", "--", tracked);
        expect(await git(module, ...porcelain)).toBe(`${change === "staged" ? "M " : " M"} ${tracked}\0`);
      }

      let duringSweep: string | undefined;
      const sample: Runner = async (argv, opts) => {
        duringSweep ??= await git(root, ...porcelain);
        return native(argv, opts);
      };
      expect(await lane.tick(21, sample)).toEqual([]);
      expect(duringSweep).toBe(" M module\0");
      expect(lane.state()).toBe(change === "clean" ? "stalled" : "running");
      if (change === "clean") expect(lane.journal()).toBe(journal);
      else expect(await lane.tick(41)).toEqual(stalled);
    } finally {
      fixture.done();
    }
  },
  30_000,
);

test.each(["writer-only", "unstaged", "staged", "writer-then-unstaged"] as const)(
  "freshness preserves the outer staged gitlink and detects real submodule dirtiness (%s)",
  async (change) => {
    const fixture = withState();
    try {
      const { root, module } = await submoduleFixture(fixture.dir, key);
      writeFileSync(join(module, tracked), "staged gitlink target\n");
      await git(module, "add", "--", tracked);
      await commit(module);
      await git(root, "add", "--", "module");
      const stagedTarget = await git(module, "rev-parse", "HEAD");
      expect(await git(root, ...porcelain)).toBe("M  module\0");
      const lane = await supervisedLane(fixture.dir, root, join(module, "cataly-state"));
      const writerExclude = join(fixture.dir, "writer.exclude");
      writeFileSync(writerExclude, "/cataly-state/lanes/.supervision-writers/\n");
      // Seed the released-style staged row via real Git, excluding only the fixture's writer during baseline.
      await git(module, "config", "--local", "core.excludesFile", writerExclude);
      const sweep = async (minute: number, outerStatus: string, innerRows: (string | RegExp)[]) => {
        let sampled: { outer: string; inner: string[] } | undefined;
        const sample: Runner = async (argv, opts) => {
          sampled ??= {
            outer: await git(root, ...porcelain),
            inner: (await git(module, ...porcelain, "--untracked-files=all")).split("\0").slice(0, -1),
          };
          return native(argv, opts);
        };
        const acts = await lane.tick(minute, sample);
        expect(sampled).toEqual({
          outer: outerStatus,
          inner: innerRows.map((row) => (typeof row === "string" ? row : expect.stringMatching(row))),
        });
        return acts;
      };
      expect(await lane.tick(0)).toEqual([]);
      expect(await sweep(20, "M  module\0", [])).toEqual(stalled);
      const baseline = lane.observation();
      expect(Object.keys(baseline?.files ?? {})).toEqual([module]);
      const journal = lane.journal();
      await git(module, "config", "--local", "--unset", "core.excludesFile");
      const writer = /^\?\? cataly-state\/lanes\/\.supervision-writers\/[^/]+\.lock$/;
      if (change === "writer-only" || change === "writer-then-unstaged") {
        expect(await sweep(21, "MM module\0", [writer])).toEqual([]);
        expect(lane.state()).toBe("stalled");
        expect(lane.journal()).toBe(journal);
        expect(lane.observation()?.activity).toBe(baseline?.activity);
        expect(lane.observation()?.activeAt).toBe(baseline?.activeAt);
        expect(await git(root, ...porcelain)).toBe("M  module\0");
        if (change === "writer-only") return;
      }

      // Modify a file that already exists so no directory creation can masquerade as work.
      writeFileSync(join(module, tracked), "real inner edit\n");
      if (change === "staged") await git(module, "add", "--", tracked);
      const innerStatus = `${change === "staged" ? "M " : " M"} ${tracked}`;
      const minute = change === "writer-then-unstaged" ? 22 : 21;
      expect(await sweep(minute, "MM module\0", [innerStatus, writer])).toEqual([]);
      expect(lane.state()).toBe("running");
      expect(lane.observation()?.activeAt).toBe(T0 + minute * MIN);
      const path = join(module, tracked);
      expect(lane.observation()?.files?.[path]?.[1]).toBe(fileEvidence(path, module).fingerprint);
      expect(await git(root, "rev-parse", ":module")).toBe(stagedTarget);
      expect(await git(module, "rev-parse", "HEAD")).toBe(stagedTarget);
    } finally {
      fixture.done();
    }
  },
);
