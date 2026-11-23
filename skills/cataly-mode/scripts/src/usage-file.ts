import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from "node:fs";

export const usageFileSignature = (stat: BigIntStats): string =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

export const openUsageFile = (path: string) => {
  const before = lstatSync(path, { bigint: true });
  const uid = process.getuid?.();
  const allowed = (s: BigIntStats) => s.isFile() && s.nlink === 1n && (uid === undefined || s.uid === BigInt(uid));
  if (!allowed(before)) throw new Error("usage requires an owned regular session file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!allowed(stat) || stat.dev !== before.dev || stat.ino !== before.ino)
      throw new Error("usage file changed before it was opened");
    return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
};

/** A disposable cache must be a stable, bounded snapshot of the actual opened file. */
export const readUsageCache = (path: string, maxBytes: number): string => {
  const { fd, stat } = openUsageFile(path);
  try {
    if (stat.size > BigInt(maxBytes)) throw new Error("usage cache outside size limit");
    const data = Buffer.alloc(Number(stat.size));
    for (let at = 0; at < data.length;) {
      const size = readSync(fd, data, at, data.length - at, at);
      if (size === 0) throw new Error("usage cache changed during read");
      at += size;
    }
    if (usageFileSignature(fstatSync(fd, { bigint: true })) !== usageFileSignature(stat))
      throw new Error("usage cache changed during read");
    return data.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const DIRECTORY_SCAN_LIMIT = 4096;
/** An incomplete directory scan cannot tell whether a missing or duplicated journal is real. */
export const listUsageJournals = (path: string): string[] => {
  if (!lstatSync(path).isDirectory()) throw new Error("usage requires a regular session directory");
  const dir = opendirSync(path);
  const names: string[] = [];
  try {
    for (let n = 0; n < DIRECTORY_SCAN_LIMIT; n++) {
      const entry = dir.readSync();
      if (entry === null) return names;
      if (entry.isFile() && entry.name.endsWith(".jsonl")) names.push(entry.name);
    }
    if (dir.readSync() !== null) throw new Error("usage directory scan limit exceeded");
    return names;
  } finally {
    dir.closeSync();
  }
};
