import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function doctorCommand(directory: string): readonly string[] {
  const executable = join(directory, "omp");
  // Read the pinned version plainly: the real bundle ownership checks refuse CI's group-writable checkouts.
  const version = (
    JSON.parse(readFileSync(resolve(import.meta.dir, "../../../../native-omp.lock"), "utf8")) as {
      nativeVersion: string;
    }
  ).nativeVersion;
  writeFileSync(
    executable,
    `#!${process.execPath}
if (process.argv[2] === "--version") console.log(${JSON.stringify(version)});
else if (process.argv[2] === "--help") console.log("--config --extension --no-extensions --model");
else process.exit(1);
`,
    { mode: 0o700 },
  );
  // Windows cannot exec a shebang script directly: run it through the same runtime there.
  return process.platform === "win32" ? [process.execPath, executable] : [executable];
}
