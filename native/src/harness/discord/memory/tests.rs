use std::fs;
use std::path::PathBuf;

use super::{HEADROOM, Memory, Origin, Snowflake, mpsc};

struct Temp(PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove test memory directory");
    }
}

fn origin(channel: u64, owner: u64, message: u64) -> Origin {
    let snow = |value: u64| Snowflake::try_from(value.to_string()).expect("valid numeric ID");
    Origin {
        bot: snow(1),
        channel: snow(channel),
        owner: snow(owner),
        message: snow(message),
    }
}

#[tokio::test]
async fn checkpoints_before_twenty_mb_without_leaking_room_or_person_notes() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("cataly-memory-{}-{nonce}", std::process::id()));
    fs::create_dir(&path).unwrap();
    let root = Temp(path);
    let (recorder, mut pending) = mpsc::channel(16);
    let memory = Memory {
        root: root.0.clone(),
        project: "p1".into(),
        recorder,
        task: tokio::spawn(async {}),
    };
    memory
        .record(origin(20, 10, 100), "room only", 123)
        .unwrap();
    assert!(pending.try_recv().is_err());
    assert!(
        memory
            .context(origin(20, 10, 101), HEADROOM - 1)
            .unwrap()
            .is_none()
    );
    memory
        .record(origin(20, 10, 101), "decision at threshold", HEADROOM)
        .unwrap();
    let checkpoint = pending.try_recv().unwrap();
    assert!(
        fs::read_to_string(checkpoint)
            .unwrap()
            .contains("decision at threshold")
    );
    for (id, note) in [
        (102, "!remember person private preference"),
        (103, "!remember project verified decision"),
        (104, "!remember common common convention"),
        (105, "!remember common password not-for-storage"),
    ] {
        memory.record(origin(20, 10, id), note, HEADROOM).unwrap();
    }
    let staged = std::iter::from_fn(|| pending.try_recv().ok()).collect::<Vec<_>>();
    assert_eq!(staged.len(), 6);
    let local = memory
        .context(origin(20, 10, 106), HEADROOM)
        .unwrap()
        .unwrap();
    assert!(local.contains("room only"));
    let other = memory
        .context(origin(21, 10, 106), HEADROOM)
        .unwrap()
        .unwrap();
    assert!(other.contains("verified decision") && other.contains("common convention"));
    for forbidden in ["room only", "private preference", "not-for-storage"] {
        assert!(!other.contains(forbidden));
    }
    assert!(
        memory
            .context(origin(20, 11, 106), HEADROOM)
            .unwrap()
            .is_none()
    );
    memory.close().await.unwrap();
}
