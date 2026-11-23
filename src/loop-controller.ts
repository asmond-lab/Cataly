import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { acquire, liveLoopLock, release } from "./loop-lock.ts";
import { Refusal } from "./refusal.ts";
import { sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import { readJournal, type MigrateJournal } from "./store-journal.ts";

export type ControllerRole = "duty-loop" | "hourly-loop";
export type LoopLifecycle = { readonly signal: AbortSignal; readonly ready: () => void };

export const CONTROLLER_POLL_MS = 250;
const handoffPath = (d: Deps, role: ControllerRole, token: string): string =>
  join(d.store.root, "migrate", `${role}.${token}.standby`);

export const controllerLock = (d: Deps, role: ControllerRole): string =>
  role === "duty-loop" ? d.store.lockPath("duty") : d.store.loopPath("runner.lock");

export function standby(d: Deps, role: ControllerRole, j: MigrateJournal) {
  const token = j.controller?.token;
  if (!token || !/^[a-f0-9-]{36}$/.test(token) || !j.newRef) return undefined;
  const ready = liveLoopLock(handoffPath(d, role, token));
  return ready?.ref && ready.handoff === token && sameSession(ready.ref, j.newRef) ? ready : undefined;
}

function activating(j: MigrateJournal): boolean {
  return j.phase === "activating" || j.phase === "switched";
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return Bun.sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

type ControllerOptions = {
  readonly role: ControllerRole;
  readonly once: boolean;
  readonly token: string | undefined;
  readonly lifecycle: LoopLifecycle | undefined;
};

/**
 * A terminal candidate first holds a standby lock, without running passes. The registered source only yields its
 * lifetime lock between passes, and stays available to reacquire it until the migration commits. Native controllers
 * use the same lifetime lock and readiness callback, with no terminal handoff state.
 */
export function controllerLease(d: Deps, { role, once, token, lifecycle }: ControllerOptions) {
  const path = controllerLock(d, role);
  const signal = lifecycle?.signal;
  const runtime = process.env["CATALY_RUNTIME"];
  const ref =
    !lifecycle && !once && (runtime === "hc" || runtime === "herdr") ? d.runtimes.terminal(runtime).self() : undefined;
  const read = () => readJournal(d.store.root, role);
  const registered = (self: SessionRef): boolean => {
    const current = d.store.roles()[role];
    return current !== undefined && sameSession(current, self);
  };
  let candidate: { readonly path: string; readonly nonce: string } | undefined;
  if (token !== undefined) {
    const j = read();
    if (
      !ref ||
      !/^[a-f0-9-]{36}$/.test(token) ||
      j?.controller?.token !== token ||
      j.phase === "cleanup" ||
      !j.newRef ||
      !sameSession(j.newRef, ref) ||
      j.to !== ref.runtime
    ) {
      throw new Refusal(`${role} has no matching terminal migration`);
    }
    const readyPath = handoffPath(d, role, token);
    const ready = acquire(d, readyPath, { ref, handoff: token });
    if ("holder" in ready) throw new Refusal(`${role} replacement already on standby (${ready.holder})`);
    candidate = { path: readyPath, nonce: ready.nonce };
  }

  let held: string | undefined;
  let parked = false;
  const dropStandby = () => {
    if (candidate) release(d, candidate.nonce, candidate.path);
    candidate = undefined;
  };
  const dropLease = () => {
    if (held) release(d, held, path);
    held = undefined;
  };
  const shouldYield = (j: MigrateJournal | undefined): boolean =>
    !!ref && !!j && sameSession(ref, j.from) && activating(j) && !!standby(d, role, j);

  return {
    async beforePass(): Promise<boolean> {
      while (!signal?.aborted) {
        if (once && role === "hourly-loop") return true;
        const j = lifecycle ? undefined : read();
        if (candidate) {
          if (j?.controller?.token !== token) {
            if (!held || !ref || !registered(ref)) return false;
            dropStandby(); // This process already won the lease and was committed as the current role.
          } else if (j?.phase === "cleanup") {
            return false;
          } else if (!j || !activating(j)) {
            await wait(CONTROLLER_POLL_MS, signal);
            continue;
          }
        }
        if (shouldYield(j)) {
          dropLease();
          parked = true;
          await wait(CONTROLLER_POLL_MS, signal);
          continue;
        }
        // The journal is removed after commit. Until then a parked source can recover if the candidate dies.
        if (parked && !j && ref && !registered(ref)) return false;
        if (!held) {
          // Do not jump the queue with a manual persistent invocation while a replacement is being activated.
          const reserved = !candidate && !parked && j && activating(j) && standby(d, role, j);
          if (reserved) throw new Refusal(`${role} is reserved for terminal migration`);
          const claim = acquire(d, path, ref ? { ref, ...(token === undefined ? {} : { handoff: token }) } : undefined);
          if ("holder" in claim) {
            if (!candidate && !parked)
              throw new Refusal(
                `another ${role === "duty-loop" ? "duty" : "hourly"} loop runs in this home (${claim.holder})`,
              );
            await wait(CONTROLLER_POLL_MS, signal);
            continue;
          }
          held = claim.nonce;
          parked = false;
          lifecycle?.ready();
        }
        return true;
      }
      return false;
    },
    async waitForPass(ms: number): Promise<void> {
      if (!ref) return wait(ms, signal);
      const until = Date.now() + ms;
      for (let remaining = ms; remaining > 0; remaining = until - Date.now()) {
        const j = read();
        if (shouldYield(j)) return;
        if (candidate && j?.controller?.token === token && j?.phase === "cleanup") return;
        if (candidate && j?.controller?.token !== token) {
          if (!held || !registered(ref)) return;
          dropStandby();
        }
        await wait(Math.min(remaining, CONTROLLER_POLL_MS), signal);
      }
    },
    close(): void {
      try {
        dropLease();
      } finally {
        dropStandby();
      }
    },
  };
}
