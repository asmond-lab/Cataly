//! Discord owner-turn recall, a port of recall-discord.ts (`discordOwnerRecall`) and the ledger half of
//! recall-ledger.ts. The TypeScript lead side (`discordLeadRecall`) keeps writing `lead` rows to the same
//! `<cataly_state>/recall-scoped-v1.sqlite`, so this opens it exactly as Bun does: one connection per turn,
//! `busy_timeout=2000`, the default rollback journal and autocommit statements.

mod redact;
mod text;
mod unicode;

use std::fs::{self, DirBuilder, File, Metadata};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
use rusqlite::{Connection, OpenFlags, params};
use rustix::fs::{Mode, OFlags, open};
use rustix::io::Errno;

use super::Snowflake;
use super::inbound::Inbound;
use text::{Row, js_trim, points_at_past, rank_recall, recall_record, stored_text};

const DAY_MS: i64 = 24 * 60 * 60_000;
/// The newest rows of one space that a search ranks.
const CANDIDATES: i64 = 2000;
const STORE: &str = "recall-scoped-v1.sqlite";
const PLATFORM: &str = "discord";
const SCOPE_KEY: &str = "platform = ?1 AND bot_id = ?2 AND owner_id = ?3";
/// Byte-identical to recall-ledger.ts so `sqlite_schema` stays the same whichever side created the table.
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS scoped_turns (
        platform TEXT NOT NULL, bot_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        at INTEGER NOT NULL, channel TEXT NOT NULL, thread TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'lead')), text TEXT NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY (platform, bot_id, owner_id, channel, thread, role, ref));
      CREATE INDEX IF NOT EXISTS scoped_turns_space ON scoped_turns(platform, bot_id, owner_id, channel, at);";
const WARN_CHARS: usize = 300;

/// Recall for one authenticated bot and its owner; enabled by `--recall-retention-days`.
pub(super) struct Recall {
    state: PathBuf,
    retention_ms: i64,
    bot: String,
    owner: String,
}

impl Recall {
    /// Validates the scope only, like `createRecallScope`; the ledger itself is opened per turn.
    pub(super) fn open(
        cataly_state: &Path,
        retention_days: u32,
        bot: Snowflake,
        owner: Snowflake,
    ) -> Result<Self> {
        ensure!(
            (1..=3650).contains(&retention_days),
            "invalid recall.retentionDays: expected a whole number of days from 1 to 3650"
        );
        ensure!(
            bot != owner,
            "recall scope needs distinct positive bot and owner IDs"
        );
        ensure!(
            cataly_state.is_absolute(),
            "recall state directory must be absolute"
        );
        Ok(Self {
            state: cataly_state.to_path_buf(),
            retention_ms: i64::from(retention_days) * DAY_MS,
            bot: bot.to_string(),
            owner: owner.to_string(),
        })
    }

    /// Records the owner turn and, when it points back at an earlier conversation, returns the
    /// `INBOUND_RECALL discord <thread> <ref> <json>` line ranked from `space` only. `space` is the thread's
    /// parent channel (or the channel itself); `None` means it is not established and recall is skipped.
    /// Ledger failures are a `WARN recall: ...` on stderr, never a lost message.
    pub(super) fn recall(&self, inbound: &Inbound, space: Option<Snowflake>) -> Option<String> {
        if js_trim(&inbound.text).is_empty() {
            return None;
        }
        let space = space?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
            });
        self.owner(space, inbound.channel, inbound.message, &inbound.text, now)
            .unwrap_or_else(|error| {
                let message: String = format!("recall: {error:#}")
                    .chars()
                    .take(WARN_CHARS)
                    .collect();
                eprintln!("WARN {message}");
                None
            })
    }

    fn owner(
        &self,
        space: Snowflake,
        thread: Snowflake,
        reference: Snowflake,
        raw: &str,
        now: i64,
    ) -> Result<Option<String>> {
        let db = open_database(&self.state)?;
        db.busy_timeout(Duration::from_secs(2))?;
        db.execute_batch(SCHEMA)?;
        db.execute(
            &format!("DELETE FROM scoped_turns WHERE {SCOPE_KEY} AND at < ?4"),
            params![PLATFORM, self.bot, self.owner, now - self.retention_ms],
        )?;
        let (space, thread, reference) =
            (space.to_string(), thread.to_string(), reference.to_string());
        let text = stored_text(raw);
        let line = if points_at_past(&text) {
            let earlier: Vec<Row> = self
                .rows(&db, &space)?
                .into_iter()
                // A redelivered message never recalls itself.
                .filter(|(row, reference_of)| {
                    row.role != "owner" || row.thread != thread || *reference_of != reference
                })
                .map(|(row, _)| row)
                .collect();
            Some(format!(
                "INBOUND_RECALL {PLATFORM} {thread} {reference} {}",
                recall_record(&rank_recall(&text, earlier))
            ))
        } else {
            None
        };
        if !text.is_empty() {
            db.execute(
                "INSERT OR IGNORE INTO scoped_turns (platform, bot_id, owner_id, channel, thread, at, role, text, ref)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'owner', ?7, ?8)",
                params![PLATFORM, self.bot, self.owner, space, thread, now, text, reference],
            )?;
        }
        Ok(line)
    }

    /// Newest first from the space, including its sibling threads; each row with its `ref`.
    fn rows(&self, db: &Connection, space: &str) -> Result<Vec<(Row, String)>> {
        let mut statement = db.prepare(&format!(
            "SELECT at, platform, channel, thread, role, text, ref FROM scoped_turns
            WHERE {SCOPE_KEY} AND channel = ?4 ORDER BY at DESC LIMIT ?5"
        ))?;
        let rows = statement.query_map(
            params![PLATFORM, self.bot, self.owner, space, CANDIDATES],
            |row| {
                Ok((
                    Row {
                        at: row.get(0)?,
                        thread: lossy(row, 3)?,
                        role: lossy(row, 4)?,
                        text: lossy(row, 5)?,
                    },
                    lossy(row, 6)?,
                ))
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// Text written by Bun is valid UTF-8; a damaged row degrades to replacement characters instead of failing recall.
fn lossy(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<String> {
    Ok(String::from_utf8_lossy(row.get_ref(index)?.as_bytes()?).into_owned())
}

/// `privateFile`: regular, owned by this user, no group/other bits, a single link.
fn private_file(meta: &Metadata, uid: u32) -> Result<()> {
    ensure!(
        meta.is_file()
            && meta.uid() == uid
            && meta.mode().trailing_zeros() >= 6
            && meta.nlink() == 1,
        "recall ledger and sidecars must be private regular files owned by this user"
    );
    Ok(())
}

fn lstat(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("inspecting {}", path.display())),
    }
}

/// `openDatabase(stateDir, true)`: a private state directory under trusted parents and a private,
/// single-link ledger file (and sidecars) created with `O_EXCL | O_NOFOLLOW`.
fn open_database(state: &Path) -> Result<Connection> {
    let uid = rustix::process::getuid().as_raw();
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state)?;
    let dir = fs::canonicalize(state)?;
    let meta = fs::symlink_metadata(&dir)?;
    ensure!(
        meta.is_dir() && meta.uid() == uid && meta.mode() & 0o022 == 0,
        "recall state directory must be owned by this user and writable only by its owner"
    );
    for parent in dir.ancestors().skip(1) {
        let meta = fs::symlink_metadata(parent)?;
        let shared = meta.mode() & 0o022 != 0 && meta.mode() & 0o1000 == 0;
        if !meta.is_dir() || (meta.uid() != 0 && meta.uid() != uid) || shared {
            bail!("recall state has an untrusted parent directory");
        }
    }
    let path = dir.join(STORE);
    let existing = lstat(&path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.clone().into_os_string();
        sidecar.push(suffix);
        if let Some(meta) = lstat(Path::new(&sidecar))? {
            private_file(&meta, uid)?;
        }
    }
    if let Some(meta) = existing {
        private_file(&meta, uid)?;
    } else {
        match open(
            path.as_path(),
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        ) {
            Ok(fd) => private_file(&File::from(fd).metadata()?, uid)?,
            // Another recall process created it; validate the winner.
            Err(Errno::EXIST) => private_file(&fs::symlink_metadata(&path)?, uid)?,
            Err(error) => return Err(error).context("creating the recall ledger"),
        }
    }
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn id(value: u64) -> Snowflake {
        Snowflake::try_from(value.to_string()).unwrap()
    }

    fn state() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("cataly-recall-{}-{nonce}", std::process::id()));
        DirBuilder::new().mode(0o700).create(&path).unwrap();
        path
    }

    fn recalled(line: Option<String>) -> Vec<(String, String, String)> {
        let line = line.unwrap();
        let json = line.splitn(5, ' ').nth(4).unwrap();
        let record: serde_json::Value = serde_json::from_str(json).unwrap();
        record["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                let field = |name: &str| row[name].as_str().unwrap().to_owned();
                (field("role"), field("thread"), field("text"))
            })
            .collect()
    }

    // Mirrors skills/cataly-mode/scripts/test/recall-ledger.test.ts "a past reference recalls owner messages and
    // replies from every thread of the same channel only" and "a redelivered message ... never recalls itself",
    // with the lead row written through the same SQL the TypeScript lead side uses.
    #[test]
    fn owner_recall_matches_recall_ledger() {
        let dir = state();
        let recall = Recall::open(&dir, 30, id(99), id(10)).unwrap();
        let mut now = 1_795_176_000_000; // Date.UTC(2026, 10, 20, 12)
        let said = |space, thread, reference, text: &str, now| {
            recall
                .owner(id(space), id(thread), id(reference), text, now)
                .unwrap()
        };
        assert_eq!(
            said(20, 20, 1, "the deploy window is friday 18:00", now),
            None
        );
        now += 1000;
        said(20, 21, 3, "ok, keep the deploy window note", now);
        now += 1000;
        let db = open_database(&dir).unwrap();
        db.execute(
            "INSERT OR IGNORE INTO scoped_turns (platform, bot_id, owner_id, channel, thread, at, role, text, ref)
              VALUES ('discord', '99', '10', '20', '21', ?1, 'lead', 'moved the deploy window to monday', '2')",
            [now],
        )
        .unwrap();
        drop(db);
        said(30, 30, 4, "other channel: deploy window secret plan", now);
        said(40, 40, 5, "dm: deploy window in a DM", now);
        now += 1000;
        let line = said(
            20,
            20,
            6,
            "what was the deploy window we discussed last time?",
            now,
        );
        assert!(
            line.as_deref()
                .unwrap()
                .starts_with("INBOUND_RECALL discord 20 6 {")
        );
        let expected = [
            ("owner", "20", "the deploy window is friday 18:00"),
            ("owner", "21", "ok, keep the deploy window note"),
            ("lead", "21", "moved the deploy window to monday"),
        ]
        .map(|(role, thread, text)| (role.to_owned(), thread.to_owned(), text.to_owned()));
        assert_eq!(recalled(line), expected);
        assert_eq!(recalled(said(40, 40, 7, "저번에 말한 배포 일정", now)), []);
        assert_eq!(
            recalled(said(50, 50, 8, "earlier: rotate the staging key", now)),
            []
        );
        // The same message again: its owner turn is already recorded and still excluded from its own recall.
        assert_eq!(
            recalled(said(50, 50, 8, "earlier: rotate the staging key", now)),
            []
        );
        let mode = fs::metadata(dir.join(STORE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
        // Retention: eight days later with a seven-day window nothing earlier survives.
        let short = Recall::open(&dir, 7, id(99), id(10)).unwrap();
        let line = short
            .owner(id(20), id(20), id(9), "yesterday deploy?", now + 8 * DAY_MS)
            .unwrap();
        assert_eq!(recalled(line), []);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn group_writable_state_is_refused_without_a_ledger() {
        let dir = state();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o770)).unwrap();
        let recall = Recall::open(&dir, 30, id(99), id(10)).unwrap();
        let error = recall.owner(id(20), id(20), id(1), "x", 0).unwrap_err();
        assert!(error.to_string().contains("writable only by its owner"));
        assert!(!dir.join(STORE).exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
