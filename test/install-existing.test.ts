import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, script, setup } from "./install-setup.ts";

// POSIX-only: the fixture runs scripts/install-source.sh and shebang stubs through a ':' PATH.
const posix = test.skipIf(process.platform === "win32");

// Re-runs over installs made before the marker: none of these may ask, back up or stop.

posix("an omp-cataly checkout in ~/.cataly/src is known by its files, whatever its remote is called", () => {
  // Given the documented layout, cloned from a remote whose name is not omp-cataly.
  const { root, home, install } = setup();
  mkdirSync(join(home, ".cataly"));
  git(root, "clone", "-q", join(root, "upstream"), join(home, ".cataly/src"));
  writeFileSync(join(home, ".cataly/config.json"), "{}\n");
  // When scripts/install-source.sh runs with no mode, no terminal and no CATALY_SRC.
  const r = install({ CATALY_SRC: "" });
  // Then it updates in place: no question, no backup, and the marker records a primary install.
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("another Cataly");
  expect(existsSync(join(home, ".cataly/backups"))).toBe(false);
  expect(readFileSync(join(home, ".cataly/.omp-cataly"), "utf8")).toBe("primary\n");
});

posix("a ~/.cataly that only holds omp-ulw or state is not another Cataly", () => {
  // Given a ~/.cataly with an earlier omp-ulw checkout and a state directory, but no config and no src.
  const { home, install } = setup();
  mkdirSync(join(home, ".cataly/omp-ulw"), { recursive: true });
  mkdirSync(join(home, ".cataly/state"));
  // When scripts/install-source.sh runs with no mode and no terminal.
  const r = install();
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, ".cataly/.omp-cataly"), "utf8")).toBe("primary\n");
  expect(existsSync(join(home, ".omp-cataly"))).toBe(false);
});

posix("the historical primary source checkout upgrades in place without rewriting its owner configuration", () => {
  const s = setup();
  const base = join(s.home, ".dori");
  const checkout = join(base, "src");
  mkdirSync(join(base, "state"), { recursive: true });
  git(s.upstream, "mv", "skills/cataly-mode", "skills/dori-mode");
  git(s.upstream, "commit", "-qm", "historical source skill layout");
  git(s.root, "clone", "-q", s.upstream, checkout);
  git(s.upstream, "mv", "skills/dori-mode", "skills/cataly-mode");
  writeFileSync(join(s.upstream, s.cli), "console.log(process.env.CATALY_CONFIG, process.argv[2]);\n");
  git(s.upstream, "commit", "-qam", "current source skill layout");
  const original = `${JSON.stringify({
    runtime: "herdr",
    agentCommand: [join(base, "bin/omp"), "--dori-role", "lane", "--model", "{model}", "{prompt}"],
    stateDir: "~/.dori/state",
    ompUlwPath: "",
    owner: { dori: "retained", duty: "retained" },
  })}\n`;
  writeFileSync(join(base, "config.json"), original, { mode: 0o600 });
  writeFileSync(join(base, ".omp-dori"), "primary\n");
  writeFileSync(join(base, "state/owner-data"), "retained\n");
  for (const directory of ["extensions", "global-bin"]) mkdirSync(join(s.home, directory));
  const oldExtension = join(s.home, "extensions/omp-dori");
  const oldCommand = join(s.home, "global-bin/dori");
  symlinkSync(join(checkout, "extension"), oldExtension);
  symlinkSync(join(checkout, "skills/dori-mode/scripts/src/cli.ts"), oldCommand);
  mkdirSync(join(base, "bin"));
  const oldHomeCommand = join(base, "bin/dori");
  symlinkSync(join(checkout, "skills/dori-mode/scripts/src/cli.ts"), oldHomeCommand);

  const upgraded = s.install({ CATALY_SRC: "" });

  expect(upgraded.code, upgraded.err).toBe(0);
  expect(git(checkout, "rev-parse", "HEAD")).toBe(git(s.upstream, "rev-parse", "HEAD"));
  expect(readFileSync(join(base, "config.json"), "utf8")).toBe(original);
  expect(readFileSync(join(base, ".omp-dori"), "utf8")).toBe("primary\n");
  expect(readFileSync(join(base, ".omp-cataly"), "utf8")).toBe("primary\n");
  expect(readFileSync(join(base, "state/owner-data"), "utf8")).toBe("retained\n");
  expect(readlinkSync(join(s.home, "global-bin/cataly"))).toBe(join(base, "bin/cataly"));
  expect(readFileSync(join(base, "bin/cataly"), "utf8")).toContain(`export CATALY_HOME=${base}`);
  for (const command of [oldCommand, oldHomeCommand, join(s.home, "global-bin/cataly")]) {
    const launched = Bun.spawnSync([command, "hook-probe"], { env: s.env() });
    expect(launched.exitCode, launched.stderr.toString()).toBe(0);
    expect(launched.stdout.toString()).toBe(`${join(base, "config.json")} hook-probe\n`);
  }
  expect(upgraded.out).toContain(`"selectedConfig":"${join(base, "config.json")}"`);
  expect(existsSync(oldExtension)).toBe(false);
  const backups = readdirSync(join(base, "backups"));
  expect(backups).toHaveLength(1);
  expect(readlinkSync(join(base, "backups", backups[0]!, "omp-dori"))).toBe(join(checkout, "extension"));
  expect(readlinkSync(join(s.home, "extensions/omp-cataly"))).toBe(join(checkout, "extension"));
  expect(existsSync(join(s.home, ".cataly"))).toBe(false);
});

posix("a legacy extension alone does not adopt an unrelated historical configuration", () => {
  const s = setup();
  const unrelated = join(s.home, ".dori");
  mkdirSync(unrelated);
  mkdirSync(join(s.home, "extensions"));
  const extension = join(s.home, "extensions/omp-dori");
  symlinkSync(join(s.src, "extension"), extension);
  const config = '{"owner":"another installation"}\n';
  writeFileSync(join(unrelated, "config.json"), config);

  const installed = s.install();

  expect(installed.code, installed.err).toBe(0);
  expect(readFileSync(join(unrelated, "config.json"), "utf8")).toBe(config);
  expect(readdirSync(unrelated)).toEqual(["config.json"]);
  expect(readlinkSync(extension)).toBe(join(s.src, "extension"));
  expect(readFileSync(join(s.home, ".cataly/.omp-cataly"), "utf8")).toBe("primary\n");
});

posix(
  "a side upgrade keeps the old terminal preference but selects headless through the regenerated environment",
  () => {
    const s = setup();
    const base = join(s.home, ".omp-dori");
    mkdirSync(join(base, "skills/omp-dori-mode"), { recursive: true });
    writeFileSync(join(base, ".omp-dori"), "side\n");
    writeFileSync(join(base, "env.sh"), "export DORI_RUNTIME=herdr\n");
    writeFileSync(join(base, "skills/omp-dori-mode/owner-note"), "keep\n");
    const configPath = join(base, "config.json");
    const original = `${JSON.stringify({
      runtime: "herdr",
      agentCommand: [join(base, "bin/omp"), "--dori-role", "lane", "{prompt}"],
      ompUlwPath: "",
      customSetting: { keep: true },
    })}\n`;
    writeFileSync(configPath, original, { mode: 0o600 });
    const selector = resolve(import.meta.dir, "../src/runtime/select.ts");
    const reader = resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/config.ts");
    const probe = `
import { readRuntimeChoice } from ${JSON.stringify(selector)};
import { loadConfig } from ${JSON.stringify(reader)};
const configPath = process.env.CATALY_CONFIG;
console.log(JSON.stringify({
  runtime: readRuntimeChoice({ env: process.env, configPath }),
  agentCommand: (await loadConfig(configPath)).agentCommand,
  namespace: process.env.HC_SESSION,
}));
`;
    const select = (extra: Record<string, string> = {}) =>
      Bun.spawnSync(
        [
          "bash",
          "-c",
          '. "$1"; shift; exec "$@"',
          "setup-runtime",
          join(base, "env.sh"),
          process.execPath,
          "--no-env-file",
          "-e",
          probe,
        ],
        { env: s.env({ HERDR_PANE_ID: "earlier-terminal", ...extra }) },
      );

    const upgraded = s.install({ CATALY_NO_PULL: "1", OMP_CATALY_HOME: "" });

    expect(upgraded.code, upgraded.err).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readFileSync(join(base, "skills/omp-dori-mode/owner-note"), "utf8")).toBe("keep\n");
    expect(readlinkSync(join(s.home, "global-bin/omp-cataly"))).toBe(join(base, "bin/omp-cataly"));
    expect(Bun.YAML.parse(readFileSync(join(base, "omp.yml"), "utf8"))).toMatchObject({
      skills: { ignoredSkills: ["cataly-mode", "omp-dori-mode"] },
    });
    expect(existsSync(join(s.home, ".omp-cataly"))).toBe(false);
    const defaultRuntime = select();
    expect(defaultRuntime.exitCode, defaultRuntime.stderr.toString()).toBe(0);
    expect(JSON.parse(defaultRuntime.stdout.toString())).toEqual({
      runtime: { kind: "headless", source: "default" },
      agentCommand: [join(base, "bin/omp"), "--cataly-role", "lane", "{prompt}"],
      namespace: "omp-dori",
    });
    const overriddenRuntime = select({ CATALY_RUNTIME: "hc" });
    expect(overriddenRuntime.exitCode, overriddenRuntime.stderr.toString()).toBe(0);
    expect(JSON.parse(overriddenRuntime.stdout.toString()).runtime).toEqual({ kind: "hc", source: "env" });
  },
);

posix("a failed pull over another Cataly leaves no backup behind", () => {
  // Given another Cataly's ~/.cataly and a checkout whose upstream cannot be reached.
  const { root, home, src, install } = setup();
  mkdirSync(join(home, ".cataly"));
  writeFileSync(join(home, ".cataly/config.json"), "{}\n");
  git(src, "remote", "set-url", "origin", join(root, "missing.git"));
  // When scripts/install-source.sh runs as primary; then it stops at the pull with no backups directory.
  const r = install({ CATALY_INSTALL_MODE: "primary" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("missing.git");
  expect(existsSync(join(home, ".cataly/backups"))).toBe(false);
});

posix("closing the terminal question stops with a reason and changes nothing", async () => {
  // Given another Cataly's ~/.cataly and the source installer in a terminal with no mode.
  const { home, env } = setup();
  mkdirSync(join(home, ".cataly"));
  writeFileSync(join(home, ".cataly/config.json"), "{}\n");
  mkdirSync(join(home, "skills"));
  symlinkSync("/elsewhere/cataly-mode", join(home, "skills/cataly-mode"));
  let screen = "";
  let closed = false;
  const proc = Bun.spawn([script], {
    env: env(),
    timeout: 60_000,
    terminal: {
      cols: 120,
      rows: 40,
      data(term, chunk) {
        screen += new TextDecoder().decode(chunk);
        // When the question appears, the owner sends end-of-file instead of an answer.
        if (!closed && screen.includes("Install as 1 or 2")) {
          closed = true;
          term.write("\x04");
        }
      },
    },
  });
  // Then the install says so and leaves the other Cataly, its skill link and the side home untouched.
  expect(await proc.exited).toBe(1);
  expect(screen).toContain("no answer; nothing was changed");
  expect(readFileSync(join(home, ".cataly/config.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(home, ".cataly/.omp-cataly"))).toBe(false);
  expect(existsSync(join(home, ".omp-cataly"))).toBe(false);
});
