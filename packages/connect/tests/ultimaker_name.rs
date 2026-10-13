// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A white-label edition (Acme Slicer) shows its own name on an UltiMaker: on the touchscreen's pairing prompt, as the
// owner of the job it sends, and in the start error. Its own test binary, so the name set here reaches no other test.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Mocks, config, job_file, secrets};
use sx_connect::drivers::UltiMakerConnector;
use sx_connect::{Action, JobKind, MemoryGate, PrinterConnector, StartOptions, params};

#[tokio::test]
async fn an_ultimaker_shows_the_editions_name() {
    sx_connect::set_app_name("Acme Slicer");
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("ultimaker", &[]).await;
    let mut cfg = config("bay-7", "ultimaker", mocks.port("ultimaker"));
    cfg.poll_ms = Some(100);
    let connector = UltiMakerConnector::new(gate.clone());
    let pair = connector
        .authorize(&cfg, Duration::from_secs(20))
        .await
        .unwrap()
        .unwrap();
    cfg.credential_ref = Some("um".to_owned());
    let s = connector.connect(&cfg, &secrets(&[("um", pair)])).await.unwrap();

    // A start without the held file names the app that holds it.
    let file = job_file("cube.gcode", JobKind::Gcode);
    let other = job_file("other.gcode", JobKind::Gcode);
    let t = gate.mint(
        Action::Upload,
        "bay-7",
        &params::upload("bay-7", &other.name, &other.sha256),
    );
    let held = s.upload(other, &t).await.unwrap();
    let missing = sx_connect::RemoteFile {
        path: file.name.clone(),
        name: file.name.clone(),
        sha256: Some(file.sha256.clone()),
        ..held.clone()
    };
    let opts = StartOptions::default();
    let t = gate.mint(Action::Start, "bay-7", &params::start("bay-7", &missing, &opts));
    let err = s.start(&missing, opts, &t).await.unwrap_err().to_string();
    assert!(err.contains("Acme Slicer holds the file sent last"), "{err}");

    let opts = StartOptions::default();
    let t = gate.mint(Action::Start, "bay-7", &params::start("bay-7", &held, &opts));
    s.start(&held, opts, &t).await.unwrap();
    let log = mocks.state().await["ultimaker"]["log"].to_string();
    assert!(
        log.contains("pair request application=Acme Slicer user=Acme Slicer"),
        "{log}"
    );
    assert!(log.contains("job owner=Acme Slicer"), "{log}");
    assert!(!log.contains("SlicerX"), "{log}");
}
