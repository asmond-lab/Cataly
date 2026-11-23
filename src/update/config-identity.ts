import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { object } from "./config.ts";
import { legacyDeploymentConfig } from "./deployment-config.ts";
import { digest } from "./source.ts";
import type { UpdateConfig } from "./types.ts";

/** Existing roots keep their exact v0.1.3 identity. A changed config still cannot adopt their pending jobs. */
export function updateConfigurationHash(config: UpdateConfig): string {
  const current = digest(JSON.stringify(config));
  const path = join(config.root, "state.json");
  if (!existsSync(path)) return current;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(raw) || raw["version"] !== 1 || raw["configHash"] === current) return current;
  const deployment = config.promotion?.deployment;
  const previous = {
    ...config,
    target: "dori",
    ...(config.promotion && deployment
      ? { promotion: { ...config.promotion, deployment: legacyDeploymentConfig(deployment) } }
      : {}),
  };
  const legacy = digest(JSON.stringify(previous));
  return raw["configHash"] === legacy ? legacy : current;
}
