import { classifyOmpArgv } from "./omp-argv.ts";
import { NATIVE_VALUE_FLAGS } from "./omp-options.ts";

/** Read the role option in a preserved v0.1.3 OMP template. Paths, custom programs and prompt text stay opaque. */
export function currentAgentCommand(argv: readonly string[]): readonly string[] {
  if (!argv.some((arg) => arg === "--dori-role" || arg.startsWith("--dori-role="))) return argv;
  const parsed = classifyOmpArgv(argv);
  if (parsed.kind !== "omp") return argv;
  const current = [...argv];
  let roleSeen = false;
  for (let i = argv.length - parsed.command.length + parsed.argsAt; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (NATIVE_VALUE_FLAGS[arg] === true || arg === "--profile" || arg === "--alias") {
      i++;
      continue;
    }
    const roleFlag = /^(--dori-role|--cataly-role)(?:=(.*))?$/.exec(arg);
    if (!roleFlag) continue;
    if (roleSeen) throw new Error("Ambiguous OMP role options in agentCommand");
    roleSeen = true;
    if (roleFlag[1] === "--cataly-role") continue;
    const role = roleFlag[2] ?? argv[i + 1];
    if (role !== "dori" && role !== "lane") throw new Error("Invalid legacy OMP role in agentCommand");
    const value = role === "dori" ? "cataly" : "lane";
    if (roleFlag[2] !== undefined) current[i] = `--cataly-role=${value}`;
    else {
      current[i] = "--cataly-role";
      current[++i] = value;
    }
  }
  return current;
}
