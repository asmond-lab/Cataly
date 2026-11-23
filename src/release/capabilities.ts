import type { RuntimeKind } from "../runtime/types.ts";
import { object } from "../update/config.ts";
import { digest } from "../update/source.ts";
import type { ReleaseManifest } from "./types.ts";

export const terminalMetadata = "release-capabilities.json";
export const nativeMetadata = "release-headless.json";

type Profile = { readonly platform: string; readonly arch: string; readonly runtime: RuntimeKind };

const TERMINAL_PROFILES = [
  { platform: "linux", arch: "x64", runtime: "herdr" },
  { platform: "darwin", arch: "arm64", runtime: "hc" },
] as const satisfies readonly Profile[];
const HEADLESS_PROFILES = [
  { platform: "linux", arch: "x64", runtime: "headless" },
  { platform: "darwin", arch: "arm64", runtime: "headless" },
] as const satisfies readonly Profile[];

export function supportsReleaseProfile(
  manifest: ReleaseManifest,
  profile: { readonly platform: string; readonly arch: string; readonly runtime: string },
  metadata?: Uint8Array,
): boolean {
  const profiles = readReleaseProfiles(manifest, terminalMetadata, metadata, TERMINAL_PROFILES) ?? [
    TERMINAL_PROFILES[0],
  ];
  return profiles.some(
    (candidate) =>
      candidate.platform === profile.platform &&
      candidate.arch === profile.arch &&
      candidate.runtime === profile.runtime,
  );
}

/** The separate source-bound marker leaves the older updater's exact v1 profile schema unchanged. */
export function headlessReleaseProfiles(manifest: ReleaseManifest, metadata?: Uint8Array) {
  const profiles = readReleaseProfiles(manifest, nativeMetadata, metadata, HEADLESS_PROFILES);
  if (
    profiles &&
    (manifest.requirements.omp === "18.18.8" || !manifest.source.files.some((entry) => entry.path === terminalMetadata))
  )
    throw new Error("Headless capability requires a bound native OMP payload and historical release profiles");
  return profiles ?? [];
}

function readReleaseProfiles<T extends Profile>(
  manifest: ReleaseManifest,
  path: string,
  metadata: Uint8Array | undefined,
  supported: readonly T[],
): readonly T[] | undefined {
  const source = manifest.source.files.find((entry) => entry.path === path);
  if (!source) {
    if (metadata !== undefined) throw new Error(`Unexpected release capabilities metadata: ${path}`);
    return undefined;
  }
  if (metadata === undefined || digest(metadata) !== source.sha256)
    throw new Error(`Release capabilities metadata missing or SHA256 differs: ${path}`);
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
  if (
    !object(input) ||
    Object.keys(input).sort().join() !== "profiles,version" ||
    input["version"] !== 1 ||
    !Array.isArray(input["profiles"]) ||
    !input["profiles"].length
  )
    throw new Error("Invalid release capabilities");
  const profiles: T[] = [];
  for (const entry of input["profiles"]) {
    if (!object(entry) || Object.keys(entry).sort().join() !== "arch,platform,runtime")
      throw new Error("Invalid release capability");
    const candidate = supported.find(
      (item) => item.platform === entry["platform"] && item.arch === entry["arch"] && item.runtime === entry["runtime"],
    );
    if (!candidate || profiles.includes(candidate)) throw new Error("Invalid or duplicate release capability");
    profiles.push(candidate);
  }
  return profiles;
}
