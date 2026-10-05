// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The filament presets must resolve the same in both languages: `fixtures/filaments-lock.json` holds FNV-1a
//! hashes of each vendor file and of the sorted-key JSON of every variant of each product.
use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value as Json;
use sx_settings::VendorFile;

const VENDORS: [&str; 9] = [
    "BBL",
    "OrcaFilamentLibrary",
    "Prusa",
    "Creality",
    "Elegoo",
    "Qidi",
    "Snapmaker",
    "Sovol",
    "FLSun",
];

fn fnv(bytes: &[u8]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h = (h ^ u32::from(*b)).wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../profiles/filaments")
}

#[test]
fn every_preset_resolves_to_the_locked_values() {
    let lock: Json =
        serde_json::from_str(include_str!("../fixtures/filaments-lock.json")).expect("lock parses");
    let mut families: BTreeMap<String, String> = BTreeMap::new();
    let mut presets = 0;
    for v in VENDORS {
        let text = std::fs::read_to_string(dir().join(format!("{v}.json"))).expect("vendor file");
        assert_eq!(
            fnv(text.as_bytes()),
            lock["files"][v].as_str().unwrap_or(""),
            "{v} file"
        );
        let file = VendorFile::parse(&text).expect("vendor file parses");
        for (fam, e) in &file.families {
            let mut all: BTreeMap<String, Json> = BTreeMap::new();
            for suf in e.variants.keys() {
                all.insert(
                    suf.clone(),
                    Json::Object(file.raw(fam, suf).expect("variant resolves")),
                );
                presets += 1;
            }
            families.insert(
                format!("{v}/{fam}"),
                fnv(serde_json::to_string(&all).expect("json").as_bytes()),
            );
        }
    }
    assert_eq!(presets, 6845);
    let want: BTreeMap<String, String> = lock["families"]
        .as_object()
        .expect("families")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
        .collect();
    let bad: Vec<&String> = want
        .iter()
        .filter(|(k, v)| families.get(*k) != Some(*v))
        .map(|(k, _)| k)
        .collect();
    assert!(
        bad.is_empty() && families.len() == want.len(),
        "differ: {:?}",
        &bad[..bad.len().min(5)]
    );
}

#[test]
fn a_preset_carries_the_maker_id_and_typed_values() {
    let text = std::fs::read_to_string(dir().join("BBL.json")).expect("vendor file");
    let file = VendorFile::parse(&text).expect("parses");
    let p = file.preset("Bambu PLA Basic", Some("BBL X1C")).expect("preset");
    assert_eq!(
        (p.brand.as_str(), p.material.as_str(), p.filament_id.as_str()),
        ("Bambu Lab", "PLA", "GFA00")
    );
    assert_eq!(p.name, "Bambu PLA Basic @BBL X1C");
    assert!(p.config.get("nozzle_temperature").is_some() && !p.compatible_printers.is_empty());
}
