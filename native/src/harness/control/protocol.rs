use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::super::discord::{DeliveryAction, DeliveryReply, Origin};
use super::super::work::{Run, RunId, RunReceipt};
use super::super::{SessionKey, Status};
use crate::rpc::tools::Decision;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Request {
    Open {
        key: SessionKey,
        cwd: Option<PathBuf>,
    },
    Status {
        key: SessionKey,
    },
    Close {
        key: SessionKey,
    },
    Run(Run),
    RunControlled(Run),
    RunWithTools(Run),
    DiscordRun {
        origin: Origin,
        prompt: String,
        readme: bool,
    },
    DiscordDelivery(DeliveryAction),
    Decide {
        id: RunId,
        approval_id: String,
        decision: Decision,
    },
    RunStatus {
        id: RunId,
    },
    Cancel {
        id: RunId,
    },
    Receipt {
        id: RunId,
    },
    Quit,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum Reply {
    State(Status),
    Run(RunReceipt),
    DiscordDelivery(DeliveryReply),
    Control {
        id: RunId,
        control: RunControl,
    },
    Approval {
        id: RunId,
        approval_id: String,
        tool: &'static str,
    },
    Decision {
        id: RunId,
        approval_id: String,
        decision: Decision,
    },
    Error {
        error: String,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RunControl {
    Running,
    Cancelling,
    AwaitingApproval,
}
