use anyhow::Result;
use serde_json::{Value, json};

use super::{discord_token, gateway::Link, gateway_url, monitor::termination};

pub async fn presence() -> Result<()> {
    let url = gateway_url()?;
    let token = discord_token()?;
    tokio::select! {
        result = termination() => {
            result?;
            println!("PRESENCE_STOPPED discord");
            Ok(())
        }
        result = (Link { url: &url, token: &token, intake: None }).run() => result,
    }
}

pub(super) fn online() -> Value {
    json!({"since": null, "activities": [], "status": "online", "afk": false})
}
