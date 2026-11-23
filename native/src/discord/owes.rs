//! `recordOwes` (owes.ts:96-140, owes-file.ts, owes-writer.ts): every head-bound owner request is owed until
//! its read mark and complete reply exist. The same `owes/inbound.jsonl`, writer reservation and lock file.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde_json::Value;

use super::inbound::quoted;
use super::lanes::lock::take_lock;

const KEEP_LINES: usize = 200;
const RETRY: Duration = Duration::from_millis(50);
const TEXT_UNITS: usize = 500;

/// One parsed obligation line, kept as its exact `JSON.stringify` text.
#[derive(Debug, PartialEq, Eq)]
struct Owe {
    id: String,
    line: String,
}

/// ECMAScript `\s` / `trim` whitespace: Unicode `White_Space` without NEL, plus the BOM.
const fn js_whitespace(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

/// `raw.replace(/^(?:\[[^\]]*\] )?/, "")`.
fn strip_prefix(raw: &str) -> &str {
    raw.strip_prefix('[')
        .and_then(|rest| rest.find(']').map(|end| &rest[end + 1..]))
        .and_then(|rest| rest.strip_prefix(' '))
        .unwrap_or(raw)
}

/// `\d{1,20}` followed by a single space.
fn digits(text: &str) -> Option<(&str, &str)> {
    let end = text.bytes().take_while(u8::is_ascii_digit).count();
    if !(1..=20).contains(&end) {
        return None;
    }
    let (number, rest) = text.split_at(end);
    Some((number, rest.strip_prefix(' ')?))
}

/// The owner text after `ref=\S* `, or `""` when the remainder holds a line terminator `.` cannot match.
fn quoted_body(rest: &str) -> &str {
    let Some(rest) = rest.strip_prefix("ref=") else {
        return "";
    };
    let end = rest.find(js_whitespace).unwrap_or(rest.len());
    let Some(body) = rest[end..].strip_prefix(' ') else {
        return "";
    };
    if body.contains(['\r', '\u{2028}', '\u{2029}']) {
        return "";
    }
    body
}

/// `JSON.stringify` of `text.slice(0, 500)`: the cut counts UTF-16 units and may leave a lone high surrogate,
/// which `JSON.stringify` escapes.
fn truncated(text: &str) -> String {
    let mut units = 0;
    for (offset, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if units + width > TEXT_UNITS {
            let mut json = quoted(&text[..offset]);
            if units < TEXT_UNITS {
                use std::fmt::Write as _;
                json.pop();
                let mut pair = [0_u16; 2];
                let high = ch.encode_utf16(&mut pair)[0];
                // Writing to a String cannot fail.
                let _ = write!(json, "\\u{high:04x}\"");
            }
            return json;
        }
        units += width;
    }
    quoted(text)
}

/// `owesInText` (owes.ts:99-118).
fn owes_in_text(text: &str, at: u64) -> Vec<Owe> {
    let mut found = Vec::new();
    for raw in text.split('\n') {
        let line = strip_prefix(raw).trim_end_matches(js_whitespace);
        let Some(rest) = line.strip_prefix("INBOUND discord ") else {
            continue;
        };
        let Some((channel, rest)) = digits(rest) else {
            continue;
        };
        let Some((message, rest)) = digits(rest) else {
            continue;
        };
        let Some(rest) = rest.strip_prefix("from=owner") else {
            continue;
        };
        if rest
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            continue;
        }
        let raw_body = quoted_body(rest.strip_prefix(' ').unwrap_or(""));
        let body = match serde_json::from_str::<Value>(raw_body) {
            Ok(Value::String(decoded)) => decoded,
            _ => raw_body.to_owned(),
        };
        let id = format!("{channel}:{message}");
        let line = format!(
            "{{\"id\":{},\"channel\":{},\"message\":{},\"at\":{at},\"text\":{}}}",
            quoted(&id),
            quoted(channel),
            quoted(message),
            truncated(&body)
        );
        found.push(Owe { id, line });
    }
    found
}

/// `parse(line, isOwe)?.id`.
fn owe_id(line: &str) -> Option<String> {
    let Value::Object(owe) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let text = |key: &str| matches!(owe.get(key), Some(Value::String(_)));
    let at = owe
        .get("at")
        .and_then(Value::as_f64)
        .is_some_and(f64::is_finite);
    if !(text("channel") && text("message") && text("text") && at) {
        return None;
    }
    match owe.get("id") {
        Some(Value::String(id)) => Some(id.clone()),
        _ => None,
    }
}

fn read_lines(path: &Path) -> Result<Vec<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes)
            .split('\n')
            .filter(|line| !line.trim_matches(js_whitespace).is_empty())
            .map(str::to_owned)
            .collect()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

/// `openReservation` (owes-writer.ts:4-15): a private, never-shared database file used only for its lock.
fn reservation(path: &Path) -> Result<Connection> {
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
    {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let stat = fs::symlink_metadata(path)?;
    ensure!(
        stat.is_file()
            && stat.nlink() == 1
            && stat.uid() == rustix::process::geteuid().as_raw()
            && stat.mode().trailing_zeros() >= 6,
        "owes writer reservation is not a private regular file"
    );
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    // bun:sqlite waits for nobody: a busy reservation means "retry after 50 ms".
    db.busy_timeout(Duration::ZERO)?;
    Ok(db)
}

/// One `tryOwesWriter` + `takeLock` round; `None` while another writer holds either.
fn try_update(path: &Path, owes: &[Owe]) -> Result<Option<usize>> {
    let reservation =
        reservation(&path.with_file_name(format!("{}.writer.sqlite", file_name(path))))?;
    match reservation.execute_batch("BEGIN IMMEDIATE") {
        Ok(()) => {}
        Err(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == ErrorCode::DatabaseBusy =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    }
    let result = locked_update(path, owes);
    reservation.execute_batch("ROLLBACK")?;
    result
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
}

fn locked_update(path: &Path, owes: &[Owe]) -> Result<Option<usize>> {
    let lock = path.with_file_name(format!("{}.lock", file_name(path)));
    let Ok(lock) = take_lock(&lock, true)? else {
        return Ok(None);
    };
    let result = append(path, owes);
    lock.release()?;
    result.map(Some)
}

/// The synchronous read-modify-publish under both locks; never spans an await.
fn append(path: &Path, owes: &[Owe]) -> Result<usize> {
    let mut lines = read_lines(path)?;
    let mut known: Vec<Option<String>> = lines.iter().map(|line| owe_id(line)).collect();
    let mut fresh = 0;
    for owe in owes {
        if known
            .iter()
            .any(|id| id.as_deref() == Some(owe.id.as_str()))
        {
            continue;
        }
        known.push(Some(owe.id.clone()));
        lines.push(owe.line.clone());
        fresh += 1;
    }
    if fresh > 0 {
        let temporary =
            path.with_file_name(format!("{}.{}.tmp", file_name(path), std::process::id()));
        let keep = &lines[lines.len().saturating_sub(KEEP_LINES)..];
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(format!("{}\n", keep.join("\n")).as_bytes())?;
        drop(file);
        fs::rename(&temporary, path)?;
    }
    Ok(fresh)
}

/// Publishes the obligations in one head delivery; returns how many new message identifiers were committed.
pub(super) async fn record(cataly_state: &Path, text: &str) -> Result<usize> {
    let at = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
    let owes = owes_in_text(text, at);
    if owes.is_empty() {
        return Ok(0);
    }
    let dir = cataly_state.join("owes");
    match DirBuilder::new().recursive(true).mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("creating the owes directory"),
    }
    let path = dir.join("inbound.jsonl");
    loop {
        if let Some(fresh) = try_update(&path, &owes)? {
            return Ok(fresh);
        }
        tokio::time::sleep(RETRY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_inbound_lines_like_owes_in_text() {
        let text = concat!(
            "[discord] INBOUND discord 20 101 from=owner ref=- \"hi \\\"you\\\"\"\n",
            "INBOUND_REPLY discord 20 101 {}\n",
            "INBOUND discord 20 102 from=ownerX ref=- \"no\"\n",
            "INBOUND discord 20 103 from=owner ref=9 not-json  \r"
        );
        let owes = owes_in_text(text, 5);
        assert_eq!(owes.len(), 2);
        assert_eq!(
            owes[0].line,
            r#"{"id":"20:101","channel":"20","message":"101","at":5,"text":"hi \"you\""}"#
        );
        assert_eq!(
            owes[1].line,
            r#"{"id":"20:103","channel":"20","message":"103","at":5,"text":"not-json"}"#
        );
        assert_eq!(owe_id(&owes[1].line).as_deref(), Some("20:103"));
        assert_eq!(owe_id(r#"{"id":"x"}"#), None);
    }

    #[test]
    fn truncates_by_utf16_units_like_slice() {
        let long = "a".repeat(499) + "\u{1f600}tail";
        assert_eq!(truncated(&long), format!("\"{}\\ud83d\"", "a".repeat(499)));
        assert_eq!(
            truncated(&"b".repeat(600)),
            format!("\"{}\"", "b".repeat(500))
        );
        assert_eq!(truncated("short"), "\"short\"");
    }

    #[tokio::test]
    async fn record_is_idempotent_and_keeps_the_last_lines() {
        let dir = std::env::temp_dir().join(format!(
            "cataly-owes-{}",
            crate::discord::ipc::random_uuid().unwrap()
        ));
        DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let line = "INBOUND discord 20 101 from=owner ref=- \"x\"";
        assert_eq!(record(&dir, line).await.unwrap(), 1);
        assert_eq!(record(&dir, line).await.unwrap(), 0);
        let path = dir.join("owes/inbound.jsonl");
        let mut many = String::new();
        for message in 200..450 {
            use std::fmt::Write as _;
            writeln!(many, "INBOUND discord 20 {message} from=owner ref=- \"y\"").unwrap();
        }
        assert_eq!(record(&dir, &many).await.unwrap(), 250);
        let lines = read_lines(&path).unwrap();
        assert_eq!(lines.len(), KEEP_LINES);
        assert!(lines[KEEP_LINES - 1].contains("\"20:449\""));
        assert!(!dir.join("owes/inbound.jsonl.lock").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
