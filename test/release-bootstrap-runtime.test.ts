import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { darwin, fixture, linux } from "./release-bootstrap-setup.ts";

// POSIX-only: the fixture runs install.sh under bash with shebang runtime stubs.
const posix = test.skipIf(process.platform === "win32");

posix.each(["{}", '{"runtime":"hc"}'])(
  "legacy bootstrap holds unbound or conflicting preserved runtime %s before its old CLI can activate",
  (preserved) => {
    const f = fixture(linux);
    f.assets();
    const home = join(f.home, ".dori"),
      config = join(home, "config.json");
    mkdirSync(home);
    writeFileSync(config, preserved);
    const choice = () => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
const {loadConfig} = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/config.ts"))});
const {runtimeChoice} = await import(${JSON.stringify(resolve(import.meta.dir, "../skills/cataly-mode/scripts/src/run.ts"))});
console.log(JSON.stringify(runtimeChoice(await loadConfig(), process.env)));`,
        ],
        {
          env: { HOME: f.home, DORI_HOME: home, DORI_CONFIG: config, PATH: join(f.root, "bin") },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(choice()).toEqual({ kind: "headless", source: "default" });
    const held = f.run(["--runtime", "herdr"]);
    expect(held.exitCode).not.toBe(0);
    expect(held.stderr.toString()).toContain(
      preserved === "{}"
        ? "Preserved config must explicitly select runtime"
        : "conflicts with preserved config runtime",
    );
    expect(readFileSync(config, "utf8")).toBe(preserved);
    expect(existsSync(f.result)).toBe(false);
    expect(existsSync(join(home, "legacy-installed"))).toBe(false);
    const selected = '{"runtime":"herdr","ownerValue":"preserved"}';
    writeFileSync(config, selected);
    const installed = f.run(["--runtime", "herdr"]);
    expect(installed.exitCode, installed.stderr.toString()).toBe(0);
    expect(choice()).toEqual({ kind: "headless", source: "default" });
    expect(readFileSync(config, "utf8")).toBe(selected);
  },
);

posix.each([
  [linux, ".dori", "18.20.0"],
  [darwin, ".omp-dori", "18.20.0"],
  [linux, ".dori", "19.0.1"],
  [darwin, ".omp-dori", "19.0.1"],
] as const)(
  "headless bootstrap accepts historical config without either executable: %j, %s, OMP %s",
  (profile, folder, version) => {
    const f = fixture(profile);
    f.assets(
      { version: 1, profiles: [linux, darwin] },
      { version: 1, profiles: [linux, darwin].map((host) => ({ ...host, runtime: "headless" })) },
      version,
    );
    const home = join(f.home, folder);
    mkdirSync(home);
    const config = join(home, "config.json");
    const old = `{"runtime":"${profile.runtime}","ownerValue":"keep"}\n`;
    writeFileSync(config, old);
    const bin = join(f.root, "bin");
    for (const tool of ["hc", "herdr"]) renameSync(join(bin, tool), join(f.root, tool));
    const fresh = f.run([], { PATH: `${bin}:/usr/bin:/bin` });
    expect(fresh.exitCode, fresh.stderr.toString()).toBe(0);
    expect(f.selected()).toEqual(f.expected(join(f.home, folder === ".dori" ? ".cataly" : ".omp-cataly"), "headless"));
    const result = f.run(["--home", home], { PATH: `${bin}:/usr/bin:/bin` });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(f.selected()).toEqual(f.expected(home, "headless"));
    expect(readFileSync(config, "utf8")).toBe(old);
    const explicit = f.run(["--runtime", profile.runtime], { PATH: `${bin}:/usr/bin:/bin` });
    expect(explicit.exitCode).not.toBe(0);
    expect(explicit.stderr.toString()).toContain(`${profile.runtime} is required`);
  },
);

posix("bootstrap permits an OMP 18-to-19 upgrade but holds a pre-19 install over a 19 receipt", () => {
  const f = fixture(linux);
  const home = join(f.home, ".dori");
  const releases = join(home, "releases");
  mkdirSync(releases, { recursive: true });
  const receipt = join(releases, "consumer-installed.json");
  const state = (omp: string) => JSON.stringify({ current: { requirements: { omp } } });
  const terminal = { version: 1, profiles: [linux] };
  const headless = { version: 1, profiles: [{ ...linux, runtime: "headless" }] };
  writeFileSync(receipt, state("18.20.0"));
  f.assets(terminal, headless, "19.0.1");
  const upgraded = f.run(["--home", home]);
  expect(upgraded.exitCode, upgraded.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual(f.expected(home, "headless"));
  const selected = state("19.0.1");
  writeFileSync(receipt, selected);
  f.assets(terminal, headless, "18.20.0");
  const held = f.run(["--home", home]);
  expect(held.exitCode).not.toBe(0);
  expect(held.stderr.toString()).toContain("cannot downgrade");
  expect(readFileSync(receipt, "utf8")).toBe(selected);
});

posix.each(["18.18.8", "19.0.1-rc.1", "20.0.0"])("headless bootstrap refuses unsupported OMP %s", (version) => {
  const f = fixture(linux);
  f.assets({ version: 1, profiles: [linux] }, { version: 1, profiles: [{ ...linux, runtime: "headless" }] }, version);
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Headless capability requires a bound native OMP payload");
  expect(existsSync(f.result)).toBe(false);
});

posix("bootstrap retirement dispatches the verified new CLI without installation or terminal prerequisites", () => {
  const f = fixture(linux);
  const home = join(f.home, ".dori");
  const args = [
    "--retire-legacy-roles",
    "--home",
    home,
    "--legacy-session",
    "original",
    "--legacy-migrated-session",
    "migration",
  ];
  const old = f.run(args);
  expect(old.exitCode).not.toBe(0);
  expect(old.stderr.toString()).toContain("requires the new verified release");
  expect(existsSync(f.result)).toBe(false);
  f.assets({ version: 1, profiles: [linux] }, { version: 1, profiles: [{ ...linux, runtime: "headless" }] });
  const bin = join(f.root, "bin");
  for (const tool of ["hc", "herdr"]) renameSync(join(bin, tool), join(f.root, tool));
  const historicalState = join(home, "historical-state");
  const retirement = f.run(args, { PATH: `${bin}:/usr/bin:/bin`, DORI_STATE_DIR: historicalState });
  expect(retirement.exitCode, retirement.stderr.toString()).toBe(0);
  expect(f.selected()).toEqual({
    command: "retire-legacy-roles",
    home,
    "legacy-session": "original",
    "legacy-migrated-session": "migration",
    historicalState,
  });
  expect(existsSync(home)).toBe(false);
});

posix("ordinary bootstrap does not hand a home with historical roles to an old updater", () => {
  const f = fixture(linux);
  f.assets();
  const home = join(f.home, ".dori");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), '{"runtime":"herdr"}\n');
  const roles = join(home, "roles.json");
  const original = '{"lead":"w1:p1"}\n';
  writeFileSync(roles, original);
  const result = f.run(["--home", home, "--runtime", "herdr"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("--retire-legacy-roles");
  expect(readFileSync(roles, "utf8")).toBe(original);
  expect(existsSync(join(home, "legacy-installed"))).toBe(false);
});
