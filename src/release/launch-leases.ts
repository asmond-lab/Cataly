import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { object } from "../update/config.ts";
import { processIdentity } from "../update/deployment-process.ts";
import { processExists } from "../update/proc.ts";
import {
  acquireConsumerLock,
  ConsumerLockBusy,
  type ConsumerPaths,
  consumerPaths,
  owned,
  pointer,
  readJson,
  realDirectory,
  regularFile,
  saveJson,
} from "./files.ts";
import { consumerReleaseHome } from "./runtime.ts";

type LaunchLease = { readonly version: 1; readonly pid: number; readonly startTicks: string; readonly bootId: string };

/** A short gate covers lease registration and only the final pointer transaction, never downloads or preparation. */
export const acquireLaunchGate = (paths: ConsumerPaths): (() => void) =>
  acquireConsumerLock(paths, "consumer-launch.lock");

const nativeStateReceipt = (stateDir: string): string => `${createHash("sha256").update(stateDir).digest("hex")}.json`;

/** Native reservations, including those in process-selected state directories, fence consumer activation. */
export function guardConsumerReservation(sourceRoot: string, stateDir: string): () => void {
  const source = realpathSync(sourceRoot);
  const cataly = consumerReleaseHome(source);
  if (!cataly) return () => {};
  const paths = consumerPaths(homedir(), cataly);
  const unlock = acquireLaunchGate(paths);
  try {
    if (regularFile(paths.journal) || pointer(paths.live) !== source)
      throw new Error("Consumer release changed before native reservation; invoke the installed CLI again");
    realDirectory(stateDir);
    const directory = join(paths.root, "consumer-native-states");
    realDirectory(directory, true);
    owned(directory);
    const name = nativeStateReceipt(stateDir);
    const receipt = join(directory, name);
    if (!regularFile(receipt)) saveJson(receipt, { version: 1, stateDir });
    else if (readNativeState(directory, name) !== stateDir) throw new Error("Native state directory receipt differs");
    return unlock;
  } catch (error) {
    unlock();
    throw error;
  }
}

function readNativeState(directory: string, name: string): string {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unexpected consumer native state receipt");
  const receipt = readJson(join(directory, name));
  if (
    !object(receipt) ||
    Object.keys(receipt).sort().join() !== "stateDir,version" ||
    receipt["version"] !== 1 ||
    typeof receipt["stateDir"] !== "string" ||
    !isAbsolute(receipt["stateDir"]) ||
    resolve(receipt["stateDir"]) !== receipt["stateDir"] ||
    nativeStateReceipt(receipt["stateDir"]) !== name
  )
    throw new Error("Invalid consumer native state receipt");
  return receipt["stateDir"];
}

export function registeredNativeStates(paths: ConsumerPaths): readonly string[] {
  const directory = join(paths.root, "consumer-native-states");
  realDirectory(directory);
  if (!existsSync(directory)) return [];
  owned(directory);
  return readdirSync(directory).map((name) => readNativeState(directory, name));
}

export async function waitLaunchGate(paths: ConsumerPaths): Promise<() => void> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      return acquireLaunchGate(paths);
    } catch (error) {
      if (!(error instanceof ConsumerLockBusy) || performance.now() >= deadline) throw error;
      await Bun.sleep(25);
    }
  }
}

/** Call under the launch gate. Start identity survives shell->native exec; executable identity intentionally does not. */
export function registerConsumerLaunch(paths: ConsumerPaths, pid: number): void {
  const identity = processIdentity(pid);
  if (!identity) throw new Error("Consumer launcher process identity is unavailable");
  const lease: LaunchLease = { version: 1, pid, startTicks: identity.startTicks, bootId: identity.bootId };
  const directory = join(paths.root, "consumer-launches");
  realDirectory(directory, true);
  owned(directory);
  const key = createHash("sha256").update(JSON.stringify(lease)).digest("hex");
  const path = join(directory, `${pid}-${key}.json`);
  if (regularFile(path)) {
    if (JSON.stringify(readJson(path)) !== JSON.stringify(lease)) throw new Error("Consumer launch receipt changed");
  } else saveJson(path, lease);
}

/** Called under the launch gate; stale receipts are owned, identity-addressed and never reused. */
export function assertNoConsumerLaunches(paths: ConsumerPaths, owner?: number): void {
  const directory = join(paths.root, "consumer-launches");
  realDirectory(directory);
  if (!existsSync(directory)) return;
  owned(directory);
  for (const name of readdirSync(directory)) {
    if (!/^\d+-[a-f0-9]{64}\.json$/.test(name)) throw new Error("Unexpected consumer launch receipt");
    const path = join(directory, name);
    const lease = readJson(path) as LaunchLease;
    if (
      !lease ||
      Object.keys(lease).sort().join() !== "bootId,pid,startTicks,version" ||
      lease.version !== 1 ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      typeof lease.startTicks !== "string" ||
      !/^\d+$/.test(lease.startTicks) ||
      typeof lease.bootId !== "string" ||
      !lease.bootId ||
      name !== `${lease.pid}-${createHash("sha256").update(JSON.stringify(lease)).digest("hex")}.json`
    )
      throw new Error("Invalid consumer launch receipt");
    const observed = processIdentity(lease.pid);
    if (!observed && processExists(lease.pid)) throw new Error("Uncertain consumer launcher identity holds activation");
    if (observed?.startTicks === lease.startTicks && observed.bootId === lease.bootId) {
      if (lease.pid !== owner) throw new Error(`Live consumer launch PID ${lease.pid} holds release activation`);
    } else unlinkSync(path);
  }
}
