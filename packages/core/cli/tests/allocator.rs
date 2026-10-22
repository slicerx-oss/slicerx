// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx allocates through jemalloc wherever jemalloc builds (not MSVC, not wasm32), with the page decay that
//! .cargo/config.toml sets at build time (`JEMALLOC_SYS_WITH_MALLOC_CONF`). jemalloc prints its statistics, the
//! options in force among them, at exit when its environment variable asks for `stats_print`, so this runs the built
//! binary and reads the options back.
#![cfg(all(not(target_env = "msvc"), not(target_arch = "wasm32")))]

use std::process::Command;

/// The options .cargo/config.toml bakes in, as `(name, value)` pairs.
fn baked() -> Vec<(String, String)> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.cargo/config.toml");
    let config = std::fs::read_to_string(path).unwrap();
    let line = config
        .lines()
        .find_map(|l| l.trim().strip_prefix("JEMALLOC_SYS_WITH_MALLOC_CONF"))
        .expect("JEMALLOC_SYS_WITH_MALLOC_CONF in .cargo/config.toml");
    let value = line.trim().trim_start_matches('=').trim().trim_matches('"');
    value
        .split(',')
        .map(|kv| {
            let (k, v) = kv.split_once(':').unwrap();
            (k.to_owned(), v.to_owned())
        })
        .collect()
}

/// An option's value in a jemalloc statistics report, from its `  opt.<name>: <value> (...)` line.
fn option<'a>(report: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("opt.{name}: ");
    report.lines().find_map(|l| {
        let rest = l.trim().strip_prefix(&key)?;
        rest.split_whitespace().next()
    })
}

#[test]
fn sx_runs_on_jemalloc_with_the_baked_decay() {
    let baked = baked();
    assert!(baked.iter().any(|(k, _)| k == "dirty_decay_ms"), "{baked:?}");
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
    for (name, value) in &baked {
        assert_eq!(
            option(&report, name),
            Some(value.as_str()),
            "opt.{name}\n{report}"
        );
    }
}
