import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { digest } from "../src/update/source.ts";
import { snapshot } from "./consumer-smoke-inspect.ts";

/** All writes and all child selections belong to one previously nonexistent namespace. */
export function createConsumerSmokeContext(
  rawOut: string,
  tar: string,
  legacy?: { readonly runtime: string; readonly binary: string },
) {
  const out = join(realpathSync(dirname(rawOut)), basename(rawOut));
  assert(!lstatSync(out, { throwIfNoEntry: false }), "Output namespace must not exist");
  for (const name of [
    ".cataly",
    ".omp-cataly",
    ".dori",
    ".omp-dori",
    ".omp",
    ".agents",
    ".config",
    ".cache",
    ".local",
    ".bun",
  ]) {
    const path = join(homedir(), name);
    if (!existsSync(path)) continue;
    const within = relative(realpathSync(path), out);
    assert(within === ".." || within.startsWith(`..${sep}`), `Output must be outside the real ${name}`);
  }
  const home = join(out, "consumer-home");
  const side = join(home, ".omp-dori");
  const tools = join(out, "tools");
  const compilerTools = join(out, "compiler-tools");
  const terminalTools = join(out, "legacy-tools");
  const cwd = join(out, "workspace");
  const namespace = `omp-dori-${digest(side).slice(0, 12)}`;
  mkdirSync(out, { mode: 0o700 });
  for (const path of [home, tools, terminalTools, cwd, join(out, "logs"), join(out, "tmp")]) {
    mkdirSync(path, { mode: 0o700 });
  }
  const binaries = {
    bun: process.execPath,
    tar,
    git: Bun.which("git"),
    gzip: Bun.which("gzip"),
    bash: Bun.which("bash"),
  };
  for (const [name, path] of Object.entries(binaries)) {
    assert(path, `Missing prerequisite: ${name}`);
    symlinkSync(realpathSync(path), join(tools, name));
  }
  const compilerEnv =
    process.platform === "linux" && process.arch === "x64"
      ? {
          PATH: `${compilerTools}:${tools}:/usr/bin:/bin`,
          RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(homedir(), ".rustup"),
          RUSTUP_TOOLCHAIN: process.env["RUSTUP_TOOLCHAIN"],
        }
      : undefined;
  if (compilerEnv) {
    mkdirSync(compilerTools, { mode: 0o700 });
    for (const name of ["cargo", "rustc"]) {
      const path = Bun.which(name);
      assert(path, `Missing release producer prerequisite: ${name}`);
      symlinkSync(realpathSync(path), join(compilerTools, name));
    }
  }
  if (legacy) symlinkSync(legacy.binary, join(terminalTools, legacy.runtime));
  // An allowlist, not a spread: no inherited DORI/HC/HERDR/OMP selection, credentials or provider settings cross.
  const env = {
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin`,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    LC_ALL: "C",
    TZ: "UTC",
    TMPDIR: join(out, "tmp"),
    XDG_STATE_HOME: join(out, "s"),
    XDG_RUNTIME_DIR: join(out, "r"),
    XDG_CONFIG_HOME: join(out, "c"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    // Running OMP writes its session and model databases. Keep those separate from the primary discovery sentinels.
    PI_CODING_AGENT_DIR: join(out, "agent"),
    PI_CONFIG_DIR: ".omp-smoke",
    HC_SESSION: namespace,
    CATALY_HERDR_SESSION: namespace,
    CATALY_INSTALL_MODE: "side",
    CATALY_TELEMETRY: "0",
    GIT_MASTER: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  let sequence = 0;
  async function run(
    label: string,
    argv: string[],
    options: { readonly allowFailure?: boolean; readonly legacy?: boolean; readonly producer?: boolean } = {},
  ) {
    const child = Bun.spawn(argv, {
      cwd,
      env: options.legacy
        ? { ...env, PATH: `${terminalTools}:${env.PATH}`, DORI_INSTALL_MODE: "side" }
        : { ...env, ...(options.producer ? compilerEnv : undefined) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 1_200_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result = { argv, cwd, code, signal: child.signalCode, stdout, stderr };
    const log = join(out, "logs", `${++sequence}-${label}.json`);
    writeFileSync(log, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ label, argv, cwd, code, signal: child.signalCode, log }));
    assert(options.allowFailure || code === 0, `${label} failed (${code}); evidence: ${log}`);
    return result;
  }
  for (const [name, bytes] of Object.entries({
    ".dori/config.json": '{"sentinel":"primary-config"}\n',
    ".dori/releases/consumer-owner.json": '{"sentinel":"primary-owner"}\n',
    ".dori/bin/dori": "primary wrapper sentinel\n",
    ".agents/skills/dori-mode/SKILL.md": "primary discovery sentinel\n",
    ".omp/agent/extensions/primary/sentinel.txt": "primary extension sentinel\n",
  })) {
    mkdirSync(dirname(join(home, name)), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, name), bytes, { flag: "wx", mode: 0o600 });
  }
  const primaryRoots = [join(home, ".dori"), join(home, ".agents"), join(home, ".omp")];
  const primary = primaryRoots.map(snapshot);
  const unchangedPrimary = () => assert.deepEqual(primaryRoots.map(snapshot), primary, "Primary sentinel tree changed");
  writeFileSync(
    join(out, "namespace.json"),
    `${JSON.stringify({ out, home, side, namespace, env, primary }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { out, home, side, tools, env, run, unchangedPrimary };
}
