import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { launchLane } from "../skills/cataly-mode/scripts/src/launch.ts";
import { HeadlessRuntime, headlessArgv } from "../src/runtime/headless.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { headlessFixture } from "./fixtures/runtime-headless.ts";

test.skipIf(process.platform === "win32")("a live host without a bound launch model cannot create a goal", async () => {
  const f = headlessFixture();
  const rt = new HeadlessRuntime(f.stateDir, f.env);
  const ref = await rt.create({
    name: f.input.key,
    role: "lane",
    cwd: f.deps.config.defaultCwd,
    env: f.env,
    container: "tab",
  });
  try {
    const argv = headlessArgv(f.deps.config.agentCommand, f.deps.config.defaultModel);
    const { sessionId } = await rt.startNative(ref, argv, f.env);
    if (!sessionId) throw new Error("missing native session");
    await expect(rt.begin(ref, sessionId, "Do not submit this goal")).rejects.toThrow("no launch model bound");
    expect(f.frames().filter((frame) => frame["type"] === "goal")).toEqual([]);
  } finally {
    await rt.close(ref);
    rmSync(f.home, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "required readback accepts the native canonical identity and records it separately from the request",
  async () => {
    const f = headlessFixture();
    const rt = new HeadlessRuntime(f.stateDir, f.env);
    let ref: SessionRef | undefined;
    try {
      const deps = { ...f.deps, config: { ...f.deps.config, requireModelReadback: true } };
      const launched = await launchLane(deps, { ...f.input, model: "Fixture/INITIAL" });
      ref = launched.lane.sessionRef;
      expect(launched.startup).toStartWith("STARTUP_OK");
      if (!ref) throw new Error("missing headless session");
      expect(await rt.observe(ref)).toMatchObject({
        model: "fixture/initial",
        goal: { status: "active" },
      });
      expect((await deps.registry.read(f.input.key))?.modelReadback).toMatchObject({
        requested: { provider: "Fixture", id: "INITIAL" },
        observed: { provider: "fixture", id: "initial" },
        status: "matched",
        billing: "non-subscription",
        source: "native-extension",
      });
      expect(launched.warnings).toEqual([]);
    } finally {
      if (ref) await rt.close(ref);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "a thinking-suffixed launch creates the goal once the base model and native level read back",
  async () => {
    const f = headlessFixture();
    const env = { ...f.env, CATALY_TEST_MODEL_THINKING: JSON.stringify({ requested: "high", observed: "high" }) };
    const rt = new HeadlessRuntime(f.stateDir, env);
    let ref: SessionRef | undefined;
    try {
      const deps = { ...f.deps, env, config: { ...f.deps.config, requireModelReadback: true } };
      const launched = await launchLane(deps, { ...f.input, model: "fixture/initial:high" });
      ref = launched.lane.sessionRef;
      expect(launched.startup).toStartWith("STARTUP_OK");
      expect((await deps.registry.read(f.input.key))?.modelReadback).toMatchObject({
        requested: { provider: "fixture", id: "initial:high" },
        observed: { provider: "fixture", id: "initial" },
        status: "matched",
        thinking: { requested: "high", observed: "high" },
      });
    } finally {
      if (ref) await rt.close(ref);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);

for (const [model, thinking] of [
  ["fixture/initial:high", {}],
  ["fixture/initial:high", { requested: "high", observed: "low" }],
  ["fixture/initial:14b", { requested: "14b", observed: "14b" }],
] as const) {
  test.skipIf(process.platform === "win32")(
    `${model} with thinking ${JSON.stringify(thinking)} never creates a native goal`,
    async () => {
      const f = headlessFixture();
      const env = { ...f.env, CATALY_TEST_MODEL_THINKING: JSON.stringify(thinking) };
      const rt = new HeadlessRuntime(f.stateDir, env);
      let ref: SessionRef | undefined;
      try {
        const launched = await launchLane({ ...f.deps, env }, { ...f.input, model });
        ref = launched.lane.sessionRef;
        expect(launched.startup).toContain("STARTUP_MODEL_HOLD: native launch model unconfirmed; no goal created");
        expect(f.frames().filter((frame) => frame["type"] === "goal")).toEqual([]);
      } finally {
        if (ref) await rt.close(ref);
        rmSync(f.home, { recursive: true, force: true });
      }
    },
    15_000,
  );
}

for (const [scenario, detail] of [
  ["mismatch", "mismatch"],
  ["unavailable", "unavailable"],
  ["unknown", "unknown"],
  ["missing", "unconfirmed"],
  ["foreign", "unconfirmed"],
  ["foreign-session", "unconfirmed"],
  ["stale", "unconfirmed"],
  ["changed", "changed"],
] as const) {
  test.skipIf(process.platform === "win32")(
    `native goal is never created with ${scenario} model attestation`,
    async () => {
      const f = headlessFixture();
      const env = { ...f.env, CATALY_TEST_MODEL_ATTESTATION: scenario };
      const rt = new HeadlessRuntime(f.stateDir, env);
      let ref: SessionRef | undefined;
      try {
        const deps = { ...f.deps, env };
        const launched = await launchLane(deps, f.input);
        const sessionId = launched.lane.session;
        ref = launched.lane.sessionRef;
        expect(launched.startup).toContain(`STARTUP_MODEL_HOLD: native launch model ${detail}; no goal created`);
        if (!ref || !sessionId) throw new Error("missing inspectable native session for the held launch");
        expect(await rt.observe(ref)).toMatchObject({ goal: { status: "none" } });
        expect(launched.lane.modelReadback).toBeUndefined();
        await expect(rt.begin(ref, sessionId, "try without verification")).rejects.toThrow(
          `native launch model ${detail}; no goal created`,
        );
        expect(f.frames().filter((frame) => frame["type"] === "goal")).toEqual([]);
      } finally {
        if (ref) await rt.close(ref);
        rmSync(f.home, { recursive: true, force: true });
      }
    },
    15_000,
  );
}

test("headless preflight refuses a bare selector or an unguarded initial message before reserving a lane", async () => {
  const f = headlessFixture();
  try {
    await expect(launchLane(f.deps, { ...f.input, model: "initial" })).rejects.toThrow("exact provider/model");
    const [omp, ...args] = f.deps.config.agentCommand;
    if (!omp) throw new Error("missing OMP fixture");
    const deps = { ...f.deps, config: { ...f.deps.config, agentCommand: [omp, "initial message", ...args] } };
    await expect(launchLane(deps, f.input)).rejects.toThrow("initial message");
    expect(await deps.registry.read(f.input.key)).toBeNull();
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
