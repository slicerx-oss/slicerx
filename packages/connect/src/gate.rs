// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Minted by the host (sx-permit) after the user approves. Single use. Mirrors
/// `ApprovalToken` in `packages/contracts/src/pilot.ts`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalToken {
    pub request_id: String,
    pub token: String,
    pub expires_at: String,
}

impl std::fmt::Debug for ApprovalToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalToken")
            .field("request_id", &self.request_id)
            .finish_non_exhaustive()
    }
}

/// What a token can authorize. `PluginCall` covers tools of service plugins that change something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Upload,
    Start,
    Pause,
    Resume,
    Cancel,
    Gcode,
    PluginCall,
    /// A change to a running print: fan, speed factor, nozzle or bed temperature.
    Adjust,
}

impl Action {
    /// The name the approval broker knows the action by.
    pub fn side_effect(self) -> &'static str {
        match self {
            Action::Upload => "printer.upload",
            Action::Start => "printer.start",
            Action::Pause => "printer.pause",
            Action::Resume => "printer.resume",
            Action::Cancel => "printer.cancel",
            Action::Gcode => "printer.gcode",
            Action::PluginCall => "plugin.call",
            Action::Adjust => "printer.adjust",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Action::Upload => "upload",
            Action::Start => "start",
            Action::Pause => "pause",
            Action::Resume => "resume",
            Action::Cancel => "cancel",
            Action::Gcode => "gcode",
            Action::PluginCall => "plugin_call",
            Action::Adjust => "adjust",
        }
    }
}

/// Canonical parameter strings, one per host call. They are the canonical JSON (sorted keys,
/// no whitespace) of the same objects the TS side hashes with `hashParams` in
/// `@slicerx/contracts`, so an adapter can compute `sha256(params)` and call
/// `sx_permit` with the hash. Shapes:
///
/// - upload: `{printerId, name, sha256}`
/// - start: `{printerId, name, opts}` (`opts` is `{}` when empty), plus `sha256` when the file's
///   content hash is known (it went up through SlicerX), so a token covers that content only
/// - pause, resume, cancel: `{printerId}`
/// - gcode: `{printerId, line}`
/// - plugin call: `{pluginId, tool, input}` (`tool` without the `<id>.` prefix)
/// - adjust: `{printerId, change}` with `change` as [`crate::Adjustment`] serializes it, or
///   `{printerId, slot}` with `slot` as [`crate::SlotSetting`] serializes it
pub mod params {
    use serde_json::{Value, json};

    use crate::types::{RemoteFile, StartOptions};

    fn canon(v: &Value) -> String {
        // serde_json keeps object keys sorted (no `preserve_order`), and `to_string` has no
        // whitespace, which is the canonical form.
        v.to_string()
    }

    pub fn upload(printer: &str, name: &str, sha256: &str) -> String {
        canon(&json!({ "printerId": printer, "name": name, "sha256": sha256 }))
    }

    pub fn start(printer: &str, file: &RemoteFile, opts: &StartOptions) -> String {
        let opts = serde_json::to_value(opts).unwrap_or_else(|_| json!({}));
        match &file.sha256 {
            Some(sha) => {
                canon(&json!({ "printerId": printer, "name": file.name, "opts": opts, "sha256": sha }))
            }
            None => canon(&json!({ "printerId": printer, "name": file.name, "opts": opts })),
        }
    }

    pub fn printer(printer: &str) -> String {
        canon(&json!({ "printerId": printer }))
    }

    pub fn gcode(printer: &str, line: &str) -> String {
        canon(&json!({ "printerId": printer, "line": line }))
    }

    pub fn adjust(printer: &str, change: &crate::types::Adjustment) -> String {
        let change = serde_json::to_value(change).unwrap_or(Value::Null);
        canon(&json!({ "printerId": printer, "change": change }))
    }

    /// The chamber light switched on or off, as a `printer.adjust`.
    pub fn light(printer: &str, on: bool) -> String {
        canon(&json!({ "printerId": printer, "light": on }))
    }

    /// A filament slot written to the printer, approved as a `printer.adjust`.
    pub fn slot(printer: &str, setting: &crate::types::SlotSetting) -> String {
        let slot = serde_json::to_value(setting).unwrap_or(Value::Null);
        canon(&json!({ "printerId": printer, "slot": slot }))
    }

    pub fn plugin(plugin: &str, tool: &str, input: &Value) -> String {
        canon(&json!({ "pluginId": plugin, "tool": tool, "input": input }))
    }
}

/// Longest G-code line a person may approve: short enough that every approval card shows it
/// whole (`WorkSummary` in packages/pair allows the same).
pub const MAX_GCODE_LINE: usize = 96;

/// Why `line` is not one G-code command a card can show whole, or `None` when it is: 1 to
/// [`MAX_GCODE_LINE`] printable ASCII characters. A line break would let a long first command hide
/// a second one that Moonraker and OctoPrint run as well; other control characters and non-ASCII
/// text (bidirectional overrides, zero-width marks) can change what the card appears to say.
#[must_use]
pub fn gcode_line_problem(line: &str) -> Option<&'static str> {
    if line.trim().is_empty() {
        Some("the G-code line is empty")
    } else if line.len() > MAX_GCODE_LINE {
        Some("one G-code line of at most 96 characters at a time")
    } else if !line.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        Some("one G-code line at a time, printable ASCII only (no line breaks or control characters)")
    } else {
        None
    }
}

/// Whether one G-code line homes the printer: a `G28`, however it is written (any case, spaces, a line
/// number, leading zeros, a decimal such as `G28.1`, axis words with or without a space, or a comment
/// after it). Homing Z brings the nozzle down to the plate, so a host sends such a line only under its
/// home rules. Errs toward yes: a line that reads as G28 to any firmware counts.
pub fn homes_axes(line: &str) -> bool {
    // Comments: `;` to the end of the line, and `( ... )`.
    let mut text = String::with_capacity(line.len());
    let mut depth = 0_u32;
    for c in line.chars() {
        match c {
            ';' if depth == 0 => break,
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => text.push(c.to_ascii_uppercase()),
            _ => {}
        }
    }
    let mut rest = text.trim_start();
    // A line number (`N10 G28`, `N 10 G28`), with any spacing around its digits.
    if let Some(after) = rest.strip_prefix('N') {
        rest = after
            .trim_start()
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .trim_start();
    }
    let Some(after) = rest.strip_prefix('G') else {
        return false;
    };
    let after = after.trim_start();
    let whole: String = after.chars().take_while(char::is_ascii_digit).collect();
    !whole.is_empty() && whole.trim_start_matches('0') == "28"
}

/// [`gcode_line_problem`] as a driver error. Every driver calls it before the token check, so one
/// call sends one command whatever the caller let through.
pub(crate) fn one_gcode_line(printer: &str, line: &str) -> Result<()> {
    gcode_line_problem(line).map_or(Ok(()), |why| Err(Error::protocol(printer, why)))
}

/// Verifies and consumes an approval token. Every driver calls it before the first byte of
/// a side effect leaves the machine. `params` is a short description of the target of the
/// call, the canonical JSON built by [`params`], so a token for one target fails for another.
///
/// The app implements this over `sx_permit::ApprovalBroker::verify`.
pub trait ApprovalGate: Send + Sync {
    fn check(&self, token: &ApprovalToken, action: Action, printer: &str, params: &str) -> Result<()>;
}

/// In-process gate for tests and the demo: mints single-use tokens bound to an action,
/// a printer and a parameter string, valid for five minutes.
#[derive(Default)]
pub struct MemoryGate {
    inner: Mutex<MemoryGateInner>,
}

#[derive(Default)]
struct MemoryGateInner {
    counter: u64,
    live: HashMap<String, (Action, String, String, Instant)>,
}

impl MemoryGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mint(&self, action: Action, printer: &str, params: &str) -> ApprovalToken {
        let mut g = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        g.counter += 1;
        let token = format!("mem-{}-{}", g.counter, action.as_str());
        g.live.insert(
            token.clone(),
            (
                action,
                printer.to_owned(),
                params.to_owned(),
                Instant::now() + Duration::from_secs(300),
            ),
        );
        ApprovalToken {
            request_id: format!("req-{}", g.counter),
            token,
            expires_at: String::new(),
        }
    }
}

impl ApprovalGate for MemoryGate {
    fn check(&self, token: &ApprovalToken, action: Action, printer: &str, params: &str) -> Result<()> {
        let bad = |detail: &str| Error::ApprovalInvalid {
            action: action.as_str().to_owned(),
            detail: detail.to_owned(),
        };
        if token.token.is_empty() {
            return Err(Error::ApprovalRequired {
                action: action.as_str().to_owned(),
            });
        }
        let mut g = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some((a, p, prm, exp)) = g.live.remove(&token.token) else {
            return Err(bad("unknown or already used"));
        };
        if exp < Instant::now() {
            return Err(bad("expired"));
        }
        if a != action {
            return Err(bad("minted for another action"));
        }
        if p != printer {
            return Err(bad("minted for another printer"));
        }
        if prm != params {
            return Err(bad("minted for other parameters"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The motion guard fails closed: a line moves the head unless it is on the short list of lines that
    // cannot (heaters, fans, messages, reports, waits), however it is written.
    #[test]
    fn a_line_that_can_move_the_head_reads_as_motion_however_it_is_written() {
        for line in [
            // Moves and homes.
            "G0 X10",
            "G1 Z-5",
            "g1 x1",
            "G2 X1 Y1 I1",
            "G3 X1 Y1 J1",
            "G00 Z1",
            "G 1 Z1",
            "G28",
            "g28 z",
            // Probing and leveling, by code: Marlin, RepRap, Prusa and Bambu Lab forms.
            "G29",
            "g29",
            "G29.1 Z0.2",
            "G29.2 S1",
            "G29 ; mesh",
            "N 10 G29",
            "n10g29",
            "\tG29",
            "G 29",
            "G030",
            "G30",
            "G31",
            "G32",
            "G34",
            "G80",
            "G81",
            "M48",
            "M48 P10",
            "G38.2 Z-10",
            "G12",
            "G27",
            "G60",
            "G61",
            // Probing and leveling macros on Klipper.
            "BED_MESH_CALIBRATE",
            "bed_mesh_calibrate PROFILE=default",
            "PROBE",
            "probe",
            "PROBE_CALIBRATE",
            "PROBE_ACCURACY",
            "QUAD_GANTRY_LEVEL",
            "Z_TILT_ADJUST",
            "SCREWS_TILT_CALCULATE",
            "Z_ENDSTOP_CALIBRATE",
            "BED_SCREWS_ADJUST",
            "DELTA_CALIBRATE",
            "N 5 Z_TILT_ADJUST",
            "BED_MESH_PROFILE LOAD=default",
            // Start macros home, level and purge.
            "PRINT_START",
            "START_PRINT BED=60",
            // Position and mode changes that make the next move land somewhere else.
            "G92 Z0",
            "G92 X0 Y0",
            "G92",
            "G91",
            "G20",
            "M84",
            "M18",
            "M17",
            // Filament changes and tool changes move the head.
            "M600",
            "M701",
            "M702",
            "LOAD_FILAMENT",
            "UNLOAD_FILAMENT",
            "T1",
            "T0",
            // Unknown codes and macros fail closed.
            "G999",
            "M999",
            "M1002 gcode_claim_action : 1",
            "FOO_BAR",
            "MY_MACRO X=1",
            "EXCLUDE_OBJECT NAME=a",
            "RESUME",
            "SET_KINEMATIC_POSITION Z=0",
        ] {
            assert!(moves_axes(line), "{line}");
        }
    }

    #[test]
    fn a_line_that_cannot_move_the_head_passes_however_it_is_written() {
        for line in [
            "M104 S200",
            "m104 s0",
            "M109 S210",
            "M140 S60",
            "M190 S60",
            "M141 S40",
            "M191 S40",
            "M106 S128",
            "M107",
            "M117 Printing",
            "M117 G28",
            "M118 hi",
            "M105",
            "M114",
            "M115",
            "M119",
            "M155 S2",
            "M73 P10",
            "M82",
            "M83",
            "M220 S100",
            "M221 S100",
            "M300 S440 P200",
            "M400",
            "M503",
            "N5 M104 S0",
            "N 5 M106",
            "G4 P100",
            "G4 S1",
            "G90",
            "G21",
            "G92 E0",
            "g92 e0",
            "; a comment",
            "(only a comment)",
            "SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200",
            "TURN_OFF_HEATERS",
            "SET_FAN_SPEED FAN=aux SPEED=0.5",
            "TEMPERATURE_WAIT SENSOR=extruder MINIMUM=200",
            "RESPOND MSG=hi",
            "STATUS",
            "QUERY_ENDSTOPS",
            "GET_POSITION",
        ] {
            assert!(!moves_axes(line), "{line}");
        }
    }

    #[test]
    fn a_home_line_reads_as_one_however_it_is_written() {
        for line in [
            "G28",
            "g28",
            "G28 Z",
            "  g28 x y ",
            "G28 ; home all",
            "G28X",
            "N5 G28",
            "n10g28",
            "N 10 G28",
            "n 10 g28",
            "N\t10 G28",
            "N10  G28",
            "N 10\tG28",
            "\tN5 G28",
            "N G28",
            "G0028 Z",
            "G28.1",
            "G 28",
            "(home first) G28",
            "G28*71",
            "G28 W",
        ] {
            assert!(homes_axes(line), "{line}");
        }
        for line in [
            "G29", "G280", "G2", "G1 Z5", "M28", "; G28", "(G28)", "M117 G28", "G92 Z0", "", "N28", "G",
            "N5 M28",
        ] {
            assert!(!homes_axes(line), "{line}");
        }
    }

    #[test]
    fn single_use_and_bound() {
        let g = MemoryGate::new();
        let t = g.mint(Action::Start, "bay-1", "a");
        assert!(
            g.check(&t, Action::Pause, "bay-1", "a").is_err(),
            "wrong action consumed it"
        );
        let t = g.mint(Action::Start, "bay-1", "a");
        assert!(g.check(&t, Action::Start, "bay-2", "a").is_err());
        let t = g.mint(Action::Start, "bay-1", "a");
        assert!(g.check(&t, Action::Start, "bay-1", "b").is_err());
        let t = g.mint(Action::Start, "bay-1", "a");
        g.check(&t, Action::Start, "bay-1", "a").unwrap();
        assert!(
            g.check(&t, Action::Start, "bay-1", "a").is_err(),
            "reuse must fail"
        );
    }
}
