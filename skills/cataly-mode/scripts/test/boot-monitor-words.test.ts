import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, type Monitor, monitorCleanup, readMonitorManifests } from "../src/boot-monitors.ts";
import { CATALY_COMMANDS, CATALY_VALUE_OPTIONS } from "../src/monitor-cataly.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { withState } from "./fakes.ts";

// Which words of a watch's own command may name a lane: base matched every word; each command's program, and a cataly
// program's command and platform, are excluded (src/monitor-command.ts), and a legacy record never crashes the match.
// test/boot-monitor-matrix.test.ts holds every reviewed counterexample.
const lane = (key: string, status: LaneStatus): Lane => ({
  key,
  status,
  pane: `w1:${key}`,
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: "2026-01-01T12:00:00.000Z",
});

const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/extensions/terminal/owner.json",
  data: {
    version: 1,
    sessionId: "owner",
    monitors: monitors.map((m) => ({ sessionId: "owner", persistent: true, monitorId: "mon_FIXTURE", ...m })),
  },
});

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a legacy record whose argv holds a non-string is still matched by its command, as before", () => {
  const dir = join(state.dir, "legacy");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "owner.json"),
    JSON.stringify({
      version: 1,
      sessionId: "owner",
      monitors: [
        { sessionId: "owner", persistent: true, monitorId: "mon_TEST", argv: [7], command: "cataly checkpoints api" },
      ],
    }),
  );
  const read = readMonitorManifests(join(state.dir, "missing"), [dir]);
  expect(read.errors).toEqual([]);
  expect(monitorCleanup([lane("api", "closed")], read.manifests).map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_TEST", ["api:command:key"]],
  ]);
});

test("a closed lane named in an argument position is still claimed, even when its key is a cataly program name", () => {
  const lanes = ["cataly", "omp-cataly", "api-fix", "harness-lane"].map((key) => lane(key, "closed"));
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["cataly", "checkpoints", "cataly"], monitorId: "mon_CATALY" },
      { argv: ["cataly", "checkpoints", "omp-cataly"], monitorId: "mon_OMP" },
      { command: "cataly checkpoints cataly", monitorId: "mon_COMMAND" },
      { argv: ["rg", "-n", "/src/omp-cataly", "api-fix"], monitorId: "mon_PATH" },
      { argv: ["bun", "/repo/src/cli.ts", "send", "harness-lane", "hi"], monitorId: "mon_HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_CATALY", ["cataly:argv:key"]],
    ["mon_OMP", ["omp-cataly:argv:key"]],
    ["mon_COMMAND", ["cataly:command:key"]],
    ["mon_PATH", ["api-fix:argv:key"]],
    ["mon_HARNESS", ["harness-lane:argv:key"]],
  ]);
});

test("a shared cataly watch behind a launcher with options is still not claimed by its own command words", () => {
  const lanes = ["cataly", "inbound", "slack"].map((key) => lane(key, "closed"));
  const argv = [
    ["env", "-u", "NODE_OPTIONS", "cataly", "inbound", "slack"],
    ["env", "-i", "/home/user/.cataly/bin/cataly", "inbound", "slack"],
    ["timeout", "60", "cataly", "inbound", "slack"],
    ["timeout", "--signal", "TERM", "60", "cataly", "inbound", "slack"],
    ["nice", "-n", "10", "cataly", "inbound", "slack"],
    ["stdbuf", "-oL", "cataly", "inbound", "slack"],
    ["FOO=a b", "cataly", "inbound", "slack"],
  ];
  const commands = [
    'FOO="a b" cataly inbound slack',
    "env -u NODE_OPTIONS cataly inbound slack",
    "bash -lc 'exec -a intake cataly inbound slack'",
    'sh -c "nohup cataly inbound slack"',
  ];
  const monitors = [...argv.map((words) => ({ argv: words })), ...commands.map((command) => ({ command }))];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
});

test("a relative cli.ts entry is cataly's own, and an argument after its command still names a lane", () => {
  const lanes = ["freshness", "api-fix"].map((key) => lane(key, "closed"));
  const skill = "/w/skills/cataly-mode/scripts";
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["bun", "src/cli.ts", "freshness"], cwd: skill, monitorId: "mon_SKILL" },
      { command: "bun run src/cli.ts freshness", cwd: skill, monitorId: "mon_SKILL_COMMAND" },
      { argv: ["bun", "src/cli.ts", "send", "api-fix", "hi"], cwd: "/w", monitorId: "mon_HARNESS" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["mon_HARNESS", ["api-fix:argv:key"]]]);
});

test("a word after a cataly program that is no cataly command still names a lane: rg -c cataly api-fix", () => {
  const result = monitorCleanup(
    [lane("api-fix", "closed")],
    [
      manifest([
        { argv: ["rg", "-c", "cataly", "api-fix"], monitorId: "mon_ARGV" },
        { command: "rg -c cataly api-fix", monitorId: "mon_COMMAND" },
      ]),
    ],
  );
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_ARGV", ["api-fix:argv:key"]],
    ["mon_COMMAND", ["api-fix:command:key"]],
  ]);
});

test("a shared cataly watch inside a loop, a condition, a subshell, a cd or an env -C stays unclaimed", () => {
  const scripts = "/w/skills/cataly-mode/scripts";
  const lanes = ["slack", "freshness"].map((key) => lane(key, "closed"));
  const monitors: Monitor[] = [
    { command: "while true; do cataly inbound slack --loop 1; sleep 3; done" },
    { command: "while true; do exec cataly inbound slack --loop 1; done" },
    { command: "if test -f /ready; then cataly inbound slack --loop 1; fi" },
    { command: "( cataly inbound slack --loop 1 )" },
    { command: `cd ${scripts} && bun src/cli.ts freshness`, cwd: "/repo" },
    { argv: ["env", "-C", scripts, "bun", "src/cli.ts", "freshness"], cwd: "/repo" },
    { argv: ["bun", "src/cli.ts", "freshness"], cwd: scripts },
    { argv: ["timeout", "-vk", "5", "60", "cataly", "inbound", "slack"] },
    { command: "bash -O extglob -c 'exec cataly inbound slack --loop 1'" },
  ];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
  // An open lane named anywhere still keeps the watch.
  const open = [lane("slack", "working"), lane("api", "closed")];
  expect(monitorCleanup(open, [manifest([{ command: "while true; do cataly inbound slack; done # api" }])])).toEqual(
    [],
  );
});

test("relayed is a command word, while its target still identifies a closed lane", () => {
  const lanes = ["relayed", "api"].map((key) => lane(key, "closed"));
  const receipt = "a".repeat(64);
  const result = monitorCleanup(lanes, [
    manifest([
      { argv: ["cataly", "relayed", "api", "--report", receipt], monitorId: "mon_ARGV" },
      { command: `cataly relayed api --report ${receipt}`, monitorId: "mon_COMMAND" },
      { argv: ["cataly", "relayed", "relayed", "--report", receipt], monitorId: "mon_TARGET" },
    ]),
  ]);
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([
    ["mon_ARGV", ["api:argv:key"]],
    ["mon_COMMAND", ["api:command:key"]],
    ["mon_TARGET", ["relayed:argv:key"]],
  ]);
});

test.each(["owner", "report"])("report option values do not hide a messenger platform: %s", (option) => {
  const monitors: Monitor[] = [
    { argv: ["cataly", "inbound", `--${option}`, "slack", "discord"] },
    { command: `cataly inbound --${option} slack discord` },
  ];
  expect(monitorCleanup([lane("discord", "closed")], [manifest(monitors)])).toEqual([]);
});

test("lanes is a command word, but report can still target a lane named lanes", () => {
  const result = monitorCleanup(
    [lane("lanes", "closed")],
    [
      manifest([
        { argv: ["cataly", "lanes", "--thread", "discord:123", "--open"], monitorId: "mon_ARGV" },
        { command: "cataly lanes --open", monitorId: "mon_COMMAND" },
        { argv: ["cataly", "report", "lanes", "--kind", "done", "--text", "complete"], monitorId: "mon_TARGET" },
      ]),
    ],
  );
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["mon_TARGET", ["lanes:argv:key"]]]);
});

test("a Discord voice monitor does not belong to lanes named voice or discord", () => {
  const lanes = ["voice", "discord"].map((key) => lane(key, "closed"));
  const monitors = [{ argv: ["cataly", "voice", "discord"] }, { command: "cataly voice discord" }];
  expect(monitorCleanup(lanes, [manifest(monitors)])).toEqual([]);
});

test("the monitor vocabulary matches CLI dispatch and value options", () => {
  const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
  const commands = [
    ...cli.matchAll(/^\s*case "([\w-]+)":/gm),
    ...cli.matchAll(/^if \(command === "([\w-]+)"\)/gm),
  ].flatMap(([, word]) => (word && !word.startsWith("-") ? [word] : []));
  const flags = readFileSync(join(import.meta.dir, "../src/cli-flags.ts"), "utf8");
  const values = [...flags.matchAll(/^\s+"?([\w-]+)"?: \{ type: "string"/gm)].map(([, word]) => word ?? "");
  expect(Object.keys(CATALY_COMMANDS).sort()).toEqual([...new Set(commands)].sort());
  expect(Object.keys(CATALY_VALUE_OPTIONS).sort()).toEqual(values.sort());
});
