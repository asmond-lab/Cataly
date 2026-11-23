import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  headlessReleaseProfiles,
  nativeMetadata,
  supportsReleaseProfile,
  terminalMetadata,
} from "../src/release/capabilities.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { isReleaseVersion, releaseVersion } from "../src/release/version.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { digest, sameManifest, sourceManifest } from "../src/update/source.ts";
import { command, git } from "./release-process.ts";
import { committedSource } from "./release-source.ts";

export type Distribution = { manifest: ReleaseManifest; assets: Record<string, Buffer> };

export const nativeReleasePath = "native-bin/linux-x64/cataly";

async function buildNativeRelease(source: string, temporary: string): Promise<Buffer | undefined> {
  // The public producer is Linux x64. Other hosts can still build source-only
  // distributions (notably the historical Darwin consumer transition smoke).
  if (process.platform !== "linux" || process.arch !== "x64") return;
  const cargo = Bun.which("cargo");
  if (!cargo) throw new Error("Cargo is required to package the Linux x64 Cataly release");
  const target = "x86_64-unknown-linux-gnu";
  const targetDir = join(temporary, "cargo-target");
  const child = Bun.spawn(
    [
      cargo,
      "build",
      "--manifest-path",
      join(source, "Cargo.toml"),
      "--locked",
      "--release",
      "--bin",
      "cataly",
      "--target",
      target,
      "--target-dir",
      targetDir,
    ],
    {
      // Cargo discovers .cargo/config relative to its invocation directory, not --manifest-path.
      cwd: "/",
      // Do not load user Cargo config, RUSTFLAGS, compiler wrappers or linker settings.
      env: {
        PATH: process.env["PATH"],
        RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(homedir(), ".rustup"),
        RUSTUP_TOOLCHAIN: process.env["RUSTUP_TOOLCHAIN"],
        CARGO_HOME: join(temporary, "cargo-home"),
        CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${temporary}=/cataly`,
        CARGO_INCREMENTAL: "0",
        SOURCE_DATE_EPOCH: "0",
        LC_ALL: "C",
        TZ: "UTC",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 600_000,
      killSignal: "SIGKILL",
    },
  );
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Cargo release build failed (${code}): ${stderr.trim()}`);
  return readAsset(join(targetDir, target, "release"), "cataly");
}

function readAsset(directory: string, name: string): Buffer {
  if (!lstatSync(directory).isDirectory()) throw new Error("Distribution must be a real directory");
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Release asset must be a regular file: ${name}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Package committed blobs plus the generated legacy shims and host release binary. */
export function buildRelease(root: string, output: string, prerelease: boolean): Promise<ReleaseManifest> {
  return buildReleaseAssets(root, output, prerelease);
}

async function buildReleaseAssets(root: string, output: string, prerelease: boolean): Promise<ReleaseManifest> {
  const commit = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
  const tree = (await git(root, ["rev-parse", "--verify", `${commit}^{tree}`])).toString().trim();
  return packageReleaseTree({ root, commit, tree }, output, prerelease);
}

/** Package one immutable tree. The publishing gate still independently regenerates from actual committed HEAD. */
export async function packageReleaseTree(
  identity: { readonly root: string; readonly commit: string; readonly tree: string },
  output: string,
  prerelease: boolean,
): Promise<ReleaseManifest> {
  if (!isReleaseVersion(releaseVersion)) throw new Error("Canonical package version is not a release version");
  const { root, commit, tree } = identity;
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "cataly-release-")));
  try {
    const archiveRoot = `omp-dori-${releaseVersion}`;
    const source = join(temporary, archiveRoot);
    const committed = await committedSource(root, tree, source);
    if (lstatSync(join(source, "native-bin"), { throwIfNoEntry: false }))
      throw new Error("Committed source uses the reserved native-bin release path");
    const binary = await buildNativeRelease(source, temporary);
    if (binary) {
      const afterBuild = sourceManifest(source);
      if (!sameManifest(committed, afterBuild) || afterBuild.excluded.length !== 0)
        throw new Error("Committed source changed during the Cargo release build");
      const artifact = join(source, nativeReleasePath);
      mkdirSync(dirname(artifact), { recursive: true, mode: 0o700 });
      writeFileSync(artifact, binary, { flag: "wx" });
      chmodSync(artifact, 0o755);
    }
    // The archived v1 updater needs these paths, not a duplicate copy of the old skill or runtime.
    const legacySkill = join(source, "skills/dori-mode");
    const currentSkill = join(source, "skills/cataly-mode");
    mkdirSync(join(legacySkill, "scripts/src"), { recursive: true, mode: 0o700 });
    // An upgraded primary's old discovery link is still its skill:// root. Traversal to a sibling is not allowed.
    // Only copy read-only skill resources; all executable code goes through the one canonical CLI.
    for (const resource of ["SKILL.md", "references", "assets"])
      cpSync(join(currentSkill, resource), join(legacySkill, resource), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    const example = readFileSync(join(currentSkill, "references/config.example.json"), "utf8");
    writeFileSync(
      join(legacySkill, "references/config.example.json"),
      example.replaceAll("~/.cataly/", "~/.dori/").replaceAll('"--cataly-role"', '"--dori-role"'),
    );
    const cli = join(legacySkill, "scripts/src/cli.ts");
    writeFileSync(cli, '#!/usr/bin/env bun\nimport "../../../cataly-mode/scripts/src/cli.ts";\n', {
      flag: "wx",
      mode: 0o755,
    });
    const observed = sourceManifest(source);
    const packageData: unknown = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (
      typeof packageData !== "object" ||
      packageData === null ||
      (packageData as Record<string, unknown>)["version"] !== releaseVersion
    ) {
      throw new Error("Committed package version differs from the canonical producer version");
    }
    for (const name of [
      "LICENSE",
      "LICENSE.integration",
      "NOTICE",
      "install.sh",
      "omp-ulw.lock",
      "native-omp.lock",
      "native-omp.patch",
      "omp-ulw.overlay.lock",
      "omp-ulw.patch",
      "native-addon/package.json",
      "native-addon/bun.lock",
      "scripts/source-dependencies.ts",
      "scripts/consumer/omp",
      terminalMetadata,
      nativeMetadata,
    ]) {
      if (!observed.files.some((file) => file.path === name)) throw new Error(`Committed release is missing ${name}`);
    }
    const pin = readFileSync(join(source, "omp-ulw.lock"), "utf8").trim();
    const native = readSourceBundle(source, true);
    if (readSourceBundle(source).lock.commit !== pin) throw new Error("Committed ULW base and overlay differ");
    const paths = new Set([archiveRoot]);
    for (const file of observed.files) {
      let parent = dirname(`${archiveRoot}/${file.path}`);
      while (parent !== ".") {
        paths.add(parent);
        parent = dirname(parent);
      }
      paths.add(`${archiveRoot}/${file.path}`);
    }
    const tar = await command(
      [
        "tar",
        "--format=ustar",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mode=u=rwX,go=rX",
        "--no-recursion",
        "--hard-dereference",
        "-cf",
        "-",
        "-C",
        temporary,
        "--null",
        "-T",
        "-",
      ],
      temporary,
      `${[...paths].sort().join("\0")}\0`,
    );
    const archive = await command(["gzip", "-n", "-9", "-c"], temporary, tar);
    if (!sameManifest(observed, sourceManifest(source))) throw new Error("Source changed during release packaging");
    const manifest = validateReleaseManifest({
      version: 1,
      product: "omp-dori",
      releaseVersion,
      tag: `v${releaseVersion}`,
      commit,
      tree,
      prerelease,
      archive: {
        name: `omp-dori-v${releaseVersion}.tar.gz`,
        root: archiveRoot,
        sha256: digest(archive),
        bytes: archive.length,
      },
      source: observed,
      requirements: {
        platform: "linux",
        arch: "x64",
        bun: "1.4.4",
        omp: native.lock.nativeVersion,
        runtime: "herdr",
        messenger: "discord",
      },
      ompUlw: { repository: "https://github.com/dbc-hbin/omp-ulw.git", commit: pin },
    });
    const historical = readFileSync(join(source, terminalMetadata));
    const profiles = headlessReleaseProfiles(manifest, readFileSync(join(source, nativeMetadata)));
    for (const runtime of [manifest.requirements, { platform: "darwin", arch: "arm64", runtime: "hc" }]) {
      if (!supportsReleaseProfile(manifest, runtime, historical))
        throw new Error(
          `Release must retain the historical ${runtime.platform}/${runtime.arch}/${runtime.runtime} profile`,
        );
      if (!profiles.some((profile) => profile.platform === runtime.platform && profile.arch === runtime.arch))
        throw new Error(`Release must provide headless on ${runtime.platform}/${runtime.arch}`);
    }
    const assets: Record<string, Buffer> = {
      [manifest.archive.name]: archive,
      "install.sh": readFileSync(join(source, "install.sh")),
      "release-manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    };
    const sums = Object.keys(assets)
      .sort()
      .map((name) => `${digest(assets[name]!)}  ${name}\n`)
      .join("");
    assets["SHA256SUMS"] = Buffer.from(sums);
    mkdirSync(resolve(output), { mode: 0o700 });
    for (const [name, bytes] of Object.entries(assets)) {
      writeFileSync(join(output, name), bytes, { flag: "wx", mode: name === "install.sh" ? 0o755 : 0o644 });
    }
    return manifest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Regeneration binds every input asset to actual HEAD without extracting any untrusted distribution bytes. */
export async function verifyDistribution(root: string, directory: string): Promise<Distribution> {
  const manifest = validateReleaseManifest(JSON.parse(readAsset(directory, "release-manifest.json").toString("utf8")));
  const names = [manifest.archive.name, "install.sh", "release-manifest.json", "SHA256SUMS"];
  const assets = Object.fromEntries(names.map((name) => [name, readAsset(directory, name)]));
  const temporary = mkdtempSync(join(tmpdir(), "cataly-dist-check-"));
  try {
    const expected = await buildReleaseAssets(root, join(temporary, "dist"), manifest.prerelease);
    if (!sameManifest(manifest.source, expected.source))
      throw new Error("Distribution source is not actual committed HEAD");
    for (const name of names) {
      if (!assets[name]!.equals(readAsset(join(temporary, "dist"), name))) {
        throw new Error(`Distribution differs from actual committed HEAD: ${name}`);
      }
    }
    return { manifest, assets };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
