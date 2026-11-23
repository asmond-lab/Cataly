import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit paths win; packaged binaries are never searched for in the caller's cwd or PATH. */
export function discordNativeBinary(): string | undefined {
  const configured = process.env["CATALY_DISCORD_NATIVE_BIN"];
  if (configured === "" || configured === "off") return undefined;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error("CATALY_DISCORD_NATIVE_BIN must be absolute or off");
    return configured;
  }
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
  const home = process.env["CATALY_HOME"];
  const bundled = fileURLToPath(
    new URL(`../../../../native-bin/${process.platform}-${process.arch}/cataly`, import.meta.url),
  );
  const candidates = home && isAbsolute(home) ? [bundled, join(home, "bin", "cataly-native")] : [bundled];
  for (const path of candidates) {
    try {
      if (!lstatSync(path).isFile()) throw new Error(`Native Discord binary is not a regular file: ${path}`);
      accessSync(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return undefined;
}
