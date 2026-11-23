#!/usr/bin/env bash
# Release bootstrap. Requires git and Bun 1.4.4+; historical releases also require their terminal runtime.
set -euo pipefail
command -v bun >/dev/null || { echo "Bun 1.4.4+ is required; install it before Cataly" >&2; exit 1; }
bun run - "$@" <<'BUN'
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new Error(message); };
const api = "https://api.github.com/repos/vntrevx/Cataly";
const downloads = "https://github.com/vntrevx/Cataly/releases/download";
const max = 128 * 1024 * 1024;
let temporary;
try {
  const args = parseArgs({ args: process.argv.slice(2), strict: true,
    options: { version: { type: "string" }, from: { type: "string" }, home: { type: "string" },
      runtime: { type: "string" }, "retire-legacy-roles": { type: "boolean" },
      "legacy-session": { type: "string" }, "legacy-migrated-session": { type: "string" },
      help: { type: "boolean", short: "h" } } });
  if (args.values.help) {
    console.log("install.sh [--version vX.Y.Z] [--from DIST] [--home PATH] [--runtime headless|hc|herdr]\ninstall.sh --retire-legacy-roles --home PATH [--legacy-session NAME] [--legacy-migrated-session NAME] [--version vX.Y.Z] [--from DIST]\nRetirement verifies the new release and the already-stopped v0.1.3 home, without installing or stopping terminals.\nCATALY_RELEASE selects an explicit tag. Current releases default to headless. No services are started.");
    process.exit(0);
  }
  const retire = args.values["retire-legacy-roles"] === true;
  if (retire && (!args.values.home || args.values.runtime !== undefined))
    fail("--retire-legacy-roles requires --home and does not take --runtime");
  const sessionFlags = ["legacy-session", "legacy-migrated-session"];
  if (!retire && sessionFlags.some((key) => args.values[key] !== undefined))
    fail("Legacy session flags apply only to --retire-legacy-roles");
  const version = args.values.version ?? process.env.CATALY_RELEASE ?? process.env.DORI_RELEASE;
  if (version !== undefined && !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) fail("Select an exact --version vX.Y.Z");
  if (args.values.from !== undefined && !args.values.from.trim()) fail("--from requires a directory");
  const atLeast = (text, wanted) => {
    const numbers = /^(\d+)\.(\d+)\.(\d+)(?:\s|$|\+)/.exec(text)?.slice(1).map(Number);
    if (!numbers) return false;
    for (let i = 0; i < wanted.length; i++) if (numbers[i] !== wanted[i]) return numbers[i] > wanted[i];
    return true;
  };
  const linux = process.platform === "linux" && process.arch === "x64";
  const darwin = process.platform === "darwin" && process.arch === "arm64";
  const legacyRuntime = darwin ? "hc" : "herdr";
  const requested = retire ? "headless" : args.values.runtime ?? ((process.env.CATALY_RUNTIME ?? process.env.DORI_RUNTIME) || undefined);
  if ((!linux && !darwin) || (requested !== undefined && requested !== "headless" && requested !== legacyRuntime))
    fail(`Unsupported host/runtime: ${process.platform}/${process.arch}/${requested ?? "headless"}`);
  const installMode = process.env.CATALY_INSTALL_MODE ?? process.env.DORI_INSTALL_MODE;
  const mode = installMode ?? (darwin ? "side" : "primary");
  if (mode !== "primary" && mode !== "side") fail("CATALY_INSTALL_MODE must be primary or side");
  if (args.values.home !== undefined && !args.values.home.trim()) fail("--home requires a directory");
  const currentPrimary = resolve(homedir(), ".cataly"), historicalPrimary = resolve(homedir(), ".dori");
  const explicitHome = args.values.home ?? (mode === "side" ? (process.env.OMP_CATALY_HOME ?? process.env.OMP_DORI_HOME) : undefined);
  const physical = (path) => {
    const suffix = [];
    let ancestor = path;
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    return resolve(realpathSync(ancestor), ...suffix);
  };
  const stat = (path) => lstatSync(path, { throwIfNoEntry: false });
  let home, configPath, configEntry, config = {};
  const selectHome = (historical) => {
    const primary = historical ? historicalPrimary : currentPrimary;
    const side = historical ? ".omp-dori" : ".omp-cataly";
    const selectedHome = explicitHome ?? (mode === "side" ? join(homedir(), side) : primary);
    if (!isAbsolute(selectedHome)) fail("--home / OMP_CATALY_HOME must be an absolute installation home");
    home = resolve(selectedHome);
    const actualHome = physical(home);
    for (const protectedHome of [currentPrimary, historicalPrimary]) {
      const actualPrimary = physical(protectedHome);
      const withinPrimary = relative(actualPrimary, actualHome);
      const containsPrimary = relative(actualHome, actualPrimary);
      const inside = (rel) => !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
      if ((installMode === "side" || home !== protectedHome) && (inside(withinPrimary) || inside(containsPrimary)))
        fail(`Side installation home must be outside ${protectedHome} and must not contain it`);
    }
    const isPrimary = home === currentPrimary || home === historicalPrimary;
    const source = join(home, "src");
    const sourceStat = stat(source);
    if (stat(join(home, ".omp-cataly")) || stat(join(home, ".omp-dori")) || stat(join(home, ".git")) ||
      (sourceStat && (!sourceStat.isSymbolicLink() ||
        dirname(resolve(home, readlinkSync(source))) !== join(home, "releases/releases"))))
      fail(`Source-owned installation at ${home}; choose another home`);
    for (const [name, target] of [
      ["cataly", "skills/cataly-mode/scripts/src/cli.ts"], ["cataly-harness", "src/cli.ts"],
      ["dori", "skills/dori-mode/scripts/src/cli.ts"], ["dori-harness", "src/cli.ts"],
      ["omp", null], ["omp-cataly", null], ["omp-dori", null],
    ]) {
      const path = join(home, "bin", name), entry = stat(path);
      const consumerOwner = stat(join(home, "releases/consumer-owner.json"));
      const managedSide = !isPrimary && consumerOwner && (stat(join(home, "releases/consumer-references.json")) ||
        stat(join(home, "releases/consumer-references-pending.json")));
      const actual = entry?.isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined;
      const managedNative = name === "omp" && isPrimary && consumerOwner && actual &&
        /^[a-f0-9]{40}-[a-f0-9]{16}\/scripts\/consumer\/omp$/.test(relative(join(home, "releases/releases"), actual));
      const oldName = { cataly: "dori", "cataly-harness": "dori-harness", "omp-cataly": "omp-dori" }[name];
      const compatibility = oldName && consumerOwner && actual === join(home, "bin", oldName);
      if (entry && !managedSide && !managedNative && !compatibility && (!target || actual !== join(source, target)))
        fail(`Unmanaged wrapper at ${path}; choose another home`);
    }
    configPath = join(home, "config.json");
    configEntry = stat(configPath);
    if (configEntry) {
      if (!configEntry.isFile() || configEntry.isSymbolicLink() || configEntry.uid !== process.getuid() || (configEntry.mode & 0o022))
        fail("Unsafe preserved config: expected an owned regular file without group/world write permission");
      config = JSON.parse(readFileSync(configPath, "utf8"));
      if (!object(config)) fail("Preserved config must be an object");
    }
  };
  if (explicitHome !== undefined) selectHome(false);
  if (!atLeast(Bun.version, [1, 4, 4])) fail("Bun 1.4.4+ is required");
  if (!retire && !Bun.which("git")) fail("git is required; install it before Cataly");
  const fetchBytes = async (url, limit) => {
    const response = await fetch(url, { headers: { Accept: url.startsWith(api) ? "application/vnd.github+json" : "application/octet-stream" },
      signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      if (url === `${api}/releases/latest` && response.status === 404)
        fail("No stable Cataly release exists yet; select an explicit preview with --version vX.Y.Z");
      fail(`Anonymous release download failed (${response.status}): ${url}`);
    }
    if (!response.body) fail("Release download has no body");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.byteLength; if (size > limit) fail("Oversized release asset"); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const json = async (path) => JSON.parse((await fetchBytes(`${api}${path}`, 4 * 1024 * 1024)).toString("utf8"));
  let release;
  if (!args.values.from) {
    release = await json(version ? `/releases/tags/${encodeURIComponent(version)}` : "/releases/latest");
    if (!object(release) || release.draft !== false || typeof release.prerelease !== "boolean" ||
      !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || (version && release.tag_name !== version) ||
      (!version && release.prerelease !== false) || !Array.isArray(release.assets)) fail("Published release metadata differs");
  }
  const asset = async (name, limit) => {
    if (args.values.from) {
      const path = join(resolve(args.values.from), name);
      let parent = dirname(path);
      while (parent !== dirname(parent)) {
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) fail(`Unsafe asset directory: ${parent}`);
        parent = dirname(parent);
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail(`Unsafe asset: ${name}`);
      return readFileSync(path);
    }
    const url = `${downloads}/${release.tag_name}/${name}`;
    const matches = release.assets.filter((entry) => object(entry) && entry.name === name);
    if (matches.length !== 1 || matches[0].browser_download_url !== url) fail(`Missing canonical release asset: ${name}`);
    return fetchBytes(url, limit);
  };
  const [metadata, sumsBytes] = await Promise.all([asset("release-manifest.json", 4 * 1024 * 1024), asset("SHA256SUMS", 65536)]);
  const sums = sumsBytes.toString("utf8");
  const checksum = (name, bytes) => {
    const lines = sums.split("\n").filter((line) => line.endsWith(`  ${name}`));
    if (lines.length !== 1 || lines[0] !== `${hash(bytes)}  ${name}`) fail(`Release checksum differs: ${name}`);
  };
  checksum("release-manifest.json", metadata);
  const manifest = JSON.parse(metadata.toString("utf8"));
  if (!object(manifest) || manifest.version !== 1 || manifest.product !== "omp-dori" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.releaseVersion) ||
    manifest.tag !== `v${manifest.releaseVersion}` || (version && manifest.tag !== version) ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) || !/^[a-f0-9]{40}$/.test(manifest.tree) ||
    !object(manifest.archive) || manifest.archive.name !== `omp-dori-${manifest.tag}.tar.gz` ||
    manifest.archive.root !== `omp-dori-${manifest.releaseVersion}` || !object(manifest.source) ||
    manifest.source.version !== 1 || manifest.source.ulwPresent !== false || !Array.isArray(manifest.source.files) ||
    !manifest.source.files.length || !Array.isArray(manifest.source.excluded) ||
    (manifest.source.excluded.length && JSON.stringify(manifest.source.excluded) !== '["ref/omp-ulw"]')) fail("Invalid public release manifest");
  if (release) {
    if (manifest.tag !== release.tag_name || manifest.prerelease !== release.prerelease) fail("Published release identity differs");
    const ref = await json(`/git/ref/tags/${encodeURIComponent(manifest.tag)}`);
    let target = ref?.object;
    for (let depth = 0; target?.type === "tag" && depth < 4; depth++) {
      if (!/^[a-f0-9]{40}$/.test(target.sha)) fail("Invalid annotated tag");
      target = (await json(`/git/tags/${target.sha}`))?.object;
    }
    if (target?.type !== "commit" || target.sha !== manifest.commit) fail("Release commit differs from its published tag");
    if ((await json(`/git/commits/${manifest.commit}`))?.tree?.sha !== manifest.tree) fail("Published release tree differs");
  }
  const safe = (path) => typeof path === "string" && path.length > 0 && !/[\x00-\x20\x7f\\:]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
  const privateName = /^(?:\.git|node_modules|\.(?:omp-)?(?:cataly|dori)|\.omp|\.omo|\.cache|\.DS_Store|\.env|auth\.json|credentials\.json)$/;
  const runtimeName = /^(?:config\.json|state|sessions|auth|bin|cache|tmp|globalextensions|ref|\.qa-home|evidence)$/;
  const expected = new Map();
  for (const entry of manifest.source.files) {
    if (!object(entry) || Object.keys(entry).sort().join() !== "executable,path,sha256" || !safe(entry.path) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.executable !== "boolean" || expected.has(entry.path) ||
      runtimeName.test(entry.path.split("/")[0]) || entry.path.split("/").some((part) => privateName.test(part) ||
        /^\.env\.(?!example$|sample$)/.test(part) || /\.(?:pem|key|p12|pfx|tmp)$/.test(part))) fail("Unsafe public source entry");
    expected.set(entry.path, entry);
  }
  if (hash(JSON.stringify({ files: manifest.source.files, ulwPresent: false })) !== manifest.source.hash) fail("Source manifest hash differs");
  const archive = await asset(manifest.archive.name, max);
  checksum(manifest.archive.name, archive);
  if (archive.length !== manifest.archive.bytes || hash(archive) !== manifest.archive.sha256) fail("Release archive SHA256/size differs");
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  if (tar.length % 512) fail("Truncated tar archive");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = (bytes) => { const end = bytes.indexOf(0); if (end >= 0 && bytes.subarray(end).some((b) => b !== 0)) fail("Invalid tar text"); return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)); };
  const octal = (bytes) => { const value = bytes.toString("ascii").replace(/\0.*$/, "").trim(); if (!/^[0-7]+$/.test(value)) fail("Invalid tar number"); const n = parseInt(value, 8); if (!Number.isSafeInteger(n)) fail("Oversized tar number"); return n; };
  const directories = new Set([manifest.archive.root]);
  for (const path of expected.keys()) { let dir = dirname(`${manifest.archive.root}/${path}`); while (dir !== ".") { directories.add(dir); dir = dirname(dir); } }
  const files = [], seen = new Set(); let ended = false;
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { if (tar.length - offset < 1024 || tar.subarray(offset).some((b) => b !== 0)) fail("Invalid tar ending"); ended = true; break; }
    if (octal(header.subarray(148, 156)) !== header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0) ||
      text(header.subarray(257, 263)) !== "ustar") fail("Invalid USTAR header");
    const prefix = text(header.subarray(345, 500)); let name = `${prefix ? `${prefix}/` : ""}${text(header.subarray(0, 100))}`;
    const kind = header[156], directory = kind === 53;
    if (directory && name.endsWith("/")) name = name.slice(0, -1);
    if (!safe(name) || (name !== manifest.archive.root && !name.startsWith(`${manifest.archive.root}/`)) || seen.has(name)) fail(`Unsafe tar path: ${name}`);
    seen.add(name);
    if ((kind !== 0 && kind !== 48 && !directory) || text(header.subarray(157, 257))) fail(`Unsafe tar member type: ${name}`);
    const mode = octal(header.subarray(100, 108)), size = octal(header.subarray(124, 136)); offset += 512;
    if ((mode & ~0o777) || offset + Math.ceil(size / 512) * 512 > tar.length) fail("Unsafe/truncated tar member");
    if (directory) { if (size || !directories.has(name)) fail(`Unexpected directory: ${name}`); }
    else {
      const path = name.slice(manifest.archive.root.length + 1), entry = expected.get(path), bytes = tar.subarray(offset, offset + size);
      if (!entry || entry.executable !== ((mode & 0o111) !== 0) || hash(bytes) !== entry.sha256) fail(`Source bytes/mode differ: ${path}`);
      files.push({ path, bytes, executable: entry.executable });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || files.length !== expected.size) fail("Release archive omits manifest source");
  const terminalFile = files.find((file) => file.path === "release-capabilities.json");
  const nativeFile = files.find((file) => file.path === "release-headless.json");
  const readProfiles = (file, allowed) => {
    const profiles = new Set();
    const capabilities = JSON.parse(decoder.decode(file.bytes));
    if (!object(capabilities) || Object.keys(capabilities).sort().join() !== "profiles,version" ||
      capabilities.version !== 1 || !Array.isArray(capabilities.profiles) || !capabilities.profiles.length)
      fail("Invalid release capabilities");
    for (const entry of capabilities.profiles) {
      if (!object(entry) || Object.keys(entry).sort().join() !== "arch,platform,runtime" ||
        typeof entry.platform !== "string" || typeof entry.arch !== "string" || typeof entry.runtime !== "string")
        fail("Invalid release capability");
      const profile = `${entry.platform}/${entry.arch}/${entry.runtime}`;
      if (!allowed.includes(profile) || profiles.has(profile))
        fail("Invalid or duplicate release capability");
      profiles.add(profile);
    }
    return profiles;
  };
  const terminal = terminalFile
    ? readProfiles(terminalFile, ["linux/x64/herdr", "darwin/arm64/hc"])
    : new Set(["linux/x64/herdr"]);
  const native = nativeFile ? readProfiles(nativeFile, ["linux/x64/headless", "darwin/arm64/headless"]) : undefined;
  const native19 = (version) => typeof version === "string" && /^19\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
  const omp = manifest.requirements?.omp;
  if (native && (!terminalFile || (omp !== "18.20.0" && !native19(omp))))
    fail("Headless capability requires a bound native OMP payload and historical release profiles");
  if (retire && !native) fail("--retire-legacy-roles requires the new verified release, not the v0.1.3 archive");
  if (home === undefined) selectHome(!native);
  if (config.sessionRuntime !== undefined && !["headless", "hc", "herdr"].includes(config.sessionRuntime))
    fail("Preserved config sessionRuntime must be headless, hc or herdr");
  if (config.runtime !== undefined && !["hc", "herdr"].includes(config.runtime))
    fail("Preserved config runtime must be hc or herdr when present");
  const runtime = requested ?? config.sessionRuntime ?? (native ? "headless" : config.runtime ?? legacyRuntime);
  const profiles = runtime === "headless" && native ? native : terminal;
  if (!profiles.has(`${process.platform}/${process.arch}/${runtime}`)) fail("Release does not support selected host/runtime");
  if (!terminalFile && home !== historicalPrimary) fail("Legacy release requires the primary ~/.dori home");
  if (!native && home === currentPrimary) fail("Historical releases require their original consumer home and launcher layout");
  if (!native && configEntry) {
    if (!["hc", "herdr"].includes(config.runtime))
      fail('Preserved config must explicitly select runtime: set "runtime" to "herdr" or "hc" before retrying');
    if (config.runtime !== runtime || (config.sessionRuntime !== undefined && config.sessionRuntime !== runtime))
      fail(`Selected runtime ${runtime} conflicts with preserved config runtime ${config.runtime}`);
  }
  if (!native) {
    const path = join(home, "roles.json");
    const entry = stat(path);
    if (entry) {
      if (!entry.isFile() || entry.uid !== process.getuid() || (entry.mode & 0o022) || entry.size > 4 * 1024 * 1024)
        fail("Unsafe historical roles.json");
      const roles = JSON.parse(readFileSync(path, "utf8"));
      if (!object(roles) || Object.keys(roles).length)
        fail("Historical roles hold activation. Use the verified new install.sh --retire-legacy-roles --home PATH first; do not edit roles.json.");
    }
  }
  // Bootstrapping an old tag runs that tag's updater, which cannot enforce newer protocol retention itself.
  for (const name of ["consumer-installed.json", "consumer-journal.json"]) {
    const path = join(home, "releases", name);
    const entry = stat(path);
    if (!entry) continue;
    if (!entry.isFile() || entry.uid !== process.getuid() || (entry.mode & 0o022)) fail("Unsafe consumer release receipt");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    const selected = name === "consumer-journal.json" ? [receipt.before?.current, receipt.after?.current] : [receipt.current];
    for (const current of selected) {
      if (!current) continue;
      const installedOmp = current.requirements?.omp;
      if ((native19(installedOmp) && !native19(omp)) ||
        (installedOmp === "18.20.0" && omp === "18.18.8") ||
        (!native && current.source?.files?.some((file) => file.path === "release-headless.json")))
        fail("Install cannot downgrade the bound runtime protocol; use rollback with its required tools");
    }
  }
  if (runtime !== "headless" && !Bun.which(runtime)) fail(`${runtime} is required; install it before Cataly`);
  temporary = mkdtempSync(join(realpathSync(tmpdir()), "cataly-bootstrap-"));
  const extracted = join(temporary, "source"), dist = join(temporary, "dist");
  mkdirSync(extracted, { mode: 0o700 }); mkdirSync(dist, { mode: 0o700 });
  for (const file of files) {
    const path = join(extracted, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.bytes, { flag: "wx", mode: 0o600 }); chmodSync(path, file.executable ? 0o755 : 0o644);
  }
  writeFileSync(join(dist, "release-manifest.json"), metadata, { flag: "wx", mode: 0o600 });
  writeFileSync(join(dist, "SHA256SUMS"), sumsBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(join(dist, manifest.archive.name), archive, { flag: "wx", mode: 0o600 });
  const env = { ...process.env };
  for (const prefix of ["CATALY", "DORI"])
    for (const key of ["HOME", "CONFIG", "STATE_DIR", "RUNTIME", "CMD", "AGENT_CMD", "AGENT_ARGV", "OMP_ULW_PATH", "MANAGED_STARTUP"])
      if (!retire || key !== "STATE_DIR") delete env[`${prefix}_${key}`];
  const prefix = native ? "CATALY" : "DORI";
  env[`${prefix}_HOME`] = home;
  env[`${prefix}_CONFIG`] = configPath;
  const childArgs = [process.execPath, join(extracted, "src/release/cli.ts")];
  if (retire) {
    childArgs.push("retire-legacy-roles", "--home", home);
    for (const key of sessionFlags)
      if (args.values[key] !== undefined) childArgs.push(`--${key}`, args.values[key]);
  } else {
    childArgs.push("install", "--from", dist, "--version", manifest.tag);
    if (terminalFile) childArgs.push("--home", home, "--runtime", runtime);
  }
  const child = Bun.spawn(childArgs,
    { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  process.exitCode = await child.exited;
} catch (error) {
  console.error(`Cataly bootstrap held: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
BUN
