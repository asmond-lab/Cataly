import { lstatSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { Refusal } from "../refusal.ts";
import { refText } from "../refs.ts";
import { parseRef, type SessionRef, type TerminalRuntimeKind } from "../runtime/types.ts";
import { object } from "../update/config.ts";
import { owned } from "./files.ts";

type LegacyTerminal = {
  readonly home: string;
  readonly primary: boolean;
  readonly runtime: TerminalRuntimeKind;
  readonly session: string;
};

function xdg(key: string, fallback: string): string {
  const path = process.env[key] || fallback;
  if (!isAbsolute(path)) throw new Refusal(`${key} must identify the original absolute runtime directory`);
  return path;
}

function endpoint({ home, primary, runtime, session }: LegacyTerminal): string {
  if (runtime === "herdr" && process.env["XDG_CONFIG_HOME"] === "")
    throw new Refusal("XDG_CONFIG_HOME must identify the original absolute runtime directory");
  const config = xdg("XDG_CONFIG_HOME", join(home, ".config"));
  if (runtime === "herdr") {
    const dir = join(config, "herdr");
    if (session !== "default") return join(dir, "sessions", session, "herdr.sock");
    const path = join(dir, "herdr.sock");
    if (process.env["HERDR_SOCKET_PATH"] && process.env["HERDR_SOCKET_PATH"] !== path)
      throw new Refusal("A custom HERDR_SOCKET_PATH cannot prove retirement from the original namespace");
    return path;
  }
  const hcConfig = join(config, "herdr-core/config.toml");
  if (lstatSync(hcConfig, { throwIfNoEntry: false })) {
    const settings: unknown = Bun.TOML.parse(readFileSync(hcConfig, "utf8"));
    if (object(settings) && Object.hasOwn(settings, "socket"))
      throw new Refusal("A custom hc config socket cannot prove retirement from the original namespace");
  }
  const fallback = join("/run/user", String(process.getuid?.()));
  const run =
    process.env["XDG_RUNTIME_DIR"] ||
    (lstatSync(fallback, { throwIfNoEntry: false })?.isDirectory() ? fallback : undefined);
  const state = xdg("XDG_STATE_HOME", join(home, ".local/state"));
  const directory = run ? join(xdg("XDG_RUNTIME_DIR", run), "herdr-core") : join(state, "herdr-core", session);
  const path = join(directory, `${session}.sock`);
  if (
    (primary || process.env["HC_SESSION"] === session) &&
    process.env["HC_SOCKET"] &&
    process.env["HC_SOCKET"] !== path
  )
    throw new Refusal("A custom HC_SOCKET cannot prove retirement from the original namespace");
  return path;
}

function socketIdentity(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false, bigint: true });
  if (!stat?.isSocket()) throw new Refusal(`No existing authoritative endpoint at ${path}`);
  if (!lstatSync(dirname(path)).isDirectory())
    throw new Refusal("The original endpoint directory is not a real directory");
  owned(dirname(path));
  owned(path);
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
}

type LegacyRead =
  | { readonly id: string; readonly method: "pane.list"; readonly params: Record<string, never> }
  | {
      readonly jsonrpc: "2.0";
      readonly id: 1;
      readonly method: "terminal.get";
      readonly params: { readonly terminal: string };
    };

/** Talk directly to the existing socket: even hc ls/get can auto-start an empty core. Do not spawn a CLI. */
function readLegacyEndpoint(path: string, request: LegacyRead): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const deadline = setTimeout(() => socket.destroy(new Error("Original terminal server did not answer")), 5_000);
    socket.once("close", () => {
      clearTimeout(deadline);
      reject(new Error("Original terminal server closed without a complete reply"));
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (received.length + chunk.length > 4 * 1024 * 1024) {
        socket.destroy(new Error("Original terminal server reply is too large"));
        return;
      }
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(10);
      if (end === -1) return;
      try {
        const packet: unknown = JSON.parse(received.subarray(0, end).toString("utf8"));
        if (!object(packet)) throw new Error("Original terminal server reply is malformed");
        resolve(packet);
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

async function proveGone(path: string, runtime: TerminalRuntimeKind, refs: readonly SessionRef[]): Promise<void> {
  if (runtime === "herdr") {
    const id = crypto.randomUUID();
    const reply = await readLegacyEndpoint(path, { id, method: "pane.list", params: {} });
    const result = reply["result"];
    if (reply["id"] !== id || reply["error"] !== undefined || !object(result) || result["type"] !== "pane_list")
      throw new Error("Original herdr server did not return a pane list");
    const panes = result["panes"];
    if (
      !Array.isArray(panes) ||
      panes.some(
        (pane) =>
          !object(pane) || typeof pane["pane_id"] !== "string" || parseRef(pane["pane_id"])?.runtime !== "herdr",
      )
    )
      throw new Error("Original herdr server returned an invalid pane list");
    for (const ref of refs)
      if (panes.some((pane: { pane_id: string }) => pane.pane_id === ref.id))
        throw new Error(`${refText(ref)} is still present`);
    return;
  }
  for (const ref of refs) {
    const reply = await readLegacyEndpoint(path, {
      jsonrpc: "2.0",
      id: 1,
      method: "terminal.get",
      params: { terminal: ref.id },
    });
    const result = reply["result"];
    const error = reply["error"];
    const data = object(error) ? error["data"] : undefined;
    if (reply["jsonrpc"] !== "2.0" || reply["id"] !== 1) throw new Error("Original hc server reply is malformed");
    if (
      result === undefined &&
      object(error) &&
      error["code"] === -32000 &&
      typeof error["message"] === "string" &&
      object(data) &&
      data["kind"] === "not_found"
    )
      continue;
    if (error === undefined && object(result) && result["address"] === ref.id && result["state"] === "finished")
      continue;
    throw new Error(`${refText(ref)} is still present or its exit is not proven`);
  }
}

export async function proveLegacyTerminalGone(
  terminal: LegacyTerminal,
  refs: readonly SessionRef[],
): Promise<() => void> {
  const hold = (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    return new Refusal(
      `${reason}. Keep roles.json unchanged. Close the historical terminals yourself in the original ${terminal.runtime} namespace (${terminal.session}), keeping its server available, then rerun from the original XDG environment. If that endpoint cannot be recovered, preserve this home and install with --home pointing to a new, empty home.`,
    );
  };
  try {
    const path = endpoint(terminal);
    const identity = socketIdentity(path);
    await proveGone(path, terminal.runtime, refs);
    return () => {
      try {
        if (socketIdentity(path) !== identity)
          throw new Error("Original terminal server endpoint changed during proof");
      } catch (error) {
        throw hold(error);
      }
    };
  } catch (error) {
    throw hold(error);
  }
}
