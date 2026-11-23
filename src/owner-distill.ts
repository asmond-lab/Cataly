import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { underInboxLock } from "./duty-inbox.ts";
import { fill, promptFile, type Deps } from "./harness.ts";
import { ConfigError, readConfig } from "./hooks.ts";
import { localDate, ownerPaths, snapshotPath } from "./owner.ts";
import type { LoopRun } from "./store-types.ts";

/** `ownerDistillHour` in config.json: the local hour (0-23) from which the hourly loop asks for one distill a day. */
export function distillHour(root: string): number | undefined {
  const config = readConfig(root);
  const value: unknown = config === undefined ? undefined : Reflect.get(config, "ownerDistillHour");
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 23)
    throw new ConfigError(
      `config.json: ownerDistillHour must be a whole hour from 0 to 23, got ${JSON.stringify(value)}`,
    );
  return value;
}

function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/** Give each date its own procedure and acknowledge only a request admitted under the lead inbox lock. */
export function distillStep(d: Deps, run: LoopRun): void {
  const root = d.store.root;
  let hour: number | undefined;
  try {
    hour = distillHour(root);
  } catch (e) {
    run.findings.push(`owner distill: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const { profile, archive } = ownerPaths(root);
  const lead = () => d.store.roles().lead;
  if (hour === undefined || !lstatSync(profile, { throwIfNoEntry: false })?.isFile() || !lead()) return;
  const now = d.now();
  const today = localDate(now);
  const state = join(root, "loop", `owner-distill-${today}.json`);
  if (new Date(now).getHours() < hour || existsSync(state)) return;
  try {
    underInboxLock(d, lead, (inbox) => {
      if (!lead()) return;
      const procedure = join(root, "prompts", `owner-distill-${today}.md`);
      mkdirSync(join(root, "prompts"), { recursive: true });
      if (!existsSync(procedure)) {
        const vars = { cataly: d.catalyCmd, date: today, profile, archive, snapshot: snapshotPath(root, today) };
        writePrivate(procedure, fill(readFileSync(promptFile("owner-distill.md"), "utf8"), vars));
      }
      const text = `[OWNER-DISTILL ${today}] Update the owner profile once for today: read ${procedure} and follow it.`;
      d.store.enqueueOnce(inbox, { id: `owner-distill:${today}`, at: now, from: "loop", text });
      writePrivate(state, `${JSON.stringify({ date: today, at: now })}\n`);
      run.distill = text;
    });
  } catch (error) {
    run.findings.push(`owner distill: ${error instanceof Error ? error.message : String(error)}`);
  }
}
