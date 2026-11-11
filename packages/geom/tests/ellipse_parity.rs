// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ellipse requests held to the digests in `fixtures/ellipse-parity.json`: every number of each reply, as f64 bits,
//! in the order the reply's text has them. packages/app/test/ellipse-parity.test.ts holds the wasm build to the same record, so the two
//! engines agree number for number. `SX_ELLIPSE_RECORD=1 cargo test -p sx-geom --test ellipse_parity` writes it again.
use serde_json::Value;
use std::path::Path;

/// every number of the reply in text order, read with the correctly rounded parse, the way the app's JSON.parse reads it
fn numbers(text: &str) -> Vec<f64> {
    let (b, mut out, mut i) = (text.as_bytes(), Vec::new(), 0);
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let s = i;
                while i < b.len() && matches!(b[i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    i += 1;
                }
                out.push(text[s..i].parse().unwrap());
            }
            _ => i += 1,
        }
    }
    out
}

#[test]
fn ellipse_replies_match_the_record() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ellipse-parity.json");
    let mut record: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let write = std::env::var_os("SX_ELLIPSE_RECORD").is_some();
    for case in record["cases"].as_array_mut().unwrap() {
        let op = case["op"].as_str().unwrap().to_owned();
        let reply =
            sx_geom::json::call(&op, &case["request"].to_string()).unwrap_or_else(|e| panic!("{op}: {e}"));
        let all = numbers(&reply);
        let n = all.len() as u64;
        let h = all
            .iter()
            .flat_map(|x| x.to_le_bytes())
            .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
            });
        let digest = format!("{h:016x}");
        if write {
            case["numbers"] = n.into();
            case["digest"] = digest.into();
        } else {
            assert_eq!(
                (n, digest.as_str()),
                (
                    case["numbers"].as_u64().unwrap(),
                    case["digest"].as_str().unwrap()
                ),
                "{op}"
            );
        }
    }
    if write {
        std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap() + "\n").unwrap();
    }
}
