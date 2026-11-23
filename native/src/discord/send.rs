use anyhow::{Context, Result, bail, ensure};
use clap::Args;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt as _;

use super::{Snowflake, api::DiscordApi};
use crate::discord_split as split;

#[derive(Args, Debug)]
pub struct SendOptions {
    /// Exact channel ID or a unique name in `CATALY_DISCORD_GUILD_ID`.
    #[arg(long, required_unless_present = "thread", conflicts_with = "thread")]
    to: Option<String>,
    /// Exact destination thread ID.
    #[arg(long, value_parser = parse_id)]
    thread: Option<Snowflake>,
    /// Reply to this exact message in the destination.
    #[arg(long, value_parser = parse_id, conflicts_with = "edit")]
    reply: Option<Snowflake>,
    /// Replace one existing message instead of creating a new one.
    #[arg(long, value_parser = parse_id)]
    edit: Option<Snowflake>,
}

fn parse_id(raw: &str) -> Result<Snowflake, &'static str> {
    Snowflake::try_from(raw.to_owned())
}

#[derive(Deserialize)]
struct Channel {
    id: Snowflake,
    #[serde(rename = "type")]
    kind: u8,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    channel: Snowflake,
    ids: Vec<Snowflake>,
    reply_confirmed: bool,
}

pub async fn send(options: SendOptions) -> Result<()> {
    const LIMIT: u64 = 256 * 1024;
    let mut input = Vec::new();
    tokio::io::stdin()
        .take(LIMIT + 1)
        .read_to_end(&mut input)
        .await?;
    ensure!(
        u64::try_from(input.len())? <= LIMIT,
        "Discord text exceeds 256 KiB"
    );
    let text = std::str::from_utf8(&input)?.trim();
    ensure!(!text.is_empty(), "Discord text is empty");
    ensure!(
        !text.contains("$("),
        "Discord text contains a shell substitution marker"
    );
    let fits = text.encode_utf16().take(split::LIMIT + 1).count() <= split::LIMIT;
    ensure!(
        options.edit.is_none() || fits,
        "--edit text exceeds 2000 UTF-16 code units"
    );
    let (api, _) = super::configured_api()?;
    let channel = resolve(&api, &options).await?;
    let mut delivery = Delivery {
        channel,
        ids: Vec::new(),
        reply_confirmed: false,
    };
    if let Some(message) = options.edit {
        api.edit_text(channel, message, text).await?;
    } else {
        for (index, part) in split::partition(text).into_iter().enumerate() {
            let reference = if index == 0 { options.reply } else { None };
            let sent = api.post_text(channel, reference, &part).await.with_context(|| {
                let known = delivery.ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(" ");
                format!("Discord delivery stopped at part {}; confirmed IDs: [{}]. Inspect the destination before retrying", index + 1, known)
            })?;
            delivery.ids.push(sent.id);
            if let Some(reference) = reference {
                delivery.reply_confirmed = sent.confirms_reply(channel, reference);
            }
        }
    }
    println!("{}", serde_json::to_string(&delivery)?);
    Ok(())
}

async fn resolve(api: &DiscordApi, options: &SendOptions) -> Result<Snowflake> {
    if let Some(thread) = options.thread {
        return Ok(thread);
    }
    let to = options
        .to
        .as_deref()
        .context("Discord destination is missing")?;
    ensure!(!to.is_empty(), "Discord destination is empty");
    let channel = if to.bytes().all(|byte| byte.is_ascii_digit()) {
        let id = parse_id(to).map_err(anyhow::Error::msg)?;
        let channel: Channel = api.get(&format!("channels/{id}")).await?;
        ensure!(channel.id == id, "Discord returned another channel");
        channel
    } else {
        let guild = std::env::var("CATALY_DISCORD_GUILD_ID")
            .context("set CATALY_DISCORD_GUILD_ID to look up a channel name")?;
        let guild = parse_id(&guild).map_err(anyhow::Error::msg)?;
        let name = to.strip_prefix('#').unwrap_or(to);
        let channels: Vec<Channel> = api.get(&format!("guilds/{guild}/channels")).await?;
        let mut hits = channels
            .into_iter()
            .filter(|channel| channel.name.as_deref() == Some(name));
        let Some(channel) = hits.next() else {
            bail!("No channel matched that name in the configured Discord guild")
        };
        ensure!(
            hits.next().is_none(),
            "More than one channel matched that name in the configured Discord guild"
        );
        channel
    };
    ensure!(
        !matches!(channel.kind, 15 | 16),
        "Discord forum/media channels require an explicit thread"
    );
    Ok(channel.id)
}
