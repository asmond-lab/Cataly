import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { installLegacyAliases } from "./aliases.ts";
import { prepareConsumerDiscovery } from "./discovery.ts";
import { assertNoLegacyRoleRegistrations } from "./live.ts";
import { nativeOmp } from "./provision.ts";
import {
  type ConsumerPaths,
  isPrimaryConsumer,
  owned,
  readOptionalJson,
  realDirectory,
  regularFile,
  saveJson,
  syncDirectory,
} from "./files.ts";
import {
  nextReferenceDigests,
  readReferenceReceipts,
  referenceFiles,
  referenceHash,
  type PendingReferences,
  type Reference,
  type ReferenceReceipts,
} from "./reference-receipts.ts";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const commandName = (paths: ConsumerPaths): string => (paths.layout === "cataly" ? "cataly" : "dori");

/** Generated references belong to the consumer, never to an existing source installer or its wrappers. */
export function preflightReferences(paths: ConsumerPaths): void {
  if (!isPrimaryConsumer(paths)) assertReferenceFiles(paths);
}

function assertReferenceFiles(paths: ConsumerPaths): ReferenceReceipts | undefined {
  installLegacyAliases(paths, false);
  const receipts = readReferenceReceipts(paths.root, readOptionalJson);
  if (receipts && receipts.layout !== paths.layout)
    throw new Error("Consumer reference inventory conflicts with the installation layout");
  const pending = receipts?.pending;
  const expected = pending ? nextReferenceDigests(pending) : receipts?.recorded;
  for (const path of referenceFiles(paths.layout)) {
    const destination = join(paths.cataly, path);
    if (!expected) {
      realDirectory(dirname(destination));
      if (lstatSync(destination, { throwIfNoEntry: false }))
        throw new Error(`Unmanaged installation reference: ${destination}`);
      continue;
    }
    const present = regularFile(destination);
    const allowed = pending ? [pending.before[path], expected[path]] : [expected[path]];
    if (
      (!present && !allowed.includes(undefined)) ||
      (present &&
        (!allowed.includes(referenceHash(readFileSync(destination, "utf8"))) ||
          (lstatSync(destination).mode & 0o111) !== (path.startsWith("bin/") ? 0o111 : 0)))
    )
      throw new Error(`Consumer reference changed: ${path}; preserve it before reinstalling`);
  }
  return receipts;
}

function finishReferences(paths: ConsumerPaths, pending: PendingReferences): Readonly<Record<string, string>> {
  for (const [path, ref] of Object.entries(pending.references)) {
    const destination = join(paths.cataly, path);
    realDirectory(dirname(destination), true);
    owned(dirname(destination));
    const temporary = `${destination}.consumer-${randomUUID()}`;
    writeFileSync(temporary, ref.bytes, { flag: "wx", mode: ref.executable ? 0o755 : 0o600 });
    chmodSync(temporary, ref.executable ? 0o755 : 0o600);
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
    syncDirectory(dirname(destination));
  }
  const digests = nextReferenceDigests(pending);
  saveJson(join(paths.root, "consumer-references.json"), digests);
  unlinkSync(join(paths.root, "consumer-references-pending.json"));
  syncDirectory(paths.root);
  return digests;
}

type LegacyPaths = Omit<ConsumerPaths, "cataly" | "layout">;
export function installIsolatedReferences(received: ConsumerPaths | LegacyPaths, source: string): void {
  // v0.1.3 calls the authenticated target renderer with its original paths record.
  const paths: ConsumerPaths =
    "cataly" in received ? received : { ...received, cataly: received.dori, layout: "legacy" };
  if (isPrimaryConsumer(paths)) return;
  if (!("cataly" in received)) assertNoLegacyRoleRegistrations(paths);
  const receipts = assertReferenceFiles(paths);
  const command = commandName(paths);
  const current = regularFile(join(source, "release-headless.json"));
  prepareConsumerDiscovery(paths, source);
  const before = receipts?.pending ? finishReferences(paths, receipts.pending) : (receipts?.recorded ?? {});
  const references: Record<string, Reference> = {};
  const omp = nativeOmp();
  if (!omp && !regularFile(join(source, "native-omp.lock")))
    throw new Error("The native omp command is unavailable outside Dori wrappers");
  const protocol =
    'const {readFileSync}=require("node:fs"); const {requirements,source}=JSON.parse(readFileSync(process.argv[1],"utf8")); const bound=source.files.some(({path})=>["native-omp.lock","native-omp.patch","omp-ulw.overlay.lock","omp-ulw.patch"].includes(path)); if(bound?requirements.omp!=="18.20.0"&&!/^19\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/.test(requirements.omp):requirements.omp!=="18.18.8") throw new Error("Unsupported or inconsistent consumer native protocol"); console.log(requirements.omp);';
  const legacy = omp
    ? `omp=${quote(omp)}`
    : 'echo "An independent native OMP is required for this retained release; reinstall with its toolchain" >&2; exit 1';
  const prefix = current ? "CATALY" : "DORI";
  const namespace = quote(`omp-${command}-${referenceHash(paths.cataly).slice(0, 12)}`);
  const env = [
    // References publish before the source link switches; either installed generation may consume these bindings.
    ...(current
      ? [
          'if [ "${CATALY_RUNTIME+x}" != x ] && [ "${DORI_RUNTIME+x}" = x ]; then export CATALY_RUNTIME="$DORI_RUNTIME"; fi',
        ]
      : ["unset CATALY_RUNTIME"]),
    "unset DORI_RUNTIME",
    ...["CATALY", "DORI"].flatMap((name) => [
      `unset ${["STATE_DIR", "LEAD_PANE", "HC_SPACE", "PROMPTS_DIR", "AGENT_ARGV", "OMP_ULW_PATH", "MANAGED_STARTUP"].map((key) => `${name}_${key}`).join(" ")}`,
      `export ${name}_HOME=${quote(paths.cataly)}`,
      `export ${name}_CONFIG=${quote(paths.config)}`,
      `export ${name}_AGENT_CMD=${quote(join(paths.cataly, "bin/omp"))}`,
      `export ${name}_CMD=${quote(quote(join(paths.cataly, "bin", `${command}-harness`)))}`,
    ]),
    `if [ "\${HC_SESSION:-}" != ${namespace} ]; then unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SOCKET; fi`,
    `export HC_SESSION=${namespace}`,
    `if [ "\${${prefix}_HERDR_SESSION:-\${DORI_HERDR_SESSION:-}}" != ${namespace} ]; then unset HERDR_PANE_ID HERDR_WORKSPACE_ID; fi`,
    `export CATALY_HERDR_SESSION=${namespace} DORI_HERDR_SESSION=${namespace}`,
    `export PATH=${quote(join(paths.cataly, "bin"))}:"$PATH"`,
  ].join("\n");
  // Explicit retirement must inspect the caller's unchanged state roots and terminal context, not this wrapper's.
  const retirementDispatch = (body: string): string =>
    `if [ "\${1:-}" = update ] && [ "\${2:-}" = retire-legacy-roles ]; then\n${body}\nfi\n`;
  const wrapper = (body: string, beforeBinding = ""): Reference => ({
    bytes: `#!/usr/bin/env bash\n# ${current ? "Cataly" : "OMP-Dori"} consumer wrapper\n${beforeBinding}${env}\n${body}\n`,
    executable: true,
  });
  const skill = `exec ${quote(process.execPath)} ${quote(join(paths.live, "skills", `${command}-mode`, "scripts/src/cli.ts"))} "$@"`;
  references[`bin/${command}`] = wrapper(
    skill,
    retirementDispatch(
      `if [ ! -f ${quote(join(paths.live, "release-headless.json"))} ]; then\n  echo 'Historical role retirement requires the verified new install.sh --retire-legacy-roles --home PATH' >&2\n  exit 2\nfi\n${skill}`,
    ),
  );
  references[`bin/${command}-harness`] = wrapper(
    `exec ${quote(process.execPath)} ${quote(join(paths.live, "src/cli.ts"))} "$@"`,
  );
  references["bin/omp"] = wrapper(
    `source=$(cd ${quote(paths.live)} && pwd -P) || exit\nif [ -f "$source/src/release/automatic.ts" ]; then\n  source=$(guard=$(/usr/bin/mktemp -d) || exit; trap '/bin/rmdir "$guard"' EXIT; cd "$guard" || exit; ${quote(process.execPath)} "$source/src/release/automatic.ts" "$source" "$HOME" "$$" "$@") || exit\nfi\nprotocol=$(guard=$(/usr/bin/mktemp -d) || exit; trap '/bin/rmdir "$guard"' EXIT; cd "$guard" || exit; ${quote(process.execPath)} -e ${quote(protocol)} ${quote(paths.manifests)}/"\${source##*/}".json) || exit\ncase "$protocol" in\n  18.20.0|19.*) omp="$source/scripts/consumer/omp" ;;\n  18.18.8) ${legacy} ;;\nesac\nexec "$omp" --no-extensions -e "$source/extension" --config ${quote(join(paths.cataly, "omp.yml"))} --config ${quote(join(paths.root, "consumer-discovery"))}/"\${source##*/}"/omp.yml "$@"`,
  );
  const dispatchSkill = `exec ${quote(join(paths.cataly, "bin", command))} "$@"`;
  references[`bin/omp-${command}`] = wrapper(
    `case "\${1:-}" in\n  omp) shift; exec ${quote(join(paths.cataly, "bin/omp"))} "$@" ;;\n  hc) shift; exec hc "$@" ;;\n  *) ${dispatchSkill} ;;\nesac`,
    retirementDispatch(dispatchSkill),
  );
  // OMP self-update replaces the first omp on PATH, which is bin/omp above; the replaced wrapper would drop the
  // extension and the live source selection. The managed deployment keeps the same per-process fence.
  references["omp.yml"] = {
    bytes: `skills:\n  ignoredSkills:\n    - ${current ? "cataly" : "dori"}-mode\nupdate:\n  auto: false\n`,
    executable: false,
  };
  const pending = { before, references };
  saveJson(join(paths.root, "consumer-references-pending.json"), pending);
  finishReferences(paths, pending);
  if (current) installLegacyAliases(paths);
}
