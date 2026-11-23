use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::omp::Identity;

mod discord;
#[cfg(feature = "discord")]
pub(super) use discord::HeadSource;
mod receipts;
pub(super) use receipts::Claim;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Binding {
    pub cwd: PathBuf,
    pub session: Identity,
}

pub struct Store {
    root: PathBuf,
    _lock: File,
}

pub enum Record {
    New,
    Starting,
    Bound(Binding),
}

impl Store {
    #[cfg(feature = "discord")]
    pub(super) fn root(&self) -> &Path {
        &self.root
    }

    pub fn open(root: &Path) -> Result<Self> {
        private_dir(root)?;
        let root = fs::canonicalize(root)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(root.join("owner.lock"))?;
        lock.try_lock()
            .context("Cataly state is already controlled or cannot be locked")?;
        Ok(Self { root, _lock: lock })
    }

    pub fn read(&self, key: &str) -> Result<Record> {
        let reader = match File::open(self.root.join(format!("{key}.json"))) {
            Ok(reader) => reader,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let starting = self.root.join(format!("{key}.starting")).try_exists()?
                    || self.root.join(format!("{key}.sessions")).try_exists()?;
                return Ok(if starting {
                    Record::Starting
                } else {
                    Record::New
                });
            }
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        reader.take(16 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 16 * 1024,
            "Cataly session binding exceeded 16 KiB"
        );
        Ok(Record::Bound(
            serde_json::from_slice(&bytes).context("invalid Cataly session binding")?,
        ))
    }

    pub fn reserve(&self, key: &str) -> Result<PathBuf> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.root.join(format!("{key}.starting")))?
            .sync_all()?;
        let root = File::open(&self.root)?;
        root.sync_all()?;
        let dir = self.root.join(format!("{key}.sessions"));
        DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .context("reserving a fresh Cataly session directory")?;
        root.sync_all()?;
        Ok(dir)
    }

    pub fn bind(&self, key: &str, binding: &Binding) -> Result<()> {
        let staged = self.root.join(format!("{key}.binding.tmp"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staged)?;
        file.write_all(&serde_json::to_vec(binding)?)?;
        file.sync_all()?;
        fs::rename(staged, self.root.join(format!("{key}.json")))?;
        let dir = File::open(&self.root)?;
        dir.sync_all()?;
        fs::remove_file(self.root.join(format!("{key}.starting")))?;
        dir.sync_all()?;
        Ok(())
    }
}

pub(super) fn private_dir(path: &Path) -> Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("creating Cataly state directory {}", path.display()));
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == rustix::process::geteuid().as_raw()
            && metadata.permissions().mode().trailing_zeros() >= 6,
        "Cataly state directory must be a private real directory: {}",
        path.display()
    );
    Ok(())
}
