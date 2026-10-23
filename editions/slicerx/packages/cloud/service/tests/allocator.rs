// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-cloud allocates through jemalloc wherever jemalloc builds, with the page decay packages/core/alloc sets per
//! operating system, as the sx command line tool does (packages/core/cli/tests/allocator.rs). The service refuses an
//! unknown role and exits at once; jemalloc prints its statistics, the options in force among them, at that exit.
#![cfg(all(not(target_env = "msvc"), not(target_arch = "wasm32")))]

use std::process::Command;

/// The decay options this operating system should run with, as `(name, value)` pairs.
#[cfg(target_os = "linux")]
const DECAY: [(&str, &str); 2] = [("dirty_decay_ms", "100"), ("muzzy_decay_ms", "0")];
#[cfg(not(target_os = "linux"))]
const DECAY: [(&str, &str); 2] = [("dirty_decay_ms", "0"), ("muzzy_decay_ms", "0")];

#[test]
fn sx_cloud_runs_on_jemalloc_with_the_decay_for_its_os() {
    let out = Command::new(env!("CARGO_BIN_EXE_sx-cloud"))
        .env("_RJEM_MALLOC_CONF", "stats_print:true")
        .env("SX_CLOUD_BACKEND", "memory")
        .env("SX_CLOUD_ROLE", "none")
        .output()
        .unwrap();
    assert!(!out.status.success());
    let report = String::from_utf8_lossy(&out.stderr);
    assert!(
        report.contains("Begin jemalloc statistics"),
        "sx-cloud did not print jemalloc statistics:\n{report}"
    );
    for (name, value) in DECAY {
        let key = format!("opt.{name}: ");
        let got = report
            .lines()
            .find_map(|l| l.trim().strip_prefix(&key)?.split_whitespace().next());
        assert_eq!(got, Some(value), "opt.{name}\n{report}");
    }
}
