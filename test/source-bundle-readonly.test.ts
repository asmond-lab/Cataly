import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSourceBundle, readSourceBundle } from "../src/release/source-bundle.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

test("rejecting staged source drift leaves both the shared index and object database unchanged", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cataly-readonly-source-"));
  try {
    const f = overlayFixture(join(root, "bundle"), join(root, "checkout"));
    f.put("presets.ts", "export const changed = true;\n");
    fixtureGit(f.checkout, "add", "presets.ts");
    const objects = join(f.checkout, ".git/objects");
    const before = sourceManifest(objects);
    const index = readFileSync(join(f.checkout, ".git/index"));
    const verify = () => assertSourceBundle(f.checkout, readSourceBundle(f.source), root);
    if (process.platform === "win32") {
      // The managed bundle requires POSIX-protected metadata. Windows fails closed before Git verification.
      expect(verify).toThrow("Group/world-writable installation path:");
    } else expect(verify).toThrow("source checkout differs");
    expect(sourceManifest(objects)).toEqual(before);
    expect(readFileSync(join(f.checkout, ".git/index"))).toEqual(index);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
