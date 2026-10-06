// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Driver contract suite against the protocol fakes in `@slicerx/mock-printers`.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Case, Mocks, config, expect_code, job_file, run_contract, secrets};
use sx_connect::drivers::{
    BambuConnector, CrealityConnector, DuetConnector, ElegooConnector, MoonrakerConnector,
    OctoPrintConnector, PrusaLinkConnector, SnapmakerConnector,
};
use sx_connect::{ErrorCode, JobKind, MemoryGate, PrinterConnector, StartOptions};

async fn http_case(
    connector: &dyn PrinterConnector,
    mock: &str,
    plugin: &str,
    camera: bool,
    gcode: bool,
    gate: Arc<MemoryGate>,
) {
    let mocks = Mocks::start(mock, &[]).await;
    let cfg = config("bay-x", plugin, mocks.port(mock));
    let session = connector.connect(&cfg, &secrets(&[])).await.unwrap();
    let case = Case {
        mocks: &mocks,
        mock,
        id: "bay-x",
        file: job_file("cube.gcode", JobKind::Gcode),
        start: StartOptions::default(),
        gate,
        camera,
        gcode,
    };
    run_contract(session.as_ref(), &case).await;
}

#[tokio::test]
async fn moonraker_contract() {
    let gate = Arc::new(MemoryGate::new());
    http_case(
        &MoonrakerConnector::new(gate.clone()),
        "moonraker",
        "moonraker",
        true,
        true,
        gate,
    )
    .await;
}

#[tokio::test]
async fn creality_contract_over_moonraker() {
    let gate = Arc::new(MemoryGate::new());
    http_case(
        &CrealityConnector::new(gate.clone()),
        "moonraker",
        "creality",
        true,
        true,
        gate,
    )
    .await;
}

#[tokio::test]
async fn snapmaker_contract_over_moonraker() {
    let gate = Arc::new(MemoryGate::new());
    http_case(
        &SnapmakerConnector::new(gate.clone()),
        "moonraker",
        "snapmaker",
        true,
        true,
        gate,
    )
    .await;
}

#[tokio::test]
async fn prusalink_contract() {
    let gate = Arc::new(MemoryGate::new());
    // The MK4S fixture has no camera and PrusaLink has no G-code console.
    http_case(
        &PrusaLinkConnector::new(gate.clone()),
        "prusalink",
        "prusalink",
        false,
        false,
        gate,
    )
    .await;
}

#[tokio::test]
async fn octoprint_contract() {
    let gate = Arc::new(MemoryGate::new());
    http_case(
        &OctoPrintConnector::new(gate.clone()),
        "octoprint",
        "octoprint",
        true,
        true,
        gate,
    )
    .await;
}

#[tokio::test]
async fn duet_contract() {
    let gate = Arc::new(MemoryGate::new());
    http_case(
        &DuetConnector::new(gate.clone()),
        "duet",
        "duet",
        false,
        true,
        gate,
    )
    .await;
}

#[tokio::test]
async fn elegoo_sdcp_contract() {
    let gate = Arc::new(MemoryGate::new());
    // Upload goes over the printer's HTTP port, the same port as the WebSocket.
    http_case(
        &ElegooConnector::new(gate.clone()),
        "elegoo",
        "elegoo",
        true,
        false,
        gate,
    )
    .await;
}

// Two sessions to one printer opened in the same second, the way the bridge's watcher and the app's
// first status call can race. With one MQTT client id the broker closed whichever connected first,
// both reconnected two seconds later, and the printer flashed between offline and online. The H2D
// also sends only what changed between full reports, and the camera must stay on through those.
#[tokio::test]
async fn two_bambu_sessions_stay_online_through_h2d_partial_reports() {
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", serde_json::json!({ "model": "O1D" }))
        .await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let c = BambuConnector::new(Arc::new(MemoryGate::new()));
    let (a, b) = tokio::join!(c.connect(&cfg, &sec), c.connect(&cfg, &sec));
    let (a, b) = (a.unwrap(), b.unwrap());
    let end = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < end {
        for s in [&a, &b] {
            let st = s.status().await.unwrap();
            assert_ne!(
                st.state,
                sx_connect::PrinterState::Offline,
                "a session went offline"
            );
            assert!(st.camera_available, "a partial report turned the camera off");
            assert_eq!(st.nozzles.len(), 2);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let state = mocks.state().await;
    let log: Vec<&str> = state["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect();
    assert_eq!(log.iter().filter(|l| **l == "mqtt connect").count(), 2, "{log:?}");
    assert!(!log.iter().any(|l| l.starts_with("mqtt takeover")), "{log:?}");
}

// A caller that gives up while the session is opening (the bridge's watcher times out after 10
// seconds) leaves no connection behind to sign in and reconnect on its own.
#[tokio::test]
async fn a_canceled_bambu_connect_leaves_no_connection() {
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let c = BambuConnector::new(Arc::new(MemoryGate::new()));
    let gave_up = tokio::time::timeout(Duration::ZERO, c.connect(&cfg, &sec)).await;
    assert!(gave_up.is_err());
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let state = mocks.state().await;
    assert!(
        !state["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l == "mqtt connect"),
        "{state}"
    );
}

#[tokio::test]
async fn bambu_contract() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    cfg.ftp_port = Some(mocks.port("bambu-ftp"));
    cfg.camera_port = Some(mocks.port("bambu-camera"));
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let session = BambuConnector::new(gate.clone())
        .connect(&cfg, &sec)
        .await
        .unwrap();

    let start = StartOptions {
        slot_map: Some([(0, "A1".to_owned()), (2, "A3".to_owned())].into_iter().collect()),
        flow_calibration: Some(true),
        vibration_compensation: Some(true),
        timelapse: Some(true),
        first_layer_inspection: Some(false),
        ..StartOptions::default()
    };
    let case = Case {
        mocks: &mocks,
        mock: "bambu",
        id: "bay-1",
        file: job_file("cube.gcode.3mf", JobKind::Gcode3mf),
        start,
        gate,
        camera: true,
        gcode: true,
    };
    run_contract(session.as_ref(), &case).await;

    // AMS slot map reached the printer as global tray ids.
    let state = mocks.state().await;
    let log = state["bambu"]["log"].as_array().unwrap();
    assert!(
        log.iter()
            .any(|l| l.as_str().is_some_and(|l| l.starts_with("start")))
    );
    let all = state["log"].as_array().unwrap();
    assert!(
        all.iter().any(|l| l
            .as_str()
            .is_some_and(|l| l.contains("\"ams_mapping\":[0,-1,2]")
                && l.contains("\"ams_mapping2\":[{\"ams_id\":0,\"slot_id\":0},{\"ams_id\":255,\"slot_id\":255},{\"ams_id\":0,\"slot_id\":2}]")
                && l.contains("\"use_ams\":true"))),
        "{all:?}"
    );

    // The print options reached the printer as the protocol's own keys.
    assert!(
        all.iter().any(
            |l| l.as_str().is_some_and(|l| l.contains("\"bed_levelling\":true")
                && l.contains("\"flow_cali\":true")
                && l.contains("\"vibration_cali\":true")
                && l.contains("\"layer_inspect\":false")
                && l.contains("\"timelapse\":true"))
        ),
        "{all:?}"
    );

    // AMS state comes through normalized.
    let st = session.status().await.unwrap();
    assert_eq!(st.slots.len(), 4);
    assert_eq!(st.slots[0].id, "A1");
    assert_eq!(st.slots[0].material.as_deref(), Some("PLA"));
    assert_eq!(st.slots[3].material.as_deref(), Some("TPU"));
    assert_eq!(st.slots[3].color.as_deref(), Some("#f97316"));
}

// `gcode_file` carries no mapping, so the printer would feed each filament from the slot its
// G-code names. A plain G-code start with a slot map is refused before anything is sent and
// without spending the token; the same start without a map goes through.
#[tokio::test]
async fn bambu_refuses_a_slot_map_on_plain_gcode() {
    use sx_connect::{Action, params};
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    cfg.ftp_port = Some(mocks.port("bambu-ftp"));
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let session = BambuConnector::new(gate.clone())
        .connect(&cfg, &sec)
        .await
        .unwrap();
    let file = job_file("cube.gcode", JobKind::Gcode);
    let t = gate.mint(
        Action::Upload,
        "bay-1",
        &params::upload("bay-1", &file.name, &file.sha256),
    );
    let rf = session.upload(file, &t).await.unwrap();

    let mapped = StartOptions {
        slot_map: Some([(0, "A3".to_owned())].into_iter().collect()),
        ..StartOptions::default()
    };
    let t = gate.mint(Action::Start, "bay-1", &params::start("bay-1", &rf, &mapped));
    let before = mocks.state().await;
    match session.start(&rf, mapped, &t).await {
        Err(e) => {
            assert_eq!(e.code(), ErrorCode::NotSupported);
            assert!(e.to_string().contains(".gcode.3mf"), "{e}");
        }
        Ok(()) => panic!("a slot map on plain G-code must be refused"),
    }
    assert_eq!(mocks.state().await["bambu"], before["bambu"]);

    let plain = StartOptions::default();
    let t = gate.mint(Action::Start, "bay-1", &params::start("bay-1", &rf, &plain));
    session.start(&rf, plain, &t).await.unwrap();
    for _ in 0..100 {
        let state = mocks.state().await;
        if state["bambu"]["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l.as_str().is_some_and(|l| l.starts_with("start")))
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the plain G-code start never reached the printer");
}

// A printer that refuses a project start answers `result: fail` with its reason. The start
// fails with `refused` and the reason, the printer does not start, and nothing else is sent.
#[tokio::test]
async fn bambu_refused_project_start_says_why() {
    use serde_json::json;
    use sx_connect::{Action, params};
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    cfg.ftp_port = Some(mocks.port("bambu-ftp"));
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    mocks.set_state("bambu", "idle").await;
    let session = BambuConnector::new(gate.clone())
        .connect(&cfg, &sec)
        .await
        .unwrap();
    let file = job_file("cube.gcode.3mf", JobKind::Gcode3mf);
    let t = gate.mint(
        Action::Upload,
        "bay-1",
        &params::upload("bay-1", &file.name, &file.sha256),
    );
    let rf = session.upload(file, &t).await.unwrap();
    mocks
        .control("/bambu", json!({ "refuse": "MD5 verify failed" }))
        .await;
    let opts = StartOptions::default();
    let t = gate.mint(Action::Start, "bay-1", &params::start("bay-1", &rf, &opts));
    match session.start(&rf, opts.clone(), &t).await {
        Err(e) => {
            assert_eq!(e.code(), ErrorCode::Refused);
            assert!(e.to_string().contains("MD5 verify failed"), "{e}");
        }
        Ok(()) => panic!("a refused project start must fail"),
    }
    assert_eq!(mocks.state().await["bambu"]["state"], "idle");

    // Accepted again: the same kind of start goes through once the printer answers success.
    mocks.control("/bambu", json!({ "refuse": null })).await;
    let t = gate.mint(Action::Start, "bay-1", &params::start("bay-1", &rf, &opts));
    session.start(&rf, opts, &t).await.unwrap();
}

/// Connects to the Bambu fake after making it another printer through `/bambu`, uploads a
/// .gcode.3mf and starts it with `slot_map`, and returns the session and the project start line.
async fn bambu_as(
    printer: serde_json::Value,
    slot_map: &[(u32, &str)],
) -> (Mocks, Box<dyn sx_connect::PrinterSession>, String) {
    use sx_connect::{Action, params};
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    mocks.control("/bambu", printer).await;
    mocks.set_state("bambu", "idle").await;
    let mut cfg = config("a1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    cfg.ftp_port = Some(mocks.port("bambu-ftp"));
    cfg.camera_port = Some(mocks.port("bambu-camera"));
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let session = BambuConnector::new(gate.clone())
        .connect(&cfg, &sec)
        .await
        .unwrap();
    let file = job_file("cube.gcode.3mf", JobKind::Gcode3mf);
    let t = gate.mint(
        Action::Upload,
        "a1",
        &params::upload("a1", &file.name, &file.sha256),
    );
    let rf = session.upload(file, &t).await.unwrap();
    let opts = StartOptions {
        slot_map: Some(slot_map.iter().map(|(k, v)| (*k, (*v).to_owned())).collect()),
        ..StartOptions::default()
    };
    let t = gate.mint(Action::Start, "a1", &params::start("a1", &rf, &opts));
    session.start(&rf, opts, &t).await.unwrap();
    let line = mocks
        .wait_log("project_file {")
        .await
        .into_iter()
        .find(|l| l.starts_with("project_file {"))
        .unwrap();
    (mocks, session, line)
}

// An A1 with its AMS lite: the model comes from the printer's own `get_version` answer (N2S), the
// four AMS lite trays and the external spool beside them are all slots, and a filament on the
// external spool goes out as -1 and 254 the way Bambu Studio sends it. The camera is the port 6000
// JPEG stream.
#[tokio::test]
async fn bambu_a1_with_ams_lite_and_external_spool() {
    let spec = serde_json::json!({ "model": "N2S", "ams": "lite", "external": { "type": "PETG", "color": "#202020" } });
    let (_mocks, s, line) = bambu_as(spec, &[(0, "A2"), (1, "1")]).await;
    assert_eq!(s.reported_model().as_deref(), Some("A1"));
    let st = s.status().await.unwrap();
    let ids: Vec<&str> = st.slots.iter().map(|x| x.id.as_str()).collect();
    assert_eq!(ids, ["A1", "A2", "A3", "A4", "1"]);
    assert_eq!(st.slots[4].material.as_deref(), Some("PETG"));
    assert!(line.contains("\"ams_mapping\":[1,-1]"), "{line}");
    assert!(
        line.contains("\"ams_mapping2\":[{\"ams_id\":0,\"slot_id\":1},{\"ams_id\":254,\"slot_id\":0}]"),
        "{line}"
    );
    assert!(line.contains("\"use_ams\":true"), "{line}");
    let shot = s.snapshot().await.unwrap().expect("a still from port 6000");
    assert_eq!(shot.content_type, "image/jpeg");
    assert!(shot.data.starts_with(&[0xff, 0xd8]));
}

// An A1 mini with no AMS lite attached: only the external spool is a slot, and a print from it
// goes out with `ams_mapping` -1 and `use_ams` false, so the printer does not look for an AMS.
#[tokio::test]
async fn bambu_a1_mini_without_ams_prints_from_the_external_spool() {
    let spec = serde_json::json!({ "model": "N1", "ams": "none", "external": { "type": "PLA", "color": "#ffffff" } });
    let (_mocks, s, line) = bambu_as(spec, &[(0, "1")]).await;
    assert_eq!(s.reported_model().as_deref(), Some("A1 mini"));
    let ids: Vec<String> = s
        .status()
        .await
        .unwrap()
        .slots
        .into_iter()
        .map(|x| x.id)
        .collect();
    assert_eq!(ids, ["1"]);
    assert!(line.contains("\"ams_mapping\":[-1]"), "{line}");
    assert!(
        line.contains("\"ams_mapping2\":[{\"ams_id\":254,\"slot_id\":0}]"),
        "{line}"
    );
    assert!(line.contains("\"use_ams\":false"), "{line}");
}

// An H2D, found by an SSDP search sent to the fake, then connected: its report fills the model,
// firmware, both nozzles (left first) and the AMS units with what they hold, so setup asks for none
// of it. The report is `fixtures/bambu-h2d-pushall.json`.
#[tokio::test]
async fn bambu_h2d_is_found_and_reports_its_hardware() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", serde_json::json!({ "model": "O1D" }))
        .await;
    let ssdp = std::net::SocketAddr::from(([127, 0, 0, 1], mocks.port("bambu-ssdp")));
    let connector = BambuConnector::new(gate.clone())
        .with_discovery_bind(std::net::Ipv4Addr::LOCALHOST.into())
        .with_ssdp(Vec::new(), vec![ssdp]);
    let found = connector.discover(Duration::from_millis(500)).await;
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].model.as_deref(), Some("H2D"));
    assert_eq!(found[0].serial.as_deref(), Some(mocks.str("serial").as_str()));
    assert_eq!(found[0].lan_only, Some(true));
    let probed = connector
        .probe("127.0.0.1", Duration::from_millis(500))
        .await
        .unwrap();
    assert_eq!(probed.serial, found[0].serial);
    // With SSDP silent, a probe reads the serial number from the MQTT port's certificate.
    let silent = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let quiet = BambuConnector::new(gate.clone())
        .with_ssdp(Vec::new(), vec![silent.local_addr().unwrap()])
        .with_mqtt_port(mocks.port("bambu"));
    let by_cert = quiet
        .probe("127.0.0.1", Duration::from_millis(1500))
        .await
        .unwrap();
    assert_eq!(by_cert.serial.as_deref(), Some(mocks.str("serial").as_str()));
    assert_eq!(by_cert.model, None);

    let mut cfg = config("h2d", "bambu-lan", mocks.port("bambu"));
    cfg.serial = found[0].serial.clone();
    cfg.credential_ref = Some("bambu-code".to_owned());
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let session = connector.connect(&cfg, &sec).await.unwrap();
    let hw = session.hardware().await.unwrap().unwrap();
    assert_eq!(hw.model.as_deref(), Some("H2D"));
    assert_eq!(hw.firmware.as_deref(), Some("01.04.00.00"));
    let nozzles: Vec<(Option<&str>, Option<f64>, Option<&str>)> = hw
        .extruders
        .iter()
        .map(|e| {
            (
                e.position.as_deref(),
                e.nozzle_diameter_mm,
                e.nozzle_type.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        nozzles,
        [
            (Some("left"), Some(0.6), Some("hardened-steel")),
            (Some("right"), Some(0.4), Some("hardened-steel")),
        ]
    );
    let kinds: Vec<&str> = hw.filament_units.iter().map(|u| u.kind.as_str()).collect();
    assert_eq!(kinds, ["ams-2-pro", "ams-ht", "external", "external"]);
    assert_eq!(
        hw.filament_units[0].slots[0].material.as_deref(),
        Some("PLA Basic")
    );
    // The status still reads both nozzles' temperatures.
    assert_eq!(session.status().await.unwrap().nozzles.len(), 2);
}

#[tokio::test]
async fn bambu_rejects_wrong_access_code() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    let sec = secrets(&[("bambu-code", "00000000".to_owned())]);
    let r = BambuConnector::new(gate).connect(&cfg, &sec).await;
    expect_code(r, ErrorCode::Auth);
}

#[tokio::test]
async fn bambu_wrong_serial_is_a_protocol_error() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some("WRONGSERIAL".to_owned());
    cfg.credential_ref = Some("bambu-code".to_owned());
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    let r = BambuConnector::new(gate).connect(&cfg, &sec).await;
    expect_code(r, ErrorCode::Protocol);
}

#[tokio::test]
async fn http_drivers_reject_bad_credentials() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("moonraker,prusalink,octoprint,duet", &["--auth"]).await;
    let bad = secrets(&[("k", "wrong".to_owned())]);
    let good_key = secrets(&[("k", mocks.str("apiKey"))]);
    let good_pw = secrets(&[("k", mocks.str("duetPassword"))]);

    let cases: Vec<(Box<dyn PrinterConnector>, &str, &str)> = vec![
        (
            Box::new(MoonrakerConnector::new(gate.clone())),
            "moonraker",
            "moonraker",
        ),
        (
            Box::new(PrusaLinkConnector::new(gate.clone())),
            "prusalink",
            "prusalink",
        ),
        (
            Box::new(OctoPrintConnector::new(gate.clone())),
            "octoprint",
            "octoprint",
        ),
        (Box::new(DuetConnector::new(gate.clone())), "duet", "duet"),
    ];
    for (conn, mock, plugin) in cases {
        let mut cfg = config("bay-x", plugin, mocks.port(mock));
        cfg.credential_ref = Some("k".to_owned());
        expect_code(conn.connect(&cfg, &bad).await, ErrorCode::Auth);
        let good = if mock == "duet" { &good_pw } else { &good_key };
        let s = conn.connect(&cfg, good).await.unwrap();
        assert_eq!(s.status().await.unwrap().state, sx_connect::PrinterState::Idle);
    }
}

#[tokio::test]
async fn an_unreachable_printer_is_reported_not_panicked() {
    let gate = Arc::new(MemoryGate::new());
    let cfg = config("bay-9", "moonraker", 1);
    let r = MoonrakerConnector::new(gate).connect(&cfg, &secrets(&[])).await;
    expect_code(r, ErrorCode::Unreachable);
}

#[tokio::test]
async fn creality_native_contract() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("creality", &[]).await;
    let mut cfg = config("bay-5", "creality", 0);
    cfg.port = None;
    cfg.protocol = Some("native".to_owned());
    cfg.ws_port = Some(mocks.port("creality"));
    cfg.http_port = Some(mocks.port("creality-http"));
    cfg.camera_port = Some(mocks.port("creality-camera"));
    let session = CrealityConnector::new(gate.clone())
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    let case = Case {
        mocks: &mocks,
        mock: "creality",
        id: "bay-5",
        file: job_file("cube.gcode", JobKind::Gcode),
        start: StartOptions::default(),
        gate,
        camera: true,
        gcode: true,
    };
    run_contract(session.as_ref(), &case).await;

    // The printer got the subprotocol Creality Print uses, answered the heartbeat, and the upload
    // carried the folder field older models expect.
    let state = mocks.state().await;
    let log: Vec<String> = state["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect();
    assert!(
        log.iter().any(|l| l == "creality subprotocol wsslicer"),
        "{log:?}"
    );
    assert!(log.iter().any(|l| l == "creality heartbeat answered"), "{log:?}");
    assert!(
        log.iter()
            .any(|l| l == "creality upload path=\"\" name=cube.gcode"),
        "{log:?}"
    );
}

#[tokio::test]
async fn creality_probe_picks_the_native_interface_when_moonraker_is_absent() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("creality", &[]).await;
    let mut cfg = config("bay-5", "creality", 0);
    // Nothing listens on a Moonraker port; only the native interface answers.
    cfg.port = Some(1);
    cfg.ws_port = Some(mocks.port("creality"));
    cfg.http_port = Some(mocks.port("creality-http"));
    let session = CrealityConnector::new(gate)
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    assert_eq!(
        session.status().await.unwrap().state,
        sx_connect::PrinterState::Idle
    );
    assert!(
        session
            .capabilities()
            .contains(&sx_connect::Capability::GcodeConsole)
    );
}

#[tokio::test]
async fn creality_probe_picks_moonraker_when_it_answers() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("moonraker,creality", &[]).await;
    let mut cfg = config("bay-5", "creality", mocks.port("moonraker"));
    cfg.ws_port = Some(mocks.port("creality"));
    let session = CrealityConnector::new(gate)
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    // Moonraker's mock reports the finished Voron job; the native mock would report idle.
    let st = session.status().await.unwrap();
    assert_eq!(st.state, sx_connect::PrinterState::Idle);
    assert!(!session.capabilities().is_empty());
    let state = mocks.state().await;
    assert!(
        state["log"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l != "creality heartbeat answered"),
        "the native socket must not have been opened"
    );
}

#[tokio::test]
async fn snapmaker_luban_pairs_and_passes_the_contract() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("snapmaker-luban", &[]).await;
    let mut cfg = config("bay-2", "snapmaker", mocks.port("snapmaker-luban"));
    cfg.credential_ref = Some("snapmaker-token".to_owned());
    let connector = SnapmakerConnector::new(gate.clone());

    // Without a stored token the printer counts as unpaired.
    expect_code(connector.connect(&cfg, &secrets(&[])).await, ErrorCode::Auth);
    // A made-up token is refused by the printer.
    expect_code(
        connector
            .connect(&cfg, &secrets(&[("snapmaker-token", "0".repeat(32))]))
            .await,
        ErrorCode::Auth,
    );
    // Pairing waits for the tap (the mock confirms after two status polls) and returns the token.
    let token = connector
        .authorize(&cfg, std::time::Duration::from_secs(20))
        .await
        .unwrap()
        .expect("a token");
    assert_eq!(token.len(), 32);
    // A pairing that is never confirmed times out as an auth error.
    let quiet = Mocks::start("snapmaker-luban", &[]).await;
    let mut cfg2 = config("bay-2", "snapmaker", quiet.port("snapmaker-luban"));
    cfg2.credential_ref = Some("snapmaker-token".to_owned());
    expect_code(
        connector.authorize(&cfg2, std::time::Duration::ZERO).await,
        ErrorCode::Auth,
    );

    let session = connector
        .connect(&cfg, &secrets(&[("snapmaker-token", token)]))
        .await
        .unwrap();
    let case = Case {
        mocks: &mocks,
        mock: "snapmaker-luban",
        id: "bay-2",
        file: job_file("cube.gcode", JobKind::Gcode),
        start: StartOptions::default(),
        gate,
        camera: false,
        gcode: true,
    };
    run_contract(session.as_ref(), &case).await;
}

#[tokio::test]
async fn snapmaker_starts_only_the_file_sent_last() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("snapmaker-luban", &[]).await;
    let mut cfg = config("bay-2", "snapmaker", mocks.port("snapmaker-luban"));
    cfg.credential_ref = Some("t".to_owned());
    let connector = SnapmakerConnector::new(gate.clone());
    let token = connector
        .authorize(&cfg, std::time::Duration::from_secs(20))
        .await
        .unwrap()
        .unwrap();
    let s = connector.connect(&cfg, &secrets(&[("t", token)])).await.unwrap();
    let a = job_file("a.gcode", JobKind::Gcode);
    let b = job_file("b.gcode", JobKind::Gcode);
    let ra = s
        .upload(
            a.clone(),
            &gate.mint(
                sx_connect::Action::Upload,
                "bay-2",
                &sx_connect::params::upload("bay-2", &a.name, &a.sha256),
            ),
        )
        .await
        .unwrap();
    let _rb = s
        .upload(
            b.clone(),
            &gate.mint(
                sx_connect::Action::Upload,
                "bay-2",
                &sx_connect::params::upload("bay-2", &b.name, &b.sha256),
            ),
        )
        .await
        .unwrap();
    let opts = StartOptions::default();
    let t = gate.mint(
        sx_connect::Action::Start,
        "bay-2",
        &sx_connect::params::start("bay-2", &ra, &opts),
    );
    expect_code(s.start(&ra, opts, &t).await, ErrorCode::NotFound);
}

#[tokio::test]
async fn prusalink_digest_login_passes_the_contract() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("prusalink", &["--digest"]).await;
    let mut cfg = config("bay-3", "prusalink", mocks.port("prusalink"));
    cfg.credential_ref = Some("prusa-pass".to_owned());
    cfg.username = Some(mocks.str("digestUser"));
    let connector = PrusaLinkConnector::new(gate.clone());

    // A missing password and a wrong one fail as auth errors.
    expect_code(connector.connect(&cfg, &secrets(&[])).await, ErrorCode::Auth);
    expect_code(
        connector
            .connect(&cfg, &secrets(&[("prusa-pass", "wrong".to_owned())]))
            .await,
        ErrorCode::Auth,
    );
    // Without a user name the login is `maker`, as on every Buddy printer.
    let mut no_user = cfg.clone();
    no_user.username = None;
    let s = connector
        .connect(&no_user, &secrets(&[("prusa-pass", mocks.str("digestPassword"))]))
        .await
        .unwrap();
    let hw = s.hardware().await.unwrap().unwrap();
    assert_eq!(hw.firmware.as_deref(), Some("6.2.4+mock"));
    assert_eq!(hw.serial.as_deref(), Some("CZPXMOCK0001"));

    let session = connector
        .connect(&cfg, &secrets(&[("prusa-pass", mocks.str("digestPassword"))]))
        .await
        .unwrap();
    let case = Case {
        mocks: &mocks,
        mock: "prusalink",
        id: "bay-3",
        file: job_file("cube.gcode", JobKind::Gcode),
        start: StartOptions::default(),
        gate,
        camera: false,
        gcode: false,
    };
    run_contract(session.as_ref(), &case).await;
}

// One secret field: a printer that answers 401 with no Digest challenge takes it as an API key.
// Uploads go to the storage the printer lists as writable, a printer without one says a USB drive
// is needed, and a 409 says the printer is busy.
#[tokio::test]
async fn prusalink_key_fallback_storage_and_busy() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("prusalink", &["--auth"]).await;
    let mut cfg = config("bay-3", "prusalink", mocks.port("prusalink"));
    cfg.credential_ref = Some("k".to_owned());
    let connector = PrusaLinkConnector::new(gate.clone());
    let s = connector
        .connect(&cfg, &secrets(&[("k", mocks.str("apiKey"))]))
        .await
        .unwrap();
    let up = |name: &str| {
        let f = job_file(name, JobKind::Gcode);
        let t = gate.mint(
            sx_connect::Action::Upload,
            "bay-3",
            &sx_connect::params::upload("bay-3", &f.name, &f.sha256),
        );
        (f, t)
    };
    mocks
        .control("/prusalink", serde_json::json!({ "storage": "local" }))
        .await;
    let (f, t) = up("a.gcode");
    let r = s.upload(f, &t).await.unwrap();
    assert_eq!(r.path, "local/a.gcode");
    let opts = StartOptions::default();
    let st = gate.mint(
        sx_connect::Action::Start,
        "bay-3",
        &sx_connect::params::start("bay-3", &r, &opts),
    );
    s.start(&r, opts, &st).await.unwrap();
    // Replacing the file that is printing draws a 409.
    let (f, t) = up("a.gcode");
    let busy = s.upload(f, &t).await.err().unwrap();
    assert_eq!(busy.code(), ErrorCode::BadState);
    assert!(busy.to_string().contains("printing"), "{busy}");
    mocks
        .control("/prusalink", serde_json::json!({ "storage": "none" }))
        .await;
    let (f, t) = up("b.gcode");
    let none = s.upload(f, &t).await.err().unwrap();
    assert_eq!(none.code(), ErrorCode::NotFound);
    assert!(none.to_string().contains("USB drive"), "{none}");
}

// A typed address is confirmed with `GET /api/version`, open or behind a Digest login. OctoPrint
// answers the same path and is not taken for PrusaLink.
#[tokio::test]
async fn prusalink_probe_confirms_a_typed_address() {
    let gate = Arc::new(MemoryGate::new());
    let at = |port| PrusaLinkConnector::new(gate.clone()).with_probe_port(port);
    let wait = Duration::from_secs(2);
    let mocks = Mocks::start("prusalink,octoprint", &[]).await;
    let p = at(mocks.port("prusalink"))
        .probe("127.0.0.1", wait)
        .await
        .unwrap();
    assert_eq!(
        (p.plugin.as_str(), p.name.as_deref()),
        ("prusalink", Some("mock"))
    );
    assert!(
        at(mocks.port("octoprint"))
            .probe("127.0.0.1", wait)
            .await
            .is_none()
    );
    let locked = Mocks::start("prusalink", &["--digest"]).await;
    let p = at(locked.port("prusalink"))
        .probe("127.0.0.1", wait)
        .await
        .unwrap();
    assert_eq!((p.plugin.as_str(), p.name), ("prusalink", None));
}

// A refused Moonraker sign-in says why: no key on a server that does not trust this computer, a
// wrong key, or logins forced on the server.
#[tokio::test]
async fn moonraker_says_why_a_sign_in_was_refused() {
    use sx_connect::LoginNeed;
    let conn = MoonrakerConnector::new(Arc::new(MemoryGate::new()));
    let keyed = Mocks::start("moonraker", &["--auth"]).await;
    let mut cfg = config("bay-4", "moonraker", keyed.port("moonraker"));
    let none = conn.connect(&cfg, &secrets(&[])).await.err().unwrap();
    assert_eq!(none.code(), ErrorCode::Auth);
    assert_eq!(none.login_need(), Some(LoginNeed::NotTrusted));
    assert!(none.to_string().contains("trusted_clients"), "{none}");
    cfg.credential_ref = Some("k".to_owned());
    let wrong = conn
        .connect(&cfg, &secrets(&[("k", "wrong".to_owned())]))
        .await
        .err()
        .unwrap();
    assert_eq!(wrong.login_need(), Some(LoginNeed::KeyWrong));
    let forced = Mocks::start("moonraker", &["--force-logins"]).await;
    let cfg = config("bay-4", "moonraker", forced.port("moonraker"));
    let login = conn.connect(&cfg, &secrets(&[])).await.err().unwrap();
    assert_eq!(login.login_need(), Some(LoginNeed::LoginRequired));
}
