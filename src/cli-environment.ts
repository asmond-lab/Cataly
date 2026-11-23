import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { importLegacyEnvironment } from "./legacy-environment.ts";
import { consumerReleaseHome } from "./release/runtime.ts";

export function bindCliEnvironment(): void {
  // The primary v0.1.3 entry points are symlinks, not shell wrappers. Follow the loaded release, never cwd.
  const installedHome = consumerReleaseHome(realpathSync(resolve(import.meta.dir, "..")));
  if (installedHome !== undefined) {
    const installedConfig = join(installedHome, "config.json");
    // During rollback the old side wrappers can already be published while this CLI is still active.
    // Their DORI pair is bound to this physical release; a conflicting inherited Cataly context is not.
    if (
      process.env["DORI_HOME"] === installedHome &&
      process.env["DORI_CONFIG"] === installedConfig &&
      (process.env["CATALY_HOME"] !== installedHome || process.env["CATALY_CONFIG"] !== installedConfig)
    ) {
      for (const key of [
        "HOME",
        "CONFIG",
        "STATE_DIR",
        "LEAD_PANE",
        "HC_SPACE",
        "PROMPTS_DIR",
        "CMD",
        "AGENT_CMD",
        "AGENT_ARGV",
        "OMP_ULW_PATH",
        "MANAGED_STARTUP",
        "HERDR_SESSION",
      ])
        delete process.env[`CATALY_${key}`];
    }
  }
  importLegacyEnvironment();
  if (installedHome !== undefined) process.env["CATALY_HOME"] ??= installedHome;
  const home = process.env["CATALY_HOME"];
  if (home !== undefined) process.env["CATALY_CONFIG"] ??= join(home, "config.json");
}
