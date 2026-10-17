// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use std::io::Write;
use std::process::{Command, Stdio};

fn run(text: &str) -> (Option<i32>, serde_json::Value) {
    run_args(&["canonical-script", "-"], text)
}

fn run_args(args: &[&str], text: &str) -> (Option<i32>, serde_json::Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sx"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.code(), serde_json::from_slice(&out.stdout).unwrap())
}

#[test]
fn native_client_reads_cosmetic_equivalence_without_granting_trust() {
    let (code, original) = run("G28\nM500");
    let (changed_code, cosmetic) = run("  G28 ; home\r\n\tM500 ; save\r\n");
    assert_eq!(code, Some(0));
    assert_eq!(changed_code, Some(0));
    assert_eq!(original["fingerprint"], cosmetic["fingerprint"]);
    assert_eq!(cosmetic["version"], 1);
    assert_eq!(cosmetic["text"], "G28\nM500");
    assert!(cosmetic.get("trusted").is_none());
    assert!(
        cosmetic["ignored"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "comments")
    );
}

#[test]
fn native_client_gets_a_structured_review_reason() {
    for source in ["{if enabled}\nM500", "; {\"a\r\nb\"}"] {
        let (code, result) = run(source);
        assert_eq!(code, Some(3));
        assert_eq!(result["error"], "script_review_required");
        assert!(!result["reason"].as_str().unwrap().is_empty());
        assert!(result.get("fingerprint").is_none());
    }
}

#[test]
fn executable_template_comments_survive_cosmetic_normalization() {
    let (code, result) = run("; {local n = 2}\n  G1 X{n} ; move");
    assert_eq!(code, Some(0));
    assert_eq!(result["text"], "; {local n = 2}\nG1 X{n}");
    let (_, changed) = run("; {local n = 3}\nG1 X{n}");
    assert_ne!(result["fingerprint"], changed["fingerprint"]);
}

#[test]
fn batches_keep_individual_results_and_require_a_selected_printer() {
    let (code, parsed) = run_args(&["canonical-script", "-", "--batch"], r#"["M500", "{if x}"]"#);
    assert_eq!(code, Some(0));
    assert_eq!(parsed[0]["text"], "M500");
    assert_eq!(parsed[1]["error"], "script_review_required");
    let (code, reviewed) = run_args(
        &["review-script", "-", "--batch"],
        r#"[{"selected":null,"key":"machine_start_gcode","text":"M500"}]"#,
    );
    assert_eq!(code, Some(0));
    assert_eq!(reviewed[0]["decision"], "review");
    assert_eq!(reviewed[0]["reason"], "printer_identity_required");
}

#[test]
fn compiled_stock_catalog_accepts_cosmetics_but_not_added_commands() {
    for (text, decision) in [
        ("  M400 U1 ; pause\r\n", "cosmetic"),
        ("M400 U1\nM500", "review"),
        ("M400 U2", "review"),
    ] {
        let input = serde_json::json!({
            "selected": {"model": "bambu-p1s", "firmware": "marlin"},
            "declared": [{"model": "bambu-p1s", "firmware": "marlin"}],
            "key": "machine_pause_gcode", "text": text,
        });
        let (code, result) = run_args(&["review-script", "-"], &input.to_string());
        assert_eq!(code, Some(0));
        assert_eq!(result["decision"], decision);
        if decision == "cosmetic" {
            assert_eq!(result["reason"], "stock_equivalent");
            assert!(result["stockVersion"].is_string());
            assert_eq!(result["fingerprint"].as_str().unwrap().len(), 64);
        } else {
            assert_eq!(result["reason"], "script_changed");
        }
    }
}

#[test]
fn slicing_uses_the_same_review_and_checks_the_effective_firmware() {
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut request: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixtures.join("cube-request.json")).unwrap()).unwrap();
    request["meshes"]["cube"] = serde_json::json!(fixtures.join("cube.stl"));
    request["options"] = serde_json::json!({"emitGcode": false, "emitPreview": false, "shards": 1});
    request["config"]["printer_model"] = serde_json::json!("Bambu Lab P1S");
    request["config"]["gcode_flavor"] = serde_json::json!("marlin");
    request["config"]["machine_pause_gcode"] = serde_json::json!("  M400 U1 ; pause\r\n");
    request["config"]["emit_machine_limits_to_gcode"] = serde_json::json!("1");
    for (model, flavor, expected) in [
        ("Bambu Lab P1S", "marlin", "stock_equivalent"),
        ("bambu-p1s", "marlin", "stock_equivalent"),
        ("Bambu Lab P1S", "klipper", "printer_identity_conflict"),
    ] {
        request["config"]["printer_model"] = serde_json::json!(model);
        request["options"]["flavor"] = serde_json::json!(flavor);
        let mut child = Command::new(env!("CARGO_BIN_EXE_sx"))
            .args([
                "slice",
                "--request",
                "-",
                "--script-printer",
                "bambu-p1s",
                "--script-firmware",
                "marlin",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();
        let line = stderr
            .lines()
            .find_map(|line| line.strip_prefix("sx: script_reviews: "))
            .expect(&stderr);
        let reviews: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(reviews.as_array().unwrap().len(), 1);
        assert_eq!(reviews[0]["reason"], expected);
        if flavor == "marlin" {
            assert!(out.status.success(), "{stderr}");
            let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(report["script_reviews"], reviews);
            assert_eq!(reviews[0]["decision"], "cosmetic");
        }
    }
}
