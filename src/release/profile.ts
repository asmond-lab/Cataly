import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { classifyOmpArgv } from "../runtime/omp-argv.ts";
import { isSessionRuntime } from "../runtime/select.ts";
import type { RuntimeKind } from "../runtime/types.ts";
import { readSetupFile, type SetupSnapshot } from "../setup-files.ts";
import { object } from "../update/config.ts";
import { headlessReleaseProfiles, nativeMetadata, supportsReleaseProfile, terminalMetadata } from "./capabilities.ts";
import { controllerReads } from "./controller.ts";
import type { ConsumerPaths } from "./files.ts";
import type { ReleaseManifest } from "./types.ts";

type ReleaseProfileBytes = (path: string) => Uint8Array | undefined;

function optionalRuntime(value: unknown, label: string): RuntimeKind | undefined {
  if (value === undefined) return undefined;
  if (isSessionRuntime(value)) return value;
  throw new Error(`${label} must be headless, hc or herdr`);
}

export function requestedReleaseRuntime(flag?: string): RuntimeKind | undefined {
  return optionalRuntime(
    flag ?? ((process.env["CATALY_RUNTIME"] ?? process.env["DORI_RUNTIME"]) || undefined),
    flag === undefined ? "CATALY_RUNTIME" : "--runtime",
  );
}

/** Select and verify against the target payload, not the update command's loaded (possibly legacy) release. */
export function releaseTargetRuntime(
  paths: ConsumerPaths,
  target: { readonly manifest: ReleaseManifest; readonly bytes: ReleaseProfileBytes },
  options: { readonly snapshot: SetupSnapshot; readonly requested?: RuntimeKind },
): RuntimeKind {
  const { manifest, bytes } = target;
  const terminal = bytes(terminalMetadata);
  const headless = headlessReleaseProfiles(manifest, bytes(nativeMetadata));
  const host = { platform: platform.os, arch: process.arch };
  const legacy = { ...host, runtime: platform.legacyReleaseRuntime() };
  const terminalSupported = supportsReleaseProfile(manifest, legacy, terminal);
  if (paths.cataly !== join(paths.home, ".dori") && !terminal)
    throw new Error("Legacy releases do not support isolated homes; keep them in the primary ~/.dori home");
  const saved = readSetupFile(options.snapshot);
  const config: unknown = saved === undefined ? {} : JSON.parse(saved.toString("utf8"));
  if (!object(config)) throw new Error("Preserved config must be an object");
  const selected = optionalRuntime(config["sessionRuntime"], "Preserved config sessionRuntime");
  const historical = config["runtime"];
  if (historical !== undefined && historical !== "hc" && historical !== "herdr")
    throw new Error("Preserved config runtime must be hc or herdr when present");
  if (headless.length > 0) {
    const runtime = options.requested ?? selected ?? "headless";
    const supported =
      runtime === "headless"
        ? headless.some((profile) => profile.platform === host.platform && profile.arch === host.arch)
        : runtime === legacy.runtime && terminalSupported;
    if (supported) return runtime;
    throw new Error(`Release ${manifest.tag} does not support ${host.platform}/${host.arch}/${runtime}`);
  }
  if (paths.layout !== "legacy")
    throw new Error("A historical release requires its original consumer home and launcher layout");

  // Older readers ignore sessionRuntime. Do not activate a target that cannot honor that explicit selection
  // or one whose preserved runtime the older updater would refuse to read.
  if (saved !== undefined && historical === undefined)
    throw new Error('Preserved config must explicitly select runtime "hc" or "herdr" for a legacy release');
  const runtime = options.requested ?? selected ?? historical ?? legacy.runtime;
  if ((historical !== undefined && historical !== runtime) || (selected !== undefined && selected !== runtime))
    throw new Error("Selected legacy runtime conflicts with preserved config runtime; leave the config intact");
  const command = config["agentCommand"];
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const parsed = classifyOmpArgv(command);
    if (parsed.kind === "omp") {
      for (const arg of parsed.command.slice(parsed.argsAt)) {
        if (arg === "--") break;
        if (arg === "--cataly-role" || arg.startsWith("--cataly-role="))
          throw new Error("Historical release cannot use the preserved --cataly-role argument");
      }
    }
  }
  if (runtime !== legacy.runtime || !terminalSupported)
    throw new Error(`Release ${manifest.tag} does not support ${host.platform}/${host.arch}/${runtime}`);
  return runtime;
}

/** Leaving the native protocol is intentional only through a verified, explicitly retained rollback. */
export function assertUpdateProtocol(current: ReleaseManifest | undefined, target: ReleaseManifest): void {
  if (current && !controllerReads(target, current))
    throw new Error(
      `Install cannot downgrade the bound runtime protocol: release ${target.tag} cannot read the OMP 19 receipt of installed ${current.tag}; use "cataly update rollback" to restore a retained pre-19 release`,
    );
  if (
    (current?.requirements.omp === "18.20.0" && target.requirements.omp === "18.18.8") ||
    (current?.source.files.some((entry) => entry.path === nativeMetadata) &&
      !target.source.files.some((entry) => entry.path === nativeMetadata))
  )
    throw new Error("Install cannot downgrade the bound runtime protocol; use rollback with its required tools");
}
