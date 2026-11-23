import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultConfig, loadConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { claimDone, closeLane, type FlowDeps } from "../skills/cataly-mode/scripts/src/done-flow.ts";
import { freshnessTick } from "../skills/cataly-mode/scripts/src/freshness.ts";
import { launchLane } from "../skills/cataly-mode/scripts/src/launch.ts";
import { parkLane } from "../skills/cataly-mode/scripts/src/park.ts";
import { pauseLane, resumeLane } from "../skills/cataly-mode/scripts/src/pause.ts";
import { statusOf } from "../skills/cataly-mode/scripts/src/registry.ts";
import { reopenLane } from "../skills/cataly-mode/scripts/src/reopen.ts";
import { Reports } from "../skills/cataly-mode/scripts/src/reports.ts";
import { ChosenRuntimes, runtimesOf } from "../skills/cataly-mode/scripts/src/run.ts";
import { resolveSession } from "../skills/cataly-mode/scripts/src/session-id.ts";
import { laneStatus } from "../skills/cataly-mode/scripts/src/status.ts";
import { tellLane } from "../skills/cataly-mode/scripts/src/tell.ts";
import { type HeadlessObservation, HeadlessRuntime, headlessArgv } from "../src/runtime/headless.ts";
import { formatRef, parseRef, type SessionRef } from "../src/runtime/types.ts";
import { headlessFixture, noExternal } from "./fixtures/runtime-headless.ts";

const skillCli = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts");

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 100; tries++) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(30);
  }
  throw new Error("native readback did not reach the expected state");
}

test("legacy terminal preferences keep native execution and explicit lane overrides remain available", async () => {
  const f = headlessFixture();
  try {
    expect(defaultConfig(f.home).laneRuntime).toBeUndefined();
    expect((await loadConfig(f.path, f.home, f.env)).laneRuntime).toBe("headless");
    expect((await loadConfig(f.path, f.home, { ...f.env, CATALY_LANE_RUNTIME: "terminal" })).laneRuntime).toBe(
      "terminal",
    );
    expect(runtimesOf(f.deps).default.kind).toBe(process.platform === "win32" ? "hc" : "headless");
    expect(() => headlessArgv(["omp", "--mode", "json", "{prompt}"], "test")).toThrow();
    expect(() => headlessArgv(["omp", "--resume", "some-session", "{prompt}"], "test")).toThrow();
    expect(() => headlessArgv(["omp", "--cataly-role", "cataly", "{prompt}"], "test")).toThrow();
    expect(() => headlessArgv(["node", "-e", "work", "{prompt}"], "test")).toThrow();
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "skill launch, report, claim, freshness, hold, and close use one native lane",
  async () => {
    const f = headlessFixture();
    const rt = new HeadlessRuntime(f.stateDir, f.env);
    let ref: SessionRef | undefined;
    try {
      const launched = await launchLane(f.deps, f.input);
      const lane = launched.lane;
      ref = lane.sessionRef;
      expect(launched.startup).toStartWith("STARTUP_OK");
      if (!ref || !lane.session) throw new Error("native launch did not record its identity");
      const actual = ref;
      const session = lane.session;
      expect(parseRef(formatRef(ref))).toEqual(ref);
      expect(lane.sessionFile).toBe(f.saved);
      expect(lane.lifecycleEpoch).toBe(ref.id);
      expect(await rt.observe(ref)).toMatchObject({
        role: "lane",
        sessionId: session,
        goal: { status: "active" },
        held: false,
      });
      expect((await laneStatus(f.deps, lane.key)).lanes[0]?.runtime?.goal.status).toBe("active");

      const report = Bun.spawn(
        [process.execPath, skillCli, "report", lane.key, "--kind", "milestone", "--text", "native evidence", "--json"],
        { env: f.env, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(report.stdout).text(),
        new Response(report.stderr).text(),
        report.exited,
      ]);
      if (code !== 0) throw new Error(err || out);
      expect(JSON.parse(out)).toMatchObject({ generation: ref.id, text: "native evidence" });
      expect(new Reports(f.stateDir).read(lane.key, { generation: ref.id })?.lastReport?.text).toBe("native evidence");

      expect(await tellLane(f.deps, lane, "request approval")).toMatchObject({ code: 0 });
      const approval = await waitFor(async () =>
        (await rt.observe(actual)).dialogs.find((dialog) => dialog.kind === "approval"),
      );
      expect(await rt.deliver(ref, "unapproved input", { force: true, when: "any" })).toEqual({
        kind: "not-ready",
        status: "blocked",
      });
      expect(await closeLane(f.deps, lane, "no close with pending input")).toMatchObject({ closed: false });
      expect(await pauseLane(f.deps, lane, "wait")).toMatchObject({ code: 3 });
      f.advance(120_000);
      expect(await freshnessTick(f.deps, f.home)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "blocked" })]),
      );
      expect((await freshnessTick(f.deps, f.home)).some((entry) => entry.kind === "blocked")).toBeFalse();
      await expect(rt.answer(ref, approval.id, { value: "Deny" }, "different")).rejects.toThrow("does not match");
      await expect(rt.answer(ref, approval.id, { value: "Approve for this session" }, session)).rejects.toThrow(
        "unsupported",
      );
      expect(await rt.answer(ref, approval.id, { value: "Deny" }, session)).toEqual({ submitted: true });
      await expect(rt.answer(ref, approval.id, { value: "Deny" }, session)).rejects.toThrow("no matching");

      expect(await tellLane(f.deps, lane, "request question")).toMatchObject({ code: 0 });
      const question = await waitFor(async () =>
        (await rt.observe(actual)).dialogs.find((dialog) => dialog.kind === "ask"),
      );
      await expect(
        rt.answer(ref, question.id, { answers: [{ id: "single", selectedOptions: ["wrong"] }] }, session),
      ).rejects.toThrow("unsupported");
      expect(
        await rt.answer(ref, question.id, { answers: [{ id: "single", selectedOptions: ["B"] }] }, session),
      ).toEqual({ submitted: true });

      expect(await tellLane(f.deps, lane, "long turn")).toMatchObject({ code: 0 });
      await waitFor(async () => ((await rt.observe(actual)).status === "working" ? true : undefined));
      const latest = await f.deps.registry.read(lane.key);
      if (!latest) throw new Error("lost lane record");
      const paused = await pauseLane(f.deps, latest, "operator wait");
      expect(paused.code).toBe(0);
      expect((await rt.observe(ref)).goal?.status).toBe("paused");
      expect(await tellLane(f.deps, paused.lane, "do not wake")).toMatchObject({ code: 2 });
      expect(await freshnessTick(f.deps, f.home)).toEqual([]);
      const resumed = await resumeLane(f.deps, paused.lane, "operator go");
      expect(resumed.code).toBe(0);
      const message = "/only-literal `suffix` $(nothing)";
      expect(await tellLane(f.deps, resumed.lane, message)).toMatchObject({ code: 0 });
      const literal = `[CATALY message]\n${message}`;
      expect((await rt.observe(ref)).recent).toContainEqual({ kind: "assistant", text: literal });
      const claimed = await claimDone(f.deps, resumed.lane, f.saved);
      expect(claimed).toStartWith("LANE_DONE_CLAIMED");
      const claimedLane = await f.deps.registry.read(lane.key);
      if (!claimedLane) throw new Error("lost claim");
      const cost = join(dirname(new Reports(f.stateDir).path(lane.key)), "cost.jsonl");
      const held = await closeLane({ ...f.deps, run: noExternal }, claimedLane, "verified");
      expect(held.closed).toBe(false);
      expect(held.lines).toContain(`HELD ${lane.key}: native process exit is unconfirmed: process table unavailable`);
      expect(await rt.observe(ref)).toMatchObject({ status: "gone", held: true });
      const prepared = await f.deps.registry.read(lane.key);
      if (!prepared?.nativeCloseIntent) throw new Error("close lost its prepared process evidence");
      expect(statusOf(prepared)).toBe("done-claimed");
      expect(prepared.receipt).toBeUndefined();
      expect(existsSync(cost)).toBe(false);

      expect(await closeLane(f.deps, prepared, "verified")).toMatchObject({ closed: true });
      expect(await rt.observe(ref)).toMatchObject({ status: "gone", held: true });
      expect(statusOf((await f.deps.registry.read(lane.key))!)).toBe("closed");
      expect(existsSync(cost)).toBe(true);
      const frames = f.frames();
      expect(frames.filter((frame) => frame["type"] === "extension_ui_response")).toHaveLength(2);
      expect(frames.filter((frame) => frame["type"] === "prompt" && frame["message"] === literal)).toEqual([
        expect.objectContaining({ streamingBehavior: "followUp" }),
      ]);
      expect(frames.filter((frame) => frame["type"] === "goal" && frame["op"] === "create")).toHaveLength(1);
      expect(frames.filter((frame) => frame["type"] === "abort")).toHaveLength(1);
    } finally {
      if (ref) await rt.close(ref);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  25_000,
);

test.skipIf(process.platform === "win32")(
  "park and explicit reopen preserve native transcript identity without reusing a host",
  async () => {
    const f = headlessFixture();
    const rt = new HeadlessRuntime(f.stateDir, f.env);
    const refs: SessionRef[] = [];
    try {
      const initial = (await launchLane(f.deps, f.input)).lane;
      if (!initial.sessionRef) throw new Error("native ref missing");
      refs.push(initial.sessionRef);
      const parked = await parkLane(f.deps, initial, "stop work");
      expect(parked.code).toBe(0);
      expect((await rt.observe(initial.sessionRef)).status).toBe("gone");
      const deps: FlowDeps = {
        ...f.deps,
        run: async (argv) => (argv[0] === "hc" ? { code: 0, out: '{"terminals":[]}', err: "" } : noExternal(argv)),
      };
      const opened = await reopenLane(deps, parked.lane);
      if (opened.lane.sessionRef) refs.push(opened.lane.sessionRef);
      expect(opened.lines[0]).toStartWith("REOPENED");
      expect(opened.code).toBe(0);
      expect(opened.lane.session).toBe(initial.session);
      expect(opened.lane.sessionRef?.id).not.toBe(initial.sessionRef.id);
      expect(opened.lane.sessionRef?.runtime).toBe("headless");
    } finally {
      for (const ref of refs) await rt.close(ref);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);

test("headless session resolution discards cached identities after a failed live observation", async () => {
  const ref: SessionRef = { runtime: "headless", id: "00000000-0000-4000-8000-000000000001" };
  const at = "2026-11-21T00:00:00.000Z";
  const confirmed: HeadlessObservation = {
    ref,
    cwd: "/fixture",
    startedAt: at,
    updatedAt: at,
    status: "idle",
    pid: 123,
    role: "lane",
    sessionId: "fixture-session",
    sessionFile: "/fixture/session.jsonl",
    goal: { status: "active" },
    held: false,
    dialogs: [],
    recent: [],
  };
  let seen = confirmed;
  const runtime = Object.assign(new HeadlessRuntime("/fixture"), { observe: async () => seen });
  const rts = new ChosenRuntimes(
    () => ({ kind: "hc", source: "config" }),
    () => runtime,
  );
  const deps = { run: noExternal, sessionsDir: "/fixture", rts };

  expect(await resolveSession(ref, confirmed.cwd, null, deps)).toMatchObject({
    id: confirmed.sessionId,
    via: "rpc-ui",
  });
  for (const observation of [
    { ...confirmed, status: "unknown", held: true },
    { ...confirmed, status: "gone", held: true },
    { ...confirmed, detail: "headless local transport unconfirmed" },
  ] satisfies readonly HeadlessObservation[]) {
    seen = observation;
    expect(await resolveSession(ref, confirmed.cwd, null, deps)).toMatchObject({ id: "", via: "none" });
  }
});
