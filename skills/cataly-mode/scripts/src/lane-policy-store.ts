import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HEADLESS_ADDRESS } from "../../../../src/runtime/types.ts";
import { checkLanePolicy, type LanePolicy, PolicyError, policyPatterns } from "./lane-policy.ts";
import { type Lane, LANE_KEY } from "./registry.ts";
import { isRequestId, isRunId, type ReportProvenance } from "./request-identity.ts";

export type PolicySnapshot = {
  readonly version: 1;
  readonly id: string;
  readonly key: string;
  readonly denyBash: readonly string[];
  readonly allowBash: readonly string[];
  readonly generation?: string;
  readonly provenance?: Pick<ReportProvenance, "requestId" | "runId">;
};
export type BoundPolicy = {
  readonly file: string;
  readonly stateDir: string;
  readonly snapshot: PolicySnapshot;
  readonly rootRef?: string;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export const prepareLanePolicy = (
  stateDir: string,
  key: string,
  policy: LanePolicy | undefined,
  rootRef?: string,
): BoundPolicy | undefined => {
  if (policy === undefined) return undefined;
  checkLanePolicy(policy);
  if (!LANE_KEY.test(key)) throw new PolicyError("invalid lane policy key");
  if (rootRef !== undefined && !HEADLESS_ADDRESS.test(rootRef)) throw new PolicyError("invalid root lane policy ref");
  const allowBash = Object.entries(policy.perLane ?? {}).flatMap(([glob, entry]) =>
    new RegExp(
      `^${glob
        .split("*")
        .map((p) => p.replaceAll(".", "\\."))
        .join(".*")}$`,
    ).test(key)
      ? entry.allowBash
      : [],
  );
  return {
    file:
      rootRef === undefined
        ? join(resolve(stateDir), "lanes", key, "policy.json")
        : join(resolve(stateDir), "headless", rootRef, "policy.json"),
    stateDir: resolve(stateDir),
    ...(rootRef === undefined ? {} : { rootRef }),
    snapshot: { version: 1, id: randomUUID(), key, denyBash: [...policy.denyBash], allowBash },
  };
};
export const policyBinding = (policy: BoundPolicy): string =>
  JSON.stringify({ file: policy.file, id: policy.snapshot.id });

export const writeLanePolicy = (
  policy: BoundPolicy,
  lane?: Pick<Lane, "key" | "lifecycleEpoch" | "requestId" | "runId">,
): void => {
  const snapshot = {
    ...policy.snapshot,
    ...(lane?.lifecycleEpoch === undefined ? {} : { generation: lane.lifecycleEpoch }),
    ...(lane?.requestId === undefined ? {} : { provenance: { requestId: lane.requestId, runId: lane.runId } }),
  };
  if (lane && lane.key !== snapshot.key) throw new PolicyError("lane policy launch key mismatch");
  if (policy.rootRef !== undefined && snapshot.generation !== policy.rootRef)
    throw new PolicyError("root lane policy generation mismatch");
  if (snapshot.provenance && (!isRequestId(snapshot.provenance.requestId) || !isRunId(snapshot.provenance.runId)))
    throw new PolicyError("lane policy launch provenance invalid");
  mkdirSync(dirname(policy.file), { recursive: true, mode: 0o700 });
  const tmp = `${policy.file}.${policy.snapshot.id}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
  renameSync(tmp, policy.file);
};

export const readLanePolicy = (binding: string): BoundPolicy => {
  let value: { file?: unknown; id?: unknown } | null;
  try {
    value = JSON.parse(binding);
  } catch {
    throw new PolicyError("invalid lane policy binding");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.file !== "string" ||
    !isAbsolute(value.file) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id)
  )
    throw new PolicyError("invalid lane policy binding");
  const file = resolve(value.file);
  let snapshot: Partial<PolicySnapshot> | null;
  try {
    snapshot = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new PolicyError("bound lane policy snapshot is missing");
    if (error instanceof SyntaxError) throw new PolicyError("invalid lane policy snapshot JSON");
    throw error;
  }
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    snapshot.version !== 1 ||
    snapshot.id !== value.id ||
    typeof snapshot.key !== "string" ||
    !LANE_KEY.test(snapshot.key)
  )
    throw new PolicyError("lane policy snapshot identity mismatch");
  const stateDir = dirname(dirname(dirname(file)));
  const { generation, provenance } = snapshot;
  const rootRef =
    typeof generation === "string" &&
    HEADLESS_ADDRESS.test(generation) &&
    file === join(stateDir, "headless", generation, "policy.json")
      ? generation
      : undefined;
  if (rootRef === undefined && join(stateDir, "lanes", snapshot.key, "policy.json") !== file)
    throw new PolicyError("lane policy path mismatch");
  const denyBash = policyPatterns(snapshot.denyBash, "denyBash");
  const allowBash = policyPatterns(snapshot.allowBash, "allowBash");
  if (
    (generation !== undefined && typeof generation !== "string") ||
    (provenance !== undefined && (!provenance || !isRequestId(provenance.requestId) || !isRunId(provenance.runId)))
  )
    throw new PolicyError("invalid lane policy report scope");
  return {
    file,
    stateDir,
    ...(rootRef === undefined ? {} : { rootRef }),
    snapshot: {
      version: 1,
      id: value.id,
      key: snapshot.key,
      denyBash,
      allowBash,
      ...(generation === undefined ? {} : { generation }),
      ...(provenance === undefined ? {} : { provenance }),
    },
  };
};

export const currentLanePolicy = (stateDir: string, key: string): BoundPolicy => {
  if (!LANE_KEY.test(key)) throw new PolicyError("invalid lane policy key");
  const file = join(resolve(stateDir), "lanes", key, "policy.json");
  let value: { id?: unknown } | null;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PolicyError(`lane ${key} has no policy snapshot`);
    if (error instanceof SyntaxError) throw new PolicyError("invalid lane policy snapshot JSON");
    throw error;
  }
  if (typeof value !== "object" || value === null || typeof value.id !== "string")
    throw new PolicyError("invalid lane policy snapshot");
  return readLanePolicy(JSON.stringify({ file, id: value.id }));
};
