use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};

use super::{Claim, Harness, Outcome, RunClaim, RunReceipt, RunTool};
use crate::harness::discord::Origin;

impl Harness<'_, '_> {
    pub(in crate::harness) fn remember_discord(
        &self,
        origin: Origin,
        input: &str,
        remember: impl FnOnce() -> Result<&'static str>,
    ) -> Result<RunReceipt> {
        let id = origin.id();
        let lane = origin.key().0;
        let fingerprint = format!("{:x}", Sha256::digest(input.as_bytes()));
        if !matches!(self.store.receipt(&id)?, Claim::Missing) {
            let receipt = self.lookup_run(&id)?;
            ensure!(
                receipt.claim.lane == lane && receipt.claim.fingerprint == fingerprint,
                "memory command does not match its recorded request"
            );
            return Ok(receipt);
        }
        self.store.lane_available(&lane)?;
        let claim = RunClaim {
            id,
            lane,
            session_id: "cataly-memory".to_owned(),
            fingerprint,
            tool: Some(RunTool::Memory),
            reply_format: None,
        };
        self.store.claim(&claim)?;
        let outcome = match remember() {
            Ok(text) => Outcome::Completed {
                text: text.to_owned(),
            },
            Err(error) => {
                eprintln!("CATALY_MEMORY_CHECKPOINT_HELD: {error:#}");
                Outcome::Failed {
                    reason: "Local memory checkpoint failed".to_owned(),
                }
            }
        };
        let result = RunReceipt { claim, outcome };
        self.store.finish_run(&result)?;
        Ok(result)
    }
}
