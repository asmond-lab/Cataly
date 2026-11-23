import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { configPath } from "../skills/cataly-mode/scripts/src/config.ts";
import { importLegacyEnvironment } from "../src/legacy-environment.ts";
import { owned, regularFile } from "../src/release/files.ts";
import { consumerReleaseHome } from "../src/release/runtime.ts";

function legacyPrimarySourceHome(source: string, home: string): string | undefined {
  if (basename(source) !== "src" || typeof process.getuid !== "function") return undefined;
  try {
    const root = join(realpathSync(home), ".dori");
    if (source !== join(root, "src") || !lstatSync(root).isDirectory() || !lstatSync(source).isDirectory())
      return undefined;
    owned(root);
    owned(source);
    const git = join(source, ".git");
    const checkout = lstatSync(git);
    if (!checkout.isDirectory() && !checkout.isFile()) return undefined;
    owned(git);
    if (!regularFile(join(source, "omp-ulw.lock"))) return undefined;
    const marked = [".omp-cataly", ".omp-dori"].some((name) => {
      const file = join(root, name);
      return regularFile(file) && readFileSync(file, "utf8").replace(/\n+$/, "") === "primary";
    });
    return marked ? root : undefined;
  } catch {
    // An unreadable, linked or unowned marker does not select the legacy installation.
    return undefined;
  }
}

/** Global discovery runs before OMP supplies the resumed branch. Select config without changing the host environment. */
export function extensionInstallation(source = resolve(import.meta.dir, ".."), userHome = homedir()) {
  const env = { ...process.env };
  importLegacyEnvironment(env);
  if (env["CATALY_HOME"] === undefined) {
    const physical = realpathSync(source);
    env["CATALY_HOME"] = consumerReleaseHome(physical) ?? legacyPrimarySourceHome(physical, userHome);
  }
  const home = env["CATALY_HOME"];
  const ordinaryConfig = configPath();
  const configFile = env["CATALY_CONFIG"] ?? (home === undefined ? ordinaryConfig : join(home, "config.json"));
  const ordinaryPaneRoot =
    configFile === ordinaryConfig &&
    env["CATALY_HOME"] === process.env["CATALY_HOME"] &&
    env["CATALY_STATE_DIR"] === process.env["CATALY_STATE_DIR"];
  env["CATALY_CONFIG"] = configFile;
  return { configFile, installationHome: home, env, ordinaryPaneRoot };
}
