import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPolicyCommand } from "../skills/cataly-mode/scripts/src/lane-policy-actions.ts";
import {
  policyBinding,
  prepareLanePolicy,
  readLanePolicy,
  writeLanePolicy,
} from "../skills/cataly-mode/scripts/src/lane-policy-store.ts";
import { backlogAdd } from "../src/backlog.ts";
import { main } from "../src/cli.ts";
import type { Deps } from "../src/harness.ts";
import { startLane } from "../src/lanes.ts";
import { HOUR, loopTick } from "../src/loop.ts";
import { HeadlessRuntime } from "../src/runtime/headless.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import { World, href } from "./fake.ts";
import { headlessFixture } from "./fixtures/runtime-headless.ts";

type Fixture = ReturnType<typeof headlessFixture>;

function rootDeps(f: Fixture, rt: HeadlessRuntime) {
  const w = new World();
  const base = w.deps();
  const store = new Store(f.home);
  const lead = w.addPane("w1:p1");
  store.setRole("lead", href("w1:p1"));
  const d: Deps = {
    ...base,
    store,
    choice: () => ({ kind: "headless", source: "default" }),
    runtimes: new Runtimes("headless", (kind) => (kind === "headless" ? rt : base.runtimes.terminal(kind))),
  };
  return { d, w, lead, dispose: () => rmSync(base.store.root, { recursive: true, force: true }) };
}

async function withRootConfig<T>(f: Fixture, run: () => Promise<T>): Promise<T> {
  const old = process.env["CATALY_CONFIG"];
  process.env["CATALY_CONFIG"] = f.path;
  try {
    return await run();
  } finally {
    if (old === undefined) delete process.env["CATALY_CONFIG"];
    else process.env["CATALY_CONFIG"] = old;
  }
}

test.skipIf(process.platform === "win32")(
  "the hourly loop holds a real native model mismatch without announcing or retrying an unstarted goal",
  async () => {
    const f = headlessFixture();
    const rt = new HeadlessRuntime(f.stateDir, { ...f.env, CATALY_TEST_MODEL_ATTESTATION: "mismatch" });
    const { d, w, lead, dispose } = rootDeps(f, rt);
    const key = f.input.key;
    try {
      await withRootConfig(f, async () => {
        backlogAdd(d, key, f.input.brief, { cwd: f.deps.config.defaultCwd });
        const run = await loopTick(d);
        const lane = d.store.lane(key);
        if (!lane) throw new Error("held native reservation was lost");
        expect(lane.sessionPath).toBe(f.saved);
        expect(lane.status).toBe("working");
        expect(await rt.observe(lane.sessionRef)).toMatchObject({ goal: { status: "none" } });
        expect(f.frames().filter((frame) => frame["type"] === "goal")).toEqual([]);
        expect(run.started).toEqual([]);
        expect(run.held.join("\n")).toContain("STARTUP_MODEL_HOLD: native launch model mismatch; no goal created");
        expect(run.findings.join("\n")).not.toContain("lead was not told");
        expect(lead.received.join("\n")).not.toContain(`[START ${key}]`);
        expect(d.store.item(key)).toMatchObject({
          status: "open",
          decision: expect.stringContaining("native lane startup held"),
        });
        expect(w.usage.some((event) => event.name === "cataly.lane_started")).toBeFalse();

        await rt.close(lane.sessionRef);
        await main(["duty", "--once"], d);
        expect(d.store.lane(key)?.status).toBe("lost");
        w.clock += HOUR;
        expect((await loopTick(d)).started).toEqual([]);
        expect(d.store.lane(key)?.sessionRef).toEqual(lane.sessionRef);
      });
    } finally {
      const ref = d.store.lane(key)?.sessionRef;
      if (ref) await rt.close(ref);
      dispose();
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "a confirmed native goal still starts the backlog item when only the lead notification fails",
  async () => {
    const f = headlessFixture();
    const rt = new HeadlessRuntime(f.stateDir, f.env);
    const { d, w, dispose } = rootDeps(f, rt);
    const key = f.input.key;
    try {
      await withRootConfig(f, async () => {
        w.promptFails.set("w1:p1", "lead fixture cannot receive");
        backlogAdd(d, key, f.input.brief, { cwd: f.deps.config.defaultCwd });
        const run = await loopTick(d);
        const lane = d.store.lane(key);
        if (!lane) throw new Error("started lane registration is missing");
        expect(await rt.observe(lane.sessionRef)).toMatchObject({ goal: { status: "active" } });
        expect(run.started).toEqual([`${key} (p5)`]);
        expect(run.findings.join("\n")).toContain("but the lead was not told");
        expect(run.held.join("\n")).not.toContain("startup held");
        expect(d.store.item(key)?.status).toBe("running");
      });
    } finally {
      const ref = d.store.lane(key)?.sessionRef;
      if (ref) await rt.close(ref);
      dispose();
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "native startup attaches only its transcript and leaves newer root progress and the skill policy intact",
  async () => {
    const f = headlessFixture();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let launchedBinding: string | undefined;
    const rt = new (class extends HeadlessRuntime {
      override async startNative(...args: Parameters<HeadlessRuntime["startNative"]>) {
        launchedBinding = args[2]["CATALY_LANE_POLICY"];
        entered.resolve();
        await released.promise;
        return super.startNative(...args);
      }
    })(f.stateDir, f.env);
    const { d, w, dispose } = rootDeps(f, rt);
    const key = f.input.key;
    const skill = prepareLanePolicy(f.stateDir, key, { denyBash: ["skill-command"] });
    if (!skill) throw new Error("missing skill policy");
    writeLanePolicy(skill, { key, lifecycleEpoch: randomUUID() });
    const [omp, ...other] = f.deps.config.agentCommand;
    writeFileSync(
      f.path,
      JSON.stringify({
        ...f.deps.config,
        lanePolicy: { denyBash: ["root-command"] },
        agentCommand: [omp, "--cataly-role", "lane", ...other],
      }),
    );
    try {
      await withRootConfig(f, async () => {
        const starting = startLane(d, key, f.input.brief, { cwd: f.deps.config.defaultCwd, priority: 5 });
        try {
          await Promise.race([
            entered.promise,
            starting.then(() => {
              throw new Error("fixture skipped the handshake");
            }),
          ]);
          const operator = { ...d, store: new Store(f.home) };
          w.clock += 5_000;
          expect(await main(["priority", key, "2"], operator)).toBe(0);
          expect(
            await main(
              [
                "report",
                key,
                "--status",
                "waiting",
                "--for",
                "review",
                "--text",
                "new progress",
                "--evidence",
                "acme/app#19",
              ],
              operator,
            ),
          ).toBe(0);
          released.resolve();
          const lane = await starting;
          expect(d.store.lane(key)).toMatchObject({
            priority: 2,
            status: "waiting",
            waitingFor: "review",
            progressAt: w.clock,
            progressEpoch: 1,
            lastEvidence: { ref: "acme/app#19", at: w.clock },
            sessionPath: f.saved,
            log: [expect.objectContaining({ kind: "start" }), expect.objectContaining({ kind: "report" })],
          });
          expect(await rt.observe(lane.sessionRef)).toMatchObject({ goal: { status: "active" } });
          if (!lane.policyBinding) throw new Error("missing registered root policy");
          expect(launchedBinding).toBe(lane.policyBinding);
          expect(readLanePolicy(lane.policyBinding)).toMatchObject({
            file: join(f.stateDir, "headless", lane.sessionRef.id, "policy.json"),
            snapshot: { generation: lane.sessionRef.id, denyBash: ["root-command"] },
          });
          expect(checkPolicyCommand(lane.policyBinding, "root-command", w.clock)).toContain("BLOCKED");
          expect(checkPolicyCommand(policyBinding(skill), "skill-command", w.clock)).toContain("BLOCKED");
          expect(checkPolicyCommand(policyBinding(skill), "root-command", w.clock)).toBeUndefined();
        } finally {
          released.resolve();
          await starting.catch(() => undefined);
        }
      });
    } finally {
      const ref = d.store.lane(key)?.sessionRef;
      if (ref) await rt.close(ref);
      dispose();
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);
