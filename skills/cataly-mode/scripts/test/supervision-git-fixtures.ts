import { expect } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run, type Runner } from "../src/run.ts";

export const native: Runner = (argv, opts) =>
  run(argv, {
    ...opts,
    preserveOutput: true,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C", ...opts?.env },
  });

export const git = async (cwd: string, ...args: string[]) => {
  const result = await native(["git", "-C", cwd, ...args]);
  expect(result.code, `git ${args.join(" ")}: ${result.err}`).toBe(0);
  return result.out;
};

export const commit = (cwd: string) =>
  git(
    cwd,
    "-c",
    "user.name=Cataly Fixture",
    "-c",
    "user.email=cataly@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "-m",
    "Seed boundary fixture",
  );

export const tracked = "work/tracked.txt";

export async function submoduleFixture(dir: string, key: string) {
  const source = join(dir, "local-source");
  const root = join(dir, "superproject");
  const module = join(root, "module");
  mkdirSync(join(source, "work"), { recursive: true });
  mkdirSync(root);
  await git(source, "init", "--quiet");
  writeFileSync(join(source, tracked), "seed\n");
  // Ignore known state files only, never the sibling writer directory created during a sweep.
  writeFileSync(
    join(source, ".gitignore"),
    `/cataly-state/lanes/${key}.json\n/cataly-state/lanes/${key}/reports.jsonl\n/cataly-state/lanes/${key}/supervision.json\n`,
  );
  await git(source, "add", "--", ".gitignore", tracked);
  await commit(source);
  await git(root, "init", "--quiet");
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", "--", source, "module");
  await commit(root);
  return { root, module };
}

export const key = "git-lock-lane";
export const lanes = "cataly-state/lanes";
export const writer = `${lanes}/.supervision-writers`;
const userDir = `${lanes}/.SUPERVISION-WRITERS`;
export const userFile = `${userDir}/work.txt`;

export async function nestedWorktreeFixture(home: string, nested: boolean, ignoreWriter: boolean, icase: boolean) {
  const repo = join(home, "worktree");
  const stateDir = join(repo, "cataly-state");
  const cwd = nested ? join(repo, "app") : repo;
  const tracked = nested ? `${lanes}/tracked.txt` : userFile;
  mkdirSync(cwd, { recursive: true });
  // Seed the writer spelling before the tracked file on case-insensitive filesystems.
  if (icase) mkdirSync(join(repo, writer), { recursive: true });
  const aliasesCase = icase && existsSync(join(repo, userDir));
  mkdirSync(dirname(join(repo, tracked)), { recursive: true });
  const native: Runner = async (argv, opts) => {
    // Model a caller's inherited mode without changing this test process's environment.
    const env = { ...process.env, GIT_ICASE_PATHSPECS: icase ? "1" : "0", ...opts?.env };
    const result = await run(argv, { ...opts, env, preserveOutput: true });
    if (result.code !== 0) throw new Error(`${argv.join(" ")}: ${result.err}`);
    return result;
  };
  const git = (...args: string[]) => native(["git", "-C", repo, ...args]);
  await git("init", "--quiet");
  const emptyExcludes = join(home, "empty-excludes");
  writeFileSync(emptyExcludes, "");
  await git("config", "core.excludesFile", emptyExcludes);
  await git("config", "core.ignoreCase", "false");
  const setWriterIgnored = (ignored: boolean) => {
    writeFileSync(
      join(repo, ".git", "info", "exclude"),
      [
        `/${lanes}/${key}.json`,
        `/${lanes}/${key}/reports.jsonl`,
        `/${lanes}/${key}/supervision.json`,
        ...(ignored ? [`/${writer}/`] : []),
        // Git tracks the uppercase index entry below. Do not report its lowercase filesystem alias as untracked.
        ...(aliasesCase ? [`/${writer}/work.txt`] : []),
        "",
      ].join("\n"),
    );
  };
  setWriterIgnored(ignoreWriter);
  writeFileSync(join(repo, tracked), "initial\n");
  if (aliasesCase) {
    expect(basename(realpathSync.native(join(repo, writer)))).toBe(basename(writer));
    const { out: blob } = await git("hash-object", "-w", "--", tracked);
    // git add could use the filesystem's directory spelling; pin the distinct name in the index.
    await git("update-index", "--add", "--cacheinfo", `100644,${blob.replace(/\r?\n$/, "")},${tracked}`);
    expect((await git("ls-files", "-z")).out).toBe(`${tracked}\0`);
  } else {
    await git("add", "--", tracked);
  }
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
  return { repo, cwd, stateDir, native, setWriterIgnored };
}
