use std::fs::{self, File, OpenOptions};
use std::path::Path;

use anyhow::{Context, Result, ensure};
use serde::{Serialize, de::DeserializeOwned};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;

use super::Store;
use crate::harness::work::{RunClaim, RunId, RunReceipt};

const MAX_RECORD_BYTES: u64 = 512 * 1024;

pub enum Claim {
    Missing,
    Pending(RunClaim),
    Done(RunReceipt),
}

impl Store {
    pub fn receipt(&self, id: &RunId) -> Result<Claim> {
        let claim = load::<RunClaim>(&self.root.join(format!("run-{}.claim", id.as_str())))?;
        if let Some(result) =
            load::<RunReceipt>(&self.root.join(format!("run-{}.result", id.as_str())))?
        {
            ensure!(
                result.claim.id == *id
                    && claim.as_ref() == Some(&result.claim)
                    && result.is_terminal(),
                "invalid Cataly terminal result"
            );
            return Ok(Claim::Done(result));
        }
        if let Some(claim) = claim {
            ensure!(
                claim.id == *id,
                "Cataly request claim identity does not match its file"
            );
            Ok(Claim::Pending(claim))
        } else {
            Ok(Claim::Missing)
        }
    }

    pub fn lane_available(&self, lane: &str) -> Result<()> {
        let pending = self.root.join(format!("run-lane-{lane}.pending"));
        if let Some(claim) = load::<RunClaim>(&pending)? {
            ensure!(
                claim.lane == lane,
                "Cataly pending request belongs to another lane"
            );
            let Claim::Done(receipt) = self.receipt(&claim.id)? else {
                anyhow::bail!(
                    "lane {lane} has an unconfirmed request {}; review it before accepting new work",
                    claim.id.as_str()
                );
            };
            ensure!(
                receipt.claim == claim,
                "Cataly terminal result does not match its lane claim"
            );
            fs::remove_file(pending)?;
            File::open(&self.root)?.sync_all()?;
        }
        Ok(())
    }

    pub fn claim(&self, claim: &RunClaim) -> Result<()> {
        let recorded = self.root.join(format!("run-{}.claim", claim.id.as_str()));
        publish(&recorded, claim)?;
        fs::hard_link(
            recorded,
            self.root.join(format!("run-lane-{}.pending", claim.lane)),
        )?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    pub fn finish_run(&self, receipt: &RunReceipt) -> Result<()> {
        publish(
            &self
                .root
                .join(format!("run-{}.result", receipt.claim.id.as_str())),
            receipt,
        )?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }
}

pub(super) fn load<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        u64::try_from(bytes.len())? <= MAX_RECORD_BYTES,
        "Cataly request receipt exceeds its limit"
    );
    Ok(Some(
        serde_json::from_slice(&bytes).context("invalid Cataly request receipt")?,
    ))
}

pub(super) fn publish(path: &Path, record: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(std::ffi::OsStr::to_str)
            .context("Cataly record missing suffix")?
    ));
    // Store owns the directory lock. A leftover temp file was never published, or its hard link already exists.
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("reclaiming an interrupted Cataly receipt write"),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    serde_json::to_writer(&mut file, record)?;
    file.sync_all()?;
    fs::hard_link(&temporary, path)?;
    fs::remove_file(temporary)?;
    Ok(())
}
