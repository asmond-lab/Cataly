import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import { proveLegacyTerminalGone } from "./release/legacy-terminal-proof.ts";
import { parseRef, type SessionRef, type TerminalRuntimeKind } from "./runtime/types.ts";
import { captureSetupFile, publishSetupFile, readSetupFile } from "./setup-files.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";
import { object } from "./update/config.ts";

/** A legacy role has no ownership receipt. Retire registrations only; never close any terminal. */
export async function retireLegacyRoles(d: Deps): Promise<number> {
  const entries = Object.entries(d.store.roles()) as [Role, SessionRef][];
  const byRuntime = new Map<TerminalRuntimeKind, SessionRef[]>();
  for (const [role, ref] of entries) {
    if (!RESERVED_KEYS.includes(role) || ref.runtime === "headless" || !parseRef(refText(ref)))
      throw new Refusal(`role ${role} has no verified legacy terminal address; its registration was left unchanged`);
    const refs = byRuntime.get(ref.runtime) ?? [];
    refs.push(ref);
    byRuntime.set(ref.runtime, refs);
  }
  for (const [kind, refs] of byRuntime) {
    const rt = d.runtimes.terminal(kind);
    try {
      const listed = await rt.list();
      for (const ref of refs) {
        if (listed.some((row) => sameSession(row.ref, ref)) || (await rt.probe(ref)).status !== "gone")
          throw new Error(`${refText(ref)} is still present or its exit is not proven`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Refusal(
        `Legacy roles left unchanged: ${reason}. Use the original ${kind} binary/server context to close your terminals yourself, then retry cataly harness stop.`,
      );
    }
  }
  // All registered refs were proven gone before changing any registration.
  d.store.clearRoles(entries);
  return entries.length;
}

export type LegacySessionSelection = {
  readonly configured: string | undefined;
  readonly migrated: string | undefined;
};

type HistoricalHome = {
  readonly home: string;
  readonly root: string;
  readonly primary: boolean;
  readonly runtime: TerminalRuntimeKind;
  readonly sessions: LegacySessionSelection;
};

function namespace(options: HistoricalHome, runtime: TerminalRuntimeKind): string {
  if (!options.primary) return `omp-dori-${createHash("sha256").update(options.root).digest("hex").slice(0, 12)}`;
  const configured = runtime === options.runtime;
  const session = configured ? options.sessions.configured : options.sessions.migrated;
  const flag = configured ? "--legacy-session" : "--legacy-migrated-session";
  if (!session || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(session))
    throw new Refusal(
      `Primary v0.1.3 did not record the ${runtime} server name; pass ${flag} with its original name (default for an unnamed server)`,
    );
  return session;
}

/** Called only under the consumer, harness and launch locks in a verified stopped historical home. */
export async function retireHistoricalRegistrations(
  options: HistoricalHome,
  recheckStopped: () => void,
): Promise<number> {
  if (!options.primary && (options.sessions.configured !== undefined || options.sessions.migrated !== undefined))
    throw new Refusal("A side release fixes its own historical namespaces; omit the legacy session flags");
  const snapshot = captureSetupFile(join(options.root, "roles.json"));
  const bytes = readSetupFile(snapshot);
  if (!bytes) return 0;
  const roles: unknown = JSON.parse(bytes.toString("utf8"));
  if (!object(roles)) throw new Refusal("Uncertain roles.json; no registrations were changed");
  const entries = Object.entries(roles);
  const byRuntime = new Map<TerminalRuntimeKind, SessionRef[]>();
  for (const [role, value] of entries) {
    const ref = typeof value === "string" && parseRef(value);
    if (!RESERVED_KEYS.some((key) => key === role) || !ref || ref.runtime === "headless")
      throw new Refusal(
        `Unrecognized or foreign role registration ${JSON.stringify(role)}; no registrations were changed`,
      );
    const refs = byRuntime.get(ref.runtime) ?? [];
    refs.push(ref);
    byRuntime.set(ref.runtime, refs);
  }
  if (entries.length === 0) return 0;
  // Resolve every namespace before reading endpoints and recheck all of their identities before committing.
  const required = [...byRuntime].map(([runtime, refs]) => ({ runtime, refs, session: namespace(options, runtime) }));
  const proofs: (() => void)[] = [];
  for (const { runtime, refs, session } of required)
    proofs.push(
      await proveLegacyTerminalGone({ home: options.home, primary: options.primary, runtime, session }, refs),
    );
  recheckStopped();
  for (const assertSameEndpoint of proofs) assertSameEndpoint();
  publishSetupFile(snapshot, "{}\n");
  return entries.length;
}
