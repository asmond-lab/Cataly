import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome } from "../skills/cataly-mode/scripts/src/config.ts";
import { importLegacyEnvironment } from "../src/legacy-environment.ts";
import { consumerPaths } from "../src/release/files.ts";
import { assertNativeSource, leaseNativePath, provisionNativeSource } from "../src/release/native.ts";
import { nativeCacheRoot, scriptLeaseHolder } from "../src/release/native-cache-lease.ts";
import { resolveConsumerOmpUlwPath } from "../src/release/runtime.ts";
import { assertSourceBundle, readSourceBundle } from "../src/release/source-bundle.ts";
import { provisionSourceOverlay } from "../src/release/source-checkout.ts";

importLegacyEnvironment();
const [action, rawSource, rawHome, rawTarget] = process.argv.slice(2);
if (!rawSource || !rawHome) throw new Error("source dependencies require an action, source root and home");
const source = resolve(rawSource);
const home = resolve(rawHome);
// The shell that runs or execs the identity holds its lease: the cache launcher's for assert-native, the named one else.
if (action === "native") {
  const receipt = await provisionNativeSource(source, home, process.execPath, scriptLeaseHolder());
  process.stdout.write(`${receipt.directory}\n`);
} else if (action === "assert-native") {
  // Existing launchers already enter their private launch-cwd. Validate that exact cache, not a preferred sibling.
  const cwd = process.cwd();
  const directory = dirname(cwd);
  const root = dirname(directory);
  const pinned =
    basename(cwd) === "launch-cwd" && (root === nativeCacheRoot(home) || root === nativeCacheRoot(home, true));
  const receipt = assertNativeSource(source, home, process.execPath, {
    holder: scriptLeaseHolder(),
    ...(pinned ? { directory } : {}),
  });
  process.stdout.write(`${receipt.directory}\n`);
} else if (action === "consumer") {
  const native = assertNativeSource(source, home, process.execPath, { holder: scriptLeaseHolder() });
  const configPath = process.env["CATALY_CONFIG"] ?? consumerPaths(home).config;
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const path = expandHome(config.ompUlwPath ?? join(home, ".cataly/omp-ulw/index.ts"), home);
  const selected = resolveConsumerOmpUlwPath(path, {
    home,
    sourceRoot: source,
    useDefault: config.ompUlwPath === undefined,
  });
  if (selected === path && (config.ompUlwPath === undefined || path === join(home, ".cataly/omp-ulw/index.ts")))
    assertSourceBundle(realpathSync(dirname(path)), readSourceBundle(source), home);
  process.stdout.write(`${native.omp}\n`);
} else if (action === "lease-path") {
  // An explicitly selected executable a writer publishes: leased like a prepared identity when it lies in the cache.
  if (!rawTarget) throw new Error("A native lease requires the selected executable path");
  leaseNativePath(home, resolve(rawTarget), scriptLeaseHolder());
} else if (action === "assert-ulw") {
  if (!rawTarget) throw new Error("ULW admission requires its selected source path");
  assertSourceBundle(realpathSync(rawTarget), readSourceBundle(source), home);
} else if (action === "ulw") {
  const entry = await provisionSourceOverlay(
    source,
    home,
    rawTarget ? resolve(rawTarget) : undefined,
    process.env["OMP_ULW_REPO"] || undefined,
  );
  process.stdout.write(`${dirname(entry)}\n`);
} else throw new Error("Unknown source dependency action");
