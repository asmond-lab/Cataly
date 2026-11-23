import { parentPort, workerData } from "node:worker_threads";
import { nativePolicy } from "./policy-host.ts";

if (!parentPort) throw new Error("policy worker fixture must run in a worker thread");
const input = workerData as { entry: string; file: string; parentSession: string; id: string; parentId: string };
const result = await nativePolicy(input.entry, {
  agent: { kind: "sub", id: input.id, parentId: input.parentId, name: "task", depth: 1 },
  session: { file: input.file, parentSession: input.parentSession },
  bash: { command: "sudo true", approvalMode: "yolo" },
});
parentPort.postMessage(result);
parentPort.close();
