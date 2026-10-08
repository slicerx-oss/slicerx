// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! BamBuddy REST (`/api/v1`). The printer record already exists in SlicerX. This session is the
//! link to the printer BamBuddy knows: `host` and `port` are the BamBuddy computer (port 8000
//! unless set), `credentialRef` is its API key (`X-API-Key`), and `serial` is BamBuddy's printer
//! id. A printer BamBuddy reaches through a bridge is the same kind of id. This driver does not
//! speak Moonraker or the Bambu LAN protocol.
//!
//! Upload stores the sliced file in the library. Start posts a queue item with `manual_start`
//! false, so BamBuddy starts it when that printer is idle. A slot map becomes `ams_mapping`.
//! `set_slot` configures an AMS tray. Status reads AMS trays and the external spool.
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder};
use serde_json::{Map, Value, json};

use crate::drivers::bambu::{slot_map_problem, slot_to_tray};
use crate::error::{Error, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, base_url};
use crate::manifest::{PluginManifest, manifest};
use crate::poll::poll_events;
use crate::types::{
    Capabilities, Capability, DiscoveredPrinter, FilamentSlot, FilamentUnit, Image, JobFile, LiveUnit,
    PrinterConfig, PrinterEvent, PrinterHardware, PrinterLive, PrinterState, PrinterStatus, RemoteFile,
    Secrets, SlotSetting, StartOptions, Temp, now_iso,
};
use crate::{PrinterConnector, PrinterSession};

const PLUGIN: &str = "bambuddy";
/// Docker Compose `PORT` when it is left unset.
const DEFAULT_PORT: u16 = 8000;
/// External spool in `ams_mapping` and in BamBuddy's `tray_now`.
const EXTERNAL_TRAY: i64 = 254;
const API: &str = "/api/v1";

pub struct BambuddyConnector {
    gate: Arc<dyn ApprovalGate>,
}

impl BambuddyConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self { gate }
    }
}

#[async_trait]
impl PrinterConnector for BambuddyConnector {
    fn manifest(&self) -> PluginManifest {
        manifest(PLUGIN).unwrap_or_else(|| super::prusalink::unreachable_manifest(PLUGIN))
    }

    /// The person types the BamBuddy address and printer id. Nothing is scanned.
    async fn discover(&self, _timeout: Duration) -> Vec<DiscoveredPrinter> {
        Vec::new()
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        let printer_num = printer_num(cfg)?;
        let key = cfg.credential_ref.as_deref().and_then(|r| secrets.get(r));
        let inner = Arc::new(Inner {
            cfg: cfg.clone(),
            client: http::client(cfg)?,
            base: base_url(cfg, DEFAULT_PORT),
            key,
            gate: self.gate.clone(),
            printer_num,
        });
        // One status read checks the address, the key and the printer id together.
        inner.fetch_status().await?;
        Ok(Box::new(BambuddySession { inner }))
    }
}

struct Inner {
    cfg: PrinterConfig,
    client: Client,
    base: String,
    key: Option<String>,
    gate: Arc<dyn ApprovalGate>,
    printer_num: u64,
}

impl Inner {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn auth(&self, rb: RequestBuilder) -> RequestBuilder {
        match &self.key {
            Some(k) => rb.header("X-API-Key", k),
            None => rb,
        }
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.auth(self.client.get(format!("{}{path}", self.base)))
    }

    fn post(&self, path: &str) -> RequestBuilder {
        self.auth(self.client.post(format!("{}{path}", self.base)))
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        let path = format!("{API}/printers/{}/status", self.printer_num);
        let resp = http::send(self.id(), self.get(&path)).await?;
        let body = http::json(self.id(), resp).await?;
        Ok(parse_status(self.id(), &body))
    }
}

struct BambuddySession {
    inner: Arc<Inner>,
}

#[async_trait]
impl PrinterSession for BambuddySession {
    fn capabilities(&self) -> Capabilities {
        vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::FilamentSlots,
            Capability::ProjectFile,
            Capability::SlotWrite,
        ]
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.inner.fetch_status().await
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let inner = self.inner.clone();
        let interval = inner.cfg.poll_interval();
        let id = inner.cfg.id.clone();
        poll_events(
            id,
            interval,
            Arc::new(move || {
                let inner = inner.clone();
                async move { inner.fetch_status().await }
            }),
        )
    }

    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let status = self.inner.fetch_status().await?;
        Ok(Some(hardware_from(&status)))
    }

    /// The queue starts the file when the printer is idle, which is after this call returns.
    fn reports_start_late(&self) -> bool {
        true
    }

    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.inner.gate.check(
            token,
            Action::Upload,
            self.inner.id(),
            &params::upload(self.inner.id(), &file.name, &file.sha256),
        )?;
        let form = Form::new().part("file", Part::bytes(file.data).file_name(file.name.clone()));
        let resp = http::send(
            self.inner.id(),
            self.inner
                .post(&format!("{API}/library/files"))
                .multipart(form)
                .timeout(Duration::from_secs(120)),
        )
        .await?;
        let body = http::json(self.inner.id(), resp).await?;
        let id = body
            .get("id")
            .and_then(Value::as_i64)
            .filter(|n| *n > 0)
            .ok_or_else(|| Error::protocol(self.inner.id(), "the library upload did not return a file id"))?;
        Ok(RemoteFile {
            printer_id: self.inner.id().to_owned(),
            path: id.to_string(),
            name: file.name,
            sha256: Some(file.sha256),
        })
    }

    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        let library_file_id = library_file_id(&file.path)?;
        let body = queue_body(self.inner.printer_num, library_file_id, &opts)?;
        self.inner.gate.check(
            token,
            Action::Start,
            self.inner.id(),
            &params::start(self.inner.id(), file, &opts),
        )?;
        http::send(
            self.inner.id(),
            self.inner
                .post(&format!("{API}/queue/"))
                .json(&body)
                .timeout(Duration::from_secs(30)),
        )
        .await?;
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.command(token, Action::Pause, "pause").await
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.command(token, Action::Resume, "resume").await
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.command(token, Action::Cancel, "stop").await
    }

    async fn snapshot(&self) -> Result<Option<Image>> {
        Ok(None)
    }

    async fn send_gcode(&self, _line: &str, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported(PLUGIN, "a G-code console"))
    }

    async fn set_slot(&self, setting: &SlotSetting, token: &ApprovalToken) -> Result<()> {
        let (ams, tray) = ams_tray(&setting.slot)?;
        let color = rgba(&setting.color)?;
        self.inner.gate.check(
            token,
            Action::Adjust,
            self.inner.id(),
            &params::slot(self.inner.id(), setting),
        )?;
        let path = format!(
            "{API}/printers/{}/slots/{ams}/{tray}/configure",
            self.inner.printer_num
        );
        let min = setting.nozzle_temp_min.to_string();
        let max = setting.nozzle_temp_max.to_string();
        http::send(
            self.inner.id(),
            self.inner
                .post(&path)
                .query(&[
                    ("tray_info_idx", setting.filament_id.as_str()),
                    ("tray_type", setting.material.as_str()),
                    ("tray_sub_brands", setting.material.as_str()),
                    ("tray_color", color.as_str()),
                    ("nozzle_temp_min", min.as_str()),
                    ("nozzle_temp_max", max.as_str()),
                ])
                .timeout(Duration::from_secs(30)),
        )
        .await?;
        Ok(())
    }
}

impl BambuddySession {
    async fn command(&self, token: &ApprovalToken, action: Action, path: &str) -> Result<()> {
        self.inner
            .gate
            .check(token, action, self.inner.id(), &params::printer(self.inner.id()))?;
        let url = format!("{API}/printers/{}/print/{path}", self.inner.printer_num);
        http::send(
            self.inner.id(),
            self.inner.post(&url).timeout(Duration::from_secs(30)),
        )
        .await?;
        Ok(())
    }
}

fn printer_num(cfg: &PrinterConfig) -> Result<u64> {
    let raw = cfg
        .serial
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            Error::Config("enter the BamBuddy printer id, the number BamBuddy uses for this printer".into())
        })?;
    let n = raw.parse::<u64>().map_err(|_| {
        Error::Config("the BamBuddy printer id is the number BamBuddy uses for this printer".into())
    })?;
    if n == 0 {
        return Err(Error::Config(
            "the BamBuddy printer id is the number BamBuddy uses for this printer".into(),
        ));
    }
    Ok(n)
}

fn library_file_id(path: &str) -> Result<i64> {
    path.parse::<i64>().ok().filter(|n| *n > 0).ok_or_else(|| {
        Error::not_supported(
            PLUGIN,
            "starting a file that was not uploaded to the BamBuddy library",
        )
    })
}

/// Queue create body. Tri-state options are omitted when the sheet did not set them, so BamBuddy
/// keeps its own default (`auto` for bed level and flow). A slot map is sent only when one was
/// approved. Nozzle mapping is not a field this create call accepts.
pub(crate) fn queue_body(printer_id: u64, library_file_id: i64, opts: &StartOptions) -> Result<Value> {
    if let Some(why) = opts.slot_map.as_ref().and_then(slot_map_problem) {
        return Err(Error::not_supported(PLUGIN, &why));
    }
    let mut body = Map::new();
    body.insert("printer_id".into(), json!(printer_id));
    body.insert("library_file_id".into(), json!(library_file_id));
    body.insert("manual_start".into(), json!(false));
    if let Some(plate) = opts.plate {
        body.insert("plate_id".into(), json!(plate.max(1)));
    }
    if let Some(v) = tri_state(opts.bed_leveling) {
        body.insert("bed_levelling".into(), json!(v));
    }
    if let Some(v) = tri_state(opts.flow_calibration) {
        body.insert("flow_cali".into(), json!(v));
    }
    if let Some(v) = opts.vibration_compensation {
        body.insert("vibration_cali".into(), json!(v));
    }
    if let Some(v) = opts.timelapse {
        body.insert("timelapse".into(), json!(v));
    }
    if let Some(v) = opts.first_layer_inspection {
        body.insert("layer_inspect".into(), json!(v));
    }
    if opts.has_slot_map() {
        let (mapping, use_ams) = ams_mapping(opts);
        body.insert("ams_mapping".into(), json!(mapping));
        body.insert("use_ams".into(), json!(use_ams));
    }
    Ok(Value::Object(body))
}

fn tri_state(v: Option<bool>) -> Option<&'static str> {
    match v {
        Some(true) => Some("on"),
        Some(false) => Some("off"),
        None => None,
    }
}

/// `ams_mapping` as BamBuddy's queue wants it: one global tray id per filament, `-1` when that
/// filament is unused or on the external spool. `use_ams` is true when any filament comes from an
/// AMS tray.
fn ams_mapping(opts: &StartOptions) -> (Vec<i64>, bool) {
    let Some(map) = opts.slot_map.as_ref().filter(|m| !m.is_empty()) else {
        return (Vec::new(), false);
    };
    let max = map.keys().copied().max().unwrap_or(0);
    let mut out = Vec::new();
    let mut use_ams = false;
    for i in 0..=max {
        match map.get(&i).and_then(|s| slot_to_tray(s)) {
            Some(EXTERNAL_TRAY) | None => out.push(-1),
            Some(tray) => {
                use_ams = true;
                out.push(tray);
            }
        }
    }
    (out, use_ams)
}

/// AMS tray address for a slot id the sheet uses (`A1`..`D4`). The external spool is not an AMS tray.
fn ams_tray(slot: &str) -> Result<(i64, i64)> {
    let Some(tray) = slot_to_tray(slot) else {
        return Err(Error::not_supported(
            PLUGIN,
            "a slot this printer does not report (AMS slots are A1 to D4)",
        ));
    };
    if tray == EXTERNAL_TRAY {
        return Err(Error::not_supported(
            PLUGIN,
            "the external spool (BamBuddy configures AMS trays; set the external spool on the printer)",
        ));
    }
    Ok((tray / 4, tray % 4))
}

fn rgba(color: &str) -> Result<String> {
    let hex = color.trim().trim_start_matches('#');
    let Some(rgb) = hex.get(..6) else {
        return Err(Error::not_supported(PLUGIN, "a color that is not #rrggbb"));
    };
    if rgb.len() != 6 || !rgb.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::not_supported(PLUGIN, "a color that is not #rrggbb"));
    }
    Ok(format!("{}FF", rgb.to_ascii_uppercase()))
}

pub(crate) fn parse_status(printer_id: &str, body: &Value) -> PrinterStatus {
    let connected = body.get("connected").and_then(Value::as_bool).unwrap_or(true);
    let slots = slots_from(body);
    let live = live_from(body, &slots);
    let temps = body.get("temperatures");
    PrinterStatus {
        printer_id: printer_id.to_owned(),
        state: map_state(connected, text(body, "state").as_deref()),
        job_name: text(body, "subtask_name").or_else(|| text(body, "current_print")),
        progress: progress_of(body),
        layer: u32_of(body, "layer_num"),
        layer_count: u32_of(body, "total_layers"),
        time_left_s: time_left(body),
        nozzles: nozzles_of(temps),
        bed: temps.and_then(|t| temp_at(t, "bed", "bed_target")),
        chamber: temps.and_then(|t| temp_at(t, "chamber", "chamber_target")),
        slots,
        camera_available: body.get("ipcam").and_then(Value::as_bool).unwrap_or(false),
        message: (!connected).then(|| "BamBuddy is not connected to this printer".to_owned()),
        updated_at: now_iso(),
        live: live.map(Box::new),
    }
}

fn map_state(connected: bool, raw: Option<&str>) -> PrinterState {
    if !connected {
        return PrinterState::Offline;
    }
    match raw.unwrap_or("").to_ascii_uppercase().as_str() {
        "RUNNING" => PrinterState::Printing,
        "PAUSE" | "PAUSED" => PrinterState::Paused,
        "FINISH" | "FINISHED" => PrinterState::Finished,
        "PREPARE" | "PREPARING" | "SLICING" => PrinterState::Preparing,
        "FAILED" | "ERROR" => PrinterState::Error,
        _ => PrinterState::Idle,
    }
}

/// BamBuddy's `progress` is a percent. `remaining_time` is minutes.
fn progress_of(body: &Value) -> Option<f64> {
    let p = body.get("progress").and_then(Value::as_f64)?;
    p.is_finite().then_some((p / 100.0).clamp(0.0, 1.0))
}

fn time_left(body: &Value) -> Option<u64> {
    let mins = body.get("remaining_time").and_then(Value::as_i64)?;
    u64::try_from(mins).ok().map(|m| m.saturating_mul(60))
}

fn u32_of(body: &Value, key: &str) -> Option<u32> {
    u32::try_from(body.get(key).and_then(Value::as_i64)?).ok()
}

fn nozzles_of(temps: Option<&Value>) -> Vec<Temp> {
    let Some(temps) = temps else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(t) = temp_at(temps, "nozzle", "nozzle_target") {
        out.push(t);
    }
    if let Some(t) = temp_at(temps, "nozzle_2", "nozzle_2_target") {
        out.push(t);
    }
    out
}

fn temp_at(temps: &Value, current: &str, target: &str) -> Option<Temp> {
    Some(Temp {
        current: temps.get(current).and_then(Value::as_f64)?,
        target: temps.get(target).and_then(Value::as_f64).unwrap_or(0.0),
    })
}

fn slots_from(body: &Value) -> Vec<FilamentSlot> {
    let mut out = Vec::new();
    if let Some(units) = body.get("ams").and_then(Value::as_array) {
        for unit in units {
            let uid = unit.get("id").and_then(Value::as_i64).unwrap_or(-1);
            let Some(trays) = unit.get("tray").and_then(Value::as_array) else {
                continue;
            };
            for tray in trays {
                let tid = tray.get("id").and_then(Value::as_i64).unwrap_or(-1);
                let Some(id) = slot_id(uid, tid) else {
                    continue;
                };
                out.push(slot_from(id, tray));
            }
        }
    }
    if let Some(tray) = body
        .get("vt_tray")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    {
        out.push(slot_from("1".to_owned(), tray));
    }
    out
}

/// `A1`..`D4` for AMS units 0 to 3. Other unit ids are not slots the sheet can map.
fn slot_id(unit: i64, tray: i64) -> Option<String> {
    let letter = unit_letter(unit)?;
    if !(0..=3).contains(&tray) {
        return None;
    }
    let n = tray + 1;
    Some(format!("{letter}{n}"))
}

fn unit_letter(unit: i64) -> Option<String> {
    if !(0..=3).contains(&unit) {
        return None;
    }
    let code = u32::try_from(unit).ok()? + u32::from(b'A');
    Some(char::from_u32(code)?.to_string())
}

fn slot_from(id: String, tray: &Value) -> FilamentSlot {
    let empty = tray_empty(tray);
    FilamentSlot {
        id,
        material: if empty { None } else { text(tray, "tray_type") },
        color: if empty {
            None
        } else {
            text(tray, "tray_color").as_deref().and_then(css_color)
        },
        remaining_pct: if empty { None } else { remain(tray) },
        spoolman_id: None,
        spool_uid: if empty { None } else { spool_uid(tray) },
    }
}

fn tray_empty(tray: &Value) -> bool {
    if tray.get("state").and_then(Value::as_i64) == Some(9) {
        return true;
    }
    tray.get("exists").and_then(Value::as_bool) == Some(false) && text(tray, "tray_type").is_none()
}

fn css_color(raw: &str) -> Option<String> {
    let hex = raw.trim().trim_start_matches('#');
    let rgb = hex.get(..6)?;
    if rgb.len() != 6 || !rgb.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", rgb.to_ascii_lowercase()))
}

fn remain(tray: &Value) -> Option<f64> {
    let n = tray.get("remain").and_then(Value::as_f64)?;
    (0.0..=100.0).contains(&n).then_some(n)
}

fn spool_uid(tray: &Value) -> Option<String> {
    text(tray, "tray_uuid").or_else(|| text(tray, "tag_uid"))
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn live_from(body: &Value, slots: &[FilamentSlot]) -> Option<PrinterLive> {
    let units = live_units(body);
    let live = PrinterLive {
        speed_percent: body
            .get("speed_level")
            .and_then(Value::as_i64)
            .and_then(speed_percent),
        light: body.get("chamber_light").and_then(Value::as_bool),
        active_slot: body
            .get("tray_now")
            .and_then(Value::as_i64)
            .and_then(active_slot)
            .filter(|id| slots.iter().any(|s| s.id == *id)),
        units: (!units.is_empty()).then_some(units),
        ..PrinterLive::default()
    };
    (live != PrinterLive::default()).then_some(live)
}

fn speed_percent(level: i64) -> Option<u16> {
    match level {
        1 => Some(50),
        2 => Some(100),
        3 => Some(124),
        4 => Some(166),
        _ => None,
    }
}

/// Global tray id to a slot id. 254 is the external spool. 255 is none.
fn active_slot(tray_now: i64) -> Option<String> {
    if tray_now == EXTERNAL_TRAY {
        return Some("1".to_owned());
    }
    if !(0..16).contains(&tray_now) {
        return None;
    }
    slot_id(tray_now / 4, tray_now % 4)
}

fn live_units(body: &Value) -> Vec<LiveUnit> {
    let mut out = Vec::new();
    if let Some(units) = body.get("ams").and_then(Value::as_array) {
        for unit in units {
            let uid = unit.get("id").and_then(Value::as_i64).unwrap_or(-1);
            let Some(id) = unit_letter(uid) else {
                continue;
            };
            let kind = if unit.get("is_ams_ht").and_then(Value::as_bool) == Some(true) {
                "ams-ht"
            } else {
                "ams"
            };
            out.push(LiveUnit {
                id,
                kind: kind.to_owned(),
                feeds: None,
            });
        }
    }
    if body
        .get("vt_tray")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
    {
        out.push(LiveUnit {
            id: "external".to_owned(),
            kind: "external".to_owned(),
            feeds: None,
        });
    }
    out
}

fn hardware_from(status: &PrinterStatus) -> PrinterHardware {
    let mut filament_units = Vec::new();
    for letter in ["A", "B", "C", "D"] {
        let mine: Vec<FilamentSlot> = status
            .slots
            .iter()
            .filter(|s| s.id.starts_with(letter))
            .cloned()
            .collect();
        if mine.is_empty() {
            continue;
        }
        let kind = status
            .live
            .as_ref()
            .and_then(|l| l.units.as_ref())
            .and_then(|u| u.iter().find(|unit| unit.id == letter))
            .map_or_else(|| "ams".to_owned(), |unit| unit.kind.clone());
        filament_units.push(FilamentUnit {
            id: letter.to_owned(),
            kind,
            tool: None,
            slots: mine,
        });
    }
    let external: Vec<FilamentSlot> = status.slots.iter().filter(|s| s.id == "1").cloned().collect();
    if !external.is_empty() {
        filament_units.push(FilamentUnit {
            id: "external".to_owned(),
            kind: "external".to_owned(),
            tool: None,
            slots: external,
        });
    }
    PrinterHardware {
        filament_units,
        ..PrinterHardware::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn opts(map: &[(u32, &str)]) -> StartOptions {
        let mut slot_map = BTreeMap::new();
        for (k, v) in map {
            slot_map.insert(*k, (*v).to_owned());
        }
        StartOptions {
            slot_map: Some(slot_map),
            ..StartOptions::default()
        }
    }

    #[test]
    fn queue_maps_slots_and_options() {
        let mut o = opts(&[(0, "A1"), (1, "B2"), (3, "1")]);
        o.plate = Some(2);
        o.bed_leveling = Some(true);
        o.flow_calibration = Some(false);
        o.vibration_compensation = Some(false);
        o.timelapse = Some(true);
        o.first_layer_inspection = Some(true);
        let body = queue_body(7, 44, &o).unwrap();
        assert_eq!(body["printer_id"], 7);
        assert_eq!(body["library_file_id"], 44);
        assert_eq!(body["manual_start"], false);
        assert_eq!(body["plate_id"], 2);
        assert_eq!(body["bed_levelling"], "on");
        assert_eq!(body["flow_cali"], "off");
        assert_eq!(body["vibration_cali"], false);
        assert_eq!(body["timelapse"], true);
        assert_eq!(body["layer_inspect"], true);
        assert_eq!(body["ams_mapping"], json!([0, 5, -1, -1]));
        assert_eq!(body["use_ams"], true);
        assert!(body.get("nozzle_mapping").is_none());
        assert!(body.get("target_model").is_none());
    }

    #[test]
    fn unset_options_stay_off_the_body_and_an_external_map_does_not_use_the_ams() {
        let body = queue_body(1, 2, &opts(&[(0, "1")])).unwrap();
        assert!(body.get("bed_levelling").is_none());
        assert!(body.get("plate_id").is_none());
        assert_eq!(body["ams_mapping"], json!([-1]));
        assert_eq!(body["use_ams"], false);
    }

    #[test]
    fn a_slot_the_printer_cannot_name_is_refused() {
        let err = queue_body(1, 2, &opts(&[(0, "Z9")])).unwrap_err();
        assert!(format!("{err}").contains("slot"));
    }

    #[test]
    fn status_reads_ams_time_and_state() {
        let body = json!({
            "connected": true,
            "state": "RUNNING",
            "subtask_name": "bracket",
            "progress": 40,
            "remaining_time": 5,
            "layer_num": 12,
            "total_layers": 80,
            "temperatures": { "nozzle": 210, "nozzle_target": 220, "bed": 55, "bed_target": 60 },
            "speed_level": 2,
            "chamber_light": true,
            "tray_now": 0,
            "ipcam": false,
            "ams": [{
                "id": 0,
                "tray": [
                    { "id": 0, "tray_type": "PLA", "tray_color": "FFFF00FF", "remain": 80, "tray_uuid": "abc", "state": 11 },
                    { "id": 1, "state": 9, "tray_type": "PETG" }
                ]
            }],
            "vt_tray": [{ "id": 254, "tray_type": "ABS", "tray_color": "0000FFFF" }]
        });
        let s = parse_status("bay-1", &body);
        assert_eq!(s.state, PrinterState::Printing);
        assert_eq!(s.job_name.as_deref(), Some("bracket"));
        assert_eq!(s.progress, Some(0.4));
        assert_eq!(s.time_left_s, Some(300));
        assert_eq!(s.layer, Some(12));
        assert_eq!(s.slots.len(), 3);
        assert_eq!(s.slots[0].id, "A1");
        assert_eq!(s.slots[0].material.as_deref(), Some("PLA"));
        assert_eq!(s.slots[0].color.as_deref(), Some("#ffff00"));
        assert_eq!(s.slots[0].spool_uid.as_deref(), Some("abc"));
        assert!(s.slots[1].material.is_none());
        assert_eq!(s.slots[2].id, "1");
        assert_eq!(s.slots[2].material.as_deref(), Some("ABS"));
        assert_eq!(s.live.as_ref().and_then(|l| l.active_slot.as_deref()), Some("A1"));
        assert_eq!(s.live.as_ref().and_then(|l| l.speed_percent), Some(100));
        assert_eq!(s.nozzles[0].current, 210.0);
        let hw = hardware_from(&s);
        assert_eq!(hw.filament_units.len(), 2);
        assert_eq!(hw.filament_units[0].id, "A");
        assert_eq!(hw.filament_units[1].kind, "external");
    }

    #[test]
    fn a_disconnected_printer_is_offline() {
        let s = parse_status("bay-1", &json!({ "connected": false, "state": "RUNNING" }));
        assert_eq!(s.state, PrinterState::Offline);
        assert!(s.message.is_some());
    }

    #[test]
    fn configure_addresses_an_ams_tray_and_refuses_the_external_spool() {
        assert_eq!(ams_tray("B2").unwrap(), (1, 1));
        assert_eq!(rgba("#ab12cd").unwrap(), "AB12CDFF");
        assert!(ams_tray("1").is_err());
    }
}
