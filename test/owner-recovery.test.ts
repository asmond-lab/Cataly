import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { ownerPaths, revert, TEMPLATE } from "../src/owner.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const { mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } = fs;

const NOON = new Date(2026, 10, 20, 12, 0).getTime();

function home() {
  const w = new World();
  w.clock = NOON;
  const d = w.deps();
  const paths = ownerPaths(d.store.root);
  const cli = (...argv: string[]) => captureIo(() => main(["owner", ...argv], d));
  return { d, paths, cli };
}

describe("cataly harness owner", () => {
  test("one competing snapshot publishes the complete baseline", async () => {
    const { paths, d } = home();
    const profile = "- (2026-11-20) Synthetic baseline.\n".repeat(32_768);
    writeFileSync(paths.profile, profile);
    const program = `
      import { snapshot } from ${JSON.stringify(join(import.meta.dir, "../src/owner.ts"))};
      process.stdout.write("ready");
      await Bun.stdin.text();
      process.exit(snapshot(${JSON.stringify(d.store.root)}, ${NOON}).written ? 0 : 23);
    `;
    const writers = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "--eval", program], { stdin: "pipe", stdout: "pipe", stderr: "inherit" }),
    );
    try {
      await Promise.all(writers.map((writer) => writer.stdout.getReader().read()));
      for (const writer of writers) writer.stdin.end();
      const statuses = await Promise.all(writers.map((writer) => writer.exited));
      expect(statuses.sort((a, b) => a - b)).toEqual([0, 23, 23, 23, 23, 23]);
      expect(readdirSync(paths.history)).toEqual(["2026-11-20.md"]);
      expect(readFileSync(join(paths.history, "2026-11-20.md"), "utf8")).toBe(profile);
    } finally {
      for (const writer of writers) if (writer.exitCode === null) writer.kill();
    }
  });

  test("a revert's advertised recovery ID restores the previous bytes without overwriting its backup", async () => {
    const { paths, cli } = home();
    const original = Buffer.from("original\n");
    const changed = Buffer.from([0x78, 0x80, 0x0a]);
    writeFileSync(paths.profile, original);
    await cli("snapshot");
    writeFileSync(paths.profile, changed);

    const first = (await cli("revert", "2026-11-20")).out;
    const id = /undo with cataly harness owner revert (\S+)$/.exec(first)![1]!;
    const backup = join(paths.history, `${id}.md`);
    const second = (await cli("revert", id)).out;
    const secondId = /undo with cataly harness owner revert (\S+)$/.exec(second)![1]!;

    expect(readFileSync(paths.profile)).toEqual(changed);
    expect(secondId).not.toBe(id);
    expect(readFileSync(backup)).toEqual(changed);
    expect(readFileSync(join(paths.history, `${secondId}.md`))).toEqual(original);
    await cli("revert", `${id}.md`);
    expect(readFileSync(paths.profile)).toEqual(changed);
    expect(await cli("diff")).toMatchObject({ code: 0, out: expect.stringContaining("DIFF 2026-11-20") });
  });

  test("restoring without a current profile reports that no backup was made", async () => {
    const { paths, cli } = home();
    writeFileSync(paths.profile, TEMPLATE);
    await cli("snapshot");
    renameSync(paths.profile, join(paths.history, "absent-profile-fixture"));

    const { code, out } = await cli("revert", "2026-11-20");

    expect(code).toBe(0);
    expect(out).toContain("No previous owner profile to back up.");
    expect(out).not.toContain("Backup saved at");
    expect(readFileSync(paths.profile, "utf8")).toBe(TEMPLATE);
    expect(readdirSync(paths.history).sort()).toEqual(["2026-11-20.md", "absent-profile-fixture"]);
  });

  test("revert rejects traversal and symlinks without changing the profile or recovery area", async () => {
    const { paths, d, cli } = home();
    const outside = join(d.store.root, "outside-history");
    mkdirSync(outside);
    const name = "pre-revert-2026-11-20T12-00-00-000Z.md";
    const target = join(outside, name);
    writeFileSync(target, "outside bytes\n");
    writeFileSync(paths.profile, TEMPLATE);
    mkdirSync(paths.history);
    symlinkSync(target, join(paths.history, name));

    for (const selector of [`../outside-history/${name}`, target, `..\\${name}`])
      await expect(cli("revert", selector)).rejects.toThrow("expects YYYY-MM-DD or a pre-revert backup");
    await expect(cli("revert", name)).rejects.toThrow("is not a regular file");
    renameSync(paths.history, `${paths.history}-original`);
    symlinkSync(outside, paths.history);
    await expect(cli("revert", name)).rejects.toThrow("is not a regular directory");

    expect(readFileSync(paths.profile, "utf8")).toBe(TEMPLATE);
    expect(readFileSync(target, "utf8")).toBe("outside bytes\n");
    expect(readdirSync(outside)).toEqual([name]);
  });

  test.each(["directory", "dangling link"] as const)("snapshot rejects an existing %s", async (kind) => {
    const { paths, cli } = home();
    writeFileSync(paths.profile, TEMPLATE);
    mkdirSync(paths.history);
    const baseline = join(paths.history, "2026-11-20.md");
    if (kind === "directory") mkdirSync(baseline);
    else symlinkSync("missing-profile", baseline);

    await expect(cli("snapshot")).rejects.toThrow("is not a regular snapshot file");
    expect(readdirSync(paths.history)).toEqual(["2026-11-20.md"]);
  });

  test("snapshot rejects a nonregular entry that wins the publication race", async () => {
    const { paths, cli } = home();
    writeFileSync(paths.profile, TEMPLATE);
    const baseline = join(paths.history, "2026-11-20.md");
    const linkSync = fs.linkSync;
    const competingWriter = spyOn(fs, "linkSync").mockImplementation((source, dest) => {
      if (dest === baseline) mkdirSync(baseline);
      linkSync(source, dest);
    });
    try {
      await expect(cli("snapshot")).rejects.toThrow("is not a regular snapshot file");
    } finally {
      competingWriter.mockRestore();
    }
    expect(readdirSync(paths.history)).toEqual(["2026-11-20.md"]);
    expect(fs.lstatSync(baseline).isDirectory()).toBe(true);
  });

  test("an overlapping revert backs up nothing until the first revert finishes", async () => {
    const { paths, d, cli } = home();
    writeFileSync(paths.profile, "first snapshot\n");
    await cli("snapshot");
    writeFileSync(join(paths.history, "2026-11-19.md"), "second snapshot\n");
    writeFileSync(paths.profile, "original profile\n");

    let attempted = false;
    const replace = spyOn(fs, "renameSync").mockImplementation((source, dest) => {
      if (dest === paths.profile && !attempted) {
        attempted = true;
        expect(() => revert(d.store.root, "2026-11-19", NOON)).toThrow("owner revert is already in progress");
      }
      renameSync(source, dest);
    });
    try {
      expect((await cli("revert", "2026-11-20")).code).toBe(0);
    } finally {
      replace.mockRestore();
    }
    expect(attempted).toBe(true);
    expect(readFileSync(paths.profile, "utf8")).toBe("first snapshot\n");
    expect(readdirSync(paths.history).filter((name) => name.startsWith("pre-revert-"))).toHaveLength(1);

    const next = (await cli("revert", "2026-11-19")).out;
    const id = /undo with cataly harness owner revert (\S+)$/.exec(next)![1]!;
    expect(readFileSync(join(paths.history, `${id}.md`), "utf8")).toBe("first snapshot\n");
    expect(readFileSync(paths.profile, "utf8")).toBe("second snapshot\n");
  });

  test("revert leaves an old unrecognized lock and the current profile untouched", async () => {
    const { paths, cli } = home();
    writeFileSync(paths.profile, TEMPLATE);
    await cli("snapshot");
    writeFileSync(paths.profile, "changed profile\n");
    const lock = join(paths.history, ".owner-revert.lock");
    writeFileSync(lock, "unrecognized holder\n");
    utimesSync(lock, 0, 0);

    await expect(cli("revert", "2026-11-20")).rejects.toThrow("its lock needs inspection");
    expect(readFileSync(lock, "utf8")).toBe("unrecognized holder\n");
    expect(readFileSync(paths.profile, "utf8")).toBe("changed profile\n");
    expect(readdirSync(paths.history).sort()).toEqual([".owner-revert.lock", "2026-11-20.md"]);
  });
});
