import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { importLegacyEnvironment } from "../src/legacy-environment.ts";
import { currentAgentCommand } from "../src/runtime/legacy-agent-command.ts";
import { readRuntimeChoice } from "../src/runtime/select.ts";

test("upgrading reads the old installer's exact command without rewriting the owner's config or selecting hc", async () => {
  const home = mkdtempSync(join(tmpdir(), "cataly-upgrade-"));
  const path = join(home, "config.json");
  const argv = [join(home, "bin", "omp"), "--dori-role", "lane", "--model", "{model}", "{prompt}"] as const;
  const bytes = JSON.stringify({ runtime: "hc", agentCommand: argv, stateDir: join(home, "state") });
  try {
    writeFileSync(path, bytes);
    const env = { CATALY_HOME: home, PATH: "" };
    const config = await loadConfig(path, home, env);
    expect(config.agentCommand).toEqual([argv[0], "--cataly-role", "lane", ...argv.slice(3)]);
    expect(readRuntimeChoice({ env, configPath: path }).kind).toBe(process.platform === "win32" ? "hc" : "headless");
    expect(readFileSync(path, "utf8")).toBe(bytes);
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("role migration does not interpret opaque executables, option values or prompt text as owned flags", () => {
  for (const argv of [
    ["my-agent", "--dori-role", "lane"],
    ["omp", "--system-prompt", "--dori-role", "--", "--dori-role=lane"],
  ])
    expect(currentAgentCommand(argv)).toEqual(argv);
  expect(currentAgentCommand(["omp", "--dori-role=dori"])).toEqual(["omp", "--cataly-role=cataly"]);
  expect(() => currentAgentCommand(["omp", "--dori-role=lane", "--cataly-role=cataly"])).toThrow("Ambiguous");
});

test.skipIf(process.platform === "win32")("the harness selects the config the OS resolves after a symlink", () => {
  const home = mkdtempSync(join(tmpdir(), "cataly-config-link-"));
  try {
    mkdirSync(join(home, "real/child"), { recursive: true });
    symlinkSync(join(home, "real/child"), join(home, "link"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ sessionRuntime: "hc" }));
    writeFileSync(join(home, "real/config.json"), JSON.stringify({ sessionRuntime: "headless" }));
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "status"], {
      cwd: home,
      env: { HOME: home, CATALY_HOME: home, CATALY_CONFIG: "link/../config.json", CATALY_TELEMETRY: "0" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("RUNTIME headless (from config)");
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("an explicit empty canonical token wins over old environment and the legacy secret is not inherited", () => {
  const env: Record<string, string | undefined> = {
    DORI_DISCORD_TOKEN: "legacy-value",
    CATALY_DISCORD_TOKEN: "",
    DORI_HOME: "/old",
    OMP_DORI_HOME: "/side",
  };
  importLegacyEnvironment(env);
  expect(env).toEqual({ CATALY_DISCORD_TOKEN: "", CATALY_HOME: "/old", OMP_CATALY_HOME: "/side" });
});
