// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx allocates through jemalloc wherever jemalloc builds (not MSVC, not wasm32), with the page decay packages/core/alloc
//! sets per operating system. jemalloc prints its statistics, the options in force among them, at exit when its
//! environment variable asks for `stats_print`, so this runs the built binary and reads the options back.
#![cfg(all(not(target_env = "msvc"), not(target_arch = "wasm32")))]

use std::process::Command;

/// The decay options this operating system should run with, as `(name, value)` pairs.
#[cfg(target_os = "linux")]
const DECAY: [(&str, &str); 2] = [("dirty_decay_ms", "100"), ("muzzy_decay_ms", "0")];
#[cfg(not(target_os = "linux"))]
const DECAY: [(&str, &str); 2] = [("dirty_decay_ms", "0"), ("muzzy_decay_ms", "0")];

/// An option's value in a jemalloc statistics report, from its `  opt.<name>: <value> (...)` line.
fn option<'a>(report: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("opt.{name}: ");
    report.lines().find_map(|l| {
        let rest = l.trim().strip_prefix(&key)?;
        rest.split_whitespace().next()
    })
}

#[test]
fn sx_runs_on_jemalloc_with_the_decay_for_its_os() {
    // The prefixed name: tikv-jemalloc-sys builds jemalloc with the `_rjem_` prefix.
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("--version")
        .env("_RJEM_MALLOC_CONF", "stats_print:true")
        .output()
        .unwrap();
    assert!(out.status.success());
    let report = String::from_utf8_lossy(&out.stderr);
    assert!(
        report.contains("Begin jemalloc statistics"),
        "sx did not print jemalloc statistics, so it does not allocate through jemalloc:\n{report}"
    );
    for (name, value) in DECAY {
        assert_eq!(option(&report, name), Some(value), "opt.{name}\n{report}");
    }
}
