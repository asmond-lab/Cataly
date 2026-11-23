import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceClock } from "../src/evidence.ts";
import { Registry, type Lane } from "../src/registry.ts";
import {
  grouped,
  holdRegistry,
  iso,
  journal,
  KEY,
  lane,
  type Role,
  sequenceState,
  spawnWriter,
  step,
  supervisor,
  T0,
  writeEvidenceReport,
} from "./evidence-sequence-fixture.ts";
import { fakeClock } from "./fakes.ts";

/** Delays the observer before it enters its real writer lock. An independent report can commit first. */
class DelayedRegistry extends Registry {
  constructor(
    stateDir: string,
    private readonly before: () => Promise<void>,
  ) {
    super(stateDir);
  }

  override async withCurrent<T>(key: string, fn: (current: Lane | null) => T): Promise<T> {
    await this.before();
    return super.withCurrent(key, fn);
  }
}

test.each(["checkpoint", "report"] as const)(
  "%s accepted first: writer processes at one millisecond wait on a held registry lock, then take 1 and 2",
  async (first) => {
    const f = sequenceState();
    const second: Role = first === "checkpoint" ? "report" : "checkpoint";
    const now = Date.now();
    const journalLock = `${f.checkpoints.path(KEY)}.lock`;
    const gate = join(f.dir, "late.go");
    const a = f.ref("A");
    const b = f.ref("B");
    const release = holdRegistry(f.dir);
    const early = spawnWriter(f.dir, first, now, f.source, a);
    const late = spawnWriter(f.dir, second, now, f.source, b, gate);
    try {
      await Promise.all([early.waiting(), late.waiting()]);
      // Both were refused by the live holder; the checkpoint writer took its own lock first and keeps it while waiting.
      expect([existsSync(f.reports.path(KEY)), existsSync(f.checkpoints.path(KEY))]).toEqual([false, false]);
      expect(JSON.parse(readFileSync(journalLock, "utf8")).pid).toBe((first === "checkpoint" ? early : late).child.pid);
      release();
      const accepted = await early.finished();
      // The gated writer still waits. A gated checkpoint writer still holds its own lock, so the report finished under
      // the registry lock without it: the checkpoint-then-registry order leaves no cycle to deadlock on.
      expect(late.child.exitCode).toBeNull();
      expect(existsSync(journalLock)).toBe(second === "checkpoint");
      writeFileSync(gate, "");
      const later = await late.finished();
      const stored = { report: journal(f.reports.path(KEY)), checkpoint: journal(f.checkpoints.path(KEY)) };
      expect([stored.report.length, stored.checkpoint.length]).toEqual([1, 1]);
      const [one] = stored[first];
      const [two] = stored[second];
      expect([one?.at, two?.at]).toEqual([iso(now), iso(now)]);
      expect([one?.evidenceSequence, two?.evidenceSequence]).toEqual([1, 2]);
      expect([one?.evidenceRefs, two?.evidenceRefs]).toEqual([[a], [b]]);
      // Each process returned exactly the record it stored.
      expect(accepted).toEqual(first === "report" ? one : { checkpoint: one, unchanged: false });
      expect(later).toEqual(second === "report" ? two : { checkpoint: two, unchanged: false });
      expect([existsSync(journalLock), existsSync(`${new Registry(f.dir).path(KEY)}.lock`)]).toEqual([false, false]);
      // The source-grouped merge lists the report first whichever was accepted first; the sequence keeps B the latest.
      expect(evidenceClock(grouped(f.dir))).toEqual({ lastEvidenceAt: iso(now), lastEvidence: b });
      const target = lane(f.dir);
      await new Registry(f.dir).write(target);
      const result = await supervisor(f.dir, fakeClock(now + 60_000), f.source).sweep(target, "Working 1m");
      expect(result.lastEvidenceAt).toBe(iso(now));
      // Quiet: the observer found nothing novel, so no activity joined the lone report.
      expect(f.reports.read(KEY)?.evidenced).toHaveLength(1);
    } finally {
      release();
      early.child.kill();
      late.child.kill();
      await Promise.all([early.child.exited, late.child.exited]);
      f.done();
    }
  },
  20_000,
);

test("a report accepted while the observer's novel evidence waits to append keeps the report's own time", async () => {
  const f = sequenceState();
  const resume = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  try {
    const clock = fakeClock(T0);
    await f.checkpoints.write(KEY, step("A", f.source, [f.ref("A")]), T0);
    const b = f.ref("B");
    clock.at = T0 + 60_000;
    const target = lane(f.dir);
    await new Registry(f.dir).write(target);
    const paused = Promise.withResolvers<true>();
    const registry = new DelayedRegistry(f.dir, async () => {
      paused.resolve(true);
      await resume.promise;
    });
    const sweep = supervisor(f.dir, clock, f.source, registry).sweep(target, "Working 1m");
    pending = sweep;
    expect(await Promise.race([paused.promise, sweep.then(() => false)])).toBe(true);
    // Meanwhile the lane's own report of B, made at the original time, is accepted first.
    const report = await writeEvidenceReport(f.dir, "B", T0, [b]);
    expect([report.at, report.evidenceSequence]).toEqual([iso(T0), 2]);
    resume.resolve();
    const result = await sweep;
    expect(result.lastEvidenceAt).toBe(iso(T0));
    expect(evidenceClock(grouped(f.dir))).toEqual({ lastEvidenceAt: iso(T0), lastEvidence: b });
    // The observer found the same fingerprint under the current writer lock and did not append it.
    const [checkpointed, reported] = [f.checkpoints.path(KEY), f.reports.path(KEY)].map((path) =>
      journal(path)
        .filter((record) => record.evidenceRefs?.length)
        .map((record) => record.evidenceSequence),
    );
    expect(checkpointed).toEqual([1]);
    expect(reported).toEqual([2]);
  } finally {
    resume.resolve();
    try {
      await pending;
    } finally {
      f.done();
    }
  }
});
