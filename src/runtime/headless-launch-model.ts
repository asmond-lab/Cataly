import {
  exactModelIdentity,
  expectedLaunchModel,
  type ModelReadback,
} from "../../skills/cataly-mode/scripts/src/lane-state.ts";
import { isCatalyEntry } from "../../skills/cataly-mode/scripts/src/session-compat.ts";
import { type HeadlessObservation, type HeadlessRequest, modelOf, object, string } from "./headless-protocol.ts";
import type { Reservation } from "./headless-record.ts";
import type { NativeState } from "./headless-remote.ts";
import type { HeadlessRpc } from "./headless-rpc.ts";

export const LAUNCH_MODEL_FLAG = "cataly-launch-model";
export const LEGACY_LAUNCH_MODEL_FLAG = "dori-launch-model";
export const LAUNCH_MODEL_OPTION = `--${LAUNCH_MODEL_FLAG}=`;
export const HEADLESS_LAUNCH_MODEL_ENTRY = "omp-cataly:headless-launch-model";

export type HeadlessBeginOutcome = HeadlessObservation & { readonly modelReadback: ModelReadback };

export const launchModelFromArgv = (argv: readonly string[]): string | undefined =>
  argv.findLast((arg) => arg.startsWith(LAUNCH_MODEL_OPTION))?.slice(LAUNCH_MODEL_OPTION.length);

type LaunchBinding = {
  readonly refId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly startedAt: string;
};

type BeginGate = {
  readonly reservation: Reservation;
  readonly model: string | undefined;
  readonly check: (session: string) => Promise<NativeState>;
};

const launchModelOf = (value: unknown, binding: LaunchBinding): ModelReadback | undefined => {
  const entry = object(value);
  const proof = object(entry?.["proof"]);
  const requested = exactModelIdentity(binding.model);
  const observed = modelOf(proof?.["observed"]);
  const identity = observed === undefined ? null : exactModelIdentity(observed);
  const checkedAt = string(proof?.["checkedAt"]);
  const status = proof?.["status"];
  const billing = proof?.["billing"];
  const expected = expectedLaunchModel(binding.model, proof?.["thinking"]);
  if (
    entry?.["refId"] !== binding.refId ||
    entry?.["sessionId"] !== binding.sessionId ||
    !requested ||
    modelOf(proof?.["requested"]) !== binding.model ||
    proof?.["source"] !== "native-extension" ||
    !checkedAt ||
    !(Date.parse(checkedAt) >= Date.parse(binding.startedAt)) ||
    (status !== "matched" && status !== "mismatch" && status !== "unknown" && status !== "unavailable") ||
    (billing !== "unknown" && billing !== "subscription" && billing !== "non-subscription")
  )
    return undefined;
  if (status === "matched" && (!identity || !expected || observed?.toLowerCase() !== expected.model.toLowerCase()))
    return undefined;
  return {
    requested,
    observed: identity,
    checkedAt,
    status,
    billing,
    source: "native-extension",
    ...(status === "matched" && expected?.thinking ? { thinking: expected.thinking } : {}),
  };
};

const readLaunchModel = async (rpc: HeadlessRpc, binding: LaunchBinding): Promise<ModelReadback | undefined> => {
  // get_available_models applies enabledModels and can hide case collisions; the extension sees the full provider catalog.
  const entries = (await rpc.request({ type: "get_entries" }))?.["entries"];
  if (!Array.isArray(entries)) return undefined;
  const entry = entries
    .map(object)
    .findLast((e) => e?.["type"] === "custom" && isCatalyEntry(e["customType"], HEADLESS_LAUNCH_MODEL_ENTRY));
  return launchModelOf(entry?.["data"], binding);
};

export async function beginNativeGoal(
  rpc: HeadlessRpc,
  { expectedSessionId, objective }: Extract<HeadlessRequest, { op: "begin" }>,
  gate: BeginGate,
): Promise<ModelReadback> {
  if (typeof expectedSessionId !== "string" || !expectedSessionId)
    throw new Error("native goal creation requires an exact session identity");
  const expectedModel = gate.model;
  if (!expectedModel) throw new Error("STARTUP_MODEL_HOLD: no launch model bound; no goal created");
  const modelReadback = await readLaunchModel(rpc, {
    refId: gate.reservation.ref.id,
    sessionId: expectedSessionId,
    model: expectedModel,
    startedAt: gate.reservation.startedAt,
  });
  const state = await gate.check(expectedSessionId);
  if (modelReadback?.status !== "matched")
    throw new Error(
      `STARTUP_MODEL_HOLD: native launch model ${modelReadback?.status ?? "unconfirmed"}; no goal created`,
    );
  if (`${modelReadback.observed?.provider}/${modelReadback.observed?.id}` !== state.model)
    throw new Error("STARTUP_MODEL_HOLD: native launch model changed; no goal created");
  if (!state.settled || state.goal.status !== "none" || typeof objective !== "string" || !objective.trim())
    throw new Error("a fresh settled OMP lane is required to create a goal");
  const result = await rpc.request({ type: "goal", op: "create", objective });
  if (object(result?.["goal"])?.["status"] !== "active") throw new Error("OMP did not acknowledge an active goal");
  return modelReadback;
}
