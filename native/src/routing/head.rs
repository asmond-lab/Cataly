use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use rustix::fs::{Mode, OFlags, open};
use serde::{Deserialize, Serialize};

use crate::harness::discord::Snowflake;

const LINE_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Operation {
    Prepare,
    Dispatch,
    Reconcile,
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    Accepted { receipt: String },
    Rejected { receipt: String },
    Ready,
    Deliver,
    Reject,
    Unresolved,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Binding {
    New,
    Original,
    Other,
}

#[derive(Deserialize)]
pub(super) struct Request<'a> {
    op: Operation,
    file: PathBuf,
    identity: &'a str,
    fingerprint: &'a str,
    check_disk: bool,
    binding: Binding,
    accepts: bool,
}

impl Request<'_> {
    pub(super) fn resolve(self) -> Result<Action> {
        ensure!(
            self.file.is_absolute(),
            "head transcript path must be absolute"
        );
        ensure!(
            self.identity.split(':').count() == 4
                && self
                    .identity
                    .split(':')
                    .all(|id| Snowflake::try_from(id.to_owned()).is_ok()),
            "invalid head source identity"
        );
        ensure!(
            self.fingerprint.len() == 64
                && self
                    .fingerprint
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid head fingerprint"
        );
        if self.check_disk
            && let Some(action) = receipt(&self.file, self.identity, self.fingerprint)?
        {
            return Ok(action);
        }
        Ok(match (self.op, self.binding) {
            (Operation::Prepare, Binding::New) => Action::Ready,
            (Operation::Dispatch, Binding::Original) if self.accepts => Action::Deliver,
            (Operation::Dispatch, Binding::Original) => Action::Reject,
            _ => Action::Unresolved,
        })
    }
}

fn candidate(line: &[u8], identity: &str, fingerprint: &str) -> Result<Option<Action>> {
    if !line.windows(3).any(|window| window == b"omp") {
        return Ok(None);
    }
    // Only admission entries need decoding. Ordinary OMP entries remain opaque.
    let text = std::str::from_utf8(line).context("invalid native transcript encoding")?;
    if !text.contains("\"ompCatalyAdmission\"") && !text.contains("\"ompDoriAdmission\"") {
        return Ok(None);
    }
    let entry: serde_json::Value = serde_json::from_slice(line)?;
    let (accepted, metadata) = match (entry["type"].as_str(), entry["customType"].as_str()) {
        (Some("custom_message"), Some("cataly-monitor")) => {
            (true, &entry["details"]["ompCatalyAdmission"])
        }
        (Some("custom_message"), Some("dori-monitor")) => {
            (true, &entry["details"]["ompDoriAdmission"])
        }
        (Some("custom"), Some("omp-cataly:admission-rejected")) => {
            (false, &entry["data"]["ompCatalyAdmission"])
        }
        (Some("custom"), Some("omp-dori:admission-rejected")) => {
            (false, &entry["data"]["ompDoriAdmission"])
        }
        _ => return Ok(None),
    };
    if metadata["identity"].as_str() != Some(identity) {
        return Ok(None);
    }
    ensure!(
        metadata["fingerprint"].as_str() == Some(fingerprint),
        "head admission identity conflict"
    );
    let receipt = entry["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .context("head admission identity conflict")?
        .to_owned();
    Ok(Some(if accepted {
        Action::Accepted { receipt }
    } else {
        Action::Rejected { receipt }
    }))
}

pub fn receipt(path: &Path, identity: &str, fingerprint: &str) -> Result<Option<Action>> {
    let mut file = File::from(open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == rustix::process::geteuid().as_raw()
            && metadata.nlink() == 1,
        "head receipt requires an owned regular native transcript"
    );
    let mut block = vec![0; 64 * 1024];
    let mut line = Vec::new();
    let mut end = metadata.len();
    let mut terminated = false;
    let mut oversized = false;
    while end != 0 {
        let start = end.saturating_sub(u64::try_from(block.len())?);
        let bytes = &mut block[..usize::try_from(end - start)?];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(bytes)
            .context("native transcript changed while checking admission")?;
        end = start;
        let mut boundary = bytes.len();
        loop {
            let split = bytes[..boundary].iter().rposition(|byte| *byte == b'\n');
            let start = split.map_or(0, |index| index + 1);
            let part = &bytes[start..boundary];
            if terminated && !oversized {
                if line.len() + part.len() <= LINE_LIMIT {
                    line.extend(part.iter().rev());
                } else {
                    oversized = true;
                    line.clear();
                }
            }
            let Some(index) = split else { break };
            if terminated && !oversized {
                line.reverse();
                if let Some(found) = candidate(&line, identity, fingerprint)? {
                    return Ok(Some(found));
                }
            }
            terminated = true;
            oversized = false;
            line.clear();
            boundary = index;
        }
    }
    if !terminated || oversized {
        return Ok(None);
    }
    line.reverse();
    candidate(&line, identity, fingerprint)
}
