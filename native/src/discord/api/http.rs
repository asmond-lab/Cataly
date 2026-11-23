use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use reqwest::{Method, StatusCode, header};
use serde::Deserialize;
use serde_json::Value;

use super::DiscordApi;

impl DiscordApi {
    pub(super) async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        auth: bool,
    ) -> Result<Vec<u8>> {
        let url = self.base.join(path)?;
        for trial in 0..2 {
            let mut request = self.client.request(method.clone(), url.clone());
            if auth {
                request = request.header(header::AUTHORIZATION, self.authorization.clone());
            }
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
                    bytes.len() + chunk.len() <= 2 * 1024 * 1024,
                    "Discord REST response exceeded its limit"
                );
                bytes.extend_from_slice(&chunk);
            }
            if status.is_success() {
                return Ok(bytes);
            }
            if status == StatusCode::TOO_MANY_REQUESTS && trial == 0 && auth {
                #[derive(Deserialize)]
                struct RateLimit {
                    retry_after: f64,
                }
                if let Ok(rate) = serde_json::from_slice::<RateLimit>(&bytes)
                    && (0.0..=5.0).contains(&rate.retry_after)
                {
                    tokio::time::sleep(Duration::from_secs_f64(rate.retry_after)).await;
                    continue;
                }
            }
            return Err(super::RestStatus {
                status: status.as_u16(),
                code: None,
            }
            .into());
        }
        bail!("Discord REST request did not complete")
    }
}
