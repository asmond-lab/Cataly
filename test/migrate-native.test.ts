import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { migrate } from "../src/migrate.ts";
import { readJournal, writeJournal } from "../src/store-journal.ts";
import { migrateWorld, NEW, OLD } from "./migrate-setup.ts";

test.each([
  ["checkpoint", { lane: "native" }, {}],
  ["resume", { lane: "native" }, { resume: true }],
  ["plan", { lane: "native" }, { dryRun: true }],
  ["all", { all: true }, {}],
] as const)("native lane policy holds the %s handoff without changing any target", async (_, target, overrides) => {
  const { w, d, lane, opts } = migrateWorld();
  try {
    const native = {
      ...lane,
      key: "native",
      createdAt: lane.createdAt + 1,
      sessionRef: { runtime: "headless", id: "00000000-0000-4000-8000-000000000020" },
      sessionPath: "/native.jsonl",
      policyBinding: "owned-native-policy",
    } as const;
    d.store.saveLane(native);
    await expect(migrate(d, target, opts(overrides))).rejects.toThrow("cannot authenticate this native lane's policy");
    expect(d.store.lane("native")).toMatchObject({
      sessionRef: native.sessionRef,
      policyBinding: native.policyBinding,
    });
    expect(d.store.lane("k")?.sessionRef).toEqual(OLD);
    expect(readJournal(d.store.root, "native")).toBeUndefined();
    expect(w.calls).toEqual([]);
  } finally {
    rmSync(d.store.root, { recursive: true, force: true });
  }
});

test("a held native handoff cannot resume from its terminal replacement", async () => {
  const { w, d, lane, opts } = migrateWorld();
  try {
    d.store.saveLane({ ...lane, sessionRef: NEW, migration: true });
    const journal = {
      name: lane.key,
      kind: "lane",
      phase: "switched",
      from: { runtime: "headless", id: "00000000-0000-4000-8000-000000000021" },
      to: "hc",
      newRef: NEW,
      at: d.now(),
    } as const;
    writeJournal(d.store.root, journal);
    await expect(migrate(d, { lane: lane.key }, opts())).rejects.toThrow(
      "cannot authenticate this native lane's policy",
    );
    expect(readJournal(d.store.root, lane.key)).toEqual(journal);
    expect(d.store.lane(lane.key)).toMatchObject({ sessionRef: NEW, migration: true });
    expect(w.calls).toEqual([]);
  } finally {
    rmSync(d.store.root, { recursive: true, force: true });
  }
});
