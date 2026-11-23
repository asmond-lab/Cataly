import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { readObservation } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const usageCommand = "fixture-usage";
const usage = { code: 0, out: '{"tokens":1,"costUsd":0}', err: "" };
const isStatus = (argv: readonly string[]) => argv[0] === "git" && argv.includes("status");

test("overlapping freshness leaves the stall and usage baseline to the same-lane owner", async () => {
  const state = withState();
  try {
    const clock = fakeClock(T0);
    const lane = {
      key: "overlap-lane",
      title: "Supervision overlap",
      thread: "none",
      pane: "w:p1",
      brief: "/b.md",
      done: "",
      openedAt: iso(T0),
      lifecycleEpoch: "overlap-epoch",
      reportProtocol: "jsonl-v1",
      cwd: state.dir,
    } satisfies Lane;
    const options = { nudgeAfterMin: 999, postAfterMin: 999, supervision: { usageArgv: [usageCommand] } };
    const worldA = newWorld();
    const worldB = newWorld();
    for (const world of [worldA, worldB]) {
      world.panes = [{ pane_id: lane.pane, workspace_id: "w", agent: "omo", agent_status: "working" }];
    }
    const a = depsFor(worldA, clock, state.dir, options);
    const b = depsFor(
      worldB,
      {
        now: clock.now,
        // A regression that holds the delivery lock here must fail, not spin on a frozen clock.
        sleep: async () => {
          throw new Error("overlapping tick waited for the lane owner");
        },
      },
      state.dir,
      options,
    );
    const reports = new Reports(state.dir);
    const scope = { generation: lane.lifecycleEpoch };
    const observationPath = join(state.dir, "lanes", lane.key, "supervision.json");
    const costPath = join(state.dir, "lanes", lane.key, "cost.jsonl");
    const journal = () => readFileSync(reports.path(lane.key), "utf8");
    const progress = () => reports.read(lane.key, scope)?.state;
    const usageTimes = () =>
      readFileSync(costPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).at);
    let usageB = 0;
    const snapshot = () => ({
      state: progress(),
      journal: journal(),
      observation: readFileSync(observationPath, "utf8"),
      usageTimes: usageTimes(),
      usageB,
    });
    const marker = join(state.dir, "usage-marker.txt");
    const clean = "tracked baseline\n";
    const provisional = "usage hook output, not lane progress\n";
    const dirty = " M usage-marker.txt";
    // Both runners see the same worktree. A tracked path appears in the porcelain only after the hook changes it.
    const status = () => ({ code: 0, out: readFileSync(marker, "utf8") === clean ? "" : `${dirty}\0`, err: "" });
    writeFileSync(marker, clean);
    await a.registry.write(lane);
    reports.report(lane.key, "milestone", "started", T0, lane.lifecycleEpoch);
    const initialJournal = journal();
    const quietRun: Runner = async (argv, opts) =>
      argv[0] === usageCommand ? usage : isStatus(argv) ? status() : a.run(argv, opts);
    worldA.screen = "Working 21m";
    expect(await freshnessTick({ ...a, run: quietRun }, state.dir)).toEqual([]);
    expect(snapshot()).toMatchObject({
      state: "running",
      journal: initialJournal,
      usageTimes: [iso(T0)],
    });
    const initialObservation = readObservation(observationPath, lane);
    expect(initialObservation).toMatchObject({ activeAt: T0, timer: 21 * 60 });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let statusesA = 0;
    const runA: Runner = async (argv, opts) => {
      if (argv[0] === usageCommand) {
        writeFileSync(marker, provisional);
        return usage;
      }
      if (!isStatus(argv)) return a.run(argv, opts);
      if (++statusesA === 2) {
        entered.resolve();
        await release.promise;
      }
      return status();
    };
    const runB: Runner = async (argv, opts) => {
      if (argv[0] === usageCommand) {
        usageB++;
        return usage;
      }
      return isStatus(argv) ? status() : b.run(argv, opts);
    };

    clock.at = T0 + 20 * MIN;
    worldA.screen = worldB.screen = "Working 41m";
    const tickA = freshnessTick({ ...a, run: runA }, state.dir);
    let stalledJournal: string;
    try {
      expect(await Promise.race([entered.promise.then(() => "held"), tickA.then(() => "finished")])).toBe("held");
      expect(readFileSync(marker, "utf8")).toBe(provisional);
      const beforeB = snapshot();
      stalledJournal = beforeB.journal;
      expect(beforeB.state).toBe("stalled");
      expect(stalledJournal.startsWith(initialJournal)).toBe(true);
      const added = stalledJournal.slice(initialJournal.length).trim().split("\n");
      expect(added.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({
          type: "activity",
          state: "stalled",
          generation: lane.lifecycleEpoch,
          at: iso(clock.at),
        }),
      ]);
      expect(beforeB.usageTimes).toEqual([iso(T0), iso(clock.at)]);
      expect(JSON.parse(beforeB.observation)).toMatchObject({
        at: clock.at,
        activeAt: T0,
        activity: initialObservation?.activity,
      });
      expect(beforeB.observation).not.toContain("usage-marker.txt");

      // Only A's runner is gated. B must neither resample the provisional state nor let Working resume the journal.
      const acts = await freshnessTick({ ...b, run: runB }, state.dir);
      expect({ acts, ...snapshot() }).toEqual({ acts: [], ...beforeB });
    } finally {
      release.resolve();
      await tickA;
    }
    expect(await tickA).toMatchObject([{ kind: "stalled", lane: lane.key }]);
    expect(progress()).toBe("stalled");
    expect(journal()).toBe(stalledJournal);
    const settled = readObservation(observationPath, lane);
    expect(settled).toMatchObject({ at: clock.at, activeAt: T0, timer: 41 * 60 });
    // The owner absorbs the hook's write in the next baseline without crediting it as progress.
    const ref = fileEvidence(marker, state.dir);
    expect(settled?.files?.[marker]?.[1]).toBe(ref.fingerprint);
    expect(settled?.incidental?.[ref.ref]).toBe(ref.fingerprint);
    expect(settled?.lastEvidenceAt).toBeNull();

    clock.at += MIN;
    worldB.screen = "Working 42m";
    expect(await freshnessTick({ ...b, run: runB }, state.dir)).toEqual([]);
    expect(usageB).toBe(1);
    expect(usageTimes()).toEqual([iso(T0), iso(T0 + 20 * MIN), iso(clock.at)]);
    expect(readObservation(observationPath, lane)).toMatchObject({ at: clock.at, activeAt: T0, timer: 42 * 60 });
    expect(progress()).toBe("stalled");
    expect(journal()).toBe(stalledJournal);
  } finally {
    state.done();
  }
});
