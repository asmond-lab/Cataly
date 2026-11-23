import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { adoptLane, launchLane } from "../skills/cataly-mode/scripts/src/launch.ts";
import { RemoteRecords } from "../skills/cataly-mode/scripts/src/remote-records.ts";
import { remoteOperation } from "../skills/cataly-mode/scripts/src/remote-worker.ts";
import { liveSessions, selectSession } from "../src/remote/client.ts";
import { remotePolicy, setRemotePolicy } from "../src/remote/policy.ts";
import { remoteSocketPath } from "../src/remote/socket-path.ts";
import { peer, throughPeer } from "../src/remote/transport.ts";
import { HeadlessRuntime } from "../src/runtime/headless.ts";
import { formatRef, type SessionRef } from "../src/runtime/types.ts";
import { startTestEndpoint } from "./fixtures/remote-endpoint.ts";
import { headlessFixture } from "./fixtures/runtime-headless.ts";

const CLI = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts");
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "cataly-remote-test-"));
  const state = join(root, "state");
  cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const env = { ...process.env, CATALY_CONFIG: join(root, "missing-config.json"), CATALY_STATE_DIR: state };
  return { root, state, env };
}

test.skipIf(process.platform === "win32")(
  "target CLI checks opt-in policy per request and never treats input as argv",
  async () => {
    const { state, env } = sandbox();
    const session = await startTestEndpoint(state, cleanup);
    const text = "'\" $HOME $(echo no)\nsecond line";
    const accept = async (request: object) => {
      const p = Bun.spawn([process.execPath, CLI, "remote", "accept"], {
        env,
        stdin: new Blob([JSON.stringify(request)]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect({ err, code }).toEqual({ err: "", code: 0 });
      return JSON.parse(out);
    };
    expect(await accept({ op: "sessions" })).toMatchObject({ ok: false, error: expect.stringContaining("disabled") });
    expect(remotePolicy(state)).toEqual({ control: false, wake: false });
    setRemotePolicy(state, "control", true);
    expect(await accept({ op: "sessions" })).toMatchObject({ ok: true, data: [session.target] });
    expect(await accept({ op: "read", session: "native" })).toMatchObject({
      ok: true,
      data: { messages: [{ role: "assistant", text: "status" }] },
    });
    expect(await accept({ op: "send", session: "native-001", generation: "stale", text })).toMatchObject({ ok: false });
    expect(await accept({ op: "send", session: "native-001", generation: "original", id: "once", text })).toMatchObject(
      {
        ok: true,
        data: { status: "admitted", text },
      },
    );
    expect(session.inputs()).toBe(1);
    expect(await accept({ op: "wake", session: "native-001" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("wake is disabled"),
    });
    setRemotePolicy(state, "wake", true);
    expect(await accept({ op: "close", session: "native-001" })).toEqual({
      ok: false,
      error: "close held by approval",
    });
    expect(await accept({ op: "wake", session: "native-001" })).toMatchObject({ ok: true, data: session.target });
    session.loseCloseReply();
    expect(await accept({ op: "close", session: "native-001" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("receipt"),
    });
    expect(await accept({ op: "wake", session: "native-001" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("close outcome is unconfirmed"),
    });
    setRemotePolicy(state, "control", false);
    expect(await accept({ op: "read", session: "native-001" })).toMatchObject({ ok: false });
  },
);

test.skipIf(process.platform === "win32")(
  "standalone remote close leaves a registered headless lane and its close receipt unchanged",
  async () => {
    const f = headlessFixture();
    const runtime = new HeadlessRuntime(f.stateDir, f.env);
    let ref: SessionRef | undefined;
    try {
      const { lane, startup } = await launchLane(f.deps, f.input);
      ref = lane.sessionRef;
      const session = lane.session;
      expect(startup).toStartWith("STARTUP_OK");
      if (!ref || !session) throw new Error("native fixture did not supply a lane identity");
      const { target } = await startTestEndpoint(f.stateDir, cleanup, { session, pane: formatRef(ref) });
      const receipt = new RemoteRecords(f.stateDir).path("session", session);
      const request = { op: "close", session, generation: target.generation, force: true };
      await expect(remoteOperation(f.deps, request, false)).rejects.toThrow("use cataly close or cataly park");
      expect(await runtime.observe(ref)).toMatchObject({
        sessionId: session,
        status: "idle",
        goal: { status: "active" },
      });
      expect(await f.deps.registry.read(lane.key)).toEqual(lane);
      expect(existsSync(receipt)).toBe(false);

      // A failed membership read must not be treated as an empty registry.
      writeFileSync(f.deps.registry.path("fixture-unreadable"), "{");
      await expect(remoteOperation(f.deps, request, false)).rejects.toThrow("lane ownership is unconfirmed");
      expect(await runtime.observe(ref)).toMatchObject({ sessionId: session, status: "idle" });
      expect(existsSync(receipt)).toBe(false);
    } finally {
      if (ref) await runtime.close(ref);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each(["addressed", "pane-less"] as const)(
  "standalone close fences terminal adoption while its %s fixture is deciding",
  async (addressing) => {
    const f = headlessFixture();
    cleanup.push(() => rmSync(f.home, { force: true, recursive: true }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { target } = await startTestEndpoint(f.stateDir, cleanup, {
      ...(addressing === "addressed" ? { pane: "t7" } : {}),
      beforeClose: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const request = { op: "close", session: target.session, generation: target.generation };
    const adopted = { ...f.input, pane: "hc:t7" };
    const finished = remoteOperation(f.deps, request, false).catch((error: unknown) => error);
    try {
      expect(await Promise.race([entered.promise.then(() => true), finished.then(() => false)])).toBe(true);
      await expect(adoptLane(f.deps, adopted)).rejects.toThrow("terminal adoption held");
      expect(await f.deps.registry.read(adopted.key)).toBeNull();
      if (addressing === "addressed")
        expect(await adoptLane(f.deps, { ...adopted, key: "other-lane", pane: "hc:t8" })).toMatchObject({
          sessionRef: { runtime: "hc", id: "t8" },
        });
    } finally {
      release.resolve();
      await finished;
    }
    expect(await finished).toMatchObject({ message: "close held by approval" });
    expect(await adoptLane(f.deps, adopted)).toMatchObject({ sessionRef: { runtime: "hc", id: "t7" } });
    await expect(remoteOperation(f.deps, request, false)).rejects.toThrow("use cataly close or cataly park");
  },
);

test.skipIf(process.platform === "win32")(
  "live discovery rejects unsafe sockets and selection rejects ambiguous IDs",
  async () => {
    const { state } = sandbox();
    const { target } = await startTestEndpoint(state, cleanup, { legacyLead: true });
    expect(await liveSessions(state)).toEqual([{ ...target, role: "cataly" }]);
    expect(() => selectSession([target, { ...target, session: "native-002" }], "native")).toThrow("Ambiguous");
    chmodSync(remoteSocketPath(state, target.session), 0o666);
    expect(await liveSessions(state)).toEqual([]);
  },
);

test("remote request transport keeps text out of process arguments", async () => {
  const argv = peer("lab-peer", "/separate home/bin/cataly");
  expect(argv).toEqual([
    "hc",
    "exec",
    "--on",
    "lab-peer",
    "--timeout",
    "55",
    "--stdin",
    "--",
    "/separate home/bin/cataly",
    "remote",
    "accept",
  ]);
  expect(() => peer("-invalid", "cataly")).toThrow("Invalid");
  await expect(
    throughPeer([process.execPath, "-e", "console.log(JSON.stringify({ok:true,data:await Bun.stdin.json()}))"], {
      op: "send",
      text: "source\nline",
      id: "request-1",
    }),
  ).resolves.toEqual({ op: "send", text: "source\nline", id: "request-1" });
});

test.skipIf(process.platform === "win32")("untrusted policy mode never silently enables access", () => {
  const { state } = sandbox();
  mkdirSync(state, { recursive: true });
  const path = join(state, "remote-policy.json");
  writeFileSync(path, '{"control":true,"wake":true}', { mode: 0o600 });
  chmodSync(path, 0o644);
  expect(statSync(path).mode & 0o777).toBe(0o644);
  expect(() => remotePolicy(state)).toThrow("owner-only");
});
