// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Long decimals in a request parse to the correctly rounded number in every build of the engine. The requests in
//! `fixtures/exact-parse-requests.json.gz` are the calls of a 7-step bracket (holes, bosses with rounded corners and
//! a push of the far end every fifth step) on base widths 60, 70.125, 72.5, 80 and 82.75 mm, as the app sends them.
//! Without `serde_json`'s `float_roundtrip` a number such as a stored corner radius of 0.9999999999977263 can parse one
//! unit in the last place off, and only in builds that do not get the feature from another crate, so the desktop and
//! the browser answered the same request differently. Each reply is held to the digests in
//! `fixtures/exact-parse.json`; packages/app/test/geom-exact-parse.test.ts holds the wasm build to the same record.
//! `SX_EXACT_PARSE_RECORD=1 cargo test -p sx-geom --test exact_parse` writes the record again.

#![cfg(all(feature = "cad", feature = "formats"))]

use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// the recorded calls: `case`, `op` and the request's raw `text`, as the app sent it
fn requests() -> Vec<Value> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(fixture("exact-parse-requests.json.gz")).unwrap())
        .read_to_string(&mut text)
        .unwrap();
    serde_json::from_str::<Vec<Value>>(&text).unwrap()
}

/// every number literal of a JSON text, in text order
fn literals(text: &str) -> Vec<&str> {
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
                out.push(&text[s..i]);
            }
            _ => i += 1,
        }
    }
    out
}

/// FNV-1a over every number of a reply as little-endian f64 bits, in text order, each read with the correctly rounded
/// parse (the way the app's JSON.parse reads it)
fn digest(reply: &str) -> (u64, String) {
    let all = literals(reply);
    let h = all
        .iter()
        .flat_map(|s| s.parse::<f64>().unwrap().to_le_bytes())
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        });
    (all.len() as u64, format!("{h:016x}"))
}

#[test]
fn every_number_in_the_requests_parses_correctly_rounded() {
    let mut long = 0;
    for r in requests() {
        let text = r["text"].as_str().unwrap();
        for s in literals(text) {
            let exact: f64 = s.parse().unwrap();
            let got: f64 = serde_json::from_str(s).unwrap();
            assert_eq!(
                got.to_bits(),
                exact.to_bits(),
                "{}: {s} parsed as {got:e}",
                r["case"]
            );
            long += usize::from(s.bytes().filter(u8::is_ascii_digit).count() > 15);
        }
    }
    // the requests carry full-precision numbers from earlier replies, the ones a plain parse can round wrong
    assert!(long > 1000, "{long} long decimals");
}

#[test]
fn the_saved_corner_radius_keeps_its_bits() {
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("exact-parse.json")).unwrap()).unwrap();
    let saved = &record["saved"];
    let r = requests()
        .into_iter()
        .find(|r| r["case"] == saved["case"])
        .unwrap();
    let text = r["text"].as_str().unwrap();
    let literal = saved["text"].as_str().unwrap();
    assert!(text.contains(literal), "{literal} is not in {}", saved["case"]);
    let bits = u64::from_str_radix(saved["bits"].as_str().unwrap(), 16).unwrap();
    assert_eq!(serde_json::from_str::<f64>(literal).unwrap().to_bits(), bits);
    // the engine carries the cylinder's radius from the request to the reply unchanged
    let reply: Value =
        serde_json::from_str(&sx_geom::json::call(r["op"].as_str().unwrap(), text).unwrap()).unwrap();
    let radius = reply
        .pointer(saved["reply"].as_str().unwrap())
        .unwrap()
        .as_f64()
        .unwrap();
    assert_eq!(radius.to_bits(), bits, "{radius:e}");
}

#[test]
fn the_replies_match_the_record() {
    let path = fixture("exact-parse.json");
    let mut record: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let write = std::env::var_os("SX_EXACT_PARSE_RECORD").is_some();
    let mut seen = Vec::new();
    for r in requests() {
        let case = r["case"].as_str().unwrap().to_owned();
        let op = r["op"].as_str().unwrap();
        let reply =
            sx_geom::json::call(op, r["text"].as_str().unwrap()).unwrap_or_else(|e| panic!("{case}: {e}"));
        let (numbers, digest) = digest(&reply);
        if write {
            record["replies"][&case] = serde_json::json!({ "numbers": numbers, "digest": digest });
        } else {
            let want = &record["replies"][&case];
            assert_eq!(
                (numbers, digest.as_str()),
                (
                    want["numbers"].as_u64().unwrap_or_default(),
                    want["digest"].as_str().unwrap_or_default()
                ),
                "{case}"
            );
        }
        seen.push(case);
    }
    if write {
        std::fs::write(&path, serde_json::to_string_pretty(&record).unwrap() + "\n").unwrap();
    } else {
        assert_eq!(
            seen.len(),
            record["replies"].as_object().unwrap().len(),
            "the record holds other cases"
        );
    }
}
