// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Idle exit, for hosts that start the service on the first request and bill
//! only while it runs (`SX_CLOUD_IDLE_EXIT_S`, Fly.io with auto start).
//!
//! A proxy that stops idle machines sees only connections, so it could stop
//! one in the middle of a slice nobody is watching. The service decides
//! instead: it exits once no request other than `/healthz` has arrived for
//! the idle time and no job is being sliced.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

static LAST: AtomicU64 = AtomicU64::new(0);
static BUSY: AtomicUsize = AtomicUsize::new(0);

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Records activity: a request, or the start or end of a job.
pub fn touch() {
    LAST.store(now_s(), Ordering::Relaxed);
}

/// Held while a job is being sliced; the process does not go idle meanwhile.
pub struct Busy(());

/// Marks the process busy until the returned guard is dropped.
pub fn busy() -> Busy {
    BUSY.fetch_add(1, Ordering::Relaxed);
    touch();
    Busy(())
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.fetch_sub(1, Ordering::Relaxed);
        touch();
    }
}

/// How long the process has been idle, or `None` while a job runs.
pub fn idle_for() -> Option<Duration> {
    if BUSY.load(Ordering::Relaxed) > 0 {
        return None;
    }
    Some(Duration::from_secs(
        now_s().saturating_sub(LAST.load(Ordering::Relaxed)),
    ))
}

/// Sets `stop` once the process has been idle for `after`. Counts from the
/// call, so a fresh start always gets the full idle time.
pub async fn exit_when_idle(after: Duration, stop: &watch::Sender<bool>) {
    touch();
    let poll = (after / 4).clamp(Duration::from_secs(1), Duration::from_secs(15));
    loop {
        tokio::time::sleep(poll).await;
        if *stop.borrow() {
            return;
        }
        if idle_for().is_some_and(|d| d >= after) {
            eprintln!("sx-cloud: idle for {} s; exiting", after.as_secs());
            let _ = stop.send(true);
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_job_keeps_the_process_awake() {
        touch();
        assert!(idle_for().is_some());
        let guard = busy();
        assert_eq!(idle_for(), None);
        drop(guard);
        assert!(idle_for().is_some_and(|d| d < Duration::from_secs(2)));
    }
}
