// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx --version`: a host checking the engine it ships gets one line and exit 0, not the usage.

use std::process::Command;

#[test]
fn version_prints_one_line() {
    for flag in ["--version", "-V"] {
        let out = Command::new(env!("CARGO_BIN_EXE_sx")).arg(flag).output().unwrap();
        assert!(
            out.status.success(),
            "{flag}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("sx {}\n", env!("CARGO_PKG_VERSION"))
        );
        assert!(out.stderr.is_empty(), "{flag}");
    }
    let usage = Command::new(env!("CARGO_BIN_EXE_sx")).output().unwrap();
    assert_eq!(usage.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&usage.stderr).contains("sx --version"));
}
