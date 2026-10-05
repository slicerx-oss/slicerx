// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Shared harness: starts `@slicerx/mock-printers` as a child process and runs the driver
//! contract suite against a session.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_lines,
    clippy::format_collect
)]
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sx_connect::params;
use sx_connect::{
    Action, Capability, Error, ErrorCode, JobFile, JobKind, MemoryGate, PrinterConfig, PrinterEvent,
    PrinterSession, PrinterState, RemoteFile, Secrets, StartOptions,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

pub struct Mocks {
    _child: Child,
    _stdin: ChildStdin,
    pub info: Value,
}

impl Mocks {
    /// `only` limits which fakes start; `extra` are more CLI flags such as `--auth`.
    pub async fn start(only: &str, extra: &[&str]) -> Mocks {
        // The sx-connect crate root holds mock-printers/; sx-link's tests run from link/.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let script = [
            root.join("mock-printers/src/cli.ts"),
            root.join("../mock-printers/src/cli.ts"),
        ]
        .into_iter()
        .find(|p| p.exists())
        .expect("mock-printers/src/cli.ts");
        let mut child = Command::new("node")
            .arg(script)
            .args(["--only", only, "--state", "idle"])
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("node must be on PATH to run the mock printers");
        let stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        Mocks {
            _child: child,
            _stdin: stdin,
            info: serde_json::from_str(&line).unwrap(),
        }
    }

    pub fn port(&self, name: &str) -> u16 {
        u16::try_from(self.info["ports"][name].as_u64().unwrap()).unwrap()
    }

    pub fn str(&self, key: &str) -> String {
        self.info[key].as_str().unwrap().to_owned()
    }

    /// State, uploaded files and request log of every running fake.
    pub async fn state(&self) -> Value {
        // A bare HTTP/1.0 GET keeps the harness free of a TLS provider.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut sock = tokio::net::TcpStream::connect((
            "127.0.0.1",
            u16::try_from(self.info["control"].as_u64().unwrap()).unwrap(),
        ))
        .await
        .unwrap();
        sock.write_all(b"GET /state HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8(raw).unwrap();
        serde_json::from_str(text.split_once("\r\n\r\n").unwrap().1).unwrap()
    }
}

impl Mocks {
    /// Offers a delivery to the cloud fake (`--only cloud`). Returns its id.
    pub async fn offer(&self, spec: Value) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let body = spec.to_string();
        let port = u16::try_from(self.info["control"].as_u64().unwrap()).unwrap();
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "POST /cloud/offer HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8(raw).unwrap();
        let v: Value = serde_json::from_str(text.split_once("\r\n\r\n").unwrap().1).unwrap();
        v["id"].as_str().unwrap().to_owned()
    }

    /// Moves one fake printer to `state` (`finished`, `error`, `idle`, `printing`), as if its job
    /// ended on its own.
    /// Changes a stored file on a fake printer behind the hub's back: new content, size and time.
    pub async fn replace_file(&self, mock: &str, name: &str) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let body = serde_json::json!({ "mock": mock, "name": name }).to_string();
        let port = u16::try_from(self.info["control"].as_u64().unwrap()).unwrap();
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "POST /replace HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.unwrap();
        assert!(
            String::from_utf8_lossy(&raw).contains(" 200"),
            "replace_file failed"
        );
    }

    /// Sets where a fake printer's head is, which axes are homed, and how many `G90` lines it
    /// refuses next (`/motion`).
    pub async fn set_motion(&self, mock: &str, spec: Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut body = spec;
        body["mock"] = serde_json::json!(mock);
        let body = body.to_string();
        let port = u16::try_from(self.info["control"].as_u64().unwrap()).unwrap();
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "POST /motion HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.unwrap();
        assert!(
            String::from_utf8_lossy(&raw).contains(" 200"),
            "set_motion failed"
        );
    }

    /// Posts `body` to a control path of the fakes (`/bambu`, for example) and returns the answer.
    #[allow(dead_code)] // Each test binary compiles this module; not all of them use it.
    pub async fn control(&self, path: &str, body: Value) -> Value {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let body = body.to_string();
        let port = u16::try_from(self.info["control"].as_u64().unwrap()).unwrap();
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "POST {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.contains(" 200"), "{path} failed: {text}");
        serde_json::from_str(text.split("\r\n\r\n").nth(1).unwrap_or("null")).unwrap_or(Value::Null)
    }

    /// Makes a fake printer's uploads take `ms` milliseconds before the file lands (`/slow`).
    pub async fn set_upload_delay(&self, mock: &str, ms: u64) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let body = serde_json::json!({ "mock": mock, "uploadMs": ms }).to_string();
        let port = u16::try_from(self.info["control"].as_u64().unwrap()).unwrap();
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "POST /slow HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.unwrap();
        assert!(
            String::from_utf8_lossy(&raw).contains(" 200"),
            "set_upload_delay failed"
        );
    }

    pub async fn set_state(&self, mock: &str, state: &str) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let body = serde_json::json!({ "mock": mock, "state": state }).to_string();
        let port = u16::try_from(self.info["control"].as_u64().unwrap()).unwrap();
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "POST /set HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        sock.read_to_end(&mut raw).await.unwrap();
        assert!(
            String::from_utf8_lossy(&raw).starts_with("HTTP/1.1 200")
                || String::from_utf8_lossy(&raw).starts_with("HTTP/1.0 200"),
            "set_state failed"
        );
    }

    /// Waits until the shared request log has a line containing `needle`.
    pub async fn wait_log(&self, needle: &str) -> Vec<String> {
        for _ in 0..200 {
            let log: Vec<String> = self.state().await["log"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|l| l.as_str().map(str::to_owned))
                .collect();
            if log.iter().any(|l| l.contains(needle)) {
                return log;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "the log never contained {needle:?}: {:?}",
            self.state().await["log"]
        );
    }
}

pub struct MapSecrets(pub HashMap<String, String>);

impl Secrets for MapSecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

pub fn secrets(pairs: &[(&str, String)]) -> MapSecrets {
    MapSecrets(pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect())
}

pub fn config(id: &str, plugin: &str, port: u16) -> PrinterConfig {
    PrinterConfig {
        id: id.to_owned(),
        name: id.to_owned(),
        plugin: plugin.to_owned(),
        host: "127.0.0.1".to_owned(),
        port: Some(port),
        credential_ref: None,
        serial: None,
        tls: None,
        poll_ms: Some(50),
        ftp_port: None,
        camera_port: None,
        ws_port: None,
        http_port: None,
        protocol: None,
        username: None,
        camera_url: None,
        camera_credential_ref: None,
        rtsp_port: None,
    }
}

pub fn job_file(name: &str, kind: JobKind) -> JobFile {
    let data: Vec<u8> = (0..4096_u32).map(|i| u8::try_from(i % 251).unwrap()).collect();
    let sha256 = Sha256::digest(&data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    JobFile {
        name: name.to_owned(),
        kind,
        data,
        sha256,
    }
}

pub async fn wait_state(s: &dyn PrinterSession, want: PrinterState) {
    for _ in 0..100 {
        if s.status().await.map(|st| st.state).ok() == Some(want) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("printer never reached {want}, last status {:?}", s.status().await);
}

pub fn expect_code<T>(r: Result<T, Error>, code: ErrorCode) {
    match r {
        Err(e) if e.code() == code => {}
        Err(e) => panic!("expected {code:?}, got error {e}"),
        Ok(_) => panic!("expected {code:?}, got Ok"),
    }
}

pub struct Case<'a> {
    pub mocks: &'a Mocks,
    /// Key in the mock's control state, such as `moonraker`.
    pub mock: &'a str,
    pub id: &'a str,
    pub file: JobFile,
    pub start: StartOptions,
    pub gate: Arc<MemoryGate>,
    pub camera: bool,
    pub gcode: bool,
}

/// The contract every driver must meet: status, events, upload, start, pause, resume, cancel,
/// approval tokens required and bound, G-code and camera as the driver declares them.
pub async fn run_contract(s: &dyn PrinterSession, c: &Case<'_>) {
    let caps = s.capabilities();
    for need in [
        Capability::Status,
        Capability::Events,
        Capability::Upload,
        Capability::Start,
        Capability::Pause,
        Capability::Resume,
        Capability::Cancel,
    ] {
        assert!(caps.contains(&need), "{need:?} missing");
    }
    let bad = sx_connect::ApprovalToken {
        request_id: String::new(),
        token: String::new(),
        expires_at: String::new(),
    };
    let forged = sx_connect::ApprovalToken {
        request_id: "x".into(),
        token: "forged".into(),
        expires_at: String::new(),
    };
    let remote = RemoteFile {
        printer_id: c.id.to_owned(),
        path: c.file.name.clone(),
        name: c.file.name.clone(),
        sha256: None,
    };

    // Status and events.
    let st = s.status().await.unwrap();
    assert_eq!(st.printer_id, c.id);
    assert_eq!(st.state, PrinterState::Idle);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let mut events = s.events();
    let handle = tokio::spawn(async move {
        while let Some(e) = events.next().await {
            if tx.send(e).is_err() {
                break;
            }
        }
    });
    match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
        Ok(Some(PrinterEvent::Status { status })) => assert_eq!(status.printer_id, c.id),
        other => panic!("first event should be a status, got {other:?}"),
    }

    // No token, forged token, wrong action, wrong printer: nothing may reach the printer.
    let before = c.mocks.state().await;
    expect_code(s.upload(c.file.clone(), &bad).await, ErrorCode::ApprovalRequired);
    expect_code(
        s.upload(c.file.clone(), &forged).await,
        ErrorCode::ApprovalInvalid,
    );
    expect_code(
        s.start(&remote, c.start.clone(), &forged).await,
        ErrorCode::ApprovalInvalid,
    );
    expect_code(s.pause(&forged).await, ErrorCode::ApprovalInvalid);
    expect_code(s.resume(&forged).await, ErrorCode::ApprovalInvalid);
    expect_code(s.cancel(&forged).await, ErrorCode::ApprovalInvalid);
    expect_code(
        s.send_gcode("M105", &forged).await,
        if c.gcode {
            ErrorCode::ApprovalInvalid
        } else {
            ErrorCode::NotSupported
        },
    );
    let wrong_printer = c.gate.mint(
        Action::Upload,
        "some-other-printer",
        &params::upload("some-other-printer", &c.file.name, &c.file.sha256),
    );
    expect_code(
        s.upload(c.file.clone(), &wrong_printer).await,
        ErrorCode::ApprovalInvalid,
    );
    let wrong_action = c
        .gate
        .mint(Action::Start, c.id, &params::start(c.id, &remote, &c.start));
    expect_code(
        s.upload(c.file.clone(), &wrong_action).await,
        ErrorCode::ApprovalInvalid,
    );
    let wrong_params = c.gate.mint(
        Action::Upload,
        c.id,
        &params::upload(c.id, &c.file.name, "not-the-hash"),
    );
    expect_code(
        s.upload(c.file.clone(), &wrong_params).await,
        ErrorCode::ApprovalInvalid,
    );
    assert_eq!(
        c.mocks.state().await[c.mock],
        before[c.mock],
        "a rejected call must not change the printer"
    );

    // Pausing an idle printer is a state error, not a crash.
    let t = c.gate.mint(Action::Pause, c.id, &params::printer(c.id));
    expect_code(s.pause(&t).await, ErrorCode::BadState);

    // Upload: the printer receives the exact bytes.
    let t = c.gate.mint(
        Action::Upload,
        c.id,
        &params::upload(c.id, &c.file.name, &c.file.sha256),
    );
    let rf = s.upload(c.file.clone(), &t).await.unwrap();
    assert_eq!(rf.printer_id, c.id);
    let state = c.mocks.state().await;
    let files = state[c.mock]["files"].as_array().unwrap();
    assert!(
        files.iter().any(|f| f["sha256"] == c.file.sha256.as_str()),
        "uploaded hash not found: {files:?}"
    );
    // Reusing the same token fails.
    expect_code(s.upload(c.file.clone(), &t).await, ErrorCode::ApprovalInvalid);

    // A start without a slot map is a driver that cannot make the printer follow one (every
    // case but Bambu's .gcode.3mf). Even an approved start with a map is refused before the
    // printer hears anything, and the refusal does not spend the token.
    if !c.start.has_slot_map() {
        let mapped = StartOptions {
            slot_map: Some([(0, "A1".to_owned())].into_iter().collect()),
            ..c.start.clone()
        };
        let t = c
            .gate
            .mint(Action::Start, c.id, &params::start(c.id, &rf, &mapped));
        let before = c.mocks.state().await;
        expect_code(s.start(&rf, mapped.clone(), &t).await, ErrorCode::NotSupported);
        assert_eq!(
            c.mocks.state().await[c.mock],
            before[c.mock],
            "a refused slot map must not change the printer"
        );
    }

    // Start, pause, resume, cancel.
    let t = c
        .gate
        .mint(Action::Start, c.id, &params::start(c.id, &rf, &c.start));
    s.start(&rf, c.start.clone(), &t).await.unwrap();
    expect_code(
        s.start(&rf, c.start.clone(), &t).await,
        ErrorCode::ApprovalInvalid,
    );
    wait_state(s, PrinterState::Printing).await;
    let st = s.status().await.unwrap();
    assert_eq!(
        st.job_name.as_deref().map(|n| n.trim_start_matches("0:/gcodes/")),
        Some(c.file.name.as_str())
    );

    s.pause(&c.gate.mint(Action::Pause, c.id, &params::printer(c.id)))
        .await
        .unwrap();
    wait_state(s, PrinterState::Paused).await;
    s.resume(&c.gate.mint(Action::Resume, c.id, &params::printer(c.id)))
        .await
        .unwrap();
    wait_state(s, PrinterState::Printing).await;

    if c.gcode {
        s.send_gcode(
            "M105",
            &c.gate.mint(Action::Gcode, c.id, &params::gcode(c.id, "M105")),
        )
        .await
        .unwrap();
        // Sending returns once the command is on its way; the mock logs it when it arrives.
        let mut arrived = false;
        for _ in 0..100 {
            let log = c.mocks.state().await;
            if log[c.mock]["log"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l.as_str() == Some("gcode M105"))
            {
                arrived = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(arrived, "the printer did not get M105");
    } else {
        expect_code(
            s.send_gcode(
                "M105",
                &c.gate.mint(Action::Gcode, c.id, &params::gcode(c.id, "M105")),
            )
            .await,
            ErrorCode::NotSupported,
        );
    }

    // Polling drivers need to see the job running before they can see it end.
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.cancel(&c.gate.mint(Action::Cancel, c.id, &params::printer(c.id)))
        .await
        .unwrap();
    wait_state(s, PrinterState::Idle).await;

    // The event stream saw the job end.
    let mut finished = false;
    let mut seen = Vec::new();
    while let Ok(Some(e)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
        if let PrinterEvent::Status { status } = &e {
            seen.push(status.state.to_string());
        }
        if let PrinterEvent::JobFinished { ok, .. } = e {
            assert!(!ok, "a canceled job is not ok");
            finished = true;
            break;
        }
    }
    assert!(
        finished,
        "no job_finished event after cancel; states seen: {seen:?}; task finished: {}",
        handle.is_finished()
    );

    // Camera.
    let snap = s.snapshot().await.unwrap();
    if c.camera {
        let img = snap.expect("camera printer should return a frame");
        assert!(img.data.starts_with(&[0xff, 0xd8]));
    } else {
        assert!(snap.is_none());
    }
}
