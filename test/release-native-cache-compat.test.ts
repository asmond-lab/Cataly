import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform } from "../src/platform/index.ts";
import { nativeCacheRoot, readLeases } from "../src/release/native-cache-lease.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

afterEach(removePruneFixtures);

// These launchers and leases use POSIX shells and ownership.
const posix = test.skipIf(process.platform === "win32");
const DEPENDENCIES = resolve(import.meta.dir, "../scripts/source-dependencies.ts");

function taggedNativeFixture() {
  const { root, home } = pruneFixture();
  const { source, checkout } = overlayFixture(join(root, "candidate"), join(root, "upstream"), true);
  writeFileSync(join(source, "release-headless.json"), "{}\n");
  mkdirSync(join(source, "scripts"));
  writeFileSync(join(source, "scripts/source-dependencies.ts"), `import ${JSON.stringify(DEPENDENCIES)};\n`);
  // The tagged updater chooses omp-dori even though the source it provisions has the new release marker.
  const identity = readSourceBundle(source, true).identity;
  const name = `${platform.nativeCacheLabel()}-${identity}`;
  const legacyRoot = nativeCacheRoot(home, true);
  const legacy = nativeCacheFixture(source, home, checkout, join(legacyRoot, name));
  const currentDirectory = join(nativeCacheRoot(home), name);
  const env = { HOME: home, PATH: process.env["PATH"] };
  const launch = (omp: string) => Bun.spawnSync([omp, "--version"], { cwd: root, env });
  return { root, home, source, checkout, legacy, legacyRoot, currentDirectory, env, launch };
}

posix("a new consumer verifies and leases the tagged updater's cache without copying or repairing it", () => {
  const f = taggedNativeFixture();
  const config = join(f.root, "config.json");
  writeFileSync(config, JSON.stringify({ ompUlwPath: join(f.root, "user-ulw.ts") }));
  const receiptPath = join(f.legacy.directory, "receipt.json");
  const immutable = [readFileSync(receiptPath), readFileSync(f.legacy.omp)];
  const consumer = (source: string) =>
    Bun.spawnSync([process.execPath, DEPENDENCIES, "consumer", source, f.home], {
      cwd: f.root,
      env: { ...f.env, CATALY_CONFIG: config, CATALY_NATIVE_LEASE_PID: String(process.pid) },
    });
  const selected = consumer(f.source);
  expect(selected.exitCode, selected.stderr.toString()).toBe(0);
  expect(selected.stdout.toString().trim()).toBe(f.legacy.omp);
  const launched = f.launch(f.legacy.omp);
  expect(launched.exitCode, launched.stderr.toString()).toBe(0);
  expect(launched.stdout.toString()).toBe("18.20.0\n");
  expect(readLeases(f.legacyRoot, false).byIdentity.get(f.legacy.identity)).toEqual([
    `lease of process ${process.pid}`,
  ]);

  // The same bundle at another path cannot make the launcher's original source binding valid again.
  const moved = join(f.root, "moved-candidate");
  renameSync(f.source, moved);
  const stale = consumer(moved);
  expect(stale.exitCode).not.toBe(0);
  expect(stale.stderr.toString()).toContain(`Missing file: ${join(f.source, "native-omp.lock")}`);
  expect(stale.stdout.toString()).toBe("");
  expect(existsSync(nativeCacheRoot(f.home))).toBe(false);
  expect([readFileSync(receiptPath), readFileSync(f.legacy.omp)]).toEqual(immutable);
});

posix("a legacy launcher cannot execute its own cache after verifying an intact current-root sibling", () => {
  const f = taggedNativeFixture();
  const current = nativeCacheFixture(f.source, f.home, f.checkout, f.currentDirectory);
  const verified = f.launch(f.legacy.omp);
  expect(verified.exitCode, verified.stderr.toString()).toBe(0);
  expect(verified.stdout.toString()).toBe("18.20.0\n");

  writeFileSync(f.legacy.addon, "different addon bytes\n");
  const rejected = f.launch(f.legacy.omp);
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr.toString()).toContain("Bound native source, Bun, addon or launcher receipt differs");
  expect(rejected.stdout.toString()).toBe("");
  const intact = f.launch(current.omp);
  expect(intact.exitCode, intact.stderr.toString()).toBe(0);
});
