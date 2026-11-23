import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("validates Discord setup IDs before changing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "cataly-cli-"));
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, "discord", "setup", ...args], {
    encoding: "utf8", env: { ...process.env, CATALY_HOME: dir },
  });
  try {
    for (const args of [["--owner", "typo"], ["--guild", "123"], ["--channels", "123456789012345678,"]]) {
      const result = run(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /snowflake/);
      assert.equal(existsSync(join(dir, "config.json")), false);
    }
    assert.equal(run(["--owner", "123456789012345678", "--channels", "123456789012345679, 123456789012345680"]).status, 0);
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(config.discord.channelIds, ["123456789012345679", "123456789012345680"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
