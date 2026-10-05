// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Real OrcaSlicer 2.4.2 and Bambu Studio 2.8.2 preset bundles (fixtures/preset-files, written from the apps' default
// profiles in their export format by scripts/make-preset-bundles.py), the import report against the golden file
// js/report.parity.test.ts writes, and the limits on untrusted bundles.
mod common;

use std::collections::BTreeMap;
use std::io::Read;

use common::{json_eq, read_json, root};
use serde_json::{Value as Json, json};
use sx_settings::{
    BundleType, DropReason, Dropped, ImportLayer, KeyFamily, ParentRef, ReportInput, Section, Value,
    build_report, count_defaulted, import_layers, import_values, read_preset_bundle,
};

fn unzip(name: &str) -> BTreeMap<String, Vec<u8>> {
    let bytes = std::fs::read(root().join("fixtures/preset-files").join(name)).unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let mut body = Vec::new();
        f.read_to_end(&mut body).unwrap();
        out.insert(f.name().to_owned(), body);
    }
    out
}

fn raw(j: &Json) -> BTreeMap<String, Json> {
    j.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

#[test]
fn reads_the_orca_printer_bundle() {
    let b = read_preset_bundle(&unzip("orca-2.4.2-printer.orca_printer")).unwrap();
    assert_eq!(b.kind, BundleType::Printer);
    assert_eq!(b.printer.as_deref(), Some("My A1 0.4 nozzle"));
    let kinds: Vec<(Section, &str)> = b
        .files
        .iter()
        .map(|f| (f.kind, f.json["name"].as_str().unwrap()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (Section::Printer, "My A1 0.4 nozzle"),
            (Section::Filament, "My PLA Basic @BBL A1"),
            (Section::Process, "My 0.20mm Standard @BBL A1"),
        ]
    );
    // Everything an Orca preset holds is a setting SlicerX has.
    for f in &b.files {
        assert!(import_values(&raw(&f.json)).1.is_empty(), "{}", f.path);
    }
}

#[test]
fn reads_the_bambu_bundles_and_finds_what_did_not_carry_over() {
    let b = read_preset_bundle(&unzip("bambu-studio-2.8.2-printer.bbscfg")).unwrap();
    assert_eq!(b.printer.as_deref(), Some("My A1 mini 0.4 nozzle"));
    assert_eq!(b.files.len(), 5);
    let process = b.files.iter().find(|f| f.kind == Section::Process).unwrap();
    let (config, dropped) = import_values(&raw(&process.json));
    let keys: Vec<(&str, DropReason, bool)> = dropped
        .iter()
        .map(|d| (d.key.as_str(), d.reason, d.nearest_value))
        .collect();
    assert_eq!(
        keys,
        vec![
            ("enable_height_slowdown", DropReason::Unsupported, false),
            ("sparse_infill_pattern", DropReason::Invalid, true),
            ("top_one_wall_type", DropReason::Unsupported, false),
        ]
    );
    assert_eq!(
        config.get("sparse_infill_pattern").map(Value::to_json),
        Some(json!("lateral-lattice"))
    );

    let f = read_preset_bundle(&unzip("bambu-studio-2.8.2-filament.bbsflmt")).unwrap();
    assert_eq!(f.kind, BundleType::Filament);
    let paths: Vec<&str> = f.files.iter().map(|x| x.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "Matte Works/Matte Works PLA @My A1 mini 0.4 nozzle.json",
            "Matte Works/Matte Works PLA Tuned.json"
        ]
    );

    let o = read_preset_bundle(&unzip("orca-2.4.2-filament.orca_filament")).unwrap();
    assert_eq!(o.files.len(), 1);
    assert_eq!(o.files[0].kind, Section::Filament);
}

#[test]
fn a_tuned_filament_takes_the_rest_from_its_base_in_the_bundle() {
    let b = read_preset_bundle(&unzip("bambu-studio-2.8.2-printer.bbscfg")).unwrap();
    let by_name = |n: &str| b.files.iter().find(|f| f.json["name"] == n).unwrap();
    let layers = [
        ImportLayer {
            name: "Matte Works PLA Tuned".into(),
            raw: Some(raw(&by_name("Matte Works PLA Tuned").json)),
            config: None,
        },
        ImportLayer {
            name: "Matte Works PLA @My A1 mini 0.4 nozzle".into(),
            raw: Some(raw(&by_name("Matte Works PLA @My A1 mini 0.4 nozzle").json)),
            config: None,
        },
    ];
    let out = import_layers(&layers);
    assert_eq!(
        out.config.get("filament_flow_ratio").map(Value::to_json),
        Some(json!([0.95]))
    );
    assert_eq!(
        out.config.get("filament_vendor").map(Value::to_json),
        Some(json!(["Matte Works"]))
    );
    assert_eq!(
        out.origin.get("filament_vendor").map(String::as_str),
        Some("Matte Works PLA @My A1 mini 0.4 nozzle")
    );
    assert!(!out.origin.contains_key("filament_flow_ratio"));
}

fn entries(files: &[(&str, &[u8])]) -> BTreeMap<String, Vec<u8>> {
    files.iter().map(|(k, v)| ((*k).to_owned(), v.to_vec())).collect()
}

#[test]
fn untrusted_bundles_are_held_to_their_limits() {
    let manifest = json!({"bundle_type": "printer config bundle", "printer_preset_name": "P", "printer_config": ["../evil.json", "C:/x.json", "printer/missing.json", "printer/big.json", "printer/P.json"], "filament_config": [], "process_config": []}).to_string();
    let big = vec![b' '; 2 * 1024 * 1024 + 1];
    let b = read_preset_bundle(&entries(&[
        ("bundle_structure.json", manifest.as_bytes()),
        ("printer/big.json", &big),
        ("printer/P.json", br#"{"name":"P","printer_settings_id":"P"}"#),
    ]))
    .unwrap();
    assert_eq!(b.files.len(), 1);
    let why: Vec<&str> = b.skipped.iter().map(|s| s.why.as_str()).collect();
    assert_eq!(
        why,
        vec![
            "The path is not safe.",
            "The path is not safe.",
            "The bundle names this file but does not have it.",
            "The file is too large to be a preset.",
        ]
    );
    assert!(read_preset_bundle(&entries(&[("readme.txt", b"hi")])).is_err());
    assert!(
        read_preset_bundle(&entries(&[("bundle_structure.json", b"{nope")]))
            .unwrap_err()
            .to_string()
            .contains("damaged")
    );
    let many: Vec<(String, String)> = (0..501)
        .map(|i| {
            (
                format!("process/p{i}.json"),
                format!(r#"{{"name":"p{i}","print_settings_id":"p{i}"}}"#),
            )
        })
        .collect();
    let many: BTreeMap<String, Vec<u8>> = many.into_iter().map(|(k, v)| (k, v.into_bytes())).collect();
    assert!(
        read_preset_bundle(&many)
            .unwrap_err()
            .to_string()
            .contains("too many")
    );
}

fn run(c: &Json) -> Json {
    let layers: Vec<ImportLayer> = c["layers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| ImportLayer {
            name: l["name"].as_str().unwrap().to_owned(),
            raw: Some(raw(&l["raw"])),
            config: None,
        })
        .collect();
    let out = import_layers(&layers);
    let section: Section = serde_json::from_value(c["section"].clone()).unwrap();
    let family: KeyFamily = serde_json::from_value(c["family"].clone()).unwrap();
    let printer = c.get("printer").map(|p| {
        (
            p["name"].as_str().unwrap().to_owned(),
            import_values(&raw(&p["raw"])).0,
        )
    });
    let mut dropped = out.dropped.clone();
    if let Some(extra) = c.get("extraDropped") {
        dropped.extend(serde_json::from_value::<Vec<Dropped>>(extra.clone()).unwrap());
    }
    let parent: Option<ParentRef> = c
        .get("parent")
        .map(|p| serde_json::from_value(p.clone()).unwrap());
    let defaulted = match &c["defaulted"] {
        Json::String(_) => count_defaulted(section, &out.config),
        n => usize::try_from(n.as_u64().unwrap()).unwrap(),
    };
    let report = build_report(&ReportInput {
        name: layers[0].name.as_str(),
        section,
        family,
        dropped: &dropped,
        config: &out.config,
        origin: &out.origin,
        printer: printer.as_ref().map(|(n, cfg)| (n.as_str(), cfg)),
        parent,
        defaulted,
    });
    json!({"config": out.config.to_json(), "origin": out.origin, "report": serde_json::to_value(&report).unwrap()})
}

#[test]
fn reports_match_the_golden_file() {
    let cases = read_json("fixtures/report-cases.json");
    let golden = read_json("fixtures/report-golden.json");
    let results = golden["results"].as_object().unwrap();
    let cases = cases["cases"].as_array().unwrap();
    assert_eq!(results.len(), cases.len());
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let got = run(c);
        assert!(
            json_eq(&got, &results[name]),
            "{name}\n got: {got}\nwant: {}",
            results[name]
        );
    }
}
