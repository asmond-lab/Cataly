import { basename, join } from "node:path";
import { listUsageJournals } from "./usage-file.ts";
import { readSessionUsage, readUsageHeader, type SessionUsage } from "./usage-session.ts";

export type Pool = {
  paths: string[];
  advisors: string[];
  byId: Map<string, string[]>;
  byParent: Map<string, string[]>;
  next: Map<string, string[]>;
};

export const createUsageIndex = (cached: Record<string, SessionUsage>, issues: string[]) => {
  const files: Record<string, SessionUsage> = {};
  const pools = new Map<string, Pool>();
  const headers = new Map<string, Awaited<ReturnType<typeof readUsageHeader>>>();
  const header = async (path: string) => {
    const result = headers.get(path) ?? (await readUsageHeader(path));
    headers.set(path, result);
    return result;
  };
  const load = async (path: string) => {
    const data = files[path] ?? (await readSessionUsage(path, cached[path], (await header(path)).signature));
    if (!data.errors.length) files[path] = data;
    return data;
  };
  const journalFiles = (dir: string) => {
    try {
      return listUsageJournals(dir).map((name) => join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push("child session directory unreadable");
      return [];
    }
  };
  const index = async (dir: string): Promise<Pool> => {
    const existing = pools.get(dir);
    if (existing) return existing;
    const pool: Pool = {
      paths: journalFiles(dir),
      advisors: [],
      byId: new Map(),
      byParent: new Map(),
      next: new Map(),
    };
    pools.set(dir, pool);
    const add = (map: Map<string, string[]>, key: string, file: string) => {
      const paths = map.get(key);
      if (paths) paths.push(file);
      else map.set(key, [file]);
    };
    for (const file of pool.paths) {
      try {
        const data = await header(file),
          name = basename(file);
        add(pool.byId, data.id, file);
        // OMP reserves these names against task IDs and records advisors without parentSession.
        if (name === "__advisor.jsonl" || (name.startsWith("__advisor.") && name.endsWith(".jsonl")))
          pool.advisors.push(file);
        else if (data.continuation) add(pool.next, data.continuation, file);
        else if (data.parent) add(pool.byParent, data.parent, file);
      } catch {
        issues.push("child session file unreadable");
      }
    }
    return pool;
  };
  const latest = async (file: string, pool: Pool): Promise<string | undefined> => {
    const seen = new Set<string>();
    while (true) {
      if (seen.has(file)) {
        issues.push("ambiguous or cyclic child continuation");
        return;
      }
      seen.add(file);
      const successors = pool.next.get((await header(file)).id);
      if (!successors) return file;
      if (successors.length !== 1) {
        issues.push("ambiguous or cyclic child continuation");
        return;
      }
      file = successors[0]!;
    }
  };
  return { files, load, header, journalFiles, index, latest };
};
