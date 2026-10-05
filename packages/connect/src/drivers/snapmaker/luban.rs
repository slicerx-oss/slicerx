// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Snapmaker 2.0 (A150, A250, A350) over the HTTP API on port 8080 that Snapmaker Luban uses.
//! Pairing needs a tap on the printer's touchscreen; see [`LubanClient::authorize`]. See README.md
//! for sources and what is untested on hardware.
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, Response};
use serde_json::Value;

use crate::PrinterSession;
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, f64_at, str_at};
use crate::poll::poll_events;
use crate::types::{
    Capabilities, Capability, Image, JobFile, PrinterConfig, PrinterEvent, PrinterState, PrinterStatus,
    RemoteFile, Secrets, StartOptions, Temp, now_iso, secs,
};

/// Tool head types Luban reports in `headType` that print: single extruder and dual extruder.
const PRINT_HEADS: [i64; 2] = [1, 5];
const DUAL_EXTRUDER: i64 = 5;

pub(crate) struct LubanClient {
    cfg: PrinterConfig,
    client: Client,
    base: String,
}

struct Session {
    api: LubanClient,
    token: String,
    dual: bool,
    gate: Arc<dyn ApprovalGate>,
    /// The file most recently sent with `prepare_print`, the only one `start_print` can start.
    prepared: Mutex<Option<String>>,
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
    /// token the printer answers with and its head type.
    async fn connect(&self, token: &str) -> Result<(String, i64)> {
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
        Ok((
            new.to_owned(),
            v.get("headType").and_then(Value::as_i64).unwrap_or(1),
        ))
    }

    /// `GET /api/v1/status`. `None` means 204: the printer is waiting for the tap on its screen.
    async fn status_raw(&self, token: &str) -> Result<Option<Value>> {
        let rb = self
            .client
            .get(format!("{}/api/v1/status", self.base))
            .query(&[("token", token)]);
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

    /// Pairing: asks for a token and waits until the user confirms on the touchscreen.
    pub(crate) async fn authorize(cfg: &PrinterConfig, timeout: Duration) -> Result<Option<String>> {
        let api = Self::new(cfg)?;
        let (token, head) = api.connect("").await?;
        Self::check_head(head)?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if api.status_raw(&token).await?.is_some() {
                return Ok(Some(token));
            }
            if tokio::time::Instant::now() >= deadline {
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
        let (token, head) = api.connect(&stored).await?;
        Self::check_head(head)?;
        if api.status_raw(&token).await?.is_none() {
            // Still waiting for the tap, or the printer forgot the token.
            return Err(Error::Auth {
                printer: cfg.id.clone(),
            });
        }
        Ok(Box::new(Session {
            api,
            token,
            dual: head == DUAL_EXTRUDER,
            gate,
            prepared: Mutex::new(None),
        }))
    }
}

impl Session {
    fn id(&self) -> &str {
        self.api.id()
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        let v = self
            .api
            .status_raw(&self.token)
            .await?
            .ok_or_else(|| Error::Auth {
                printer: self.id().to_owned(),
            })?;
        Ok(parse_status(self.id(), &v, self.dual))
    }

    async fn post(&self, path: &str, extra: &[(&str, &str)]) -> Result<()> {
        let mut form = vec![("token", self.token.as_str())];
        form.extend_from_slice(extra);
        http::send(
            self.id(),
            self.api
                .client
                .post(format!("{}{path}", self.api.base))
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
    let progress = f64_at(v, &["progress"])
        .map(|p| if p > 1.0 { p / 100.0 } else { p })
        .map(|p| p.clamp(0.0, 1.0));
    let state = match str_at(v, &["status"])
        .unwrap_or("IDLE")
        .to_ascii_uppercase()
        .as_str()
    {
        "RUNNING" => PrinterState::Printing,
        "PAUSED" => PrinterState::Paused,
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
        // The session owns a token and a client; the event stream gets its own copies.
        let api = LubanClient {
            cfg: self.api.cfg.clone(),
            client: self.api.client.clone(),
            base: self.api.base.clone(),
        };
        let (token, dual) = (self.token.clone(), self.dual);
        // The touchscreen firmware is slow; poll every two seconds unless the config says otherwise.
        let interval = Duration::from_millis(self.api.cfg.poll_ms.unwrap_or(2000).max(50));
        let id = self.id().to_owned();
        let api = Arc::new(api);
        poll_events(
            id.clone(),
            interval,
            Arc::new(move || {
                let (api, token, id) = (api.clone(), token.clone(), id.clone());
                async move {
                    let v = api
                        .status_raw(&token)
                        .await?
                        .ok_or_else(|| Error::Auth { printer: id.clone() })?;
                    Ok(parse_status(&id, &v, dual))
                }
            }),
        )
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
            .text("token", self.token.clone())
            .text("type", "3DP")
            .part(
                "file",
                Part::bytes(file.data.clone()).file_name(file.name.clone()),
            );
        http::send(
            self.id(),
            self.api
                .client
                .post(format!("{}/api/v1/prepare_print", self.api.base))
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
    }
}
