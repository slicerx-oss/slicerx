// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-cloud allocates through jemalloc wherever jemalloc builds, with the page decay .cargo/config.toml sets at build
//! time, as the sx command line tool does (packages/core/cli/tests/allocator.rs). The service refuses an unknown
//! role and exits at once; jemalloc prints its statistics, the options in force among them, at that exit.
#![cfg(all(not(target_env = "msvc"), not(target_arch = "wasm32")))]

use std::process::Command;

#[test]
fn sx_cloud_runs_on_jemalloc_with_the_baked_decay() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../../.cargo/config.toml");
    let config = std::fs::read_to_string(path).unwrap();
    let baked = config
        .lines()
        .find_map(|l| l.trim().strip_prefix("JEMALLOC_SYS_WITH_MALLOC_CONF"))
        .expect("JEMALLOC_SYS_WITH_MALLOC_CONF in .cargo/config.toml")
        .trim()
        .trim_start_matches('=')
        .trim()
        .trim_matches('"');
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
    for kv in baked.split(',') {
        let (name, value) = kv.split_once(':').unwrap();
        let key = format!("opt.{name}: ");
        let got = report
            .lines()
            .find_map(|l| l.trim().strip_prefix(&key)?.split_whitespace().next());
        assert_eq!(got, Some(value), "opt.{name}\n{report}");
    }
}
