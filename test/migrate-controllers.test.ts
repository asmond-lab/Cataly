import { expect, test } from "bun:test";
import { migrate } from "../src/migrate.ts";
import { refText } from "../src/refs.ts";
import { readJournal } from "../src/store-journal.ts";
import { controllerTerminals } from "./controller-migration-setup.ts";
import { href } from "./fake.ts";
import { rolesWorld } from "./migrate-setup.ts";

test.each([
  ["duty-loop", "w1:p4", "duty"],
  ["hourly-loop", "w1:p5", "loop"],
] as const)(
  "%s hands the live lock to the terminal child without clearing the operator's stop",
  async (role, id, stop) => {
    const { w, d, lines, opts } = rolesWorld();
    const f = controllerTerminals(w, d);
    try {
      const old = await f.source(role, href(id));
      f.knobs.beforeClose = (child) => {
        expect(child.pid).toBe(old.pid);
        expect(f.holder(role)?.pid).toBe(f.started[0]!.pid);
      };
      expect(await migrate(d, { role }, opts({ sleep: f.sleep }))).toBe(0);
      expect(lines).toEqual([`MIGRATED ${role} ${id} -> hc:t1`]);
      expect(refText(d.store.roles()[role]!)).toBe("hc:t1");
      expect(f.holder(role)?.pid).toBe(f.started[0]!.pid);
      expect(w.panes.has(id)).toBe(false);
      expect(readJournal(d.store.root, role)).toBeUndefined();
      expect(d.store.stop(stop)?.reason).toBe("operator stopped");
    } finally {
      await f.closeActors();
    }
  },
);

test("a legacy hourly holder is stopped only when its PID belongs to the registered pane", async () => {
  const { w, d, opts } = rolesWorld();
  const f = controllerTerminals(w, d);
  const role = "hourly-loop";
  try {
    const old = await f.source(role, href("w1:p5"), true);
    f.knobs.beforeClose = () => expect(f.holder(role)?.pid).toBe(old.pid);
    expect(await migrate(d, { role }, opts({ sleep: f.sleep }))).toBe(0);
    expect(f.holder(role)?.pid).toBe(f.started[0]!.pid);
    expect(w.panes.has("w1:p5")).toBe(false);
  } finally {
    await f.closeActors();
  }
});

test("a same-role holder in a different terminal must not authorize closing the registered pane", async () => {
  const { w, d, opts } = rolesWorld();
  const f = controllerTerminals(w, d);
  const role = "hourly-loop";
  try {
    const other = await f.source(role, href("w1:p90"), true);
    await expect(migrate(d, { role }, opts({ sleep: f.sleep }))).rejects.toThrow(/cannot verify hourly-loop/);
    expect(f.holder(role)?.pid).toBe(other.pid);
    expect(w.panes.has("w1:p5")).toBe(true);
    expect(f.started).toHaveLength(0);
  } finally {
    await f.closeActors();
  }
});

test("a replacement that fails startup does not take down the registered controller", async () => {
  const { w, d, lines, opts } = rolesWorld();
  const f = controllerTerminals(w, d);
  const role = "hourly-loop";
  const source = href("w1:p5");
  try {
    const old = await f.source(role, source);
    f.knobs.rejectLaunch = true;
    // Advance the migration deadline after the real child has exited; no simulated lock receipt.
    const sleep = async () => {
      await f.started[0]?.exited;
      w.clock += 3 * 60_000;
    };
    expect(await migrate(d, { role }, opts({ sleep }))).toBe(3);
    expect(lines[0]).toStartWith("MIGRATE_ROLLBACK hourly-loop");
    expect(lines.some((l) => l.startsWith("MIGRATED"))).toBe(false);
    expect(f.holder(role)?.pid).toBe(old.pid);
    expect(d.store.roles()[role]).toEqual(source);
    expect(w.panes.has(source.id)).toBe(true);
    expect(readJournal(d.store.root, role)).toMatchObject({
      phase: "cleanup",
      newRef: { runtime: "hc", id: "t1" },
    });
    await expect(migrate(d, { role }, opts({ sleep }))).rejects.toThrow(/replacement hc:t1; retire it/);
    expect(w.hc.terminals.get("t1")?.state).toBe("live");
    expect(f.started).toHaveLength(1);
    expect(f.holder(role)?.pid).toBe(old.pid);
  } finally {
    await f.closeActors();
  }
});

test.each([
  ["start", "loseStartReply"],
  ["verification", "loseProbeReply"],
] as const)("resuming after a lost %s reply claims the existing replacement, not a duplicate", async (stage, flag) => {
  const { w, d, opts } = rolesWorld();
  const f = controllerTerminals(w, d);
  const role = "hourly-loop";
  const source = href("w1:p5");
  try {
    const old = await f.source(role, source);
    f.knobs[flag] = true;
    await expect(migrate(d, { role }, opts({ sleep: f.sleep }))).rejects.toThrow(`terminal lost its ${stage} reply`);
    expect(d.store.roles()[role]).toEqual(source);
    expect(f.holder(role)?.pid).toBe(stage === "start" ? old.pid : f.started[0]!.pid);
    f.knobs[flag] = false;
    expect(await migrate(d, { role }, opts({ sleep: f.sleep }))).toBe(0);
    expect(f.started).toHaveLength(1);
    expect(f.holder(role)?.pid).toBe(f.started[0]!.pid);
  } finally {
    await f.closeActors();
  }
});

test("the source can reclaim its lock when the replacement dies during commit, then retry", async () => {
  const { w, d, lines, opts } = rolesWorld();
  const f = controllerTerminals(w, d);
  const role = "hourly-loop";
  const source = href("w1:p5");
  try {
    const old = await f.source(role, source);
    f.knobs.killOnReplacementProbe = true;
    expect(await migrate(d, { role }, opts({ sleep: f.sleep }))).toBe(3);
    expect(lines[0]).toStartWith("MIGRATE_ROLLBACK hourly-loop");
    expect(d.store.roles()[role]).toEqual(source);
    await f.untilHolder(role, old.pid);
    f.knobs.killOnReplacementProbe = false;
    w.hc.terminals.delete("t1"); // The operator retired the failed candidate shell in its original server.
    expect(await migrate(d, { role }, opts({ sleep: f.sleep }))).toBe(0);
    expect(refText(d.store.roles()[role]!)).toBe("hc:t2");
    expect(f.holder(role)?.pid).toBe(f.started[1]!.pid);
  } finally {
    await f.closeActors();
  }
});

test("a replacement lost during source retirement never restores a closed role and can be retried", async () => {
  const { w, d, lines, opts } = rolesWorld();
  const f = controllerTerminals(w, d);
  const role = "hourly-loop";
  const source = href("w1:p5");
  try {
    await f.source(role, source);
    f.knobs.beforeClose = async () => {
      expect(readJournal(d.store.root, role)?.controller?.retirementStarted).toBe(true);
      const replacement = f.started[0]!;
      replacement.kill("SIGKILL");
      await replacement.exited;
    };
    expect(await migrate(d, { role }, opts({ sleep: f.sleep }))).toBe(3);
    expect(w.panes.has(source.id)).toBe(false);
    expect(refText(d.store.roles()[role]!)).toBe("hc:t1");
    expect(readJournal(d.store.root, role)).toMatchObject({
      phase: "cleanup",
      from: source,
      newRef: { runtime: "hc", id: "t1" },
      controller: { retirementStarted: true },
    });
    expect(lines).toEqual([expect.stringContaining("no live source confirmed, registration unchanged")]);

    // A still-present shell is never closed by the migration and blocks a duplicate launch.
    await expect(migrate(d, { role }, opts({ sleep: f.sleep }))).rejects.toThrow(/replacement hc:t1; retire it/);
    expect(w.hc.terminals.get("t1")?.state).toBe("live");
    expect(f.started).toHaveLength(1);
    w.hc.terminals.delete("t1");

    expect(await migrate(d, { role }, opts({ sleep: f.sleep }))).toBe(0);
    expect(refText(d.store.roles()[role]!)).toBe("hc:t2");
    expect(f.holder(role)?.pid).toBe(f.started[1]!.pid);
    expect(readJournal(d.store.root, role)).toBeUndefined();
  } finally {
    await f.closeActors();
  }
});
