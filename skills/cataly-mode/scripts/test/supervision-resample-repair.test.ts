import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { withDeliveryLock } from "../src/delivery-lock.ts";
import { fileEvidence } from "../src/evidence.ts";
import { pauseLane } from "../src/pause.ts";
import type { Runner } from "../src/run.ts";
import { sent } from "./fakes.ts";
import { fixture, MIN, T0, usage, usageCommand } from "./supervision-resample-fixture.ts";

const rejectedFileAncestor =
  /post-effect activity sample failed: (?:ENOTDIR\b|activity path ancestor is not a directory\b)/;

test("the second Git status after usage does not hold the delivery lock against pause", async () => {
  const f = fixture({ usageArgv: [usageCommand] });
  try {
    await f.seed();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    let gitStatuses = 0;
    const run: Runner = async (argv, opts) => {
      if (argv[0] === usageCommand) {
        calls.push("usage");
        return usage;
      }
      if (argv[0] === "git" && argv.includes("status")) {
        calls.push("git status");
        if (++gitStatuses === 2) {
          entered.resolve();
          await release.promise;
          return { code: 0, out: "?? later.txt\0", err: "" };
        }
      }
      return f.deps.run(argv, opts);
    };
    const tick = f.tick("Working 21m\n❯ ", run);
    const observation = join(f.state.dir, "lanes", f.lane.key, "supervision.json");
    let committed = "";
    try {
      expect(await Promise.race([entered.promise.then(() => "second status"), tick.then(() => "tick finished")])).toBe(
        "second status",
      );
      expect(calls).toEqual(["git status", "usage", "git status"]);
      // The real pause waits on this lock, so check contention without waiting on a frozen fixture clock.
      const lock = await withDeliveryLock(f.deps, f.lane.key, () => f.deps.registry.read(f.lane.key), 0);
      expect(lock).toMatchObject({ ok: true, value: { key: f.lane.key } });
      committed = readFileSync(observation, "utf8");

      f.world.screens = ["❯ ", "❯ ", "Goal paused\nObjective: ship it\n❯ "];
      const paused = await pauseLane(f.deps, f.lane, "owner said wait");
      expect(paused).toMatchObject({ code: 0, lane: { status: "paused" } });
      expect(await f.deps.registry.read(f.lane.key)).toMatchObject({ status: "paused" });
      expect(sent(f.world)).toEqual(["/goal pause"]);
    } finally {
      release.resolve();
      await tick;
    }
    expect(await f.deps.registry.read(f.lane.key)).toMatchObject({ status: "paused" });
    expect(readFileSync(observation, "utf8")).toBe(committed);
  } finally {
    f.state.done();
  }
});

test("new checkpoint evidence during the read-only usage hook resets the same timer's staleness", async () => {
  const f = fixture({ gitActivity: false, usageArgv: [usageCommand] });
  try {
    await f.seed();
    const initial = f.journal();
    const readUsage: Runner = (argv, opts) =>
      argv[0] === usageCommand ? Promise.resolve(usage) : f.deps.run(argv, opts);
    expect(await f.tick("Working 21m", readUsage)).toEqual([]);

    f.clock.at = T0 + 19 * MIN;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const heldUsage: Runner = async (argv, opts) => {
      if (argv[0] === usageCommand) {
        entered.resolve();
        await release.promise;
      }
      return readUsage(argv, opts);
    };
    const tick = f.tick("Working 40m", heldUsage);
    try {
      expect(await Promise.race([entered.promise.then(() => "usage entered"), tick.then(() => "tick finished")])).toBe(
        "usage entered",
      );
      // Model the lane's own writer; the usage runner only supplies usage and does not write the checkpoint.
      const checkpoints = new Checkpoints(f.state.dir);
      const path = join(f.state.dir, "build-result.txt");
      writeFileSync(path, "built");
      const { checkpoint, unchanged } = await checkpoints.write(
        f.lane.key,
        {
          step: "build",
          result: "ok",
          evidence: [],
          remoteEffects: [],
          evidenceRefs: [fileEvidence(path, f.state.dir)],
        },
        f.clock.now(),
      );
      expect(unchanged).toBe(false);
      expect(checkpoints.read(f.lane.key)).toEqual([checkpoint]);
    } finally {
      release.resolve();
      await tick;
    }
    expect(await tick).toEqual([]);

    f.clock.at = T0 + 20 * MIN;
    expect(await f.tick("Working 41m", readUsage)).toEqual([]);
    expect(f.reports.read(f.lane.key)?.state).toBe("running");
    expect(f.journal()).toBe(initial);

    f.clock.at = T0 + 40 * MIN;
    expect((await f.tick("Working 61m", readUsage)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(f.reports.read(f.lane.key)?.state).toBe("stalled");
  } finally {
    f.state.done();
  }
});

test.each([2, 3])("post-usage lstat failure on tick %s preserves the committed stall", async (failureOn) => {
  const f = fixture({ gitActivity: false, usageArgv: [usageCommand], activityPaths: ["activity/task.txt"] });
  try {
    const parent = join(f.state.dir, "activity");
    const savedParent = join(f.state.dir, "activity-before-usage");
    const path = join(parent, "task.txt");
    mkdirSync(parent);
    writeFileSync(path, "unchanged lane file");
    await f.seed();

    let usageCalls = 0;
    const run: Runner = async (argv, opts) => {
      if (argv[0] !== usageCommand) return f.deps.run(argv, opts);
      if (++usageCalls >= failureOn) {
        // Reaching usage means the initial lstat succeeded. Only the post-effect sample sees the non-directory.
        renameSync(parent, savedParent);
        writeFileSync(parent, "usage replaced the directory");
      }
      return usage;
    };
    expect(await f.tick("Working 21m", run)).toEqual([]);
    f.clock.at = T0 + 20 * MIN;
    if (failureOn === 3) {
      expect((await f.tick("Working 41m", run)).map((act) => act.kind)).toEqual(["stalled"]);
      expect(f.reports.read(f.lane.key)?.state).toBe("stalled");
      f.clock.at += MIN;
    }
    const before = f.journal();
    expect(lstatSync(path).isFile()).toBe(true);

    const acts = await f.tick(failureOn === 2 ? "Working 41m" : "Working 42m", run);
    expect(usageCalls).toBe(failureOn);
    expect(lstatSync(parent).isFile()).toBe(true);
    expect(() => lstatSync(path)).toThrow();
    expect(acts.map((act) => act.kind)).toEqual(
      failureOn === 2 ? ["supervision-error", "stalled"] : ["supervision-error"],
    );
    expect(acts[0]).toMatchObject({ lane: f.lane.key, detail: expect.stringMatching(rejectedFileAncestor) });
    expect(f.reports.read(f.lane.key)?.state).toBe("stalled");
    if (failureOn === 2) {
      const added = f.journal().slice(before.length).trim().split("\n");
      expect(added.map((line) => JSON.parse(line).state)).toEqual(["stalled"]);
    } else {
      expect(f.journal()).toBe(before);
    }
    const stalled = f.journal();
    unlinkSync(parent);
    renameSync(savedParent, parent);
    f.clock.at += MIN;
    expect(await f.tick(failureOn === 2 ? "Working 42m" : "Working 43m", run)).toEqual([]);
    expect(f.journal()).toBe(stalled);
    expect((await f.deps.registry.read(f.lane.key))?.lastSupervisionError).toMatch(rejectedFileAncestor);
  } finally {
    f.state.done();
  }
});

test("an absent ancestor remains a valid watched-path sample until the file is created", async () => {
  const f = fixture({ gitActivity: false, activityPaths: ["missing/nested/work.txt"] });
  try {
    await f.seed();
    expect(await f.tick("Working 21m")).toEqual([]);
    const observation = join(f.state.dir, "lanes", f.lane.key, "supervision.json");
    const parent = join(f.state.dir, "missing", "nested");
    const initial = JSON.parse(readFileSync(observation, "utf8"));
    expect(initial.files).toEqual({ [join(parent, "work.txt")]: ["missing", null] });

    mkdirSync(parent, { recursive: true });
    writeFileSync(join(parent, "work.txt"), "new lane work");
    f.clock.at = T0 + 20 * MIN;
    expect(await f.tick("Working 41m")).toEqual([]);
    expect(f.reports.read(f.lane.key)?.state).toBe("running");
    expect(JSON.parse(readFileSync(observation, "utf8")).activeAt).toBe(T0 + 20 * MIN);
  } finally {
    f.state.done();
  }
});

test("a timed-out second Git probe retains the successful baseline and original stall deadline", async () => {
  const f = fixture({ usageArgv: [usageCommand] });
  try {
    await f.seed();
    writeFileSync(join(f.state.dir, "work.txt"), "existing tracked edit");
    let probes = 0;
    const run: Runner = async (argv, opts) => {
      if (argv[0] === usageCommand) return usage;
      if (argv[0] !== "git" || !argv.includes("status")) return f.deps.run(argv, opts);
      return ++probes === 4 ? { code: 124, out: "", err: "timeout" } : { code: 0, out: " M work.txt\0", err: "" };
    };
    expect(await f.tick("Working 21m", run)).toEqual([]);
    f.clock.at = T0 + 10 * MIN;
    const warning = await f.tick("Working 31m", run);
    f.clock.at = T0 + 20 * MIN;
    expect((await f.tick("Working 41m", run)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(f.reports.read(f.lane.key)?.state).toBe("stalled");
    expect(probes).toBe(6);
    expect(warning).toEqual([
      { kind: "supervision-error", lane: f.lane.key, detail: expect.stringContaining("git status exited 124") },
    ]);
  } finally {
    f.state.done();
  }
});
