import { expect, test } from "bun:test";
import { appendFileSync, linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run as runChild } from "../src/run.ts";
import { listUsageJournals, readUsageCache } from "../src/usage-file.ts";
import { readSessionUsage, readUsageHeader } from "../src/usage-session.ts";
import { withState } from "./fakes.ts";

const header = JSON.stringify({ type: "session", id: "fixture-session", timestamp: "2026-01-01T00:00:00Z" });

test("native capture rejects output on either pipe without returning partial text", async () => {
  for (const pipe of ["stdout", "stderr"]) {
    const script = `process.${pipe}.write("x".repeat(256 * 1024))`;
    const response = await runChild([process.execPath, "-e", script], { timeoutMs: 5_000, captureMaxBytes: 1024 });
    expect(response).toEqual({ code: 125, out: "", err: "child output exceeded capture limit" });
  }
  const control = await runChild([process.execPath, "-e", 'process.stdout.write("한")'], { captureMaxBytes: 3 });
  expect(control).toEqual({ code: 0, out: "한", err: "" });
});

test("usage reads only a bounded header for discovery", async () => {
  const state = withState();
  try {
    const related = join(state.dir, "valid.jsonl");
    const extra = join(state.dir, "long-prefix.jsonl");
    writeFileSync(related, `${header}\n${"body to ignore".repeat(9000)}`);
    writeFileSync(extra, `${" ".repeat(65_536)}\n${header}\n`);
    expect((await readUsageHeader(related)).id).toBe("fixture-session");
    await expect(readUsageHeader(extra)).rejects.toThrow("session header unavailable");
  } finally {
    state.done();
  }
});

test("usage bodies must match the file version admitted by discovery", async () => {
  const state = withState();
  try {
    const file = join(state.dir, "usage.jsonl");
    writeFileSync(file, `${header}\n`);
    const observed = await readUsageHeader(file);
    const exact = await readSessionUsage(file, undefined, observed.signature);
    expect(exact).toMatchObject({ id: "fixture-session", entries: [], errors: [] });
    appendFileSync(file, "\n");
    await expect(readSessionUsage(file, undefined, observed.signature)).rejects.toThrow(
      "session changed after header admission",
    );
  } finally {
    state.done();
  }
});

test.skipIf(process.platform === "win32")("usage rejects ambiguous linked file identities at discovery", async () => {
  const state = withState();
  try {
    const file = join(state.dir, "real.jsonl");
    const alias = join(state.dir, "alias.jsonl");
    writeFileSync(file, `${header}\n`);
    linkSync(file, alias);
    await expect(readUsageHeader(alias)).rejects.toThrow("owned regular session file");
  } finally {
    state.done();
  }
});

test("usage directory overflow reports an incomplete scan instead of a partial journal list", () => {
  const state = withState();
  try {
    for (let i = 0; i < 4096; i++) writeFileSync(join(state.dir, `${i}.jsonl`), "");
    expect(listUsageJournals(state.dir)).toHaveLength(4096);
    writeFileSync(join(state.dir, "overflow.jsonl"), "");
    expect(() => listUsageJournals(state.dir)).toThrow("directory scan limit exceeded");
  } finally {
    state.done();
  }
});

test("usage cache bounds are measured in bytes before reading the descriptor", () => {
  const state = withState();
  try {
    const file = join(state.dir, "cache.json");
    writeFileSync(file, "한");
    expect(readUsageCache(file, 3)).toBe("한");
    expect(() => readUsageCache(file, 2)).toThrow("cache outside size limit");
  } finally {
    state.done();
  }
});
