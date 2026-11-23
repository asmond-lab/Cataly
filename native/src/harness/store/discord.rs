use std::fs::File;
use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::Store;
use super::receipts::{load, publish};
use crate::harness::discord::{DeliveryReply, Origin, Snowflake};
use crate::harness::work::RunId;

#[derive(Deserialize, Eq, PartialEq, Serialize)]
struct Attempt {
    origin: Origin,
    part: usize,
    digest: String,
}

#[derive(Deserialize, Eq, PartialEq, Serialize)]
struct Posted {
    attempt: Attempt,
    remote: Snowflake,
}

#[cfg(feature = "discord")]
#[derive(Deserialize, Eq, PartialEq, Serialize)]
pub(in crate::harness) struct HeadSource {
    pub bot: Snowflake,
    pub owner: Snowflake,
    pub channel: Snowflake,
}

impl Store {
    #[cfg(feature = "discord")]
    pub(in crate::harness) fn bind_discord_head(&self, expected: Option<HeadSource>) -> Result<()> {
        let path = self.root.join("discord-head.source");
        match (load::<HeadSource>(&path)?, expected) {
            (None, Some(source)) => {
                // Do not reinterpret an existing lane inbox as the head.
                let origin = Origin {
                    bot: source.bot,
                    owner: source.owner,
                    channel: source.channel,
                    message: Snowflake::FLOOR,
                };
                ensure!(
                    !self
                        .root
                        .join(format!("{}.cursor", origin.key().0))
                        .try_exists()?,
                    "Discord head requires a state directory not previously used as a lane for this channel"
                );
                publish(&path, &source)?;
                File::open(&self.root)?.sync_all()?;
            }
            (Some(source), expected) => ensure!(
                expected.as_ref() == Some(&source),
                "Discord head state is bound to a different bot, owner or channel"
            ),
            (None, None) => {}
        }
        Ok(())
    }

    fn discord_paths(&self, id: &RunId, part: usize) -> (PathBuf, PathBuf) {
        let path = self.root.join(format!("{}-part-{part}", id.as_str()));
        (
            path.with_extension("sending"),
            path.with_extension("posted"),
        )
    }

    pub(in crate::harness) fn next_discord_part(
        &self,
        origin: Origin,
        id: &RunId,
        parts: &[impl AsRef<str>],
        start: usize,
    ) -> Result<DeliveryReply> {
        for (part, text) in parts.iter().enumerate().skip(start) {
            let text = text.as_ref();
            let (sending, posted) = self.discord_paths(id, part);
            let attempt = Attempt {
                origin,
                part,
                digest: format!("{:x}", Sha256::digest(text.as_bytes())),
            };
            let intent = load::<Attempt>(&sending)?;
            if let Some(receipt) = load::<Posted>(&posted)? {
                ensure!(
                    receipt.attempt == attempt && intent == Some(attempt),
                    "Discord reply receipt changed"
                );
                continue;
            }
            if let Some(intent) = intent {
                ensure!(intent == attempt, "Discord reply intent changed");
                // An unknown POST may have succeeded even if its short remote nonce window is over.
                return Ok(DeliveryReply::Held { part });
            }
            publish(&sending, &attempt)?;
            File::open(&self.root)?.sync_all()?;
            let nonce = format!(
                "{:x}",
                Sha256::digest(format!("cataly-discord:{}:{part}", id.as_str()))
            );
            return Ok(DeliveryReply::Part {
                part,
                text: text.to_owned(),
                nonce: nonce[..24].to_owned(),
            });
        }
        Ok(DeliveryReply::Done)
    }

    pub(in crate::harness) fn ack_discord_part(
        &self,
        origin: Origin,
        id: &RunId,
        part: usize,
        remote: Snowflake,
    ) -> Result<()> {
        let (sending, posted) = self.discord_paths(id, part);
        let attempt =
            load::<Attempt>(&sending)?.context("Discord reply has no saved send intent")?;
        ensure!(
            attempt.origin == origin && attempt.part == part,
            "Discord reply acknowledgement does not match its send intent"
        );
        let receipt = Posted { attempt, remote };
        if let Some(existing) = load::<Posted>(&posted)? {
            ensure!(
                existing == receipt,
                "Discord reply was acknowledged with a different message ID"
            );
        } else {
            publish(&posted, &receipt)?;
            File::open(&self.root)?.sync_all()?;
        }
        Ok(())
    }
}
