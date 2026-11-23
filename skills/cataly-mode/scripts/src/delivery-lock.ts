import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatRef, parseRef, type SessionRef } from "../../../../src/runtime/types.ts";
import { takeLock } from "./checkpoint-lock.ts";
import type { FlowDeps } from "./done-flow.ts";

/** How long a tell or a pause waits for the other before giving up. A pause holds the lock for seconds. */
export const DELIVERY_WAIT_MS = 30_000;
const RETRY_MS = 50;

export type Held<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly holder: string };

/**
 * Runs `fn` under the lane's delivery lock, `<stateDir>/lanes/<key>.deliver.lock`. `cataly tell` holds it across its
 * registry re-read and its send; `cataly pause` holds it from its goal command through its registry change and Escape.
 * So a tell either lands before a pause, whose Escape then stops the turn it started, or reads the lane paused and
 * sends nothing. Registry writes never hold their own lock across pane round trips; this lock exists for exactly
 * those. A holder that died is taken over; a live one on this host keeps it however long its I/O takes (the 30-second
 * limit is for the waiter, not the holder). Gives up after `waitMs`, naming the holder.
 */
const withLaneLock = async <T>(
  deps: Pick<FlowDeps, "registry" | "clock">,
  key: string,
  fn: () => Promise<T>,
  waitMs: number,
  scope: "deliver" | "launch",
): Promise<Held<T>> => {
  mkdirSync(deps.registry.dir, { recursive: true });
  const lock = join(deps.registry.dir, `${key}.${scope}.lock`);
  const fail = (m: string) => new Error(`lane ${scope === "deliver" ? "delivery" : "launch"} lock of ${key} ${m}`);
  const deadline = deps.clock.now() + waitMs;
  for (;;) {
    // A slow tell or pause may hold it past takeLock's two-minute age limit: a live holder is never taken over.
    const held = takeLock(lock, deps.clock.now(), fail, { keepLiveOwner: true });
    if (typeof held !== "string") {
      try {
        return { ok: true, value: await fn() };
      } finally {
        held();
      }
    }
    if (deps.clock.now() >= deadline) return { ok: false, holder: held };
    await deps.clock.sleep(RETRY_MS);
  }
};

export const withDeliveryLock = <T>(
  deps: Pick<FlowDeps, "registry" | "clock">,
  key: string,
  fn: () => Promise<T>,
  waitMs = DELIVERY_WAIT_MS,
): Promise<Held<T>> => withLaneLock(deps, key, fn, waitMs, "deliver");

/** Starting or queueing a lane must never hold off pause/tell while startup confirmation waits. */
export const withLaunchLock = <T>(
  deps: Pick<FlowDeps, "registry" | "clock">,
  key: string,
  fn: () => Promise<T>,
  waitMs = DELIVERY_WAIT_MS,
): Promise<Held<T>> => withLaneLock(deps, key, fn, waitMs, "launch");

/** Native endpoint metadata uses a bare hc address; adoption also accepts the prefixed address. */
export const parseOwnershipRef = (pane: string): SessionRef | undefined =>
  parseRef(pane) ?? (/^t[0-9a-z]+$/.test(pane) ? { runtime: "hc", id: pane } : undefined);

/** A pane-less native endpoint needs the same fence as every adoption, since its physical address is unknown. */
export const withTerminalOwnershipLock = <T>(
  deps: Pick<FlowDeps, "registry" | "clock">,
  ref: SessionRef | undefined,
  fn: () => Promise<T>,
): Promise<Held<T>> => {
  const key = ref ? `@terminal-${createHash("sha256").update(formatRef(ref)).digest("hex")}` : "@terminal-adoption";
  return withLaunchLock(deps, key, fn, 0);
};

/** Called inside the per-key launch lock. Never wait on a standalone close while holding it. */
export const withTerminalAdoptionLock = async <T>(
  deps: Pick<FlowDeps, "registry" | "clock">,
  ref: SessionRef | undefined,
  fn: () => Promise<T>,
): Promise<Held<T>> => {
  const fence = await withTerminalOwnershipLock(deps, undefined, async (): Promise<Held<T>> =>
    ref ? withTerminalOwnershipLock(deps, ref, fn) : { ok: true, value: await fn() },
  );
  return fence.ok ? fence.value : fence;
};
