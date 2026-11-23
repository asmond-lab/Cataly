import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** Hash every byte through one descriptor without allocating a whole-file Buffer. */
export function fileDigest(input: string | number): string {
  const fd = typeof input === "number" ? input : openSync(input, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    if (typeof input === "string") closeSync(fd);
  }
}
