import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractArchive, readArchive } from "../src/release/archive.ts";
import { saveJson } from "../src/release/files.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { digest, sourceManifest } from "../src/update/source.ts";
import { archive, type ConsumerFixture, withArchive } from "./release-consumer-setup.ts";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

export function bundledRelease(
  f: ConsumerFixture,
  selected: string,
  nativeSource?: string,
  nativeVersion = "18.20.0",
  headless = false,
) {
  const original = f.release(selected);
  const source = join(f.root, `bundled-${selected}`);
  extractArchive(original.bundle.files, original.bundle.manifest, source);
  const ulw = overlayFixture(source, join(f.root, `ulw-${selected}`), false, selected);
  if (nativeSource) {
    mkdirSync(join(source, "native-addon"), { mode: 0o700 });
    for (const path of ["native-omp.lock", "native-omp.patch", "native-addon/package.json", "native-addon/bun.lock"])
      copyFileSync(join(nativeSource, path), join(source, path));
  } else {
    const native = overlayFixture(source, join(f.root, `native-${selected}`), true, "reviewed-overlay", nativeVersion);
    nativeCacheFixture(source, f.paths.home, native.checkout);
  }
  mkdirSync(join(source, "scripts/consumer"), { recursive: true, mode: 0o700 });
  // Real helper bytes are carried; addon loading remains a separate real isolated installation gate.
  copyFileSync(
    resolve(import.meta.dir, "../scripts/source-dependencies.ts"),
    join(source, "scripts/source-dependencies.ts"),
  );
  copyFileSync(resolve(import.meta.dir, "../scripts/consumer/omp"), join(source, "scripts/consumer/omp"));
  chmodSync(join(source, "scripts/consumer/omp"), 0o755);
  if (headless) {
    for (const path of ["release-capabilities.json", "release-headless.json"])
      copyFileSync(resolve(import.meta.dir, "..", path), join(source, path));
  }
  const publicSource = sourceManifest(source);
  const bytes = archive(
    publicSource.files.map((file) => ({
      name: `${original.bundle.manifest.archive.root}/${file.path}`,
      bytes: readFileSync(join(source, file.path)),
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive(
    validateReleaseManifest({
      ...original.bundle.manifest,
      source: publicSource,
      requirements: {
        ...original.bundle.manifest.requirements,
        omp: readSourceBundle(source, true).lock.nativeVersion,
      },
      ompUlw: { repository: ulw.lock.repository, commit: ulw.commit },
    }),
    bytes,
  );
  const bundle = readSourceBundle(source);
  const dependency = join(f.paths.dependencies, `omp-ulw-${ulw.commit}-${bundle.identity}`);
  renameSync(ulw.checkout, dependency);
  saveJson(`${dependency}.json`, {
    version: 1,
    repository: ulw.lock.repository,
    commit: ulw.commit,
    identity: bundle.identity,
  });
  const metadata = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(original.dist, manifest.archive.name), bytes);
  writeFileSync(join(original.dist, "release-manifest.json"), metadata);
  writeFileSync(
    join(original.dist, "SHA256SUMS"),
    `${digest(bytes)}  ${manifest.archive.name}\n${digest(metadata)}  release-manifest.json\n`,
  );
  return { source, dependency, dist: original.dist, bundle: { manifest, files: readArchive(bytes, manifest) } };
}
