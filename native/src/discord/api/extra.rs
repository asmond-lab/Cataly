//! Read receipts, channel lookups and idempotent lane reply parts.
//!
//! `call` reports a failed status only as text, so these requests use `exchange`, which keeps the HTTP status and
//! the Discord JSON error `code` that source-deleted detection (10008) needs.

use std::time::Duration;

use anyhow::{Context, Result, ensure};
use reqwest::{Method, StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{DiscordApi, Snowflake};

const UNKNOWN_MESSAGE: u64 = 10_008;
const PART_DEADLINE: Duration = Duration::from_secs(8);
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

/// A non-success Discord REST status with the JSON error code when the body carried one.
#[derive(Debug)]
pub(in crate::discord) struct RestStatus {
    pub(in crate::discord) status: u16,
    pub(in crate::discord) code: Option<u64>,
}

impl std::fmt::Display for RestStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Discord REST returned HTTP {}", self.status)
    }
}

impl std::error::Error for RestStatus {}

impl RestStatus {
    fn unknown_message(&self) -> bool {
        self.status == 404 && self.code == Some(UNKNOWN_MESSAGE)
    }
}

/// The outcome of posting one lane reply part.
#[derive(Debug, PartialEq, Eq)]
pub(in crate::discord) enum PartPost {
    Sent(Snowflake),
    /// The referenced owner message no longer exists (Discord 404 code 10008).
    SourceMissing,
}

fn error_code(bytes: &[u8]) -> Option<u64> {
    #[derive(Deserialize)]
    struct Body {
        code: Value,
    }
    let body: Body = serde_json::from_slice(bytes).ok()?;
    match body.code {
        Value::Number(code) => code.as_u64(),
        Value::String(code) => code.parse().ok(),
        _ => None,
    }
}

impl DiscordApi {
    /// One authorized request; a non-success status is returned as a `RestStatus` error after one bounded 429 retry.
    async fn exchange(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Vec<u8>> {
        let url = self.base.join(path)?;
        let mut trial = 0;
        loop {
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .header(header::AUTHORIZATION, self.authorization.clone());
            if let Some(body) = body {
                request = request.json(body);
            }
            let mut response = request
                .send()
                .await
                .map_err(reqwest::Error::without_url)
                .context("Discord REST I/O failed")?;
            let status = response.status();
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(reqwest::Error::without_url)?
            {
                ensure!(
                    bytes.len() + chunk.len() <= RESPONSE_LIMIT,
                    "Discord REST response exceeded its limit"
                );
                bytes.extend_from_slice(&chunk);
            }
            if status.is_success() {
                return Ok(bytes);
            }
            if status == StatusCode::TOO_MANY_REQUESTS && trial == 0 {
                #[derive(Deserialize)]
                struct RateLimit {
                    retry_after: f64,
                }
                if let Ok(rate) = serde_json::from_slice::<RateLimit>(&bytes)
                    && (0.0..=5.0).contains(&rate.retry_after)
                {
                    trial += 1;
                    tokio::time::sleep(Duration::from_secs_f64(rate.retry_after)).await;
                    continue;
                }
            }
            return Err(RestStatus {
                status: status.as_u16(),
                code: error_code(&bytes),
            }
            .into());
        }
    }

    /// Adds the bot's 👀 reaction to an owner message.
    pub(in crate::discord) async fn react_seen(
        &self,
        channel: Snowflake,
        message: Snowflake,
    ) -> Result<()> {
        self.exchange(
            Method::PUT,
            &format!("channels/{channel}/messages/{message}/reactions/%F0%9F%91%80/@me"),
            None,
        )
        .await?;
        Ok(())
    }

    /// The raw channel object; a failed status surfaces as a `RestStatus` error.
    pub(in crate::discord) async fn channel_info(&self, channel: Snowflake) -> Result<Value> {
        let bytes = self
            .exchange(Method::GET, &format!("channels/{channel}"), None)
            .await?;
        serde_json::from_slice(&bytes).context("invalid Discord REST response")
    }

    /// Opens (or returns) the bot's DM channel with `recipient`.
    pub(in crate::discord) async fn dm_channel(&self, recipient: Snowflake) -> Result<Value> {
        let bytes = self
            .exchange(
                Method::POST,
                "users/@me/channels",
                Some(&json!({ "recipient_id": recipient.to_string() })),
            )
            .await?;
        serde_json::from_slice(&bytes).context("invalid Discord REST response")
    }

    /// Posts one reply part with an enforced nonce. A deleted source (404/10008, or 400/404 whose source GET is
    /// 404/10008) is `SourceMissing`; every other failure is the POST error. The POST and its check share 8 s.
    pub(in crate::discord) async fn post_part(
        &self,
        channel: Snowflake,
        reference: Snowflake,
        text: &str,
        nonce: &str,
    ) -> Result<PartPost> {
        tokio::time::timeout(
            PART_DEADLINE,
            self.post_part_now(channel, reference, text, nonce),
        )
        .await
        .context("Discord lane reply timed out")?
    }

    async fn post_part_now(
        &self,
        channel: Snowflake,
        reference: Snowflake,
        text: &str,
        nonce: &str,
    ) -> Result<PartPost> {
        #[derive(Deserialize)]
        struct Reply {
            id: Option<Value>,
            channel_id: Option<Value>,
        }
        let messages = format!("channels/{channel}/messages");
        let body = part_body(reference, text, nonce);
        match self.exchange(Method::POST, &messages, Some(&body)).await {
            Ok(bytes) => {
                let reply: Reply = serde_json::from_slice(&bytes)
                    .context("Discord did not confirm the lane reply destination")?;
                let id = match reply.id {
                    Some(Value::String(id)) => Snowflake::try_from(id).ok(),
                    _ => None,
                };
                let same = matches!(&reply.channel_id, Some(Value::String(at)) if *at == channel.to_string());
                match id {
                    Some(id) if same => Ok(PartPost::Sent(id)),
                    _ => anyhow::bail!("Discord did not confirm the lane reply destination"),
                }
            }
            Err(error) => {
                let Some(status) = error.downcast_ref::<RestStatus>() else {
                    return Err(error);
                };
                if status.status != 400 && status.status != 404 {
                    return Err(error);
                }
                if status.unknown_message() {
                    return Ok(PartPost::SourceMissing);
                }
                match self
                    .exchange(Method::GET, &format!("{messages}/{reference}"), None)
                    .await
                {
                    Err(check)
                        if check
                            .downcast_ref::<RestStatus>()
                            .is_some_and(RestStatus::unknown_message) =>
                    {
                        Ok(PartPost::SourceMissing)
                    }
                    _ => Err(error),
                }
            }
        }
    }
}

fn part_body(reference: Snowflake, text: &str, nonce: &str) -> Value {
    json!({
        "content": text,
        "allowed_mentions": { "parse": [], "replied_user": false },
        "nonce": nonce,
        "enforce_nonce": true,
        "message_reference": { "message_id": reference.to_string(), "fail_if_not_exists": true },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_body_matches_lane_monitor() {
        let reference = Snowflake::try_from("42".to_owned()).unwrap();
        assert_eq!(
            part_body(reference, "hi", "abc"),
            json!({
                "content": "hi",
                "allowed_mentions": {"parse": [], "replied_user": false},
                "nonce": "abc",
                "enforce_nonce": true,
                "message_reference": {"message_id": "42", "fail_if_not_exists": true}
            })
        );
    }

    #[test]
    fn unknown_message_needs_404_and_10008() {
        assert_eq!(error_code(br#"{"code":10008,"message":"x"}"#), Some(10_008));
        assert_eq!(error_code(br#"{"code":"10008"}"#), Some(10_008));
        assert_eq!(error_code(b"nope"), None);
        assert!(
            RestStatus {
                status: 404,
                code: Some(10_008)
            }
            .unknown_message()
        );
        assert!(
            !RestStatus {
                status: 400,
                code: Some(10_008)
            }
            .unknown_message()
        );
        assert!(
            !RestStatus {
                status: 404,
                code: Some(10_003)
            }
            .unknown_message()
        );
    }
}
