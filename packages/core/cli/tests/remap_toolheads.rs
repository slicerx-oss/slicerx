// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx remap-toolheads` on a four-filament U1 slice: every reference to a logical tool moves to its physical toolhead
//! together (T, M109 T and the pre-extrude INDEX), comments stay, an identity map changes nothing, and each refusal
//! is a clean error with nothing written.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use sha2::{Digest, Sha256};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../connect/tests/fixtures/u1-four-filament.gcode")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sx-remap-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sx(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_sx"))
        .args(args)
        .output()
        .unwrap()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// The code of a line, without its comment.
fn code(line: &str) -> &str {
    line.split_once(';').map_or(line, |(code, _)| code).trim()
}

/// The tool a line selects, for `T<n>` lines.
fn selection(line: &str) -> Option<u8> {
    let word = code(line).split_whitespace().next()?;
    word.strip_prefix('T')?.parse().ok()
}

fn param(line: &str, command: &str, prefix: &str) -> Option<u8> {
    let mut words = code(line).split_whitespace();
    (words.next()? == command).then_some(())?;
    words.find_map(|w| w.strip_prefix(prefix)?.parse().ok())
}

#[test]
fn a_four_filament_u1_slice_moves_every_reference_of_a_tool_together() {
    let dir = scratch("swap");
    let out = dir.join("out.gcode");
    let run = sx(&[
        "remap-toolheads",
        fixture().to_str().unwrap(),
        "--map",
        "0=2,1=3,2=0,3=1",
        "-o",
        out.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(
        run.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
    let source = std::fs::read_to_string(fixture()).unwrap();
    let result = std::fs::read_to_string(&out).unwrap();
    assert_eq!(report["sha256"], hex(&Sha256::digest(result.as_bytes())));
    assert_eq!(report["sourceSha256"], hex(&Sha256::digest(source.as_bytes())));
    assert_eq!(report["toolsUsed"], serde_json::json!([0, 1, 2, 3]));

    let map = [2u8, 3, 0, 1];
    let before: Vec<&str> = source.split_inclusive('\n').collect();
    let after: Vec<&str> = result.split_inclusive('\n').collect();
    assert_eq!(before.len(), after.len());
    let (mut tool, mut preextrude, mut heats, mut selections) = (None, 0, 0, 0);
    for (n, (old, new)) in before.iter().zip(&after).enumerate() {
        // Comments are never touched.
        assert_eq!(
            old.split_once(';').map(|c| c.1),
            new.split_once(';').map(|c| c.1),
            "line {}",
            n + 1
        );
        if let Some(t) = selection(new) {
            assert_eq!(
                Some(t),
                selection(old).map(|t| map[usize::from(t)]),
                "line {}",
                n + 1
            );
            tool = Some(t);
            selections += 1;
        }
        // The partner pattern: a pre-extrude must purge the toolhead just selected.
        if let Some(index) = param(new, "SM_PRINT_PREEXTRUDE_FILAMENT", "INDEX=") {
            assert_eq!(Some(index), tool, "line {}: {new}", n + 1);
            preextrude += 1;
        }
        // A heat wait names the same toolhead as the selection it goes with: the one a tool change selects next, or
        // the one already selected when it comes back from standby.
        if let Some(heat) = param(new, "M109", "T") {
            assert_eq!(
                Some(heat),
                param(old, "M109", "T").map(|t| map[usize::from(t)]),
                "line {}",
                n + 1
            );
            let next = after[n..].iter().find_map(|l| selection(l));
            assert!(Some(heat) == next || Some(heat) == tool, "line {}: {new}", n + 1);
            heats += 1;
        }
    }
    assert!(preextrude >= 3, "{preextrude} pre-extrude lines");
    assert!(
        heats >= 3 && selections >= 4,
        "{heats} heats, {selections} selections"
    );
    assert_eq!(report["counts"]["preextrudeIndexes"], preextrude);
    assert!(report["counts"]["toolChanges"].as_u64().unwrap() >= 4);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_identity_map_leaves_the_file_byte_for_byte() {
    let dir = scratch("identity");
    let out = dir.join("same.gcode");
    let run = sx(&[
        "remap-toolheads",
        fixture().to_str().unwrap(),
        "--map",
        "0=0,1=1,2=2,3=3",
        "-o",
        out.to_str().unwrap(),
    ]);
    assert_eq!(
        run.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let source = std::fs::read(fixture()).unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), source);
    let text = String::from_utf8(run.stdout).unwrap();
    assert!(text.contains("changed 0 lines"), "{text}");
    assert!(text.contains(&hex(&Sha256::digest(&source))), "{text}");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn each_line_refusal_is_a_clean_error_and_writes_nothing() {
    let dir = scratch("refuse");
    let out = dir.join("out.gcode");
    for (text, line, reason) in [
        ("T0\nt1\n", 2, "Use uppercase tool commands before mapping"),
        ("T0\nM104S220T0\n", 2, "Separate indexed temperature commands"),
        (
            "T0\nM104 S220T0\n",
            2,
            "Separate indexed temperature parameters with spaces",
        ),
        (
            "T0\nSM_PRINT_PREEXTRUDE_FILAMENT index=0\n",
            2,
            "Use uppercase tool parameter names",
        ),
        (
            "T0\nCUSTOM T0\n",
            2,
            "Indexed tool parameter in CUSTOM is not supported",
        ),
        (
            "T0\nCUSTOM TOOL=0\n",
            2,
            "Tool reference in CUSTOM is not supported",
        ),
        ("T0\nM104 t0 S220\n", 2, "Use uppercase tool parameter names"),
        ("T0 A2\n", 1, "Use A0 or A1 for tool addressing"),
        ("T0\nM104 T{tool}\n", 2, "Resolve templates"),
        (
            "T0\nSET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=1\n",
            2,
            "Embedded firmware mapping",
        ),
        ("T0\nT5\n", 2, "Tool 5 has no selected loaded toolhead"),
    ] {
        let input = dir.join("in.gcode");
        std::fs::write(&input, text).unwrap();
        let run = sx(&[
            "remap-toolheads",
            input.to_str().unwrap(),
            "--map",
            "0=1,1=0",
            "-o",
            out.to_str().unwrap(),
            "--json",
        ]);
        assert_eq!(run.status.code(), Some(3), "{text}");
        let error: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
        assert_eq!(error["error"], "remap_refused", "{text}");
        assert_eq!(error["line"], line, "{text}");
        assert!(
            error["reason"].as_str().unwrap().starts_with(reason),
            "{text}: {error}"
        );
        let stderr = String::from_utf8_lossy(&run.stderr);
        assert!(
            stderr.contains(&format!("refused: line {line}: {reason}")),
            "{stderr}"
        );
        assert!(!out.exists(), "{text}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_mapped_copy_a_bad_map_and_usage_mistakes_are_refused() {
    let dir = scratch("refuse-file");
    let out = dir.join("out.gcode");
    std::fs::write(dir.join("in.gcode"), "T0\nT5\n").unwrap();
    // A copy that already carries a mapping, and a map past the U1's four toolheads.
    let mapped = dir.join("mapped.gcode");
    std::fs::write(&mapped, "; slicerx_toolhead_map = {}\nT0\n").unwrap();
    for (input, map, reason) in [
        (&mapped, "0=1", "This file is already mapped"),
        (
            &dir.join("in.gcode"),
            "0=4",
            "Map tools 0 to 31 onto toolheads 0 to 3",
        ),
    ] {
        let run = sx(&[
            "remap-toolheads",
            input.to_str().unwrap(),
            "--map",
            map,
            "-o",
            out.to_str().unwrap(),
            "--json",
        ]);
        assert_eq!(run.status.code(), Some(3));
        let error: serde_json::Value = serde_json::from_slice(&run.stdout).unwrap();
        assert_eq!(error["line"], serde_json::Value::Null);
        assert!(error["reason"].as_str().unwrap().starts_with(reason), "{error}");
        assert!(!out.exists());
    }
    // Usage mistakes exit 2 before reading anything.
    let input = dir.join("in.gcode");
    for args in [
        vec![
            "remap-toolheads",
            input.to_str().unwrap(),
            "--map",
            "0:1",
            "-o",
            out.to_str().unwrap(),
        ],
        vec![
            "remap-toolheads",
            input.to_str().unwrap(),
            "-o",
            out.to_str().unwrap(),
        ],
        vec!["remap-toolheads", input.to_str().unwrap(), "--map", "0=1"],
        vec![
            "remap-toolheads",
            input.to_str().unwrap(),
            "--map",
            "0=1",
            "-o",
            input.to_str().unwrap(),
        ],
    ] {
        assert_eq!(sx(&args).status.code(), Some(2), "{args:?}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}
