// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Snapmaker 2.0 (A150, A250, A350) over the HTTP API on port 8080 that Snapmaker Luban uses.
//! Pairing needs a tap on the printer's touchscreen; see [`LubanClient::authorize`]. See README.md
//! for sources and what is untested on hardware.
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, Response};
use serde_json::Value;

use crate::PrinterSession;
use crate::error::{Error, LoginNeed, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, f64_at, str_at};
use crate::poll::poll_events;
use crate::types::{
    Capabilities, Capability, ExtruderInfo, Image, JobFile, Motion, PrinterConfig, PrinterEvent,
    PrinterHardware, PrinterState, PrinterStatus, RemoteFile, Secrets, StartOptions, Temp, now_iso, secs,
};

/// Tool head types Luban reports in `headType` that print: single extruder and dual extruder.
const PRINT_HEADS: [i64; 2] = [1, 5];
const DUAL_EXTRUDER: i64 = 5;

pub(crate) struct LubanClient {
    cfg: PrinterConfig,
    client: Client,
    base: String,
}

/// Rejections in a row after which the stored token counts as invalid. The A350 drops idle sessions
/// with a 401 now and then (ifnull/homeassistant-snapmaker PR 1), and a token it forgot keeps
/// failing for minutes.
const MAX_REJECTIONS: u32 = 10;

/// The least time between two reconnects, so a printer that keeps refusing is not asked in a loop.
const RECONNECT_GAP: Duration = Duration::from_secs(10);

struct Session {
    state: Arc<State>,
    dual: bool,
    /// The machine the printer names in its connect reply (`series`), such as A350.
    series: Option<String>,
    gate: Arc<dyn ApprovalGate>,
    /// The file most recently sent with `prepare_print`, the only one `start_print` can start.
    prepared: Mutex<Option<String>>,
}

/// What the session and its event poll share: the token, which a reconnect replaces.
struct State {
    api: LubanClient,
    token: Mutex<String>,
    /// Status requests carry the token in the body: set when the query form was refused and the body
    /// form got in (newer notes say body only).
    token_in_body: AtomicBool,
    rejections: AtomicU32,
    last_reconnect: Mutex<Option<tokio::time::Instant>>,
}

/// The `POST /api/v1/connect` reply.
struct Connected {
    token: String,
    head: i64,
    series: Option<String>,
}

impl LubanClient {
    pub(crate) fn new(cfg: &PrinterConfig) -> Result<Self> {
        Ok(Self {
            cfg: cfg.clone(),
            client: http::client(cfg)?,
            base: format!("http://{}:{}", cfg.host, cfg.port.unwrap_or(8080)),
        })
    }

    fn id(&self) -> &str {
        &self.cfg.id
    }

    /// `POST /api/v1/connect`. Sends the stored token, or nothing for a first pairing. Returns the
    /// token the printer answers with, its head type and its series.
    async fn connect(&self, token: &str) -> Result<Connected> {
        let body = if token.is_empty() {
            Vec::new()
        } else {
            vec![("token", token)]
        };
        let resp = http::send(
            self.id(),
            self.client
                .post(format!("{}/api/v1/connect", self.base))
                .form(&body),
        )
        .await?;
        let v = http::json(self.id(), resp).await?;
        let new = v
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::protocol(self.id(), "connect reply without token"))?;
        Ok(Connected {
            token: new.to_owned(),
            head: v.get("headType").and_then(Value::as_i64).unwrap_or(1),
            series: v
                .get("series")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        })
    }

    /// `POST /api/v1/disconnect`, which also clears a pairing prompt left on the touchscreen.
    async fn disconnect(&self, token: &str) {
        let _ = self
            .client
            .post(format!("{}/api/v1/disconnect", self.base))
            .form(&[("token", token)])
            .timeout(Duration::from_secs(3))
            .send()
            .await;
    }

    /// `GET /api/v1/status`. `None` means 204: the printer is waiting for the tap on its screen.
    /// Luban sends the token in the query; `in_body` sends it as a form body instead. Error text never
    /// carries the URL, so the token stays out of logs.
    async fn status_raw(&self, token: &str, in_body: bool) -> Result<Option<Value>> {
        let rb = self.client.get(format!("{}/api/v1/status", self.base));
        let rb = if in_body {
            rb.form(&[("token", token)])
        } else {
            rb.query(&[("token", token)])
        };
        let resp: Response = rb
            .send()
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        if resp.status().as_u16() == 204 {
            return Ok(None);
        }
        let resp = http::check(self.id(), resp)?;
        let v = http::json(self.id(), resp).await?;
        Ok(v.as_object().is_some_and(|o| !o.is_empty()).then_some(v))
    }

    fn check_head(head: i64) -> Result<()> {
        if PRINT_HEADS.contains(&head) {
            Ok(())
        } else {
            Err(Error::not_supported("snapmaker", "laser and CNC tool heads"))
        }
    }

    /// Pairing: asks for a token and waits until the user confirms on the touchscreen. A refusal on
    /// the screen (401) stops at once; a timeout clears the prompt with `disconnect`, so it does not
    /// stay on the screen. Polled every second, as Luban does.
    pub(crate) async fn authorize(cfg: &PrinterConfig, timeout: Duration) -> Result<Option<String>> {
        let api = Self::new(cfg)?;
        let c = api.connect("").await?;
        Self::check_head(c.head)?;
        let token = c.token;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match api.status_raw(&token, false).await {
                Ok(Some(_)) => return Ok(Some(token)),
                Ok(None) => {}
                Err(Error::Auth { .. }) => {
                    return Err(Error::Login {
                        printer: cfg.id.clone(),
                        need: LoginNeed::Declined,
                    });
                }
                Err(e) => {
                    api.disconnect(&token).await;
                    return Err(e);
                }
            }
            if tokio::time::Instant::now() >= deadline {
                api.disconnect(&token).await;
                return Err(Error::Auth {
                    printer: cfg.id.clone(),
                });
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    pub(crate) async fn open(
        cfg: &PrinterConfig,
        secrets: &dyn Secrets,
        gate: Arc<dyn ApprovalGate>,
    ) -> Result<Box<dyn PrinterSession>> {
        let api = Self::new(cfg)?;
        // No stored token means the printer was never paired with SlicerX.
        let stored = cfg
            .credential_ref
            .as_deref()
            .and_then(|r| secrets.get(r))
            .ok_or_else(|| Error::Auth {
                printer: cfg.id.clone(),
            })?;
        let c = api.connect(&stored).await?;
        Self::check_head(c.head)?;
        let state = State {
            api,
            token: Mutex::new(c.token.clone()),
            token_in_body: AtomicBool::new(false),
            rejections: AtomicU32::new(0),
            last_reconnect: Mutex::new(None),
        };
        match state.status_once(&c.token).await {
            Ok(Some(_)) => {}
            // The printer raised a pairing prompt: it forgot the token (powered off). Clear the
            // prompt rather than leave it waiting for a tap nobody asked for.
            Ok(None) => {
                state.api.disconnect(&c.token).await;
                return Err(Error::Login {
                    printer: cfg.id.clone(),
                    need: LoginNeed::PairAgain,
                });
            }
            Err(e) => return Err(e),
        }
        Ok(Box::new(Session {
            state: Arc::new(state),
            dual: c.head == DUAL_EXTRUDER,
            series: c.series,
            gate,
            prepared: Mutex::new(None),
        }))
    }
}

impl State {
    fn id(&self) -> &str {
        self.api.id()
    }

    fn token(&self) -> String {
        self.token.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// One status request with `token`, in the query, or in the body once the query was refused and
    /// the body got in.
    async fn status_once(&self, token: &str) -> Result<Option<Value>> {
        let in_body = self.token_in_body.load(Ordering::Relaxed);
        match self.api.status_raw(token, in_body).await {
            Err(Error::Auth { .. }) if !in_body => {
                let r = self.api.status_raw(token, true).await;
                if matches!(r, Ok(Some(_))) {
                    self.token_in_body.store(true, Ordering::Relaxed);
                }
                r
            }
            r => r,
        }
    }

    /// The status, with a dropped session (401, or 204 from an approved token) reconnected with the
    /// stored token and asked once more. A token the printer forgot (it raises the pairing prompt
    /// again) clears the prompt and says to pair again; ten rejections in a row mean the same.
    async fn status_value(&self) -> Result<Value> {
        match self.status_once(&self.token()).await {
            Ok(Some(v)) => {
                self.rejections.store(0, Ordering::Relaxed);
                return Ok(v);
            }
            Ok(None) | Err(Error::Auth { .. }) => {}
            Err(e) => return Err(e),
        }
        let n = self.rejections.fetch_add(1, Ordering::Relaxed) + 1;
        if n >= MAX_REJECTIONS {
            return Err(Error::Login {
                printer: self.id().to_owned(),
                need: LoginNeed::PairAgain,
            });
        }
        let now = tokio::time::Instant::now();
        {
            let mut last = self.last_reconnect.lock().unwrap_or_else(PoisonError::into_inner);
            if last.is_some_and(|t| now.duration_since(t) < RECONNECT_GAP) {
                return Err(Error::unreachable(
                    self.id(),
                    "the printer dropped the session; reconnecting",
                ));
            }
            *last = Some(now);
        }
        let c = self.api.connect(&self.token()).await?;
        match self.status_once(&c.token).await {
            Ok(Some(v)) => {
                *self.token.lock().unwrap_or_else(PoisonError::into_inner) = c.token;
                self.rejections.store(0, Ordering::Relaxed);
                Ok(v)
            }
            Ok(None) => {
                self.api.disconnect(&c.token).await;
                Err(Error::Login {
                    printer: self.id().to_owned(),
                    need: LoginNeed::PairAgain,
                })
            }
            // Still refused: counted, and tried again after the gap.
            Err(Error::Auth { .. }) => Err(Error::unreachable(
                self.id(),
                "the printer dropped the session; reconnecting",
            )),
            Err(e) => Err(e),
        }
    }
}

impl Session {
    fn id(&self) -> &str {
        self.state.id()
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        let v = self.state.status_value().await?;
        Ok(parse_status(self.id(), &v, self.dual))
    }

    async fn post(&self, path: &str, extra: &[(&str, &str)]) -> Result<()> {
        let token = self.state.token();
        let mut form = vec![("token", token.as_str())];
        form.extend_from_slice(extra);
        http::send(
            self.id(),
            self.state
                .api
                .client
                .post(format!("{}{path}", self.state.api.base))
                .form(&form),
        )
        .await?;
        Ok(())
    }

    async fn require(&self, action: &str, ok: &[PrinterState]) -> Result<()> {
        let s = self.fetch_status().await?.state;
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

/// Maps a `GET /api/v1/status` reply to the normalized status.
pub(crate) fn parse_status(id: &str, v: &Value, dual: bool) -> PrinterStatus {
    let file = v
        .get("fileName")
        .and_then(Value::as_str)
        .filter(|f| !f.is_empty());
    // Luban reports progress as a fraction; a percentage is accepted too.
    // Without a progress, the G-code line counter (Luban's getGcodePrintingInfo reads the same).
    let lines = match (f64_at(v, &["currentLine"]), f64_at(v, &["totalLines"])) {
        (Some(c), Some(t)) if t > 0.0 => Some(c / t),
        _ => None,
    };
    let progress = f64_at(v, &["progress"])
        .map(|p| if p > 1.0 { p / 100.0 } else { p })
        .or(lines)
        .map(|p| p.clamp(0.0, 1.0));
    let mut stopped = false;
    // IDLE, RUNNING and PAUSED are the documented values; STOPPED is read as a stop, in case.
    let state = match str_at(v, &["status"])
        .unwrap_or("IDLE")
        .to_ascii_uppercase()
        .as_str()
    {
        "RUNNING" => PrinterState::Printing,
        "PAUSED" => PrinterState::Paused,
        "STOPPED" => {
            stopped = true;
            PrinterState::Idle
        }
        _ if file.is_some() && progress.is_some_and(|p| p >= 1.0) => PrinterState::Finished,
        _ => PrinterState::Idle,
    };
    let active = state != PrinterState::Idle;
    let temp = |cur: &str, tgt: &str| {
        f64_at(v, &[cur]).map(|c| Temp {
            current: c,
            target: f64_at(v, &[tgt]).unwrap_or(0.0),
        })
    };
    let mut nozzles: Vec<Temp> = Vec::new();
    if dual {
        nozzles.extend(temp("nozzleTemperature1", "nozzleTargetTemperature1"));
        nozzles.extend(temp("nozzleTemperature2", "nozzleTargetTemperature2"));
    }
    if nozzles.is_empty() {
        nozzles.extend(temp("nozzleTemperature", "nozzleTargetTemperature"));
    }
    let message = if v.get("isEnclosureDoorOpen").and_then(Value::as_bool) == Some(true) {
        Some("Enclosure door is open".to_owned())
    } else if v.get("isFilamentOut").and_then(Value::as_bool) == Some(true) {
        Some("Filament ran out".to_owned())
    } else if stopped {
        Some("The print was stopped".to_owned())
    } else {
        None
    };
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: file.filter(|_| active).map(str::to_owned),
        progress: progress.filter(|_| active),
        layer: None,
        layer_count: None,
        time_left_s: f64_at(v, &["remainingTime"]).filter(|_| active).map(secs),
        nozzles,
        bed: temp("heatedBedTemperature", "heatedBedTargetTemperature"),
        chamber: None,
        slots: Vec::new(),
        camera_available: false,
        message,
        updated_at: now_iso(),
        live: None,
    }
}

#[async_trait]
impl PrinterSession for Session {
    fn capabilities(&self) -> Capabilities {
        vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::GcodeConsole,
        ]
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.fetch_status().await
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let (state, dual) = (self.state.clone(), self.dual);
        // The touchscreen firmware is slow; poll every two seconds unless the config says otherwise.
        let interval = Duration::from_millis(self.state.api.cfg.poll_ms.unwrap_or(2000).max(50));
        let id = self.id().to_owned();
        poll_events(
            id.clone(),
            interval,
            Arc::new(move || {
                let (state, id) = (state.clone(), id.clone());
                async move {
                    let v = state.status_value().await?;
                    Ok(parse_status(&id, &v, dual))
                }
            }),
        )
    }

    /// The machine from the connect reply's `series` and one or two nozzles from the head type.
    /// Serial and firmware are not in the replies.
    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        Ok(Some(luban_hardware(self.series.as_deref(), self.dual)))
    }

    /// Head position and whether it is homed, from the status (`x`, `y`, `z`, `homed`).
    async fn motion(&self) -> Result<Motion> {
        let v = self.state.status_value().await?;
        Ok(luban_motion(&v))
    }

    /// Sends the file with `prepare_print`, which also loads it on the printer's screen. Only the
    /// most recently uploaded file can be started.
    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.gate.check(
            token,
            Action::Upload,
            self.id(),
            &params::upload(self.id(), &file.name, &file.sha256),
        )?;
        if file.name.contains(['/', '\\']) || file.name.is_empty() {
            return Err(Error::protocol(self.id(), "unsafe file name"));
        }
        let form = Form::new()
            .text("token", self.state.token())
            .text("type", "3DP")
            .part(
                "file",
                Part::bytes(file.data.clone()).file_name(file.name.clone()),
            );
        http::send(
            self.id(),
            self.state
                .api
                .client
                .post(format!("{}/api/v1/prepare_print", self.state.api.base))
                .multipart(form),
        )
        .await?;
        *self.prepared.lock().unwrap_or_else(PoisonError::into_inner) = Some(file.name.clone());
        Ok(RemoteFile {
            printer_id: self.id().to_owned(),
            path: file.name.clone(),
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("snapmaker")?;
        self.gate.check(
            token,
            Action::Start,
            self.id(),
            &params::start(self.id(), file, &opts),
        )?;
        let prepared = self
            .prepared
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if prepared.as_deref() != Some(file.path.as_str()) {
            return Err(Error::NotFound {
                printer: self.id().to_owned(),
                what: "prepared file (upload it again; the printer starts the file sent last)".to_owned(),
            });
        }
        self.require("start a job", &[PrinterState::Idle, PrinterState::Finished])
            .await?;
        self.post("/api/v1/start_print", &[]).await
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Pause, self.id(), &params::printer(self.id()))?;
        self.require("pause", &[PrinterState::Printing]).await?;
        self.post("/api/v1/pause_print", &[]).await
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.gate
            .check(token, Action::Resume, self.id(), &params::printer(self.id()))?;
        self.require("resume", &[PrinterState::Paused]).await?;
        self.post("/api/v1/resume_print", &[]).await
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
        )
        .await?;
        self.post("/api/v1/stop_print", &[]).await
    }

    async fn snapshot(&self) -> Result<Option<Image>> {
        Ok(None)
    }

    async fn send_gcode(&self, line: &str, token: &ApprovalToken) -> Result<()> {
        // One command per call: a card showed this line whole, and nothing may ride behind it.
        crate::gate::one_gcode_line(self.id(), line)?;
        self.gate
            .check(token, Action::Gcode, self.id(), &params::gcode(self.id(), line))?;
        self.post("/api/v1/execute_code", &[("code", line)]).await
    }
}

/// The model name in a connect reply's `series`: A150, A250 or A350 when it names one, else as given.
pub(crate) fn model_from_series(series: &str) -> String {
    let up = series.to_ascii_uppercase();
    ["A150", "A250", "A350"]
        .into_iter()
        .find(|m| up.contains(m))
        .map_or_else(|| series.to_owned(), str::to_owned)
}

pub(crate) fn luban_hardware(series: Option<&str>, dual: bool) -> PrinterHardware {
    let tools: u8 = if dual { 2 } else { 1 };
    PrinterHardware {
        model: series.map(model_from_series),
        extruders: (0..tools)
            .map(|tool| ExtruderInfo {
                tool,
                ..ExtruderInfo::default()
            })
            .collect(),
        ..PrinterHardware::default()
    }
}

pub(crate) fn luban_motion(v: &Value) -> Motion {
    let pos = (f64_at(v, &["x"]), f64_at(v, &["y"]), f64_at(v, &["z"]));
    Motion {
        homed: v.get("homed").and_then(Value::as_bool).map(|h| [h; 3]),
        position: match pos {
            (Some(x), Some(y), Some(z)) => Some([x, y, z]),
            _ => None,
        },
        ..Motion::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_mapping() {
        let v = json!({ "status": "RUNNING", "fileName": "a.gcode", "progress": 0.25, "remainingTime": 900, "nozzleTemperature": 200.5, "nozzleTargetTemperature": 205, "heatedBedTemperature": 60, "heatedBedTargetTemperature": 60, "isEnclosureDoorOpen": true });
        let s = parse_status("x", &v, false);
        assert_eq!(s.state, PrinterState::Printing);
        assert_eq!(s.progress, Some(0.25));
        assert_eq!(s.time_left_s, Some(900));
        assert_eq!(s.message.as_deref(), Some("Enclosure door is open"));
        assert_eq!(
            parse_status(
                "x",
                &json!({ "status": "PAUSED", "fileName": "a", "progress": 50 }),
                false
            )
            .progress,
            Some(0.5)
        );
        assert_eq!(
            parse_status(
                "x",
                &json!({ "status": "IDLE", "fileName": "a", "progress": 1 }),
                false
            )
            .state,
            PrinterState::Finished
        );
        let dual = parse_status(
            "x",
            &json!({ "status": "IDLE", "nozzleTemperature1": 25, "nozzleTemperature2": 26 }),
            true,
        );
        assert_eq!(dual.nozzles.len(), 2);
        let stopped = parse_status("x", &json!({ "status": "STOPPED" }), false);
        assert_eq!(stopped.state, PrinterState::Idle);
        assert_eq!(stopped.message.as_deref(), Some("The print was stopped"));
        let by_lines = parse_status(
            "x",
            &json!({ "status": "RUNNING", "fileName": "a", "currentLine": 250, "totalLines": 1000 }),
            false,
        );
        assert_eq!(by_lines.progress, Some(0.25));
    }

    #[test]
    fn hardware_and_motion() {
        let h = luban_hardware(Some("A350"), true);
        assert_eq!(h.model.as_deref(), Some("A350"));
        assert_eq!(h.extruders.len(), 2);
        assert_eq!(model_from_series("Snapmaker 2.0 a250"), "A250");
        let m = luban_motion(&json!({ "x": 1.0, "y": 2.0, "z": 3.5, "homed": true }));
        assert_eq!(m.position, Some([1.0, 2.0, 3.5]));
        assert_eq!(m.homed, Some([true; 3]));
    }
}
