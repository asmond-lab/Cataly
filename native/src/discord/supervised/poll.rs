//! REST intake with TypeScript cursor semantics (discord-inbound.ts, discord-inbound-thread-poll.ts): attach,
//! the quiet probe plus full-page merge, queued-owner merge, and FIFO drain.

use std::collections::BTreeMap;

use anyhow::{Context as _, Result, bail, ensure};
use serde_json::Value;

use super::session::Session;
use crate::discord::{
    Snowflake,
    api::RestStatus,
    inbound::{self, Inbound},
    inbox::First,
    scope,
    threads::{Discovery, Routes},
};

const PAGE: u8 = 100;
/// Bounded backlog per channel and poll (TS reads unboundedly); exceeding it holds the cursor.
const PAGE_LIMIT: usize = 100;
const QUEUE_SCAN: usize = 100_000;

/// The watched conversations (`watched`, `parents`, explicit and `--scope-all` targets).
pub(super) struct Scope<'a> {
    pub(super) explicit: Vec<Snowflake>,
    pub(super) all: bool,
    pub(super) discovery: Option<Discovery>,
    pub(super) routes: &'a Routes,
    /// Polled channels in attachment order.
    pub(super) watched: Vec<Snowflake>,
    polls: u64,
}

impl<'a> Scope<'a> {
    pub(super) const fn new(
        explicit: Vec<Snowflake>,
        all: bool,
        discovery: Option<Discovery>,
        routes: &'a Routes,
    ) -> Self {
        Self {
            explicit,
            all,
            discovery,
            routes,
            watched: Vec::new(),
            polls: 0,
        }
    }

    /// `recallSpaceFor`; without thread following no conversation space is established.
    pub(super) fn space(
        &self,
        channel: Snowflake,
        admitted: Option<Snowflake>,
    ) -> Option<Snowflake> {
        self.discovery
            .as_ref()
            .and_then(|discovery| discovery.space(self.routes, channel, admitted))
    }

    fn watching(&self, channel: Snowflake) -> bool {
        self.watched.contains(&channel)
    }

    /// `accepts` (discord-inbound.ts:125-127).
    fn accepts(&self, channel: Snowflake, parent: Option<Snowflake>) -> bool {
        self.all
            || self.watching(channel)
            || parent.is_some_and(|parent| {
                self.discovery
                    .as_ref()
                    .is_some_and(|discovery| discovery.is_parent(parent))
            })
    }

    fn watch(&mut self, channel: Snowflake) {
        if !self.watching(channel) {
            self.watched.push(channel);
        }
    }
}

/// `unavailable`: a discovered target's lost access is skipped rather than fatal.
fn unavailable(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<RestStatus>()
        .is_some_and(|status| matches!(status.status, 403 | 404))
}

fn id_of(raw: &Value, key: &str) -> Option<Snowflake> {
    raw.get(key)
        .and_then(Value::as_str)
        .and_then(|id| Snowflake::try_from(id.to_owned()).ok())
}

impl Session<'_> {
    fn is_owner(&self, raw: &Value) -> bool {
        inbound::is_owner(raw, self.owner, self.bot)
    }

    async fn read_page(
        &mut self,
        channel: Snowflake,
        limit: u8,
        before: Option<Snowflake>,
    ) -> Result<Option<Vec<Value>>> {
        match self.api.history_raw(channel, before, limit).await {
            Ok(page) => Ok(Some(page)),
            Err(error) if !self.scope.explicit.contains(&channel) && unavailable(&error) => {
                self.scope.watched.retain(|&id| id != channel);
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// `attach` (discord-inbound.ts:88-99): a new conversation starts at `seed` or its latest message.
    async fn attach(&mut self, channel: Snowflake, seed: Option<Snowflake>) -> Result<bool> {
        let cursor = self.cursor(channel, true)?;
        let Some(latest) = self.read_page(channel, 1, None).await? else {
            return Ok(false);
        };
        ensure!(
            latest
                .iter()
                .all(|message| id_of(message, "channel_id") == Some(channel)),
            "Discord inbound channel response does not match the configured channel"
        );
        if cursor.is_none() {
            let start = seed
                .or_else(|| latest.first().and_then(|message| id_of(message, "id")))
                .unwrap_or(Snowflake::FLOOR);
            self.save(channel, start)?;
        }
        self.scope.watch(channel);
        Ok(true)
    }

    /// `refresh`: explicit targets, `--scope-all` discovery and followed threads.
    pub(super) async fn refresh(&mut self, initial: bool, discover: bool) -> Result<()> {
        for channel in self.scope.explicit.clone() {
            let readable = self
                .scope
                .discovery
                .as_ref()
                .is_none_or(|d| d.readable(channel));
            if readable && !self.scope.watching(channel) {
                self.attach(channel, None).await?;
            }
        }
        if self.scope.all && discover {
            for channel in scope::discover(self.api, self.owner).await? {
                if !self.scope.watching(channel) {
                    self.attach(channel, None).await?;
                }
            }
        }
        let Some(discovery) = self.scope.discovery.as_mut() else {
            return Ok(());
        };
        discovery.refresh(self.api, self.scope.routes).await;
        let startup = discovery.startup;
        let active = self.scope.routes.take(true);
        // Stop polling archived threads without deleting their cursor or admitted rows.
        let explicit = self.scope.explicit.clone();
        let routes = self.scope.routes;
        self.scope.watched.retain(|id| {
            explicit.contains(id) || active.contains(id) || routes.parent(*id).is_some()
        });
        for thread in active {
            if self.scope.watching(thread) {
                continue;
            }
            let seed = (!initial).then(|| thread.max(startup));
            if let Err(error) = self.attach(thread, seed).await
                && !unavailable(&error)
            {
                return Err(error);
            }
        }
        Ok(())
    }

    /// `deliver`: emit owner messages, then save the cursor.
    async fn deliver(&mut self, raw: &Value, channel: Snowflake, cursor: Snowflake) -> Result<()> {
        if self.is_owner(raw) {
            let inbound = Inbound::from_raw(raw)?;
            self.emit(&inbound).await?;
        }
        self.save(channel, cursor)
    }

    /// `accept` for a retained FIFO record (discord-inbound.ts:140-172) with its admission cursor and scope.
    async fn accept(
        &mut self,
        raw: &Value,
        admitted: Option<Snowflake>,
        parent: Option<Snowflake>,
    ) -> Result<()> {
        let (Some(id), Some(channel)) = (id_of(raw, "id"), id_of(raw, "channel_id")) else {
            return Ok(());
        };
        if !self.scope.accepts(channel, parent) {
            return Ok(());
        }
        if !self.scope.watching(channel) {
            if self.cursor(channel, true)?.is_none() {
                self.save(
                    channel,
                    admitted.unwrap_or_else(|| id.preceding().unwrap_or(Snowflake::FLOOR)),
                )?;
            }
            // An archived admitted record is delivery work, not a reason to resume polling that thread.
            if parent.is_none() || self.scope.explicit.contains(&channel) {
                self.scope.watch(channel);
            }
        }
        let cursor = self.current(channel)?;
        if id <= cursor
            && (id == cursor || admitted.is_some_and(|after| id <= after) || !self.is_owner(raw))
        {
            return Ok(());
        }
        self.deliver(raw, channel, id.max(cursor)).await
    }

    /// Retained owner records up to `through`, merged before a REST checkpoint (thread-poll.ts:52-74).
    async fn merge_queued(&mut self, channel: Snowflake, through: Snowflake) -> Result<()> {
        let owner = self.owner.to_string();
        let mut after = None;
        for _ in 0..QUEUE_SCAN {
            let Some(job) = self.inbox.next_queued(channel, after)? else {
                return Ok(());
            };
            if job.id > through {
                return Ok(());
            }
            if job
                .payload
                .get("author")
                .and_then(|a| a.get("id"))
                .and_then(Value::as_str)
                != Some(owner.as_str())
            {
                after = Some((job.id, job.row));
                continue;
            }
            if id_of(&job.payload, "channel_id") != Some(channel) {
                bail!("Discord inbound queue message is invalid");
            }
            if !self.scope.accepts(channel, job.parent) {
                self.inbox.remove(job.row)?;
                continue;
            }
            after = Some((job.id, job.row));
            if !self.is_owner(&job.payload) {
                continue;
            }
            self.accept(&job.payload, job.admitted_after, job.parent)
                .await?;
            self.inbox.acknowledge(channel, job.id)?;
            // Recheck arrivals admitted while the previous owner emit was awaited.
            after = None;
        }
        bail!("Discord FIFO exceeded the bounded processing window")
    }

    /// `pollChannel` (discord-inbound-thread-poll.ts:17-79). `queued` merges FIFO records (Gateway mode only).
    async fn poll_channel(&mut self, channel: Snowflake, queued: bool) -> Result<()> {
        let after = self.current(channel)?;
        let Some(latest) = self.read_page(channel, 1, None).await? else {
            return Ok(());
        };
        ensure!(
            latest
                .iter()
                .all(|message| id_of(message, "channel_id") == Some(channel)),
            "Discord inbound channel response does not match the configured channel"
        );
        let Some((head, probe)) = latest
            .first()
            .and_then(|m| id_of(m, "id").map(|id| (id, m.clone())))
        else {
            return Ok(());
        };
        if head <= after {
            return Ok(());
        }
        // Keep the probe if it disappears remotely.
        let mut pending = BTreeMap::from([(head, probe)]);
        let mut before = None;
        let mut complete = false;
        for _ in 0..PAGE_LIMIT {
            let Some(page) = self.read_page(channel, PAGE, before).await? else {
                return Ok(());
            };
            let oldest = page.iter().filter_map(|m| id_of(m, "id")).min();
            for message in &page {
                if let Some(id) = id_of(message, "id")
                    && id_of(message, "channel_id") == Some(channel)
                    && id > after
                {
                    pending.entry(id).or_insert_with(|| message.clone());
                }
            }
            ensure!(
                before.is_none_or(|bound| oldest.is_none_or(|oldest| oldest < bound)),
                "Discord inbound pagination did not advance"
            );
            if page.len() < usize::from(PAGE) || oldest.is_none_or(|oldest| oldest <= after) {
                complete = true;
                break;
            }
            before = oldest;
        }
        ensure!(
            complete,
            "Discord backlog exceeds the bounded history window; no cursor was advanced"
        );
        let last = pending.keys().next_back().copied();
        for (id, message) in pending {
            // An owner checkpoint covers its preceding filtered run; a trailing run needs its own save.
            if !self.is_owner(&message) && Some(id) != last {
                continue;
            }
            if queued {
                self.merge_queued(channel, id).await?;
            }
            if id > self.current(channel)? {
                self.deliver(&message, channel, id).await?;
                if queued {
                    self.inbox.acknowledge(channel, id)?;
                }
            }
        }
        Ok(())
    }

    /// Gateway thread following: refresh routes, then backfill newly attached threads whose first live
    /// messages arrived before their route existed.
    pub(super) async fn follow(&mut self) -> Result<()> {
        if self.scope.discovery.is_none() {
            return Ok(());
        }
        let before = self.scope.watched.clone();
        self.refresh(false, false).await?;
        for channel in self.scope.watched.clone() {
            if !before.contains(&channel) && self.scope.watching(channel) {
                self.poll_channel(channel, true).await?;
            }
        }
        Ok(())
    }

    /// One `poll` (discord-inbound.ts:198-202).
    pub(super) async fn poll(&mut self, queued: bool) -> Result<()> {
        self.scope.polls += 1;
        let refresh = if self.scope.all {
            self.scope.polls.is_multiple_of(100)
        } else {
            self.scope.discovery.is_some() && self.scope.polls.is_multiple_of(10)
        };
        if refresh {
            self.refresh(false, true).await?;
        }
        for channel in self.scope.watched.clone() {
            if self.scope.watching(channel) {
                self.poll_channel(channel, queued).await?;
            }
        }
        Ok(())
    }

    /// `sync` (discord-inbound.ts:203-218): the Gateway backfill on READY/RESUMED.
    pub(super) async fn sync(&mut self) -> Result<()> {
        self.refresh(false, true).await?;
        for channel in self.inbox.queued_channels(QUEUE_SCAN)? {
            if self.scope.watching(channel) {
                continue;
            }
            if self.scope.all {
                self.attach(channel, None).await?;
            } else if let Some(parent) = self.inbox.parent_for(channel)?
                && self
                    .scope
                    .discovery
                    .as_ref()
                    .is_some_and(|discovery| discovery.is_parent(parent))
                && self.cursor(channel, true)?.is_some()
            {
                self.poll_channel(channel, true).await?;
            }
        }
        self.poll(true).await
    }

    /// The live FIFO drain (discord-inbound-live.ts:87-116): oldest message per channel first; a `sync`
    /// marker owes a backfill before it is retired. Returns whether a backfill completed.
    pub(super) async fn drain(&mut self) -> Result<bool> {
        let mut backfilled = false;
        for _ in 0..QUEUE_SCAN {
            match self.inbox.first()? {
                None => return Ok(backfilled),
                Some(First::Sync { row }) => {
                    self.sync().await.context(super::Backfill)?;
                    self.inbox.remove(row)?;
                    backfilled = true;
                }
                Some(First::Message { row, channel: None }) => self.inbox.remove(row)?,
                Some(First::Message {
                    row,
                    channel: Some(channel),
                }) => {
                    let Some(job) = self.inbox.next_queued(channel, None)? else {
                        self.inbox.remove(row)?;
                        continue;
                    };
                    self.accept(&job.payload, job.admitted_after, job.parent)
                        .await?;
                    if self.scope.accepts(channel, job.parent) {
                        self.inbox.acknowledge(channel, job.id)?;
                    } else {
                        self.inbox.remove(job.row)?;
                    }
                }
            }
        }
        bail!("Discord FIFO exceeded the bounded processing window")
    }
}
