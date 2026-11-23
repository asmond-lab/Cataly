//! `--wake-lanes`: start a retired Discord lane's exact saved OMP session (`discord-lane-wake.ts`,
//! `discord-lane-headless-wake.ts`, `discord-lane-wake-pending.ts`, `discord-lane-wake-lease.ts`).
//!
//! Every wake runs under the detached Bun headless broker (`src/runtime/headless-broker.ts`), never in a herdr or hc
//! pane: Rust reserves `<state>/headless/<uuid>/`, claims `started`, streams the `HostStart` record to the broker and
//! attests the result through the broker's own `observe` endpoint and the lane extension's `discord-lane.json`.
//! Registry transitions are `discord-wake-pending:<uuid>` before any side effect, `discord-wake-pending:bound:<uuid>`
//! once the new reservation is recorded, and `<uuid>` after attestation; a restarted monitor re-attests a bound wake
//! and never starts a second process for it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};
use serde::Deserialize;
use tokio::io::AsyncReadExt as _;

use super::command::{WakeCommand, headless_argv, wake_command};
use super::guard::{Guard, can_launch};
use super::headless::{self, HeadlessRef};
use super::json::Json;
use super::registry::{
    Lane, RESERVED_LANE_KEY, Registry, SessionRef, pane_role, pane_state, record_execution,
    valid_key,
};
use super::route::delivery_lock;
use super::transcript;
use super::util::{now_ms, parse_iso, signalable, uuid};

const PREFIX: &str = "discord-wake-pending:";
const BOUND_PREFIX: &str = "discord-wake-pending:bound:";
const LEASE_DEADLINE: Duration = Duration::from_secs(8);
const LEASE_OUTPUT: u64 = 64 * 1024;
/// `WAIT_FOR_HOST`: how long a start may take to prove its native session.
const STARTUP_DEADLINE: Duration = Duration::from_secs(65);
const STARTUP_POLL: Duration = Duration::from_millis(250);

/// The Bun CLI's resolved launch context, exported as `CATALY_DISCORD_LANE_LAUNCH` before it execs this binary.
pub(super) const LAUNCH_ENV: &str = "CATALY_DISCORD_LANE_LAUNCH";

/// Never handed to a lane or to OMP: the monitor's IPC wiring, its secrets and its own launch context.
const PRIVATE_ENV: [&str; 11] = [
    "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "CATALY_MONITOR_ADMISSION",
    "CATALY_MONITOR_ADMISSION_PROTOCOL",
    "DORI_MONITOR_ADMISSION",
    "CATALY_ASK_ROUTING_STATE",
    LAUNCH_ENV,
    "CATALY_DISCORD_TOKEN",
    "DORI_DISCORD_TOKEN",
    "CATALY_TELEGRAM_TOKEN",
    "DORI_TELEGRAM_TOKEN",
];

pub(super) fn is_pending(epoch: Option<&str>) -> bool {
    epoch.is_some_and(|epoch| epoch.starts_with(PREFIX))
}

fn completed(epoch: &str) -> Option<&str> {
    epoch.strip_prefix(BOUND_PREFIX)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchRecord {
    agent_command: Vec<String>,
    sessions_dir: PathBuf,
    guard: Guard,
    env: BTreeMap<String, String>,
    wake_config: PathBuf,
    broker: Vec<String>,
}

/// What a wake needs from the loaded TypeScript config.
pub(super) struct Launch {
    command: Option<WakeCommand>,
    sessions_dir: PathBuf,
    guard: Guard,
    lane_env: BTreeMap<String, String>,
    wake_config: PathBuf,
    broker: Vec<String>,
    base_env: BTreeMap<String, String>,
}

impl Launch {
    pub(super) fn from_env() -> Result<Self> {
        let raw = std::env::var(LAUNCH_ENV)
            .with_context(|| format!("--wake-lanes requires {LAUNCH_ENV} from the Cataly CLI"))?;
        let record: LaunchRecord =
            serde_json::from_str(&raw).with_context(|| format!("invalid {LAUNCH_ENV}"))?;
        for path in [&record.sessions_dir, &record.wake_config] {
            super::util::absolute(path, LAUNCH_ENV)?;
        }
        anyhow::ensure!(
            record.broker.len() >= 2 && record.broker.iter().all(|p| Path::new(p).is_absolute()),
            "{LAUNCH_ENV} broker must be absolute [runtime, headless-broker.ts]"
        );
        // A variable that is not UTF-8 cannot cross the JSON start record; it is left out rather than mangled.
        let base_env = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .filter(|(key, _)| !PRIVATE_ENV.contains(&key.as_str()))
            .collect();
        Ok(Self {
            command: wake_command(&record.agent_command),
            sessions_dir: record.sessions_dir,
            guard: record.guard,
            lane_env: record.env,
            wake_config: record.wake_config,
            broker: record.broker,
            base_env,
        })
    }
}

/// `DiscordLaneWakeResult`. The TypeScript reason texts are kept beside each return as `held`/`unconfirmed` calls;
/// only the kind is reported (`DISCORD_LANE_WAKE_*` lines name the key, never the reason).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Wake {
    Started,
    Held,
    Unconfirmed,
}

const fn held(_reason: &'static str) -> Wake {
    Wake::Held
}

const fn unconfirmed(_reason: &'static str) -> Wake {
    Wake::Unconfirmed
}

/// An attestation that has not yet seen the exact live session.
const WAITING: &str = "waiting for exact live native transcript, receiver and saved model";

/// `wakeLeaseState`.
#[derive(Debug, PartialEq, Eq)]
enum Lease {
    Free,
    Held,
    Unknown,
}

async fn lease(launch: &Launch, argv: &[String], session: &str, cwd: &Path) -> Lease {
    #[derive(Deserialize)]
    struct Report {
        held: Vec<String>,
        unknown: Vec<String>,
    }
    let Some((program, prefix)) = argv.split_first() else {
        return Lease::Unknown;
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args(prefix)
        .args(["session", "lease", "--json", "--", session])
        .current_dir(cwd)
        .env_clear()
        .envs(&launch.base_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let run = async {
        let mut child = command.spawn()?;
        let mut out = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no lease output"))?
            .take(LEASE_OUTPUT)
            .read_to_end(&mut out)
            .await?;
        let status = child.wait().await?;
        Ok::<_, anyhow::Error>((status.success(), out))
    };
    let Ok(Ok((true, out))) = tokio::time::timeout(LEASE_DEADLINE, run).await else {
        return Lease::Unknown;
    };
    let Ok(report) = serde_json::from_slice::<Report>(&out) else {
        return Lease::Unknown;
    };
    if !report.unknown.is_empty() {
        return Lease::Unknown;
    }
    match report.held.as_slice() {
        [] => Lease::Free,
        [held] if held == session => Lease::Held,
        _ => Lease::Unknown,
    }
}

fn real(path: &str) -> Result<String> {
    std::fs::canonicalize(path)?
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow!("path is not UTF-8"))
}

/// The retired session a wake would resume, with the gates its prior runtime can still prove.
struct Retired {
    session: String,
    file: String,
    cwd: String,
    goal: String,
    model: String,
    /// The headless reservation the prior session ran in, if any.
    prior: Option<HeadlessRef>,
}

/// `startHeadlessWake`'s eligibility: a cleanly stopped native lane with a recorded retirement goal.
fn retired_headless(
    state: &Path,
    launch: &Launch,
    lane: &Lane,
    prior: HeadlessRef,
) -> Result<Result<Retired, Wake>> {
    let session = lane.session();
    let binding = headless::receiver(state, lane)?;
    let goal = binding
        .as_ref()
        .and_then(headless::Binding::retired_goal)
        .and_then(Json::as_str)
        .map(str::to_owned);
    let (Some(session), Some(binding), Some(goal)) = (session, binding, goal) else {
        return Ok(Err(held("no settled retired native lane identity")));
    };
    if binding
        .stopped
        .as_ref()
        .and_then(|s| s.str("closedSessionId"))
        != Some(session)
        || !matches!(goal.as_str(), "none" | "active" | "complete" | "dropped")
        || launch.command.is_none()
    {
        return Ok(Err(held("no settled retired native lane identity")));
    }
    if !std::fs::metadata(binding.cwd())?.is_dir() {
        return Ok(Err(held("recorded lane directory differs")));
    }
    let model = transcript::exact(
        binding.file(),
        &launch.sessions_dir,
        session,
        Path::new(binding.cwd()),
    )?
    .and_then(|t| t.model);
    let Some(model) = model else {
        return Ok(Err(held("exact saved transcript and model not verified")));
    };
    Ok(Ok(Retired {
        session: session.to_owned(),
        file: binding.file().to_owned(),
        cwd: binding.cwd().to_owned(),
        goal,
        model,
        prior: Some(prior),
    }))
}

/// `startExactLane`'s Herdr eligibility, minus the pane probe: the extension retired the pane cleanly (pid 0).
fn retired_pane(
    state: &Path,
    launch: &Launch,
    lane: &Lane,
    pane: &str,
) -> Result<Result<Retired, Wake>> {
    let Some(session) = lane.session() else {
        return Ok(Err(held("no exact Herdr session registered")));
    };
    let old = pane_state(state, pane);
    let goal = old
        .as_ref()
        .and_then(|old| old.get("goal"))
        .and_then(|goal| goal.str("status"))
        .filter(|goal| matches!(*goal, "none" | "active" | "complete" | "dropped"))
        .map(str::to_owned);
    let Some((old, goal)) = old.zip(goal) else {
        return Ok(Err(held("retired pane identity or goal not eligible")));
    };
    let old_cwd = old.str("cwd").filter(|cwd| Path::new(cwd).is_absolute());
    let updated = old.str("updatedAt").and_then(parse_iso);
    let opened = lane.0.str("openedAt").and_then(parse_iso);
    if old.str("paneId") != Some(pane)
        || pane_role(&old) != Some("lane")
        || old.get("discordLaneInbox") != Some(&Json::Bool(true))
        || old.get("pid").and_then(Json::as_f64) != Some(0.0)
        || old.str("sessionId") != Some(session)
        || old.get("approvalPending") != Some(&Json::Bool(false))
        || old.str("sessionFile").is_none()
        || old_cwd.is_none()
        || !matches!((updated, opened), (Some(updated), Some(opened)) if updated >= opened)
    {
        return Ok(Err(held("retired pane identity or goal not eligible")));
    }
    if launch.command.as_ref().and_then(headless_argv).is_none() {
        return Ok(Err(held(
            "agent command is not an exact interactive OMP template",
        )));
    }
    let cwd = real(old_cwd.unwrap_or_default())?;
    if lane
        .cwd()
        .map(real)
        .transpose()?
        .is_some_and(|lane_cwd| lane_cwd != cwd)
        || !std::fs::metadata(&cwd)?.is_dir()
    {
        return Ok(Err(held("recorded lane directory differs")));
    }
    let Some(exact) = transcript::exact(
        old.str("sessionFile").unwrap_or_default(),
        &launch.sessions_dir,
        session,
        Path::new(&cwd),
    )?
    else {
        return Ok(Err(held("exact saved transcript not verified")));
    };
    let file = exact
        .file
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow!("transcript path is not UTF-8"))?;
    if lane
        .session_file()
        .map(real)
        .transpose()?
        .is_some_and(|recorded| recorded != file)
    {
        return Ok(Err(held("exact saved transcript not verified")));
    }
    // A headless lane attests the saved model, so a pane transcript without one cannot be woken here.
    let Some(model) = exact.model else {
        return Ok(Err(held("exact saved transcript and model not verified")));
    };
    Ok(Ok(Retired {
        session: session.to_owned(),
        file,
        cwd,
        goal,
        model,
        prior: None,
    }))
}

/// `parseRef(id)?.id === id` for a bare Herdr pane: `^w[0-9A-Za-z]+:p[0-9A-Za-z]+$`.
fn herdr_pane(id: &str) -> bool {
    let word = |part: &str, head: char| {
        part.strip_prefix(head)
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()))
    };
    id.split_once(':')
        .is_some_and(|(workspace, pane)| word(workspace, 'w') && word(pane, 'p'))
}

/// No other registered lane, live headless broker or live pane writer owns the session.
async fn owned_elsewhere(state: &Path, lane: &Lane, retired: &Retired) -> Result<bool> {
    let scan = Registry::new(state).scan()?;
    let prior = lane.session_ref();
    let prior_id = prior.as_ref().and_then(SessionRef::id);
    let prior_runtime = prior.as_ref().and_then(SessionRef::runtime);
    if scan.unreadable > 0
        || scan
            .lanes
            .iter()
            .filter(|peer| peer.status() != "closed")
            .any(|peer| {
                let reference = peer.session_ref();
                peer.key() != lane.key()
                    && (peer.thread() == lane.thread()
                        || peer.session() == Some(retired.session.as_str())
                        || (prior_id.is_some()
                            && reference.as_ref().and_then(SessionRef::runtime) == prior_runtime
                            && reference.as_ref().and_then(SessionRef::id) == prior_id))
            })
    {
        return Ok(true);
    }
    for (reference, seen) in headless::hosts(state).await? {
        if retired
            .prior
            .as_ref()
            .is_some_and(|prior| prior.id == reference.id)
        {
            return Ok(true);
        }
        if seen.session_id.as_deref() == Some(retired.session.as_str()) || seen.status == "unknown"
        {
            return Ok(true);
        }
    }
    if let Ok(entries) = std::fs::read_dir(state.join("sessions")) {
        for entry in entries.flatten() {
            let Ok(raw) = super::util::read_limited(&entry.path(), super::util::RECORD_LIMIT)
            else {
                continue;
            };
            let Ok(pane) = serde_json::from_slice::<Json>(&raw) else {
                continue;
            };
            if pane.str("sessionId") == Some(retired.session.as_str())
                && super::registry::int_field(&pane, "pid").is_some_and(signalable)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `completeDiscordWake`.
async fn complete(state: &Path, lane: &Lane, epoch: &str, session: &str) -> Result<Wake> {
    let done = Registry::new(state)
        .transition(lane, |current| {
            if !lane.same_wake_target(&current) {
                return Ok(None);
            }
            let mut next = current;
            next.0.set("lifecycleEpoch", Json::string(epoch));
            // Bind the final reporting generation to the exact attested OMP session.
            record_execution(state, &next, now_ms(), Some(session))?;
            Ok(Some(next))
        })
        .await?;
    Ok(if done.is_some() {
        Wake::Started
    } else {
        unconfirmed("the lane changed during startup attestation")
    })
}

/// `attestHeadlessWake`.
async fn attest(
    state: &Path,
    launch: &Launch,
    lane: &Lane,
    expected_model: Option<&str>,
) -> Result<Wake> {
    let epoch = lane.epoch().and_then(completed);
    let (Some(epoch), Some(session), Some(file), Some(cwd), Some(reference)) = (
        epoch,
        lane.session(),
        lane.session_file(),
        lane.cwd(),
        HeadlessRef::of(lane),
    ) else {
        return Ok(held("earlier wake requires inspection"));
    };
    let mut model = expected_model.map(str::to_owned);
    if model.is_none() {
        // The extension's activation record preserves the model selected by the original start attempt.
        model = transcript::exact(file, &launch.sessions_dir, session, Path::new(cwd))?
            .and_then(|t| t.model);
    }
    let binding = headless::receiver(state, lane)?;
    let seen = headless::observe(state, &reference).await?;
    let attested = match (&model, &binding) {
        (Some(model), Some(binding)) => {
            binding.stopped.is_none()
                && binding.retired_goal().is_none()
                && binding.receiver.str("wakeModel") == Some(model.as_str())
                && seen.role.as_deref() == Some("lane")
                && seen.id.as_deref() == Some(reference.id.as_str())
                && seen.runtime.as_deref() == Some("headless")
                && seen.status == "idle"
                && !seen.detail
                && !seen.held
                && seen.dialogs == 0
                && seen.pid == Some(binding.pid())
                && seen.session_id.as_deref() == Some(session)
                && seen.session_file.as_deref() == Some(file)
                && seen.cwd.as_deref() == Some(cwd)
                && seen.model.as_deref() == Some(model.as_str())
        }
        _ => false,
    };
    if !attested {
        return Ok(unconfirmed(WAITING));
    }
    complete(state, lane, epoch, session).await
}

/// Attests a just-started wake until it proves itself, its broker stops, or the startup deadline passes.
async fn attest_startup(state: &Path, launch: &Launch, lane: &Lane, model: &str) -> Result<Wake> {
    let deadline = tokio::time::Instant::now() + STARTUP_DEADLINE;
    let reference =
        HeadlessRef::of(lane).ok_or_else(|| anyhow!("bound wake lost its native reference"))?;
    loop {
        let result = attest(state, launch, lane, Some(model)).await?;
        if result != Wake::Unconfirmed {
            return Ok(result);
        }
        if headless::observe(state, &reference).await?.status == "gone" {
            bail!("headless lane process exited before proving startup");
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(result);
        }
        tokio::time::sleep(STARTUP_POLL).await;
    }
}

async fn start_exact(
    state: &Path,
    launch: &Launch,
    seen: &Lane,
    reserved: &mut bool,
) -> Result<Wake> {
    let registry = Registry::new(state);
    let Some(lane) = registry
        .read(seen.key())?
        .filter(|lane| seen.same_wake_target(lane))
    else {
        return Ok(held("lane no longer eligible"));
    };
    let prior = lane.session_ref();
    let runtime = prior
        .as_ref()
        .and_then(SessionRef::runtime)
        .map(str::to_owned);
    let pane = prior.as_ref().and_then(SessionRef::id).map(str::to_owned);
    if is_pending(lane.epoch()) {
        *reserved = true;
        // An unattested Herdr wake from an earlier monitor needs the terminal runtime this binary no longer drives.
        if runtime.as_deref() != Some("headless") {
            return Ok(held("earlier wake requires inspection"));
        }
        return attest(state, launch, &lane, None).await;
    }
    let retired = match (runtime.as_deref(), pane) {
        (Some("headless"), _) => {
            let prior = HeadlessRef::of(&lane).ok_or_else(|| anyhow!("invalid headless ref"))?;
            retired_headless(state, launch, &lane, prior)?
        }
        (Some("herdr"), Some(pane)) if lane.session().is_some() && herdr_pane(&pane) => {
            retired_pane(state, launch, &lane, &pane)?
        }
        _ => Err(held("no exact Herdr session registered")),
    };
    let retired = match retired {
        Ok(retired) => retired,
        Err(wake) => return Ok(wake),
    };
    let Some(command) = launch.command.as_ref() else {
        return Ok(held("no settled retired native lane identity"));
    };
    let Some(argv) = headless_argv(command) else {
        return Ok(held(
            "agent command is not an exact interactive OMP template",
        ));
    };
    if owned_elsewhere(state, &lane, &retired).await? {
        return Ok(held("native transcript ownership unverified"));
    }
    let cwd = Path::new(&retired.cwd);
    if !can_launch(state, cwd, &launch.guard).await {
        return Ok(held("host launch guard holds"));
    }
    if lease(launch, &command.lease, &retired.session, cwd).await != Lease::Free {
        return Ok(held("OMP session lease is held or unverified"));
    }
    launch_retired(state, launch, &lane, &retired, command, argv, reserved).await
}

/// The side effects of a wake whose gates all passed: intent, reservation, binding, start, attestation.
async fn launch_retired(
    state: &Path,
    launch: &Launch,
    lane: &Lane,
    retired: &Retired,
    command: &WakeCommand,
    mut argv: Vec<String>,
    reserved: &mut bool,
) -> Result<Wake> {
    let registry = Registry::new(state);
    let cwd = Path::new(&retired.cwd);
    let epoch = uuid()?;
    let run = if lane.0.get("requestId").is_some() {
        Some(uuid()?)
    } else {
        None
    };
    // Commit before the first side effect: a monitor that dies during reserve, bind or start leaves a pending wake
    // that every later monitor holds or attests, never restarts.
    let intent = registry
        .transition(lane, |current| {
            if !lane.same_wake_target(&current) {
                return Ok(None);
            }
            let mut next = current;
            if let Some(run) = &run {
                next.0.set("runId", Json::string(run));
            }
            next.0
                .set("lifecycleEpoch", Json::string(&format!("{PREFIX}{epoch}")));
            let mut started = next.clone();
            started.0.set("lifecycleEpoch", Json::string(&epoch));
            // The run starts in the final reporting generation; pending:/bound: only guard startup in the registry.
            record_execution(state, &started, now_ms(), None)?;
            Ok(Some(next))
        })
        .await?;
    let Some(intent) = intent else {
        return Ok(held("lane changed before wake"));
    };
    *reserved = true;
    let group = retired.prior.as_ref().and_then(|prior| prior.group.clone());
    let reference = headless::reserve(state, lane.key(), cwd, group)?;
    let bound = registry
        .transition(&intent, |current| {
            if !intent.same_wake_target(&current) {
                return Ok(None);
            }
            let mut next = current;
            // A Herdr pane's tab does not describe the new native session; a headless row keeps its fields.
            if retired.prior.is_none() {
                next.0.remove("tab");
            }
            next.0.set("sessionRef", reference.json());
            next.0.set("pane", Json::string(&reference.id));
            next.0.set("cwd", Json::string(&retired.cwd));
            next.0.set("sessionFile", Json::string(&retired.file));
            next.0.set(
                "lifecycleEpoch",
                Json::string(&format!("{BOUND_PREFIX}{epoch}")),
            );
            Ok(Some(next))
        })
        .await?;
    let Some(bound) = bound else {
        return Ok(unconfirmed(
            "lane changed before starting the native session",
        ));
    };
    if lease(launch, &command.lease, &retired.session, cwd).await != Lease::Free {
        return Ok(unconfirmed(
            "OMP session acquired another owner during wake",
        ));
    }
    let mut env = launch.base_env.clone();
    env.extend(launch.lane_env.clone());
    env.insert("CATALY_LANE_RUN".to_owned(), run.unwrap_or_default());
    env.insert(
        "CATALY_DISCORD_WAKE_SESSION".to_owned(),
        retired.session.clone(),
    );
    env.insert("CATALY_DISCORD_WAKE_GOAL".to_owned(), retired.goal.clone());
    env.insert(
        "CATALY_DISCORD_WAKE_MODEL".to_owned(),
        retired.model.clone(),
    );
    argv.push("--config".to_owned());
    argv.push(
        launch
            .wake_config
            .to_str()
            .ok_or_else(|| anyhow!("wake overlay path is not UTF-8"))?
            .to_owned(),
    );
    headless::start(
        state,
        &reference,
        &launch.broker,
        &argv,
        env,
        (retired.file.as_str(), retired.session.as_str()),
    )
    .await?;
    attest_startup(state, launch, &bound, &retired.model).await
}

/// `wakeDiscordLane`: request startup of the exact lane session; never types a message or resumes a goal.
pub(super) async fn wake(state: &Path, launch: &Launch, seen: &Lane) -> Result<Wake> {
    if !valid_key(seen.key()) || seen.key() == RESERVED_LANE_KEY {
        return Ok(held("invalid lane key"));
    }
    let Some(lock) = delivery_lock(state, seen.key(), Duration::ZERO).await? else {
        return Ok(held("lane delivery lock in use"));
    };
    let mut reserved = false;
    let result = start_exact(state, launch, seen, &mut reserved).await;
    let released = lock.release();
    // Runtime and filesystem errors can contain private launch arguments or transcript paths.
    let wake = result.unwrap_or_else(|_| {
        if reserved {
            unconfirmed("wake interrupted after reservation; inspect before any manual restart")
        } else {
            held("wake prerequisites could not be verified")
        }
    });
    released?;
    Ok(wake)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epochs() {
        assert!(is_pending(Some("discord-wake-pending:x")));
        assert!(is_pending(Some("discord-wake-pending:bound:x")));
        assert!(!is_pending(Some("x")) && !is_pending(None));
        assert_eq!(completed("discord-wake-pending:bound:e"), Some("e"));
        assert_eq!(completed("discord-wake-pending:e"), None);
        assert!(herdr_pane("w1:p2") && !herdr_pane("w1:x2") && !herdr_pane("w:p2"));
    }

    #[test]
    fn launch_record_is_strict() {
        let record = r#"{"agentCommand":["omp","{prompt}"],"sessionsDir":"/s","guard":{"loadAlert":1,"loadOk":1,"memFreeMinPct":20,"diskFreeMinGb":50,"panesMax":20},"env":{"CATALY_STATE_DIR":"/x"},"wakeConfig":"/w.yml","broker":["/bun","/b.ts"]}"#;
        let parsed: LaunchRecord = serde_json::from_str(record).unwrap();
        assert_eq!(parsed.broker.len(), 2);
        assert!(
            serde_json::from_str::<LaunchRecord>(&record.replace("\"broker\"", "\"other\""))
                .is_err()
        );
    }
}
