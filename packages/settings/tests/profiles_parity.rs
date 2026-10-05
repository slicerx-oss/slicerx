// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The profile configs must match `js/profiles.test.ts`: `fixtures/profiles-golden.json` holds FNV-1a hashes
//! of the sorted-key JSON of each config.
use std::collections::BTreeMap;

use sx_settings::{
    PrintConfig, filament_config, filament_sources, knowledge, list_printer_profiles, list_process_presets,
    printer_config, process_config, profile_config,
};

fn fnv(text: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in text.bytes() {
        h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

fn hash(c: Option<PrintConfig>) -> String {
    fnv(&c.map(|c| c.to_json().to_string()).unwrap_or_default())
}

fn table() -> BTreeMap<String, String> {
    let mut t = BTreeMap::new();
    for p in list_printer_profiles() {
        t.insert(format!("printer {}", p.id), hash(printer_config(&p.id, None)));
        t.insert(
            format!("printer {} 0.6", p.id),
            hash(printer_config(&p.id, Some(0.6))),
        );
    }
    for id in knowledge().materials.keys() {
        t.insert(format!("filament {id}"), hash(filament_config(id, None)));
        t.insert(
            format!("filament {id} high_flow"),
            hash(filament_config(id, Some("high_flow"))),
        );
        t.insert(format!("sources {id}"), fnv(&filament_sources(id).join("\u{1}")));
    }
    for n in [0.2, 0.4, 0.6, 0.8] {
        for pr in list_process_presets(n, None) {
            t.insert(
                format!("process {} {n}", pr.id),
                hash(process_config(pr.id, n, None)),
            );
            t.insert(format!("label {} {n}", pr.id), fnv(&pr.label));
        }
    }
    for printer in [
        "bambu-p2s",
        "bambu-h2d",
        "bambu-h2s",
        "bambu-x1-carbon",
        "bambu-a1",
        "prusa-mk4s",
        "prusa-core-one",
        "creality-k1",
        "elegoo-neptune-4",
        "snapmaker-u1",
        "voron-2.4-300",
        "flsun-v400",
        "generic-klipper",
    ] {
        for pr in list_process_presets(0.4, Some(printer)) {
            t.insert(
                format!("process {} 0.4 {printer}", pr.id),
                hash(process_config(pr.id, 0.4, Some(printer))),
            );
            t.insert(format!("label {} 0.4 {printer}", pr.id), fnv(&pr.label));
        }
    }
    for (printer, filament, process) in [
        ("bambu-x1-carbon", "pla", Some("fine")),
        ("prusa-mk4s", "petg", Some("strong")),
        ("voron-2.4-300", "tpu_95a", Some("draft")),
        ("flsun-v400", "abs", None),
    ] {
        t.insert(
            format!("merged {printer} {filament} {}", process.unwrap_or("")),
            hash(profile_config(printer, None, Some(filament), process)),
        );
    }
    t
}

#[test]
fn profile_configs_match_the_typescript_golden_file() {
    let text = include_str!("../fixtures/profiles-golden.json");
    let file: serde_json::Value = serde_json::from_str(text).expect("golden file parses");
    let want: BTreeMap<String, String> = file["hashes"]
        .as_object()
        .expect("hashes")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
        .collect();
    let got = table();
    assert_eq!(got.len(), want.len());
    let bad: Vec<&String> = want
        .iter()
        .filter(|(k, v)| got.get(*k) != Some(*v))
        .map(|(k, _)| k)
        .collect();
    assert!(bad.is_empty(), "differ: {bad:?}");
}
