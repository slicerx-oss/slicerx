// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Live camera streams from every connector, against the protocol fakes.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Mocks, config, secrets};
use futures::StreamExt;
use sx_connect::camera::{self, CameraFrame, FrameKind, FrameStream};
use sx_connect::drivers::{
    BambuConnector, CrealityConnector, ElegooConnector, MoonrakerConnector, OctoPrintConnector,
    PrusaLinkConnector,
};
use sx_connect::{MemoryGate, PrinterConnector, PrinterSession};

async fn take(s: &mut FrameStream, n: usize) -> Vec<CameraFrame> {
    let mut out = Vec::new();
    while out.len() < n {
        let f = tokio::time::timeout(Duration::from_secs(8), s.next())
            .await
            .expect("a frame in time")
            .expect("the stream ended early");
        out.push(f);
    }
    out
}

fn is_jpeg(f: &CameraFrame) -> bool {
    f.kind == FrameKind::Jpeg && f.key && f.data.starts_with(&[0xff, 0xd8]) && f.data.ends_with(&[0xff, 0xd9])
}

async fn jpeg_case(connector: &dyn PrinterConnector, mock: &str, plugin: &str) {
    let mocks = Mocks::start(mock, &["--camera"]).await;
    let cfg = config("bay-x", plugin, mocks.port(mock));
    let session = connector.connect(&cfg, &secrets(&[])).await.unwrap();
    let mut s = session.stream().await.unwrap().expect("a stream");
    let frames = take(&mut s, 3).await;
    assert!(frames.iter().all(is_jpeg), "{plugin}");
}

#[tokio::test]
async fn moonraker_streams_mjpeg() {
    let gate = Arc::new(MemoryGate::new());
    jpeg_case(&MoonrakerConnector::new(gate), "moonraker", "moonraker").await;
}

#[tokio::test]
async fn octoprint_streams_mjpeg() {
    let gate = Arc::new(MemoryGate::new());
    jpeg_case(&OctoPrintConnector::new(gate), "octoprint", "octoprint").await;
}

#[tokio::test]
async fn prusalink_streams_polled_snapshots() {
    let gate = Arc::new(MemoryGate::new());
    jpeg_case(&PrusaLinkConnector::new(gate), "prusalink", "prusalink").await;
}

#[tokio::test]
async fn a_printer_with_no_camera_has_no_stream() {
    let gate = Arc::new(MemoryGate::new());
    // The MK4S fixture has no camera.
    let mocks = Mocks::start("prusalink", &[]).await;
    let cfg = config("bay-x", "prusalink", mocks.port("prusalink"));
    let session = PrusaLinkConnector::new(gate)
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    assert!(session.stream().await.unwrap().is_none());
}

#[tokio::test]
async fn elegoo_streams_its_mjpeg_url() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("elegoo", &[]).await;
    let cfg = config("bay-x", "elegoo", mocks.port("elegoo"));
    let session = ElegooConnector::new(gate)
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    let mut s = session.stream().await.unwrap().expect("a stream");
    assert!(take(&mut s, 3).await.iter().all(is_jpeg));
}

#[tokio::test]
async fn creality_streams_from_its_camera_port() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("creality", &[]).await;
    let mut cfg = config("bay-5", "creality", 0);
    cfg.port = None;
    cfg.protocol = Some("native".to_owned());
    cfg.ws_port = Some(mocks.port("creality"));
    cfg.http_port = Some(mocks.port("creality-http"));
    cfg.camera_port = Some(mocks.port("creality-camera"));
    let session = CrealityConnector::new(gate)
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    let mut s = session.stream().await.unwrap().expect("a stream");
    assert!(take(&mut s, 3).await.iter().all(is_jpeg));
}

fn bambu_config(mocks: &Mocks) -> sx_connect::PrinterConfig {
    let mut cfg = config("bay-1", "bambu-lan", mocks.port("bambu"));
    cfg.serial = Some(mocks.str("serial"));
    cfg.credential_ref = Some("bambu-code".to_owned());
    cfg.ftp_port = Some(mocks.port("bambu-ftp"));
    cfg.camera_port = Some(mocks.port("bambu-camera"));
    cfg.rtsp_port = Some(mocks.port("bambu-rtsps"));
    cfg
}

async fn bambu_session(mocks: &Mocks, cfg: &sx_connect::PrinterConfig) -> Box<dyn PrinterSession> {
    let sec = secrets(&[("bambu-code", mocks.str("accessCode"))]);
    BambuConnector::new(Arc::new(MemoryGate::new()))
        .connect(cfg, &sec)
        .await
        .unwrap()
}

#[tokio::test]
async fn bambu_a1_and_p1_stream_jpeg_on_port_6000() {
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", serde_json::json!({ "model": "N2S" }))
        .await;
    let session = bambu_session(&mocks, &bambu_config(&mocks)).await;
    let mut s = session.stream().await.unwrap().expect("a stream");
    let frames = take(&mut s, 4).await;
    assert!(frames.iter().all(is_jpeg));
}

/// Nal unit types in an Annex B access unit.
fn nal_types(data: &[u8]) -> Vec<u8> {
    data.windows(4)
        .enumerate()
        .filter(|(_, w)| *w == [0, 0, 0, 1])
        .filter_map(|(i, _)| data.get(i + 4).map(|b| b & 0x1f))
        .collect()
}

#[tokio::test]
async fn bambu_x1_and_h2_stream_h264_over_rtsps_when_port_6000_is_closed() {
    let mocks = Mocks::start("bambu", &[]).await;
    let mut cfg = bambu_config(&mocks);
    // An X1 refuses port 6000.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    cfg.camera_port = Some(closed.local_addr().unwrap().port());
    drop(closed);
    let session = bambu_session(&mocks, &cfg).await;
    let mut s = session.stream().await.unwrap().expect("a stream");
    let frames = take(&mut s, 12).await;
    assert!(frames.iter().all(|f| f.kind == FrameKind::H264));
    // The first frame is a key frame with the parameter sets in front, then a delta frame follows.
    let first = frames.first().unwrap();
    assert!(first.key);
    assert_eq!(nal_types(&first.data), vec![7, 8, 5]);
    assert!(
        frames
            .get(1)
            .is_some_and(|f| !f.key && nal_types(&f.data) == vec![1])
    );
}

// An H2D says in its report where its camera is: RTSPS while LAN Only Liveview is on, `disable` when
// it is off. It sends only what changed between full reports, so the session reads that from the
// merged state.
#[tokio::test]
async fn bambu_h2d_streams_over_rtsps_and_says_when_liveview_is_off() {
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", serde_json::json!({ "model": "O1D" }))
        .await;
    let session = bambu_session(&mocks, &bambu_config(&mocks)).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let st = session.status().await.unwrap();
    assert!(st.camera_available);
    let mut s = session.stream().await.unwrap().expect("a stream");
    assert!(take(&mut s, 3).await.iter().all(|f| f.kind == FrameKind::H264));
    drop(s);

    mocks
        .control("/bambu", serde_json::json!({ "liveview": false }))
        .await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let Err(e) = session.stream().await else {
        panic!("liveview is off, so there is no stream")
    };
    assert_eq!(e.code(), sx_connect::ErrorCode::NotSupported);
    assert_eq!(
        e.to_string(),
        "Turn on LAN Only Liveview on the printer's screen to see its camera."
    );
}

// The H2D's report names its RTSPS URL and no `liveview` key. That is enough: the stream goes
// straight to 322, a still is not looked for on 6000, and a stream whose SPS and PPS come in band
// as units of their own still starts with a key frame that carries them.
#[tokio::test]
async fn bambu_h2d_goes_straight_to_rtsps_with_in_band_parameter_sets() {
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control(
            "/bambu",
            serde_json::json!({ "model": "O1D", "inBandParameterSets": true }),
        )
        .await;
    let session = bambu_session(&mocks, &bambu_config(&mocks)).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(session.snapshot().await.unwrap().is_none());
    let mut s = session.stream().await.unwrap().expect("a stream");
    let frames = take(&mut s, 12).await;
    let key = frames.iter().find(|f| f.key).expect("a key frame");
    assert_eq!(
        nal_types(&key.data)[..2],
        [7, 8],
        "SPS and PPS go with the key frame"
    );
    let state = mocks.state().await;
    assert!(
        !state["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l == "camera 6000 connect"),
        "{state}"
    );
}

// The H2D camera checks its Digest login as live555 does: quoted fields from the start, `uri` the
// request line's URI exactly. The same login works when the challenge offers qop. A camera that
// turns the login down says so, and not that liveview is off.
#[tokio::test]
async fn bambu_h2d_camera_login_as_a_strict_digest_server_checks_it() {
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", serde_json::json!({ "model": "O1D" }))
        .await;
    let session = bambu_session(&mocks, &bambu_config(&mocks)).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let mut s = session.stream().await.unwrap().expect("a stream, live555 style");
    take(&mut s, 2).await;
    drop(s);

    mocks
        .control("/bambu", serde_json::json!({ "digestQop": true }))
        .await;
    let mut s = session.stream().await.unwrap().expect("a stream, qop=auth");
    take(&mut s, 2).await;
    drop(s);

    mocks
        .control("/bambu", serde_json::json!({ "cameraCode": "87654321" }))
        .await;
    let Err(e) = session.stream().await else {
        panic!("the camera wants another code")
    };
    assert_eq!(
        e.to_string(),
        "The printer refused the camera login. Check the access code."
    );
}

// live555 on the H2D plays one session at a time and holds one whose connection dropped without
// TEARDOWN. Closing a stream sends TEARDOWN, so the next one starts at once instead of being
// refused (rc12: about one still in three).
#[tokio::test]
async fn closing_an_h2d_stream_frees_the_camera_for_the_next_one() {
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", serde_json::json!({ "model": "O1D" }))
        .await;
    let session = bambu_session(&mocks, &bambu_config(&mocks)).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    for _ in 0..3 {
        let mut s = session.stream().await.unwrap().expect("a stream");
        take(&mut s, 2).await;
        drop(s);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let log: Vec<String> = mocks.state().await["log"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .filter(|l| l.starts_with("rtsp PLAY") || l.starts_with("rtsp TEARDOWN"))
        .collect();
    assert_eq!(
        log,
        [
            "rtsp PLAY ok",
            "rtsp TEARDOWN ok",
            "rtsp PLAY ok",
            "rtsp TEARDOWN ok",
            "rtsp PLAY ok",
            "rtsp TEARDOWN ok"
        ]
    );
}

// live555 on the H2D sometimes drops a new session at PLAY just after the last one ended (rc13).
// The driver reports that as a timeout, which the bridge's camera feed tries again for a live
// view; the next open gets in.
#[tokio::test]
async fn a_dropped_play_is_a_timeout_worth_trying_again() {
    let mocks = Mocks::start("bambu", &[]).await;
    mocks
        .control("/bambu", serde_json::json!({ "model": "O1D", "dropPlays": 1 }))
        .await;
    let session = bambu_session(&mocks, &bambu_config(&mocks)).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let Err(e) = session.stream().await else {
        panic!("the first PLAY is dropped")
    };
    assert_eq!(e.code(), sx_connect::ErrorCode::Timeout);
    let mut s = session.stream().await.unwrap().expect("the next one starts");
    take(&mut s, 2).await;
}

#[tokio::test]
async fn a_generic_rtsp_camera_streams_with_a_basic_login_kept_out_of_the_url() {
    let mocks = Mocks::start("rtsp-camera", &[]).await;
    let port = mocks.port("rtsp-camera");
    let mut cfg = config("cam", "moonraker", 0);
    cfg.camera_url = Some(format!("rtsp://127.0.0.1:{port}/live"));
    cfg.camera_credential_ref = Some("cam-login".to_owned());
    let good = secrets(&[("cam-login", "cam:cam-pass".to_owned())]);
    let mut s = camera::open_url(&cfg, &good).await.expect("a stream");
    let frames = take(&mut s, 3).await;
    assert!(frames.iter().all(|f| f.kind == FrameKind::H264));
    assert!(frames.first().unwrap().key);

    let bad = secrets(&[("cam-login", "cam:nope".to_owned())]);
    assert!(camera::open_url(&cfg, &bad).await.is_none());
    assert!(
        camera::open_url(&cfg, &secrets(&[])).await.is_none(),
        "no login, no stream"
    );

    // A login inside the URL is refused, and so is a path the camera does not have.
    cfg.camera_url = Some(format!("rtsp://cam:cam-pass@127.0.0.1:{port}/live"));
    assert!(camera::open_url(&cfg, &good).await.is_none());
    cfg.camera_url = Some(format!("rtsp://127.0.0.1:{port}/other"));
    assert!(camera::open_url(&cfg, &good).await.is_none());
    cfg.camera_url = None;
    assert!(camera::open_url(&cfg, &good).await.is_none());
}

#[tokio::test]
async fn an_http_camera_url_streams_mjpeg() {
    let mocks = Mocks::start("moonraker", &[]).await;
    let port = mocks.port("moonraker");
    let mut cfg = config("cam", "moonraker", 0);
    cfg.camera_url = Some(format!("http://127.0.0.1:{port}/webcam/stream"));
    let mut s = camera::open_url(&cfg, &secrets(&[])).await.expect("a stream");
    assert!(take(&mut s, 3).await.iter().all(is_jpeg));
    cfg.camera_url = Some(format!("http://user:pw@127.0.0.1:{port}/webcam/stream"));
    assert!(camera::open_url(&cfg, &secrets(&[])).await.is_none());
}

const OFFER: &str = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=recvonly\r\n";

#[tokio::test]
async fn webrtc_offers_reach_crowsnest_whep_and_the_creality_k2() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("moonraker", &["--camera"]).await;
    let port = mocks.port("moonraker");

    // The first WebRTC webcam in Moonraker's list is camera-streamer.
    let cfg = config("bay-x", "moonraker", port);
    let session = MoonrakerConnector::new(gate.clone())
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    let answer = session.webrtc_offer(OFFER).await.unwrap().expect("an answer");
    assert!(
        answer.starts_with("v=0") && answer.contains("sx-mock-answer:camerastreamer"),
        "{answer}"
    );

    // A Creality K2 speaks the base64 flow on its own port, whatever Moonraker lists.
    let mut k2 = config("k2", "creality", port);
    k2.protocol = Some("moonraker".to_owned());
    k2.camera_port = Some(port);
    let session = CrealityConnector::new(gate)
        .connect(&k2, &secrets(&[]))
        .await
        .unwrap();
    let answer = session.webrtc_offer(OFFER).await.unwrap().expect("an answer");
    assert!(answer.contains("sx-mock-answer:creality"), "{answer}");
    // Junk is never sent on.
    assert!(session.webrtc_offer("hello").await.unwrap().is_none());

    // WHEP as mediamtx and go2rtc serve it.
    let whep = camera::Signaling::Whep(format!("http://127.0.0.1:{port}/webcam/whep"));
    let a = camera::webrtc_answer(&cfg, &whep, OFFER).await.unwrap();
    assert!(a.contains("sx-mock-answer:whep"));
    let dead = camera::Signaling::Whep("http://127.0.0.1:1/x".to_owned());
    assert!(camera::webrtc_answer(&cfg, &dead, OFFER).await.is_none());
}

#[tokio::test]
async fn a_printer_with_no_webrtc_camera_gives_no_answer() {
    let gate = Arc::new(MemoryGate::new());
    // OctoPrint has no WebRTC service to hand an offer to.
    let mocks = Mocks::start("octoprint", &["--camera"]).await;
    let cfg = config("bay-x", "octoprint", mocks.port("octoprint"));
    let session = OctoPrintConnector::new(gate)
        .connect(&cfg, &secrets(&[]))
        .await
        .unwrap();
    assert!(session.webrtc_offer(OFFER).await.unwrap().is_none());
}

#[tokio::test]
async fn an_onvif_camera_hands_over_its_rtsp_stream_and_the_login_stays_out_of_the_url() {
    let mocks = Mocks::start("rtsp-camera", &[]).await;
    let mut cfg = config("cam", "moonraker", 0);
    cfg.camera_url = Some(format!("onvif://127.0.0.1:{}", mocks.port("onvif")));
    cfg.camera_credential_ref = Some("cam-login".to_owned());
    let good = secrets(&[("cam-login", "cam:cam-pass".to_owned())]);
    // The camera reports 10.9.9.9 in its stream address; the connector plays it from where it reached the camera.
    let mut s = camera::open_url(&cfg, &good).await.expect("a stream");
    let frames = take(&mut s, 3).await;
    assert!(frames.iter().all(|f| f.kind == FrameKind::H264));
    assert!(frames.first().unwrap().key);
    drop(s);

    // A wrong password fails at the ONVIF login, before any stream is asked for.
    let bad = secrets(&[("cam-login", "cam:nope".to_owned())]);
    assert!(camera::open_url(&cfg, &bad).await.is_none());
    assert!(camera::open_url(&cfg, &secrets(&[])).await.is_none());
    cfg.camera_url = Some("onvif://cam:pw@127.0.0.1/".to_owned());
    assert!(camera::open_url(&cfg, &good).await.is_none());

    // A camera with no login needs none.
    cfg.camera_url = Some(format!("onvif://127.0.0.1:{}", mocks.port("onvif-open")));
    cfg.camera_credential_ref = None;
    let mut s = camera::open_url(&cfg, &secrets(&[])).await;
    assert!(s.is_some());
    assert!(
        take(s.as_mut().unwrap(), 2)
            .await
            .iter()
            .all(|f| f.kind == FrameKind::H264)
    );
}

#[tokio::test]
async fn ws_discovery_finds_an_onvif_camera() {
    let mocks = Mocks::start("rtsp-camera", &[]).await;
    let target = std::net::SocketAddr::from(([127, 0, 0, 1], mocks.port("onvif-discovery")));
    let found = sx_connect::onvif::discover(target, Duration::from_millis(600)).await;
    assert_eq!(found.len(), 1, "{found:?}");
    let c = found.first().unwrap();
    assert_eq!((c.host.as_str(), c.port), ("127.0.0.1", mocks.port("onvif-open")));
    assert_eq!(c.name.as_deref(), Some("Mock Cam"));
    assert_eq!(c.hardware.as_deref(), Some("SX-1"));
    // Nobody home: an empty list, not an error.
    let closed = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let dead = closed.local_addr().unwrap();
    assert!(
        sx_connect::onvif::discover(dead, Duration::from_millis(300))
            .await
            .is_empty()
    );
}
