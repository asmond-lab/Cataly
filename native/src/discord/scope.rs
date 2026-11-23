//! `--scope-all` channel discovery (discoverChannels parity).

use std::collections::BTreeSet;

use anyhow::Result;
use serde_json::Value;

use super::Snowflake;
use super::api::{DiscordApi, RestStatus};

/// Text (0) and announcement (5) channels.
const TEXT_CHANNELS: [u64; 2] = [0, 5];

fn snowflake(value: Option<&Value>) -> Option<Snowflake> {
    match value {
        Some(Value::String(id)) => Snowflake::try_from(id.clone()).ok(),
        _ => None,
    }
}

fn items(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn guild_ids(guilds: &Value) -> Vec<Snowflake> {
    items(guilds)
        .iter()
        .filter_map(|guild| snowflake(guild.get("id")))
        .collect()
}

fn text_channels(channels: &Value, into: &mut BTreeSet<Snowflake>) {
    for channel in items(channels) {
        let kind = channel.get("type").and_then(Value::as_u64);
        if let Some(id) = snowflake(channel.get("id"))
            && kind.is_some_and(|kind| TEXT_CHANNELS.contains(&kind))
        {
            into.insert(id);
        }
    }
}

fn active_threads(threads: &Value, into: &mut BTreeSet<Snowflake>) {
    if let Some(list) = threads.get("threads") {
        into.extend(
            items(list)
                .iter()
                .filter_map(|thread| snowflake(thread.get("id"))),
        );
    }
}

/// Every text channel and active thread in the bot's guilds, plus the owner's DM with the bot, deduplicated and
/// sorted. A 403/404 opening the DM skips it; every other failure fails discovery.
pub(super) async fn discover(api: &DiscordApi, owner: Snowflake) -> Result<Vec<Snowflake>> {
    let mut ids = BTreeSet::new();
    let guilds: Value = api.get("users/@me/guilds").await?;
    for guild in guild_ids(&guilds) {
        let channels: Value = api.get(&format!("guilds/{guild}/channels")).await?;
        text_channels(&channels, &mut ids);
        let threads: Value = api.get(&format!("guilds/{guild}/threads/active")).await?;
        active_threads(&threads, &mut ids);
    }
    match api.dm_channel(owner).await {
        Ok(dm) => ids.extend(snowflake(dm.get("id"))),
        Err(error)
            if error
                .downcast_ref::<RestStatus>()
                .is_some_and(|status| matches!(status.status, 403 | 404)) => {}
        Err(error) => return Err(error),
    }
    Ok(ids.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn id(value: u64) -> Snowflake {
        Snowflake::try_from(value.to_string()).unwrap()
    }

    #[test]
    fn filters_dedupes_and_sorts() {
        let mut ids = BTreeSet::new();
        text_channels(
            &json!([
                {"id": "30", "type": 0},
                {"id": "10", "type": 5},
                {"id": "20", "type": 2},
                {"id": "40"},
                {"id": "01", "type": 0},
                {"id": 50, "type": 0}
            ]),
            &mut ids,
        );
        active_threads(
            &json!({"threads": [{"id": "30"}, {"id": "25"}, {"id": "x"}]}),
            &mut ids,
        );
        active_threads(&json!({"threads": "nope"}), &mut ids);
        text_channels(&json!({"not": "array"}), &mut ids);
        assert_eq!(
            ids.into_iter().collect::<Vec<_>>(),
            vec![id(10), id(25), id(30)]
        );
        assert_eq!(
            guild_ids(&json!([{"id": "7"}, {}, null, {"id": "0"}])),
            vec![id(7)]
        );
    }
}
