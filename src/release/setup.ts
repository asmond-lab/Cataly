import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { assertSetupFile, readSetupFile, setupPreview, type SetupSnapshot } from "../setup-files.ts";
import { extractArchive } from "./archive.ts";
import type { VerifiedBundle } from "./bundle.ts";
import { nativeMetadata } from "./capabilities.ts";
import { type ConsumerPaths, isPrimaryConsumer } from "./files.ts";
import { assertLock, dependencyPlan } from "./provision.ts";

type ConsumerConfigPlan = { readonly text: string | Buffer; readonly keys: readonly string[] };

export function consumerConfigPlan(
  paths: ConsumerPaths,
  snapshot: SetupSnapshot,
  source: string,
  dependency: string,
  manifest: VerifiedBundle["manifest"],
): ConsumerConfigPlan {
  if (snapshot.path !== paths.config) throw new Error("Configuration snapshot belongs to another installation");
  const saved = readSetupFile(snapshot);
  if (saved !== undefined) return { text: saved, keys: [] };
  const skill = manifest.source.files.some((file) => file.path === "skills/cataly-mode/references/config.example.json")
    ? "cataly-mode"
    : "dori-mode";
  const example = JSON.parse(readFileSync(join(source, "skills", skill, "references/config.example.json"), "utf8"));
  example.ompUlwPath = dependency;
  const keys = ["ompUlwPath"];
  if (manifest.source.files.some((file) => file.path === nativeMetadata)) {
    delete example.runtime;
    delete example.sessionRuntime;
  } else {
    example.runtime = platform.legacyReleaseRuntime();
    keys.push("runtime");
  }
  if (!isPrimaryConsumer(paths) || (paths.layout === "legacy" && skill === "cataly-mode")) {
    example.stateDir = join(paths.cataly, "state");
    keys.push("stateDir");
  }
  if (manifest.requirements.omp !== "18.18.8" || !isPrimaryConsumer(paths)) {
    example.agentCommand = [
      join(paths.cataly, "bin/omp"),
      ...(example.agentCommand?.slice(1) ?? [
        skill === "cataly-mode" ? "--cataly-role" : "--dori-role",
        "lane",
        "--model",
        "{model}",
        "{prompt}",
      ]),
    ];
    keys.push("agentCommand");
  }
  return { text: `${JSON.stringify(example, null, 2)}\n`, keys };
}

/** Verify the selected bytes in disposable storage, without preparing dependencies or touching the installation. */
export function previewConsumerSetup(paths: ConsumerPaths, bundle: VerifiedBundle, snapshot: SetupSnapshot) {
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "dori-setup-preview-")));
  let plan: ConsumerConfigPlan;
  try {
    const source = join(stage, "source");
    extractArchive(bundle.files, bundle.manifest, source);
    assertLock(source, bundle.manifest);
    const dependency = join(dependencyPlan(paths, bundle.manifest, source).directory, "index.ts");
    plan = consumerConfigPlan(paths, snapshot, source, dependency, bundle.manifest);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  assertSetupFile(snapshot);
  return setupPreview(snapshot, plan.text, plan.keys);
}
