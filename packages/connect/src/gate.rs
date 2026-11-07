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

/// The part of a line a firmware reads: everything before the first `;`. Only `;` starts a comment on
/// every firmware a host drives; Klipper reads no comment in parentheses.
fn code_part(line: &str) -> &str {
    line.split(';').next().unwrap_or("")
}

/// Whether the guard cannot be sure how a firmware reads the line, so it fails closed: a `(` or `)`
/// (Marlin and RepRapFirmware skip a parenthesized comment, Klipper runs `(G28` as G28), a `*` with
/// anything but a checksum after it, or text left with no command (a bare `N10`).
fn opaque(line: &str) -> bool {
    let code = code_part(line);
    if code.contains(['(', ')']) {
        return true;
    }
    if let Some(star) = code.find('*') {
        let sum = code[star + 1..].trim();
        if sum.is_empty() || !sum.bytes().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    !code.trim().is_empty() && command_word(&command_text(line)).is_none()
}

/// One G-code line as firmware reads it: a comment (`;` to the end) and a checksum (`*71`) dropped, a
/// line number skipped with any spacing (`N10`, `N 10`, or a bare `N` before a command), upper case,
/// trimmed.
fn command_text(line: &str) -> String {
    let text = code_part(line).to_ascii_uppercase();
    let mut rest = text.trim();
    if let Some(star) = rest.find('*') {
        rest = rest[..star].trim_end();
    }
    if let Some(after) = rest.strip_prefix('N') {
        let after = after.trim_start();
        let digits = after.trim_start_matches(|c: char| c.is_ascii_digit());
        if digits.len() < after.len() || digits.starts_with(['G', 'M', 'T']) {
            rest = digits.trim_start();
        }
    }
    rest.to_owned()
}

/// The command of a line read by [`command_text`] and the rest of it: a letter code with its number as
/// firmware reads it (`G28`, `G29.1`, `M104`, `T1`; a space after the letter and leading zeros dropped),
/// or an extended command or macro name (`BED_MESH_CALIBRATE`). `None` for a line with no command.
fn command_word(text: &str) -> Option<(String, &str)> {
    let first = text.chars().next()?;
    if matches!(first, 'G' | 'M' | 'T') {
        let after = text[1..].trim_start();
        let len = after
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(after.len());
        let digits = &after[..len];
        if digits.starts_with(|c: char| c.is_ascii_digit()) {
            let (whole, frac) = digits.split_once('.').unwrap_or((digits, ""));
            let whole = whole.trim_start_matches('0');
            let whole = if whole.is_empty() { "0" } else { whole };
            let code = if frac.is_empty() {
                format!("{first}{whole}")
            } else {
                format!("{first}{whole}.{frac}")
            };
            return Some((code, after[len..].trim_start()));
        }
    }
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    Some((text[..end].to_owned(), text[end..].trim_start()))
}

/// The parameters of a G or M code, read by letter as firmware reads them, not by word: `E0Z50` is
/// `E` 0 and `Z` 50, as is `E0 Z50`. `None` when the rest holds anything but letters, numbers, signs,
/// points and spaces, which the guard does not try to read.
fn params_by_letter(rest: &str) -> Option<Vec<(char, String)>> {
    let mut out: Vec<(char, String)> = Vec::new();
    for c in rest.chars() {
        if c.is_ascii_alphabetic() {
            out.push((c, String::new()));
        } else if c.is_ascii_digit() || matches!(c, '.' | '-' | '+') {
            out.last_mut()?.1.push(c);
        } else if !c.is_whitespace() {
            return None;
        }
    }
    Some(out)
}

/// Whether one G-code line homes the printer: a `G28`, however it is written (any case, spaces, a line
/// number, leading zeros, a decimal such as `G28.1`, axis words with or without a space, or a comment
/// after it). Homing Z brings the nozzle down to the plate, so a host sends such a line only under its
/// home rules. Errs toward yes: a line that reads as G28 to any firmware counts, and so does any line
/// with a parenthesis, which Klipper reads as a command where other firmware sees a comment.
pub fn homes_axes(line: &str) -> bool {
    code_part(line).contains(['(', ')'])
        || command_word(&command_text(line))
            .is_some_and(|(code, _)| code == "G28" || code.starts_with("G28."))
}

/// The command of one line as firmware reads it (as [`moves_axes`] reads it): `G1` for `g01 x1`,
/// `RESUME` for `n 10 resume`. `None` for a line with no command (empty, or only a comment).
pub fn command_name(line: &str) -> Option<String> {
    command_word(&command_text(line)).map(|(code, _)| code)
}

/// Whether one line is the plain filament change: `M600` with nothing but an optional `B` (beeps),
/// however it is written. The firmware parks the head at its own place for the swap and waits for the
/// person, so a host may send it while a print runs or is paused; on an idle or finished printer it
/// still moves the head like any other line that moves. An M600 that names a park position or lengths
/// (`X`, `Y`, `Z`, `E`, `U`, `L`) is not this: it moves where it says, so it is motion.
pub fn changes_filament(line: &str) -> bool {
    if opaque(line) {
        return false;
    }
    let text = command_text(line);
    match command_word(&text) {
        Some((code, rest)) if code == "M600" => {
            params_by_letter(rest).is_some_and(|p| p.iter().all(|(l, _)| *l == 'B'))
        }
        _ => false,
    }
}

/// When a host may send one raw G-code line: the motion guard's classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineRule {
    /// Heater and fan targets, messages and reports: at any time, a running print included.
    AnyTime,
    /// Cannot move the head, but changes how a running print goes (extrusion and positioning modes, the
    /// E frame, speed and flow factors, dwells and waits): only while no print runs.
    NoPrint,
    /// Can move the head, or the guard cannot tell: only while the printer is idle or finished, and only
    /// onto a plate known to be clear or said to be clear.
    Motion,
    /// Never as a raw line, for the reason given.
    Refused(&'static str),
}

/// Heater and fan targets, messages, reports, auto reports and a beep: they cannot move the head and do
/// not change what a running print does.
const ANY_TIME_M: &[&str] = &[
    "M104", "M105", "M106", "M107", "M114", "M115", "M117", "M118", "M119", "M140", "M141", "M155", "M300",
    "M503",
];

/// Klipper commands that cannot move the head: heaters, fans, messages and reports.
const ANY_TIME_MACROS: &[&str] = &[
    "SET_HEATER_TEMPERATURE",
    "TURN_OFF_HEATERS",
    "SET_FAN_SPEED",
    "RESPOND",
    "STATUS",
    "QUERY_ENDSTOPS",
    "GET_POSITION",
];

/// Codes that cannot move the head but change a running print: millimeter units and absolute
/// positioning, progress, extrusion modes, the line number, waits for the bed, the chamber and moves.
/// `G4`, `G92`, `M220` and `M221` are read on their own.
const NO_PRINT_CODES: &[&str] = &["G21", "G90", "M73", "M82", "M83", "M110", "M190", "M191", "M400"];

/// Longest dwell a raw `G4` may ask for, in seconds.
const MAX_DWELL_S: f64 = 60.0;

/// The speed and flow factors a raw `M220` or `M221` may set, in percent: the running print adjustment's
/// speed limits.
const FACTOR_PERCENT: std::ops::RangeInclusive<f64> = 50.0..=150.0;

/// When a host may send `line` ([`LineRule`]). It fails closed: a line moves unless it is read as one
/// command on the short lists of lines that cannot. So moves and homes, probing and leveling in every
/// firmware's form (`G29` and its Bambu Lab decimals, `G30`, `G32`, `G34`, Prusa's `G80` and `G81`, `M48`,
/// Klipper's `PROBE`, `BED_MESH_CALIBRATE`, `QUAD_GANTRY_LEVEL`, `Z_TILT_ADJUST`, `SCREWS_TILT_CALCULATE`),
/// start macros, position and mode changes, `M109` (which picks a tool on some firmware), filament and
/// tool changes, a message that carries a host action, every code or macro the lists do not know, and
/// any line the guard cannot read as one command (a parenthesis, text after a checksum) all count.
#[must_use]
pub fn line_rule(line: &str) -> LineRule {
    let code = code_part(line);
    if code.trim().is_empty() {
        return LineRule::AnyTime;
    }
    if opaque(line) {
        return LineRule::Motion;
    }
    let text = command_text(line);
    let Some((name, rest)) = command_word(&text) else {
        return LineRule::Motion;
    };
    let name = name.as_str();
    // A message that carries a host action (`action:resume`, `action:cancel`) can resume or stop a print
    // through the host, around the resume and pause rules.
    if matches!(name, "M117" | "M118" | "RESPOND") {
        return if rest.contains("ACTION:") {
            LineRule::Motion
        } else {
            LineRule::AnyTime
        };
    }
    if ANY_TIME_MACROS.contains(&name) {
        return LineRule::AnyTime;
    }
    if name == "TEMPERATURE_WAIT" {
        return LineRule::NoPrint;
    }
    if !(name.starts_with('G') || name.starts_with('M')) {
        return LineRule::Motion;
    }
    let Some(params) = params_by_letter(rest) else {
        return LineRule::Motion;
    };
    let letters = |allowed: &[char]| params.iter().all(|(l, _)| allowed.contains(l));
    let value = |p: &(char, String)| p.1.parse::<f64>().ok();
    match name {
        // Only the extruder: every parameter letter is E. Any other axis, or none (which zeroes every
        // axis), moves the frame.
        "G92" => {
            if !params.is_empty() && letters(&['E']) {
                LineRule::NoPrint
            } else {
                LineRule::Motion
            }
        }
        "G4" => match params.as_slice() {
            [] => LineRule::NoPrint,
            [p @ ('S' | 'P', _)] => match value(p) {
                Some(v) if v >= 0.0 && (if p.0 == 'S' { v } else { v / 1000.0 }) <= MAX_DWELL_S => {
                    LineRule::NoPrint
                }
                _ => LineRule::Refused("a raw dwell (G4) is at most 60 seconds, given as one S or P value"),
            },
            _ => LineRule::Refused("a raw dwell (G4) is at most 60 seconds, given as one S or P value"),
        },
        "M220" | "M221" => match params.as_slice() {
            [p @ ('S', _)] if value(p).is_some_and(|v| FACTOR_PERCENT.contains(&v)) => LineRule::NoPrint,
            _ => LineRule::Refused(
                "a raw speed or flow factor (M220, M221) is one S value from 50 to 150 percent",
            ),
        },
        _ if NO_PRINT_CODES.contains(&name) => LineRule::NoPrint,
        _ if ANY_TIME_M.contains(&name) => LineRule::AnyTime,
        _ => LineRule::Motion,
    }
}

/// Whether one G-code line can move the head, the motion guard's test: [`line_rule`] is
/// [`LineRule::Motion`].
pub fn moves_axes(line: &str) -> bool {
    line_rule(line) == LineRule::Motion
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
            assert_eq!(line_rule(line), LineRule::Motion, "{line}");
            assert!(moves_axes(line), "{line}");
        }
    }

    // Lines a naive reader takes for still ones but a firmware runs as moves fail closed too.
    #[test]
    fn a_line_that_reads_as_still_only_to_a_naive_reader_is_motion() {
        for line in [
            // Parentheses are no comment to Klipper: "(G28" runs as G28. Any "(" or ")" fails closed.
            "(G28",
            "(G28 X)",
            "(G28)",
            "(G1 Z-5 A)",
            "(G1 Z-5)",
            "(G1 X5",
            "(G29",
            "( G1 Z-50",
            "( G1 X0 Y0 Z-50",
            "( x ) G29",
            "(PRINT_START",
            "M117 (",
            "M104 S200 (hot)",
            "(only a comment)",
            // Text the guard cannot read as one command, a checksum with more after it.
            "N10",
            "*71",
            "M104 S200*G28",
            "M104 S200 * 5 G28",
            // G92 reads its parameters by letter, not by word: anything but E moves the frame.
            "G92 E0Z0",
            "G92 E0Z50",
            "G92E0X5",
            "G92 E0 Y1",
            "G92 E0.5Z10",
            "G92 E0 Z0",
            "G92 EZ0",
            "G92 E0X0Y0",
            "G92 E0#Z",
            // A tool is picked on M109 on some firmware, which runs the tool change macros.
            "M109 S210",
            "M109 S200 T1",
            // A host action through a message line can resume a paused print.
            "M118 A1 action:resume",
            "M118 //action:cancel",
            "RESPOND TYPE=command MSG=action:resume",
            "respond type=command msg=Action:Cancel",
            "M117 action:resume",
            // An M600 with any parameter other than B parks or unloads where it says: motion, not the plain swap.
            "M600 X0 Y0 Z0",
            "M600 Z-50",
            "M600 E-500 U500 L500",
            // Relative positioning.
            "G91",
        ] {
            assert_eq!(line_rule(line), LineRule::Motion, "{line}");
            assert!(moves_axes(line), "{line}");
        }
    }

    // Heater and fan targets, messages and reports go at any time, a running print included.
    #[test]
    fn a_heater_fan_message_or_report_line_goes_at_any_time() {
        for line in [
            "M104 S200",
            "m104 s0",
            "M104 S200 T0",
            "M140 S60",
            "M141 S40",
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
            "M300 S440 P200",
            "M503",
            "N5 M104 S0",
            "N 5 M106",
            "N10 M104 S200*71",
            "; a comment",
            "   ; M600",
            "SET_HEATER_TEMPERATURE HEATER=extruder TARGET=200",
            "TURN_OFF_HEATERS",
            "SET_FAN_SPEED FAN=aux SPEED=0.5",
            "RESPOND MSG=hi",
            "STATUS",
            "QUERY_ENDSTOPS",
            "GET_POSITION",
        ] {
            assert_eq!(line_rule(line), LineRule::AnyTime, "{line}");
            assert!(!moves_axes(line), "{line}");
        }
    }

    // Lines that cannot move the head but change how a running print goes (extrusion and positioning
    // modes, the E frame, speed and flow factors, waits): only while no print runs.
    #[test]
    fn a_line_that_changes_a_running_print_waits_for_no_print() {
        for line in [
            "M73 P10",
            "M82",
            "M83",
            "M110 N0",
            "M220 S100",
            "M220 S50",
            "M221 S150",
            "M190 S60",
            "M191 S40",
            "M400",
            "G4 P100",
            "G4 S1",
            "G4 S60",
            "G4 P60000",
            "G90",
            "G21",
            "G92 E0",
            "g92 e0",
            "G92 E0   ",
            "G92 E-1.5",
            "TEMPERATURE_WAIT SENSOR=extruder MINIMUM=200",
        ] {
            assert_eq!(line_rule(line), LineRule::NoPrint, "{line}");
            assert!(!moves_axes(line), "{line}");
        }
    }

    // A dwell longer than a minute, or a speed or flow factor outside 50 to 150 percent, is never sent raw.
    #[test]
    fn a_long_dwell_or_a_wild_factor_is_refused() {
        for line in [
            "G4 S61",
            "G4 P60001",
            "G4 S1 P1",
            "G4 X1",
            "M220 S1000",
            "M220 S49",
            "M221 S1000",
            "M221 S10",
            "M220",
            "M220 B",
            "M221 S100 T1",
        ] {
            assert!(matches!(line_rule(line), LineRule::Refused(_)), "{line}");
            assert!(!moves_axes(line), "{line}");
        }
    }

    #[test]
    fn a_filament_change_line_reads_as_one_however_it_is_written() {
        for line in [
            "M600",
            "m600",
            "M600 B1",
            "M 600",
            "N 5 M600",
            "M0600 ; swap",
            "n10m600",
            "M600 B3",
        ] {
            assert!(changes_filament(line), "{line}");
            assert!(moves_axes(line), "{line}");
        }
        for line in [
            "M60",
            "M6000",
            "M601",
            "M701",
            "LOAD_FILAMENT",
            "; M600",
            "M117 M600",
            "M600 X0 Y0 Z0",
            "M600 Z-50",
            "M600 E-500 U500 L500",
            "M600 (park)",
            "(M600",
            "M600 B1 X0",
        ] {
            assert!(!changes_filament(line), "{line}");
        }
        assert_eq!(command_name("n 10 resume"), Some("RESUME".to_owned()));
        assert_eq!(
            command_name("exclude_object name=a"),
            Some("EXCLUDE_OBJECT".to_owned())
        );
        assert_eq!(command_name("g01 x1"), Some("G1".to_owned()));
        assert_eq!(command_name("; nothing"), None);
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
            // Klipper reads no comment in parentheses, so a line with one homes as far as the guard knows.
            "(G28",
            "(G28 X)",
            "(G28)",
            "(G1 Z-5 A)",
        ] {
            assert!(homes_axes(line), "{line}");
        }
        for line in [
            "G29", "G280", "G2", "G1 Z5", "M28", "; G28", "M117 G28", "G92 Z0", "", "N28", "G", "N5 M28",
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
