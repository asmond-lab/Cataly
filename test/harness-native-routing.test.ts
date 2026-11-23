import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { headlessArgv, HeadlessRuntime, type HeadlessObservation } from "../src/runtime/headless.ts";
import { writePrivate } from "../src/runtime/headless-record.ts";
import { Store } from "../src/store.ts";
import { headlessFixture } from "./fixtures/runtime-headless.ts";

const cli = resolve(import.meta.dir, "../src/cli.ts");

async function waitFor(read: () => Promise<HeadlessObservation>, ready: (seen: HeadlessObservation) => boolean) {
  const deadline = Date.now() + 10_000;
  do {
    const seen = await read();
    if (ready(seen)) return seen;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error("native lead did not reach the expected state");
}

test.skipIf(process.platform === "win32")(
  "fresh CLI processes send to, observe, and answer the registered native role at its launch override",
  async () => {
    const f = headlessFixture();
    const stateDir = join(f.home, "one-invocation-state");
    const rt = new HeadlessRuntime(stateDir, f.env);
    const store = new Store(f.home);
    const { CATALY_STATE_DIR: _, ...fresh } = f.env;
    const env = { ...fresh, CATALY_TELEMETRY: "0" };
    const command = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${err || out}`);
      return out.trim();
    };
    const lead = await rt.create({ name: "lead", role: "lead", cwd: f.home, env: {}, container: "tab" });
    try {
      const seen = await rt.startNative(lead, headlessArgv(f.deps.config.agentCommand, "fixture/initial", "lead"), {
        ...f.env,
        CATALY_STATE_DIR: stateDir,
      });
      const session = seen.sessionId;
      if (!session) throw new Error("fake native lead failed to prove its session");
      writePrivate(join(f.home, "harness-native.json"), {
        version: 1,
        stateDir,
        roles: { lead: { ref: lead, sessionId: session } },
      });
      store.setRole("lead", lead);

      expect(await command("send", "lead", "--text", "request approval")).toBe("DELIVERED lead");
      const observed = await waitFor(
        async () => JSON.parse(await command("observe", `headless:${lead.id}`)),
        (value) => value.dialogs.length > 0,
      );
      expect(observed).toMatchObject({ harnessRole: "lead", sessionId: session, status: "blocked" });
      const request = observed.dialogs[0];
      if (!request) throw new Error("approval missing from observe");
      const raw = `headless:${lead.id}`;
      // A controller can exit after the broker binds, while its inventory is still reservation-only.
      store.clearRoles([["lead", lead]]);
      writePrivate(join(f.home, "harness-native.json"), { version: 1, stateDir, roles: { lead: { ref: lead } } });
      await expect(command("send", raw, "--text", "must not be delivered")).rejects.toThrow(
        "no matching verified native role registration",
      );
      expect(JSON.parse(await command("observe", raw))).toMatchObject({ sessionId: session, status: "blocked" });
      await expect(
        command("answer", raw, "--session", "other-session", "--request", request.id, "--text", '{"value":"Deny"}'),
      ).rejects.toThrow("answer session does not match");
      await command("answer", raw, "--session", session, "--request", request.id, "--text", '{"value":"Deny"}');
      await waitFor(
        () => rt.observe(lead),
        (value) => value.status === "idle",
      );
      expect(f.frames().filter((frame) => frame["type"] === "extension_ui_response")).toEqual([
        { type: "extension_ui_response", id: request.id, value: "Deny" },
      ]);
    } finally {
      const seen = await rt.observe(lead);
      if (seen.sessionId) {
        for (const dialog of seen.dialogs) await rt.answer(lead, dialog.id, { cancelled: true }, seen.sessionId);
        await waitFor(
          () => rt.observe(lead),
          (value) => value.status === "idle",
        );
      }
      await rt.stopHarnessRole(lead, "lead", seen.sessionId);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  90_000,
);
