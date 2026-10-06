// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A linter for G-code text that did not come from the engine: custom start,
//! end, layer change, tool change, pause and filament G-code from profiles,
//! projects, library files, MCP calls and mimir. Run it on the rendered
//! text (after placeholders are filled in), once per section.
//!
//! It finds what can damage a printer or leave it in a bad state: heaters and
//! fans past the printer's limits, waits with no target, commands that write
//! the printer's memory or configuration (`M500`, `SAVE_CONFIG`), restart or
//! update firmware, run shell commands, disable safety features, change
//! motion or motor settings, cut power mid-print, leave the wrong coordinate
//! mode set, or leave the heaters on at the end.
//!
//! Errors block. Warnings need a person's yes. Text from an imported file is
//! [`Trust::Untrusted`], where some warnings become errors.

use std::fmt::Write as _;

/// Where the text sits in the file, which decides what it may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Start,
    End,
    LayerChange,
    ToolChange,
    Pause,
    /// Filament change and everything else.
    Other,
}

/// Where the text came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    /// Written by the person on this machine, or shipped with the app.
    Trusted,
    /// From a project, shared preset, library file, MCP call or `mimir`.
    Untrusted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Error,
}

/// One thing the linter found.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Finding {
    /// 1-based line of the section text.
    pub line: u32,
    pub code: &'static str,
    pub severity: Severity,
    pub message: String,
}

/// Limits of the target printer. `None` means unknown, which uses the wider
/// fallback below and is reported as a warning when a value comes close to it.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default)]
    pub nozzle_max_c: Option<f64>,
    #[serde(default)]
    pub bed_max_c: Option<f64>,
    #[serde(default)]
    pub chamber_max_c: Option<f64>,
    /// The hotend has a PTFE liner, which degrades above about 240 C and gives off
    /// fumes that harm people and pet birds. Unknown is treated as not lined.
    #[serde(default)]
    pub ptfe_lined: Option<bool>,
}

/// No consumer hotend or bed goes past these; used when the printer's own limit is unknown.
pub const FALLBACK_NOZZLE_C: f64 = 350.0;
pub const FALLBACK_BED_C: f64 = 150.0;
pub const FALLBACK_CHAMBER_C: f64 = 90.0;

/// What the linter concluded about one section.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Report {
    pub findings: Vec<Finding>,
}

impl Report {
    pub fn errors(&self) -> impl Iterator<Item = &Finding> {
        self.findings.iter().filter(|f| f.severity == Severity::Error)
    }

    pub fn warnings(&self) -> impl Iterator<Item = &Finding> {
        self.findings.iter().filter(|f| f.severity == Severity::Warning)
    }

    /// True when nothing blocks. Warnings still need a person's yes.
    pub fn ok(&self) -> bool {
        self.errors().next().is_none()
    }

    /// True when there is nothing to show a person.
    pub fn clean(&self) -> bool {
        self.findings.is_empty()
    }

    /// One line per finding, for messages.
    pub fn summary(&self) -> String {
        let mut s = String::new();
        for f in &self.findings {
            let _ = writeln!(s, "line {}: {} ({})", f.line, f.message, f.code);
        }
        s
    }
}

/// Commands that write printer memory or configuration, restart or update
/// firmware, run programs or change the machine's calibration. Error for all.
const DENIED: &[(&str, &str, &str)] = &[
    ("M500", "writes settings to the printer's memory", "eeprom_write"),
    (
        "M501",
        "reloads settings from the printer's memory, undoing the profile",
        "eeprom_load",
    ),
    ("M502", "resets the printer to factory settings", "factory_reset"),
    ("M504", "validates or rewrites stored settings", "eeprom_write"),
    (
        "SAVE_CONFIG",
        "rewrites the printer's config file and restarts it",
        "config_save",
    ),
    (
        "SAVE_VARIABLE",
        "writes to the printer's saved variables",
        "config_save",
    ),
    (
        "FIRMWARE_RESTART",
        "restarts the printer's firmware",
        "firmware_restart",
    ),
    (
        "RESTART",
        "restarts the printer's host software",
        "firmware_restart",
    ),
    ("M999", "restarts the printer after an error", "firmware_restart"),
    ("M997", "updates the printer's firmware", "firmware_update"),
    ("M112", "is an emergency stop", "emergency_stop"),
    ("M851", "changes the probe offset", "probe_offset"),
    ("M301", "changes the hotend PID values", "pid_change"),
    ("M303", "runs PID autotune", "pid_change"),
    ("M304", "changes the bed PID values", "pid_change"),
    ("M306", "changes the thermal model", "pid_change"),
    ("PID_CALIBRATE", "runs PID autotune", "pid_change"),
    ("M92", "changes steps per millimeter", "steps_change"),
    ("M665", "changes delta geometry", "geometry_change"),
    ("M666", "changes endstop or delta offsets", "geometry_change"),
    ("M906", "changes stepper motor current", "motor_current"),
    ("M907", "changes stepper motor current", "motor_current"),
    ("M913", "changes stepper motor sensitivity", "motor_current"),
    ("M914", "changes stepper motor sensitivity", "motor_current"),
    ("M211", "changes the software endstops", "endstops"),
    ("M32", "starts a file on the printer's storage", "sd_control"),
    ("M28", "writes a file to the printer's storage", "sd_control"),
    ("M29", "writes a file to the printer's storage", "sd_control"),
    ("M30", "deletes a file on the printer's storage", "sd_control"),
    ("M810", "runs a stored G-code macro", "stored_macro"),
    ("M811", "runs a stored G-code macro", "stored_macro"),
    ("M812", "runs a stored G-code macro", "stored_macro"),
    ("M813", "runs a stored G-code macro", "stored_macro"),
    ("M814", "runs a stored G-code macro", "stored_macro"),
    ("M815", "runs a stored G-code macro", "stored_macro"),
    ("M816", "runs a stored G-code macro", "stored_macro"),
    ("M817", "runs a stored G-code macro", "stored_macro"),
    ("M818", "runs a stored G-code macro", "stored_macro"),
    ("M819", "runs a stored G-code macro", "stored_macro"),
    (
        "RUN_SHELL_COMMAND",
        "runs a program on the printer's host",
        "shell",
    ),
    ("SHELL_COMMAND", "runs a program on the printer's host", "shell"),
    (
        "SET_KINEMATIC_POSITION",
        "overrides where the printer thinks it is",
        "position_override",
    ),
    (
        "SET_HEATER_PWM",
        "drives a heater without a temperature control",
        "heater_raw",
    ),
    ("SET_PIN", "drives a pin directly", "pin_write"),
    ("M42", "drives a pin directly", "pin_write"),
    ("M43", "changes pin state", "pin_write"),
    // RepRapFirmware: a file could lock the owner out or take the printer off the network.
    ("M551", "sets the printer's password", "network_change"),
    (
        "M552",
        "changes the printer's network connection",
        "network_change",
    ),
    ("M553", "changes the printer's network mask", "network_change"),
    ("M554", "changes the printer's network gateway", "network_change"),
    ("M587", "adds a Wi-Fi network to the printer", "network_change"),
    (
        "M588",
        "removes a Wi-Fi network from the printer",
        "network_change",
    ),
    ("M589", "changes the printer's access point", "network_change"),
    ("M98", "runs a macro file on the printer", "macro_file"),
];

/// Findings of `DENIED` that stock printer profiles use in their own G-code (the Bambu start
/// sequences save their calibration with `M500` and set soft endstops with `M211`): only warnings for
/// trusted text.
/// Duet start G-code calls its own macros with `M98`, so a profile may too.
const MAKER_SETUP: &[&str] = &["eeprom_write", "eeprom_load", "endstops", "macro_file"];

/// Commands that are legal but change state a person should approve.
const WARNED: &[(&str, &str, &str)] = &[
    ("M413", "changes power loss recovery", "power_loss"),
    ("M206", "changes the home offset", "home_offset"),
    ("M85", "changes the inactivity shutdown timer", "inactivity_timer"),
    ("M81", "turns the printer's power supply off", "power_off"),
    ("M80", "turns the printer's power supply on", "power_on"),
    ("M420", "changes bed leveling state", "leveling_state"),
    ("M290", "changes baby stepping, which moves Z", "babystep"),
    ("M710", "changes the controller fan behavior", "fan_control"),
    ("SET_GCODE_OFFSET", "changes the Z offset", "gcode_offset"),
    (
        "M0",
        "stops the print until someone presses a button",
        "hard_pause",
    ),
    (
        "M1",
        "stops the print until someone presses a button",
        "hard_pause",
    ),
    ("M226", "waits for a pin", "pin_wait"),
    ("M291", "waits for a person to answer a message", "prompt_wait"),
    ("M600", "starts a filament change", "filament_change"),
    ("M601", "pauses the print", "hard_pause"),
    ("PAUSE", "pauses the print", "hard_pause"),
    ("BED_MESH_CLEAR", "clears the bed mesh", "leveling_state"),
    ("SET_VELOCITY_LIMIT", "changes speed limits", "motion_limits"),
];

/// A macro that does the printer's own end sequence, heaters off included.
const END_MACROS: &[&str] = &[
    "PRINT_END",
    "END_PRINT",
    "END_GCODE",
    "TURN_OFF_HEATERS",
    "M81",
    "M2",
];

struct Words<'a> {
    cmd: String,
    params: Vec<(String, &'a str)>,
}

fn parse_line(raw: &str) -> Option<Words<'_>> {
    let code = raw.split(';').next().unwrap_or("").trim();
    if code.is_empty() {
        return None;
    }
    let mut it = code.split_ascii_whitespace();
    let first = it.next()?;
    let mut cmd = first.to_ascii_uppercase();
    // "N123 G1 ..." line numbers and "*57" checksums.
    let rest: Vec<&str> = if cmd.len() > 1
        && cmd.starts_with('N')
        && cmd
            .get(1..)
            .is_some_and(|d| d.chars().all(|c| c.is_ascii_digit()))
    {
        let next = it.next()?;
        cmd = next.to_ascii_uppercase();
        it.collect()
    } else {
        it.collect()
    };
    if let Some((c, _)) = cmd.split_once('*') {
        cmd = c.to_owned();
    }
    let params = rest
        .into_iter()
        .filter_map(|w| {
            if let Some((k, v)) = w.split_once('=') {
                return Some((k.to_ascii_uppercase(), v));
            }
            let mut cs = w.chars();
            let k = cs.next()?;
            let v = w.get(k.len_utf8()..).unwrap_or("");
            // A trailing "*57" is a line checksum.
            let v = v.split('*').next().unwrap_or(v);
            Some((k.to_ascii_uppercase().to_string(), v))
        })
        .collect();
    Some(Words { cmd, params })
}

impl Words<'_> {
    fn param(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
    }

    fn number(&self, key: &str) -> Option<f64> {
        self.param(key).and_then(|v| v.trim().parse().ok())
    }

    fn has(&self, key: &str) -> bool {
        self.params.iter().any(|(k, _)| k == key)
    }
}

/// Lints one section of rendered G-code text.
pub fn lint(text: &str, section: Section, trust: Trust, limits: &Limits) -> Report {
    let mut rep = Report::default();
    let nozzle_max = limits.nozzle_max_c.unwrap_or(FALLBACK_NOZZLE_C);
    let bed_max = limits.bed_max_c.unwrap_or(FALLBACK_BED_C);
    let chamber_max = limits.chamber_max_c.unwrap_or(FALLBACK_CHAMBER_C);
    let push = |rep: &mut Report, line: u32, code: &'static str, severity: Severity, message: String| {
        // Untrusted text: what would only need a yes from the person's own file blocks here.
        let severity = if trust == Trust::Untrusted
            && severity == Severity::Warning
            && WARN_BLOCKS_UNTRUSTED.contains(&code)
        {
            Severity::Error
        } else {
            severity
        };
        rep.findings.push(Finding {
            line,
            code,
            severity,
            message,
        });
    };
    let mut abs_xyz = true;
    let mut rel_e: Option<bool> = None;
    let mut heaters_off = false;
    let mut bed_off = false;
    let mut macro_end = false;
    let mut line_no = 0u32;
    for raw in text.lines() {
        line_no += 1;
        let code_part = raw.split(';').next().unwrap_or("");
        if unrendered(code_part) || code_part.contains('{') || code_part.contains('}') {
            push(
                &mut rep,
                line_no,
                "unrendered_placeholder",
                Severity::Error,
                "has a placeholder that was not filled in".to_owned(),
            );
            continue;
        }
        let Some(w) = parse_line(raw) else { continue };
        let cmd = w.cmd.as_str();
        if let Some((_, why, code)) = DENIED.iter().find(|(c, _, _)| *c == cmd) {
            // A maker's own start and layer G-code sets up its printer with these; the person who
            // trusts the text sees them as warnings, imported text still stops on them.
            let severity = if trust == Trust::Trusted && MAKER_SETUP.contains(code) {
                Severity::Warning
            } else {
                Severity::Error
            };
            push(&mut rep, line_no, code, severity, format!("{cmd} {why}"));
            continue;
        }
        if let Some((_, why, code)) = WARNED.iter().find(|(c, _, _)| *c == cmd) {
            let expected = matches!(
                (cmd, section),
                (
                    "M600" | "M601" | "PAUSE" | "M0" | "M1" | "M291",
                    Section::Pause | Section::Other | Section::ToolChange
                )
            ) || (cmd == "M81" && section == Section::End);
            if !expected {
                push(&mut rep, line_no, code, Severity::Warning, format!("{cmd} {why}"));
            }
        }
        if END_MACROS.contains(&cmd) && section == Section::End {
            macro_end = true;
        }
        match cmd {
            "M104" | "M109" => {
                let t = w.number("S").or_else(|| w.number("R"));
                match t {
                    Some(t) if t > nozzle_max => push(
                        &mut rep,
                        line_no,
                        "nozzle_over_limit",
                        Severity::Error,
                        format!("{cmd} sets the nozzle to {t} C, above the limit of {nozzle_max} C"),
                    ),
                    Some(t) if t < 0.0 => push(
                        &mut rep,
                        line_no,
                        "negative_target",
                        Severity::Error,
                        format!("{cmd} has a negative temperature"),
                    ),
                    Some(t) => {
                        if t == 0.0 && cmd == "M104" {
                            heaters_off = true;
                        }
                        if limits.nozzle_max_c.is_none() && t > 300.0 {
                            push(
                                &mut rep,
                                line_no,
                                "nozzle_limit_unknown",
                                Severity::Warning,
                                format!("{cmd} sets {t} C and the printer's limit is not known"),
                            );
                        }
                    }
                    None if cmd == "M109" => push(
                        &mut rep,
                        line_no,
                        "wait_without_target",
                        Severity::Error,
                        "M109 waits with no S or R target".to_owned(),
                    ),
                    None => {}
                }
            }
            // Bambu's H2C writes the bed target as `D` (its start G-code: `M190 D[bed_temperature_initial_layer_single]`).
            "M140" | "M190" => match w.number("S").or_else(|| w.number("R")).or_else(|| w.number("D")) {
                Some(t) if t > bed_max => push(
                    &mut rep,
                    line_no,
                    "bed_over_limit",
                    Severity::Error,
                    format!("{cmd} sets the bed to {t} C, above the limit of {bed_max} C"),
                ),
                Some(t) if t < 0.0 => push(
                    &mut rep,
                    line_no,
                    "negative_target",
                    Severity::Error,
                    format!("{cmd} has a negative temperature"),
                ),
                Some(t) => {
                    if t == 0.0 && cmd == "M140" {
                        bed_off = true;
                    }
                }
                None if cmd == "M190" => push(
                    &mut rep,
                    line_no,
                    "wait_without_target",
                    Severity::Error,
                    "M190 waits with no S or R target".to_owned(),
                ),
                None => {}
            },
            "M141" | "M191" => match w.number("S").or_else(|| w.number("R")) {
                Some(t) if t > chamber_max => push(
                    &mut rep,
                    line_no,
                    "chamber_over_limit",
                    Severity::Error,
                    format!("{cmd} sets the chamber to {t} C, above the limit of {chamber_max} C"),
                ),
                None if cmd == "M191" => push(
                    &mut rep,
                    line_no,
                    "wait_without_target",
                    Severity::Error,
                    "M191 waits with no S or R target".to_owned(),
                ),
                _ => {}
            },
            "SET_HEATER_TEMPERATURE" => {
                let heater = w.param("HEATER").unwrap_or("").to_ascii_lowercase();
                let t = w.number("TARGET");
                let cap = if heater.contains("bed") {
                    bed_max
                } else if heater.contains("chamber") || heater.contains("cavity") {
                    chamber_max
                } else {
                    nozzle_max
                };
                match t {
                    Some(t) if t > cap => push(
                        &mut rep,
                        line_no,
                        "heater_over_limit",
                        Severity::Error,
                        format!("SET_HEATER_TEMPERATURE sets {heater} to {t} C, above {cap} C"),
                    ),
                    Some(0.0) => {
                        if heater.contains("bed") {
                            bed_off = true;
                        } else if !heater.contains("chamber") {
                            heaters_off = true;
                        }
                    }
                    _ => {}
                }
            }
            "TEMPERATURE_WAIT" => {
                if !w.has("MINIMUM") && !w.has("MAXIMUM") {
                    push(
                        &mut rep,
                        line_no,
                        "wait_without_target",
                        Severity::Error,
                        "TEMPERATURE_WAIT has no MINIMUM or MAXIMUM".to_owned(),
                    );
                }
            }
            "M106" => {
                if let Some(s) = w.number("S")
                    && !(0.0..=255.0).contains(&s)
                {
                    push(
                        &mut rep,
                        line_no,
                        "fan_out_of_range",
                        Severity::Error,
                        format!("M106 sets the fan to {s}, outside 0 to 255"),
                    );
                }
            }
            "M302" => {
                // Lowering the cold extrusion limit a little is common; turning it off is not.
                let safe =
                    w.number("S").is_some_and(|s| s >= 150.0) && w.number("P").is_none_or(|p| p == 0.0);
                if !safe {
                    push(
                        &mut rep,
                        line_no,
                        "cold_extrusion",
                        Severity::Error,
                        format!("{cmd} allows extruding below 150 C"),
                    );
                }
            }
            "M84" | "M18" => {
                // `M84 E` frees the extruder motor only, which is common before homing.
                let axes = w.has("X") || w.has("Y") || w.has("Z") || w.params.iter().all(|(k, _)| k != "E");
                if axes && section != Section::End && section != Section::Pause {
                    // A maker's start sequence frees the motors to home or level; the person who trusts it sees a warning.
                    let severity = if trust == Trust::Trusted && section == Section::Start {
                        Severity::Warning
                    } else {
                        Severity::Error
                    };
                    push(
                        &mut rep,
                        line_no,
                        "motors_off",
                        severity,
                        format!("{cmd} turns the motors off before the print ends"),
                    );
                }
            }
            "G28" => {
                if section == Section::LayerChange || section == Section::ToolChange {
                    push(
                        &mut rep,
                        line_no,
                        "home_mid_print",
                        Severity::Error,
                        "G28 homes the printer in the middle of a print".to_owned(),
                    );
                }
            }
            "G92" => {
                if (w.has("X") || w.has("Y") || w.has("Z")) && section != Section::Start {
                    push(
                        &mut rep,
                        line_no,
                        "position_override",
                        Severity::Error,
                        "G92 moves the printer's idea of X, Y or Z during the print".to_owned(),
                    );
                }
            }
            "G91" => abs_xyz = false,
            "G90" => abs_xyz = true,
            "M82" => rel_e = Some(false),
            "M83" => rel_e = Some(true),
            _ => {}
        }
    }
    // The engine writes G90 and M83 after a start sequence, so only the sections between moves must restore them.
    if !abs_xyz && section != Section::Start {
        push(
            &mut rep,
            line_no.max(1),
            "leaves_relative_xyz",
            Severity::Error,
            "ends in relative XYZ mode (G91) without G90".to_owned(),
        );
    }
    if section != Section::Start && section != Section::End && rel_e == Some(false) {
        push(
            &mut rep,
            line_no.max(1),
            "leaves_absolute_extruder",
            Severity::Error,
            "switches the extruder to absolute mode (M82) without M83 again".to_owned(),
        );
    }
    if section == Section::End && !macro_end {
        // A hot nozzle left over is the hazard; a warm bed is common in stock profiles.
        if !heaters_off {
            push(
                &mut rep,
                line_no.max(1),
                "end_leaves_heaters_on",
                Severity::Error,
                "the end G-code does not turn the nozzle heater off".to_owned(),
            );
        } else if !bed_off {
            push(
                &mut rep,
                line_no.max(1),
                "end_leaves_bed_on",
                Severity::Warning,
                "the end G-code leaves the bed heater on".to_owned(),
            );
        }
    }
    rep
}

/// Warnings that block when the text is from an imported file.
const WARN_BLOCKS_UNTRUSTED: &[&str] = &[
    "power_loss",
    "home_offset",
    "inactivity_timer",
    "power_off",
    "power_on",
    "leveling_state",
    "gcode_offset",
];

/// True when the line still has a `[name]` that looks like a placeholder.
fn unrendered(code: &str) -> bool {
    let cs: Vec<char> = code.chars().collect();
    let mut i = 0;
    while let Some(&c) = cs.get(i) {
        if c == '[' {
            let mut j = i + 1;
            while cs.get(j).is_some_and(|d| d.is_ascii_alphanumeric() || *d == '_') {
                j += 1;
            }
            if j > i + 1
                && cs.get(j) == Some(&']')
                && cs
                    .get(i + 1)
                    .is_some_and(|d| d.is_ascii_alphabetic() || *d == '_')
            {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(text: &str, section: Section, trust: Trust) -> Vec<&'static str> {
        lint(
            text,
            section,
            trust,
            &Limits {
                nozzle_max_c: Some(300.0),
                bed_max_c: Some(110.0),
                chamber_max_c: Some(60.0),
                ptfe_lined: None,
            },
        )
        .findings
        .iter()
        .map(|f| f.code)
        .collect()
    }

    #[test]
    fn an_ordinary_start_and_end_are_clean() {
        let start = "M140 S60\nM104 S200\nG28\nM190 S60\nM109 S200\nG90\nM83\nG92 E0\n";
        assert!(codes(start, Section::Start, Trust::Untrusted).is_empty());
        let end = "M104 S0\nM140 S0\nM107\nG91\nG1 Z10\nG90\nM84\n";
        assert!(codes(end, Section::End, Trust::Untrusted).is_empty());
        assert!(codes("PRINT_END", Section::End, Trust::Untrusted).is_empty());
    }

    #[test]
    fn heaters_past_the_limits_block() {
        assert_eq!(
            codes("M104 S999", Section::Start, Trust::Trusted),
            ["nozzle_over_limit"]
        );
        assert_eq!(
            codes("M190 S150", Section::Start, Trust::Trusted),
            ["bed_over_limit"]
        );
        assert_eq!(
            codes("M191 S80", Section::Start, Trust::Trusted),
            ["chamber_over_limit"]
        );
        assert_eq!(
            codes("M106 S300", Section::LayerChange, Trust::Trusted),
            ["fan_out_of_range"]
        );
        assert_eq!(
            codes(
                "SET_HEATER_TEMPERATURE HEATER=extruder TARGET=500",
                Section::Start,
                Trust::Trusted
            ),
            ["heater_over_limit"]
        );
    }

    #[test]
    fn a_wait_needs_a_target() {
        assert_eq!(
            codes("M109", Section::Start, Trust::Trusted),
            ["wait_without_target"]
        );
        assert_eq!(
            codes("M190", Section::Start, Trust::Trusted),
            ["wait_without_target"]
        );
        assert_eq!(
            codes("TEMPERATURE_WAIT SENSOR=extruder", Section::Start, Trust::Trusted),
            ["wait_without_target"]
        );
        assert!(codes("M109 R210", Section::Start, Trust::Trusted).is_empty());
    }

    #[test]
    fn persistent_and_destructive_commands_are_errors() {
        for c in [
            "M502",
            "SAVE_CONFIG",
            "FIRMWARE_RESTART",
            "M997",
            "M851 Z-1",
            "M301 P1",
            "M92 E400",
            "RUN_SHELL_COMMAND CMD=x",
            "M302 P1",
        ] {
            assert!(
                !lint(c, Section::Start, Trust::Trusted, &Limits::default()).ok(),
                "{c}"
            );
        }
        // A maker's own start sequence saves settings; only text that is not the person's is stopped.
        // Bambu's own start sequences also turn the soft endstops off for the purge.
        for c in ["M500", "M211 S0"] {
            assert!(
                !lint(c, Section::Start, Trust::Untrusted, &Limits::default()).ok(),
                "{c}"
            );
            assert!(
                lint(c, Section::Start, Trust::Trusted, &Limits::default()).ok(),
                "{c}"
            );
        }
        assert_eq!(codes("M84", Section::LayerChange, Trust::Trusted), ["motors_off"]);
        assert_eq!(
            codes("G28", Section::LayerChange, Trust::Trusted),
            ["home_mid_print"]
        );
    }

    #[test]
    fn stock_start_sequences_pass() {
        // Freeing the extruder motor, a small cold extrusion change, and a start left in relative mode
        // (the engine writes G90 and M83 after it) are all common in maker profiles.
        for t in [
            "M84 E",
            "M302 S160",
            "G91\nG1 Z2\nM400",
            "SET_VELOCITY_LIMIT ACCEL_TO_DECEL=2500",
        ] {
            let r = lint(t, Section::Start, Trust::Untrusted, &Limits::default());
            assert!(r.ok(), "{t}: {}", r.summary());
        }
        assert_eq!(codes("M84", Section::Start, Trust::Trusted), ["motors_off"]);
        assert_eq!(codes("M84 X Y", Section::Start, Trust::Trusted), ["motors_off"]);
        assert_eq!(
            codes("M302 P1", Section::Start, Trust::Trusted),
            ["cold_extrusion"]
        );
        assert_eq!(
            codes("M302 S0", Section::Start, Trust::Trusted),
            ["cold_extrusion"]
        );
    }

    #[test]
    fn modes_must_be_restored() {
        assert_eq!(
            codes("G91\nG1 Z1", Section::LayerChange, Trust::Trusted),
            ["leaves_relative_xyz"]
        );
        assert!(codes("G91\nG1 Z1\nG90", Section::LayerChange, Trust::Trusted).is_empty());
        assert_eq!(
            codes("M82", Section::ToolChange, Trust::Trusted),
            ["leaves_absolute_extruder"]
        );
    }

    #[test]
    fn the_end_must_turn_heaters_off() {
        assert_eq!(
            codes("G1 Z10", Section::End, Trust::Trusted),
            ["end_leaves_heaters_on"]
        );
        assert_eq!(
            codes("M140 S0", Section::End, Trust::Trusted),
            ["end_leaves_heaters_on"]
        );
        // A hot nozzle blocks; a warm bed only warns.
        assert_eq!(
            codes("M104 S0", Section::End, Trust::Trusted),
            ["end_leaves_bed_on"]
        );
        assert!(lint("M104 S0", Section::End, Trust::Untrusted, &Limits::default()).ok());
    }

    #[test]
    fn untrusted_text_blocks_more() {
        let l = Limits::default();
        assert!(lint("M413 S0", Section::Start, Trust::Trusted, &l).ok());
        assert!(!lint("M413 S0", Section::Start, Trust::Untrusted, &l).ok());
        assert!(lint("M600", Section::Pause, Trust::Untrusted, &l).clean());
    }

    #[test]
    fn unfilled_placeholders_are_errors() {
        assert_eq!(
            codes("M104 S[nozzle_temperature]", Section::Start, Trust::Trusted),
            ["unrendered_placeholder"]
        );
        assert_eq!(
            codes("M104 S{x}", Section::Start, Trust::Trusted),
            ["unrendered_placeholder"]
        );
        assert!(codes("M117 [ done ]", Section::Start, Trust::Trusted).is_empty());
    }

    #[test]
    fn comments_and_case_do_not_hide_commands() {
        assert!(codes("; M500 in a comment", Section::Start, Trust::Trusted).is_empty());
        assert_eq!(
            codes("m500 ; save", Section::Start, Trust::Trusted),
            ["eeprom_write"]
        );
        assert_eq!(
            codes("N12 M500*33", Section::Start, Trust::Trusted),
            ["eeprom_write"]
        );
    }

    #[test]
    fn a_makers_start_sequence_is_not_stopped() {
        // The commands of the stock Bambu P1S start sequence that were reported: a fan controller
        // mode, a baby step for the nozzle wipe height and saving the calibration.
        let start = "M710 A1 S255\nM290 X40 Y40 Z2.6\nM500 ; save\n";
        let own = lint(start, Section::Start, Trust::Trusted, &Limits::default());
        assert!(own.ok(), "{}", own.summary());
        let other = lint(start, Section::Start, Trust::Untrusted, &Limits::default());
        let blocked: Vec<_> = other.errors().map(|f| f.code).collect();
        assert_eq!(blocked, ["eeprom_write"], "{}", other.summary());
        let no_save = lint(
            "M710 A1 S255\nM290 Z-0.1\n",
            Section::Start,
            Trust::Untrusted,
            &Limits::default(),
        );
        assert!(no_save.ok(), "{}", no_save.summary());
    }

    #[test]
    fn a_filament_end_hook_is_not_a_print_end() {
        let hook = "G1 E-2 F1800\nM106 S0\n";
        assert!(lint(hook, Section::Other, Trust::Trusted, &Limits::default()).ok());
        assert!(!lint(hook, Section::End, Trust::Trusted, &Limits::default()).ok());
    }
}
