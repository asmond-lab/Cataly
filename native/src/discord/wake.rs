use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct Wake {
    pending: AtomicU64,
    notify: Notify,
}

impl Wake {
    pub(super) const ALL: u64 = u64::MAX;

    pub(super) fn send(&self, channels: u64) {
        self.pending.fetch_or(channels, Ordering::Relaxed);
        self.notify.notify_one();
    }

    pub(super) fn take(&self) -> u64 {
        self.pending.swap(0, Ordering::Relaxed)
    }

    pub(super) async fn receive(&self) -> u64 {
        self.notify.notified().await;
        self.take()
    }
}

#[cfg(test)]
mod tests {
    use super::Wake;

    #[tokio::test]
    async fn coalesces_only_the_channels_that_woke_and_clears_after_receive() {
        let wake = Wake::default();
        wake.send(1 << 2);
        wake.send(1 << 2);
        wake.send(1 << 63);
        assert_eq!(wake.receive().await, (1 << 2) | (1 << 63));
        assert_eq!(wake.take(), 0);
        wake.send(Wake::ALL);
        assert_eq!(wake.receive().await, Wake::ALL);
    }
}
