import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import type { Observation } from "../src/supervision-observe.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";
import { key, lanes, nestedWorktreeFixture, userFile, writer } from "./supervision-git-fixtures.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const status = ["status", "--porcelain=v1", "-z", "--untracked-files=normal"];

const setup = async (home: string, nested: boolean, ignoreWriter: boolean, icase: boolean, mode?: "post" | "usage") => {
  const { repo, cwd, stateDir, native, setWriterIgnored } = await nestedWorktreeFixture(
    home,
    nested,
    ignoreWriter,
    icase,
  );

  const clock = fakeClock(T0);
  const world = newWorld();
  const lane: Lane = {
    key,
    title: "Git writer lock",
    thread: mode === "post" ? "123" : "none",
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
    postAfterMin: 22,
    hooks: mode === "post" ? { threadReply: ["notify", "{thread}", "{text}"] } : {},
    supervision: {
      hungAfterMinutes: 20,
      staleAfterMinutes: 20,
      ...(mode === "usage" ? { usageArgv: ["fixture-usage"], activityPaths: [join(repo, lanes, "tracked.txt")] } : {}),
    },
  });
  const reports = new Reports(stateDir);
  await deps.registry.write(lane);
  reports.report(key, "milestone", "started", T0);
  const journal = reports.path(key);
  const wall = Date.now();
  const rawStatus = async (...pathspec: string[]) =>
    (await native(["git", "-C", cwd, ...status, ...pathspec])).out.split("\0").filter(Boolean);
  const nestedSamples: string[][] = [];
  let failNextRoot = false;
  const sample: Runner = async (argv, opts) => {
    if (argv[0] === "fixture-usage") return { code: 0, out: '{"tokens":1}', err: "" };
    if (argv[0] !== "git") return deps.run(argv, opts);
    if (failNextRoot && argv.includes("--show-toplevel")) {
      failNextRoot = false;
      return { code: 124, out: "", err: "timeout" };
    }
    // The writer lock is removed at sweep exit; sample while the actual lock is held.
    if (nested && argv.includes("status")) nestedSamples.push(await rawStatus());
    return native(argv, opts);
  };
  return {
    repo,
    cwd,
    setWriterIgnored,
    rawStatus,
    question: () => reports.report(key, "question", "need a decision", T0 + 21 * MIN),
    nestedSamples,
    state: () => reports.read(key)?.state,
    journal: () => readFileSync(journal, "utf8"),
    observation: (): Observation => JSON.parse(readFileSync(join(dirname(journal), "supervision.json"), "utf8")),
    tick: async (minutes: number, failure?: 1 | 2 | "status") => {
      let reads = 0;
      const runner: Runner = (argv, opts) => {
        if (failure === "status" && argv.includes("status") && ++reads === 1) {
          return Promise.resolve({ code: 124, out: "", err: "timeout" });
        }
        if (typeof failure === "number" && argv.includes("--show-toplevel") && ++reads === failure) failNextRoot = true;
        return sample(argv, opts);
      };
      clock.at = T0 + minutes * MIN;
      world.screen = `Working ${21 + minutes}m`;
      const now = spyOn(Date, "now").mockImplementation(() => wall + minutes * MIN);
      try {
        return await freshnessTick({ ...deps, run: runner }, home);
      } finally {
        now.mockRestore();
      }
    },
  };
};

test("freshness stays stalled when native nested Git status first exposes the sibling writer directory", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true, true, false);
    expect(await f.tick(0)).toEqual([]);
    expect(f.nestedSamples[0]).toEqual([]);
    expect((await f.tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(f.state()).toBe("stalled");
    const stalled = f.observation();
    const journal = f.journal();

    // Change only private Git ignore metadata, not any worktree file or saved observation.
    f.setWriterIgnored(false);
    const firstExposedSample = f.nestedSamples.length;
    expect(existsSync(join(f.repo, writer))).toBe(true);
    expect(existsSync(join(f.cwd, writer))).toBe(false);

    const actions = await f.tick(40);
    expect(f.nestedSamples[firstExposedSample]).toEqual([`?? ${writer}/`]);
    expect(actions).toEqual([]);
    expect(f.state()).toBe("stalled");
    expect(f.journal()).toBe(journal);
    expect(f.observation()).toMatchObject({
      at: T0 + 40 * MIN,
      activeAt: stalled.activeAt,
      activity: stalled.activity,
    });
  } finally {
    fixture.done();
  }
});

test("freshness counts a case-distinct tracked edit with inherited Git icase pathspecs", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, false, false, true);
    expect(await f.tick(0)).toEqual([]);
    expect(await f.rawStatus()).toEqual([]);
    writeFileSync(join(f.repo, userFile), "real lane work\n");
    expect(await f.rawStatus()).toEqual([` M ${userFile}`]);
    expect(await f.rawStatus("--", `:(exclude,literal)${writer}`)).toEqual([]);

    expect(await f.tick(20)).toEqual([]);
    expect(f.state()).toBe("running");
    const observed = f.observation();
    expect(observed.activeAt).toBe(T0 + 20 * MIN);
    const path = join(f.repo, userFile);
    expect(observed.files?.[path]?.[1]).toBe(fileEvidence(path, f.repo).fingerprint);
    expect(observed.lastEvidenceAt).toBe(new Date(T0 + 20 * MIN).toISOString());
    expect((await f.tick(40)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(f.state()).toBe("stalled");
  } finally {
    fixture.done();
  }
});

test("a failed post-stall Git root lookup cannot record the writer lock as progress", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true, false, false);
    expect(await f.tick(0)).toEqual([]);
    const first = f.observation();
    const effects = await f.tick(20, 2);
    expect(await f.tick(21)).toEqual([]);
    expect(f.state()).toBe("stalled");
    expect(f.observation().activity).toBe(first.activity);
    expect(f.observation().activeAt).toBe(first.activeAt);
    expect(effects.map((act) => act.kind)).toEqual(["supervision-error", "stalled"]);
    expect(effects[0]?.detail).toContain("git rev-parse exited 124");
  } finally {
    fixture.done();
  }
});

test("a failed first Git root lookup preserves the dirty baseline and stall deadline", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true, false, false, "post");
    writeFileSync(join(f.repo, lanes, "tracked.txt"), "existing tracked edit\n");
    expect(await f.tick(0)).toEqual([]);
    const before = f.observation();
    const warning = await f.tick(10, 1);
    const afterFailure = f.observation();
    expect((await f.tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(afterFailure).toEqual(before);
    expect(warning).toEqual([
      { kind: "supervision-error", lane: key, detail: expect.stringContaining("git rev-parse exited 124") },
    ]);
    const stalled = f.journal();
    expect((await f.tick(21, 1)).map((act) => act.kind)).toEqual(["supervision-error"]);
    expect(f.state()).toBe("stalled");
    expect(f.journal()).toBe(stalled);
    f.question();
    expect(await f.tick(22, 1)).toEqual([
      { kind: "posted", lane: key, detail: "Progress (from the lane's last report): need a decision" },
    ]);
    expect((await f.tick(23, 1)).some((act) => act.kind === "posted")).toBe(false);
  } finally {
    fixture.done();
  }
});

test("a failed first Git status leaves the edit for the next successful observation", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true, false, false, "usage");
    expect(await f.tick(0)).toEqual([]);
    writeFileSync(join(f.repo, lanes, "tracked.txt"), "new tracked edit\n");
    await f.tick(10, "status");
    expect((await f.tick(20)).some((act) => act.kind === "stalled")).toBe(false);
    expect(f.observation().activeAt).toBe(T0 + 20 * MIN);
  } finally {
    fixture.done();
  }
});
