// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The memory the machine has available, for the guards that keep a big slice from taking more than a share of it
//! (`paint.rs`, the painted layers' grids). Read once, on first use; a host that knows better gives it with
//! [`set_available`]. `None` where it cannot be read (Windows without a host value, the browser), and then nothing is
//! capped.

use crate::par::Init as _;
use std::sync::OnceLock;

static GIVEN: OnceLock<Option<u64>> = OnceLock::new();

/// The available memory as the host reads it, bytes, before the first slice asks. Later calls change nothing.
pub fn set_available(bytes: Option<u64>) {
    let _ = GIVEN.set(bytes);
}

/// The memory available to this process, bytes: the host's value, else the system's own figure.
pub(crate) fn available() -> Option<u64> {
    *GIVEN.once(read)
}

#[cfg(target_os = "linux")]
fn read() -> Option<u64> {
    meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

#[cfg(target_os = "macos")]
fn read() -> Option<u64> {
    let out = std::process::Command::new("/usr/bin/vm_stat").output().ok()?;
    vm_stat(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read() -> Option<u64> {
    None
}

/// `MemAvailable` from `/proc/meminfo`, bytes.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn meminfo(text: &str) -> Option<u64> {
    let line = text.lines().find(|l| l.starts_with("MemAvailable:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    kb.checked_mul(1024)
}

/// Free, inactive and speculative pages from `vm_stat`, bytes: the pages macOS hands out without paging anything out.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn vm_stat(text: &str) -> Option<u64> {
    let page: u64 = text
        .lines()
        .next()?
        .split("page size of ")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let pages = |name: &str| -> Option<u64> {
        let line = text.lines().find(|l| l.starts_with(name))?;
        line.rsplit(':').next()?.trim().trim_end_matches('.').parse().ok()
    };
    let n =
        pages("Pages free")? + pages("Pages inactive").unwrap_or(0) + pages("Pages speculative").unwrap_or(0);
    n.checked_mul(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_linux_and_macos_figures() {
        assert_eq!(
            meminfo("MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    8000000 kB\n"),
            Some(8_000_000 * 1024)
        );
        assert_eq!(meminfo("MemTotal: 1 kB\n"), None);
        let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10.\nPages active:                             99.\nPages inactive:                           20.\nPages speculative:                         3.\n";
        assert_eq!(vm_stat(vm), Some(33 * 16384));
        assert_eq!(vm_stat("nothing"), None);
    }
}
