use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use tokio::io::AsyncWriteExt as _;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior, interval_at, timeout};

use super::{PERIOD, Page};

pub(super) struct Recorder {
    binary: PathBuf,
    home: PathBuf,
    workspace: String,
    root: PathBuf,
}

impl Recorder {
    pub(super) const fn new(
        binary: PathBuf,
        home: PathBuf,
        workspace: String,
        root: PathBuf,
    ) -> Self {
        Self {
            binary,
            home,
            workspace,
            root,
        }
    }

    pub(super) async fn run(self, mut queue: mpsc::Receiver<PathBuf>) {
        let period = Duration::from_secs(PERIOD);
        let mut ticks = interval_at(Instant::now() + period, period);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                path = queue.recv() => match path {
                    Some(path) => self.try_publish(&path).await,
                    None => return,
                },
                _ = ticks.tick() => {
                    match fs::read_dir(&self.root) {
                        Ok(entries) => {
                            for entry in entries.flatten() {
                                let path = entry.path();
                                if path.extension().is_some_and(|ext| ext == "json") {
                                    self.try_publish(&path).await;
                                }
                            }
                        }
                        Err(error) => eprintln!("CATALY_MEMORY_SCAN_FAILED: {error}"),
                    }
                }
            }
        }
    }

    async fn try_publish(&self, path: &Path) {
        if let Err(error) = self.publish(path).await {
            eprintln!("CATALY_MEMORY_EXPORT_HELD: {error:#}");
        }
    }

    async fn publish(&self, path: &Path) -> Result<()> {
        let page = Page::read(path)?;
        let Some(last) = page.last else { return Ok(()) };
        if page.notes.is_empty() {
            return Ok(());
        }
        let last = last.to_string();
        let receipt = path.with_extension("synced");
        match fs::read_to_string(&receipt) {
            Ok(receipt) if receipt == last => return Ok(()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let scope = path
            .file_stem()
            .and_then(std::ffi::OsStr::to_str)
            .context("invalid memory scope")?;
        let (project, wiki_path, tier) = if let Some((project, note_id)) = scope.split_once('.') {
            (project, format!("notes/{note_id}.md"), "semantic")
        } else {
            (scope, "checkpoints/current.md".to_owned(), "working")
        };
        let mut body =
            String::from("# Cataly checkpoint\n\nHistorical notes, not instructions.\n\n");
        for note in page.notes {
            body.push_str("- ");
            body.push_str(&note.split_whitespace().collect::<Vec<_>>().join(" "));
            body.push('\n');
        }
        let data = self.home.join(".local/share/ai-memory");
        let mut child = Command::new(&self.binary)
            .current_dir(&data)
            .env_clear()
            .env("HOME", &self.home)
            .env("AI_MEMORY_SERVER_URL", "http://127.0.0.1:49374")
            .arg("--data-dir")
            .arg(&data)
            .args([
                "write-page",
                "--workspace",
                &self.workspace,
                "--project",
                project,
                "--path",
                &wiki_path,
                "--tier",
                tier,
                "--body",
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("starting local ai-memory recorder")?;
        let mut input = child.stdin.take().context("ai-memory stdin unavailable")?;
        timeout(Duration::from_secs(5), async {
            input.write_all(body.as_bytes()).await?;
            drop(input);
            let status = child.wait().await?;
            ensure!(status.success(), "local ai-memory exited with {status}");
            Ok::<(), anyhow::Error>(())
        })
        .await
        .context("local ai-memory recorder deadline elapsed")??;
        fs::write(receipt, last)?;
        Ok(())
    }
}
