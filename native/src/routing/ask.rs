use std::borrow::Cow;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use rustix::fs::{AtFlags, Mode, OFlags, linkat, open, openat, unlinkat};
use serde::Deserialize;

use crate::harness::discord::Snowflake;

const RETAIN: Duration = Duration::from_hours(48);
const TTL_MS: u128 = 15_000;
const MAX_REPLY: usize = 16_384;
const OPEN: OFlags = OFlags::RDONLY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::NONBLOCK)
    .union(OFlags::CLOEXEC);
static STAGING: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
pub struct Reply<'a> {
    pub channel: Snowflake,
    pub message: Snowflake,
    pub reference: Option<Snowflake>,
    pub owner: Snowflake,
    #[serde(borrow)]
    pub text: Cow<'a, str>,
    pub plain: bool,
}

struct Directory(File);

impl Directory {
    fn verify(file: File) -> Result<Self> {
        let stat = file.metadata()?;
        ensure!(
            stat.is_dir()
                && stat.uid() == rustix::process::geteuid().as_raw()
                && stat.mode().trailing_zeros() >= 6,
            "ASK mailbox directory is not private"
        );
        Ok(Self(file))
    }

    fn sub(&self, name: &str) -> Result<Option<Self>> {
        match openat(&self.0, name, OPEN | OFlags::DIRECTORY, Mode::empty()) {
            Ok(fd) => Ok(Some(Self::verify(fd.into())?)),
            Err(rustix::io::Errno::NOENT) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn read(&self, name: &str, limit: usize) -> Result<Option<String>> {
        let file = match openat(&self.0, name, OPEN, Mode::empty()) {
            Ok(fd) => File::from(fd),
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let stat = file.metadata()?;
        let max = u64::try_from(limit)?;
        ensure!(
            stat.is_file()
                && stat.uid() == rustix::process::geteuid().as_raw()
                && stat.mode().trailing_zeros() >= 6
                && stat.len() <= max,
            "ASK file is not private or exceeds its size limit"
        );
        let mut text = String::new();
        file.take(max + 1).read_to_string(&mut text)?;
        ensure!(text.len() <= limit, "ASK file grew during bounded read");
        Ok(Some(text))
    }

    fn expired(&self, now: SystemTime) -> Result<bool> {
        let stat = self.0.metadata()?;
        let created = stat.created().or_else(|_| stat.modified())?;
        Ok(now.duration_since(created).is_ok_and(|age| age > RETAIN))
    }

    fn publish(&self, name: &str, text: &str) -> Result<bool> {
        let dir = &self.0;
        let (temp, mut file) = loop {
            let next = STAGING.fetch_add(1, Ordering::Relaxed);
            // Keep the existing mailbox's partial-file cleanup format.
            let data = (u128::from(std::process::id()) << 64) | u128::from(next);
            let hex = format!("{data:032x}");
            let temp = format!(
                ".partial-{}-{}-{}-{}-{}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..]
            );
            match openat(
                dir,
                temp.as_str(),
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR,
            ) {
                Ok(fd) => break (temp, File::from(fd)),
                Err(rustix::io::Errno::EXIST) => {}
                Err(error) => return Err(error.into()),
            }
        };
        let result = (|| {
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            let installed = match linkat(dir, temp.as_str(), dir, name, AtFlags::empty()) {
                Ok(()) => true,
                Err(rustix::io::Errno::EXIST) => false,
                Err(error) => return Err(error.into()),
            };
            dir.sync_all()?;
            Ok(installed)
        })();
        let cleanup = unlinkat(dir, temp.as_str(), AtFlags::empty());
        if let Err(error) = cleanup
            && error != rustix::io::Errno::NOENT
        {
            eprintln!("ASK staging cleanup failed: {error}");
        }
        result
    }

    fn deliver(&self, message: Snowflake, answer: &str) -> Result<()> {
        let name = format!("reply-{message}");
        self.publish(&name, answer)?;
        if self.read("closed", 1)?.is_some() {
            match unlinkat(&self.0, name.as_str(), AtFlags::empty()) {
                Ok(()) | Err(rustix::io::Errno::NOENT) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

pub fn route(state: &Path, reply: &Reply<'_>) -> Result<bool> {
    if reply.reference.is_none() && (!reply.plain || reply.text.trim().is_empty()) {
        return Ok(false);
    }
    let path = state.join("discord-ask-replies");
    let root = match open(&path, OPEN | OFlags::DIRECTORY, Mode::empty()) {
        Ok(fd) => Directory::verify(fd.into())?,
        Err(rustix::io::Errno::NOENT) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let now = SystemTime::now();
    let owner = reply.owner.to_string();
    if let Some(question) = reply.reference {
        if question >= reply.message {
            return Ok(false);
        }
        let Some(exchange) = root.sub(&format!("{}-{question}", reply.channel))? else {
            return Ok(false);
        };
        if exchange.read("owner", 24)?.as_deref() != Some(&owner) {
            return Ok(false);
        }
        if exchange.read("closed", 1)?.is_none() && !exchange.expired(now)? {
            exchange.deliver(reply.message, &encode(&reply.text, false)?)?;
        }
        return Ok(true);
    }
    plain(&root, &path, reply, &owner, now)
}

fn encode(text: &str, plain: bool) -> Result<String> {
    let answer = if plain {
        serde_json::to_string(&[text])?
    } else {
        serde_json::to_string(text)?
    };
    ensure!(
        answer.len() <= MAX_REPLY,
        "Discord ASK reply exceeds the local size limit"
    );
    Ok(answer)
}

fn accepts(exchange: &Directory, owner: &str, now: SystemTime, message_at: u128) -> Result<bool> {
    if exchange.expired(now)? {
        return Ok(false);
    }
    let Some(lease) = exchange.read("text-intake", 33)? else {
        return Ok(false);
    };
    let Some((start, end)) = lease.split_once(':') else {
        return Ok(false);
    };
    if [start, end]
        .iter()
        .any(|part| part.is_empty() || part.len() > 16 || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Ok(false);
    }
    let start = start.parse::<u128>()?;
    let end = end.parse::<u128>()?;
    let now_ms = now.duration_since(UNIX_EPOCH)?.as_millis();
    Ok(message_at >= start
        && end > now_ms
        && end <= now_ms + TTL_MS
        && exchange.read("owner", 24)?.as_deref() == Some(owner)
        && exchange.read("closed", 1)?.is_none())
}

fn matching(
    root: &Directory,
    path: &Path,
    reply: &Reply<'_>,
    owner: &str,
    now: SystemTime,
) -> Result<Option<String>> {
    let prefix = format!("{}-", reply.channel);
    let mut question = None;
    for entry in fs::read_dir(path)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_prefix(&prefix) else {
            continue;
        };
        if Snowflake::try_from(id.to_owned()).is_ok_and(|id| id < reply.message)
            && let Some(exchange) = root.sub(name)?
            && accepts(
                &exchange,
                owner,
                now,
                u128::from(reply.message.timestamp_ms()),
            )?
        {
            if question.is_some() {
                return Ok(Some("ambiguous".to_owned()));
            }
            question = Some(id.to_owned());
        }
    }
    Ok(question)
}

fn plain(
    root: &Directory,
    path: &Path,
    reply: &Reply<'_>,
    owner: &str,
    now: SystemTime,
) -> Result<bool> {
    let claim = format!("plain-{}-{}-{}", reply.channel, reply.owner, reply.message);
    let mut answer = None;
    let question = if let Some(saved) = root.read(&claim, 20)? {
        saved
    } else {
        let Some(selected) = matching(root, path, reply, owner, now)? else {
            return Ok(false);
        };
        if selected != "ambiguous" {
            answer = Some(encode(&reply.text, true)?);
        }
        if root.publish(&claim, &selected)? {
            selected
        } else {
            root.read(&claim, 20)?
                .context("Discord ASK claim disappeared")?
        }
    };
    if question == "ambiguous" {
        return Ok(false);
    }
    let question = Snowflake::try_from(question).map_err(anyhow::Error::msg)?;
    ensure!(
        question < reply.message,
        "Discord ASK text claim is invalid"
    );
    if let Some(exchange) = root.sub(&format!("{}-{question}", reply.channel))?
        && accepts(
            &exchange,
            owner,
            SystemTime::now(),
            u128::from(reply.message.timestamp_ms()),
        )?
    {
        let text = match answer {
            Some(text) => text,
            None => encode(&reply.text, true)?,
        };
        exchange.deliver(reply.message, &text)?;
    }
    Ok(true)
}
