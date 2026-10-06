// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Setup asks for as little as the printer allows: found, identified and filled in from what it
//! reports, against the protocol fakes in `@slicerx/mock-printers`.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;

use std::sync::Arc;

use common::{Mocks, config, expect_code, job_file, secrets};
use sx_connect::drivers::BambuConnector;
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
