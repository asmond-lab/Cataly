import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, posix, script, setup } from "./install-setup.ts";

const cliProbe = `console.log(JSON.stringify({
  config: process.env.CATALY_CONFIG,
  namespace: process.env.HC_SESSION,
  space: process.env.CATALY_HC_SPACE,
  argv: process.argv.slice(2),
}));\n`;
const ownerConfig = '{"owner":"unrelated primary"}\n';

posix("the previous README command installs only the side checkout on an empty HOME without fetching", () => {
  const s = setup();
  for (const name of ["install-source.sh", "source-configuration.ts"]) {
    symlinkSync(join(dirname(script), name), join(s.src, "scripts", name));
  }
  const trace = join(s.root, "git-trace.jsonl");
  const result = Bun.spawnSync(
    ["bash", "-c", 'DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh'],
    {
      cwd: s.src,
      env: s.env({
        CATALY_INSTALL_MODE: undefined,
        CATALY_NO_PULL: undefined,
        CATALY_SRC: undefined,
        OMP_CATALY_HOME: undefined,
        OMP_CATALY_BIN_DIR: undefined,
        SKILLS_DIR: undefined,
        OMP_EXTENSIONS_DIR: undefined,
        GIT_ALLOW_PROTOCOL: "",
        GIT_TRACE2_EVENT: trace,
      }),
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const side = join(s.home, ".omp-cataly");
  expect(readlinkSync(join(side, "skills/omp-cataly-mode/scripts"))).toBe(join(s.src, "skills/cataly-mode/scripts"));
  expect(readlinkSync(join(s.home, ".bun/bin/omp-cataly"))).toBe(join(side, "bin/omp-cataly"));
  for (const path of [".cataly", ".dori", ".agents/skills", ".omp/agent/extensions", ".bun/bin/cataly"]) {
    expect(existsSync(join(s.home, path))).toBe(false);
  }
  const commands = existsSync(trace) ? readFileSync(trace, "utf8") : "";
  expect(commands).not.toMatch(/"name":"(?:clone|fetch|pull)"/);
});

posix("historical installer selectors install a custom side home without pulling or modifying primary", () => {
  const s = setup();
  const primaries = [join(s.home, ".cataly"), join(s.home, ".dori")];
  for (const primary of primaries) {
    mkdirSync(primary);
    writeFileSync(join(primary, "config.json"), ownerConfig);
  }
  writeFileSync(join(s.src, s.cli), cliProbe);
  git(s.src, "remote", "set-url", "origin", join(s.root, "missing.git"));
  const base = join(s.home, "historical side");
  const bin = join(s.home, "historical bin");
  mkdirSync(base);
  git(s.root, "clone", "-q", s.upstream, join(base, "src"));

  const installed = s.install({
    CATALY_INSTALL_MODE: undefined,
    CATALY_SRC: undefined,
    CATALY_NO_PULL: undefined,
    CATALY_OMP: undefined,
    OMP_CATALY_HOME: undefined,
    OMP_CATALY_BIN_DIR: undefined,
    OMP_CATALY_HC_SESSION: undefined,
    OMP_CATALY_HC_SPACE: undefined,
    DORI_INSTALL_MODE: "side",
    DORI_SRC: s.src,
    DORI_NO_PULL: "1",
    DORI_OMP: join(s.root, "bin/omp"),
    OMP_DORI_HOME: base,
    OMP_DORI_BIN_DIR: bin,
    OMP_DORI_HC_SESSION: "archived-core",
    OMP_DORI_HC_SPACE: "archived-space",
  });

  expect(installed.code, installed.err).toBe(0);
  expect(readlinkSync(join(bin, "omp-cataly"))).toBe(join(base, "bin/omp-cataly"));
  const launched = Bun.spawnSync([join(bin, "omp-cataly"), "probe"], { env: s.env() });
  expect(launched.exitCode, launched.stderr.toString()).toBe(0);
  expect(JSON.parse(launched.stdout.toString())).toEqual({
    config: join(base, "config.json"),
    namespace: "archived-core",
    space: "archived-space",
    argv: ["probe"],
  });
  for (const primary of primaries) {
    expect(readFileSync(join(primary, "config.json"), "utf8")).toBe(ownerConfig);
    expect(readdirSync(primary)).toEqual(["config.json"]);
  }
  expect(existsSync(join(s.home, ".omp-cataly"))).toBe(false);
  expect(existsSync(join(s.home, "extensions"))).toBe(false);
});

posix.each([
  { saved: "old team 'session' $(literal)", explicit: undefined, expected: "old team 'session' $(literal)" },
  { saved: "old wörkspace\t\n", explicit: undefined, expected: "old wörkspace\t\n" },
  { saved: "old terminal core", explicit: "new terminal core", expected: "new terminal core" },
])(
  "a custom marked side home keeps its old commands and selects namespace $expected",
  ({ saved, explicit, expected }) => {
    const s = setup();
    const base = join(s.home, "old side home");
    const bin = join(s.home, "global-bin");
    const sentinel = join(s.root, "old-env-ran");
    const legacyDispatch = join(base, "bin/omp-dori");
    const sideConfig = '{"owner":"side configuration"}\n';
    mkdirSync(join(base, "bin"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(base, ".omp-dori"), "side\n");
    writeFileSync(join(base, "config.json"), sideConfig, { mode: 0o600 });
    writeFileSync(join(s.src, s.cli), cliProbe);
    writeFileSync(join(s.root, "bin/hc"), '#!/bin/sh\nprintf "%s" "$HC_SESSION"\n', { mode: 0o700 });
    const previous = Bun.spawnSync(
      [
        "bash",
        "-c",
        `
      printf 'export DORI_HOME=%q\\nexport DORI_CONFIG=%q\\nexport HC_SESSION=%q\\n' "$1" "$1/config.json" "$2" > "$1/env.sh"
      printf 'printf unsafe > %q\\n' "$3" >> "$1/env.sh"
      printf '#!/usr/bin/env bash\\nset -euo pipefail\\n. %q\\nexec %q %q "$@"\\n' "$1/env.sh" "$4" "$5" > "$1/bin/dori"
      printf '#!/usr/bin/env bash\\nset -euo pipefail\\n. %q\\n' "$1/env.sh" > "$1/bin/omp-dori"
      printf 'case "\${1:-}" in\\n  omp) shift; exec %q "$@" ;;\\n  hc) shift; exec hc "$@" ;;\\n  *) exec %q "$@" ;;\\nesac\\n' \\
        "$1/bin/omp" "$1/bin/dori" >> "$1/bin/omp-dori"
      chmod 755 "$1/bin/dori" "$1/bin/omp-dori"
    `,
        "previous-source-install",
        base,
        saved,
        sentinel,
        "/old installation/bin/bun",
        join(s.src, "skills/dori-mode/scripts/src/cli.ts"),
      ],
      { env: s.env() },
    );
    expect(previous.exitCode, previous.stderr.toString()).toBe(0);
    symlinkSync(legacyDispatch, join(bin, "omp-dori"));

    const installed = s.install({
      CATALY_INSTALL_MODE: "", // The marker, not the conflicting historical mode, decides.
      CATALY_NO_PULL: "1",
      OMP_CATALY_HOME: base,
      OMP_CATALY_HC_SESSION: explicit ?? "",
      DORI_INSTALL_MODE: "primary",
      OMP_DORI_HOME: join(s.home, "unused"),
      OMP_DORI_HC_SESSION: "unused-legacy-value",
    });

    expect(installed.code, installed.err).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(readFileSync(join(base, "config.json"), "utf8")).toBe(sideConfig);
    expect(readlinkSync(join(bin, "omp-dori"))).toBe(legacyDispatch);
    const dispatchers = [join(bin, "omp-dori"), join(bin, "omp-cataly")];
    for (const command of [join(base, "bin/dori"), ...dispatchers]) {
      const launched = Bun.spawnSync([command, "hook", "literal ; $()"], { env: s.env() });
      expect(launched.exitCode, launched.stderr.toString()).toBe(0);
      expect(JSON.parse(launched.stdout.toString())).toEqual({
        config: join(base, "config.json"),
        namespace: expected,
        argv: ["hook", "literal ; $()"],
      });
    }
    for (const command of dispatchers) {
      const launched = Bun.spawnSync([command, "hc", "ls"], { env: s.env() });
      expect(launched.exitCode, launched.stderr.toString()).toBe(0);
      expect(launched.stdout.toString()).toBe(expected);
    }
  },
);

posix.each(["primary", "side"] as const)("a legacy %s reinstall preserves unrelated old-name executables", (mode) => {
  const s = setup();
  const base = join(s.home, mode === "primary" ? ".dori" : ".omp-dori");
  const bin = join(s.home, "global-bin");
  const operatorFile = "#!/bin/sh\nprintf 'operator command\\n'\n";
  mkdirSync(join(base, "bin"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(base, ".omp-dori"), `${mode}\n`);
  for (const command of [join(base, "bin/dori"), join(bin, "dori")]) {
    writeFileSync(command, operatorFile, { mode: 0o755 });
  }

  const installed = s.install({ CATALY_INSTALL_MODE: mode, CATALY_NO_PULL: "1", OMP_CATALY_HOME: "" });

  expect(installed.code, installed.err).toBe(0);
  for (const command of [join(base, "bin/dori"), join(bin, "dori")]) {
    expect(readFileSync(command, "utf8")).toBe(operatorFile);
  }
});
