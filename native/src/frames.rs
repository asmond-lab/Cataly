use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};

pub const PHYSICAL_LIMIT: usize = 1024 * 1024;
pub const LOGICAL_LIMIT: usize = 64 * PHYSICAL_LIMIT;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Ready,
    Response,
    RpcChunk,
    RpcFrameError,
    #[serde(other)]
    Event,
}

#[derive(Deserialize)]
struct Header {
    #[serde(rename = "type")]
    kind: Kind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk<'a> {
    #[serde(rename = "chunkId")]
    id: &'a str,
    index: usize,
    count: usize,
    byte_length: usize,
    data: &'a str,
}

pub struct Frame {
    pub(crate) kind: Kind,
    pub(crate) bytes: Vec<u8>,
}

pub struct Frames<R> {
    pub(crate) reader: BufReader<R>,
    physical_limit: usize,
    logical_limit: usize,
    chunking: bool,
}

impl<R: tokio::io::AsyncRead + Unpin> Frames<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            physical_limit: PHYSICAL_LIMIT,
            logical_limit: LOGICAL_LIMIT,
            chunking: false,
        }
    }

    pub(crate) fn set_limits(&mut self, physical: usize, logical: usize) -> Result<()> {
        ensure!(
            physical > 0 && logical > 0,
            "OMP advertised invalid RPC frame limits"
        );
        self.physical_limit = PHYSICAL_LIMIT.min(physical);
        self.logical_limit = LOGICAL_LIMIT.min(logical);
        Ok(())
    }

    pub(crate) const fn physical_limit(&self) -> usize {
        self.physical_limit
    }

    pub(crate) const fn enable_chunking(&mut self) {
        self.chunking = true;
    }

    pub(crate) async fn read(&mut self) -> Result<Frame> {
        let initial = read_line(&mut self.reader, self.physical_limit).await?;
        let kind = serde_json::from_slice::<Header>(&initial)
            .context("invalid OMP RPC frame")?
            .kind;
        if kind != Kind::RpcChunk {
            return Ok(Frame {
                kind,
                bytes: initial,
            });
        }
        ensure!(self.chunking, "OMP sent RPC chunks without negotiation");
        let first: Chunk<'_> = serde_json::from_slice(&initial).context("invalid OMP RPC chunk")?;
        ensure!(
            first.byte_length <= self.logical_limit
                && !first.id.is_empty()
                && first.index == 0
                && (1..=first.byte_length).contains(&first.count),
            "invalid OMP RPC chunk sequence bounds"
        );
        let mut bytes = Vec::new();
        append_chunk(&mut bytes, &first)?;
        for index in 1..first.count {
            let raw = read_line(&mut self.reader, self.physical_limit).await?;
            ensure!(
                serde_json::from_slice::<Header>(&raw)?.kind == Kind::RpcChunk,
                "interleaved OMP RPC chunk sequence"
            );
            let chunk: Chunk<'_> = serde_json::from_slice(&raw).context("invalid OMP RPC chunk")?;
            ensure!(
                chunk.index == index
                    && chunk.id == first.id
                    && chunk.count == first.count
                    && chunk.byte_length == first.byte_length,
                "inconsistent OMP RPC chunk sequence"
            );
            append_chunk(&mut bytes, &chunk)?;
        }
        ensure!(
            bytes.len() == first.byte_length,
            "incomplete OMP RPC chunk data"
        );
        let reassembled = std::str::from_utf8(&bytes).context("invalid UTF-8 in OMP RPC chunks")?;
        let kind = serde_json::from_str::<Header>(reassembled)
            .context("invalid reassembled OMP RPC frame")?
            .kind;
        ensure!(kind != Kind::RpcChunk, "nested OMP RPC chunk sequence");
        Ok(Frame { kind, bytes })
    }
}

async fn read_line(reader: &mut (impl AsyncBufRead + Unpin), max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await.context("reading OMP RPC stdout")?;
        ensure!(
            !available.is_empty(),
            "OMP closed RPC stdout before a complete response; check the configured OMP model/profile"
        );
        let end = available.iter().position(|byte| *byte == b'\n');
        let consumed = end.map_or(available.len(), |index| index + 1);
        ensure!(
            bytes.len() + consumed <= max,
            "OMP RPC frame exceeded its physical limit"
        );
        bytes.extend_from_slice(&available[..end.unwrap_or(consumed)]);
        reader.consume(consumed);
        if end.is_some() {
            return Ok(bytes);
        }
    }
}

fn append_chunk(bytes: &mut Vec<u8>, chunk: &Chunk<'_>) -> Result<()> {
    let segment = STANDARD
        .decode(chunk.data)
        .context("invalid OMP RPC base64 chunk")?;
    ensure!(
        !segment.is_empty() && bytes.len() + segment.len() <= chunk.byte_length,
        "OMP RPC chunk exceeds declared logical length"
    );
    bytes.extend_from_slice(&segment);
    Ok(())
}

#[cfg(test)]
mod tests;
