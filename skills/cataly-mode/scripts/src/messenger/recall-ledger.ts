import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";
import {
  pointsAtPast,
  rankRecall,
  type RecallConversation,
  type RecallPlatform,
  type RecallRow,
  recallRecord,
  type RecallSettings,
  storedText,
} from "./recall-text.ts";

const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
/** The newest rows of one space that a search ranks. */
const CANDIDATES = 2000;
const STORE = "recall-scoped-v1.sqlite";
const SCOPE_KEY = "platform = ? AND bot_id = ? AND owner_id = ?";
const VALIDATED_SCOPE = Symbol("recall scope");

export type RecallScope = {
  readonly [VALIDATED_SCOPE]: true;
  readonly platform: RecallPlatform;
  readonly botId: string;
  readonly ownerId: string;
};

const validatedScopes = new WeakSet<RecallScope>();
const discordId = (id: unknown): id is string => isDiscordSnowflake(id) && id.trim() === id;
const telegramId = (id: unknown, signed = false): id is string =>
  typeof id === "string" &&
  id.trim() === id &&
  /^-?[1-9]\d{0,15}$/.test(id) &&
  (signed || !id.startsWith("-")) &&
  Number.isSafeInteger(Number(id));

/** Validate stable IDs only. The caller establishes identity; this does not authenticate an account. */
export const createRecallScope = (platform: unknown, botId: unknown, ownerId: unknown): RecallScope => {
  if (platform !== "discord" && platform !== "telegram")
    throw new MessengerError("recall scope platform must be discord or telegram", 0);
  const validId = platform === "discord" ? discordId : telegramId;
  if (!validId(botId) || !validId(ownerId) || botId === ownerId)
    throw new MessengerError("recall scope needs distinct positive bot and owner IDs", 0);
  const scope: RecallScope = Object.freeze({ [VALIDATED_SCOPE]: true as const, platform, botId, ownerId });
  validatedScopes.add(scope);
  return scope;
};

const scopeKey = (scope: RecallScope) => {
  if (!validatedScopes.has(scope))
    throw new MessengerError("recall scope must be validated before accessing storage", 0);
  return [scope.platform, scope.botId, scope.ownerId] as const;
};

/** Check ID syntax only; for Discord, the caller is responsible for establishing the parent. */
export const validateRecallConversation = (
  platform: RecallPlatform,
  conversation: RecallConversation,
): RecallConversation => {
  const channel = conversation?.channel;
  const thread = conversation?.thread;
  if (typeof channel === "string" && typeof thread === "string") {
    const valid =
      platform === "discord"
        ? discordId(channel) && discordId(thread)
        : telegramId(channel, true) &&
          (thread === channel || (thread.startsWith(`${channel}/`) && telegramId(thread.slice(channel.length + 1))));
    if (valid) return { channel, thread };
  }
  throw new MessengerError("recall requires an explicit space and conversation with valid IDs", 0);
};

type RecordedTurn = Pick<RecallRow, "at" | "role" | "text" | "ref">;

export type RecallLedger = {
  record(conversation: RecallConversation, turn: RecordedTurn): void;
  /** Newest first from the supplied space, including its sibling threads. */
  rows(conversation: RecallConversation): RecallRow[];
  close(): void;
};
const privateFile = (stat: Stats, uid: number): void => {
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1)
    throw new MessengerError("recall ledger and sidecars must be private regular files owned by this user", 0);
};

function openDatabase(stateDir: string, create: true): Database;
function openDatabase(stateDir: string, create: false): Database | undefined;
function openDatabase(stateDir: string, create: boolean): Database | undefined {
  if (!create && !lstatSync(stateDir, { throwIfNoEntry: false })) return undefined;
  const uid = process.platform === "win32" ? undefined : process.getuid?.();
  if (uid === undefined) throw new MessengerError("recall ledger requires POSIX file ownership and permissions", 0);
  if (create) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dir = realpathSync(stateDir);
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0)
    throw new MessengerError("recall state directory must be owned by this user and writable only by its owner", 0);
  for (let at = dirname(dir); ; at = dirname(at)) {
    const parent = lstatSync(at);
    const shared = (parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0;
    if (!parent.isDirectory() || (parent.uid !== 0 && parent.uid !== uid) || shared)
      throw new MessengerError("recall state has an untrusted parent directory", 0);
    if (at === dirname(at)) break;
  }
  const path = join(dir, STORE);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing && !create) return undefined;
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
    if (sidecar) privateFile(sidecar, uid);
  }
  if (existing) privateFile(existing, uid);
  else {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      // Another recall process created it; validate the winner without opening a second descriptor on its inode.
      privateFile(lstatSync(path), uid);
    }
    if (fd !== undefined) {
      try {
        privateFile(fstatSync(fd), uid);
      } finally {
        closeSync(fd);
      }
    }
  }
  return new Database(path, { readwrite: true, create: false });
}

/** Opens the owner-only scoped schema. Only this identity's expired rows are dropped on open. */
export const openRecallLedger = (
  stateDir: string,
  scope: RecallScope,
  { settings, now }: { readonly settings: RecallSettings | undefined; readonly now: number },
): RecallLedger => {
  const identity = scopeKey(scope);
  const db = openDatabase(stateDir, true);
  try {
    db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS scoped_turns (
        platform TEXT NOT NULL, bot_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        at INTEGER NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'lead')), text TEXT NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY (platform, bot_id, owner_id, channel, thread, role, ref));
      CREATE INDEX IF NOT EXISTS scoped_turns_space ON scoped_turns(platform, bot_id, owner_id, channel, at);`);
    db.query(`DELETE FROM scoped_turns WHERE ${SCOPE_KEY} AND at < ?`).run(
      ...identity,
      now - (settings?.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS,
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    record(conversation, turn) {
      const { channel, thread } = validateRecallConversation(scope.platform, conversation);
      const text = storedText(turn.text);
      if (text === "") return;
      db.query(
        `INSERT OR IGNORE INTO scoped_turns (platform, bot_id, owner_id, channel, thread, at, role, text, ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...identity, channel, thread, turn.at, turn.role, text, turn.ref);
    },
    rows(conversation) {
      const { channel } = validateRecallConversation(scope.platform, conversation);
      return db
        .query<RecallRow, [string, string, string, string, number]>(
          `SELECT at, platform, channel, thread, role, text, ref FROM scoped_turns
            WHERE ${SCOPE_KEY} AND channel = ? ORDER BY at DESC LIMIT ?`,
        )
        .all(...identity, channel, CANDIDATES);
    },
    close: () => db.close(),
  };
};

/** Logical deletion only, without initializing storage or applying retention to other identities. */
export const purgeRecallLedger = (stateDir: string, scope: RecallScope): number => {
  const identity = scopeKey(scope);
  const db = openDatabase(stateDir, false);
  if (!db) return 0;
  try {
    db.exec("PRAGMA busy_timeout=2000");
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'scoped_turns'").get()) return 0;
    return db.query(`DELETE FROM scoped_turns WHERE ${SCOPE_KEY}`).run(...identity).changes;
  } finally {
    db.close();
  }
};

type Turn = RecallConversation & Pick<RecallRow, "ref" | "text">;

/**
 * The messenger side of recall, or undefined while it is off. `owner` records an owner message and, when it points
 * back at an earlier conversation, returns the `INBOUND_RECALL` record ranked from the same space only. Both owner
 * and lead use the caller's verified space; stored rows never establish thread parentage. Ledger failures are warnings.
 */
export const conversationRecall = (
  config: { readonly stateDir: string; readonly recall?: RecallSettings; readonly scope: RecallScope },
  warn: (message: string) => void,
  clock: () => number = Date.now,
) => {
  if (config.recall?.enabled !== true) return undefined;
  const { scope } = config;
  const withLedger = <T>(
    turn: Turn,
    use: (ledger: RecallLedger, now: number, conversation: RecallConversation) => T,
  ): T | undefined => {
    try {
      const now = clock();
      const conversation = validateRecallConversation(scope.platform, turn);
      const ledger = openRecallLedger(config.stateDir, scope, { settings: config.recall, now });
      try {
        return use(ledger, now, conversation);
      } finally {
        ledger.close();
      }
    } catch (error) {
      warn(`recall: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      return undefined;
    }
  };
  return {
    owner: (turn: Turn): string | undefined =>
      withLedger(turn, (ledger, now, conversation) => {
        const text = storedText(turn.text);
        let record: string | undefined;
        if (pointsAtPast(text)) {
          const earlier = ledger
            .rows(conversation)
            .filter((row) => !(row.role === "owner" && row.thread === conversation.thread && row.ref === turn.ref));
          record = `INBOUND_RECALL ${scope.platform} ${conversation.thread} ${turn.ref} ${recallRecord(rankRecall(text, earlier))}`;
        }
        ledger.record(conversation, { at: now, role: "owner", ref: turn.ref, text: turn.text });
        return record;
      }),
    lead: (turn: Turn): void => {
      if (turn.text.trim() === "") return;
      withLedger(turn, (ledger, now, conversation) => {
        ledger.record(conversation, { at: now, role: "lead", ref: turn.ref, text: turn.text });
      });
    },
  };
};
