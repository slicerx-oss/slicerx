// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the time a timed test's work spent on a core. a loaded machine stretches the wall clock with the turns the
//! thread waits for a core, which is other jobs' time, not the work's

/// what `f` returns, and the seconds this thread ran it; the wall clock where the kernel does not say
pub(crate) fn seconds<T>(f: impl FnOnce() -> T) -> (T, f64) {
    let (start, wall) = (ran(), std::time::Instant::now());
    let out = f();
    let wall = wall.elapsed().as_secs_f64();
    match (start, ran()) {
        (Some(a), Some(b)) => (out, b - a),
        _ => (out, wall),
    }
}

/// seconds this thread has run so far, from the Linux scheduler's count
fn ran() -> Option<f64> {
    // a running thread's count is brought up to date when it yields
    std::thread::yield_now();
    let s = std::fs::read_to_string("/proc/thread-self/schedstat").ok()?;
    Some(s.split_whitespace().next()?.parse::<f64>().ok()? / 1e9)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_sleep_is_no_work() {
        let ((), slept) = super::seconds(|| std::thread::sleep(std::time::Duration::from_millis(50)));
        // on Linux the thread ran for next to none of it; elsewhere it is the wall clock
        if std::fs::read_to_string("/proc/thread-self/schedstat").is_ok() {
            assert!(slept < 0.01, "{slept} s");
        } else {
            assert!(slept >= 0.05, "{slept} s");
        }
    }
}
