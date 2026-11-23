//! The detached headless runtime's on-disk records and local HTTP endpoint (`src/runtime/headless-record.ts`,
//! `headless-lifecycle.ts`, `discord-lane-headless-state.ts`).
//!
//! `<state>/headless/<uuid>/` holds `reservation.json`, `started`, `endpoint.json`, `stopped.json` and the lane
//! extension's `discord-lane.json`, each owner-only. A broker (`headless-broker.ts`) serves `{"op":"observe"}` and
//! friends over the Unix socket named in `endpoint.json`, authorized by its 64-hex key.

use std::collections::BTreeMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail, ensure};
use serde::Serialize;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

use super::json::Json;
use super::registry::{Lane, int_field};
use super::util::{
    RECORD_LIMIT, is_uuid, iso, now_ms, parse_iso, read_limited, replace_file, uuid,
};

const OBSERVE_DEADLINE: Duration = Duration::from_secs(20);
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;

/// A headless session reference (`{runtime:"headless", id, group?}`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct HeadlessRef {
    pub(super) id: String,
    pub(super) group: Option<Json>,
}

impl HeadlessRef {
    pub(super) fn of(lane: &Lane) -> Option<Self> {
        let reference = lane.session_ref()?;
        // `...(prior.group ? { group } : {})`: only a truthy group is carried to a new reservation.
        let group = lane
            .0
            .get("sessionRef")
            .filter(|reference| reference.truthy("group"))
            .and_then(|reference| reference.get("group"))
            .cloned();
        (reference.runtime() == Some("headless")).then(|| Self {
            id: reference.id().unwrap_or_default().to_owned(),
            group,
        })
    }

    pub(super) fn json(&self) -> Json {
        let mut fields = vec![
            ("runtime", Json::string("headless")),
            ("id", Json::string(&self.id)),
        ];
        if let Some(group) = &self.group {
            fields.push(("group", group.clone()));
        }
        Json::object(fields)
    }
}

fn data_dir(state: &Path) -> PathBuf {
    state.join("headless")
}

/// `laneDir`: refuses an id that is not a lowercase UUID.
pub(super) fn lane_dir(state: &Path, reference: &HeadlessRef) -> Result<PathBuf> {
    ensure!(
        is_uuid(&reference.id, false),
        "invalid headless session ref"
    );
    Ok(data_dir(state).join(&reference.id))
}

fn uid() -> u32 {
    rustix::process::getuid().as_raw()
}

/// `privateDir`.
fn private_dir(dir: &Path) -> Result<()> {
    let stat = fs::symlink_metadata(dir)?;
    ensure!(
        stat.is_dir() && stat.uid() == uid() && stat.mode().trailing_zeros() >= 6,
        "headless state directory is not owner-only"
    );
    Ok(())
}

/// `readPrivate`: absent is `None`; a non-private file or non-object record is an error.
pub(super) fn read_private(path: &Path) -> Result<Option<Json>> {
    let stat = match fs::symlink_metadata(path) {
        Ok(stat) => stat,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        stat.is_file() && stat.uid() == uid() && stat.mode().trailing_zeros() >= 6,
        "headless state file is not owner-only"
    );
    let bytes = match read_limited(path, RECORD_LIMIT) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let value: Json = serde_json::from_slice(&bytes)?;
    ensure!(value.is_object(), "invalid headless state record");
    Ok(Some(value))
}

/// `writePrivate`: `JSON.stringify(value)` to `<path>.<uuid>` (exclusive, 0600), then rename.
fn write_private(path: &Path, value: &Json) -> Result<()> {
    let temporary = super::util::sibling(path, &format!(".{}", uuid()?));
    replace_file(path, &temporary, &value.compact())
}

pub(super) struct Entry {
    pub(super) dir: PathBuf,
    pub(super) reservation: Json,
}

/// `laneEntry`.
pub(super) fn lane_entry(state: &Path, reference: &HeadlessRef) -> Result<Option<Entry>> {
    let dir = lane_dir(state, reference)?;
    if !data_dir(state).exists() || !dir.exists() {
        return Ok(None);
    }
    private_dir(&data_dir(state))?;
    private_dir(&dir)?;
    let reservation = read_private(&dir.join("reservation.json"))?;
    let valid = reservation.as_ref().is_some_and(|reservation| {
        let reference_ok = reservation.get("ref").is_some_and(|r| {
            r.str("runtime") == Some("headless") && r.str("id") == Some(reference.id.as_str())
        });
        let role_ok = reservation.get("role").is_none_or(|role| {
            matches!(
                role.as_str(),
                Some("lane" | "lead" | "duty" | "duty-loop" | "hourly-loop")
            )
        });
        reference_ok && role_ok
    });
    let Some(reservation) = reservation.filter(|_| valid) else {
        bail!("headless reservation identity unreadable");
    };
    Ok(Some(Entry { dir, reservation }))
}

/// A broker observation (`HeadlessObservation`) as far as lane checks read it.
#[derive(Debug, Default)]
pub(super) struct Observation {
    pub(super) id: Option<String>,
    pub(super) runtime: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) status: String,
    pub(super) pid: Option<i64>,
    pub(super) role: Option<String>,
    pub(super) session_id: Option<String>,
    pub(super) session_file: Option<String>,
    pub(super) model: Option<String>,
    pub(super) held: bool,
    pub(super) dialogs: usize,
    pub(super) detail: bool,
}

impl Observation {
    fn base(status: &str, reference: &HeadlessRef, entry: Option<&Entry>) -> Self {
        let reserved = entry.and_then(|entry| entry.reservation.get("ref"));
        Self {
            id: Some(
                reserved
                    .and_then(|r| r.str("id"))
                    .unwrap_or(reference.id.as_str())
                    .to_owned(),
            ),
            runtime: Some("headless".to_owned()),
            cwd: entry
                .and_then(|entry| entry.reservation.str("cwd"))
                .map(str::to_owned),
            status: status.to_owned(),
            held: true,
            ..Self::default()
        }
    }

    fn parse(value: &Json) -> Result<Self> {
        let text = |key: &str| value.str(key).map(str::to_owned);
        // parseCatalyRole; an unrecognized role is an invalid observation.
        let role = match value.get("role") {
            None => None,
            Some(role) => match role.as_str() {
                Some("lane") => Some("lane".to_owned()),
                Some("cataly" | "dori") => Some("cataly".to_owned()),
                _ => bail!("invalid headless runtime role"),
            },
        };
        let reference = value.get("ref");
        Ok(Self {
            id: reference.and_then(|r| r.str("id")).map(str::to_owned),
            runtime: reference.and_then(|r| r.str("runtime")).map(str::to_owned),
            cwd: text("cwd"),
            status: text("status").unwrap_or_default(),
            pid: int_field(value, "pid"),
            role,
            session_id: text("sessionId"),
            session_file: text("sessionFile"),
            model: text("model"),
            held: !matches!(value.get("held"), Some(Json::Bool(false))),
            dialogs: match value.get("dialogs") {
                Some(Json::Array(items)) => items.len(),
                _ => 1,
            },
            detail: value.get("detail").is_some(),
        })
    }
}

fn endpoint_socket(endpoint: &Json) -> Option<(&str, &str)> {
    let socket = endpoint.str("socket")?;
    let name = socket
        .strip_prefix("/tmp/cataly-rpc-")?
        .strip_suffix("/socket")?;
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    endpoint.str("key").map(|key| (socket, key))
}

/// One HTTP/1.1 POST over the broker's Unix socket; returns the reply body.
async fn post(socket: &str, key: &str, body: &str) -> Result<Vec<u8>> {
    let mut stream = tokio::net::UnixStream::connect(socket).await?;
    let request = format!(
        "POST / HTTP/1.1\r\nHost: localhost\r\nAuthorization: {key}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    let mut bytes = Vec::new();
    let mut chunk = vec![0_u8; 16 * 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        ensure!(
            bytes.len() + read <= RESPONSE_LIMIT,
            "headless reply too large"
        );
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(body) = complete_body(&bytes, false)? {
            return Ok(body);
        }
    }
    complete_body(&bytes, true)?.ok_or_else(|| anyhow!("incomplete headless reply"))
}

/// The body of a complete HTTP response in `bytes`, or `None` while more bytes are needed. At `eof`, a response
/// without a length runs to the end of the stream.
fn complete_body(bytes: &[u8], eof: bool) -> Result<Option<Vec<u8>>> {
    let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Ok(None);
    };
    let head = std::str::from_utf8(&bytes[..end])?;
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap_or_default();
    let code = status.split(' ').nth(1).unwrap_or_default();
    ensure!(code.starts_with('2'), "HTTP {code}");
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.parse::<usize>()?);
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && value.eq_ignore_ascii_case("chunked")
        {
            chunked = true;
        }
    }
    let rest = &bytes[end + 4..];
    if chunked {
        let mut body = Vec::new();
        let mut at = 0;
        loop {
            let Some(line) = rest[at..].windows(2).position(|w| w == b"\r\n") else {
                return Ok(None);
            };
            let size_text = std::str::from_utf8(&rest[at..at + line])?;
            let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)?;
            at += line + 2;
            if size == 0 {
                return Ok(Some(body));
            }
            if rest.len() < at + size + 2 {
                return Ok(None);
            }
            body.extend_from_slice(&rest[at..at + size]);
            at += size + 2;
        }
    }
    let complete = length.map_or(eof, |length| rest.len() >= length);
    Ok(complete.then(|| rest[..length.unwrap_or(rest.len())].to_vec()))
}

/// `requestHost(stateDir, ref, request)`; transport failures are errors.
async fn request_host(entry: &Entry, request: &Json) -> Result<Json> {
    let endpoint = read_private(&entry.dir.join("endpoint.json"))?
        .ok_or_else(|| anyhow!("headless host endpoint missing or invalid"))?;
    let (socket, key) = endpoint_socket(&endpoint)
        .ok_or_else(|| anyhow!("headless host endpoint missing or invalid"))?;
    let body = tokio::time::timeout(OBSERVE_DEADLINE, post(socket, key, &request.compact()))
        .await
        .context("headless local transport unconfirmed")??;
    let reply: Json = serde_json::from_slice(&body).context("invalid response")?;
    match reply.get("ok") {
        Some(Json::Bool(true)) => Ok(reply.get("value").cloned().unwrap_or(Json::Null)),
        Some(Json::Bool(false)) => bail!("{}", reply.str("error").unwrap_or("headless host error")),
        _ => bail!("invalid response"),
    }
}

/// `observeHost`.
pub(super) async fn observe(state: &Path, reference: &HeadlessRef) -> Result<Observation> {
    let entry = lane_entry(state, reference)?;
    let Some(entry) = entry else {
        return Ok(Observation::base("gone", reference, None));
    };
    if let Some(stopped) = read_private(&entry.dir.join("stopped.json"))? {
        let mut seen = Observation::base("gone", reference, Some(&entry));
        seen.detail = stopped.truthy("detail");
        return Ok(seen);
    }
    if read_private(&entry.dir.join("endpoint.json"))?.is_none() {
        return Ok(Observation::base("unknown", reference, Some(&entry)));
    }
    let observed = request_host(&entry, &Json::object(vec![("op", Json::string("observe"))]))
        .await
        .and_then(|value| Observation::parse(&value));
    Ok(observed.unwrap_or_else(|_| {
        let mut seen = Observation::base("unknown", reference, Some(&entry));
        seen.detail = true;
        seen
    }))
}

/// `listHosts` restricted to what lane gates read: every non-gone headless session.
pub(super) async fn hosts(state: &Path) -> Result<Vec<(HeadlessRef, Observation)>> {
    let base = data_dir(state);
    if !base.exists() {
        return Ok(Vec::new());
    }
    private_dir(&base)?;
    let mut ids = Vec::new();
    for entry in fs::read_dir(base)? {
        let name = entry?.file_name();
        if let Some(name) = name.to_str()
            && is_uuid(name, false)
        {
            ids.push(name.to_owned());
        }
    }
    ids.sort();
    let mut out = Vec::new();
    for id in ids {
        let reference = HeadlessRef { id, group: None };
        if lane_entry(state, &reference)?.is_none() {
            continue;
        }
        let seen = observe(state, &reference).await?;
        if seen.status != "gone" {
            out.push((reference, seen));
        }
    }
    Ok(out)
}

/// The extension's `discord-lane.json` activation record, verified against the lane (`headlessDiscordReceiver`).
pub(super) struct Binding {
    pub(super) reference: HeadlessRef,
    pub(super) receiver: Json,
    pub(super) stopped: Option<Json>,
}

impl Binding {
    pub(super) fn session(&self) -> &str {
        self.receiver.str("session").unwrap_or_default()
    }

    pub(super) fn file(&self) -> &str {
        self.receiver.str("file").unwrap_or_default()
    }

    pub(super) fn cwd(&self) -> &str {
        self.receiver.str("cwd").unwrap_or_default()
    }

    pub(super) fn pid(&self) -> i64 {
        int_field(&self.receiver, "pid").unwrap_or(0)
    }

    pub(super) fn retired_goal(&self) -> Option<&Json> {
        self.receiver.get("retiredGoal")
    }
}

fn realpath(path: &str) -> Result<String> {
    fs::canonicalize(path)?
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow!("path is not UTF-8"))
}

/// `headlessDiscordReceiver(stateDir, lane)`.
pub(super) fn receiver(state: &Path, lane: &Lane) -> Result<Option<Binding>> {
    let Some(reference) = HeadlessRef::of(lane) else {
        return Ok(None);
    };
    let (Some(session), Some(file), Some(cwd)) = (lane.session(), lane.session_file(), lane.cwd())
    else {
        return Ok(None);
    };
    let Some(entry) = lane_entry(state, &reference)? else {
        return Ok(None);
    };
    let Some(receiver) = read_private(&entry.dir.join("discord-lane.json"))? else {
        return Ok(None);
    };
    let updated = receiver.str("updatedAt").and_then(parse_iso);
    let started = entry.reservation.str("startedAt").and_then(parse_iso);
    let opened = lane.0.str("openedAt").and_then(parse_iso);
    let fresh = match (updated, started, opened) {
        (Some(updated), Some(started), Some(opened)) => {
            updated >= started.max(opened) && updated <= now_ms() + 1000
        }
        _ => false,
    };
    let valid = receiver.str("session") == Some(session)
        && receiver.str("file") == Some(file)
        && receiver.str("cwd") == Some(realpath(cwd)?.as_str())
        && receiver.str("cwd") == entry.reservation.str("cwd")
        && int_field(&receiver, "pid").is_some_and(|pid| pid > 0)
        && fresh;
    if !valid {
        return Ok(None);
    }
    let stopped = read_private(&entry.dir.join("stopped.json"))?;
    Ok(Some(Binding {
        reference,
        receiver,
        stopped,
    }))
}

/// `headlessDiscordLaneAvailable(stateDir, lane)` (not for dispatch).
pub(super) async fn available(state: &Path, lane: &Lane) -> Result<bool> {
    let Some(binding) = receiver(state, lane)? else {
        return Ok(false);
    };
    if let Some(stopped) = &binding.stopped {
        return Ok(stopped.str("closedSessionId") == Some(binding.session())
            && binding.retired_goal().is_some());
    }
    if binding.retired_goal().is_some() {
        return Ok(false);
    }
    let seen = observe(state, &binding.reference).await?;
    Ok(live_receiver(&seen, &binding))
}

fn live_receiver(seen: &Observation, binding: &Binding) -> bool {
    seen.runtime.as_deref() == Some("headless")
        && seen.id.as_deref() == Some(binding.reference.id.as_str())
        && !seen.detail
        && matches!(seen.status.as_str(), "idle" | "working" | "blocked")
        && seen.role.as_deref() == Some("lane")
        && seen.pid == Some(binding.pid())
        && seen.session_id.as_deref() == Some(binding.session())
        && seen.session_file.as_deref() == Some(binding.file())
        && seen.cwd.as_deref() == Some(binding.cwd())
}

/// `HeadlessRuntime.create`: a fresh owner-only reservation for one lane role session.
pub(super) fn reserve(
    state: &Path,
    name: &str,
    cwd: &Path,
    group: Option<Json>,
) -> Result<HeadlessRef> {
    let reference = HeadlessRef { id: uuid()?, group };
    let cwd = fs::canonicalize(cwd)?
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow!("lane directory is not UTF-8"))?;
    let base = data_dir(state);
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)?;
    private_dir(&base)?;
    let dir = lane_dir(state, &reference)?;
    DirBuilder::new().mode(0o700).create(&dir)?;
    write_private(
        &dir.join("reservation.json"),
        &Json::object(vec![
            ("ref", reference.json()),
            ("cwd", Json::string(&cwd)),
            ("name", Json::string(name)),
            ("role", Json::string("lane")),
            ("startedAt", Json::string(&iso(now_ms()))),
        ]),
    )?;
    Ok(reference)
}

/// `HostStart`, streamed to the broker's stdin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStart<'a> {
    argv: &'a [String],
    env: &'a BTreeMap<String, String>,
    expected_resume_id: &'a str,
}

const SETSID: [&str; 2] = ["/usr/bin/setsid", "/bin/setsid"];

const HOST_ENV_REMOVED: [&str; 7] = [
    "HC_TERMINAL_ID",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "CATALY_HEADLESS_ID",
    "CATALY_ASK_LAUNCHED_LANE",
    "CATALY_HARNESS_ROLE",
];

/// `startHost` for a lane resume: claims `started`, then spawns the detached broker with the start record on stdin.
/// Startup is proven later by attestation; this never waits for the native session.
pub(super) async fn start(
    state: &Path,
    reference: &HeadlessRef,
    broker: &[String],
    argv: &[String],
    mut env: BTreeMap<String, String>,
    resume: (&str, &str),
) -> Result<()> {
    let entry =
        lane_entry(state, reference)?.ok_or_else(|| anyhow!("headless reservation missing"))?;
    ensure!(
        entry.reservation.str("role").unwrap_or("lane") == "lane",
        "native start role mismatch"
    );
    ensure!(
        !entry.dir.join("stopped.json").exists(),
        "headless reservation has stopped"
    );
    // A competing start/close gets the same exclusive file. Never retry a spawn after ambiguity.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(entry.dir.join("started"))
        .context("headless reservation already started")?;
    for key in HOST_ENV_REMOVED {
        env.remove(key);
    }
    let (file, session) = resume;
    let mut argv = argv.to_vec();
    argv.push(format!("--resume={file}"));
    let start = serde_json::to_vec(&HostStart {
        argv: &argv,
        env: &env,
        expected_resume_id: session,
    })?;
    let (program, prefix) = broker
        .split_first()
        .ok_or_else(|| anyhow!("no headless broker"))?;
    // `spawn(..., { detached: true })` calls setsid(2). `unsafe_code = "forbid"` rules out `pre_exec`, so the
    // util-linux `setsid` program does it where present (it execs without forking: the child is no group leader);
    // elsewhere the broker gets its own process group, which still keeps terminal job-control signals away.
    let setsid = SETSID
        .into_iter()
        .map(Path::new)
        .find(|path| path.is_file());
    let mut command = tokio::process::Command::new(setsid.unwrap_or_else(|| Path::new(program)));
    if setsid.is_some() {
        command.arg(program);
    } else {
        command.process_group(0);
    }
    command
        .args(prefix)
        .arg(&entry.dir)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    // Secrets are streamed to the child, not persisted or inserted into argv.
    for key in ["PATH", "HOME", "TMPDIR"] {
        if let Some(value) = env.get(key) {
            command.env(key, value);
        }
    }
    let mut child = command
        .spawn()
        .context("headless supervisor start unconfirmed")?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("headless supervisor input pipe unavailable"))?;
    stdin
        .write_all(&start)
        .await
        .context("headless supervisor start unconfirmed")?;
    // EOF ends the record (`Bun.stdin.json()`).
    drop(stdin);
    // Dropping the handle leaves the broker running; tokio reaps it if it exits while this process lives.
    drop(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_bodies() {
        let reply = b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}";
        assert_eq!(
            complete_body(reply, false).unwrap().unwrap(),
            b"{\"ok\":true}"
        );
        assert!(
            complete_body(&reply[..reply.len() - 1], false)
                .unwrap()
                .is_none()
        );
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n";
        assert_eq!(complete_body(chunked, false).unwrap().unwrap(), b"abc");
        assert!(
            complete_body(
                b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n",
                false
            )
            .is_err()
        );
        assert_eq!(
            complete_body(b"HTTP/1.1 200 OK\r\n\r\n{}", true)
                .unwrap()
                .unwrap(),
            b"{}"
        );
    }

    #[test]
    fn endpoints_must_be_private_tmp_sockets() {
        let ok: Json =
            serde_json::from_str(r#"{"socket":"/tmp/cataly-rpc-Ab1/socket","key":"k"}"#).unwrap();
        assert_eq!(
            endpoint_socket(&ok),
            Some(("/tmp/cataly-rpc-Ab1/socket", "k"))
        );
        let bad: Json = serde_json::from_str(r#"{"socket":"/tmp/x/socket","key":"k"}"#).unwrap();
        assert_eq!(endpoint_socket(&bad), None);
    }
}
