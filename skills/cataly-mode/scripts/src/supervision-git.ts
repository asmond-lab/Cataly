import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Ran, Runner, RunOptions } from "./run.ts";

const pathspecEnv = {
  GIT_LITERAL_PATHSPECS: "0",
  GIT_ICASE_PATHSPECS: "0",
  GIT_GLOB_PATHSPECS: "0",
  GIT_NOGLOB_PATHSPECS: "0",
};
const probeOptions = { timeoutMs: 10_000, preserveOutput: true } as const;
export const noWorktree = ({ code, out, err }: Ran): boolean => {
  if (code !== 128 || out) return false;
  const detail = err.trimEnd().replaceAll("\r\n", "\n");
  return (
    detail === "fatal: not a git repository (or any of the parent directories): .git" ||
    detail === "fatal: this operation must be run in a work tree" ||
    (detail.startsWith("fatal: not a git repository (or any parent up to mount point ") &&
      detail.endsWith(")\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set)."))
  );
};

export class IncompleteGitObservation extends Error {}

const gitPath = (path: string): string => (sep === "/" ? path : path.replaceAll(sep, "/"));

export const inDirectory = (relativePath: string): boolean =>
  !isAbsolute(relativePath) && relativePath.split(sep)[0] !== "..";

const rootMayContain = (cwd: string, writers: string): boolean => {
  for (let parent = cwd; ; parent = dirname(parent)) {
    if (inDirectory(relative(parent, writers)) && existsSync(join(parent, ".git"))) return true;
    if (parent === dirname(parent)) return false;
  }
};

const nestedWorktree = (parent: string, writers: string): boolean => {
  if (!inDirectory(relative(parent, writers))) return false;
  for (let path = dirname(writers); path !== parent && path !== dirname(path); path = dirname(path)) {
    if (existsSync(join(path, ".git"))) return true;
  }
  return false;
};

type GitEnv = NonNullable<RunOptions["env"]>;
const childGitEnv = (env: RunOptions["env"]): GitEnv => ({
  ...env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_IMPLICIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_PREFIX: undefined,
  GIT_SHALLOW_FILE: undefined,
  GIT_GRAFT_FILE: undefined,
});

type Status = Ran & {
  readonly root?: string;
  readonly submodules?: readonly { readonly root: string; readonly out: string }[];
};
export const gitStatus = (run: Runner, rawCwd: string, cwd: string, writers: string, hasWatches: boolean) => {
  const explicitWorktree = Boolean(process.env["GIT_DIR"] || process.env["GIT_WORK_TREE"]);
  return status(run, rawCwd, cwd, writers, process.env, explicitWorktree, hasWatches);
};

async function status(
  run: Runner,
  rawCwd: string,
  cwd: string,
  writers: string,
  env: RunOptions["env"],
  explicitWorktree: boolean,
  hasWatches = false,
): Promise<Status> {
  const argv = ["git", "-C", rawCwd, "status", "--porcelain=v1", "-z", "--untracked-files=normal"];
  const fromCwd = relative(cwd, writers);
  let exclude =
    !explicitWorktree && fromCwd && inDirectory(fromCwd) ? `:(exclude,literal)${gitPath(fromCwd)}` : undefined;
  let actualRoot: string | undefined;
  // Ask Git for its root only to locate the writer or match a root-relative row against a nested lane's watches.
  const nestedWatch = hasWatches && !existsSync(join(cwd, ".git")) && rootMayContain(cwd, cwd);
  if (nestedWatch || (exclude ? nestedWorktree(cwd, writers) : explicitWorktree || rootMayContain(cwd, writers))) {
    const root = await run(["git", "-C", rawCwd, "rev-parse", "--show-toplevel"], {
      ...probeOptions,
      env: { ...env, LC_ALL: "C" },
    });
    // A definitive discovery boundary is the ordinary no-Git case; an uncertain probe cannot admit unfiltered status.
    if (noWorktree(root)) return root;
    // Git's line-oriented output may use the Windows CRT's CRLF delimiter. Preserve every other path byte.
    const lineEnding = process.platform === "win32" ? /\r?\n$/ : /\n$/;
    const path = root.out.replace(lineEnding, "");
    // Without the root, status could report the writer lock as lane work.
    if (root.code !== 0) throw new IncompleteGitObservation(`git rev-parse exited ${root.code}`);
    if (!isAbsolute(path)) throw new IncompleteGitObservation("git rev-parse did not return an absolute worktree root");
    try {
      // Compare against the same Win32 filesystem spelling as cwd and writers, including 8.3 aliases.
      actualRoot = process.platform === "win32" ? realpathSync.native(path) : path;
    } catch (cause) {
      throw new IncompleteGitObservation("git rev-parse worktree root could not be resolved", { cause });
    }
    const fromRoot = relative(actualRoot, writers);
    if (!exclude && fromRoot && inDirectory(fromRoot)) exclude = `:(top,exclude,literal)${gitPath(fromRoot)}`;
  }
  if (exclude) argv.push("--", exclude);
  const statusEnv = { ...env, ...(exclude ? pathspecEnv : {}), LC_ALL: "C" };
  const raw = await run(argv, { ...probeOptions, env: statusEnv });
  const result = actualRoot ? { ...raw, root: actualRoot } : raw;
  if (result.code !== 0 || !result.out || !actualRoot || !nestedWorktree(actualRoot, writers)) return result;

  // Porcelain reports a dirty submodule as one path, so a pathspec cannot remove its descendant writer lock.
  // Clear only worktree dirt after proving the writer is its only source; preserve the original index status.
  const rows = result.out.split("\0");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? "";
    if (row[1] === "M" && row[2] === " ") {
      const name = row.slice(3);
      const module = join(actualRoot, name);
      const inside = relative(module, writers);
      if (inside && inDirectory(inside) && existsSync(join(module, ".git"))) {
        const diff = await run(
          [
            "git",
            "-C",
            rawCwd,
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--ignore-submodules=untracked",
            "--",
            `:(top,literal)${name}`,
          ],
          { ...probeOptions, env: { ...env, ...pathspecEnv } },
        );
        if (diff.code !== 0 && diff.code !== 1)
          throw new IncompleteGitObservation(`git submodule diff exited ${diff.code}`);
        const inner = await status(run, module, module, writers, childGitEnv(env), false);
        if (inner.code !== 0) throw new IncompleteGitObservation(`git submodule status exited ${inner.code}`);
        if (diff.code === 0 && !inner.out) {
          if (row[0] === " ") rows.splice(i, 1);
          else rows[i] = `${row[0]} ${row.slice(2)}`;
          return { ...result, out: rows.join("\0") };
        }
        if (inner.out)
          return {
            ...result,
            submodules: [{ root: inner.root ?? module, out: inner.out }, ...(inner.submodules ?? [])],
          };
        break;
      }
    }
    // A porcelain rename/copy's second field is only a path, not another status row.
    if (row[0] === "R" || row[0] === "C" || row[1] === "R" || row[1] === "C") i++;
  }
  return result;
}
