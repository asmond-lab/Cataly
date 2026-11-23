use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    net::TcpStream,
    sync::{Notify, mpsc},
    time::{Instant, sleep, sleep_until, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

use super::{Interaction, Snowflake, presence::online, threads::Routes, wake::Wake};

mod dispatch;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Deserialize)]
struct Frame {
    op: u8,
    s: Option<u64>,
    t: Option<String>,
    #[serde(default)]
    d: Value,
}

#[derive(Deserialize)]
struct Hello {
    heartbeat_interval: u64,
}

struct Resume {
    url: Url,
    id: String,
    sequence: u64,
}

enum Outcome {
    Reconnect,
    Restart,
    RateLimited,
    Fatal(u16),
}

pub(super) struct Link<'a> {
    pub(super) url: &'a Url,
    pub(super) token: &'a str,
    pub(super) intake: Option<IntakeLink<'a>>,
}

pub(super) struct IntakeLink<'a> {
    pub(super) channels: &'a [Snowflake],
    pub(super) owner: Snowflake,
    pub(super) wake: &'a Wake,
    pub(super) threads: Option<&'a Routes>,
    pub(super) inbox: &'a super::inbox::Inbox,
    pub(super) interactions: Option<mpsc::Sender<Interaction>>,
    pub(super) supervision: Option<Supervision<'a>>,
}

/// TS-parity FIFO admission (discord-inbound-live.ts): each accepted owner message is persisted with its
/// channel's admission cursor and thread scope before any delivery.
pub(super) struct Supervision<'a> {
    pub(super) cursors: &'a Path,
    /// `--scope-all`: every valid channel is accepted (discord-inbound.ts:125-127).
    pub(super) all: bool,
    pub(super) health: &'a Health,
}

/// The established connection's state for activity and receiver publication (`onHealth`/`onReady`).
#[derive(Default)]
pub(super) struct Health {
    connected: AtomicBool,
    generation: AtomicU64,
    notify: Notify,
}

impl Health {
    fn ready(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.connected.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    fn lost(&self) {
        if self.connected.swap(false, Ordering::AcqRel) {
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
        self.notify.notify_one();
    }

    fn ack(&self) {
        if self.connected.load(Ordering::Acquire) {
            self.notify.notify_one();
        }
    }

    /// Whether READY/RESUMED established the current connection, and that connection's generation.
    pub(super) fn snapshot(&self) -> (bool, u64) {
        (
            self.connected.load(Ordering::Acquire),
            self.generation.load(Ordering::Acquire),
        )
    }

    /// Resolves after a connection was established or retired, or a heartbeat was acknowledged.
    pub(super) async fn changed(&self) {
        self.notify.notified().await;
    }
}

impl Link<'_> {
    pub(super) async fn run(self) -> Result<()> {
        let mut resume = None;
        let presence = self.intake.is_none();
        let base_delay = if presence { 5 } else { 1 };
        let max_delay = if presence { 300 } else { 30 };
        let mut delay = base_delay;
        loop {
            let started = Instant::now();
            let mut minimum = 0;
            let outcome = self.connect(&mut resume).await;
            if let Some(health) = self.health() {
                health.lost();
            }
            match outcome {
                Ok(Outcome::Fatal(code)) => {
                    bail!("Discord Gateway closed with non-retryable code {code}")
                }
                Ok(Outcome::Restart) => resume = None,
                Ok(Outcome::Reconnect) | Err(_) => {}
                Ok(Outcome::RateLimited) => minimum = 60,
            }
            if started.elapsed() >= Duration::from_secs(30) {
                delay = base_delay;
            }
            let minimum = minimum.max(if resume.is_some() || presence { 1 } else { 6 });
            let wait = delay.max(minimum);
            if presence {
                println!("PRESENCE_RECONNECT discord delay_ms={}", wait * 1000);
            }
            sleep(Duration::from_secs(wait)).await;
            delay = (delay * 2).min(max_delay);
        }
    }

    async fn connect(&self, resume: &mut Option<Resume>) -> Result<Outcome> {
        let url = resume.as_ref().map_or(self.url, |state| &state.url);
        let config = WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let (mut ws, _) = timeout(
            Duration::from_secs(10),
            connect_async_with_config(url.as_str(), Some(config), true),
        )
        .await??;
        let hello = timeout(Duration::from_secs(10), ws.next())
            .await?
            .context("Discord Gateway closed before HELLO")??;
        let Message::Text(hello) = hello else {
            bail!("expected Discord Gateway HELLO");
        };
        let hello: Frame = serde_json::from_str(hello.as_str())?;
        ensure!(hello.op == 10, "expected Discord Gateway HELLO");
        let hello: Hello = serde_json::from_value(hello.d)?;
        ensure!(
            (100..=120_000).contains(&hello.heartbeat_interval),
            "invalid Discord Gateway heartbeat interval"
        );
        let interval = Duration::from_millis(hello.heartbeat_interval);
        let first = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
            % u128::from(hello.heartbeat_interval);
        let mut heartbeat = Instant::now() + Duration::from_millis(u64::try_from(first)?);
        let mut awaiting_ack = false;
        let handshake = Instant::now() + Duration::from_secs(20);
        let mut ready = false;
        let mut acknowledged = false;
        let mut heartbeat_seq = None;
        send(&mut ws, &self.authenticate(resume.as_ref())).await?;
        loop {
            tokio::select! {
                () = sleep_until(handshake), if !ready => return Ok(Outcome::Reconnect),
                () = sleep_until(heartbeat) => {
                    if awaiting_ack { return Ok(Outcome::Reconnect); }
                    beat(&mut ws, resume.as_ref()).await?;
                    heartbeat_seq = resume.as_ref().map(|state| state.sequence);
                    awaiting_ack = true;
                    heartbeat = Instant::now() + interval;
                }
                incoming = ws.next() => {
                    let Some(incoming) = incoming else { return Ok(Outcome::Reconnect); };
                    match incoming? {
                        Message::Text(text) => {
                            let frame: Frame = serde_json::from_str(text.as_str())?;
                            match frame.op {
                                0 => {
                                    let sequence = frame.s;
                                    let event = self.dispatch(frame, resume, &mut ready)?;
                                    if let (Some(state), Some(sequence)) = (resume.as_mut(), sequence) {
                                        state.sequence = state.sequence.max(sequence);
                                    }
                                    if self.intake.is_none() && let Some(event) = event {
                                        if event == "RESUMED" {
                                            send(&mut ws, &json!({"op": 3, "d": online()})).await?;
                                        }
                                        println!("PRESENCE_READY discord event={event}");
                                    }
                                }
                                1 => {
                                    beat(&mut ws, resume.as_ref()).await?;
                                    heartbeat_seq = resume.as_ref().map(|state| state.sequence);
                                    awaiting_ack = true;
                                }
                                7 => return Ok(Outcome::Reconnect),
                                9 if frame.d == Value::Bool(true) => return Ok(Outcome::Reconnect),
                                9 => return Ok(Outcome::Restart),
                                11 if awaiting_ack => {
                                    awaiting_ack = false;
                                    if ready && let Some(health) = self.health() {
                                        health.ack();
                                    }
                                    if self.intake.is_none() && !acknowledged {
                                        acknowledged = true;
                                        let seq = heartbeat_seq.map_or_else(|| "-".to_owned(), |seq| seq.to_string());
                                        println!("PRESENCE_ACK discord seq={seq}");
                                    }
                                }
                                _ => {}
                            }
                        }
                        Message::Ping(_) => timeout(Duration::from_secs(3), ws.flush()).await??,
                        Message::Close(Some(close)) => return Ok(match u16::from(close.code) {
                            code @ (4004 | 4010..=4014) => Outcome::Fatal(code),
                            4008 => Outcome::RateLimited,
                            1000 | 1001 | 4003 | 4005 | 4007 | 4009 => Outcome::Restart,
                            _ => Outcome::Reconnect,
                        }),
                        Message::Close(None) => return Ok(Outcome::Reconnect),
                        _ => {}
                    }
                }
            }
        }
    }

    fn health(&self) -> Option<&Health> {
        self.intake
            .as_ref()
            .and_then(|intake| intake.supervision.as_ref())
            .map(|supervision| supervision.health)
    }

    fn authenticate(&self, resume: Option<&Resume>) -> Value {
        resume.map_or_else(
            || {
                let mut identify = json!({"op": 2, "d": {"token": self.token, "intents": 1 << 9,
                    "properties": {"os": std::env::consts::OS, "browser": "cataly", "device": "cataly"}}});
                if let Some(intake) = &self.intake {
                    let guilds = u32::from(intake.threads.is_some());
                    identify["d"]["intents"] = json!((1 << 9) | (1 << 12) | (1 << 15) | guilds);
                } else {
                    identify["d"]["presence"] = online();
                }
                identify
            },
            |state| json!({"op": 6, "d": {"token": self.token, "session_id": state.id, "seq": state.sequence}}),
        )
    }
}

async fn beat(ws: &mut Socket, resume: Option<&Resume>) -> Result<()> {
    send(
        ws,
        &json!({"op": 1, "d": resume.map(|state| state.sequence)}),
    )
    .await
}

async fn send(ws: &mut Socket, value: &Value) -> Result<()> {
    timeout(
        Duration::from_secs(3),
        ws.send(Message::text(value.to_string())),
    )
    .await??;
    Ok(())
}
