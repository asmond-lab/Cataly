import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { fileEvidence } from "../src/evidence.ts";
import { type Lane, Registry, sameLaneGeneration } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import type { SupervisionOptions } from "../src/supervision-observe.ts";
import { fakeClock, withState } from "./fakes.ts";

const start = Date.parse("2026-10-29T00:00:00Z");
// These sweeps use a synthetic clock but still fsync real writer locks and persist observations.
const filesystemSweepTimeoutMs = process.platform === "win32" ? 15_000 : 5_000;

const lane: Lane = {
  key: "demo-lane",
  title: "Demo",
  thread: "",
  brief: "",
  done: "",
  openedAt: new Date(start).toISOString(),
  reportProtocol: "jsonl-v1",
};

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const fixture = (options: SupervisionOptions = {}) => {
  const state = withState();
  const clock = fakeClock(start);
  const wall = Date.now();
  const filesystemNow = spyOn(Date, "now").mockImplementation(() => wall + clock.at - start);
  cleanup = () => {
    filesystemNow.mockRestore();
    state.done();
    cleanup = undefined;
  };
  const calls: string[][] = [];
  const alerts: string[] = [];
  let dirty = "";
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "git" && argv.includes("--show-toplevel")) return { code: 0, out: `${state.dir}\n`, err: "" };
    return {
      code: 0,
      out: argv[0] === "usage" ? '{"tokens":null,"costUsd":null}' : argv[0] === "git" ? dirty : "",
      err: "",
    };
  };
  const deps = { stateDir: state.dir, clock, run, alert: (_lane: Lane, message: string) => void alerts.push(message) };
  return {
    ...state,
    clock,
    calls,
    alerts,
    deps,
    supervisor: new Supervision(deps, options),
    setDirty: (value: string) => {
      dirty = value;
    },
  };
};

describe("supervision", () => {
  test("legacy lanes perform no commands or state writes", async () => {
    const f = fixture({ usageArgv: ["usage"] });
    expect((await f.supervisor.sweep({ ...lane, reportProtocol: undefined }, "Working 40m")).enabled).toBe(false);
    expect(await f.supervisor.close({ ...lane, reportProtocol: undefined })).toBeNull();
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.dir, "lanes"))).toBe(false);
  });

  test("growing same timer requires persisted observations and fresh-activity grace", async () => {
    const f = fixture();
    expect((await f.supervisor.sweep(lane, "Working (21m 0s)")).alerts).toEqual([]);
    f.clock.at += 20 * 60_000;
    const restarted = new Supervision(f.deps);
    expect((await restarted.sweep(lane, "Working (41m 0s)")).state).toBe("stalled");
    expect(f.alerts).toHaveLength(1);
    f.clock.at += 60_000;
    expect((await restarted.sweep(lane, "Working (42m 0s)")).alerts).toEqual([]);
    expect(new Reports(f.dir).read(lane.key)?.state).toBe("stalled");
    expect(f.calls.some((args) => /kill|send-text/.test(args.join(" ")))).toBe(false);
  });

  test("timer reset, frozen timer, and changed timer origin do not mark hung", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    await f.supervisor.sweep(lane, "Working 25m");
    f.clock.at += 60_000;
    expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual([]);
    f.clock.at += 60_000;
    expect((await f.supervisor.sweep(lane, "Working 1m")).alerts).toEqual([]);
    f.clock.at += 60_000;
    expect((await f.supervisor.sweep(lane, "Working 30m")).alerts).toEqual([]);
    f.clock.at += 60_000;
    expect((await f.supervisor.sweep(lane, "Running 31m")).alerts).toEqual([]);
  });

  test("a minute-rounded timer is hung even when sweeps do not line up with its minute boundary", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    await f.supervisor.sweep(lane, "Working 25m");
    f.clock.at += 90_000; // the real timer went 25m10s -> 26m40s and shows 26m
    expect((await f.supervisor.sweep(lane, "Working 26m")).state).toBe("stalled");
  });

  test("report prose and checkpoints without evidence do not postpone a verified stall", async () => {
    const f = fixture();
    const reports = new Reports(f.dir);
    reports.report(lane.key, "milestone", "starting", f.clock.now());
    await f.supervisor.sweep({ ...lane, reportProtocol: undefined }, "Working 21m");
    f.clock.at += 20 * 60_000;
    reports.report(lane.key, "milestone", "progress, in other words", f.clock.now());
    await new Checkpoints(f.dir).write(
      lane.key,
      { step: "build", result: "ok", evidence: [], remoteEffects: [] },
      f.clock.now(),
    );
    expect(await f.supervisor.sweep(lane, "Working 41m")).toMatchObject({
      state: "stalled",
      lastReportAt: new Date(f.clock.now()).toISOString(),
      lastEvidenceAt: null,
    });
  });

  test.each(["usage", "alert"] as const)("a file written by the %s hook is not lane progress", async (hook) => {
    const f = fixture();
    const registry = new Registry(f.dir);
    const active = { ...lane, cwd: f.dir };
    await registry.write(active);
    const cache = `${hook}-cache.json`;
    const write = () => writeFileSync(join(f.dir, cache), "{}");
    const run: Runner = (argv, opts) => {
      if (argv[0] === "usage") write();
      return f.deps.run(argv, opts);
    };
    f.setDirty(`?? ${cache}\0`);
    const supervisor = new Supervision(
      { ...f.deps, registry, run, alert: hook === "alert" ? write : f.deps.alert },
      hook === "usage" ? { usageArgv: ["usage"] } : { defaults: { tokens: 10 } },
    );
    await supervisor.sweep(active, "Running 21m");
    f.clock.at += 20 * 60_000;
    expect((await supervisor.sweep(active, "Running 41m")).state).toBe("stalled");
  });

  test("selected bytes move the evidence clock once, independently of report wording", async () => {
    const f = fixture();
    const registry = new Registry(f.dir);
    const reports = new Reports(f.dir);
    const supervisor = new Supervision({ ...f.deps, registry });
    const path = join(f.dir, "result.txt");
    await registry.write(lane);
    const report = (text: string) =>
      registry.withCurrent(lane.key, (current) => {
        if (!current || !sameLaneGeneration(lane, current)) throw new Error("fixture lane changed");
        return reports.report(lane.key, "milestone", text, f.clock.now(), undefined, undefined, undefined, [
          fileEvidence(path, f.dir),
        ]);
      });
    writeFileSync(path, "first");
    await report("starting");
    await supervisor.sweep(lane, "Working 21m");
    f.clock.at += 20 * 60_000;
    utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
    await report("still starting");
    expect(await supervisor.sweep(lane, "Working 41m")).toMatchObject({
      state: "stalled",
      lastReportAt: new Date(f.clock.now()).toISOString(),
      lastEvidenceAt: new Date(start).toISOString(),
    });
    f.clock.at += 60_000;
    writeFileSync(path, "second");
    await report("second result");
    expect(await supervisor.sweep(lane, "Working 42m")).toMatchObject({
      state: "running",
      heldHung: false,
      lastEvidenceAt: new Date(f.clock.now()).toISOString(),
    });
    f.clock.at += 20 * 60_000;
    await new Checkpoints(f.dir).write(
      lane.key,
      {
        step: "s",
        result: "r",
        evidence: ["result.txt"],
        remoteEffects: [],
        evidenceRefs: [fileEvidence(path, f.dir)],
      },
      f.clock.now(),
    );
    expect((await supervisor.sweep(lane, "Working 62m")).state).toBe("stalled");
  });

  test(
    "a touch and a status-only change are not progress; new file bytes are",
    async () => {
      const f = fixture();
      const path = join(f.dir, "source.ts");
      const active = { ...lane, cwd: f.dir, activityPaths: [path] };
      const registry = new Registry(f.dir);
      await registry.write(active);
      const supervisor = new Supervision({ ...f.deps, registry });
      writeFileSync(path, "first");
      await supervisor.sweep(active, "Running 21m");
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      writeFileSync(path, "first");
      f.clock.at += 20 * 60_000;
      f.setDirty(" M source.ts\0?? node_modules/\0");
      expect((await supervisor.sweep(active, "Running 41m")).state).toBe("stalled");
      f.clock.at += 60_000;
      writeFileSync(path, "second");
      expect((await supervisor.sweep(active, "Running 42m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      expect((await supervisor.sweep(active, "Running 62m")).state).toBe("stalled");
      f.clock.at += 60_000;
      f.setDirty(" M source.ts\0?? added.ts\0");
      writeFileSync(join(f.dir, "added.ts"), "new");
      expect((await supervisor.sweep(active, "Running 63m")).state).toBe("running");
      expect(f.calls.every((args) => args[0] === "git")).toBe(true);
    },
    filesystemSweepTimeoutMs,
  );

  test("a supervision record from before evidence fingerprints is not itself evidence", async () => {
    const f = fixture();
    new Reports(f.dir).report(lane.key, "milestone", "starting", start);
    const legacy = { at: start, timer: 21 * 60, timerKind: "working", activity: "{}", activeAt: start, alerts: [] };
    writeFileSync(join(f.dir, "lanes", lane.key, "supervision.json"), JSON.stringify(legacy));
    f.clock.at += 20 * 60_000;
    expect(await f.supervisor.sweep(lane, "Working (41m 0s)")).toMatchObject({
      state: "running",
      lastEvidenceAt: null,
    });
    f.clock.at += 20 * 60_000;
    expect((await f.supervisor.sweep(lane, "Working (61m 0s)")).state).toBe("stalled");
  });

  test("changes under node_modules or outside the lane's cwd are not activity", async () => {
    const f = fixture();
    const activeLane = { ...lane, cwd: f.dir };
    f.setDirty(" M node_modules/a/index.js\0");
    await f.supervisor.sweep(activeLane, "Running 21m");
    f.clock.at += 20 * 60_000;
    f.setDirty(" M node_modules/b/index.js\0 M ../elsewhere.ts\0");
    expect((await f.supervisor.sweep(activeLane, "Running 41m")).state).toBe("stalled");
  });
});
