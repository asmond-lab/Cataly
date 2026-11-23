import { createHash } from "node:crypto";
import { type EvidenceRef, markHolds, type PathMark, pathMark, racyMark, UnstableEvidenceError } from "./evidence.ts";

export type FileCoverage = {
  /** A fixed snapshot drains before new candidates are scheduled, so churn cannot starve its tail. */
  readonly pending: readonly string[];
  /** Remember discoveries even when they leave Git status before the next snapshot starts. */
  readonly deferred: readonly string[];
  readonly manifest: string;
  /** Membership changes, new evidence, and failed or raced reads disqualify a cycle from a hung verdict. */
  readonly changed: boolean;
  /** A path's read failure stays reported, once, until a later read of that path succeeds; races are not failures. */
  readonly failed?: Readonly<Record<string, string>>;
};
type Marks = Readonly<Record<string, PathMark>>;
/** One sweep's candidates from Git and activityPaths, and which paths are the observer's own state. */
type Candidates = { readonly paths: ReadonlySet<string>; readonly ownState: (path: string) => boolean };
export type Discovery = Candidates | { readonly error: string };
/** What one window read found: the marks it trusts, the file evidence it saw, its schedule and its uncertainty. */
export type WindowRead = {
  readonly files: Marks;
  readonly observed: readonly EvidenceRef[];
  readonly coverage?: FileCoverage;
  readonly evidenceError?: string;
};

/** A fixed snapshot drains even when a failed path must be retried in the next cycle. */
export const fileWindow = (
  paths: ReadonlySet<string>,
  previous: readonly string[],
  coverage?: FileCoverage,
): FileCoverage => {
  const ordered = [...paths].sort();
  const manifest = createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
  const cycle = coverage?.pending.length
    ? coverage
    : {
        pending: [...new Set([...ordered, ...previous, ...(coverage?.deferred ?? [])])].sort(),
        deferred: [],
        manifest,
        changed: false,
      };
  const known = new Set([...previous, ...cycle.pending, ...cycle.deferred]);
  return {
    pending: cycle.pending,
    deferred: [...cycle.deferred, ...ordered.filter((path) => !known.has(path))],
    manifest: cycle.manifest,
    changed: cycle.changed || manifest !== cycle.manifest,
    ...(coverage?.failed === undefined ? {} : { failed: coverage.failed }),
  };
};

/**
 * Before a new hung verdict only: re-stat every known candidate, including this sweep's window. A racy mark, changed
 * stat or failed lstat leaves the verdict unknown. These sequential lstats are not an atomic filesystem snapshot;
 * they neither replace marks nor move the schedule. Only a later content read may credit changed bytes as evidence.
 */
export const confirmMarks = (
  files: Readonly<Record<string, PathMark>>,
  observedAt = Date.now(),
): { readonly quiet: boolean; readonly stats: number } => {
  const marks = Object.entries(files);
  if (marks.some(([, mark]) => racyMark(mark))) return { quiet: false, stats: 0 };
  let stats = 0;
  for (const [path, mark] of marks) {
    stats++;
    if (!markHolds(path, mark, observedAt)) return { quiet: false, stats };
  }
  return { quiet: true, stats };
};

// A failing path stays one stable report, not a new one each cycle, until a read of it succeeds; a whole-observation
// failure of this sweep is reported first.
const reported = (read: WindowRead, failure?: string): WindowRead => {
  const failing = Object.entries(read.coverage?.failed ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const [first] = failing;
  const evidenceError =
    failure ?? (first && `${first[1]}${failing.length > 1 ? ` (and ${failing.length - 1} more failing paths)` : ""}`);
  return evidenceError === undefined ? read : { ...read, evidenceError };
};

/** A failed discovery reads nothing: the trusted marks and the schedule stay, and the cycle is disqualified. */
export const missedWindow = (files: Marks, coverage: FileCoverage | undefined, failure: string): WindowRead => {
  const kept = coverage === undefined ? {} : { coverage: { ...coverage, changed: true } };
  return reported({ files, observed: [], ...kept }, failure);
};

/**
 * Reads at most 256 candidates of the prepared window: their stats, and the bytes of any not settled unchanged. Run it
 * outside the delivery lock, after the plan is durable; only a commit in the same generation records what it found.
 */
export const WINDOW_LIMIT = 256;
export const readWindow = (
  { paths, ownState }: Candidates,
  files: Marks,
  planned: FileCoverage,
  limit = WINDOW_LIMIT,
): WindowRead => {
  let changed = planned.changed;
  const deferred = new Set(planned.deferred);
  const marks = { ...files };
  const observed: EvidenceRef[] = [];
  const failed: Record<string, string> = { ...planned.failed };
  for (const path of planned.pending.slice(0, limit)) {
    try {
      const mark = pathMark(path, files[path]);
      const [, fingerprint, canonical] = mark;
      if (paths.has(path)) marks[path] = mark;
      else delete marks[path];
      if (fingerprint !== "special" && !ownState(canonical ?? path))
        observed.push({ kind: "file", ref: canonical ?? path, fingerprint });
      delete failed[path];
    } catch (error) {
      // A read that raced a change keeps the trusted mark and any earlier failure, and is retried next cycle.
      if (!(error instanceof UnstableEvidenceError))
        failed[path] = error instanceof Error ? error.message : String(error);
      changed = true;
      deferred.add(path);
    }
  }
  return reported({
    files: marks,
    observed,
    coverage: {
      pending: planned.pending.slice(limit),
      deferred: [...deferred],
      manifest: planned.manifest,
      changed,
      ...(Object.keys(failed).length ? { failed } : {}),
    },
  });
};
