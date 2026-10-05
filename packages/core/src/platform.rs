// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The small platform layer: a monotonic clock for stage timings. Native
//! builds use `std::time::Instant`; `wasm32-unknown-unknown` has no clock, so
//! stage timings read zero there and the host measures wall time itself.

/// A monotonic microsecond clock.
pub trait Clock {
    fn now_micros(&self) -> u64;
}

/// The default clock for the current target.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

#[cfg(not(target_arch = "wasm32"))]
impl Clock for SystemClock {
    fn now_micros(&self) -> u64 {
        use crate::par::Init as _;
        use std::sync::OnceLock;
        use std::time::Instant;
        static START: OnceLock<Instant> = OnceLock::new();
        let start = *START.once(Instant::now);
        u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX)
    }
}

#[cfg(target_arch = "wasm32")]
impl Clock for SystemClock {
    fn now_micros(&self) -> u64 {
        0
    }
}

/// Measures one stage.
pub(crate) struct Timer(u64);

impl Timer {
    pub(crate) fn start() -> Self {
        Self(SystemClock.now_micros())
    }
    pub(crate) fn micros(&self) -> u64 {
        SystemClock.now_micros().saturating_sub(self.0)
    }
}
