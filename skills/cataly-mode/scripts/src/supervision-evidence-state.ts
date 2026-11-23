import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
  type Discovery,
  type FileCoverage,
  fileWindow,
  missedWindow,
  readWindow,
  WINDOW_LIMIT,
  type WindowRead,
} from "./evidence-window.ts";
import { type Evidenced, evidenceClock, markHolds, type PathMark } from "./evidence.ts";
import { type ReportProvenance, provenanceIdentity } from "./request-identity.ts";
import type { Runner } from "./run.ts";
import { writerDir } from "./supervision-activity.ts";
import { gitStatus, inDirectory, noWorktree } from "./supervision-git.ts";
import type { SupervisedLane, SupervisionOptions } from "./supervision-observe.ts";

type Scope = {
  readonly openedAt: string;
  readonly generation?: string;
  readonly provenance?: ReportProvenance;
};
export type Observation = Scope & {
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  readonly activity: string | null;
  readonly files?: Readonly<Record<string, PathMark>>;
  readonly coverage?: FileCoverage;
  readonly incidental?: Readonly<Record<string, string | null>>;
  readonly hung?: boolean;
  readonly activeAt: number;
  readonly lastReportAt?: string | null;
  readonly lastEvidenceAt?: string | null;
  readonly evidenceError?: string;
  readonly alerts: readonly string[];
};
type Stored = Observation | (Scope & { readonly coverage: FileCoverage });
type Candidates = Exclude<Discovery, { readonly error: string }> & { readonly declared: ReadonlySet<string> };
export type FileDiscovery = Candidates | { readonly error: string };

export const observationText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

const scoped = (saved: Stored | null, lane: SupervisedLane): Stored | null =>
  saved?.openedAt === lane.openedAt &&
  saved.generation === lane.lifecycleEpoch &&
  saved.provenance?.requestId === lane.requestId &&
  saved.provenance?.runId === lane.runId
    ? saved
    : null;

export const readObservation = (path: string, lane: SupervisedLane): Observation | null => {
  const text = observationText(path);
  const saved = scoped(text === null ? null : (JSON.parse(text) as Stored | null), lane);
  return saved && "at" in saved ? saved : null;
};

export const writeObservation = (path: string, observation: Stored): string => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(observation);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
  return text;
};

export const selectedEvidence = (records: Iterable<Evidenced>) => {
  const evidence = evidenceClock(records);
  return {
    signature: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    lastEvidenceAt: evidence.lastEvidenceAt,
  };
};

/** Keep one planned window durable before hashing; a failed/unknown poll never replaces its verified base. */
export const prepareWindow = (
  path: string,
  lane: SupervisedLane,
  tag: Omit<Scope, "openedAt">,
  discovery: FileDiscovery | null,
) => {
  const basis = observationText(path);
  const stored = scoped(basis === null ? null : (JSON.parse(basis) as Stored | null), lane);
  const savedTag = stored?.provenance;
  const expected = tag.provenance;
  const own =
    JSON.stringify(savedTag && provenanceIdentity(savedTag)) ===
    JSON.stringify(expected && provenanceIdentity(expected))
      ? stored
      : null;
  const previous = own && "at" in own ? own : null;
  const files = previous?.files ?? {};
  if (!discovery) {
    const read: WindowRead = { files, observed: [], ...(own?.coverage ? { coverage: own.coverage } : {}) };
    return { basis, previous, remaining: 0, observe: () => read };
  }
  if ("error" in discovery) {
    return { basis, previous, remaining: 0, observe: () => missedWindow(files, own?.coverage, discovery.error) };
  }
  const coverage = fileWindow(discovery.paths, Object.keys(files), own?.coverage);
  const planned = writeObservation(path, { ...previous, openedAt: lane.openedAt, ...tag, coverage });
  const remaining = Math.max(0, WINDOW_LIMIT - coverage.pending.length);
  return { basis: planned, previous, remaining, observe: () => readWindow(discovery, files, coverage) };
};

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Resolve through an existing ancestor too, so a new path through a state-directory alias is never evidence.
const physical = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : resolve(physical(parent), relative(parent, path));
  }
};

class InvalidWatchAncestor extends Error {}

const watchedPath = (path: string): void => {
  // On Windows the same invalid ancestor can appear as ENOENT rather than ENOTDIR.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    try {
      if (!statSync(parent).isDirectory())
        throw new InvalidWatchAncestor(`activity path ancestor is not a directory: ${path}`);
      return;
    } catch (error) {
      if (!missing(error)) throw error;
      if (parent === dirname(parent)) return;
    }
  }
};

// A broken watch cannot credit work. The later advisory probe reports the broken path without altering the prior sample.
export const confirmDeclared = (files: Readonly<Record<string, PathMark>>, declared: ReadonlySet<string>) =>
  Object.entries(files).every(([path, mark]) => {
    if (!declared.has(path) || markHolds(path, mark)) return true;
    try {
      watchedPath(path);
      return false;
    } catch (error) {
      return error instanceof InvalidWatchAncestor;
    }
  });

/** Use native Git's worktree and writer exclusions; expand every admitted untracked listing. */
export const discoverSupervisionFiles = async (
  run: Runner,
  options: SupervisionOptions,
  stateDir: string,
  lane: SupervisedLane,
): Promise<FileDiscovery> => {
  let probingGit = false;
  try {
    const state = physical(resolve(stateDir, "lanes"));
    const writerState = physical(writerDir(stateDir));
    const laneState = physical(resolve(state, lane.key));
    const registryEntry = physical(resolve(state, `${lane.key}.json`));
    const ownState = (path: string) => {
      const target = physical(path);
      const laneFile = relative(laneState, target);
      const registryFile = relative(state, target);
      const prefix = `${lane.key}.`;
      const ownRegistryFile = registryFile.startsWith(prefix) ? registryFile.slice(prefix.length) : "";
      const writerFile = relative(writerState, target);
      return (
        (inDirectory(writerFile) && (writerFile === "" || /\.lock(?:\.|$)/.test(writerFile))) ||
        /^(?:reports\.jsonl|checkpoints\.jsonl(?:\.lock)?|supervision\.json(?:\.\d+\.tmp|\.[a-f0-9]{64}\.lock)?)$/.test(
          laneFile,
        ) ||
        /^(?:deliver\.lock|launch\.lock|json\.\d+\.tmp)$/.test(ownRegistryFile) ||
        target === registryEntry ||
        target === `${registryEntry}.lock`
      );
    };
    const cwd = resolve(lane.cwd ?? ".");
    const declared = new Set(
      [...(options.activityPaths ?? []), ...(lane.activityPaths ?? [])]
        .map((name) => resolve(cwd, name))
        .filter((path) => !ownState(path)),
    );
    const paths = new Set(declared);
    for (const path of declared) watchedPath(path);
    if (options.gitActivity === false || !lane.cwd) return { paths, declared, ownState };
    probingGit = true;
    const physicalCwd = physical(lane.cwd);
    const expanded: Runner = (argv, opts) =>
      run(
        argv[3] === "status"
          ? argv.map((arg) => (arg === "--untracked-files=normal" ? "--untracked-files=all" : arg))
          : argv,
        opts,
      );
    const result = await gitStatus(expanded, lane.cwd, physicalCwd, writerState, true);
    if (result.code !== 0) {
      const explicitWorktree = process.env["GIT_DIR"] || process.env["GIT_WORK_TREE"];
      if (explicitWorktree || !noWorktree(result))
        throw new Error(`git status exited ${result.code}: ${result.err.trim()}`);
      return { paths, declared, ownState };
    }
    for (const { root, out } of [{ root: result.root ?? physicalCwd, out: result.out }, ...(result.submodules ?? [])]) {
      const rows = out.split("\0");
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        const local = relative(physicalCwd, resolve(root, row.slice(3)));
        if (row[0] === "R" || row[0] === "C" || row[1] === "R" || row[1] === "C") i++;
        if (!inDirectory(local) || local.split(sep).includes("node_modules")) continue;
        const path = resolve(cwd, local);
        if (!ownState(path)) paths.add(path);
      }
    }
    return { paths, declared, ownState };
  } catch (error) {
    return { error: probingGit ? `Git evidence observation failed: ${message(error)}` : message(error) };
  }
};

/** Refresh only incidental effect paths. Declared watches and untouched queued paths stay for a later real sweep. */
export const absorbIncidental = (
  observation: Observation,
  before: Candidates,
  after: Candidates,
  limit: number,
): Observation => {
  if (!limit) return observation;
  const files = observation.files ?? {};
  const declared = new Set([...before.declared, ...after.declared].map(physical));
  const paths = new Set(
    [...after.paths, ...before.paths].filter(
      (path) => !declared.has(physical(path)) && (path in files || !before.paths.has(path)),
    ),
  );
  const window = readWindow({ paths, ownState: after.ownState }, files, fileWindow(paths, []), limit);
  if (window.evidenceError) throw new Error(window.evidenceError);
  const incidental = { ...observation.incidental };
  for (const path of paths) {
    const mark = window.files[path];
    if (mark && (files[path] === undefined || files[path][1] !== mark[1]))
      incidental[mark[2] ?? path] = mark[1] === "special" ? null : mark[1];
  }
  return { ...observation, files: window.files, incidental };
};
