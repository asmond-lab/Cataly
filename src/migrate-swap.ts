import { harnessLaunchEnv, type Deps } from "./harness.ts";
import { CONTROLLER_POLL_MS, controllerLock, standby, type ControllerRole } from "./loop-controller.ts";
import { liveLoopLock } from "./loop-lock.ts";
import { POLL_MS, type MigrateOpts, type Subject } from "./migrate-capture.ts";
import { drainForward, moveBack, moveInbox } from "./migrate-inbox.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { formatRef, openSession, type Probe, type SessionRef, type TerminalRuntime } from "./runtime/types.ts";
import { type MigrateJournal, removeJournal, writeJournal } from "./store-journal.ts";

export const VERIFY_MS = 3 * 60_000;

/** The group new sessions join on the target: this home's group label on hc, a new "cataly" workspace on herdr, the
 * caller's own session (else one named "cataly") on tern. */
const targetGroup = async (d: Deps, rt: TerminalRuntime, cwd: string): Promise<string> =>
  rt.kind === "hc" ? groupId(d.store.root) : rt.createGroup("cataly", cwd);

/** Step (4): opens the replacement on the target; the journal records it before anything else moves. */
async function open(d: Deps, s: Subject, j: MigrateJournal, command: string): Promise<MigrateJournal> {
  const rt = d.runtimes.terminal(j.to);
  const newRef = await openSession(rt, s.spec(await targetGroup(d, rt, s.cwd)), command);
  const next: MigrateJournal = { ...j, phase: "opened", newRef };
  writeJournal(d.store.root, next);
  return next;
}

/** Step (5): the new session's probe reaches idle or working within VERIFY_MS, polled every POLL_MS. */
async function verify(d: Deps, ref: SessionRef, opts: MigrateOpts): Promise<string | undefined> {
  const rt = d.runtimes.for(ref);
  const deadline = d.now() + VERIFY_MS;
  for (;;) {
    const { status } = await rt.probe(ref);
    if (status === "idle" || status === "working") return undefined;
    if (d.now() >= deadline) return `never reached idle or working within 3 min (last: ${status})`;
    await opts.sleep(POLL_MS);
  }
}

async function closeQuietly(d: Deps, ref: SessionRef): Promise<void> {
  const rt = d.runtimes.for(ref);
  if ((await rt.probe(ref).catch(() => undefined))?.status === "gone") return;
  await rt.close(ref);
}

/**
 * Steps (4)-(8) for an agent session, resuming at the journal's phase: open, verify (rollback on failure: close the
 * new one, put the inbox back, clear the hold, exit 3), move the inbox, switch the record, close the old one.
 */
export async function swapAgent(d: Deps, s: Subject, j: MigrateJournal, command: string, opts: MigrateOpts) {
  if (j.phase === "hold") j = await open(d, s, j, command);
  const newRef = j.newRef as SessionRef;
  if (j.phase === "opened") {
    const why = await verify(d, newRef, opts);
    if (why !== undefined) {
      await closeQuietly(d, newRef).catch(() => undefined);
      await moveBack(d, j.from, newRef, opts);
      removeJournal(d.store.root, s.name);
      s.setHold(false);
      opts.log(`MIGRATE_ROLLBACK ${s.name} ${formatRef(newRef)} ${why}`);
      return 3;
    }
    await moveInbox(d, j.from, newRef, opts);
    s.switchTo(newRef);
    j = { ...j, phase: "switched" };
    writeJournal(d.store.root, j);
  }
  await closeQuietly(d, j.from);
  await drainForward(d, j.from, newRef, opts);
  removeJournal(d.store.root, s.name);
  s.setHold(false);
  opts.log(`MIGRATED ${s.name} ${refText(j.from)} -> ${formatRef(newRef)}`);
  return 0;
}

function runsIn(probe: Probe, pid: number): boolean {
  return probe.status !== "gone" && (probe.rootPid === pid || !!probe.foreground?.some((p) => p.pid === pid));
}

async function waitFor<T>(d: Deps, opts: MigrateOpts, observe: () => T | undefined): Promise<T | undefined> {
  const deadline = d.now() + VERIFY_MS;
  for (;;) {
    const value = observe();
    if (value !== undefined || d.now() >= deadline) return value;
    await opts.sleep(CONTROLLER_POLL_MS);
  }
}

/** Stage a process that cannot run a pass yet; only the holder of the actual lifetime lock can commit the move. */
export async function swapLoop(d: Deps, role: ControllerRole, initial: MigrateJournal, cwd: string, opts: MigrateOpts) {
  let j = initial;
  const lock = controllerLock(d, role);
  const owner = () => liveLoopLock(lock);
  const source = d.runtimes.terminal(j.from.runtime);
  const target = d.runtimes.terminal(j.to);
  const save = (next: MigrateJournal) => {
    writeJournal(d.store.root, next);
    j = next;
  };
  const registration = () => {
    const current = d.store.roles()[role];
    if (!current || ![j.from, j.newRef, j.controller?.publishedRef].some((ref) => ref && sameSession(current, ref)))
      throw new Refusal(`${role} registration changed during migration; left it unchanged`);
    return current;
  };
  const matchesSource = (seen: Probe, held: NonNullable<ReturnType<typeof owner>>): boolean =>
    seen.status !== "gone" && (held.ref ? sameSession(held.ref, j.from) : runsIn(seen, held.pid));
  const sourceOwner = async () => {
    const seen = await source.probe(j.from, { foregroundOnly: true });
    const held = owner();
    if (seen.status === "gone" && !held) return undefined;
    if (held && matchesSource(seen, held)) return held;
    throw new Refusal(
      `cannot verify ${role} in ${refText(j.from)}; no terminal was closed. Check the original server and stop any old controller yourself before retrying.`,
    );
  };
  const restoreSource = async (): Promise<boolean> => {
    if (sameSession(registration(), j.from) && !j.controller?.retirementStarted) return true;
    const seen = await source.probe(j.from, { foregroundOnly: true });
    const held = owner();
    const sourcePid = j.controller?.sourcePid;
    if (!held || (sourcePid !== undefined && held.pid !== sourcePid) || !matchesSource(seen, held)) return false;
    if (!sameSession(registration(), j.from)) d.store.setRole(role, j.from);
    return true;
  };
  registration();
  if (j.phase === "cleanup" || (!j.controller && j.newRef)) {
    // A terminal without a proven holder is not ours to close. Keep it on the journal until retired externally.
    await restoreSource();
    if (j.newRef && (await target.probe(j.newRef)).status !== "gone")
      throw new Refusal(`unverified earlier ${role} replacement ${refText(j.newRef)}; retire it before retrying`);
    const current = registration();
    const retirementStarted = j.controller?.retirementStarted;
    const publishedRef = sameSession(current, j.from) ? undefined : current;
    save({
      name: j.name,
      kind: j.kind,
      phase: "hold",
      from: j.from,
      to: j.to,
      at: j.at,
      controller: {
        ...(retirementStarted && { retirementStarted }),
        ...(publishedRef && { publishedRef }),
      },
    });
  }
  if (j.phase === "hold") {
    await sourceOwner();
    const token = crypto.randomUUID();
    const group = await targetGroup(d, target, cwd);
    const env = {
      ...harnessLaunchEnv(d),
      CATALY_RUNTIME: target.kind,
      ...(target.kind === "herdr" ? { HERDR_WORKSPACE_ID: group } : {}),
    };
    const newRef = await target.create({ name: role, role, container: "tab", cwd, env, group });
    const command = role === "duty-loop" ? `${d.catalyCmd} duty --interval 60` : `${d.catalyCmd} loop`;
    // Persist the reservation before dispatch and never replay an ambiguous send. A crash during creation or
    // before dispatch can leave an empty shell, never a second controller.
    save({ ...j, phase: "starting", newRef, controller: { ...j.controller, token } });
    await target.start(newRef, `${command} --controller-handoff ${token}`);
  }
  const { newRef } = j;
  const token = j.controller?.token;
  if (!newRef || !token) throw new Refusal(`incomplete ${role} migration journal`);
  const rollback = async (why: string) => {
    save({ ...j, phase: "cleanup" }); // Fences delayed launches without dropping the terminal address.
    const sourceRestored = await restoreSource();
    const detail = sourceRestored ? "" : "; no live source confirmed, registration unchanged";
    opts.log(
      `MIGRATE_ROLLBACK ${role} ${why}${detail}; inspect ${refText(newRef)} and retire it in its original server before retrying --to ${j.to}`,
    );
    return 3;
  };
  if (j.phase === "starting") {
    if (!(await waitFor(d, opts, () => standby(d, role, j)))) return rollback("replacement did not reach standby");
    const old = await sourceOwner();
    registration();
    if (old && !old.ref) {
      // Older controllers cannot yield between passes. The live lock PID was tied to this terminal by its probe.
      save({ ...j, controller: { ...j.controller, retirementStarted: true, sourcePid: old.pid } });
      await source.close(j.from);
    }
    save({
      ...j,
      phase: "activating",
      controller: { ...j.controller, ...(old ? { sourcePid: old.pid } : {}) },
    });
  }
  const replacement = () => {
    const ready = standby(d, role, j);
    const held = owner();
    return ready && held?.ref && held.pid === ready.pid && held.handoff === token && sameSession(held.ref, newRef)
      ? held
      : undefined;
  };
  if (!standby(d, role, j) || !(await waitFor(d, opts, replacement)))
    return rollback("replacement did not acquire the controller lock");
  if ((await target.probe(newRef)).status === "gone" || !replacement())
    return rollback("replacement exited before registration");
  registration();
  d.store.setRole(role, newRef);
  if (j.phase !== "switched") save({ ...j, phase: "switched" });
  const sourcePid = j.controller?.sourcePid;
  if (
    !j.controller?.retirementStarted &&
    sourcePid !== undefined &&
    runsIn(await source.probe(j.from, { foregroundOnly: true }), sourcePid)
  ) {
    if (!replacement()) return rollback("replacement exited before source retirement");
    registration();
    save({ ...j, controller: { ...j.controller, retirementStarted: true } });
    await source.close(j.from);
  }
  if (!replacement()) return rollback("replacement exited before migration completed");
  registration();
  removeJournal(d.store.root, role);
  opts.log(`MIGRATED ${role} ${refText(j.from)} -> ${formatRef(newRef)}`);
  return 0;
}
