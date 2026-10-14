// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
#![cfg(feature = "brep")]
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn cli_bounds_exact_input_before_json_parsing_removes_whitespace() {
    let limit = 32 * 1024 * 1024;
    for bytes in [limit, limit + 1] {
        let mut input = String::from(r#"{"min":[0,0,0],"max":[20,20,20]}"#);
        input.extend(std::iter::repeat_n(' ', bytes - input.len()));
        let mut child = Command::new(env!("CARGO_BIN_EXE_sx-geom"))
            .arg("brep.box")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("starts sx-geom");
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let result = child.wait_with_output().expect("sx-geom exits");
        let reply: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        if bytes == limit {
            assert!(result.status.success(), "{reply}");
            assert!(reply["body"].is_number());
        } else {
            assert!(!result.status.success(), "{reply}");
            assert!(
                reply["error"].as_str().unwrap().contains("exceeds 32 MiB"),
                "{reply}"
            );
        }
    }
}
