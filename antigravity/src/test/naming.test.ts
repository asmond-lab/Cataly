import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

it("uses Cataly naming throughout the plugin and runtime", () => {
  function check(dir: string): void {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === "test") continue;
      const path = `${dir}/${entry.name}`;
      assert.doesNotMatch(path, /dori/i, `legacy name in path: ${path}`);
      if (entry.isDirectory()) check(path);
      else if (/\.(?:ts|mjs|json|md|svg)$/.test(entry.name)) {
        assert.doesNotMatch(readFileSync(join(root, path), "utf8"), /dori/i, `legacy name in ${path}`);
      }
    }
  }
  for (const dir of ["plugin", "scripts", "src"]) check(dir);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "cataly-antigravity");
  assert.deepEqual(Object.keys(pkg.bin), ["cataly"]);
});
