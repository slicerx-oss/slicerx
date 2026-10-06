// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The Rust wire types serialize to the JSON in `packages/contracts/fixtures/printers-*.json`,
//! and the TS side (`@slicerx/fleet-sim` tests) parses the same files. Run with
//! `UPDATE_FIXTURES=1` to rewrite them after an intentional change.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sx_connect::{
    DiscoveredPrinter, FilamentSlot, PrinterConfig, PrinterEvent, PrinterHardware, PrinterState,
    PrinterStatus, RemoteFile, StartOptions, Temp,
};

fn path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../contracts/fixtures")
        .join(name)
}

/// Compares `value` with the fixture, or writes it when `UPDATE_FIXTURES` is set. The file must
/// also deserialize back into `T` and serialize to the same JSON.
fn check<T: Serialize + DeserializeOwned>(name: &str, value: &T) {
    let json = serde_json::to_value(value).unwrap();
    let p = path(name);
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&p, serde_json::to_string_pretty(&json).unwrap() + "\n").unwrap();
    }
    let on_disk: Value = serde_json::from_str(
        &std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("{name} missing; run with UPDATE_FIXTURES=1")),
    )
    .unwrap();
    assert_eq!(on_disk, json, "{name} is out of date; run with UPDATE_FIXTURES=1");
    let back: T = serde_json::from_value(on_disk).unwrap();
    assert_eq!(serde_json::to_value(&back).unwrap(), json);
}

fn status() -> PrinterStatus {
    PrinterStatus {
        printer_id: "bay-1".into(),
        state: PrinterState::Printing,
        job_name: Some("Tidewell harbor lantern.gcode.3mf".into()),
        progress: Some(0.62),
        layer: Some(148),
        layer_count: Some(238),
        time_left_s: Some(5040),
        nozzles: vec![Temp {
            current: 249.6,
            target: 250.0,
        }],
        bed: Some(Temp {
            current: 79.8,
            target: 80.0,
        }),
        chamber: Some(Temp {
            current: 38.0,
            target: 0.0,
        }),
        slots: vec![
            FilamentSlot {
                id: "A1".into(),
                material: Some("PLA".into()),
                color: Some("#f2f2f2".into()),
                remaining_pct: Some(82.0),
                spoolman_id: Some(1),
                spool_uid: None,
            },
            FilamentSlot {
                id: "A4".into(),
                ..FilamentSlot::default()
            },
        ],
        camera_available: true,
        message: None,
        updated_at: "2026-09-30T08:00:00.000Z".into(),
        live: None,
    }
}

#[test]
fn status_fixture() {
    check("printers-status.json", &status());
}

/// A running H2D as the Bambu driver reads it (fixtures/bambu-h2d-printing.json): two nozzles, an
/// AMS and an AMS HT, fans, speed, light and a current HMS issue. The app's device view tests read it.
#[test]
fn h2d_status_fixture() {
    let report: Value = serde_json::from_str(include_str!("../fixtures/bambu-h2d-printing.json")).unwrap();
    let mut st = sx_connect::drivers::bambu::status_from_report("h2d", &report);
    st.updated_at = "2026-10-05T07:34:00.000Z".into();
    check("printers-status-h2d.json", &st);
}

#[test]
fn events_fixture() {
    let events = vec![
        PrinterEvent::Status { status: status() },
        PrinterEvent::JobFinished {
            printer_id: "bay-4".into(),
            job_name: "Ferro Labs duct adapter.gcode".into(),
            ok: true,
        },
        PrinterEvent::Error {
            printer_id: "bay-5".into(),
            code: "unreachable".into(),
            message: "printer bay-5 is unreachable: connection refused".into(),
        },
    ];
    check("printers-events.json", &events);
}

#[test]
fn config_fixture() {
    #[derive(Serialize, serde::Deserialize)]
    struct Bundle {
        config: PrinterConfig,
        discovered: DiscoveredPrinter,
        remote: RemoteFile,
        start: StartOptions,
    }
    let b = Bundle {
        config: PrinterConfig {
            id: "bay-2".into(),
            name: "Bay 2".into(),
            plugin: "bambu-lan".into(),
            host: "192.0.2.12".into(),
            port: None,
            credential_ref: Some("printer/bay-2/access-code".into()),
            serial: Some("01P00A000000000".into()),
            tls: None,
            poll_ms: None,
            ftp_port: None,
            camera_port: None,
            ws_port: None,
            http_port: None,
            protocol: None,
            username: None,
            camera_url: None,
            camera_credential_ref: None,
            rtsp_port: None,
        },
        discovered: DiscoveredPrinter {
            plugin: "bambu-lan".into(),
            host: "192.0.2.12".into(),
            port: Some(8883),
            name: Some("Bay 2".into()),
            model: Some("P1S".into()),
            serial: Some("01P00A000000000".into()),
            firmware: None,
            lan_only: None,
            ..DiscoveredPrinter::default()
        },
        remote: RemoteFile {
            printer_id: "bay-2".into(),
            path: "lantern.gcode.3mf".into(),
            name: "lantern.gcode.3mf".into(),
            sha256: None,
        },
        start: StartOptions {
            plate: Some(1),
            bed_leveling: Some(true),
            flow_calibration: Some(false),
            vibration_compensation: Some(false),
            timelapse: Some(true),
            first_layer_inspection: Some(true),
            slot_map: Some([(0, "A1".to_owned()), (2, "A3".to_owned())].into_iter().collect()),
        },
    };
    check("printers-config.json", &b);
}

/// What sx-link's `printers.test` returns as `hardware` for the H2D report in
/// `packages/connect/fixtures/bambu-h2d-pushall.json`. The app's setup tests read the same file.
#[test]
fn hardware_fixture() {
    let report: Value = serde_json::from_str(include_str!("../fixtures/bambu-h2d-pushall.json")).unwrap();
    let mut hw: PrinterHardware = sx_connect::drivers::bambu::hardware_from_report(&report);
    hw.model = Some("H2D".to_owned());
    hw.firmware = Some("01.03.00.00".to_owned());
    check("printers-hardware.json", &hw);
}
