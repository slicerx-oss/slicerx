// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! edition names in command help and usage errors.

use std::process::Command;

#[test]
fn call_help_uses_the_edition_name() {
    let config = std::env::temp_dir().join(format!("sx-call-edition-{}.json", std::process::id()));
    std::fs::write(&config, r#"{"brand":{"name":" Workshop Tools "}}"#).unwrap();
    for flag in [Some("--help"), Some("-h"), None] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sx"));
        command.arg("call").env("SLICERX_CONFIG", &config);
        if let Some(flag) = flag {
            command.arg(flag);
        }
        let out = command.output().unwrap();
        assert_eq!(out.status.code(), Some(if flag.is_some() { 0 } else { 2 }));
        let text = if flag.is_some() {
            assert!(out.stderr.is_empty());
            String::from_utf8(out.stdout).unwrap()
        } else {
            assert!(out.stdout.is_empty());
            String::from_utf8(out.stderr).unwrap()
        };
        assert!(text.contains("Run Workshop Tools tools in order"), "{text}");
        assert!(text.contains("usage: sx call"), "{text}");
        assert!(text.contains("design_steps '{\"design\":\"obj_1\"}'"), "{text}");
    }
    std::fs::remove_file(config).unwrap();
}
