import type { TerminateIdentity } from "../../../../src/platform/adapter.ts";
import { platform } from "../../../../src/platform/index.ts";
import type { FlowDeps } from "./done-flow.ts";

export type CloseProcess = TerminateIdentity & { readonly pid: number };

export const processIdentity = (deps: Pick<FlowDeps, "platform">, pid: number): CloseProcess => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("native process PID is unconfirmed");
  const reader = deps.platform ?? platform;
  const { startTicks } = reader.procStat(pid);
  const bootId = reader.bootId();
  if (!startTicks || !bootId) throw new Error(`native process ${pid} identity is unconfirmed`);
  return { pid, startTicks, bootId };
};

export const sameProcess = (a: CloseProcess, b: CloseProcess): boolean =>
  a.pid === b.pid && a.startTicks === b.startTicks && a.bootId === b.bootId;

export const processHold = async (
  deps: Pick<FlowDeps, "platform" | "run">,
  process: CloseProcess | undefined,
): Promise<string | undefined> => {
  if (
    !process ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 0 ||
    typeof process.startTicks !== "string" ||
    !process.startTicks ||
    typeof process.bootId !== "string" ||
    !process.bootId
  )
    return "prepared close has no confirmed native process identity";
  // Only a successful full table or a different kernel incarnation proves exit, never a wall-clock shift.
  const table = await deps.run(["ps", "-A", "-o", "pid="]);
  const rows = table.out.split("\n").filter((line) => line.trim());
  if (table.code !== 0 || rows.length === 0 || rows.some((line) => !/^\s*\d+\s*$/.test(line)))
    return "native process exit is unconfirmed: process table unavailable";
  if (rows.some((line) => Number(line.trim()) === process.pid)) {
    const current = processIdentity(deps, process.pid);
    if (sameProcess(current, process)) return `native process ${process.pid} is still present`;
  }
  return undefined;
};
