import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { prepareSchedule, schedulePreview } from "../src/schedule-prepare.ts";
import { join, resolve } from "node:path";

let dir: string;
const cli = resolve(import.meta.dir, "../src/cli.ts");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cataly-inspect-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ runtime: "herdr", stateDir: join(dir, "state") }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function invoke(...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, "--no-env-file", cli, ...args], {
    cwd: dir,
    env: {
      HOME: dir,
      PATH: process.env["PATH"],
      CATALY_CONFIG: join(dir, "config.json"),
      CATALY_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}
const command = ["--", process.execPath, "-e", "require('node:fs').writeFileSync('must-not-run', 'oops')"];

test("cron dry-run predicts five IANA trigger instants without creating state or executing argv", () => {
  const result = invoke(
    "schedule",
    "add",
    "preview",
    "--cron",
    "0 9 * * *",
    "--tz",
    "Asia/Seoul",
    "--dry-run",
    ...command,
  );
  expect(result.code).toBe(0);
  const view = JSON.parse(result.out);
  expect(view.dryRun).toBe(true);
  expect(view.candidate.id).toBeUndefined();
  expect(view.occurrences).toHaveLength(5);
  expect(view.occurrencesLocal).toHaveLength(5);
  expect(view.occurrencesLocal[0]).toMatchObject({ timeZone: "Asia/Seoul" });
  expect(view.occurrencesLocal[0].local).toContain("09:00:00");
  for (const instant of view.occurrences) expect(instant).toMatch(/T00:00:00.000Z$/);
  expect(existsSync(join(dir, "state"))).toBe(false);
  expect(existsSync(join(dir, "must-not-run"))).toBe(false);
});

test("at dry-run has one instant, condition estimates have fixed idle spacing", () => {
  const once = invoke("schedule", "add", "once", "--at", "2099-01-01T09:00:00+09:00", "--dry-run", ...command);
  expect(JSON.parse(once.out).occurrences).toEqual(["2099-01-01T00:00:00.000Z"]);
  const condition = JSON.parse(
    invoke("schedule", "add", "probe", "--every-seconds", "30", "--dry-run", ...command).out,
  );
  expect(condition.estimate).toContain("idle polls");
  expect(condition.candidate.timeoutSeconds).toBe(30);
  expect(Date.parse(condition.occurrences[1]) - Date.parse(condition.occurrences[0])).toBe(30_000);
  expect(existsSync(join(dir, "state"))).toBe(false);
});

test("show and dry-run preserve existing state bytes, mtime, receipts and directory contents", () => {
  expect(invoke("schedule", "add", "one", "--cron", "* * * * *", "--tz", "UTC", ...command).code).toBe(0);
  expect(invoke("schedule", "add", "two", "--every-seconds", "30", ...command).code).toBe(0);
  const path = join(dir, "state/schedule.json");
  const before = readFileSync(path, "utf8");
  const time = statSync(path).mtimeMs;
  const contents = readdirSync(join(dir, "state"));
  const shown = invoke("schedule", "show", "two");
  expect(shown.code).toBe(0);
  expect(JSON.parse(shown.out).jobs.map((job: { name: string }) => job.name)).toEqual(["two"]);
  expect(invoke("schedule", "show", "missing").code).toBe(1);
  expect(invoke("schedule", "show", "one", "extra").code).toBe(1);
  expect(invoke("schedule", "add", "one", "--cron", "* * * * *", "--tz", "UTC", "--dry-run", ...command).code).toBe(1);
  expect(invoke("schedule", "add", "new", "--cron", "* * * * *", "--tz", "UTC", "--dry-run", ...command).code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(statSync(path).mtimeMs).toBe(time);
  expect(readdirSync(join(dir, "state"))).toEqual(contents);
  expect(existsSync(join(dir, "must-not-run"))).toBe(false);
});

test("dry-run cannot silently mutate other subcommands and refuses inline false", () => {
  for (const args of [
    ["list", "--dry-run"],
    ["add", "x", "--cron", "* * * * *", "--tz", "UTC", "--dry-run=false", ...command],
  ])
    expect(invoke("schedule", ...args).code).toBe(1);
  expect(existsSync(join(dir, "state"))).toBe(false);
});

test("DST previews preserve spring-gap and fall-fold trigger semantics", () => {
  const input = {
    name: "dst",
    cron: "30 2 * * *",
    tz: "America/New_York",
    cwd: dir,
    argv: ["false"],
    deliver: "log" as const,
  };
  const spring = schedulePreview(prepareSchedule(input, Date.parse("2027-03-14T06:59:00Z")), 2);
  expect(spring).toEqual([Date.parse("2027-03-14T07:00:00Z"), Date.parse("2027-03-15T06:30:00Z")]);
  const fall = schedulePreview(
    prepareSchedule({ ...input, cron: "30 1 * * *" }, Date.parse("2026-11-01T04:00:00Z")),
    2,
  );
  expect(fall).toEqual([Date.parse("2026-11-01T05:30:00Z"), Date.parse("2026-11-02T06:30:00Z")]);
});
