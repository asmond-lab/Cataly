use std::{
    fs::File,
    io::Read as _,
    os::{fd::OwnedFd, unix::fs::MetadataExt as _},
    path::{Component, Path},
    sync::Arc,
};

use anyhow::{Context, Result, bail, ensure};
use rustix::fs::{Mode, OFlags, open, openat};

const MAX_BYTES: u64 = 16 * 1024;
const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

pub(super) struct Workspace(Arc<OwnedFd>);

impl Workspace {
    pub(super) async fn open(path: &Path) -> Result<Self> {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut components = path.components();
            ensure!(
                components.next() == Some(Component::RootDir),
                "workspace is not absolute"
            );
            let mut directory = open("/", DIRECTORY, Mode::empty())?;
            for component in components {
                let Component::Normal(name) = component else {
                    bail!("workspace path was not normalized");
                };
                directory = openat(&directory, name, DIRECTORY, Mode::empty())?;
            }
            Ok(Self(Arc::new(directory)))
        })
        .await
        .context("opening the Cataly workspace")?
    }

    pub(super) async fn read(&self) -> Result<String> {
        let directory = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || {
            let fd = openat(
                &*directory,
                "README.md",
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )?;
            let file = File::from(fd);
            let metadata = file.metadata()?;
            ensure!(
                metadata.is_file() && metadata.nlink() == 1,
                "README.md is not a single-link regular file"
            );
            ensure!(metadata.len() <= MAX_BYTES, "README.md exceeds 16 KiB");
            let mut bytes = Vec::new();
            file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
            ensure!(
                u64::try_from(bytes.len())? <= MAX_BYTES,
                "README.md exceeds 16 KiB"
            );
            String::from_utf8(bytes).context("README.md is not UTF-8")
        })
        .await
        .context("reading the Cataly workspace README")?
    }
}
