// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Creality printers on stock firmware, over the interface Creality Print uses: telemetry pushed
//! over a WebSocket on port 9999, uploads by HTTP `POST /upload/<name>`, an MJPEG camera on port
//! 8080 or WebRTC on port 8000. See README.md for sources and what is untested on hardware.
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::RequestBuilder;
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};

use crate::PrinterSession;
use crate::camera;
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http;
use crate::push::PushState;
use crate::types::{
    Capabilities, Capability, Fans, FilamentSlot, FilamentUnit, Image, JobFile, Motion, PrinterConfig,
    PrinterEvent, PrinterHardware, PrinterLive, PrinterState, PrinterStatus, RemoteFile, StartOptions, Temp,
    now_iso, secs,
};
use crate::wslink::{OnLink, OnText, WsLink, WsLinkSpec};

/// The frame that asks the printer for its full state.
const REQUEST_STATE: &str = r#"{"method":"get","params":{"ReqPrinterPara":1}}"#;

/// The frame that asks for the CFS boxes (`boxsInfo`), as OrcaSlicer's `query_boxes_info` sends it.
const REQUEST_BOXES: &str = r#"{"method":"get","params":{"boxsInfo":1}}"#;

/// How often the CFS boxes are asked for: the printer sends them only on request.
const BOXES_EVERY: Duration = Duration::from_secs(30);

/// The subprotocol ha_creality_ws offers, as the printer's own web UI does. OrcaSlicer offers none,
/// so a printer that refuses it is asked again without one.
const SUBPROTOCOL: &str = "wsslicer";

pub(crate) struct NativeSession {
    cfg: PrinterConfig,
    gate: Arc<dyn ApprovalGate>,
    push: Arc<PushState>,
    link: WsLink,
    /// `model` from `GET /info`, empty when the printer did not answer.
    model: String,
    /// The key for `Authorization: Bearer`, sent as OrcaSlicer's Creality host sends it.
    key: Option<String>,
    boxes: tokio::task::JoinHandle<()>,
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.boxes.abort();
    }
}

impl NativeSession {
    pub(crate) async fn open(
        cfg: &PrinterConfig,
        key: Option<String>,
        gate: Arc<dyn ApprovalGate>,
    ) -> Result<Box<dyn PrinterSession>> {
        let push = Arc::new(PushState::new(&cfg.id, parse_status));
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
        let spec = |subprotocol| WsLinkSpec {
            url: format!("ws://{}:{}/", cfg.host, cfg.ws_port.unwrap_or(9999)),
            subprotocol,
            greeting: Arc::new(|| vec![REQUEST_STATE.to_owned(), REQUEST_BOXES.to_owned()]),
            keepalive: Some((Duration::from_secs(10), REQUEST_STATE.to_owned())),
        };
        let first = WsLink::start(&cfg.id, spec(Some(SUBPROTOCOL)), on_text.clone(), on_link.clone()).await;
        let link = match first {
            Ok(l) => l,
            Err(_) => WsLink::start(&cfg.id, spec(None), on_text, on_link).await?,
        };
        if !push.first_state(Duration::from_secs(8)).await {
            return Err(Error::protocol(&cfg.id, "no telemetry after connecting"));
        }
        let model = fetch_info(cfg, key.as_deref())
            .await
            .and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        let boxes = {
            let out = link.out.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(BOXES_EVERY);
                tick.reset();
                loop {
                    tick.tick().await;
                    if out.send(REQUEST_BOXES.to_owned()).is_err() {
                        return;
                    }
                }
            })
        };
        Ok(Box::new(NativeSession {
            cfg: cfg.clone(),
            gate,
            push,
            link,
            model,
            key,
            boxes,
        }))
    }

    fn id(&self) -> &str {
        &self.cfg.id
    }

    /// The model as `/info` gives it, else as the telemetry does.
    fn model(&self) -> String {
        if !self.model.is_empty() {
            return self.model.clone();
        }
        self.text("model").unwrap_or_default()
    }

    fn text(&self, key: &str) -> Option<String> {
        self.push
            .value(key)
            .and_then(|v| v.as_str().map(str::trim).map(str::to_owned))
            .filter(|s| !s.is_empty())
    }

    fn uses_webrtc(&self) -> bool {
        uses_webrtc(
            &self.model(),
            &self.text("modelVersion").unwrap_or_default(),
            self.push.value("webrtcSupport").as_ref(),
        )
    }

    fn sign(&self, rb: RequestBuilder) -> RequestBuilder {
        match &self.key {
            Some(k) => rb.bearer_auth(k),
            None => rb,
        }
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

/// `GET /info` on the printer's web port. Only a JSON object counts: a web UI's page (Fluidd on a
/// K2's 4408) is not the printer's answer.
pub(crate) async fn fetch_info(cfg: &PrinterConfig, key: Option<&str>) -> Option<Value> {
    let client = http::client(cfg).ok()?;
    let url = format!("http://{}:{}/info", cfg.host, cfg.http_port.unwrap_or(80));
    let mut rb = client.get(url).timeout(Duration::from_secs(3));
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let v: Value = rb.send().await.ok()?.json().await.ok()?;
    v.is_object().then_some(v)
}

/// Board codes and the models they name, from OrcaSlicer's CrealityPrint model table and
/// ha_creality_ws's model detection.
const BOARD_CODES: [(&str, &str); 8] = [
    ("F001", "Ender-3 V3"),
    ("F002", "Ender-3 V3 Plus"),
    ("F005", "Ender-3 V3 KE"),
    ("F008", "K2 Plus"),
    ("F012", "K2 Pro"),
    ("F018", "Hi"),
    ("F021", "K2"),
    ("F022", "SPARKX i7"),
];

/// The model's name: a board code in `model` or `modelVersion` read through [`BOARD_CODES`], else
/// `model` as the printer gives it (`CR-K1 Max`, `K1C`).
pub(crate) fn model_name(model: &str, model_version: &str) -> Option<String> {
    let code = |s: &str| {
        let up = s.to_ascii_uppercase();
        BOARD_CODES
            .iter()
            .find(|(c, _)| up.contains(c))
            .map(|(_, n)| (*n).to_owned())
    };
    code(model)
        .or_else(|| code(model_version))
        .or_else(|| Some(model.trim().to_owned()).filter(|m| !m.is_empty()))
}

/// The firmware from `modelVersion` (`Printer HW Ver: ...; Printer SW Ver: 1.3.3.46`), the printer's
/// own software version, else the screen's (`DWIN SW Ver`), as ha_creality_ws reads it.
pub(crate) fn firmware(model_version: &str) -> Option<String> {
    let part = |key: &str| {
        model_version.split(';').find_map(|seg| {
            let (k, v) = seg.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case(key)
                .then(|| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        })
    };
    part("printer sw ver").or_else(|| part("dwin sw ver"))
}

/// K1, K1C, K1 Max, K1 SE and K1_CFS-C keep G-code under `/usr/data`; other models under
/// `/mnt/UDISK`, OrcaSlicer's default.
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

/// Models that print several colors from a CFS: OrcaSlicer leaves out the upload's `path` field for
/// exactly these (`model_supports_multi_color`).
fn multi_color(model: &str) -> bool {
    ["F008", "F012", "F021", "F022", "K1", "K1 SE", "K1C", "K1_CFS-C"].contains(&model.trim())
}

/// Whether the camera is WebRTC on port 8000 rather than MJPEG on 8080: every K2, and a K1 whose
/// firmware (1.3.5.22 and later) reports `webrtcSupport` 1.
fn uses_webrtc(model: &str, model_version: &str, webrtc: Option<&Value>) -> bool {
    is_k2(model) || is_k2(model_version) || webrtc.and_then(num) == Some(1.0)
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        // The printer sometimes sends numbers as strings.
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// The CFS boxes of a `boxsInfo` answer, read as OrcaSlicer's `parse_cfs_response` reads them:
/// boxes with `state` 1 and `type` 0, lettered A, B, ... in order (box ids have gaps); a slot with a
/// non-zero `state` and a vendor or type is loaded; colors come as `#0RRGGBB`. Slot ids are the box
/// letter and the slot's `id` plus one.
pub(crate) fn cfs_units(boxes: Option<&Value>) -> Vec<FilamentUnit> {
    let Some(list) = boxes
        .and_then(|b| b.get("materialBoxs"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let int = |v: &Value, k: &str| match v.get(k) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    };
    list.iter()
        .filter(|b| int(b, "state") == 1 && int(b, "type") == 0)
        .zip(b'A'..=b'Z')
        .map(|(b, letter)| {
            let letter = char::from(letter);
            let slots = b
                .get("materials")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|m| {
                    let text = |k: &str| {
                        m.get(k)
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    };
                    let loaded = int(m, "state") != 0 && (text("vendor").is_some() || text("type").is_some());
                    let n = int(m, "id").clamp(0, 99) + 1;
                    FilamentSlot {
                        id: format!("{letter}{n}"),
                        material: loaded.then(|| text("type")).flatten(),
                        color: loaded
                            .then(|| text("color"))
                            .flatten()
                            .and_then(|c| crate::drivers::moonraker::hex_color(&c)),
                        ..FilamentSlot::default()
                    }
                })
                .collect();
            FilamentUnit {
                id: letter.to_string(),
                kind: "cfs".to_owned(),
                tool: None,
                slots,
            }
        })
        .collect()
}

/// `curPosition`, `X:10.00 Y:20.00 Z:3.40`.
pub(crate) fn position(text: &str) -> Option<[f64; 3]> {
    let axis = |a: &str| {
        text.split_whitespace().find_map(|p| {
            let (k, v) = p.split_once(':')?;
            k.eq_ignore_ascii_case(a).then(|| v.parse().ok()).flatten()
        })
    };
    Some([axis("X")?, axis("Y")?, axis("Z")?])
}

/// Maps merged telemetry to the normalized status.
pub(crate) fn parse_status(id: &str, t: &Value) -> PrinterStatus {
    let get = |k: &str| t.get(k);
    let errcode = t.get("err").map_or(0.0, |e| {
        e.get("errcode").and_then(num).or_else(|| num(e)).unwrap_or(0.0)
    });
    let self_test = get("withSelfTest").and_then(num).unwrap_or(0.0);
    let file = get("printFileName")
        .and_then(Value::as_str)
        .filter(|f| !f.is_empty());
    let progress = get("printProgress")
        .and_then(num)
        .or_else(|| get("dProgress").and_then(num));
    let code = get("state").and_then(num);
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
        get(cur).and_then(num).map(|c| Temp {
            current: c,
            target: get(tgt).and_then(num).unwrap_or(0.0),
        })
    };
    // The fan percents ha_creality_ws reads: the part (model) fan, the case fan, the side fan.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pct = |k: &str| get(k).and_then(num).map(|p| p.round().clamp(0.0, 100.0) as u8);
    let fans = Fans {
        part: pct("modelFanPct"),
        aux: pct("auxiliaryFanPct"),
        chamber: pct("caseFanPct"),
    };
    let live = PrinterLive {
        fans: (fans != Fans::default()).then_some(fans),
        light: get("lightSw").and_then(num).map(|l| l != 0.0),
        ..PrinterLive::default()
    };
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: file
            .filter(|_| active)
            .map(|f| f.rsplit('/').next().unwrap_or(f).to_owned()),
        progress: progress.filter(|_| active).map(|p| (p / 100.0).clamp(0.0, 1.0)),
        layer: get("layer")
            .and_then(num)
            .filter(|_| active)
            .map(|l| u32::try_from(secs(l)).unwrap_or(0)),
        layer_count: get("TotalLayer")
            .and_then(num)
            .filter(|_| active)
            .map(|l| u32::try_from(secs(l)).unwrap_or(0)),
        time_left_s: get("printLeftTime").and_then(num).filter(|_| active).map(secs),
        nozzles: temp("nozzleTemp", "targetNozzleTemp").into_iter().collect(),
        bed: temp("bedTemp0", "targetBedTemp0").or_else(|| temp("bedTemp", "targetBedTemp")),
        chamber: temp("boxTemp", "targetBoxTemp"),
        slots: cfs_units(get("boxsInfo"))
            .into_iter()
            .flat_map(|u| u.slots)
            .collect(),
        // Every model has a camera: MJPEG on 8080, or WebRTC on 8000 through `webrtc_offer`.
        camera_available: true,
        message: (errcode != 0.0).then(|| format!("Printer error {errcode}")),
        updated_at: now_iso(),
        live: (live != PrinterLive::default()).then(|| Box::new(live)),
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
            Capability::Camera,
        ];
        if !cfs_units(self.push.value("boxsInfo").as_ref()).is_empty() {
            c.push(Capability::FilamentSlots);
        }
        c
    }

    async fn status(&self) -> Result<PrinterStatus> {
        Ok(self.push.snapshot())
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        self.push.events()
    }

    /// The model (a board code read as its name), the firmware from `modelVersion`, the host name
    /// and the CFS boxes with what each slot holds.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        Ok(Some(PrinterHardware {
            model: self.reported_model(),
            firmware: firmware(&self.text("modelVersion").unwrap_or_default()),
            hostname: self.text("hostname"),
            filament_units: cfs_units(self.push.value("boxsInfo").as_ref()),
            ..PrinterHardware::default()
        }))
    }

    fn reported_model(&self) -> Option<String> {
        model_name(&self.model(), &self.text("modelVersion").unwrap_or_default())
    }

    async fn motion(&self) -> Result<Motion> {
        Ok(Motion {
            position: self.text("curPosition").as_deref().and_then(position),
            ..Motion::default()
        })
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
        // OrcaSlicer sends the target folder only to models that cannot print from a CFS.
        if !multi_color(&self.model) {
            form = form.text("path", "");
        }
        form = form.part("file", Part::bytes(file.data.clone()).file_name(name.clone()));
        http::send(
            self.id(),
            self.sign(client.post(url))
                .multipart(form)
                .timeout(Duration::from_secs(300)),
        )
        .await?;
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

    /// WebRTC signaling on port 8000 (`/call/webrtc_local`), for the K2 and newer K1 firmware.
    async fn webrtc_offer(&self, offer_sdp: &str) -> Result<Option<String>> {
        if !self.uses_webrtc() {
            return Ok(None);
        }
        let signaling = camera::Signaling::Creality(format!(
            "http://{}:{}/call/webrtc_local",
            self.cfg.host,
            self.cfg.camera_port.unwrap_or(8000)
        ));
        Ok(camera::webrtc_answer(&self.cfg, &signaling, offer_sdp).await)
    }

    /// The MJPEG stream on port 8080. WebRTC cameras answer `None` here and stream through
    /// [`Self::webrtc_offer`].
    async fn stream(&self) -> Result<Option<camera::FrameStream>> {
        if self.uses_webrtc() {
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
        if self.uses_webrtc() {
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
        assert_eq!(data_root("F005"), "/mnt/UDISK");
        assert!(is_k2("F008") && is_k2("K2 Plus") && !is_k2("F001"));
        assert!(multi_color("K1C") && multi_color("F022"));
        assert!(!multi_color("CR-K1 Max") && !multi_color("F001"));
    }

    #[test]
    fn board_codes_read_as_model_names() {
        assert_eq!(model_name("F008", "").as_deref(), Some("K2 Plus"));
        assert_eq!(
            model_name("", "Printer HW Ver: F005; Printer SW Ver: 1.1.0.12").as_deref(),
            Some("Ender-3 V3 KE")
        );
        assert_eq!(model_name("CR-K1 Max", "").as_deref(), Some("CR-K1 Max"));
        assert_eq!(model_name("Hi", "F018").as_deref(), Some("Hi"));
        assert_eq!(model_name("", ""), None);
        assert_eq!(
            firmware("Printer HW Ver: CR4CU220812S11; Printer SW Ver: 1.3.3.46; DWIN SW Ver: 1.0").as_deref(),
            Some("1.3.3.46")
        );
        assert_eq!(
            firmware("DWIN HW Ver: x; DWIN SW Ver: 2.1").as_deref(),
            Some("2.1")
        );
    }

    #[test]
    fn the_camera_is_webrtc_on_k2_and_newer_k1_firmware() {
        assert!(uses_webrtc("F012", "", None));
        assert!(uses_webrtc("K1C", "", Some(&json!(1))));
        assert!(uses_webrtc("K1C", "", Some(&json!("1"))));
        assert!(!uses_webrtc("K1C", "", Some(&json!(0))));
        assert!(!uses_webrtc("CR-K1 Max", "", None));
    }

    #[test]
    fn cfs_boxes_read_as_orca_reads_them() {
        let boxes = json!({ "materialBoxs": [
            { "id": 0, "state": 1, "type": 1, "materials": [{ "id": 0, "state": 1, "type": "PLA", "vendor": "Creality", "color": "#0FFFFFF" }] },
            { "id": 1, "state": 1, "type": 0, "materials": [
                { "id": 0, "state": 1, "type": "PLA", "vendor": "Creality", "name": "Hyper PLA", "color": "#0FF0000" },
                { "id": 1, "state": 0, "type": "", "vendor": "", "color": "#0000000" },
                { "id": 2, "state": 2, "type": "PETG", "vendor": "Generic", "color": "#000FF00" },
                { "id": 3, "state": 1, "type": "", "vendor": "" }] },
            { "id": 2, "state": 0, "type": 0, "materials": [] }] });
        let u = cfs_units(Some(&boxes));
        assert_eq!(u.len(), 1);
        assert_eq!((u[0].id.as_str(), u[0].kind.as_str()), ("A", "cfs"));
        let s: Vec<(&str, Option<&str>, Option<&str>)> = u[0]
            .slots
            .iter()
            .map(|x| (x.id.as_str(), x.material.as_deref(), x.color.as_deref()))
            .collect();
        assert_eq!(
            s,
            [
                ("A1", Some("PLA"), Some("#ff0000")),
                ("A2", None, None),
                ("A3", Some("PETG"), Some("#00ff00")),
                ("A4", None, None),
            ]
        );
        assert!(cfs_units(None).is_empty());
    }

    #[test]
    fn fans_light_and_position_come_from_the_telemetry() {
        let s = parse_status(
            "x",
            &json!({ "model": "K1C", "modelFanPct": 80, "caseFanPct": "30", "auxiliaryFanPct": 0, "lightSw": 1 }),
        );
        let live = s.live.unwrap();
        let f = live.fans.unwrap();
        assert_eq!((f.part, f.chamber, f.aux), (Some(80), Some(30), Some(0)));
        assert_eq!(live.light, Some(true));
        assert_eq!(position("X:10.50 Y:20.00 Z:3.40"), Some([10.5, 20.0, 3.4]));
        assert_eq!(position("X:1"), None);
    }
}
