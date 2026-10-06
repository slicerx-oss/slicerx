// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Wire types. They serialize to the JSON shapes in `packages/contracts/src/printers.ts`
//! (`camelCase` fields, `snake_case` tags), so the TS mirror and this crate cannot drift apart
//! unnoticed: `tests/contract_json.rs` checks the fixtures both sides read.
use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrinterState {
    Idle,
    Preparing,
    Printing,
    Paused,
    Finished,
    Error,
    Offline,
}

impl fmt::Display for PrinterState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            PrinterState::Idle => "idle",
            PrinterState::Preparing => "preparing",
            PrinterState::Printing => "printing",
            PrinterState::Paused => "paused",
            PrinterState::Finished => "finished",
            PrinterState::Error => "error",
            PrinterState::Offline => "offline",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Temp {
    pub current: f64,
    pub target: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilamentSlot {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoolman_id: Option<u64>,
    /// The spool's own tag, when the printer reads one (Bambu Lab RFID `tray_uuid`), so a swapped
    /// spool reads as a new one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spool_uid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterStatus {
    pub printer_id: String,
    pub state: PrinterState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_name: Option<String>,
    /// 0 to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_left_s: Option<u64>,
    pub nozzles: Vec<Temp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bed: Option<Temp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chamber: Option<Temp>,
    pub slots: Vec<FilamentSlot>,
    pub camera_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub updated_at: String,
    /// What the printer reports beyond the basics, for the device view. Absent when it reports none of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<Box<PrinterLive>>,
}

/// Fans, speed, light and filament feed as the printer reports them. Every field is absent when the
/// printer does not say.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterLive {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fans: Option<Fans>,
    /// The print speed in percent of the sliced speeds (Bambu Lab levels: 50, 100, 124, 166).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_percent: Option<u16>,
    /// Whether the chamber light is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light: Option<bool>,
    /// The slot feeding the nozzle now, as a slot id of `slots`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_slot: Option<String>,
    /// `left` or `right` for each entry of `nozzles`, on printers with two side by side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nozzle_sides: Option<Vec<String>>,
    /// The filament units, in the order of their slots.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub units: Option<Vec<LiveUnit>>,
    /// Height of the layer printing now, in mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_z_mm: Option<f64>,
}

/// Fan speeds in percent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fans {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aux: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chamber: Option<u8>,
}

/// One filament unit in a status: the letter of its slots, its kind as in [`FilamentUnit`], and the
/// nozzle it feeds (`left` or `right`) on a printer with two.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUnit {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feeds: Option<String>,
}

impl PrinterStatus {
    /// A status for a printer that did not answer.
    pub fn offline(printer_id: &str) -> Self {
        PrinterStatus {
            printer_id: printer_id.to_owned(),
            state: PrinterState::Offline,
            job_name: None,
            progress: None,
            layer: None,
            layer_count: None,
            time_left_s: None,
            nozzles: Vec::new(),
            bed: None,
            chamber: None,
            slots: Vec::new(),
            camera_available: false,
            message: None,
            updated_at: now_iso(),
            live: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PrinterEvent {
    Status {
        status: PrinterStatus,
    },
    #[serde(rename_all = "camelCase")]
    JobFinished {
        printer_id: String,
        job_name: String,
        ok: bool,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        printer_id: String,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobKind {
    #[serde(rename = "gcode")]
    Gcode,
    #[serde(rename = "gcode.3mf")]
    Gcode3mf,
    #[serde(rename = "bgcode")]
    Bgcode,
}

#[derive(Clone)]
pub struct JobFile {
    pub name: String,
    pub kind: JobKind,
    pub data: Vec<u8>,
    pub sha256: String,
}

impl fmt::Debug for JobFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JobFile")
            .field("name", &self.name)
            .field("bytes", &self.data.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub printer_id: String,
    pub path: String,
    pub name: String,
    /// SHA-256 of the content, when the file went up through SlicerX. Start approvals bind to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bed_leveling: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow_calibration: Option<bool>,
    /// Bambu Lab motion (vibration) compensation before the print.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vibration_compensation: Option<bool>,
    /// Record a timelapse. Needs storage in the printer (Bambu Lab, Elegoo).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timelapse: Option<bool>,
    /// Bambu Lab first layer inspection (X1 series).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_layer_inspection: Option<bool>,
    /// Filament to printer slot id. Keys are 0 based filament indexes: key 0 is the first
    /// filament (the G-code's `T0`, shown to people as filament 1, and the first entry of a Bambu
    /// `ams_mapping`). Slot ids are what the printer reports, such as "A3", or "1" for the
    /// external spool. Only a driver that can make the printer follow the map accepts one; the
    /// others refuse the start (see [`StartOptions::refuse_slot_map`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_map: Option<BTreeMap<u32, String>>,
}

impl StartOptions {
    /// Whether the start carries a slot map with at least one entry.
    pub fn has_slot_map(&self) -> bool {
        self.slot_map.as_ref().is_some_and(|m| !m.is_empty())
    }

    /// Refuses a start whose slot map the printer would not follow. The card showed the map as
    /// part of what the person approved, so a start that would print from other slots is
    /// refused rather than started as if the map were not there.
    pub(crate) fn refuse_slot_map(&self, plugin: &str) -> crate::Result<()> {
        if self.has_slot_map() {
            return Err(crate::Error::not_supported(
                plugin,
                "a filament slot map (this printer takes filament as its G-code says; start without one)",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Status,
    Events,
    Upload,
    Start,
    Pause,
    Resume,
    Cancel,
    Camera,
    FilamentSlots,
    GcodeConsole,
}

pub type Capabilities = Vec<Capability>;

/// How a driver reaches one printer. Secrets are never in here: `credential_ref` names an
/// entry that [`Secrets`] resolves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterConfig {
    pub id: String,
    pub name: String,
    pub plugin: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls: Option<bool>,
    /// Polling interval for drivers without a push channel. Default 1000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_ms: Option<u64>,
    /// Bambu FTPS port override (default 990). Tests point it at the mock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ftp_port: Option<u16>,
    /// Camera port override (Bambu default 6000, Creality default 8080).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_port: Option<u16>,
    /// Creality WebSocket port (default 9999).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ws_port: Option<u16>,
    /// Creality REST port for `/info` and uploads (default 80).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_port: Option<u16>,
    /// Forces a protocol for plugins with two (`moonraker` or `native` for Creality,
    /// `moonraker` or `luban` for Snapmaker). Unset means probe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// User name for HTTP digest login (PrusaLink). The secret is then the password.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// A camera that is not the printer's own: `rtsp://`, `rtsps://` or an `http://` MJPEG URL on the
    /// local network, without a user name in it. Used in place of the connector's camera.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_url: Option<String>,
    /// Secret holding `user:password` for `camera_url`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_credential_ref: Option<String>,
    /// Bambu Lab RTSPS port override (default 322). Tests point it at the mock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtsp_port: Option<u16>,
}

impl PrinterConfig {
    pub fn poll_interval(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.poll_ms.unwrap_or(1000).max(50))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPrinter {
    pub plugin: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// Firmware version, when the announcement says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    /// Bambu Lab: true while LAN Only Mode is on, false while the printer uses Bambu Cloud.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lan_only: Option<bool>,
    /// Bambu Lab: true while the printer is bound to a Bambu account (SSDP `DevBind` `occupied`),
    /// false while it is free.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound: Option<bool>,
    /// The announcement offers HTTPS on `port` (Moonraker's `https_port`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls: Option<bool>,
    /// An identity that survives an address change, for printers that announce one without a
    /// serial number (Moonraker's instance `uuid`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
}

/// What a printer reports about its own hardware: read once, when it is added, so setup asks for
/// nothing the printer already knows. Every field is absent when the printer did not say.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterHardware {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    /// One per extruder, in tool order (T0 first).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extruders: Vec<ExtruderInfo>,
    /// AMS units, MMUs and external spools, with what each slot holds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filament_units: Vec<FilamentUnit>,
    /// Bambu Lab: false when the printer wants signed commands, which means Developer Mode is off and
    /// it will refuse prints from SlicerX.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_mode: Option<bool>,
    /// Bambu Lab: whether a micro SD card is in. An X1 needs one to start a print over the network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sd_card: Option<bool>,
    /// The printable volume, X, Y and Z in mm, from the printer's own travel limits (Klipper).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_volume_mm: Option<[f64; 3]>,
    /// The diameter of a round bed in mm (delta printers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bed_diameter_mm: Option<f64>,
    /// Klipper's kinematics: `cartesian`, `corexy`, `delta` and so on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinematics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_velocity_mm_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_accel_mm_s2: Option<f64>,
    /// The name the printer has on the network, which outlives an address change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtruderInfo {
    /// Tool number.
    pub tool: u8,
    /// `left` or `right` on printers with two nozzles side by side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nozzle_diameter_mm: Option<f64>,
    /// `brass`, `hardened-steel`, `stainless-steel` or `tungsten-carbide`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nozzle_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high_flow: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilamentUnit {
    /// The slot letter the unit's slots use (`A` for slots A1 to A4), or `external`.
    pub id: String,
    /// `ams`, `ams-lite`, `ams-2-pro`, `ams-ht`, `mmu`, `qidi-box`, `cfs` (Creality), `toolchanger`
    /// (one spool per toolhead, Snapmaker U1) or `external`.
    pub kind: String,
    /// The tool the unit feeds, when the printer has more than one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<u8>,
    pub slots: Vec<FilamentSlot>,
}

/// A JPEG or PNG frame from the printer camera.
#[derive(Debug, Clone)]
pub struct Image {
    pub content_type: String,
    pub data: Vec<u8>,
}

/// Resolves credentials by reference. The desktop app backs it with the OS keychain.
/// Implementations must not log values.
pub trait Secrets: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
}

/// Whole seconds from a JSON float. Negative and non-finite values become 0.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub(crate) fn secs(v: f64) -> u64 {
    if v.is_finite() && v > 0.0 { v as u64 } else { 0 }
}

/// Lowercase hex of a byte slice.
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

pub(crate) fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format_iso(secs)
}

/// Civil date from a Unix timestamp (Howard Hinnant's algorithm), to avoid a date crate.
pub(crate) fn format_iso(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formatting() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso(1_700_000_000), "2023-11-14T22:13:20.000Z");
    }

    #[test]
    fn status_serializes_like_the_ts_contract() {
        let mut s = PrinterStatus::offline("bay-5");
        s.updated_at = "t".into();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["printerId"], "bay-5");
        assert_eq!(v["state"], "offline");
        assert_eq!(v["cameraAvailable"], false);
        assert!(v.get("jobName").is_none());
    }
}

/// A part cooling, auxiliary or chamber fan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FanKind {
    Part,
    Aux,
    Chamber,
}

/// One change to a print that is running. The hub checks it against the safe limits before a
/// driver sees it ([`Adjustment`] values are what the person approved, never clamped silently).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Adjustment {
    /// Fan speed, 0 to 100 percent.
    Fan { fan: FanKind, percent: u8 },
    /// Speed factor in percent of the sliced speeds.
    Speed { percent: u16 },
    /// Nozzle target in degrees Celsius.
    Nozzle { celsius: u16 },
    /// Bed target in degrees Celsius.
    Bed { celsius: u16 },
}

impl Adjustment {
    /// The Marlin and Klipper G-code for printers that take it (Moonraker, OctoPrint). `None` for a
    /// fan the generic commands cannot name.
    pub fn marlin_gcode(&self) -> Option<String> {
        match *self {
            Adjustment::Fan {
                fan: FanKind::Part,
                percent,
            } => Some(format!(
                "M106 S{}",
                (u32::from(percent.min(100)) * 255 + 50) / 100
            )),
            Adjustment::Fan { .. } => None,
            Adjustment::Speed { percent } => Some(format!("M220 S{percent}")),
            Adjustment::Nozzle { celsius } => Some(format!("M104 S{celsius}")),
            Adjustment::Bed { celsius } => Some(format!("M140 S{celsius}")),
        }
    }
}

/// What a filament slot holds, written to the printer as Bambu Studio writes an AMS slot it edits
/// (`ams_filament_setting`). `slot` is the slot's id in [`FilamentSlot`] ("A1", "1" for the external
/// spool); `filament_id` is the filament preset's `filament_id` ("GFA00"), which the printer keeps as
/// `tray_info_idx`; `color` is `#rrggbb`; the nozzle range is the preset's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotSetting {
    pub slot: String,
    pub filament_id: String,
    pub material: String,
    pub color: String,
    pub nozzle_temp_min: u16,
    pub nozzle_temp_max: u16,
}

impl SlotSetting {
    /// What is wrong with the setting, in words, or `None`. Checked before any approval is used.
    #[must_use]
    pub fn problem(&self) -> Option<&'static str> {
        let id_ok = |s: &str, max: usize| {
            !s.is_empty()
                && s.len() <= max
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-+ .".contains(&b))
        };
        if !id_ok(&self.slot, 4) {
            Some("the slot is not one the printer reports")
        } else if !id_ok(&self.filament_id, 16) {
            Some("the filament has no preset id the printer knows")
        } else if !id_ok(&self.material, 24) {
            Some("the material type is empty or too long")
        } else if !(self.color.len() == 7
            && self.color.starts_with('#')
            && self.color[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        {
            Some("the color is not #rrggbb")
        } else if !(150..=350).contains(&self.nozzle_temp_min)
            || !(150..=350).contains(&self.nozzle_temp_max)
            || self.nozzle_temp_min > self.nozzle_temp_max
        {
            Some("the nozzle range is 150 to 350 °C, low before high")
        } else {
            None
        }
    }
}

/// What the printer says about one stored file. `modified` is seconds since the epoch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<f64>,
}

/// A file stored on the printer. `modified` is seconds since the epoch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFile {
    /// The path to give `start`, relative to the printer's G-code folder.
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<f64>,
}

/// One finished or interrupted print from the printer's own history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintRecord {
    pub name: String,
    /// `completed`, `canceled` or `failed`.
    pub outcome: String,
    /// What the printer called it, when that says more (for example `klippy_shutdown`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Seconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    /// Filament used, in millimeters of filament, when reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filament_mm: Option<f64>,
}

/// An object of the running print that can be skipped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintObject {
    /// What `skip_object` takes: the label the G-code carries.
    pub id: String,
    pub name: String,
    pub skipped: bool,
    /// Where it sits on the bed (X, Y in mm), when the printer says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<[f64; 2]>,
    /// The footprint outline in bed coordinates, when the printer says.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub polygon: Vec<[f64; 2]>,
}

/// A problem the printer reports about itself, in words a person can act on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterIssue {
    /// The printer's own code, for looking it up (Bambu HMS: `0300_0100_0001_0001`).
    pub code: String,
    /// `fatal`, `serious`, `common` or `info`.
    pub severity: String,
    /// Which part reported it: the AMS, the toolhead, the main board.
    pub module: String,
    pub text: String,
    /// Where the maker explains this code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help_url: Option<String>,
    /// Left over from a job that is no longer running: the printer still lists it, but it is history,
    /// not a problem with the printer now.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stale: bool,
}

/// Where a jog moves, relative to where the head is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JogAxis {
    X,
    Y,
    Z,
}

/// Where the head is and which axes are homed, for the axes the printer reports. Index 0 is X, 1 is
/// Y, 2 is Z. A `None` means the printer does not say.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homed: Option<[bool; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<[f64; 3]>,
    /// The lowest and highest position each axis may reach, in mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<[f64; 3]>,
}
