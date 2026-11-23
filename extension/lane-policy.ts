import type { ExtensionAPI, FileEntry } from "@oh-my-pi/pi-coding-agent";
import type { CatalyApi, CatalyContext } from "./index.ts";
import type { CatalyRole } from "../skills/cataly-mode/scripts/src/lane-state.ts";
import { checkPolicyCommand } from "../skills/cataly-mode/scripts/src/lane-policy-actions.ts";
import { PolicyError } from "../skills/cataly-mode/scripts/src/lane-policy.ts";
import { isCatalyEntry, SESSION_WIRE } from "../skills/cataly-mode/scripts/src/session-compat.ts";

const ENTRY = "omp-cataly:lane-policy";
type Binding = string | { readonly error: string };
type Branch = ReturnType<CatalyContext["sessionManager"]["getBranch"]>;
type Inherited = { readonly role: CatalyRole | undefined; readonly binding: Binding | undefined };
const agentPolicies = new Map<string, Inherited>();
const recordedBinding = (branch: Branch): Binding | undefined => {
  const entry = branch.findLast((entry) => entry.type === "custom" && isCatalyEntry(entry.customType, ENTRY));
  return entry === undefined
    ? undefined
    : typeof entry.data === "string"
      ? entry.data
      : { error: "invalid recorded lane policy binding" };
};

export const lanePolicyHook = (
  pi: CatalyApi & { pi?: Pick<ExtensionAPI["pi"], "loadSessionFile" | "SessionEntryIndex"> },
  recordedRole: (branch: Branch) => CatalyRole | undefined,
  launchedBinding: string | undefined,
) => {
  let binding: Binding | undefined;
  pi.on("tool_call", (event) => {
    const call = event as { toolName?: unknown; input?: unknown } | null;
    if (binding === undefined || typeof call !== "object" || call === null || call.toolName !== "bash") return;
    try {
      if (typeof binding !== "string") throw new PolicyError(binding.error);
      const input = call.input as { command?: unknown } | null;
      if (typeof input !== "object" || input === null || typeof input.command !== "string")
        throw new PolicyError("configured lane policy received a bash call without a command string");
      const reason = checkPolicyCommand(binding, input.command, Date.now());
      return reason ? { block: true, reason } : undefined;
    } catch (error) {
      // Native OMP may catch handler exceptions. Returning block is required to stop approval and execution.
      const reason = error instanceof Error ? error.message : String(error);
      return { block: true, reason: `LANE_POLICY_ERROR: ${reason}. Report this blocker; no command ran.` };
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    // Keep the same-realm role handoff used before lane policies, without retaining a live binding here.
    const previous = agentPolicies.get(ctx.agent.id);
    if (previous?.binding !== undefined) agentPolicies.delete(ctx.agent.id);
    binding = undefined;
  });
  pi.on("before_subagent_spawn", (_event, ctx) => {
    if (binding !== undefined && !ctx.sessionManager.getSessionFile())
      return {
        block: true,
        reason: "Lane policy inheritance requires a persisted native parent session; no subagent started.",
      };
  });
  return {
    inherit: async (ctx: CatalyContext): Promise<Inherited> => {
      try {
        const own = ctx.sessionManager.getBranch();
        const saved = { role: recordedRole(own), binding: recordedBinding(own) };
        if (saved.role !== undefined || saved.binding !== undefined) return saved;
        const parent = ctx.agent.parentId;
        const active = parent === undefined ? undefined : agentPolicies.get(parent);
        if (active !== undefined) return active;
        // Native worker realms re-import extensions. Their session header names the spawning transcript.
        const file = ctx.sessionManager.getHeader?.()?.parentSession;
        if (!file) return { role: undefined, binding: undefined };
        if (!pi.pi) throw new PolicyError("native session reader is unavailable");
        const loaded = await pi.pi.loadSessionFile(file, undefined, { throwIfMissing: true });
        if (loaded.invalidHeader || loaded.entries[0]?.type !== "session")
          throw new PolicyError("invalid parent session transcript");
        const index = new pi.pi.SessionEntryIndex();
        index.rebuild(loaded.entries.filter((entry: FileEntry) => entry.type !== "session"));
        const branch = index.pathTo();
        const inherited = { role: recordedRole(branch), binding: recordedBinding(branch) };
        if (loaded.malformedRecords && inherited.binding !== undefined)
          throw new PolicyError("invalid parent policy transcript");
        return inherited;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { role: undefined, binding: { error: `cannot inherit parent session: ${message}` } };
      }
    },
    sync: (
      role: CatalyRole | undefined,
      ctx: CatalyContext,
      eventName: string,
      event: unknown,
      flaggedRole: boolean,
      inherited: Inherited | undefined,
    ): void => {
      const recorded = recordedBinding(ctx.sessionManager.getBranch());
      if (ctx.agent.kind === "sub") binding = inherited?.binding;
      else if (role !== "lane") binding = undefined;
      else {
        const carried =
          eventName === "session_switch" &&
          typeof event === "object" &&
          event !== null &&
          "reason" in event &&
          event.reason === "new";
        if (recorded !== undefined) binding = recorded;
        else if (!carried)
          binding = eventName === "session_start" && flaggedRole ? launchedBinding || undefined : undefined;
      }
      if (recorded === undefined && binding !== undefined)
        pi.appendEntry(SESSION_WIRE.lanePolicy, typeof binding === "string" ? binding : null);
      agentPolicies.set(ctx.agent.id, { role, binding });
    },
  };
};
