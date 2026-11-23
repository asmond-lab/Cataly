use std::num::NonZeroU64;

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::work::{Run, RunId};
#[cfg(feature = "discord")]
mod memory;
#[cfg(feature = "discord")]
mod service;
use super::{Harness, SessionKey};
#[cfg(feature = "discord")]
pub use service::{ApprovalCard, Worker};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct Snowflake(NonZeroU64);

impl TryFrom<String> for Snowflake {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let id = value
            .parse::<NonZeroU64>()
            .map_err(|_| "invalid Discord ID")?;
        if id.to_string() != value {
            return Err("invalid Discord ID");
        }
        Ok(Self(id))
    }
}

impl From<Snowflake> for String {
    fn from(value: Snowflake) -> Self {
        value.0.to_string()
    }
}
impl std::fmt::Display for Snowflake {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}
impl Snowflake {
    #[cfg(feature = "discord")]
    pub(crate) const FLOOR: Self = Self(NonZeroU64::MIN);

    #[cfg(feature = "discord")]
    pub(crate) fn preceding(self) -> Option<Self> {
        NonZeroU64::new(self.0.get() - 1).map(Self)
    }

    pub(crate) const fn timestamp_ms(self) -> u64 {
        (self.0.get() >> 22) + 1_420_070_400_000
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    pub(crate) bot: Snowflake,
    pub(crate) owner: Snowflake,
    pub(crate) channel: Snowflake,
    pub(crate) message: Snowflake,
}

impl Origin {
    pub(super) fn id(self) -> RunId {
        RunId::discord(self.message.0)
    }

    pub(super) fn key(self) -> SessionKey {
        let digest = Sha256::digest(format!(
            "{}:{}:{}",
            self.bot.0, self.owner.0, self.channel.0
        ));
        let hex = format!("{digest:x}");
        SessionKey(format!("discord-{}", &hex[..40]))
    }

    pub(super) fn run(self, prompt: String) -> Run {
        // Slash-prefixed Discord text is data, not an OMP control command.
        let prompt = if prompt.trim_start().starts_with('/') {
            format!("Discord message:\n{prompt}")
        } else {
            prompt
        };
        Run {
            id: self.id(),
            key: self.key(),
            prompt,
            bind_workspace: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum DeliveryAction {
    Next {
        origin: Origin,
    },
    Ack {
        origin: Origin,
        part: usize,
        remote: Snowflake,
    },
}

#[derive(Serialize)]
#[serde(tag = "delivery", rename_all = "snake_case")]
pub(super) enum DeliveryReply {
    Part {
        part: usize,
        text: String,
        nonce: String,
    },
    Done,
    Held {
        part: usize,
    },
    Acknowledged {
        part: usize,
    },
}

impl Harness<'_, '_> {
    pub(super) fn discord_delivery(&self, action: DeliveryAction) -> Result<DeliveryReply> {
        let origin = match action {
            DeliveryAction::Next { origin } | DeliveryAction::Ack { origin, .. } => origin,
        };
        let id = origin.id();
        let receipt = self.lookup_run(&id)?;
        let key = origin.key();
        ensure!(
            receipt.claim.lane == key.0,
            "Discord origin does not match the run receipt"
        );
        let parts = reply_parts(&receipt);
        match action {
            DeliveryAction::Next { .. } => self.store.next_discord_part(origin, &id, &parts, 0),
            DeliveryAction::Ack { part, remote, .. } => {
                ensure!(part < parts.len(), "Discord reply part does not exist");
                self.store.ack_discord_part(origin, &id, part, remote)?;
                Ok(DeliveryReply::Acknowledged { part })
            }
        }
    }
}

fn reply_parts(receipt: &super::work::RunReceipt) -> Vec<std::borrow::Cow<'_, str>> {
    let text = receipt.discord_text();
    if receipt.fenced_replies() {
        crate::discord_split::partition(text)
    } else {
        // Existing send intents bind the historical text digest and part number.
        split(text)
            .into_iter()
            .map(std::borrow::Cow::Borrowed)
            .collect()
    }
}

/// Discord counts UTF-16 code units. Prefer a word boundary without dropping text.
fn split(mut remainder: &str) -> Vec<&str> {
    const LIMIT: usize = 2_000;
    let mut parts = Vec::new();
    while !remainder.is_empty() {
        let mut width = 0;
        let mut last_space = None;
        let mut end = remainder.len();
        for (offset, ch) in remainder.char_indices() {
            width += ch.len_utf16();
            if width > LIMIT {
                end = last_space.unwrap_or(offset);
                break;
            }
            if width > LIMIT / 2 && ch.is_whitespace() {
                last_space = Some(offset + ch.len_utf8());
            }
        }
        let (part, rest) = remainder.split_at(end);
        if !part.trim().is_empty() {
            parts.push(part);
        }
        remainder = rest;
    }
    parts
}
