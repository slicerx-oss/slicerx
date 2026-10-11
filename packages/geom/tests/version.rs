// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-geom --version`: one plain line and exit 0.

use std::process::Command;

#[test]
fn version_prints_one_line() {
    for flag in ["--version", "-V"] {
        let out = Command::new(env!("CARGO_BIN_EXE_sx-geom"))
            .arg(flag)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{flag}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("sx-geom {}\n", env!("CARGO_PKG_VERSION"))
        );
    }
}
