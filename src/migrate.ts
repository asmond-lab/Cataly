import { readFileSync } from "node:fs";
import { join } from "node:path";
import { need, one, USAGE, type Args } from "./cli-args.ts";
import { shq } from "./delivery.ts";
import {
  agentCommand,
  harnessLaneEnv,
  harnessLaunchEnv,
  isOmpAgentCommand,
  prompt,
  rolePrompt,
  type Deps,
} from "./harness.ts";
import type { ControllerRole } from "./loop-controller.ts";
import { Refusal } from "./refusal.ts";
import { askCheckpoint, capture, type MigrateOpts, type Subject } from "./migrate-capture.ts";
import { swapAgent, swapLoop } from "./migrate-swap.ts";
import { refText } from "./refs.ts";
import { readRuntimeChoice } from "./runtime/select.ts";
import type { SessionRef } from "./runtime/types.ts";
import {
  createJournal,
  lockMigration,
  type MigrateJournal,
  readJournal,
  removeJournal,
  writeJournal,
} from "./store-journal.ts";
import type { Lane, Role } from "./store-types.ts";

export type Target = { readonly lane?: string; readonly role?: Role; readonly all?: boolean };

const LOOP_ROLES: readonly ControllerRole[] = ["duty-loop", "hourly-loop"];
const ROLE_NAMES: readonly Role[] = ["lead", "duty", ...LOOP_ROLES];
const isOpen = (l: Lane): boolean => l.status !== "done" && l.status !== "lost";

function migratableLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane || !isOpen(lane)) throw new Refusal(`no open lane ${key}`);
  // The terminal replacement does not inherit or authenticate the source's native policy binding.
  if (lane.sessionRef.runtime === "headless" || readJournal(d.store.root, key)?.from.runtime === "headless")
    throw new Refusal(`MIGRATION HELD ${key}: the terminal handoff cannot authenticate this native lane's policy`);
  return lane;
}

function laneSubject(d: Deps, key: string): Subject {
  const lane = migratableLane(d, key);
  const kickoff = (brief: string) => `Read your brief at ${brief} and execute it. Your lane key is ${key}.`;
  const save = (change: (l: Lane) => Lane): void => {
    d.store.updateLane(key, (current) => {
      if (!current || current.createdAt !== lane.createdAt || (lane.noticeId && current.noticeId !== lane.noticeId))
        throw new Refusal(`lane ${key} registration changed during migration`);
      return change(current);
    });
  };
  return {
    name: key,
    kind: "lane",
    from: lane.sessionRef,
    cwd: lane.cwd,
    brief: () => readFileSync(lane.brief, "utf8"),
    footer: prompt("lane-footer.md", { key, cataly: d.catalyCmd }),
    logTail: lane.log.slice(-20).map((e) => `- ${new Date(e.at).toISOString()} ${e.kind}: ${e.text}`),
    ...(lane.sessionPath === undefined ? {} : { sessionPath: lane.sessionPath }),
    spec: (group) => ({
      name: key,
      role: "lane",
      container: "tab",
      cwd: lane.cwd,
      env: harnessLaneEnv(d, key),
      ...(group === undefined ? {} : { group }),
    }),
    command: (brief) => `${agentCommand(d, "lane")} ${shq(kickoff(brief))}`,
    setHold: (on) => save(({ migration: _, ...l }) => (on ? { ...l, migration: true } : l)),
    switchTo: (ref) =>
      save((l) => ({ ...l, sessionRef: ref, migratedFrom: [...(l.migratedFrom ?? []), l.sessionRef] })),
  };
}

function roleSubject(d: Deps, role: Role, from: SessionRef): Subject {
  const name = role === "lead" ? "lead.md" : "duty.md";
  return {
    name: role,
    kind: "role",
    from,
    cwd: process.cwd(),
    brief: () => rolePrompt(d, name),
    logTail: [],
    spec: (group) => ({
      name: role === "lead" ? "cataly" : "duty",
      role,
      container: "tab",
      cwd: process.cwd(),
      env: harnessLaunchEnv(d),
      ...(group === undefined ? {} : { group }),
    }),
    command: (brief) => `${agentCommand(d, "cataly")} --append-system-prompt ${shq(brief)}`,
    setHold: () => {},
    switchTo: (ref) => d.store.setRole(role, ref),
  };
}

/** --resume: only a live source that is idle or done, with its agent's session file on record. */
async function resumeCommand(d: Deps, s: Subject): Promise<string> {
  const { status, sessionFile } = await d.runtimes.for(s.from).probe(s.from);
  const sessionPath = sessionFile ?? s.sessionPath;
  if (sessionPath === undefined)
    throw new Refusal(`--resume refused for ${s.name}: no recorded session path; migrate without --resume`);
  if (status !== "idle" && status !== "done")
    throw new Refusal(`--resume refused for ${s.name}: its session is ${status}, not idle or done`);
  const command = agentCommand(d, s.kind === "lane" ? "lane" : "cataly");
  return isOmpAgentCommand(d.agentCmd)
    ? `${command} --resume=${shq(sessionPath)}`
    : `${command} --session ${shq(sessionPath)}`;
}

/** Steps (1)-(3) for an agent session, then the swap. Resumes at the journal's phase. */
async function agentSession(d: Deps, s: Subject, j: MigrateJournal | undefined, opts: MigrateOpts) {
  let resume: string | undefined;
  if (j === undefined) {
    if (opts.resume) resume = await resumeCommand(d, s);
    j = { name: s.name, kind: s.kind, phase: "hold", from: s.from, to: opts.to, at: d.now() };
    if (!createJournal(d.store.root, j)) throw new Refusal(`another cataly harness migrate of ${s.name} is running`);
    s.setHold(true);
  }
  if (j.phase === "hold" && j.briefPath === undefined) {
    const asked = resume === undefined ? await askCheckpoint(d, s, opts) : "stopped";
    if (asked === "blocked" || asked === "working") {
      removeJournal(d.store.root, s.name);
      s.setHold(false);
      opts.log(`DEFERRED ${s.name} ${asked === "blocked" ? "blocked" : `working past ${opts.waitMinutes} min`}`);
      return 0;
    }
    j = { ...j, briefPath: await capture(d, s, j, asked === "gone") };
    writeJournal(d.store.root, j);
  }
  return swapAgent(d, s, j, resume ?? s.command(j.briefPath ?? ""), opts);
}

async function migrateName(d: Deps, name: string, from: SessionRef, opts: MigrateOpts, sub: () => Subject) {
  const journal = () => {
    const j = readJournal(d.store.root, name);
    if (j !== undefined && j.to !== opts.to)
      throw new Refusal(`a migration of ${name} is in progress toward ${j.to}; finish it with --to ${j.to}`);
    return j;
  };
  const skip = () => {
    opts.log(`SKIP ${name} already on ${opts.to}`);
    return 0;
  };
  if (opts.dryRun) {
    const j = journal();
    if (!j && from.runtime === opts.to) return skip();
    const what = j === undefined ? `inbox entries: ${d.store.queued(from).length}` : `resume at ${j.phase}`;
    opts.log(`PLAN ${name} ${refText(from)} -> ${opts.to} (${what})`);
    return 0;
  }
  const release = lockMigration(d.store.root, name, d.now());
  if (!release) throw new Refusal(`another cataly harness migrate of ${name} is running`);
  try {
    const j = journal();
    const role = LOOP_ROLES.find((role) => role === name);
    if (role) {
      const current = d.store.roles()[role];
      if (!current) throw new Refusal(`no ${role} session registered`);
      if (!j && current.runtime === opts.to) return skip();
      return await swapLoop(d, role, j ?? fresh(d, name, current, opts), process.cwd(), opts);
    }
    const subject = sub();
    if (!j && subject.from.runtime === opts.to) return skip();
    return await agentSession(d, subject, j, opts);
  } finally {
    release();
  }
}

function fresh(d: Deps, name: string, from: SessionRef, opts: MigrateOpts): MigrateJournal {
  const j: MigrateJournal = { name, kind: "role", phase: "hold", from, to: opts.to, at: d.now() };
  if (!createJournal(d.store.root, j)) throw new Refusal(`another cataly harness migrate of ${name} is running`);
  return j;
}

/**
 * `cataly migrate`: hands sessions over to `opts.to`. `--all` = every open lane, then lead and duty, then the duty loop
 * and the hourly loop. Returns the exit code: 3 when any session rolled back, else 0.
 */
export async function migrate(d: Deps, t: Target, opts: MigrateOpts): Promise<number> {
  const lanes = t.all
    ? d.store
        .lanes()
        .filter(isOpen)
        .map((l) => l.key)
    : t.lane
      ? [t.lane]
      : [];
  const roles = t.all ? ROLE_NAMES : t.role ? [t.role] : [];
  if (lanes.length + roles.length === 0) throw new Refusal(`give --lane K, --role R or --all\n\n${USAGE}`);
  // Preflight every requested lane before an --all handoff changes any of them.
  for (const key of lanes) migratableLane(d, key);
  const registeredRoles = d.store.roles();
  for (const role of roles) {
    if (registeredRoles[role]?.runtime === "headless")
      throw new Refusal(`headless role ${role} cannot migrate to a terminal; use cataly harness stop first`);
  }
  let code = 0;
  for (const key of lanes) {
    const lane = migratableLane(d, key);
    code = Math.max(code, await migrateName(d, key, lane.sessionRef, opts, () => laneSubject(d, key)));
  }
  for (const role of roles) {
    const ref = registeredRoles[role];
    if (!ref) {
      if (t.all) continue;
      throw new Refusal(`no ${role} session registered`);
    }
    code = Math.max(code, await migrateName(d, role, ref, opts, () => roleSubject(d, role, ref)));
  }
  return code;
}

export async function runMigrate(d: Deps, a: Args): Promise<number> {
  const to =
    one(a, "to") ??
    readRuntimeChoice({
      env: process.env,
      configPath: process.env["CATALY_CONFIG"] ?? join(d.store.root, "config.json"),
      terminalOnly: true,
    }).kind;
  if (to !== "herdr" && to !== "hc" && to !== "tern") throw new Refusal(`--to must be herdr, hc or tern`);
  const role = one(a, "role") as Role | undefined;
  if (role !== undefined && !ROLE_NAMES.includes(role))
    throw new Refusal(`--role must be one of ${ROLE_NAMES.join(", ")}`);
  const wait = Number(one(a, "wait-minutes") ?? "10");
  if (!(Number.isFinite(wait) && wait >= 0)) throw new Refusal("--wait-minutes must be a number of minutes, 0 or more");
  const lane = one(a, "lane");
  if (lane !== undefined) need(lane, "--lane key");
  return migrate(
    d,
    { ...(lane === undefined ? {} : { lane }), ...(role === undefined ? {} : { role }), all: one(a, "all") === "true" },
    {
      to,
      dryRun: one(a, "dry-run") === "true",
      waitMinutes: wait,
      resume: one(a, "resume") === "true",
      sleep: Bun.sleep,
      log: console.log,
    },
  );
}
