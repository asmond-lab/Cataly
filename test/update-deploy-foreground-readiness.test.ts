import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { foregroundActor, silentForegroundActor } from "./update-deploy-foreground-readiness.ts";

const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

posix("a silent foreground actor cannot leave readiness pending", async () => {
  const actor = silentForegroundActor();
  try {
    await actor.monitorPid();
    await expect(actor.waitForReady(100)).rejects.toThrow("actor ready line timed out after 100ms");
  } finally {
    await actor.dispose();
  }
});

posix("foreground fixture names the launch phase when its child exits before readiness", async () => {
  const actor = foregroundActor.spawn("prior", () =>
    spawn("/bin/bash", ["-c", "IFS= read -r line; exit 7"], { stdio: ["pipe", "pipe", "ignore", "pipe"] }),
  );
  try {
    const ready = actor.waitForReady();
    actor.child.stdin!.end("stop\n");
    await expect(ready).rejects.toThrow(/prior actor readiness:.*stdout EOF/);
  } finally {
    await actor.stop();
  }
  expect(actor.child.exitCode).toBe(7);
});
