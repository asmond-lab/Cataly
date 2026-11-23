import { expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run, type Runner } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;

const layouts = ["direct", "cwd symlink", "state symlink", "literal mode", "cwd symlink parent"];
test.each(layouts)("freshness preserves tracked Git activity but not its writer lock (%s)", async (layout) => {
  const fixture = withState();
  try {
    const repo = join(fixture.dir, "worktree");
    mkdirSync(repo);
    const throughParent = layout === "cwd symlink parent";
    const actualState = join(repo, "cataly-state");
    const alias = join(fixture.dir, "alias");
    if (layout === "cwd symlink") symlinkSync(repo, alias, "dir");
    if (layout === "state symlink") symlinkSync(actualState, alias, "dir");
    // Win32 applies `..` before following the link; Unix follows the link first. Keep the raw spelling on both.
    const lexicalParentOnWindows = throughParent && process.platform === "win32";
    // Keep the Windows cwd below the worktree root but beside the writer subtree, so it must probe the Git root.
    const linkParent = lexicalParentOnWindows ? join(repo, "lane-cwd") : fixture.dir;
    const link = join(linkParent, "link");
    if (throughParent) {
      const subdir = join(lexicalParentOnWindows ? fixture.dir : repo, "subdir");
      if (lexicalParentOnWindows) mkdirSync(linkParent);
      mkdirSync(subdir);
      symlinkSync(subdir, link, "dir");
      if (!lexicalParentOnWindows) symlinkSync(actualState, join(fixture.dir, "cataly-state"), "dir");
    }
    const stateDir = layout === "state symlink" ? alias : actualState;
    const key = "git-lock-lane";
    const lanePath = `cataly-state/lanes/${key}`;
    const trackedPath = lexicalParentOnWindows ? "lane-cwd/tracked.txt" : `${lanePath}/tracked.txt`;
    const git = async (...args: string[]) => {
      const result = await run(["git", "-C", repo, ...args]);
      if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}`);
    };
    await git("init", "--quiet");
    const emptyExcludes = join(fixture.dir, "empty-excludes");
    writeFileSync(emptyExcludes, "");
    await git("config", "core.excludesFile", emptyExcludes);
    mkdirSync(join(repo, lanePath), { recursive: true });
    // Keep the user change in the lane cwd even when Windows resolves the alias parent beside the state directory.
    writeFileSync(join(repo, trackedPath), "initial\n");
    writeFileSync(
      join(repo, ".gitignore"),
      [
        `/cataly-state/lanes/${key}.json`,
        `/${lanePath}/reports.jsonl`,
        `/${lanePath}/supervision.json`,
        ...(lexicalParentOnWindows ? ["/lane-cwd/link"] : []),
        "",
      ].join("\n"),
    );
    await git("add", "--", ".gitignore", trackedPath);
    await git(
      "-c",
      "user.name=Cataly Fixture",
      "-c",
      "user.email=cataly@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "Seed lane",
    );

    const clock = fakeClock(T0);
    const world = newWorld();
    const cwd = throughParent ? `${link}/..` : layout === "cwd symlink" ? alias : repo;
    const lane: Lane = {
      key,
      title: "Git writer lock",
      thread: "none",
      pane: "w:p1",
      brief: "/b.md",
      done: "",
      openedAt: new Date(T0).toISOString(),
      reportProtocol: "jsonl-v1",
      cwd,
    };
    if (throughParent) {
      const root = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { preserveOutput: true });
      expect(root.code, root.err).toBe(0);
      expect(realpathSync.native(root.out.replace(/\r?\n$/, ""))).toBe(realpathSync.native(repo));
    }
    world.panes = [{ pane_id: "w:p1", workspace_id: "w", agent: "omo", agent_status: "working" }];
    const deps = depsFor(world, clock, stateDir, {
      nudgeAfterMin: 999,
      postAfterMin: 999,
      supervision: { hungAfterMinutes: 20, staleAfterMinutes: 20 },
    });
    const reports = new Reports(stateDir);
    await deps.registry.write(lane);
    reports.report(key, "milestone", "started", T0);

    const statuses: string[][] = [];
    const sample: Runner = async (argv, opts) => {
      if (argv[0] !== "git") return deps.run(argv, opts);
      const env = layout === "literal mode" ? { GIT_LITERAL_PATHSPECS: "1", ...opts?.env } : opts?.env;
      const result = await run(argv, env ? { ...opts, env } : opts);
      if (!argv.includes("status")) return result;
      if (result.code !== 0) throw new Error(`git status: ${result.err}`);
      const entries = result.out.split("\0");
      if (throughParent) {
        // Sample the same native worktree with no pathspec while the sweep owns its writer lock.
        const unfiltered = await run([...argv.slice(0, 6), "--untracked-files=all"], opts);
        const writer = /^\?\? cataly-state\/lanes\/\.supervision-writers\/[^/]+\.lock$/;
        expect(unfiltered.code, unfiltered.err).toBe(0);
        expect(unfiltered.out.split("\0").filter((row) => writer.test(row))).toHaveLength(1);
        expect(entries.some((row) => writer.test(row))).toBe(false);
      }
      statuses.push(entries);
      for (const entry of entries) {
        const path = entry.slice(3);
        const oldLock =
          path.startsWith(`${lanePath}/`) &&
          /^supervision\.json\.[a-f0-9]{64}\.lock$/.test(path.slice(lanePath.length + 1));
        if (entry.startsWith("?? ") && (oldLock || path === "cataly-state/lanes/.supervision-writers/")) {
          // Give any reported writer artifact distinct mtimes, without replacing real Git output.
          const stamp = clock.now() / 1000;
          utimesSync(join(repo, path), stamp, stamp);
        }
      }
      return result;
    };
    const wall = Date.now();
    const tick = async (minutes: number) => {
      clock.at = T0 + minutes * MIN;
      world.screen = `Working ${21 + minutes}m`;
      const now = spyOn(Date, "now").mockImplementation(() => wall + minutes * MIN);
      try {
        return await freshnessTick({ ...deps, run: sample }, fixture.dir);
      } finally {
        now.mockRestore();
      }
    };

    expect(await tick(0)).toEqual([]);
    writeFileSync(join(repo, trackedPath), "real lane work\n");
    const firstChangedSample = statuses.length;
    expect(await tick(20)).toEqual([]);
    expect(statuses[firstChangedSample]).toContain(` M ${trackedPath}`);
    expect(reports.read(key)?.state).toBe("running");

    // The tracked edit is still dirty, but unchanged. Another full interval without activity must stall.
    expect((await tick(40)).map((act) => act.kind)).toEqual(["stalled"]);
    expect(reports.read(key)?.state).toBe("stalled");
  } finally {
    fixture.done();
  }
});
