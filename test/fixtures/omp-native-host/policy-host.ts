import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAgentIdentity } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper, wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { nativeExtensionFactory, SOL_MODEL } from "./compose.ts";

/** Drives the real native wrapper; the fixture tool only counts calls and never starts a process. */
export const nativePolicy = async (
  entry: string,
  options: {
    readonly role?: "cataly" | "lane";
    readonly agent?: ExtensionAgentIdentity;
    readonly bash?: { readonly command: string; readonly approvalMode: "yolo" | "always-ask" };
    readonly session?: { readonly file: string; readonly parentSession?: string };
  },
) => {
  const factory = await nativeExtensionFactory(entry);
  const runtime = new ExtensionRuntime();
  const events = new EventBus();
  const cwd = import.meta.dir;
  const session = options.session
    ? await SessionManager.open(options.session.file, undefined, undefined, {
        initialCwd: cwd,
        suppressBreadcrumb: true,
        ...(options.session.parentSession ? { parentSession: options.session.parentSession } : {}),
      })
    : SessionManager.inMemory(cwd);
  if (options.role) runtime.flagValues.set("cataly-role", options.role);
  const extension = await loadExtensionFromFactory(factory, cwd, events, runtime, entry);
  let executions = 0;
  let approvals = 0;
  const fixture = await loadExtensionFromFactory(
    (api) => {
      api.registerTool({
        name: "bash",
        label: "Fixture bash",
        description: "Count admission without running a process",
        parameters: api.zod.object({ command: api.zod.string() }),
        async execute() {
          executions++;
          return { content: [{ type: "text", text: "fixture admitted" }], details: {} };
        },
      });
      api.on("tool_approval_requested", () => {
        approvals++;
      });
    },
    cwd,
    events,
    runtime,
    "policy-tool-fixture",
  );
  const unsupported = (): never => {
    throw new Error("native policy fixture attempted an action outside the tool-call test");
  };
  const registry = new Proxy({} as ModelRegistry, { get: unsupported });
  const settings = Settings.isolated({
    "prewalk.auto": "off",
    "prewalk.enabled": false,
    ...(options.bash ? { "tools.approvalMode": options.bash.approvalMode } : {}),
  });
  const runner = new ExtensionRunner(
    [extension, fixture], runtime, cwd, session, registry, undefined, settings, undefined, undefined, options.agent,
  );
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  let active: string[] = [];
  runner.initialize(
    {
      sendMessage: unsupported,
      sendUserMessage: unsupported,
      appendEntry: (type, data) => void session.appendCustomEntry(type, data),
      setLabel: unsupported,
      getActiveTools: () => [...active],
      getAllTools: () => [],
      setActiveTools: async (names) => { active = [...names]; },
      getCommands: () => [],
      setModel: unsupported,
      getThinkingLevel: () => undefined,
      setThinkingLevel: unsupported,
      getSessionName: () => undefined,
      setSessionName: unsupported,
    },
    {
      getModel: () => SOL_MODEL,
      isIdle: () => true,
      abort: unsupported,
      hasPendingMessages: () => false,
      shutdown: unsupported,
      getContextUsage: () => undefined,
      compact: unsupported,
      getSystemPrompt: () => [],
    },
  );
  try {
    await runner.emit({ type: "session_start" });
    let toolError: string | undefined;
    if (options.bash) {
      const tool = fixture.tools.get("bash");
      if (!tool) throw new Error("native fixture did not register bash");
      const wrapped = new ExtensionToolWrapper(wrapRegisteredTool(tool, runner), runner);
      try {
        await wrapped.execute("policy-call", { command: options.bash.command });
      } catch (error) {
        toolError = error instanceof Error ? error.message : String(error);
      }
    }
    return { tool: { executions, approvals, error: toolError }, entries: session.getBranch() };
  } finally {
    try {
      await emitSessionShutdownEvent(runner);
    } finally {
      settings.stopWatching();
      await settings.flush();
      await session.flush();
    }
    if (errors.length) throw new AggregateError(errors, "native policy fixture handler failed");
  }
};
