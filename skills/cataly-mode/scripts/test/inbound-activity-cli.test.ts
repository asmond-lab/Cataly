import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform as host } from "../../../../src/platform/index.ts";
import { withState } from "./fakes.ts";

const activityTest = test.skipIf(!host.supportsProcessReaders);

activityTest("slack REST exits nonzero when its required activity writer fails", async () => {
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    const activity = join(state.dir, "activity.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "herdr", hooks: {} }));
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "record-inbound-activity-failure.ts"),
        join(import.meta.dir, "../src/cli.ts"),
        "inbound",
        "slack",
        "--loop",
        "0",
        "--activity-file",
        activity,
      ],
      {
        env: {
          HOME: state.dir,
          PATH: "/usr/bin:/bin",
          CATALY_CONFIG: config,
          CATALY_STATE_DIR: state.dir,
          CATALY_TEST_ACTIVITY: activity,
          CATALY_SLACK_TOKEN: "synthetic-slack-token",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(1);
    expect(err).toContain("Inbound activity");
    expect(out).not.toContain("WARN");
    expect(out).not.toContain("INBOUND own-thread ");
    expect(out + err).not.toMatch(/synthetic-slack-token/);
    expect(existsSync(activity + ".lock/owner.json")).toBe(false);
  } finally {
    state.done();
  }
});
