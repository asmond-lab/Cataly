import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  conversationRecall,
  createRecallScope,
  openRecallLedger,
  purgeRecallLedger,
} from "../src/messenger/recall-ledger.ts";
import { type TestState, withState } from "./fakes.ts";

const DAY = 24 * 60 * 60_000;
const scope = createRecallScope("discord", "99", "10");
const STORE = "recall-scoped-v1.sqlite";
const room = { channel: "20", thread: "20" };
const topic = { channel: "20", thread: "21" };
const posix = test.skipIf(process.platform === "win32" || process.getuid === undefined);
let state: TestState;
let now: number;
let warnings: string[];
beforeEach(() => {
  state = withState();
  now = Date.UTC(2026, 10, 20, 12);
  warnings = [];
});
afterEach(() => state.done());

const recall = (retentionDays?: number) =>
  conversationRecall(
    { stateDir: state.dir, scope, recall: { enabled: true, ...(retentionDays ? { retentionDays } : {}) } },
    (warning) => warnings.push(warning),
    () => now,
  )!;
const said = (channel: string, thread: string, ref: string, text: string) =>
  recall().owner({ channel, thread, ref, text });
const recalled = (line: string | undefined) => {
  const match = /^INBOUND_RECALL discord (\d+) (\d+) (.*)$/.exec(line ?? "");
  return { conversation: match?.[1], ref: match?.[2], ...(JSON.parse(match?.[3] ?? "null") as object) } as {
    conversation?: string;
    ref?: string;
    rows: { role: string; thread: string; text: string }[];
  };
};

test("recall is off by default and creates no ledger", () => {
  for (const config of [{ stateDir: state.dir }, { stateDir: state.dir, recall: { enabled: false } }])
    expect(conversationRecall({ ...config, scope }, () => {})).toBeUndefined();
  expect(existsSync(join(state.dir, STORE))).toBe(false);
});

posix("a past reference recalls owner messages and replies from every thread of the same channel only", () => {
  expect(said("20", "20", "1", "the deploy window is friday 18:00")).toBeUndefined();
  now += 1000;
  said("20", "21", "3", "ok, keep the deploy window note");
  now += 1000;
  recall().lead({ ...topic, ref: "2", text: "moved the deploy window to monday" });
  said("30", "30", "4", "other channel: deploy window secret plan");
  said("40", "40", "5", "dm: deploy window in a DM");
  now += 1000;
  const result = recalled(said("20", "20", "6", "what was the deploy window we discussed last time?"));
  expect(result.conversation).toBe("20");
  expect(result.ref).toBe("6");
  expect(result.rows.map((row) => [row.role, row.thread, row.text])).toEqual([
    ["owner", "20", "the deploy window is friday 18:00"],
    ["owner", "21", "ok, keep the deploy window note"],
    ["lead", "21", "moved the deploy window to monday"],
  ]);
  expect(recalled(said("40", "40", "7", "저번에 말한 배포 일정")).rows).toEqual([]);
  expect(warnings).toEqual([]);
});

posix("a redelivered message is stored once and never recalls itself", () => {
  said("20", "20", "1", "earlier: rotate the staging key");
  const again = recalled(said("20", "20", "1", "earlier: rotate the staging key"));
  expect(again.rows).toEqual([]);
  const ledger = openRecallLedger(state.dir, scope, { settings: undefined, now });
  try {
    expect(ledger.rows(room)).toHaveLength(1);
  } finally {
    ledger.close();
  }
});

posix("stored rows are redacted, owner-only and dropped after the retention period", () => {
  said("20", "20", "1", "token=abc123secret for the deploy");
  const ledger = openRecallLedger(state.dir, scope, { settings: undefined, now });
  try {
    expect(ledger.rows(room).map((row) => row.text)).toEqual(["token=[redacted] for the deploy"]);
  } finally {
    ledger.close();
  }
  expect(statSync(join(state.dir, STORE)).mode & 0o077).toBe(0);
  now += 8 * DAY;
  expect(recalled(recall(7).owner({ ...room, ref: "2", text: "yesterday deploy?" })).rows).toEqual([]);
});

test.skipIf(process.platform === "win32" || process.getuid === undefined)(
  "existing ledger and SQLite sidecars must be private single-link files",
  () => {
    const path = join(state.dir, STORE);
    const original = join(state.dir, "original");
    const assertClosed = () => {
      expect(() => openRecallLedger(state.dir, scope, { settings: undefined, now })).toThrow(
        "recall ledger and sidecars must be private regular files owned by this user",
      );
    };
    writeFileSync(original, "synthetic", { mode: 0o600 });
    for (const [name, create] of [
      [path, () => symlinkSync(original, path)],
      [`${path}-wal`, () => linkSync(original, `${path}-wal`)],
      [`${path}-shm`, () => mkdirSync(`${path}-shm`, { mode: 0o700 })],
      [
        `${path}-journal`,
        () => {
          const journal = `${path}-journal`;
          writeFileSync(journal, "synthetic", { mode: 0o600 });
          chmodSync(journal, 0o644);
        },
      ],
    ] as const) {
      create();
      assertClosed();
      expect(existsSync(path)).toBe(name === path);
      expect(existsSync(name)).toBe(true);
      rmSync(name, { recursive: true });
    }
    chmodSync(state.dir, 0o755);
    said("20", "20", "1", "synthetic owner text");
    chmodSync(path, 0o644);
    assertClosed();
    expect(statSync(path).mode & 0o777).toBe(0o644);
  },
);

test.skipIf(process.getuid === undefined)("recall leaves a group-writable state directory without a ledger", () => {
  chmodSync(state.dir, 0o770);
  expect(() => openRecallLedger(state.dir, scope, { settings: undefined, now })).toThrow("writable only by its owner");
  expect(existsSync(join(state.dir, STORE))).toBe(false);
});

test.skipIf(process.getuid === undefined)("recall skips an owner-only state directory under an unsafe parent", () => {
  const parent = join(state.dir, "shared");
  const nested = join(parent, "state");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o770);
  expect(() => openRecallLedger(nested, scope, { settings: undefined, now })).toThrow("untrusted parent directory");
  expect(existsSync(join(nested, STORE))).toBe(false);
});

test("a ledger failure is a warning, not a lost message", () => {
  const broken = conversationRecall(
    { stateDir: join(state.dir, "missing\0dir"), scope, recall: { enabled: true } },
    (warning) => warnings.push(warning),
  )!;
  expect(broken.owner({ ...room, ref: "1", text: "earlier?" })).toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toStartWith("recall: ");
});

posix("caller-supplied space controls where a reply is recorded, not the first row for its thread", () => {
  said("30", "21", "1", "unrelated cached space");
  recall().lead({ ...topic, ref: "1", text: "deployment changed" });
  expect(recalled(said("20", "21", "2", "what changed earlier about deployment?")).rows).toMatchObject([
    { role: "lead", thread: "21", text: "deployment changed" },
  ]);
  expect(recalled(said("30", "21", "2", "what changed earlier about deployment?")).rows).toEqual([]);
});

posix("exact-scope purge clears all its spaces and preserves overlapping rows in every other identity", () => {
  const identities = [
    [createRecallScope("discord", "99", "10"), "original"],
    [createRecallScope("discord", "98", "10"), "different bot"],
    [createRecallScope("discord", "99", "11"), "different owner"],
    [createRecallScope("telegram", "99", "10"), "different platform"],
  ] as const;
  const otherRoom = { channel: "30", thread: "30" };
  const row = { at: now, role: "owner", ref: "1" } as const;
  for (const [identity, text] of identities) {
    const ledger = openRecallLedger(state.dir, identity, { settings: undefined, now });
    try {
      ledger.record(room, { ...row, text });
      ledger.record(otherRoom, { ...row, text });
    } finally {
      ledger.close();
    }
  }
  const read = (identity: typeof scope, conversation: typeof room) => {
    const ledger = openRecallLedger(state.dir, identity, { settings: undefined, now });
    try {
      return ledger.rows(conversation).map((item) => item.text);
    } finally {
      ledger.close();
    }
  };
  for (const [identity, text] of identities) expect(read(identity, room)).toEqual([text]);
  expect(purgeRecallLedger(state.dir, scope)).toBe(2);
  expect(read(scope, room)).toEqual([]);
  expect(read(scope, otherRoom)).toEqual([]);
  for (const [identity, text] of identities.slice(1)) {
    expect(read(identity, room)).toEqual([text]);
    expect(read(identity, otherRoom)).toEqual([text]);
  }
});

posix("retention on open sweeps only the requested scope", () => {
  const old = now - 31 * DAY;
  const otherScope = createRecallScope("discord", "98", "10");
  for (const identity of [scope, otherScope]) {
    const ledger = openRecallLedger(state.dir, identity, { settings: undefined, now: old });
    try {
      ledger.record(room, { at: old, role: "owner", ref: "1", text: "older note" });
    } finally {
      ledger.close();
    }
  }
  const current = openRecallLedger(state.dir, scope, { settings: undefined, now });
  try {
    expect(current.rows(room)).toEqual([]);
  } finally {
    current.close();
  }
  const other = openRecallLedger(state.dir, otherScope, { settings: { enabled: true, retentionDays: 60 }, now });
  try {
    expect(other.rows(room).map((row) => row.text)).toEqual(["older note"]);
  } finally {
    other.close();
  }
});

test("forged scope and missing conversation do not create messenger storage", () => {
  const missing = join(state.dir, "missing");
  const options = { settings: undefined, now };
  const forged = { ...scope };
  expect(() => openRecallLedger(missing, forged, options)).toThrow("scope must be validated");
  expect(() => purgeRecallLedger(missing, forged)).toThrow("scope must be validated");
  recall().lead({ channel: "", thread: "21", ref: "1", text: "unverified space" });
  expect(warnings).toHaveLength(1);
  expect(existsSync(missing)).toBe(false);
  expect(existsSync(join(state.dir, STORE))).toBe(false);
});
