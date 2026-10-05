// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Preheating idle tools before a tool change, as Orca's G-code processor does it after the file
//! is written (`GCodeProcessor` post-processing with `ExportLines::insert_lines`): with ooze
//! prevention on a printer whose tools have their own nozzles, each tool change looks back
//! `preheat_time` seconds of printing (in `preheat_steps` steps), puts an `M104` for the new tool
//! there, and drops the standby cooldowns of that tool inside the window. The look back stops at
//! the previous change to the same tool and at the start of the print (`G28`, `G29`,
//! `PRINT_START`, `START_PRINT`).
//!
//! The times come from reading the finished file the way Orca's processor does (`printtime`).

use crate::config::PrintConfig;

/// True when the settings ask for preheating (Orca: `backtrace_enabled`).
/// The print's filament count is checked in [`apply`], from the tools the file selects.
pub(crate) fn wanted(cfg: &PrintConfig) -> bool {
    crate::tower::flag(cfg, "ooze_prevention")
        && cfg.raw_number("preheat_time", 30.0) > 0.0
        && !crate::tower::flag_or(cfg, "single_extruder_multi_material", true)
}

/// The command word of a G-code line, as Orca's `extract_cmd` reads it.
fn command(line: &str) -> &str {
    line.split(';')
        .next()
        .unwrap_or("")
        .split_ascii_whitespace()
        .next()
        .unwrap_or("")
}

fn word(line: &str, key: char) -> Option<f64> {
    line.split(';')
        .next()
        .unwrap_or("")
        .split_ascii_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(key).and_then(|v| v.parse::<f64>().ok()))
}

/// The file with preheat lines put in and the cooldowns inside each window dropped.
pub(crate) fn apply(gcode: &[u8], cfg: &PrintConfig) -> Vec<u8> {
    let text = String::from_utf8_lossy(gcode);
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut used: Vec<&str> = lines
        .iter()
        .map(|l| command(l))
        .filter(|c| c.len() >= 2 && c.starts_with('T') && c[1..].parse::<u32>().is_ok())
        .collect();
    used.sort_unstable();
    used.dedup();
    if used.len() < 2 {
        return gcode.to_vec();
    }
    // Seconds into the print at each line, as Orca's G-code processor times the file.
    let times = crate::printtime::estimate(gcode, cfg, true).lines;
    let window = cfg.raw_number("preheat_time", 30.0);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small step count"
    )]
    let steps = (cfg.raw_number("preheat_steps", 1.0).round() as usize).max(1);
    #[allow(clippy::cast_precision_loss, reason = "a small step count")]
    let step = window / steps as f64;
    let flavor = cfg.gcode_flavor;
    let start_like = |c: &str| {
        ["G28", "G29", "PRINT_START", "START_PRINT"]
            .iter()
            .any(|s| c.eq_ignore_ascii_case(s))
    };
    // The output so far, each line with its time.
    let mut out: Vec<(String, f64)> = Vec::with_capacity(lines.len() + 64);
    let mut layer = 0u32;
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with(";LAYER_CHANGE") {
            layer += 1;
        }
        let cmd = command(line);
        let tool = (cmd.len() >= 2 && cmd.starts_with('T'))
            .then(|| cmd[1..].parse::<usize>().ok())
            .flatten();
        if let Some(tool) = tool {
            let slot = u8::try_from(tool + 1).unwrap_or(1);
            let temp = if layer > 1 {
                PrintConfig::per_slot(&cfg.nozzle_temperature, slot, 220.0)
            } else {
                crate::tower::per_slot_raw(
                    cfg,
                    "nozzle_temperature_initial_layer",
                    slot,
                    PrintConfig::per_slot(&cfg.nozzle_temperature, slot, 220.0),
                )
            };
            // The time of the last move before the change.
            let now = out.last().map_or(0.0, |l| l.1);
            let mut back = 0usize; // lines from the end already passed
            let mut last_insert = f64::NAN;
            for k in 0..steps {
                #[allow(clippy::cast_precision_loss, reason = "a small step count")]
                let threshold = now - (k + 1) as f64 * step;
                let started = back;
                let mut idx = out.len().checked_sub(1 + back);
                let mut stop = false;
                while let Some(j) = idx {
                    let Some((l, t)) = out.get_mut(j) else { break };
                    let c = command(l);
                    if *t <= threshold || c == cmd || start_like(c) {
                        stop = c == cmd || start_like(c);
                        break;
                    }
                    // A standby cooldown of this tool inside the window is not needed any more.
                    if c == "M104"
                        && l.contains("cooldown")
                        && word(l, 'T').is_some_and(|v| {
                            (v - f64::from(u32::try_from(tool).unwrap_or(u32::MAX))).abs() < 0.5
                        })
                    {
                        "; removed M104\n".clone_into(l);
                    }
                    back += 1;
                    idx = j.checked_sub(1);
                }
                if stop {
                    break;
                }
                let Some(j) = idx else { break };
                let t = out.get(j).map_or(0.0, |l| l.1);
                // Two steps never put their lines at the same time.
                if back == started || (t - last_insert).abs() < f64::EPSILON {
                    continue;
                }
                last_insert = t;
                #[allow(clippy::cast_possible_truncation, reason = "seconds of a print")]
                let secs = (now - t).round() as i64;
                let comment = format!("preheat T{tool} time: {secs}s");
                let mut l = Vec::new();
                crate::gcode::orca_temperature_line(&mut l, flavor, tool, temp, &comment);
                out.insert(j + 1, (String::from_utf8_lossy(&l).into_owned(), t));
                back += 1;
            }
        }
        out.push(((*line).to_owned(), times.get(i).copied().unwrap_or(0.0)));
    }
    out.into_iter().flat_map(|(l, _)| l.into_bytes()).collect()
}
