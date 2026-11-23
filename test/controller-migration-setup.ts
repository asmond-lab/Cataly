import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { controllerLock, type ControllerRole } from "../src/loop-controller.ts";
import { liveLoopLock } from "../src/loop-lock.ts";
import type { Exec } from "../src/runtime/exec.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import type { World } from "./fake.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const lockModule = join(import.meta.dir, "../src/loop-lock.ts");
const controller = (role: ControllerRole) => (role === "hourly-loop" ? "loop" : "duty");
type Child = Bun.Subprocess<"ignore", "ignore", "ignore">;

/** Real controller children, with separate daemon defaults and the real terminal adapters over the wire fake. */
export function controllerTerminals(w: World, d: Deps) {
  const real: Exec = w.exec;
  const children = new Map<string, Child>();
  const owned = new Set<Child>();
  const sessions = new Map<string, Record<string, string>>();
  const started: Child[] = [];
  const knobs = {
    rejectLaunch: false,
    loseStartReply: false,
    loseProbeReply: false,
    killOnReplacementProbe: false,
    beforeClose: (_child: Child): void | Promise<void> => {},
  };
  const env = {
    ...process.env,
    CATALY_HOME: d.store.root,
    CATALY_STATE_DIR: join(d.store.root, "omp"),
    CATALY_CONFIG: join(d.store.root, "config.json"),
    CATALY_TELEMETRY: "0",
    CATALY_RUNTIME: "headless",
    HC_TERMINAL_ID: "",
    HERDR_PANE_ID: "",
  };
  const spawn = (args: string[], overrides: Record<string, string>): Child => {
    const child = Bun.spawn([process.execPath, ...args], {
      env: { ...env, ...overrides },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    owned.add(child);
    return child;
  };
  w.exec = async (cmd, argv, options) => {
    const args = cmd === "hc" ? argv.slice(1) : argv;
    const close = cmd === "herdr" && args[0] === "pane" && args[1] === "close" ? args[2] : undefined;
    const old = close && children.get(close);
    if (old) {
      await knobs.beforeClose(old);
      if (old.exitCode === null) old.kill("SIGKILL");
      await old.exited;
    }
    const result = await real(cmd, argv, options);
    if (result.code !== 0) return result;
    if (cmd === "hc" && args[0] === "run") {
      const { address } = JSON.parse(result.stdout) as { address: string };
      const values = args.slice(args.indexOf("--") + 2, -1);
      sessions.set(address, {
        ...Object.fromEntries(
          values.map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)]),
        ),
        HC_TERMINAL_ID: address,
      });
    }
    if (cmd === "hc" && args[0] === "send" && args[2] === "--") {
      const id = args[1] ?? "";
      const [executable, subcommand, ...flags] = (args[3] ?? "").split(" ");
      const overrides = sessions.get(id);
      if (executable === "cataly" && subcommand && flags.includes("--controller-handoff") && overrides) {
        const child = spawn(
          [cli, subcommand, ...flags, ...(knobs.rejectLaunch ? ["--interval", "-1"] : [])],
          overrides,
        );
        children.set(id, child);
        started.push(child);
        if (knobs.loseStartReply) throw new Error("terminal lost its start reply");
      }
    }
    if (cmd === "hc" && args[0] === "get") {
      const child = children.get(args[1] ?? "");
      if (child && knobs.loseProbeReply) throw new Error("terminal lost its verification reply");
      if (child && knobs.killOnReplacementProbe) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    }
    if (cmd === "herdr" && args[0] === "pane" && args[1] === "process-info") {
      const child = children.get(args[3] ?? "");
      if (child && child.exitCode === null) {
        const report = JSON.parse(result.stdout) as { result: { process_info: Record<string, unknown> } };
        report.result.process_info["foreground_processes"] = [{ name: "bun", argv: ["bun", cli], pid: child.pid }];
        return { ...result, stdout: JSON.stringify(report) };
      }
    }
    return result;
  };
  const holder = (role: ControllerRole) => liveLoopLock(controllerLock(d, role));
  async function untilHolder(role: ControllerRole, pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (holder(role)?.pid !== pid) {
      if (Date.now() >= deadline) throw new Error(`${role} did not acquire its lock for child ${pid}`);
      await Bun.sleep(25);
    }
  }
  return {
    knobs,
    started,
    holder,
    untilHolder,
    sleep: async (ms: number) => {
      await Bun.sleep(25);
      w.clock += Math.max(ms, 1000);
    },
    async source(role: ControllerRole, ref: SessionRef, legacy = false) {
      d.store.setStop(d.now(), "operator stopped", role === "duty-loop" ? "duty" : "loop");
      const child = legacy
        ? spawn(
            [
              "-e",
              `import { acquire } from ${JSON.stringify(lockModule)};
           if ("holder" in acquire({ now: Date.now }, ${JSON.stringify(controllerLock(d, role))})) process.exit(1);
           setInterval(() => {}, 1000);`,
            ],
            {},
          )
        : spawn([cli, controller(role)], { CATALY_RUNTIME: ref.runtime, HERDR_PANE_ID: ref.id });
      children.set(ref.id, child);
      await untilHolder(role, child.pid);
      return child;
    },
    async closeActors() {
      for (const child of owned) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all([...owned].map((child) => child.exited));
    },
  };
}
