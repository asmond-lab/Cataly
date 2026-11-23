use std::pin::pin;

use anyhow::{Context, Result, anyhow, ensure};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::sync::{mpsc, oneshot};

use super::Harness;
use super::work::{Run, RunOptions};
use crate::rpc::tools::Approval;

mod protocol;
use protocol::{Reply, Request, RunControl};

const MAX_REQUEST_BYTES: u64 = 16 * 1024;

pub(super) async fn serve(harness: &mut Harness<'_, '_>) -> Result<()> {
    let mut io = ControlIo {
        input: BufReader::new(tokio::io::stdin()),
        output: tokio::io::stdout(),
        line: Vec::new(),
    };
    while let Some(request) = io.read().await? {
        let result = match request {
            Ok(Request::Open { key, cwd }) => harness.open(key, cwd, true).await.map(Reply::State),
            Ok(Request::Status { key }) => harness.status(key).await.map(Reply::State),
            Ok(Request::Close { key }) => harness.close(key).await.map(Reply::State),
            Ok(Request::Run(run)) => harness
                .execute(run, RunOptions::default())
                .await
                .map(Reply::Run),
            Ok(Request::RunControlled(run)) => {
                io.run_controlled(harness, run, false).await?;
                continue;
            }
            Ok(Request::RunWithTools(run)) => {
                io.run_controlled(harness, run, true).await?;
                continue;
            }
            Ok(Request::DiscordRun {
                origin,
                prompt,
                readme,
            }) => {
                io.run_controlled(harness, origin.run(prompt), readme)
                    .await?;
                continue;
            }
            Ok(Request::DiscordDelivery(action)) => {
                harness.discord_delivery(action).map(Reply::DiscordDelivery)
            }
            Ok(Request::Receipt { id }) => harness.lookup_run(&id).map(Reply::Run),
            Ok(Request::RunStatus { .. } | Request::Cancel { .. } | Request::Decide { .. }) => {
                Err(anyhow!("no active Cataly controlled run"))
            }
            Ok(Request::Quit) => return Ok(()),
            Err(error) => Err(error),
        };
        io.write(result).await?;
    }
    Ok(())
}

struct ControlIo<R, W> {
    input: R,
    output: W,
    line: Vec<u8>,
}

impl<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin> ControlIo<R, W> {
    // If a run completes mid-read, retain the partial line and its remaining byte budget.
    async fn read(&mut self) -> Result<Option<Result<Request>>> {
        let remaining = (MAX_REQUEST_BYTES + 1)
            .checked_sub(u64::try_from(self.line.len())?)
            .context("Cataly request exceeded the remaining frame budget")?;
        (&mut self.input)
            .take(remaining)
            .read_until(b'\n', &mut self.line)
            .await?;
        if self.line.is_empty() {
            return Ok(None);
        }
        ensure!(
            u64::try_from(self.line.len())? <= MAX_REQUEST_BYTES && self.line.ends_with(b"\n"),
            "Cataly expected a newline-terminated JSON request no larger than 16 KiB"
        );
        let request = serde_json::from_slice(&self.line).context("invalid Cataly request");
        self.line.clear();
        Ok(Some(request))
    }

    async fn write(&mut self, reply: Result<Reply>) -> Result<()> {
        let reply = reply.unwrap_or_else(|error| Reply::Error {
            error: format!("{error:#}"),
        });
        let mut data = serde_json::to_vec(&reply)?;
        data.push(b'\n');
        self.output.write_all(&data).await?;
        self.output.flush().await?;
        Ok(())
    }

    async fn run_controlled(
        &mut self,
        harness: &mut Harness<'_, '_>,
        run: Run,
        tools: bool,
    ) -> Result<()> {
        let active = run.id.clone();
        let (send, receive) = oneshot::channel();
        let mut cancel = Some(send);
        let mut cancelling = false;
        let (publish, mut approvals) = mpsc::channel::<Approval>(1);
        let mut pending_approval: Option<Approval> = None;
        let options = RunOptions {
            cancel: Some(receive),
            approvals: tools.then_some(publish),
            memory_context: None,
            fenced_replies: false,
            discord_head: false,
        };
        let mut execution = pin!(harness.execute(run, options));
        loop {
            let request = tokio::select! {
                biased;
                result = &mut execution => return self.write(result.map(Reply::Run)).await,
                Some(approval) = approvals.recv(), if tools && !cancelling => {
                    ensure!(pending_approval.is_none(), "Cataly already has a pending approval");
                    self.write(Ok(Reply::Approval {
                        id: active.clone(),
                        approval_id: approval.id.clone(),
                        tool: crate::rpc::tools::NAME,
                    })).await?;
                    pending_approval = Some(approval);
                    continue;
                }
                request = self.read() => request?,
            };
            let Some(request) = request else {
                drop(pending_approval);
                drop(approvals);
                return self.write(execution.await.map(Reply::Run)).await;
            };
            let reply = request.and_then(|request| match request {
                Request::RunStatus { id } if id == active => Ok(Reply::Control {
                    id,
                    control: if cancelling {
                        RunControl::Cancelling
                    } else if pending_approval.is_some() {
                        RunControl::AwaitingApproval
                    } else {
                        RunControl::Running
                    },
                }),
                Request::Cancel { id } if id == active => {
                    if !cancelling {
                        cancel
                            .take()
                            .context("Cataly run is already settling")?
                            .send(())
                            .map_err(|()| anyhow!("Cataly run is already settling"))?;
                        cancelling = true;
                    }
                    Ok(Reply::Control {
                        id,
                        control: RunControl::Cancelling,
                    })
                }
                Request::Decide {
                    id,
                    approval_id,
                    decision,
                } if id == active && !cancelling => {
                    let approval = pending_approval
                        .take_if(|pending| pending.id == approval_id)
                        .context("approval ID does not match a pending Cataly tool request")?;
                    approval
                        .decision
                        .send(decision)
                        .map_err(|_| anyhow!("Cataly approval is no longer pending"))?;
                    Ok(Reply::Decision {
                        id,
                        approval_id,
                        decision,
                    })
                }
                Request::RunStatus { .. } | Request::Cancel { .. } | Request::Decide { .. } => {
                    Err(anyhow!("request ID does not match the active Cataly run"))
                }
                Request::Open { .. }
                | Request::Status { .. }
                | Request::Close { .. }
                | Request::Run(_)
                | Request::RunControlled(_)
                | Request::RunWithTools(_)
                | Request::DiscordRun { .. }
                | Request::DiscordDelivery(_)
                | Request::Receipt { .. }
                | Request::Quit => Err(anyhow!(
                    "only run_status, cancel or decide is available during a controlled run"
                )),
            });
            self.write(reply).await?;
        }
    }
}
