import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RuntimeKind, TerminalRuntimeKind } from "./types.ts";

export type RuntimeSource =
  "default" | "env" | "config" | "detect:HC_TERMINAL_ID" | "detect:HERDR_PANE_ID" | "detect:TERN_PANE" | "detect:path";
export type RuntimeChoice = { readonly kind: RuntimeKind; readonly source: RuntimeSource };
type Settings = { readonly runtime?: TerminalRuntimeKind; readonly sessionRuntime?: RuntimeKind };

/** No runtime could be chosen; the message is the one-line fix. */
export class RuntimeChoiceError extends Error {}
/** A runtime setting that is present but unusable (bad value, unreadable config file). */
export class ConfigError extends Error {}

// A record keyed by kind, so a new RuntimeKind cannot be left out here. Key order is not a preference: PATH detection
// asks for hc first, then herdr, then tern, whatever order the keys or the PATH entries have.
const KIND_SET: Readonly<Record<TerminalRuntimeKind, true>> = { herdr: true, hc: true, tern: true };
const KINDS = Object.keys(KIND_SET) as TerminalRuntimeKind[];
const isKind = (value: unknown): value is TerminalRuntimeKind => KINDS.some((k) => k === value);
export const isSessionRuntime = (value: unknown): value is RuntimeKind => value === "headless" || isKind(value);

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

function configSettings(configPath: string): Settings {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return {};
    throw new ConfigError(`cannot read ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${configPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ConfigError(`${configPath} must hold a JSON object`);
  const runtime = "runtime" in parsed ? parsed.runtime : undefined;
  const sessionRuntime = "sessionRuntime" in parsed ? parsed.sessionRuntime : undefined;
  if (runtime !== undefined && !isKind(runtime))
    throw new ConfigError(`${configPath}: "runtime" must be "herdr", "hc" or "tern", got ${JSON.stringify(runtime)}`);
  if (sessionRuntime !== undefined && !isSessionRuntime(sessionRuntime))
    throw new ConfigError(`${configPath}: invalid sessionRuntime ${JSON.stringify(sessionRuntime)}`);
  return { ...(runtime && { runtime }), ...(sessionRuntime && { sessionRuntime }) };
}

function onPath(pathVar: string | undefined, exists: (path: string) => boolean): TerminalRuntimeKind[] {
  const dirs = (pathVar ?? "").split(delimiter).filter((dir) => dir !== "");
  return KINDS.filter((kind) => dirs.some((dir) => exists(join(dir, kind))));
}

/**
 * Old installers wrote `runtime` even when the owner made no choice. Consult it, the enclosing pane and PATH
 * only when terminal execution was requested, or on Windows where the native socket host is unavailable.
 */
export function readRuntimeChoice(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configPath: string;
  readonly config?: Settings;
  readonly terminalOnly?: boolean;
  readonly exists?: (path: string) => boolean;
}): RuntimeChoice {
  const { env, configPath } = options;
  const fromEnv = nonEmpty(env["CATALY_RUNTIME"]);
  if (fromEnv !== undefined) {
    if (!isSessionRuntime(fromEnv)) throw new ConfigError(`invalid CATALY_RUNTIME: ${JSON.stringify(fromEnv)}`);
    if (!options.terminalOnly || fromEnv !== "headless") return { kind: fromEnv, source: "env" };
  }
  const config = options.config ?? configSettings(configPath);
  if (config.sessionRuntime && (!options.terminalOnly || config.sessionRuntime !== "headless"))
    return { kind: config.sessionRuntime, source: "config" };
  if (!options.terminalOnly && process.platform !== "win32") return { kind: "headless", source: "default" };
  if (config.runtime) return { kind: config.runtime, source: "config" };
  if (nonEmpty(env["HC_TERMINAL_ID"]) !== undefined) return { kind: "hc", source: "detect:HC_TERMINAL_ID" };
  if (nonEmpty(env["HERDR_PANE_ID"]) !== undefined) return { kind: "herdr", source: "detect:HERDR_PANE_ID" };
  const found = onPath(env["PATH"], options.exists ?? isExecutableFile);
  if (found.includes("hc")) return { kind: "hc", source: "detect:path" };
  if (found.includes("herdr")) return { kind: "herdr", source: "detect:path" };
  // Tern comes last: it is a terminal people also run hc or herdr in, so whoever has one of those keeps it.
  if (nonEmpty(env["TERN_PANE"]) !== undefined) return { kind: "tern", source: "detect:TERN_PANE" };
  if (found.includes("tern")) return { kind: "tern", source: "detect:path" };
  throw new RuntimeChoiceError(
    `none of herdr, hc or tern is on PATH: install hc (herdr-core), herdr or Tern, or set "runtime": "herdr", "hc" or "tern" in ${configPath}, or CATALY_RUNTIME`,
  );
}
