import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./refusal.ts";
import { refFromText, refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Role } from "./store-types.ts";

type StoredRoles = Partial<Record<Role, string>>;
type Roles = Partial<Record<Role, SessionRef>>;
const fileOf = (root: string) => join(root, "roles.json");

function read(root: string): StoredRoles | undefined {
  try {
    return JSON.parse(readFileSync(fileOf(root), "utf8")) as StoredRoles;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function write(root: string, roles: StoredRoles): void {
  const path = fileOf(root);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(roles, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Keep ref strings readable by older binaries; bare values are herdr panes. */
export const readRoles = (root: string): Roles =>
  Object.fromEntries(Object.entries(read(root) ?? {}).map(([role, text]) => [role, refFromText(text)]));

export const registerRole = (root: string, role: Role, ref: SessionRef): void =>
  write(root, { ...read(root), [role]: refText(ref) });

/** Check the whole set before committing; an independently replaced registration is never removed. */
export function removeRoles(root: string, expected: readonly [Role, SessionRef][]): void {
  const raw = read(root);
  if (!raw || !expected.length) return;
  for (const [role, ref] of expected) {
    const current = raw[role];
    if (current !== undefined && !sameSession(ref, refFromText(current)))
      throw new Refusal(`role ${role} registration changed`);
    delete raw[role];
  }
  write(root, raw);
}
