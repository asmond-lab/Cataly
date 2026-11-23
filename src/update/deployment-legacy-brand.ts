import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DeploymentHeld } from "./deployment-process.ts";
import { sourceManifest } from "./source.ts";

/** Select the v0.1.3 dialect only for hash-bound deployment source, never from an argv hint. */
export function legacyDeploymentSource(source: string | undefined, hash: string | undefined): boolean {
  if (!source) return false;
  const manifest = join(source, "package.json");
  if (!existsSync(manifest)) return false;
  const pkg: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "dori-superagent") return false;
  if (
    !hash ||
    sourceManifest(source).hash !== hash ||
    !existsSync(join(source, "skills", "dori-mode", "scripts", "src", "cli.ts"))
  )
    throw new DeploymentHeld("legacy deployment source does not match its journaled bytes");
  return true;
}

/** Call only on the generated managed environment, not the caller's inherited variables. */
export const deploymentEnvArgs = (env: Record<string, string>, legacy: boolean): string[] =>
  Object.entries(env).map(
    ([key, value]) => `${legacy && key.startsWith("CATALY_") ? `DORI_${key.slice("CATALY_".length)}` : key}=${value}`,
  );
