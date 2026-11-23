use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    sync::{mpsc, oneshot},
    time::timeout,
};

use super::{Registration, Request, Rpc};
use readme::Workspace;

mod readme;

pub const NAME: &str = "cataly_read_readme";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Approve,
    Deny,
}

pub struct Approval {
    pub(crate) id: String,
    pub(crate) decision: oneshot::Sender<Decision>,
}

pub struct Tools {
    approvals: mpsc::Sender<Approval>,
    workspace: Workspace,
    offered: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HostToolCall<'a> {
    id: &'a str,
    tool_name: &'a str,
    arguments: Value,
}

impl Tools {
    pub(crate) async fn new(
        approvals: mpsc::Sender<Approval>,
        path: &std::path::Path,
    ) -> Result<Self> {
        Ok(Self {
            approvals,
            workspace: Workspace::open(path).await?,
            offered: false,
        })
    }

    pub(super) async fn call(&mut self, rpc: &mut Rpc, call: HostToolCall<'_>) -> Result<()> {
        let HostToolCall {
            id,
            tool_name,
            arguments,
        } = call;
        ensure!(
            !id.is_empty()
                && id.len() <= 96
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)),
            "OMP returned an invalid host tool request ID"
        );
        let (text, is_error) =
            if tool_name != NAME || !arguments.as_object().is_some_and(serde_json::Map::is_empty) {
                ("Unknown tool or invalid tool arguments".to_owned(), true)
            } else if self.offered {
                (
                    "Only one README request can be approved per turn".to_owned(),
                    true,
                )
            } else {
                self.offered = true;
                let (decision, receive) = oneshot::channel();
                self.approvals
                    .send(Approval {
                        id: id.to_owned(),
                        decision,
                    })
                    .await
                    .context("Cataly approval client disconnected")?;
                let decision = tokio::select! {
                    biased;
                    status = rpc.child.wait() => {
                        bail!("OMP exited while awaiting approval: {}", status?);
                    }
                    decision = receive => decision.context("Cataly approval was not answered")?,
                };
                match decision {
                    Decision::Approve => match self.workspace.read().await {
                        Ok(text) => (text, false),
                        Err(error) => (format!("Cannot read workspace README.md: {error:#}"), true),
                    },
                    Decision::Deny => ("The user denied the README.md request".to_owned(), true),
                }
            };
        rpc.write(&json!({
            "type": "host_tool_result", "id": id, "isError": is_error,
            "result": { "content": [{ "type": "text", "text": text }], "details": {} }
        }))
        .await
    }
}

impl Rpc {
    pub(crate) async fn register_workspace_tool(&mut self) -> Result<bool> {
        let tools = [json!({
            "name": NAME, "label": "Read Cataly workspace README.md", "loadMode": "always",
            "description": "Read README.md in the current Cataly workspace after user approval (up to 16 KiB). Takes no arguments.",
            "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
        })];
        let Some(registration) = timeout(
            Duration::from_secs(20),
            self.call::<Registration>(Request::SetHostTools { tools: &tools }),
        )
        .await
        .context("OMP host tool registration timed out")??
        else {
            return Ok(false);
        };
        ensure!(
            registration.tool_names == [NAME],
            "OMP returned an unexpected host tool registration"
        );
        Ok(true)
    }
}
