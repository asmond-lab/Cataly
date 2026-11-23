/** The monitor IPC head-admission wire shared by the OMP extension and the native Rust monitor. */
import type { HeadAdmissionProtocol } from "./head-admission-protocol.ts";

export type HeadInput = { identity: string; fingerprint: string } & (
  { op: "prepare" | "dispatch"; content: string; headFile?: string } | { op: "reconcile"; headFile: string }
);
export type HeadRequest = HeadInput & { protocol: HeadAdmissionProtocol; request: string };
export type HeadResult =
  | { outcome: "ready"; headFile: string; headPid: number }
  | { outcome: "accepted" | "rejected"; headFile: string; headPid: number; receipt: string }
  | { outcome: "unresolved" };
export type HeadReply = { protocol: HeadAdmissionProtocol; request: string } & HeadResult;
