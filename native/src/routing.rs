use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;

use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

pub mod ask;
pub mod head;

const LIMIT: usize = 128 * 1024;

// Adapted from omp-superagent host-owner/src/transport.rs (MIT; see NOTICE).
// Count the frame without allocating a second JSON buffer.
fn wire_size(frame: &Value) -> serde_json::Result<usize> {
    struct Size(usize);
    impl io::Write for Size {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut size = Size(1); // JSONL delimiter
    serde_json::to_writer(&mut size, frame)?;
    Ok(size.0)
}

#[derive(Deserialize)]
struct Request<'a> {
    id: u32,
    #[serde(flatten, borrow)]
    operation: Operation<'a>,
}

#[derive(Deserialize)]
#[serde(tag = "route", rename_all = "snake_case")]
enum Operation<'a> {
    Ask {
        state: PathBuf,
        #[serde(flatten, borrow)]
        reply: ask::Reply<'a>,
    },
    Head {
        #[serde(flatten, borrow)]
        request: head::Request<'a>,
    },
}

impl Operation<'_> {
    fn run(self) -> Result<Value> {
        match self {
            Self::Ask { state, reply } => {
                ensure!(state.is_absolute(), "ASK state path must be absolute");
                Ok(json!(ask::route(&state, &reply)?))
            }
            Self::Head { request } => Ok(serde_json::to_value(request.resolve()?)?),
        }
    }
}

pub fn run() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut frame = Vec::new();
    loop {
        frame.clear();
        if (&mut input)
            .take(u64::try_from(LIMIT)?)
            .read_until(b'\n', &mut frame)?
            == 0
        {
            return Ok(());
        }
        ensure!(
            frame.last() == Some(&b'\n'),
            "routing request exceeded the frame limit or was truncated"
        );
        let request: Request<'_> = serde_json::from_slice(&frame)?;
        let response = match request.operation.run() {
            Ok(value) => json!({"id": request.id, "value": value}),
            Err(error) => json!({"id": request.id, "error": error.to_string()}),
        };
        let response = if wire_size(&response)? <= LIMIT {
            response
        } else {
            json!({"id": request.id, "error": "native routing response exceeded the frame limit"})
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
}
