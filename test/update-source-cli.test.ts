import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("source update help dispatches its own CLI before consumer profile or user config admission", () => {
  const home = mkdtempSync(join(tmpdir(), "cataly-source-cli-"));
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts"),
        "update",
        "source",
        "--help",
      ],
      {
        env: { HOME: home, PATH: process.env["PATH"], CATALY_TELEMETRY: "0", DO_NOT_TRACK: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("cataly update source");
    expect(result.stdout.toString()).toContain("--when idle");
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
