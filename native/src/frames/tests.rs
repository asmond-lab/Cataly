use anyhow::{Context, Result};
use serde_json::json;

use super::{Frames, Kind, STANDARD};
use base64::Engine as _;

fn chunks(payload: &[u8], split: usize) -> [String; 2] {
    let (head, tail) = payload.split_at(split);
    [(0, head), (1, tail)].map(|(index, part)| {
        format!(
            "{}\n",
            json!({
                "type": "rpc_chunk", "chunkId": "proof", "index": index,
                "count": 2, "byteLength": payload.len(), "data": STANDARD.encode(part),
            })
        )
    })
}

#[tokio::test]
async fn reassembles_utf8_split_inside_a_character() -> Result<()> {
    let payload = r#"{"type":"response","text":"한글"}"#.as_bytes();
    let split = payload
        .iter()
        .position(|b| !b.is_ascii())
        .context("fixture lacks Unicode")?
        + 1;
    let stream = chunks(payload, split).concat();
    let mut frames = Frames::new(stream.as_bytes());
    frames.enable_chunking();
    let frame = frames.read().await?;
    assert!(frame.kind == Kind::Response);
    assert_eq!(frame.bytes, payload);
    Ok(())
}

#[tokio::test]
async fn rejects_an_event_between_chunks() -> Result<()> {
    let [first, second] = chunks(br#"{"type":"response"}"#, 4);
    let stream = format!("{first}{{\"type\":\"agent_end\"}}\n{second}");
    let mut frames = Frames::new(stream.as_bytes());
    frames.enable_chunking();
    let error = frames
        .read()
        .await
        .err()
        .context("interleaved frame was accepted")?;
    assert!(error.to_string().contains("interleaved"), "{error:#}");
    Ok(())
}

#[tokio::test]
async fn enforces_advertised_physical_and_reassembly_limits() -> Result<()> {
    let plain = b"{\"type\":\"response\"}\n";
    let mut frames = Frames::new(plain.as_slice());
    frames.set_limits(plain.len() - 1, 128)?;
    let error = frames
        .read()
        .await
        .err()
        .context("oversized line was accepted")?;
    assert!(error.to_string().contains("physical limit"), "{error:#}");

    let stream = chunks(&plain[..plain.len() - 1], 4).concat();
    let mut frames = Frames::new(stream.as_bytes());
    frames.set_limits(1024, plain.len() - 2)?;
    frames.enable_chunking();
    let error = frames
        .read()
        .await
        .err()
        .context("oversized logical frame was accepted")?;
    assert!(error.to_string().contains("sequence bounds"), "{error:#}");
    Ok(())
}
