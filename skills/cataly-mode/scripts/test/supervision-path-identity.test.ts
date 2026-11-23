import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run, type Runner } from "../src/run.ts";
import type { Observation, SupervisionOptions } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;

const seedLane = async (home: string, stateDir: string, cwd: string, options: SupervisionOptions = {}) => {
  const clock = fakeClock(T0);
  const world = newWorld();
  const lane: Lane = {
    key: "path-identity-lane",
    title: "Path identity",
    thread: "none",
    pane: "w:p1",
    brief: "/b.md",
    done: "",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
    cwd,
  };
  world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
  const deps = depsFor(world, clock, stateDir, {
    nudgeAfterMin: 999,
    postAfterMin: 999,
    supervision: { hungAfterMinutes: 20, staleAfterMinutes: 20, ...options },
  });
  const reports = new Reports(stateDir);
  await deps.registry.write(lane);
  reports.report(lane.key, "milestone", "started", T0);

  const journalPath = reports.path(lane.key);
  const observationPath = join(dirname(journalPath), "supervision.json");
  const wall = Date.now();
  return {
    observationPath,
    observation: (): Observation => JSON.parse(readFileSync(observationPath, "utf8")),
    journal: () => readFileSync(journalPath, "utf8"),
    state: () => reports.read(lane.key)?.state,
    tick: async (minutes: number, runner: Runner = deps.run) => {
      clock.at = T0 + minutes * MIN;
      world.screen = `Working ${21 + minutes}m`;
      const now = spyOn(Date, "now").mockImplementation(() => wall + minutes * MIN);
      try {
        return await freshnessTick({ ...deps, run: runner }, home);
      } finally {
        now.mockRestore();
      }
    },
    run: deps.run,
  };
};

test("freshness preserves a stalled Git baseline saved with the lane's symlink spelling", async () => {
  const fixture = withState();
  try {
    const repo = join(fixture.dir, "worktree");
    const alias = join(fixture.dir, "worktree-alias");
    const stateDir = join(fixture.dir, "cataly-state");
    mkdirSync(repo);
    symlinkSync(repo, alias, "dir");
    const git = async (...args: string[]) => {
      const result = await run(["git", "-C", alias, ...args]);
      if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}`);
    };
    await git("init", "--quiet", "--separate-git-dir", join(fixture.dir, "git-state"));
    await git("config", "core.excludesFile", "/dev/null");
    const tracked = "tracked.txt";
    const aliasFile = join(alias, tracked);
    writeFileSync(aliasFile, "initial\n");
    await git("add", "--", tracked);
    await git(
      "-c",
      "user.name=Cataly Fixture",
      "-c",
      "user.email=cataly@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "Seed lane",
    );
    writeFileSync(aliasFile, "dirty lane work\n");
    const f = await seedLane(fixture.dir, stateDir, alias);
    const sample: Runner = async (argv, opts) => {
      if (argv[0] !== "git" || !argv.includes("status")) return f.run(argv, opts);
      const result = await run(argv, opts);
      if (result.code !== 0) throw new Error(`git status: ${result.err}`);
      return result;
    };

    expect(await f.tick(0, sample)).toEqual([]);
    expect((await f.tick(20, sample)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(f.state()).toBe("stalled");
    const stalledJournal = f.journal();
    const saved = f.observation();
    const trackedMark = saved.files?.[aliasFile];
    expect(trackedMark?.[1]).toBe(fileEvidence(aliasFile, repo).fingerprint);
    const { mtimeMs, ctimeMs, size } = statSync(aliasFile);
    // Replace the new observer state with the previous release's persisted shape, including its lexical alias.
    const { files: _files, coverage: _coverage, hung: _hung, lastEvidenceAt: _at, ...legacy } = saved;
    const activity = JSON.stringify({ changes: [` M ${tracked}`], files: [[aliasFile, mtimeMs, ctimeMs, size]] });
    writeFileSync(f.observationPath, JSON.stringify({ ...legacy, activity }));

    expect(await f.tick(40, sample)).toEqual([]);
    expect(f.state()).toBe("stalled");
    expect(f.journal()).toBe(stalledJournal);
    expect(f.observation()).toMatchObject({ at: T0 + 40 * MIN, activeAt: saved.activeAt, activity: saved.activity });
  } finally {
    fixture.done();
  }
});

test("an explicit writer directory through a state symlink does not count as activity", async () => {
  const fixture = withState();
  try {
    const stateDir = join(fixture.dir, "cataly-state");
    const alias = join(fixture.dir, "state-alias");
    mkdirSync(stateDir);
    symlinkSync(stateDir, alias, "dir");
    const realWriter = join(stateDir, "lanes", ".supervision-writers");
    const f = await seedLane(fixture.dir, alias, fixture.dir, {
      gitActivity: false,
      activityPaths: [join(alias, "lanes", ".supervision-writers")],
    });

    expect(await f.tick(0)).toEqual([]);
    expect(f.state()).toBe("running");
    const first = f.observation();
    const before = statSync(realWriter).mtimeMs;
    const stamp = new Date(before - MIN);
    utimesSync(realWriter, stamp, stamp);
    expect(statSync(realWriter).mtimeMs).not.toBe(before);

    expect((await f.tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(f.state()).toBe("stalled");
    const stalled = f.observation();
    expect(stalled).toMatchObject({ at: T0 + 20 * MIN, activeAt: first.activeAt, activity: first.activity });
    // Prove exclusion even if lock acquisition itself stamps the directory within the same filesystem clock tick.
    expect(stalled.files).toEqual({});
  } finally {
    fixture.done();
  }
});
