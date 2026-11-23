use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub struct RunId(String);

impl RunId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(in crate::harness) fn discord(message: std::num::NonZeroU64) -> Self {
        Self(format!("discord-{message}"))
    }
}

impl TryFrom<String> for RunId {
    type Error = &'static str;

    fn try_from(value: String) -> std::result::Result<Self, Self::Error> {
        if (1..=96).contains(&value.len())
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            Ok(Self(value))
        } else {
            Err("request ID must be 1–96 ASCII letters, digits, hyphens or underscores")
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct RunClaim {
    pub id: RunId,
    pub lane: String,
    pub session_id: String,
    pub(super) fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) tool: Option<RunTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) reply_format: Option<ReplyFormat>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ReplyFormat {
    FencedV1,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RunTool {
    ReadReadme,
    Memory,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(super) enum Outcome {
    Completed { text: String },
    Failed { reason: String },
    Unconfirmed { reason: String },
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RunReceipt {
    pub claim: RunClaim,
    #[serde(flatten)]
    pub(super) outcome: Outcome,
}

impl RunReceipt {
    pub const fn is_terminal(&self) -> bool {
        matches!(
            self.outcome,
            Outcome::Completed { .. } | Outcome::Failed { .. }
        )
    }

    #[cfg(feature = "discord")]
    pub(in crate::harness) const fn completed(&self) -> bool {
        matches!(self.outcome, Outcome::Completed { .. })
    }

    pub(super) const README_UNAVAILABLE: &'static str =
        "This OMP does not support the optional README approval tool.";

    pub(in crate::harness) const fn fenced_replies(&self) -> bool {
        matches!(self.claim.reply_format, Some(ReplyFormat::FencedV1))
    }
    pub(in crate::harness) fn discord_text(&self) -> &str {
        match &self.outcome {
            Outcome::Completed { text } if !text.trim().is_empty() => text.trim(),
            Outcome::Completed { .. } => "Cataly finished without a text result.",
            Outcome::Failed { reason } if reason == Self::README_UNAVAILABLE => {
                Self::README_UNAVAILABLE
            }
            Outcome::Failed { .. } => "Cataly could not complete the native run.",
            Outcome::Unconfirmed { .. } => {
                "The native run outcome is unconfirmed. Cataly did not automatically rerun it."
            }
        }
    }

    pub(super) const fn held(claim: RunClaim, reason: String) -> Self {
        Self {
            claim,
            outcome: Outcome::Unconfirmed { reason },
        }
    }
}
