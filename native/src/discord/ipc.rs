//! The supervising extension's JSON IPC channel, inherited on fd 0 (Bun `serialization: "json"`): one
//! `JSON.stringify(value) + "\n"` per message in each direction. Requests carry a fresh UUID v4 `request`; a
//! reply is routed to the exchange that sent it. EOF, an oversized or malformed frame, or a failed write
//! disconnects the channel: every pending exchange fails and the monitor exits 1 after closing its stores
//! (cli-context.ts:31-44 `exitOnDisconnect`).

use std::collections::HashMap;
use std::fs::File;
use std::io::Read as _;
use std::os::fd::AsFd as _;
use std::os::unix::fs::FileTypeExt as _;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{oneshot, watch};

/// Head admission content is at most 1 MiB; JSON escaping and envelope fields stay well inside 64 KiB more.
const LINE_LIMIT: usize = 1024 * 1024 + 64 * 1024;
const PENDING_LIMIT: usize = 64;

type Pending = HashMap<String, oneshot::Sender<Value>>;

struct Shared {
    pending: Mutex<Option<Pending>>,
    closed: watch::Sender<bool>,
}

impl Shared {
    /// Fails every pending exchange, refuses new ones and wakes the disconnect watcher.
    fn disconnect(&self) {
        let drained = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(drained);
        self.closed.send_replace(true);
    }

    /// Records a pending exchange; refused after disconnect or past the pending limit.
    fn register(&self, request: String, send: oneshot::Sender<Value>) -> Result<()> {
        let mut guard = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(pending) = guard.as_mut() else {
            return Err(Disconnected.into());
        };
        ensure!(
            pending.len() < PENDING_LIMIT,
            "too many pending IPC exchanges"
        );
        pending.insert(request, send);
        drop(guard);
        Ok(())
    }
}

struct Forget<'a> {
    shared: &'a Shared,
    request: &'a str,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        if let Some(pending) = self
            .shared
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            pending.remove(self.request);
        }
    }
}

pub(super) struct Ipc {
    shared: Arc<Shared>,
    writer: tokio::sync::Mutex<OwnedWriteHalf>,
    closed: watch::Receiver<bool>,
    reader: tokio::task::JoinHandle<()>,
}

/// The exchange ended without a reply: the outcome is unknown and must never be replayed.
#[derive(Debug)]
pub(super) struct Disconnected;

impl std::fmt::Display for Disconnected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the supervising IPC channel disconnected")
    }
}

impl std::error::Error for Disconnected {}

impl Ipc {
    /// Adopts fd 0. The descriptor is marked close-on-exec so no spawned process can keep the channel alive.
    pub(super) fn open() -> Result<Self> {
        let stdin = std::io::stdin();
        let fd = stdin.as_fd();
        rustix::io::fcntl_setfd(fd, rustix::io::FdFlags::CLOEXEC)?;
        let channel = File::from(rustix::io::fcntl_dupfd_cloexec(fd, 3)?);
        ensure!(
            channel
                .metadata()
                .context("inspecting the supervising IPC channel")?
                .file_type()
                .is_socket(),
            "--supervised needs the extension's IPC socket on standard input"
        );
        let socket = std::os::unix::net::UnixStream::from(std::os::fd::OwnedFd::from(channel));
        // Bun leaves its IPC descriptor nonblocking; tokio needs that too.
        socket.set_nonblocking(true)?;
        let (read, write) = UnixStream::from_std(socket)?.into_split();
        let (closed_send, closed) = watch::channel(false);
        let shared = Arc::new(Shared {
            pending: Mutex::new(Some(HashMap::new())),
            closed: closed_send,
        });
        let reader = tokio::spawn(read_loop(read, Arc::clone(&shared)));
        Ok(Self {
            shared,
            writer: tokio::sync::Mutex::new(write),
            closed,
            reader,
        })
    }

    /// Sends `message` (an object) with a fresh `request` and waits for the reply that echoes it.
    pub(super) async fn exchange(&self, mut message: Map<String, Value>) -> Result<Value> {
        let request = random_uuid()?;
        let (send, receive) = oneshot::channel();
        self.shared.register(request.clone(), send)?;
        // An abandoned or failed exchange forgets its request; a late reply is then ignored.
        let _forget = Forget {
            shared: &self.shared,
            request: &request,
        };
        message.insert("request".to_owned(), Value::String(request.clone()));
        self.send(&Value::Object(message)).await?;
        receive.await.map_err(|_| Disconnected.into())
    }

    async fn send(&self, value: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(value)?;
        line.push(b'\n');
        let mut writer = self.writer.lock().await;
        let written = async {
            writer.write_all(&line).await?;
            writer.flush().await
        }
        .await;
        if written.is_err() {
            self.shared.disconnect();
            return Err(Disconnected.into());
        }
        Ok(())
    }

    /// Resolves once the channel has disconnected.
    pub(super) async fn disconnected(&self) {
        let mut closed = self.closed.clone();
        drop(closed.wait_for(|closed| *closed).await);
    }
}

impl Drop for Ipc {
    fn drop(&mut self) {
        self.reader.abort();
        self.shared.disconnect();
    }
}

async fn read_loop(read: OwnedReadHalf, shared: Arc<Shared>) {
    let mut reader = BufReader::new(read);
    let mut line = Vec::new();
    loop {
        line.clear();
        match read_line(&mut reader, &mut line).await {
            Ok(true) => {}
            Ok(false) => break,
            Err(error) => {
                eprintln!("DISCORD_IPC_DISCONNECTED: {error:#}");
                break;
            }
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            eprintln!("DISCORD_IPC_DISCONNECTED: invalid frame");
            break;
        };
        let Some(request) = value.get("request").and_then(Value::as_str) else {
            continue;
        };
        let waiter = shared
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
            .and_then(|pending| pending.remove(request));
        if let Some(waiter) = waiter {
            // The exchange may have been abandoned; its reply is then irrelevant.
            drop(waiter.send(value));
        }
    }
    shared.disconnect();
}

/// Reads one `\n`-terminated frame (without the delimiter); `false` at a clean EOF.
async fn read_line(reader: &mut BufReader<OwnedReadHalf>, line: &mut Vec<u8>) -> Result<bool> {
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            ensure!(line.is_empty(), "the IPC channel closed inside a frame");
            return Ok(false);
        }
        let (taken, done) = buffer
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or((buffer.len(), false), |end| (end, true));
        if line.len() + taken > LINE_LIMIT {
            bail!("an IPC frame exceeded {LINE_LIMIT} bytes");
        }
        line.extend_from_slice(&buffer[..taken]);
        reader.consume(taken + usize::from(done));
        if done {
            return Ok(true);
        }
    }
}

/// An RFC 4122 version 4 UUID string (`crypto.randomUUID` format).
pub(super) fn random_uuid() -> Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .context("reading /dev/urandom")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .fold(String::with_capacity(32), |mut hex, byte| {
            use std::fmt::Write as _;
            // Writing to a String cannot fail.
            let _ = write!(hex, "{byte:02x}");
            hex
        });
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

#[cfg(test)]
mod tests {
    use super::random_uuid;

    #[test]
    fn uuid_is_version_4() {
        let id = random_uuid().unwrap();
        assert_eq!(id.len(), 36);
        let bytes = id.as_bytes();
        assert_eq!(bytes[14], b'4');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
        assert!(
            id.bytes().all(
                |byte| byte == b'-' || (byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            )
        );
        assert_ne!(random_uuid().unwrap(), id);
    }
}
