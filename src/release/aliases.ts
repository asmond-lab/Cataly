import { lstatSync } from "node:fs";
import { join } from "node:path";
import { type ConsumerPaths, isPrimaryConsumer, owned, pointer, realDirectory, replacePointer } from "./files.ts";

/** An old updater can still validate its v1 wrapper receipt. Canonical aliases are separate from that wire format. */
export function installLegacyAliases(paths: ConsumerPaths, publish = true): void {
  const primary = isPrimaryConsumer(paths);
  const names = [
    ["cataly", "dori"],
    ["cataly-harness", "dori-harness"],
    ...(primary ? [] : ([["omp-cataly", "omp-dori"]] as const)),
  ] as const;
  const bin = join(paths.cataly, "bin");
  if (paths.layout === "cataly") {
    if (primary) return;
    realDirectory(bin);
    for (const [, legacy] of names) {
      const path = join(bin, legacy);
      if (lstatSync(path, { throwIfNoEntry: false }))
        throw new Error(`Ambiguous consumer command layout: ${path}; preserve it before reinstalling`);
    }
    return;
  }
  const missing = names.flatMap(([alias, target]) => {
    const path = join(bin, alias);
    const expected = join(bin, target);
    const current = pointer(path);
    if (current !== undefined && current !== expected) throw new Error(`Unmanaged Cataly compatibility link: ${path}`);
    return current === undefined ? [{ path, expected }] : [];
  });
  if (!publish || missing.length === 0) return;
  realDirectory(bin, true);
  owned(bin);
  for (const { path, expected } of missing) replacePointer(path, undefined, expected);
}
