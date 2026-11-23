import { platform } from "../../../../src/platform/index.ts";
import { classifyOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { NATIVE_VALUE_FLAGS } from "../../../../src/runtime/omp-options.ts";
import { sourceOmpArgv } from "../../../../src/runtime/omp.ts";
import type { LanePolicy } from "./lane-policy.ts";

const NOT_FRESH =
  /^(?:--resume|--continue|--session|--restore|--fork|--from-claude|--from-codex|--profile|--alias|-r|-c)(?:=|$)/;
const INTERPRETER_FLAGS = new Set(["--no-env-file", "--no-warnings", "--enable-source-maps"]);

export function isPolicyLaneCommand(argv: readonly string[]): boolean {
  const classified = classifyOmpArgv(argv);
  if (classified.kind !== "omp") return false;
  const { command, argsAt } = classified;
  const prefixes = argv.slice(0, argv.length - command.length);
  // Allow simple env assignments, but not a wrapper that may reset or replace the launch binding.
  if (
    prefixes.some((word, i) => {
      const next = argv[i + 1];
      return (
        /^CATALY_LANE_POLICY=/i.test(word) ||
        (platform.programName(word) === "env" && next !== "--" && next?.startsWith("-"))
      );
    })
  )
    return false;
  const interpreter = platform.programName(command[0] ?? "");
  if (!sourceOmpArgv(command) && (interpreter === "bun" || interpreter === "node")) {
    let at = 1;
    while (INTERPRETER_FLAGS.has(command[at] ?? "")) at++;
    if (interpreter === "bun" && command[at] === "run") at++;
    while (INTERPRETER_FLAGS.has(command[at] ?? "")) at++;
    // Interpreter eval, define and arbitrary preload values are not executable entries.
    if (at + 1 !== argsAt) return false;
  }
  let roles = 0;
  for (let at = argsAt; at < command.length; at++) {
    const arg = command[at] ?? "";
    if (arg === "--") break;
    if (NOT_FRESH.test(arg)) return false;
    // Native prompts may appear among options; only -- ends flag parsing.
    if (!arg.startsWith("-")) continue;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (flag !== "--cataly-role" && NATIVE_VALUE_FLAGS[flag] !== true) continue;
    const value = equals < 0 ? command[++at] : arg.slice(equals + 1);
    // A bare flag-shaped value is ambiguous when an extension shadows a native string flag.
    if (!value || (equals < 0 && value.startsWith("-"))) return false;
    if (flag === "--cataly-role") {
      if (value !== "lane") return false;
      roles++;
    }
  }
  return roles === 1;
}

export function requirePolicyLaneCommand(
  argv: readonly string[],
  policy: LanePolicy | undefined,
  ErrorType: new (message: string) => Error,
): void {
  if (policy !== undefined && !isPolicyLaneCommand(argv))
    throw new ErrorType("lanePolicy requires fresh, unambiguous native OMP argv with --cataly-role lane");
}
