import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { up } from "../src/cli-up.ts";
import { shq } from "../src/delivery.ts";
import { review } from "../src/gate.ts";
import { startLane } from "../src/lanes.ts";
import { catalyLaunchEnv } from "../src/release/runtime.ts";
import { captureIo } from "./inbox-setup.ts";
import { recorded, recordingOmp } from "./terminal-context-setup.ts";
import { expectContext, managedTerminal } from "./terminal-managed-setup.ts";

// POSIX-only: the transport fixture records through /bin/sh shebang programs and `env -0`.
const posix = test.skipIf(process.platform === "win32");

for (const runtime of ["herdr", "hc"] as const) {
  for (const conflicting of [false, true]) {
    posix(
      `${runtime}: harness agents and controllers cross a daemon with conflicting=${conflicting} defaults`,
      async () => {
        const f = managedTerminal(runtime, conflicting);
        try {
          await captureIo(async () => {
            await up(f.deps, f.cwd);
            return 0;
          });
          // Only the harness selection is in effect here: the daemon may still default children to headless.
          for (const session of f.daemon.sessions.values()) expect(session.env["CATALY_RUNTIME"]).toBe(runtime);
          await startLane(f.deps, "transport-lane", f.brief, { cwd: f.cwd, group: "w1" });
          expect(f.daemon.captures).toHaveLength(5);
          const agents = f.daemon.captures.filter((capture) => capture.stdout.includes("\nENV\n"));
          expect(agents).toHaveLength(3);
          for (const capture of agents) {
            const child = expectContext(capture, f.expected);
            expect(child.argv.slice(0, f.prefix.length)).toEqual(f.prefix);
          }
          for (const session of f.daemon.sessions.values()) {
            for (const [key, value] of Object.entries(f.expected)) expect(session.env[key]).toBe(value);
            expect(session.env["UNRELATED_SECRET"]).toBeUndefined();
          }
          expect(recorded(agents[2]!).argv.slice(f.prefix.length, f.prefix.length + 2)).toEqual([
            "--cataly-role",
            "lane",
          ]);
        } finally {
          await f.daemon.close();
        }
      },
    );
  }

  posix(`${runtime}: explicit harness shell commands keep literal assignments and argument semantics`, async () => {
    const f = managedTerminal(runtime);
    const external = join(f.root, "owner tools", "custom-agent");
    mkdirSync(dirname(external), { recursive: true });
    recordingOmp(external);
    const value = "owner value 'quote' ; $(touch assignment-ran)";
    const command = `env OWNER_VALUE=${shq(value)} ${shq(external)} --literal ''`;
    try {
      await startLane({ ...f.deps, agentCmd: command }, "external-lane", f.brief, { cwd: f.cwd, group: "w1" });
      const child = expectContext(f.daemon.captures[0]!, f.expected);
      expect(child.argv.slice(0, 3)).toEqual([external, "--literal", ""]);
      expect(child.argv).not.toContain("--cataly-role");
      expect(child.env["OWNER_VALUE"]).toBe(value);
      expect(existsSync(join(f.cwd, "assignment-ran"))).toBe(false);
    } finally {
      await f.daemon.close();
    }
  });
}

posix("fresh reviewer receives the selected context and drops parent pane and managed-startup identities", async () => {
  const f = managedTerminal("herdr");
  let child: { argv: string[]; env: Record<string, string> } | undefined;
  f.world.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: "a".repeat(40) }) });
  const deps = {
    ...f.deps,
    exec: async (cmd: string, argv: readonly string[]) => {
      if (cmd === "gh") return f.world.exec(cmd, argv);
      expect(cmd).toBe("env");
      expect(argv.some((part) => part.startsWith("UNRELATED_SECRET="))).toBe(false);
      const result = Bun.spawnSync([cmd, ...argv], { cwd: f.cwd });
      child = recorded({
        serverPid: process.pid,
        childPid: result.pid,
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      });
      return { code: result.exitCode, stdout: "VERDICT: CLEAR", stderr: result.stderr.toString() };
    },
  };
  try {
    expect((await review(deps, "fixture/repo#7", "fixture/model")).verdict).toBe("CLEAR");
    for (const [key, value] of Object.entries(f.expected)) {
      if (key !== "CATALY_MANAGED_STARTUP") expect(child!.env[key]).toBe(value);
    }
    for (const key of [
      "HERDR_PANE_ID",
      "HERDR_WORKSPACE_ID",
      "HC_TERMINAL_ID",
      "CATALY_MANAGED_STARTUP",
      "CATALY_LANE",
    ])
      expect(child!.env[key]).toBeUndefined();
    expect(child!.argv.slice(0, f.prefix.length)).toEqual(f.prefix);
    expect(child!.argv.slice(f.prefix.length, f.prefix.length + 6)).toEqual([
      "--cataly-role",
      "lane",
      "-p",
      "--no-session",
      "--model",
      "fixture/model",
    ]);
  } finally {
    await f.daemon.close();
  }
});

test("launch context makes relative paths absolute without collapsing OS links or explicit empty scope", () => {
  const raw = `relative${sep}link${sep}..${sep}config.json`;
  const context = catalyLaunchEnv(
    {
      CATALY_AGENT_ARGV: '["/selected omp", "--literal", ""]',
      CATALY_HOME: "relative home",
      CATALY_STATE_DIR: "relative state",
      CATALY_OMP_ULW_PATH: "relative ulw/index.ts",
      OMP_ULW_SCOPE_FILE: "",
      HERDR_PANE_ID: "wparent:pparent",
      CATALY_MANAGED_STARTUP: "1",
      SECRET: "private",
    },
    raw,
  );
  expect(context).toEqual({
    CATALY_MANAGED_STARTUP: "",
    CATALY_CONFIG: `${process.cwd()}${sep}${raw}`,
    CATALY_HOME: `${process.cwd()}${sep}relative home`,
    CATALY_STATE_DIR: `${process.cwd()}${sep}relative state`,
    CATALY_OMP_ULW_PATH: `${process.cwd()}${sep}relative ulw/index.ts`,
    OMP_ULW_SCOPE_FILE: "",
    CATALY_AGENT_ARGV: '["/selected omp", "--literal", ""]',
  });
});
