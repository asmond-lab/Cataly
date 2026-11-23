import { expect, test } from "bun:test";
import { fileEvidence } from "../src/evidence.ts";
import { withState } from "./fakes.ts";
import { key, MIN, probes, setup, T0 } from "./freshness-git-timeout.fixture.ts";

test("an unreadable Git index cannot revive a stalled lane or replace its verified dirty baseline", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, false);
    await f.tick(0);
    expect((await f.tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
    const journal = f.journal();
    const verified = f.observation();
    const actions = await f.tick(21, "status", 128);
    expect(f.reports.read(key)?.state).toBe("stalled");
    expect(actions.map((act) => act.kind)).toEqual(["supervision-error"]);
    expect(f.journal()).toBe(journal);
    expect(f.observation()).toEqual(verified);
    await f.tick(22);
    expect(f.journal()).toBe(journal);
    expect(f.observation().activeAt).toBe(verified.activeAt);
  } finally {
    fixture.done();
  }
});

test("staging unchanged watched bytes below the root during usage does not reset the evidence clock", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, false, true);
    f.edit();
    await f.tick(0);
    const before = f.observation();
    const fingerprint = fileEvidence(f.source, fixture.dir).fingerprint;
    expect(before.files?.[f.source]?.[1]).toBe(fingerprint);
    expect(await f.status()).toBe("AM app/work.txt\0");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.holdUsage(() => {
      entered.resolve();
      return release.promise;
    });
    const sweep = f.tick(10);
    try {
      expect(await Promise.race([entered.promise.then(() => true), sweep.then(() => false)])).toBe(true);
      await f.stage();
    } finally {
      release.resolve();
      await sweep;
    }
    expect(f.observation().activity).toBe(before.activity);
    expect(await f.status()).toBe("A  app/work.txt\0");
    expect((await f.tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
    const after = f.observation();
    expect(after.activeAt).toBe(before.activeAt);
    expect(after.lastEvidenceAt).toBe(before.lastEvidenceAt);
    expect(after.files?.[f.source]?.[1]).toBe(fingerprint);
    expect((await f.tick(40)).map((act) => act.kind)).toEqual(["posted"]);
    expect(await f.tick(41)).toEqual([]);
    expect(f.reports.read(key)?.state).toBe("stalled");
  } finally {
    fixture.done();
  }
});

test("a required Git root timeout suppresses a current stalled milestone but still posts a new question", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, false);
    expect(await f.tick(0)).toEqual([]);
    expect((await f.tick(20)).map((act) => act.kind)).toEqual(["stalled"]);
    // The current journal event is the stall, not the older milestone it retains as its last report.
    expect(f.reports.read(key)).toMatchObject({
      state: "stalled",
      lastEvent: { type: "activity", state: "stalled" },
      lastReport: { kind: "milestone", text: "staged the initial change" },
    });
    expect((await f.stored())?.lastPostedReport).toBeUndefined();
    const stalled = f.journal();
    expect(await f.tick(22, "rev-parse")).toEqual([
      { kind: "supervision-error", lane: key, detail: expect.stringContaining("git rev-parse exited 124") },
    ]);
    expect(f.posted).toEqual([]);
    expect(f.journal()).toBe(stalled);
    expect((await f.stored())?.lastPostedReport).toBeUndefined();

    f.reports.report(key, "question", "which option should I take?", T0 + 23 * MIN);
    expect(f.reports.read(key)?.state).toBe("blocked");
    const detail = "Progress (from the lane's last report): which option should I take?";
    expect(await f.tick(23, "rev-parse")).toEqual([{ kind: "posted", lane: key, detail }]);
    expect(await f.tick(24, "rev-parse")).toEqual([]);
    expect(f.posted).toEqual([["123", detail]]);
  } finally {
    fixture.done();
  }
});

test.each(probes)("an initial Git %s timeout still applies and deduplicates wall and usage ceilings", async (probe) => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true);
    expect(await f.tick(0)).toEqual([]);
    expect(f.reports.read(key)?.state).toBe("running");
    expect(f.usageReads()).toBe(1);
    const verified = f.observation();
    expect(verified.lastEvidenceAt).toBe(new Date(T0).toISOString());
    expect(verified.files?.[f.source]?.[1]).toBe(fileEvidence(f.source, fixture.dir).fingerprint);
    f.edit();

    const ceilings = ["wallMinutes ceiling reached (5)", "tokens ceiling reached (10)"];
    const effects = await f.tick(5, probe);
    expect(effects.filter((act) => act.kind === "supervision-error")).toEqual([
      { kind: "supervision-error", lane: key, detail: expect.stringContaining(`git ${probe} exited 124`) },
    ]);
    expect(effects.filter((act) => act.kind === "blocked").map((act) => act.detail)).toEqual(ceilings);
    expect(f.usageReads()).toBe(2);
    expect(f.reports.read(key)).toMatchObject({
      state: "blocked",
      lastReport: { kind: "blocker", text: ceilings.join("; "), at: new Date(T0 + 5 * MIN).toISOString() },
    });
    const blocked = f.journal();
    expect(await f.tick(6, probe)).toEqual([]);
    expect(f.usageReads()).toBe(3);
    expect(f.journal()).toBe(blocked);
    // The alert receipt changes, but the verified Git signature and activity clock do not.
    expect(f.observation()).toEqual({
      ...verified,
      alerts: ceilings,
      evidenceError: expect.stringContaining(`git ${probe} exited 124`),
    });
  } finally {
    fixture.done();
  }
});

test("budget alerts before any successful Git sample do not create an activity baseline", async () => {
  const fixture = withState();
  try {
    const f = await setup(fixture.dir, true);
    const ceilings = ["wallMinutes ceiling reached (5)", "tokens ceiling reached (10)"];
    expect((await f.tick(5, "status")).filter((act) => act.kind === "blocked").map((act) => act.detail)).toEqual(
      ceilings,
    );
    expect(f.observation()).toMatchObject({ activity: null, timer: null, alerts: ceilings });
    expect(await f.tick(6, "status")).toEqual([]);
    expect(await f.tick(7)).toEqual([]);
    expect(f.observation()).toMatchObject({
      files: { [f.source]: expect.arrayContaining([fileEvidence(f.source, fixture.dir).fingerprint]) },
      lastEvidenceAt: new Date(T0 + 7 * MIN).toISOString(),
      activeAt: T0 + 7 * MIN,
      alerts: ceilings,
    });
  } finally {
    fixture.done();
  }
});
