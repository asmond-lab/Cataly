import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import { Reports } from "../src/reports.ts";
import { run, type Runner } from "../src/run.ts";
import { readObservation, type SupervisedLane } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const filename = "work.txt";
const usageCommand = "fixture-read-usage";
const nativeGit: Runner = async (argv, opts) => {
  const result = await run(argv, { ...opts, preserveOutput: true });
  if (result.code !== 0) throw new Error(`${argv.join(" ")}: ${result.err}`);
  return result;
};

for (const scenario of ["without-git", "worktree-edit", "stage-through-alias", "stage-deletion"] as const) {
  const gitActivity = scenario !== "without-git";
  const alias = scenario === "stage-through-alias";
  const deletion = scenario === "stage-deletion";
  const stage = alias || deletion;
  const mode = gitActivity ? scenario : "without Git";
  test(`freshness ${stage ? "does not count staging identical bytes" : "credits a watched edit"} during read-only usage (${mode})`, async () => {
    const fixture = withState();
    try {
      const cwd = join(fixture.dir, "worktree");
      const stateDir = join(fixture.dir, "state");
      const watched = join(cwd, filename);
      const watchRoot = join(fixture.dir, "watch-alias");
      const watchPath = stage ? join(watchRoot, filename) : watched;
      const beforeStage = `${deletion ? " D" : " M"} ${filename}`;
      const afterStage = `${deletion ? "D " : "M "} ${filename}`;
      const usagePath = join(fixture.dir, "usage.json");
      const initial = "tracked baseline\n";
      const edited = "external lane work after the pre-usage sample\n";
      mkdirSync(cwd);
      writeFileSync(watched, initial);
      utimesSync(watched, new Date(T0), new Date(T0));
      writeFileSync(usagePath, '{"tokens":1,"costUsd":0}');

      const git = (...args: string[]) => nativeGit(["git", "-C", cwd, ...args]);
      const porcelain = async () => (await git("status", "--porcelain=v1", "-z", "--untracked-files=normal")).out;
      if (gitActivity) {
        await git("init", "--quiet");
        await git("config", "core.excludesFile", "/dev/null");
        await git("add", "--", filename);
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
          "Seed watched file",
        );
        expect(await porcelain()).toBe("");
      }
      if (stage) {
        symlinkSync(cwd, watchRoot, "junction");
        if (deletion) unlinkSync(watched);
        else {
          writeFileSync(watched, edited);
          utimesSync(watched, new Date(T0), new Date(T0));
        }
        expect(await porcelain()).toBe(`${beforeStage}\0`);
      }

      const lane = {
        key: "explicit-activity-lane",
        title: "Explicit activity",
        thread: "none",
        pane: "w:p1",
        brief: "/b.md",
        done: "",
        openedAt: iso(T0),
        lifecycleEpoch: "explicit-activity-epoch",
        reportProtocol: "jsonl-v1",
        cwd: deletion ? watchRoot : cwd,
      } satisfies SupervisedLane;
      const scope = { generation: lane.lifecycleEpoch };
      const clock = fakeClock(T0);
      const world = newWorld();
      world.panes = [{ pane_id: lane.pane, workspace_id: "w", agent: "omo", agent_status: "working" }];
      const deps = depsFor(world, clock, stateDir, {
        nudgeAfterMin: 999,
        postAfterMin: 999,
        supervision: {
          activityPaths: [deletion ? filename : watchPath],
          gitActivity,
          hungAfterMinutes: 20,
          staleAfterMinutes: 20,
          usageArgv: [usageCommand],
        },
      });
      const reports = new Reports(stateDir);
      await deps.registry.write(lane);
      reports.report(lane.key, "milestone", "started", T0, lane.lifecycleEpoch);
      const journalPath = reports.path(lane.key);
      const observation = () => readObservation(join(dirname(journalPath), "supervision.json"), lane);
      const watchedEntry = () => {
        if (deletion) {
          expect(existsSync(watchPath)).toBe(false);
          return [watchPath, null];
        }
        const { mtimeMs, ctimeMs, size } = statSync(watchPath);
        return [watchPath, mtimeMs, ctimeMs, size];
      };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const observer: Runner = async (argv, opts) => {
        if (argv[0] === usageCommand) {
          const out = readFileSync(usagePath, "utf8");
          if (clock.at === T0 + 10 * MIN) {
            entered.resolve();
            await release.promise;
          }
          return { code: 0, out, err: "" };
        }
        if (argv[0] === "git") {
          if (!gitActivity) throw new Error("unexpected Git probe with gitActivity disabled");
          return nativeGit(argv, opts);
        }
        return deps.run(argv, opts);
      };
      const wall = Date.now();
      const tick = async (minutes: number) => {
        clock.at = T0 + minutes * MIN;
        world.screen = `Working ${21 + minutes}m`;
        const now = spyOn(Date, "now").mockImplementation(() => wall + minutes * MIN);
        try {
          return await freshnessTick({ ...deps, run: observer }, fixture.dir);
        } finally {
          now.mockRestore();
        }
      };

      expect(await tick(0)).toEqual([]);
      const baseline = observation();
      expect(baseline).toMatchObject({ ...scope, at: T0, activeAt: T0, timer: 21 * 60 });
      const fingerprint = () => (deletion ? null : fileEvidence(watchPath, watchRoot).fingerprint);
      expect(baseline?.files?.[watchPath]?.[1]).toBe(fingerprint());
      const beforeRefs = reports.read(lane.key, scope)?.evidenced.length;
      const beforeJournal = readFileSync(journalPath, "utf8");
      const held = tick(10);
      try {
        expect(await Promise.race([entered.promise.then(() => "held"), held.then(() => "finished")])).toBe("held");
        expect(observation()).toMatchObject({
          at: baseline?.at,
          activity: baseline?.activity,
          activeAt: baseline?.activeAt,
          files: baseline?.files,
        });
        if (stage) {
          const before = watchedEntry();
          await git("add", "--", filename);
          expect(await porcelain()).toBe(`${afterStage}\0`);
          expect(watchedEntry()).toEqual(before);
        } else {
          expect(readFileSync(watched, "utf8")).toBe(initial);
          // The test driver, not the usage command or observer runner, authors the edit.
          writeFileSync(watched, edited);
          utimesSync(watched, new Date(clock.at), new Date(clock.at));
          if (gitActivity) expect(await porcelain()).toBe(` M ${filename}\0`);
        }
      } finally {
        release.resolve();
        await held;
      }
      expect(await held).toEqual([]);
      if (stage) {
        expect((await tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
        expect(reports.read(lane.key, scope)?.state).toBe("stalled");
        expect(reports.read(lane.key, scope)?.evidenced).toHaveLength(beforeRefs ?? 0);
        expect(observation()).toMatchObject({ activeAt: T0, lastEvidenceAt: baseline?.lastEvidenceAt });
        return;
      }

      // The timer has the same origin on every sweep. The old deadline must not consume the edit.
      expect(await tick(20)).toEqual([]);
      expect(reports.read(lane.key, scope)?.state).toBe("running");
      expect(readFileSync(journalPath, "utf8").startsWith(beforeJournal)).toBe(true);
      expect(reports.read(lane.key, scope)?.evidenced).toHaveLength((beforeRefs ?? 0) + 1);
      const reset = observation();
      expect(reset).toMatchObject({ ...scope, at: clock.at, activeAt: clock.at, timer: 41 * 60 });
      expect(reset?.files?.[watchPath]?.[1]).toBe(fingerprint());
      expect(reset?.lastEvidenceAt).toBe(iso(clock.at));

      expect(await tick(39)).toEqual([]);
      expect(reports.read(lane.key, scope)?.state).toBe("running");
      expect((await tick(40)).map(({ kind, lane }) => [kind, lane])).toEqual([["stalled", lane.key]]);
      expect(reports.read(lane.key, scope)?.state).toBe("stalled");
      expect(observation()).toMatchObject({ ...scope, at: clock.at, activeAt: T0 + 20 * MIN, timer: 61 * 60 });
    } finally {
      fixture.done();
    }
  });
}
