import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HeadlessObservation, NativeLoopRole } from "./headless-protocol.ts";
import * as host from "./headless-record.ts";
import type { SessionRef, SessionRole } from "./types.ts";

type Resume = { readonly file: string; readonly sessionId: string };
type Env = Record<string, string | undefined>;
const WAIT_FOR_HOST = 65_000;

const liveAgent = (seen: HeadlessObservation, role: SessionRole): boolean =>
  seen.status !== "gone" &&
  seen.status !== "unknown" &&
  seen.status !== "error" &&
  seen.role === (role === "lane" ? "lane" : "cataly") &&
  (role === "lane" || seen.harnessRole === role) &&
  !!seen.sessionId &&
  !!seen.sessionFile;

const liveLoop = (seen: HeadlessObservation, role: NativeLoopRole): boolean =>
  seen.harnessRole === role && seen.role === undefined && seen.status === "working" && seen.pid !== undefined;

async function spawnHost(dir: string, start: host.HostStart) {
  const { env } = start;
  const log = start.argv.length === 0 ? openSync(join(dir, "loop.log"), "wx", 0o600) : undefined;
  const child = (() => {
    try {
      return spawn(process.execPath, [join(import.meta.dir, "headless-broker.ts"), dir], {
        detached: true,
        stdio: ["pipe", log ?? "ignore", log ?? "ignore"],
        // Secrets are streamed to the child, not persisted or inserted into argv.
        env: { PATH: env["PATH"], HOME: env["HOME"], TMPDIR: env["TMPDIR"] },
      });
    } finally {
      if (log !== undefined) closeSync(log);
    }
  })();
  const channel = child.stdin;
  if (!channel) throw new host.HeadlessError("headless supervisor input pipe unavailable");
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    channel.once("error", fail);
    channel.end(JSON.stringify(start), done);
  }).catch((error: unknown) => {
    throw new host.HeadlessError(`headless supervisor start unconfirmed (${String(error)})`);
  });
  child.unref();
  return child;
}

export async function startHost(
  stateDir: string,
  ref: SessionRef,
  argv: readonly string[],
  env: Env,
  resume?: Resume,
): Promise<HeadlessObservation> {
  const entry = host.laneEntry(stateDir, ref);
  if (!entry) throw new host.HeadlessError("headless reservation missing");
  const { dir, reservation } = entry;
  const role = reservation.role ?? "lane";
  const isLoop = role === "duty-loop" || role === "hourly-loop";
  if (isLoop !== (argv.length === 0) || (resume && role !== "lane"))
    throw new host.HeadlessError("native start role mismatch");
  if (existsSync(join(dir, "stopped.json"))) throw new host.HeadlessError("headless reservation has stopped");
  // A competing start/close gets the same exclusive file. Never retry a spawn after ambiguity.
  writeFileSync(join(dir, "started"), "", { flag: "wx", mode: 0o600 });
  for (const key of [
    "HC_TERMINAL_ID",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "CATALY_HEADLESS_ID",
    "CATALY_ASK_LAUNCHED_LANE",
    "CATALY_HARNESS_ROLE",
  ])
    delete env[key];
  if (role === "lead" || role === "duty") env["CATALY_HARNESS_ROLE"] = role;
  const child = await spawnHost(dir, {
    argv: resume ? [...argv, `--resume=${resume.file}`] : argv,
    env,
    ...(resume ? { expectedResumeId: resume.sessionId } : {}),
  });
  const deadline = Date.now() + WAIT_FOR_HOST;
  do {
    const seen = await host.observeHost(stateDir, ref);
    if (isLoop ? liveLoop(seen, role) : liveAgent(seen, role)) return seen;
    if (seen.status === "gone" || child.exitCode !== null || child.signalCode !== null)
      throw new host.HeadlessError(seen.detail ?? `headless ${role} process exited before proving startup`);
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new host.HeadlessError(`headless ${role} process did not prove startup before the deadline`);
}

export async function stopHarnessRole(
  stateDir: string,
  ref: SessionRef,
  role: Exclude<SessionRole, "lane">,
  sessionId?: string,
): Promise<void> {
  const entry = host.laneEntry(stateDir, ref);
  if (!entry || entry.reservation.role !== role) throw new host.HeadlessError("native harness reservation mismatch");
  const stopped = () => host.readPrivate<host.StopReceipt>(join(entry.dir, "stopped.json")) !== undefined;
  if (stopped()) return;
  if (!existsSync(join(entry.dir, "started"))) {
    await closeHost(stateDir, ref);
    return;
  }
  const seen = await host.observeHost(stateDir, ref);
  if (stopped()) return;
  if (role === "duty-loop" || role === "hourly-loop") {
    // After a stop was admitted the broker may still be draining the same pass.
    if (seen.harnessRole !== role || seen.pid === undefined)
      throw new host.HeadlessError("plain loop identity is unconfirmed; no process was signaled");
    await host.requestHost(stateDir, ref, { op: "stop-loop" }).catch((error: unknown) => {
      if (!(error instanceof host.HostTransportError) || !stopped()) throw error;
    });
  } else {
    if (!liveAgent(seen, role) || (sessionId && seen.sessionId !== sessionId))
      throw new host.HeadlessError("native role session identity is unconfirmed or changed");
    if (seen.held || seen.status !== "idle")
      throw new host.HeadlessError("native role is busy or awaiting an answer; no approval was touched");
    await closeHost(stateDir, ref, seen.sessionId);
  }
  const deadline = Date.now() + 5_000;
  while (!stopped() && Date.now() < deadline) await Bun.sleep(20);
  if (!stopped()) throw new host.HeadlessError("native role exit was not confirmed");
}

export async function closeHost(stateDir: string, ref: SessionRef, expectedSessionId?: string): Promise<void> {
  const entry = host.laneEntry(stateDir, ref);
  if (!entry || host.readPrivate<host.StopReceipt>(join(entry.dir, "stopped.json"))) return;
  if (!existsSync(join(entry.dir, "started"))) {
    // Competing start either already owns this record or will see that close reserved it.
    writeFileSync(join(entry.dir, "started"), "", { flag: "wx", mode: 0o600 });
    host.writePrivate(join(entry.dir, "stopped.json"), {});
    return;
  }
  const observed = await host.observeHost(stateDir, ref);
  if (observed.status === "gone") return;
  const bound = expectedSessionId ?? observed.sessionId;
  if (!bound) throw new host.HeadlessError("headless close has no confirmed native session identity");
  await host.requestHost(stateDir, ref, { op: "close", expectedSessionId: bound }).catch((error: unknown) => {
    if (
      !(error instanceof host.HostTransportError) ||
      host.readPrivate<host.StopReceipt>(join(entry.dir, "stopped.json"))?.closedSessionId !== bound
    )
      throw error;
  });
  if ((await host.observeHost(stateDir, ref)).status !== "gone")
    throw new host.HeadlessError("headless close not confirmed");
}
