// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Creality printers on stock firmware, over the interface Creality Print uses: telemetry pushed
//! over a WebSocket on port 9999, uploads by HTTP `POST /upload/<name>`, an MJPEG camera on port
//! 8080. See README.md for sources and what is untested on hardware.
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};

use crate::PrinterSession;
use crate::camera;
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http;
use crate::push::PushState;
use crate::types::{
    Capabilities, Capability, FilamentSlot, Image, JobFile, PrinterConfig, PrinterEvent, PrinterState,
    PrinterStatus, RemoteFile, StartOptions, Temp, now_iso, secs,
};
use crate::wslink::{OnLink, OnText, WsLink, WsLinkSpec};

/// The frame that asks the printer for its full state.
const REQUEST_STATE: &str = r#"{"method":"get","params":{"ReqPrinterPara":1}}"#;

pub(crate) struct NativeSession {
    cfg: PrinterConfig,
    gate: Arc<dyn ApprovalGate>,
    push: Arc<PushState>,
    link: WsLink,
    /// `model` from `GET /info`, empty when the printer did not answer.
    model: String,
}

impl NativeSession {
    pub(crate) async fn open(
        cfg: &PrinterConfig,
        gate: Arc<dyn ApprovalGate>,
    ) -> Result<Box<dyn PrinterSession>> {
        let push = Arc::new(PushState::new(&cfg.id, parse_status));
        let spec = WsLinkSpec {
            url: format!("ws://{}:{}/", cfg.host, cfg.ws_port.unwrap_or(9999)),
            // The printer's own web UI offers this subprotocol; matching it keeps the handshake identical.
            subprotocol: Some("wsslicer"),
            greeting: Arc::new(|| vec![REQUEST_STATE.to_owned()]),
            keepalive: Some((Duration::from_secs(10), REQUEST_STATE.to_owned())),
        };
        let on_text: OnText = {
            let push = push.clone();
            Arc::new(move |text| {
                // The printer sends its heartbeat as JSON and expects the bare text `ok` back.
                if text == "ok" {
                    return None;
                }
                let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) else {
                    return None;
                };
                if obj.get("ModeCode").and_then(Value::as_str) == Some("heart_beat") {
                    return Some("ok".to_owned());
                }
                push.merge(&obj);
                None
            })
        };
        let on_link: OnLink = {
            let push = push.clone();
            Arc::new(move |up| push.set_link(up))
        };
        let link = WsLink::start(&cfg.id, spec, on_text, on_link).await?;
        if !push.first_state(Duration::from_secs(8)).await {
            return Err(Error::protocol(&cfg.id, "no telemetry after connecting"));
        }
        let model = fetch_model(cfg).await.unwrap_or_default();
        Ok(Box::new(NativeSession {
            cfg: cfg.clone(),
            gate,
            push,
            link,
            model,
        }))
    }

    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn model(&self) -> String {
        if !self.model.is_empty() {
            return self.model.clone();
        }
        // Without `/info`, the telemetry carries the model too.
        self.push
            .value("model")
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    fn send(&self, params: &Value) -> Result<()> {
        if !self.push.is_connected() {
            return Err(Error::unreachable(self.id(), "WebSocket connection is down"));
        }
        self.link
            .out
            .send(json!({ "method": "set", "params": params }).to_string())
            .map_err(|_| Error::unreachable(self.id(), "connection closed"))
    }

    fn require(&self, action: &str, ok: &[PrinterState]) -> Result<()> {
        let s = self.push.snapshot().state;
        if s == PrinterState::Offline {
            return Err(Error::unreachable(self.id(), "connection is down"));
        }
        if ok.contains(&s) {
            Ok(())
        } else {
            Err(Error::BadState {
                printer: self.id().to_owned(),
                state: s.to_string(),
                action: action.to_owned(),
            })
        }
    }
}

async fn fetch_model(cfg: &PrinterConfig) -> Option<String> {
    let client = http::client(cfg).ok()?;
    let url = format!("http://{}:{}/info", cfg.host, cfg.http_port.unwrap_or(80));
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .ok()?;
    let v: Value = resp.json().await.ok()?;
    v.get("model").and_then(Value::as_str).map(str::to_owned)
}

/// K1, K1C, K1 Max and K1 SE keep G-code under `/usr/data`; other models under `/mnt/UDISK`.
fn data_root(model: &str) -> &'static str {
    if model.to_ascii_uppercase().contains("K1") {
        "/usr/data"
    } else {
        "/mnt/UDISK"
    }
}

/// K2 family model codes (F008, F012, F021) and names.
fn is_k2(model: &str) -> bool {
    let m = model.to_ascii_uppercase();
    m.contains("K2") || ["F008", "F012", "F021"].iter().any(|c| m.contains(c))
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        // The printer sometimes sends numbers as strings.
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Maps merged telemetry to the normalized status.
pub(crate) fn parse_status(id: &str, t: &Value) -> PrinterStatus {
    let get = |k: &str| t.get(k);
    let errcode = t.get("err").map_or(0.0, |e| {
        num(e.get("errcode")).or_else(|| num(Some(e))).unwrap_or(0.0)
    });
    let self_test = num(get("withSelfTest")).unwrap_or(0.0);
    let file = get("printFileName")
        .and_then(Value::as_str)
        .filter(|f| !f.is_empty());
    let progress = num(get("printProgress")).or_else(|| num(get("dProgress")));
    let code = num(get("state"));
    let state = if errcode != 0.0 {
        PrinterState::Error
    } else if (1.0..=99.0).contains(&self_test) {
        PrinterState::Preparing
    } else if file.is_some() {
        if progress.is_some_and(|p| p >= 100.0) {
            PrinterState::Finished
        } else {
            match code {
                Some(5.0) => PrinterState::Paused,
                Some(1.0) => PrinterState::Printing,
                Some(0.0) => PrinterState::Preparing,
                // 4 is a stopped job; anything else reads as idle.
                _ => PrinterState::Idle,
            }
        }
    } else {
        PrinterState::Idle
    };
    let active = matches!(
        state,
        PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing | PrinterState::Finished
    );
    let temp = |cur: &str, tgt: &str| {
        num(get(cur)).map(|c| Temp {
            current: c,
            target: num(get(tgt)).unwrap_or(0.0),
        })
    };
    let model = get("model").and_then(Value::as_str).unwrap_or("");
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: file
            .filter(|_| active)
            .map(|f| f.rsplit('/').next().unwrap_or(f).to_owned()),
        progress: progress.filter(|_| active).map(|p| (p / 100.0).clamp(0.0, 1.0)),
        layer: num(get("layer"))
            .filter(|_| active)
            .map(|l| u32::try_from(secs(l)).unwrap_or(0)),
        layer_count: num(get("TotalLayer"))
            .filter(|_| active)
            .map(|l| u32::try_from(secs(l)).unwrap_or(0)),
        time_left_s: num(get("printLeftTime")).filter(|_| active).map(secs),
        nozzles: temp("nozzleTemp", "targetNozzleTemp").into_iter().collect(),
        bed: temp("bedTemp0", "targetBedTemp0").or_else(|| temp("bedTemp", "targetBedTemp")),
        chamber: temp("boxTemp", "targetBoxTemp"),
        slots: Vec::<FilamentSlot>::new(),
        camera_available: !is_k2(model),
        message: (errcode != 0.0).then(|| format!("Printer error {errcode}")),
        updated_at: now_iso(),
        live: None,
    }
}

#[async_trait]
impl PrinterSession for NativeSession {
    fn capabilities(&self) -> Capabilities {
        let mut c = vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::GcodeConsole,
        ];
        if !is_k2(&self.model()) {
            c.push(Capability::Camera);
        }
        c
    }

    async fn status(&self) -> Result<PrinterStatus> {
        Ok(self.push.snapshot())
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        self.push.events()
    }

    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.gate.check(
            token,
            Action::Upload,
            self.id(),
            &params::upload(self.id(), &file.name, &file.sha256),
        )?;
        // The printer's own tools replace spaces the same way.
        let name = file.name.replace(' ', "_");
        if name.contains(['/', '\\']) || name.is_empty() {
            return Err(Error::protocol(self.id(), "unsafe file name"));
        }
        let client = http::client(&self.cfg)?;
        let url = format!(
            "http://{}:{}/upload/{}",
            self.cfg.host,
            self.cfg.http_port.unwrap_or(80),
            http::seg(&name)
        );
        let mut form = Form::new();
        // Models before the K2 platform expect the target folder as a form field.
        if !is_k2(&self.model()) {
            form = form.text("path", "");
        }
        form = form.part("file", Part::bytes(file.data.clone()).file_name(name.clone()));
        http::send(self.id(), client.post(url).multipart(form)).await?;
        Ok(RemoteFile {
            printer_id: self.id().to_owned(),
            path: name.clone(),
            name,
            sha256: Some(file.sha256.clone()),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("creality")?;
        self.gate.check(
            token,
            Action::Start,
            self.id(),
            &params::start(self.id(), file, &opts),
        )?;
        self.require(
            "start a job",
            &[PrinterState::Idle, PrinterState::Finished, PrinterState::Error],
        )?;
        if file.path.contains(['/', '\\', '\r', '\n']) {
            return Err(Error::protocol(self.id(), "unsafe file path"));
        }
        let path = format!("{}/printer_data/gcodes/{}", data_root(&self.model()), file.path);
        self.send(&json!({ "opGcodeFile": format!("printprt:{path}") }))
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Pause, self.id(), &params::printer(self.id()))?;
        self.require("pause", &[PrinterState::Printing])?;
        self.send(&json!({ "pause": 1 }))
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Resume, self.id(), &params::printer(self.id()))?;
        self.require("resume", &[PrinterState::Paused])?;
        self.send(&json!({ "pause": 0 }))
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Cancel, self.id(), &params::printer(self.id()))?;
        self.require(
            "cancel",
            &[
                PrinterState::Printing,
                PrinterState::Paused,
                PrinterState::Preparing,
            ],
        )?;
        self.send(&json!({ "stop": 1 }))
    }

    /// First frame of the MJPEG stream on port 8080. K2 printers stream WebRTC instead and answer `None`.
    async fn stream(&self) -> Result<Option<camera::FrameStream>> {
        if is_k2(&self.model()) {
            return Ok(None);
        }
        let client = http::client(&self.cfg)?;
        let url = format!(
            "http://{}:{}/?action=stream",
            self.cfg.host,
            self.cfg.camera_port.unwrap_or(8080)
        );
        Ok(camera::mjpeg_stream(&client, &url).await)
    }

    async fn snapshot(&self) -> Result<Option<Image>> {
        if is_k2(&self.model()) {
            return Ok(None);
        }
        let client = http::client(&self.cfg)?;
        let url = format!(
            "http://{}:{}/?action=stream",
            self.cfg.host,
            self.cfg.camera_port.unwrap_or(8080)
        );
        Ok(http::mjpeg_frame(&client, &url).await)
    }

    async fn send_gcode(&self, line: &str, token: &ApprovalToken) -> Result<()> {
        // One command per call: a card showed this line whole, and nothing may ride behind it.
        crate::gate::one_gcode_line(self.id(), line)?;
        self.gate
            .check(token, Action::Gcode, self.id(), &params::gcode(self.id(), line))?;
        self.send(&json!({ "gcodeCmd": line }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_mapping() {
        let t = |v: Value| parse_status("x", &v);
        assert_eq!(t(json!({ "state": 0 })).state, PrinterState::Idle);
        assert_eq!(t(json!({ "state": 1, "printFileName": "/usr/data/printer_data/gcodes/a.gcode", "printProgress": 10 })).state, PrinterState::Printing);
        assert_eq!(
            t(json!({ "state": 5, "printFileName": "a.gcode", "printProgress": 10 })).state,
            PrinterState::Paused
        );
        assert_eq!(
            t(json!({ "state": 0, "printFileName": "a.gcode", "printProgress": 100 })).state,
            PrinterState::Finished
        );
        assert_eq!(
            t(json!({ "state": 4, "printFileName": "a.gcode", "printProgress": 40 })).state,
            PrinterState::Idle
        );
        assert_eq!(t(json!({ "withSelfTest": 30 })).state, PrinterState::Preparing);
        assert_eq!(t(json!({ "err": { "errcode": 12 } })).state, PrinterState::Error);
        let s = t(
            json!({ "state": 1, "printFileName": "/x/a.gcode", "printProgress": "42", "nozzleTemp": "219.5", "targetNozzleTemp": 220, "bedTemp0": 60, "boxTemp": 35, "layer": 10, "TotalLayer": 100, "printLeftTime": 600 }),
        );
        assert_eq!(s.job_name.as_deref(), Some("a.gcode"));
        assert_eq!(s.progress, Some(0.42));
        assert_eq!(s.nozzles.first().map(|n| n.current), Some(219.5));
        assert_eq!(s.chamber.map(|c| c.current), Some(35.0));
        assert_eq!(s.time_left_s, Some(600));
    }

    #[test]
    fn model_families() {
        assert_eq!(data_root("CR-K1 Max"), "/usr/data");
        assert_eq!(data_root("K1C"), "/usr/data");
        assert_eq!(data_root("F008"), "/mnt/UDISK");
        assert!(is_k2("F008") && is_k2("K2 Plus") && !is_k2("F001"));
    }
}
