// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Setup asks for as little as the printer allows: found, identified and filled in from what it
//! reports, against the protocol fakes in `@slicerx/mock-printers`.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;

use std::sync::Arc;

use common::{Mocks, config, expect_code, job_file, secrets};
use std::time::Duration;

use sx_connect::drivers::{BambuConnector, CrealityConnector, MoonrakerConnector, SnapmakerConnector};
use sx_connect::{
    Action, ErrorCode, JobKind, MemoryGate, PrinterConnector, PrinterSession, PrinterState, StartOptions,
    params,
};

/// A session to the Bambu fake after `/bambu` made it `printer`.
async fn bambu(printer: serde_json::Value) -> (Mocks, Arc<MemoryGate>, Box<dyn PrinterSession>) {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    mocks.control("/bambu", printer).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    cfg.ftp_port = Some(mocks.port("bambu-ftp"));
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let s = BambuConnector::new(gate.clone())
        .connect(&cfg, &sec)
        .await
        .unwrap();
    (mocks, gate, s)
}

// A printer added by address alone, with SSDP blocked: the serial number comes from the MQTT
// certificate, so the access code is all setup asks for.
#[tokio::test]
async fn bambu_connects_without_a_serial_number() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = None;
    cfg.credential_ref = Some("bambu-code".to_owned());
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let s = BambuConnector::new(gate).connect(&cfg, &sec).await.unwrap();
    assert_eq!(s.status().await.unwrap().state, PrinterState::Idle);
}

// An X1 whose `get_version` cannot tell it from an X1 Carbon names itself in `printer_type`, and a
// project goes to it from the SD card, as ha-bambulab sends it to the older models.
#[tokio::test]
async fn bambu_names_the_model_from_printer_type_and_starts_from_the_sd_card() {
    let (mocks, gate, s) =
        bambu(serde_json::json!({ "model": "BL-P001", "printerType": "3DPrinter-X1" })).await;
    assert_eq!(s.reported_model().as_deref(), Some("X1"));
    let file = job_file("cube.gcode.3mf", JobKind::Gcode3mf);
    let t = gate.mint(
        Action::Upload,
        "bay-1",
        &params::upload("bay-1", &file.name, &file.sha256),
    );
    let rf = s.upload(file, &t).await.unwrap();
    let opts = StartOptions::default();
    let t = gate.mint(Action::Start, "bay-1", &params::start("bay-1", &rf, &opts));
    s.start(&rf, opts, &t).await.unwrap();
    let log = mocks.wait_log("project_file {").await;
    let line = log.iter().find(|l| l.starts_with("project_file {")).unwrap();
    assert!(
        line.contains("\"url\":\"file:///sdcard/cube.gcode.3mf\""),
        "{line}"
    );
}

// No SD card: the upload is refused with the reason before any file is sent, unless the printer
// says it prints from internal storage.
#[tokio::test]
async fn bambu_without_an_sd_card_says_so_before_uploading() {
    let (mocks, gate, s) = bambu(serde_json::json!({ "model": "N1", "storage": "none" })).await;
    assert_eq!(s.hardware().await.unwrap().unwrap().sd_card, Some(false));
    let file = job_file("cube.gcode", JobKind::Gcode);
    let t = gate.mint(
        Action::Upload,
        "bay-1",
        &params::upload("bay-1", &file.name, &file.sha256),
    );
    let r = s.upload(file.clone(), &t).await;
    assert!(format!("{:?}", r.as_ref().err()).contains("SD card"), "{r:?}");
    expect_code(r, ErrorCode::Refused);
    assert!(
        mocks.state().await["bambu"]["files"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let (_mocks, gate, s) =
        bambu(serde_json::json!({ "model": "N1", "storage": "none", "emmc": true })).await;
    let t = gate.mint(
        Action::Upload,
        "bay-1",
        &params::upload("bay-1", &file.name, &file.sha256),
    );
    s.upload(file, &t).await.unwrap();
}

/// A Moonraker session to the fake, after `/moonraker` made it `variant` (a QIDI printer, a U1).
async fn moonraker(extra: &[&str], control: serde_json::Value) -> (Mocks, Box<dyn PrinterSession>) {
    let mocks = Mocks::start("moonraker", extra).await;
    mocks.control("/moonraker", control).await;
    let cfg = config("bay-4", "moonraker", mocks.port("moonraker"));
    let s = MoonrakerConnector::new(Arc::new(MemoryGate::new()))
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    (mocks, s)
}

async fn machine_log(mocks: &Mocks) -> Vec<String> {
    mocks.state().await["moonraker"]["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect()
}

// Setup fills the bed, kinematics and limits from Klipper itself, so nothing is typed.
#[tokio::test]
async fn moonraker_reports_the_bed_and_kinematics() {
    let (_mocks, s) = moonraker(&[], serde_json::json!({})).await;
    let hw = s.hardware().await.unwrap().unwrap();
    assert_eq!(hw.build_volume_mm, Some([220.0, 220.0, 250.0]));
    assert_eq!(hw.kinematics.as_deref(), Some("corexy"));
    assert_eq!(hw.max_velocity_mm_s, Some(500.0));
    assert_eq!(hw.hostname.as_deref(), Some("mock"));
}

// A QIDI Box's spools come from `save_variables`, the runout buttons and the printer's filament
// dictionary; the model is the `machine_name` QIDI's Moonraker reports.
#[tokio::test]
async fn a_qidi_box_reads_as_slots() {
    let (_mocks, s) = moonraker(&[], serde_json::json!({ "variant": "qidi" })).await;
    let st = s.status().await.unwrap();
    let slots: Vec<(&str, Option<&str>, Option<&str>)> = st
        .slots
        .iter()
        .map(|x| (x.id.as_str(), x.material.as_deref(), x.color.as_deref()))
        .collect();
    assert_eq!(
        slots,
        [
            ("A1", Some("PLA Rapido"), Some("#0000ff")),
            ("A2", Some("PETG Tough"), Some("#ffffff")),
            ("A3", None, None),
            ("A4", None, None),
        ]
    );
    let hw = s.hardware().await.unwrap().unwrap();
    assert_eq!(hw.model.as_deref(), Some("X-Max 4"));
    assert_eq!(hw.filament_units[0].kind, "qidi-box");
}

// A Snapmaker U1 names itself through `print_task_config`, and each toolhead's spool is a slot.
#[tokio::test]
async fn a_snapmaker_u1_reads_its_toolheads() {
    let (_mocks, s) = moonraker(&[], serde_json::json!({ "variant": "u1" })).await;
    assert_eq!(s.reported_model().as_deref(), Some("U1"));
    let st = s.status().await.unwrap();
    let mats: Vec<Option<&str>> = st.slots.iter().map(|x| x.material.as_deref()).collect();
    assert_eq!(
        mats,
        [Some("PLA HIGH SPEED"), Some("PETG"), None, Some("PLA MATTE")]
    );
    assert_eq!(st.slots[0].color.as_deref(), Some("#ff0000"));
}

// Klipper down while Moonraker answers: an error with Klipper's own words, not a lost connection.
#[tokio::test]
async fn a_klipper_shutdown_says_why() {
    let (mocks, s) = moonraker(&[], serde_json::json!({})).await;
    mocks
        .control(
            "/moonraker",
            serde_json::json!({ "klippy": "shutdown", "message": "Lost communication with MCU 'mcu'" }),
        )
        .await;
    let st = s.status().await.unwrap();
    assert_eq!(st.state, PrinterState::Error);
    assert_eq!(
        st.message.as_deref(),
        Some("Klipper shutdown: Lost communication with MCU 'mcu'")
    );
    mocks
        .control(
            "/moonraker",
            serde_json::json!({ "klippy": "startup", "message": "" }),
        )
        .await;
    let st = s.status().await.unwrap();
    assert_eq!(st.message.as_deref(), Some("Klipper is starting"));
}

// Uploads carry their SHA-256, which Moonraker checks; the webcam list is read once per session and
// a disabled webcam is skipped.
#[tokio::test]
async fn moonraker_uploads_with_a_checksum_and_reads_webcams_once() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("moonraker", &["--camera"]).await;
    let cfg = config("bay-4", "moonraker", mocks.port("moonraker"));
    let s = MoonrakerConnector::new(gate.clone())
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    let file = job_file("cube.gcode", JobKind::Gcode);
    let t = gate.mint(
        Action::Upload,
        "bay-4",
        &params::upload("bay-4", &file.name, &file.sha256),
    );
    s.upload(file, &t).await.unwrap();
    assert!(s.snapshot().await.unwrap().is_some());
    assert!(s.snapshot().await.unwrap().is_some());
    let log = machine_log(&mocks).await;
    assert!(
        log.contains(&"moonraker upload checksum sent".to_owned()),
        "{log:?}"
    );
    assert_eq!(log.iter().filter(|l| *l == "webcams list").count(), 1, "{log:?}");
}

// Logins forced: a user name and password sign in, and an expired access token is renewed with the
// refresh token without the person seeing it.
#[tokio::test]
async fn moonraker_signs_in_with_a_user_login_and_renews_it() {
    let mocks = Mocks::start("moonraker", &["--force-logins"]).await;
    let mut cfg = config("bay-4", "moonraker", mocks.port("moonraker"));
    cfg.username = Some(mocks.info["moonrakerLogin"]["user"].as_str().unwrap().to_owned());
    cfg.credential_ref = Some("pw".to_owned());
    let pw = mocks.info["moonrakerLogin"]["password"]
        .as_str()
        .unwrap()
        .to_owned();
    let conn = MoonrakerConnector::new(Arc::new(MemoryGate::new()));
    let s = conn.connect(&cfg, &secrets(&[("pw", pw)])).await.unwrap();
    assert_eq!(s.status().await.unwrap().state, PrinterState::Idle);
    mocks
        .control("/moonraker", serde_json::json!({ "expireTokens": true }))
        .await;
    assert_eq!(s.status().await.unwrap().state, PrinterState::Idle);
    assert!(machine_log(&mocks).await.contains(&"refresh_jwt".to_owned()));
    let wrong = conn
        .connect(&cfg, &secrets(&[("pw", "nope".to_owned())]))
        .await
        .err()
        .unwrap();
    assert_eq!(wrong.login_need(), Some(sx_connect::LoginNeed::KeyWrong));
}

// "Enter IP instead": Moonraker answers on the address, and a U1 is left to the Snapmaker connector.
#[tokio::test]
async fn moonraker_probe_confirms_a_typed_address() {
    let (mocks, _s) = moonraker(&[], serde_json::json!({})).await;
    let conn =
        MoonrakerConnector::new(Arc::new(MemoryGate::new())).with_probe_ports(vec![mocks.port("moonraker")]);
    let wait = Duration::from_millis(800);
    let p = conn.probe("127.0.0.1", wait).await.unwrap();
    assert_eq!(p.plugin, "moonraker");
    assert_eq!(p.name.as_deref(), Some("mock"));
    assert_eq!(p.firmware.as_deref(), Some("Moonraker mock"));
    mocks
        .control("/moonraker", serde_json::json!({ "variant": "u1" }))
        .await;
    assert!(conn.probe("127.0.0.1", wait).await.is_none());
}

// A U1 typed in by address: found on whichever of 80 and 7125 answers, named by its own Klipper
// object, and connected through Moonraker with no port given.
#[tokio::test]
async fn a_snapmaker_u1_is_found_and_connected_by_address() {
    let (mocks, _s) = moonraker(&[], serde_json::json!({ "variant": "u1" })).await;
    let port = mocks.port("moonraker");
    let conn = SnapmakerConnector::new(Arc::new(MemoryGate::new())).with_u1_ports(vec![1, port]);
    let p = conn.probe("127.0.0.1", Duration::from_millis(800)).await.unwrap();
    assert_eq!(
        (p.plugin.as_str(), p.model.as_deref(), p.port),
        ("snapmaker", Some("U1"), Some(port))
    );
    assert_eq!(p.name.as_deref(), Some("U1"));
    let mut cfg = config("u1", "snapmaker", port);
    cfg.port = None;
    let s = conn.connect(&cfg, &secrets(&[])).await.unwrap();
    assert_eq!(s.reported_model().as_deref(), Some("U1"));
    // Another Klipper machine is not a U1.
    mocks
        .control("/moonraker", serde_json::json!({ "variant": null }))
        .await;
    assert!(
        conn.probe("127.0.0.1", Duration::from_millis(800))
            .await
            .is_none()
    );
}

/// A native Creality session to the fake, after `/creality` made it `printer`.
async fn creality(
    printer: serde_json::Value,
    key: Option<&str>,
) -> (Mocks, Arc<MemoryGate>, Box<dyn PrinterSession>) {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("creality", &[]).await;
    mocks.control("/creality", printer).await;
    let mut cfg = config("bay-5", "creality", 0);
    cfg.port = None;
    cfg.protocol = Some("native".to_owned());
    cfg.ws_port = Some(mocks.port("creality"));
    cfg.http_port = Some(mocks.port("creality-http"));
    cfg.camera_port = Some(mocks.port("creality-camera"));
    let sec = match key {
        Some(k) => {
            cfg.credential_ref = Some("k".to_owned());
            secrets(&[("k", k.to_owned())])
        }
        None => secrets(&[]),
    };
    let s = CrealityConnector::new(gate.clone())
        .connect(&cfg, &sec)
        .await
        .unwrap();
    (mocks, gate, s)
}

fn mock_log(state: &serde_json::Value) -> Vec<String> {
    state["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect()
}

// A K2 Plus names itself by board code, its CFS spools are slots, its camera is WebRTC, and an
// upload leaves out the folder field as OrcaSlicer does for CFS models.
#[tokio::test]
async fn a_creality_k2_reads_its_cfs_and_board_code() {
    let (mocks, gate, s) = creality(
        serde_json::json!({ "model": "F008", "modelVersion": "Printer HW Ver: F008; Printer SW Ver: 1.1.2.10", "cfs": true }),
        Some("creality-key"),
    )
    .await;
    assert_eq!(s.reported_model().as_deref(), Some("K2 Plus"));
    let mut slots = Vec::new();
    for _ in 0..50 {
        slots = s.status().await.unwrap().slots;
        if !slots.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let got: Vec<(&str, Option<&str>, Option<&str>)> = slots
        .iter()
        .map(|x| (x.id.as_str(), x.material.as_deref(), x.color.as_deref()))
        .collect();
    assert_eq!(
        got,
        [
            ("A1", Some("PLA"), Some("#ff0000")),
            ("A2", Some("PETG"), Some("#0000ff")),
            ("A3", None, None),
            ("A4", None, None),
        ]
    );
    let hw = s.hardware().await.unwrap().unwrap();
    assert_eq!(hw.firmware.as_deref(), Some("1.1.2.10"));
    assert_eq!(hw.hostname.as_deref(), Some("mock-creality"));
    assert_eq!(hw.filament_units[0].kind, "cfs");
    assert!(
        s.stream().await.unwrap().is_none(),
        "a K2 streams WebRTC, not MJPEG"
    );
    let file = job_file("cube.gcode", JobKind::Gcode);
    let t = gate.mint(
        Action::Upload,
        "bay-5",
        &params::upload("bay-5", &file.name, &file.sha256),
    );
    s.upload(file, &t).await.unwrap();
    let log = mock_log(&mocks.state().await);
    assert!(
        log.iter()
            .any(|l| l == "creality upload path=null name=cube.gcode"),
        "{log:?}"
    );
    assert!(
        log.iter().any(|l| l == "creality authorization Bearer"),
        "{log:?}"
    );
}

// A printer that refuses the wsslicer subprotocol is asked again without one, as OrcaSlicer connects.
#[tokio::test]
async fn a_creality_that_refuses_the_subprotocol_still_connects() {
    let (mocks, _gate, s) = creality(serde_json::json!({ "refuseSubprotocol": true }), None).await;
    assert_eq!(s.status().await.unwrap().state, PrinterState::Idle);
    let log = mock_log(&mocks.state().await);
    assert!(log.iter().any(|l| l == "creality subprotocol refused"), "{log:?}");
    assert!(log.iter().any(|l| l == "creality subprotocol "), "{log:?}");
    assert_eq!(s.motion().await.unwrap().position, Some([100.0, 100.0, 10.0]));
    let live = s.status().await.unwrap().live.unwrap();
    assert_eq!(live.light, Some(true));
}

// A K1 on firmware that reports webrtcSupport streams WebRTC, not MJPEG on 8080.
#[tokio::test]
async fn a_creality_k1_with_webrtc_firmware_has_no_mjpeg() {
    let (_mocks, _gate, s) = creality(serde_json::json!({ "model": "K1C", "webrtc": true }), None).await;
    assert!(s.snapshot().await.unwrap().is_none());
    let (_mocks, _gate, s) = creality(serde_json::json!({ "model": "K1C" }), None).await;
    assert!(s.snapshot().await.unwrap().is_some());
}

// "Enter IP instead": `/info` names the model and the MAC.
#[tokio::test]
async fn creality_probe_reads_info() {
    let mocks = Mocks::start("creality", &[]).await;
    let conn = CrealityConnector::new(Arc::new(MemoryGate::new()))
        .with_probe_ports(mocks.port("creality-http"), mocks.port("creality"));
    let p = conn.probe("127.0.0.1", Duration::from_millis(800)).await.unwrap();
    assert_eq!(p.plugin, "creality");
    assert_eq!(p.model.as_deref(), Some("CR-K1 Max"));
    assert_eq!(p.uid.as_deref(), Some("A1B2C3D4E5F6"));
    assert_eq!(p.name.as_deref(), Some("mock-creality"));
    // Only the WebSocket answers: still a Creality printer, model unknown.
    let ws_only =
        CrealityConnector::new(Arc::new(MemoryGate::new())).with_probe_ports(1, mocks.port("creality"));
    let p = ws_only
        .probe("127.0.0.1", Duration::from_millis(800))
        .await
        .unwrap();
    assert_eq!(p.model, None);
}
