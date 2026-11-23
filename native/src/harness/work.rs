use std::future::pending;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use super::{Harness, SessionKey, store::Claim};
use crate::rpc::TurnOutcome;
use crate::rpc::tools::{Approval, Tools};

#[cfg(feature = "discord")]
mod memory;
mod receipt;
use receipt::{Outcome, ReplyFormat, RunTool};
pub use receipt::{RunClaim, RunId, RunReceipt};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Run {
    pub(super) id: RunId,
    pub(super) key: SessionKey,
    pub(super) prompt: String,
    #[serde(skip)]
    pub(super) bind_workspace: bool,
}

#[derive(Default)]
pub(super) struct RunOptions {
    pub(super) cancel: Option<oneshot::Receiver<()>>,
    pub(super) approvals: Option<mpsc::Sender<Approval>>,
    pub(super) memory_context: Option<String>,
    pub(super) fenced_replies: bool,
    pub(super) discord_head: bool,
}

impl Harness<'_, '_> {
    #[cfg(feature = "discord")]
    pub(super) fn discord_readme_mode(
        &self,
        origin: super::discord::Origin,
        key: &SessionKey,
    ) -> Result<Option<bool>> {
        let claim = match self.store.receipt(&origin.id())? {
            Claim::Missing => return Ok(None),
            Claim::Pending(claim) => claim,
            Claim::Done(receipt) => receipt.claim,
        };
        ensure!(
            claim.lane == key.0,
            "Discord origin does not match the run receipt"
        );
        Ok(Some(claim.tool == Some(RunTool::ReadReadme)))
    }

    pub(super) fn lookup_run(&self, id: &RunId) -> Result<RunReceipt> {
        match self.store.receipt(id)? {
            Claim::Missing => bail!("unknown Cataly request: {}", id.as_str()),
            Claim::Pending(claim) => Ok(RunReceipt::held(
                claim,
                "request outcome is unconfirmed; it will not be replayed".to_owned(),
            )),
            Claim::Done(receipt) => Ok(receipt),
        }
    }

    pub(super) async fn execute(&mut self, run: Run, options: RunOptions) -> Result<RunReceipt> {
        let Run {
            id,
            key,
            prompt,
            bind_workspace,
        } = run;
        ensure!(
            (key.0 == "head") == options.discord_head,
            "only supervised Discord may submit a turn to the Cataly head"
        );
        ensure!(
            !prompt.trim().is_empty() && !prompt.trim_start().starts_with('/'),
            "Cataly run requires nonempty text, not an OMP slash command"
        );
        let tool = options.approvals.as_ref().map(|_| RunTool::ReadReadme);
        let fingerprint = format!("{:x}", Sha256::digest(prompt.as_bytes()));
        match self.store.receipt(&id)? {
            Claim::Missing => {}
            Claim::Pending(claim) => {
                ensure!(
                    claim.lane == key.0 && claim.fingerprint == fingerprint && claim.tool == tool,
                    "request ID was already used for different input"
                );
                return Ok(RunReceipt::held(
                    claim,
                    "request outcome is unconfirmed; it will not be replayed".to_owned(),
                ));
            }
            Claim::Done(receipt) => {
                ensure!(
                    receipt.claim.lane == key.0
                        && receipt.claim.fingerprint == fingerprint
                        && receipt.claim.tool == tool,
                    "request ID was already used for different input"
                );
                return Ok(receipt);
            }
        }
        self.store.lane_available(&key.0)?;
        let temporary = !self.sessions.contains_key(&key);
        ensure!(
            temporary || options.approvals.is_none(),
            "Cataly tool runs require a parked or new lane"
        );
        if temporary {
            let cwd = bind_workspace.then(|| self.cwd.to_path_buf());
            self.open(SessionKey(key.0.clone()), cwd, false).await?;
        }
        let result = self.dispatch(id, &key, fingerprint, &prompt, options).await;
        let shutdown = if temporary || matches!(&result, Ok((_, true))) {
            let live = self
                .sessions
                .remove(&key)
                .context("Cataly lane is not open")?;
            live.rpc.close().await
        } else {
            Ok(())
        };
        match (result, shutdown) {
            (Ok((receipt, _)), Ok(())) => {
                if receipt.is_terminal() {
                    self.store.finish_run(&receipt)?;
                }
                Ok(receipt)
            }
            (Ok((receipt, _)), Err(error)) => Ok(RunReceipt::held(
                receipt.claim,
                format!("could not confirm OMP lane shutdown: {error:#}"),
            )),
            (Err(error), Ok(())) => Err(error),
            (Err(error), Err(shutdown)) => {
                Err(error).context(format!("OMP lane shutdown also failed: {shutdown:#}"))
            }
        }
    }

    async fn dispatch(
        &mut self,
        id: RunId,
        key: &SessionKey,
        fingerprint: String,
        prompt: &str,
        mut options: RunOptions,
    ) -> Result<(RunReceipt, bool)> {
        let live = self
            .sessions
            .get_mut(key)
            .context("Cataly lane is not open")?;
        live.verify().await?;
        let readme = options.approvals.is_some();
        let tools = if let Some(approvals) = options.approvals {
            if live.rpc.register_workspace_tool().await? {
                Some(Tools::new(approvals, &live.binding.cwd).await?)
            } else {
                None
            }
        } else {
            None
        };
        ensure!(
            options
                .cancel
                .as_mut()
                .is_none_or(|signal| signal.try_recv().is_err()),
            "Cataly run cancelled before sending the prompt"
        );
        let claim = RunClaim {
            id,
            lane: key.0.clone(),
            session_id: live.binding.session.id.clone(),
            fingerprint,
            tool: readme.then_some(RunTool::ReadReadme),
            reply_format: options.fenced_replies.then_some(ReplyFormat::FencedV1),
        };
        self.store.claim(&claim)?;
        if readme && tools.is_none() {
            return Ok((
                RunReceipt {
                    claim,
                    outcome: Outcome::Failed {
                        reason: RunReceipt::README_UNAVAILABLE.to_owned(),
                    },
                },
                false,
            ));
        }
        let prompt = with_memory(prompt, options.memory_context.as_deref());
        let turn = tokio::select! {
            biased;
            () = cancellation(options.cancel) => {
                return Ok((RunReceipt::held(
                    claim,
                    "cancellation requested; the OMP turn outcome is unconfirmed".to_owned(),
                ), true));
            }
            turn = live.rpc.run_turn(&prompt, tools) => turn,
        };
        let turn = match turn {
            Ok(turn) => turn,
            Err(error) => {
                live.faulted = true;
                return Ok((RunReceipt::held(claim, format!("{error:#}")), false));
            }
        };
        if let Err(error) = live.verify().await {
            return Ok((RunReceipt::held(claim, format!("{error:#}")), false));
        }
        let outcome = match turn {
            TurnOutcome::Completed(text) => Outcome::Completed { text },
            TurnOutcome::Failed(reason) => Outcome::Failed {
                reason: reason.to_owned(),
            },
        };
        Ok((RunReceipt { claim, outcome }, false))
    }
}

fn with_memory<'a>(prompt: &'a str, context: Option<&str>) -> std::borrow::Cow<'a, str> {
    context.map_or_else(
        || prompt.into(),
        |context| format!("{prompt}{context}").into(),
    )
}

async fn cancellation(receiver: Option<oneshot::Receiver<()>>) {
    if let Some(receiver) = receiver
        && receiver.await.is_ok()
    {
        return;
    }
    pending::<()>().await;
}
