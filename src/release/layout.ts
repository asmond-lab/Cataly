import { join } from "node:path";
import { contains } from "../update/config.ts";
import { readReferenceReceipts, type ReferenceLayout } from "./reference-receipts.ts";

export const isPrimaryConsumer = ({ home, cataly }: { readonly home: string; readonly cataly: string }): boolean =>
  cataly === join(home, ".cataly") || cataly === join(home, ".dori");

export function consumerLayout(home: string, location: string, read: (path: string) => unknown): ReferenceLayout {
  for (const primary of [join(home, ".cataly"), join(home, ".dori")])
    if (location !== primary && (contains(primary, location) || contains(location, primary)))
      throw new Error(`A consumer home must not contain or be inside the primary home ${primary}`);
  if (location === join(home, ".dori") || location === join(home, ".omp-dori")) return "legacy";
  if (location === join(home, ".cataly")) return "cataly";
  // A custom v1 home may have committed its transaction before publishing any of its wrappers.
  const root = join(location, "releases");
  const receipts = readReferenceReceipts(root, read);
  if (!receipts) return "cataly";
  const owner = read(join(root, "consumer-owner.json"));
  if (JSON.stringify(owner) !== JSON.stringify({ version: 1, home, liveSource: join(location, "src") }))
    throw new Error("Consumer release ownership differs");
  return receipts.layout;
}
