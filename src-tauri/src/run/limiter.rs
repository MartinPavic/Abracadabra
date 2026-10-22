//! Caps how many runs execute their pipeline at once. The limit lives in the
//! limiter and is refreshed by every `acquire` and by `set_limit` (called when
//! Settings are saved), so a change also reaches runs that are already waiting.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

#[derive(Default)]
struct Inner {
    running: Mutex<usize>,
    limit: AtomicU32,
    released: Notify,
}

#[derive(Clone, Default)]
pub struct RunLimiter(Arc<Inner>);

/// Wakes runs waiting for an earlier run in their project folder to finish.
/// Whether a run may start is decided from the run store (see
/// `RunStore::blocker_of`); this only says "look again".
#[derive(Default)]
pub struct ProjectGate(Notify);

impl ProjectGate {
    pub fn notify(&self) {
        self.0.notify_waiters();
    }

    /// A future that completes on the next `notify`. Call `enable` on it before
    /// re-checking the condition, so a notification in between isn't lost.
    pub fn changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.0.notified()
    }
}

/// Held for as long as a run occupies a slot; dropping it frees the slot.
pub struct RunPermit(Arc<Inner>);

impl RunLimiter {
    /// Changes the limit (minimum 1) and wakes waiting runs to re-check it.
    pub fn set_limit(&self, limit: u32) {
        self.0.limit.store(limit.max(1), Ordering::SeqCst);
        self.0.released.notify_waiters();
    }

    /// Waits until fewer than `limit` runs (minimum 1) hold a permit.
    pub async fn acquire(&self, limit: u32) -> RunPermit {
        self.0.limit.store(limit.max(1), Ordering::SeqCst);
        loop {
            let released = self.0.released.notified();
            tokio::pin!(released);
            released.as_mut().enable();

            {
                let mut running = self.0.running.lock().expect("run limiter lock poisoned");
                if *running < self.0.limit.load(Ordering::SeqCst) as usize {
                    *running += 1;
                    return RunPermit(self.0.clone());
                }
            }
            released.await;
        }
    }
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        *self.0.running.lock().expect("run limiter lock poisoned") -= 1;
        self.0.released.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn waits_for_a_free_slot() {
        let limiter = RunLimiter::default();
        let first = limiter.acquire(2).await;
        let _second = limiter.acquire(2).await;

        // Both slots are taken, so a third acquire must block...
        assert!(timeout(Duration::from_millis(50), limiter.acquire(2)).await.is_err());

        // ...until one is released.
        drop(first);
        assert!(timeout(Duration::from_millis(500), limiter.acquire(2)).await.is_ok());
    }

    #[tokio::test]
    async fn a_waiting_run_is_woken_when_a_slot_frees() {
        let limiter = RunLimiter::default();
        let held = limiter.acquire(1).await;

        let waiter = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.acquire(1).await })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiter.is_finished());

        drop(held);
        assert!(timeout(Duration::from_millis(500), waiter).await.is_ok());
    }

    #[tokio::test]
    async fn raising_the_limit_wakes_waiting_runs() {
        let limiter = RunLimiter::default();
        let _held = limiter.acquire(1).await;

        let waiter = {
            let limiter = limiter.clone();
            tokio::spawn(async move { limiter.acquire(1).await })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiter.is_finished());

        limiter.set_limit(2);
        assert!(timeout(Duration::from_millis(500), waiter).await.is_ok());
    }

    #[tokio::test]
    async fn zero_limit_still_allows_one_run() {
        let limiter = RunLimiter::default();
        assert!(timeout(Duration::from_millis(100), limiter.acquire(0)).await.is_ok());
    }
}
