use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::omp::{Executable, Target, session_state};
use crate::rpc::Rpc;

mod control;
pub mod discord;
mod store;
mod work;

use store::{Binding, Record, Store};

#[derive(Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(try_from = "String")]
struct SessionKey(String);

impl TryFrom<String> for SessionKey {
    type Error = &'static str;

    fn try_from(text: String) -> std::result::Result<Self, Self::Error> {
        if (1..=48).contains(&text.len())
            && text.as_bytes()[0].is_ascii_lowercase()
            && text
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            Ok(Self(text))
        } else {
            Err(
                "session key must be 1–48 lowercase letters, digits or hyphens, starting with a letter",
            )
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Status {
    Unconfirmed { key: SessionKey },
    Open { key: SessionKey, binding: Binding },
    Closed { key: SessionKey, binding: Binding },
    Parked { key: SessionKey, binding: Binding },
}

struct Live {
    rpc: Rpc,
    binding: Binding,
    faulted: bool,
}

impl Live {
    async fn verify(&mut self) -> Result<()> {
        ensure!(
            !self.faulted,
            "Cataly session observation was lost; end this owner before reopening"
        );
        let state = session_state(&mut self.rpc).await;
        let result = match state {
            Ok(state) => state.verify(&self.binding.session).await,
            Err(error) => Err(error),
        };
        self.faulted = result.is_err();
        result
    }
}

struct Harness<'a, 'b> {
    omp: &'a Executable<'b>,
    cwd: &'a Path,
    store: Store,
    max_sessions: usize,
    sessions: BTreeMap<SessionKey, Live>,
}

impl Harness<'_, '_> {
    async fn open(
        &mut self,
        key: SessionKey,
        cwd: Option<PathBuf>,
        require_head: bool,
    ) -> Result<Status> {
        ensure!(
            !self.sessions.contains_key(&key),
            "Cataly session is already open"
        );
        ensure!(
            self.sessions.len() < self.max_sessions,
            "Cataly session capacity reached"
        );
        if require_head && key.0 != "head" {
            self.sessions
                .get_mut(&SessionKey("head".to_owned()))
                .context("open the Cataly head before opening a lane")?
                .verify()
                .await?;
        }
        let saved = match self.store.read(&key.0)? {
            Record::Bound(binding) => Some(binding),
            Record::New => None,
            Record::Starting => bail!(
                "Cataly has an unconfirmed start for {}; inspect the state before opening it again",
                key.0
            ),
        };
        let cwd = tokio::fs::canonicalize(cwd.as_deref().unwrap_or_else(|| {
            saved
                .as_ref()
                .map_or(self.cwd, |binding| binding.cwd.as_path())
        }))
        .await
        .context("resolving Cataly session working directory")?;
        ensure!(
            tokio::fs::metadata(&cwd).await?.is_dir(),
            "Cataly working directory must be a directory"
        );
        let omp = self.omp.in_dir(&cwd);
        let (binding, rpc) = if let Some(binding) = saved {
            ensure!(
                binding.cwd == cwd,
                "Cataly session belongs to a different working directory"
            );
            let connection = omp
                .connect(Target::Saved {
                    file: &binding.session.file,
                    id: &binding.session.id,
                })
                .await?;
            (binding, connection.rpc)
        } else {
            let dir = self.store.reserve(&key.0)?;
            let connection = omp.connect(Target::Fresh(&dir)).await?;
            let result = async {
                let session = connection.observation.state.identity().await?;
                let binding = Binding {
                    cwd: cwd.clone(),
                    session,
                };
                self.store.bind(&key.0, &binding)?;
                Ok::<Binding, anyhow::Error>(binding)
            }
            .await;
            match result {
                Ok(binding) => (binding, connection.rpc),
                Err(error) => {
                    connection
                        .rpc
                        .close()
                        .await
                        .context("closing unbound Cataly session")?;
                    return Err(error);
                }
            }
        };
        self.sessions.insert(
            SessionKey(key.0.clone()),
            Live {
                rpc,
                binding: binding.clone(),
                faulted: false,
            },
        );
        Ok(Status::Open { key, binding })
    }

    async fn status(&mut self, key: SessionKey) -> Result<Status> {
        if let Some(live) = self.sessions.get_mut(&key) {
            live.verify().await?;
            return Ok(Status::Open {
                key,
                binding: live.binding.clone(),
            });
        }
        match self.store.read(&key.0)? {
            Record::New => bail!("unknown Cataly session: {}", key.0),
            Record::Starting => Ok(Status::Unconfirmed { key }),
            Record::Bound(binding) => Ok(Status::Parked { key, binding }),
        }
    }

    async fn close(&mut self, key: SessionKey) -> Result<Status> {
        self.sessions
            .get_mut(&key)
            .context("Cataly session is not open")?
            .verify()
            .await?;
        let Live { rpc, binding, .. } = self
            .sessions
            .remove(&key)
            .context("Cataly session is not open")?;
        rpc.close().await?;
        ensure!(
            tokio::fs::metadata(&binding.session.file).await?.is_file(),
            "saved OMP session disappeared during shutdown"
        );
        Ok(Status::Closed { key, binding })
    }

    async fn shutdown(self) -> Result<()> {
        let mut failures = Vec::new();
        for (key, Live { rpc, .. }) in self.sessions {
            if let Err(error) = rpc.close().await {
                failures.push(format!("{}: {error:#}", key.0));
            }
        }
        ensure!(
            failures.is_empty(),
            "Cataly session shutdown failed: {}",
            failures.join("; ")
        );
        Ok(())
    }
}

impl<'a, 'b> Harness<'a, 'b> {
    fn new(omp: &'a Executable<'b>, options: Options<'a>) -> Result<Self> {
        Ok(Self {
            omp,
            cwd: options.cwd,
            store: Store::open(options.root)?,
            max_sessions: options.max_sessions,
            sessions: BTreeMap::new(),
        })
    }
}

#[derive(Clone, Copy)]
pub struct Options<'a> {
    pub cwd: &'a Path,
    pub root: &'a Path,
    pub max_sessions: usize,
}

pub async fn run(omp: &Executable<'_>, options: Options<'_>) -> Result<()> {
    let mut harness = Harness::new(omp, options)?;
    let commands = control::serve(&mut harness).await;
    let shutdown = harness.shutdown().await;
    match (commands, shutdown) {
        (Ok(()), result) | (result, Ok(())) => result,
        (Err(error), Err(close)) => Err(error.context(format!("{close:#}"))),
    }
}
