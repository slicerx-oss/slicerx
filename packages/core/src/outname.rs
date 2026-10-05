// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The output file name: the profile's `filename_format` rendered with Orca's placeholders (Orca's
//! `Print::output_filename`, `PrintBase::output_filename` and `PrintStatistics::config`). The numbers
//! come from the finished file's footer, so a native run and a WASM run of shards name it alike.
//!
//! Unlike Orca, characters no file system takes (`/ \ : * ? " < > |` and control characters) become `_`,
//! so a name never points into another folder.

use crate::config::PrintConfig;
use crate::template::{Context, Value};

/// Orca 2.4.2's default `filename_format`.
pub const DEFAULT_FORMAT: &str = "{input_filename_base}_{filament_type[initial_tool]}_{print_time}.gcode";

/// What the plate knows that the settings do not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NameInfo {
    /// Object names in plate order (the first gives `input_filename_base`).
    pub objects: Vec<String>,
    /// `plate_name`, empty when the plate has none.
    pub plate_name: String,
    /// The plate's number from 1 (`plate_number`, written with two digits).
    pub plate_number: u32,
    /// The project's name (`model_name`).
    pub model_name: String,
}

/// Totals of a finished file, read from its footer and tool commands.
#[derive(Debug, Clone, Default, PartialEq)]
struct Totals {
    time_s: f64,
    mm: Vec<f64>,
    cm3: Vec<f64>,
    grams: f64,
    cost: f64,
    first_tool: usize,
    tool_changes: usize,
}

fn footer_list(text: &str, key: &str) -> Vec<f64> {
    text.lines()
        .rev()
        .find_map(|l| l.strip_prefix(key))
        .map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect())
        .unwrap_or_default()
}

fn totals(gcode: &[u8], filaments: usize) -> Totals {
    let tail = String::from_utf8_lossy(gcode.get(gcode.len().saturating_sub(4096)..).unwrap_or(&[]));
    let mut t = Totals {
        time_s: crate::firmware::footer_time(gcode).unwrap_or(0.0),
        mm: footer_list(&tail, "; filament used [mm] = "),
        cm3: footer_list(&tail, "; filament used [cm3] = "),
        grams: footer_list(&tail, "; total filament used [g] = ")
            .first()
            .copied()
            .unwrap_or(0.0),
        cost: footer_list(&tail, "; total filament cost = ")
            .first()
            .copied()
            .unwrap_or(0.0),
        ..Totals::default()
    };
    // Tool commands (`T0` to the last filament; Bambu's T255 and T1000 are not tools).
    let mut last: Option<usize> = None;
    for line in gcode.split(|&b| b == b'\n') {
        let Some(rest) = line.strip_prefix(b"T") else {
            continue;
        };
        let digits: Vec<u8> = rest.iter().copied().take_while(u8::is_ascii_digit).collect();
        if digits.is_empty()
            || rest
                .get(digits.len())
                .is_some_and(|b| !b.is_ascii_whitespace() && *b != b';')
        {
            continue;
        }
        let Some(n) = std::str::from_utf8(&digits)
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
        else {
            continue;
        };
        if n >= filaments.max(1) {
            continue;
        }
        match last {
            None => t.first_tool = n,
            Some(p) if p != n => t.tool_changes += 1,
            _ => {}
        }
        last = Some(n);
    }
    t
}

/// Orca's `short_time`: whole minutes once a print takes an hour (seconds from 30 round up), else minutes
/// and seconds.
fn short_time(total_s: f64) -> String {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a print lasts far less than 2^63 seconds"
    )]
    let t = total_s.max(0.0) as u64;
    let (mut d, mut h, mut m, s) = (t / 86_400, t % 86_400 / 3600, t % 3600 / 60, t % 60);
    if d + h > 0 && s >= 30 {
        m += 1;
        if m == 60 {
            m = 0;
            h += 1;
            if h == 24 {
                h = 0;
                d += 1;
            }
        }
    }
    if d > 0 {
        format!("{d}d{h}h{m}m")
    } else if h > 0 {
        format!("{h}h{m}m")
    } else if m > 0 {
        format!("{m}m{s}s")
    } else if s >= 1 {
        format!("{s}s")
    } else if total_s > 0.0 {
        "<1s".to_owned()
    } else {
        "0s".to_owned()
    }
}

/// Characters a file name cannot hold become `_`; leading and trailing spaces and dots go.
fn clean(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    s.trim_matches(|c: char| c == ' ' || c == '.').to_owned()
}

/// The name the finished `gcode` gets: `filename_format` (Orca's default when unset) rendered with the
/// plate, the settings, the moment of slicing and the footer's totals. `.gcode` is added when the name
/// has no G-code extension, and binary G-code ends in `.bgcode`.
pub fn file_name(cfg: &PrintConfig, info: &NameInfo, gcode: &[u8], binary: bool) -> Result<String, String> {
    let format = match cfg.raw.get("filename_format") {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.as_str(),
        _ => DEFAULT_FORMAT,
    };
    let filaments = match cfg.raw.get("filament_type") {
        Some(serde_json::Value::Array(a)) => a.len(),
        _ => 1,
    };
    let t = totals(gcode, filaments);
    let mut ctx = Context {
        config: Some(&cfg.raw),
        ..Context::default()
    };
    let num = Value::Num;
    let text = |s: &str| Value::Str(s.to_owned());
    let time = short_time(t.time_s);
    let mm: f64 = t.mm.iter().sum();
    let cm3: f64 = t.cm3.iter().sum();
    let first = info.objects.first().map_or("", String::as_str);
    let base = first.rsplit_once('.').map_or(first, |(b, _)| b);
    let base = if base.is_empty() { "plate" } else { base };
    let nozzles = match cfg.raw.get("nozzle_diameter") {
        Some(serde_json::Value::Array(a)) => a.len().max(1),
        _ => 1,
    };
    let filament_name = match cfg.raw.get("filament_settings_id") {
        Some(serde_json::Value::Array(a)) => a
            .get(t.first_tool)
            .or_else(|| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or(""),
        Some(serde_json::Value::String(s)) => s.as_str(),
        _ => "",
    };
    let filament_name = filament_name.split('@').next().unwrap_or("");
    let [year, month, day, hour, minute, second] = crate::customgcode::calendar(cfg);
    #[allow(clippy::cast_precision_loss, reason = "counts are small")]
    let vars = [
        ("print_time", text(&time)),
        ("normal_print_time", text(&time)),
        ("silent_print_time", text(&time)),
        ("used_filament", num(mm / 1000.0)),
        ("extruded_volume", num(cm3 * 1000.0)),
        ("extruded_volume_total", num(cm3 * 1000.0)),
        ("total_cost", num(t.cost)),
        ("total_weight", num(t.grams)),
        ("extruded_weight_total", num(t.grams)),
        ("total_toolchanges", num(t.tool_changes as f64)),
        ("total_wipe_tower_cost", num(0.0)),
        ("total_wipe_tower_filament", num(0.0)),
        ("initial_tool", num(t.first_tool as f64)),
        ("initial_extruder", num(t.first_tool as f64)),
        ("num_filaments", num(nozzles as f64)),
        ("num_extruders", num(nozzles as f64)),
        ("plate_name", text(&info.plate_name)),
        ("plate_number", text(&format!("{:02}", info.plate_number.max(1)))),
        ("model_name", text(&info.model_name)),
        ("filament_name", text(filament_name)),
        ("num_objects", num(info.objects.len() as f64)),
        ("num_instances", num(info.objects.len() as f64)),
        ("first_object_name", text(first)),
        ("input_filename", text(&format!("{base}.gcode"))),
        ("input_filename_base", text(base)),
        ("version", text(env!("CARGO_PKG_VERSION"))),
        ("user", text("unknown")),
        (
            "timestamp",
            text(&format!(
                "{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}"
            )),
        ),
        ("year", num(year)),
        ("month", num(month)),
        ("day", num(day)),
        ("hour", num(hour)),
        ("minute", num(minute)),
        ("second", num(second)),
    ];
    for (k, v) in vars {
        ctx.vars.insert(k.to_owned(), v);
    }
    let rendered = crate::template::render(format, &ctx).map_err(|e| format!("filename_format: {e}"))?;
    let mut name = clean(rendered.trim());
    if name.is_empty() {
        name = clean(base);
    }
    // Orca keeps any extension; a name that ends in a number with a point ("0.18g") would lose its `.gcode`,
    // so only a G-code extension counts here.
    let lower = name.to_ascii_lowercase();
    let has_ext = [".gcode", ".gco", ".g", ".bgcode", ".nc"]
        .iter()
        .any(|e| lower.ends_with(e) && lower.len() > e.len());
    if !has_ext {
        name.push_str(".gcode");
    }
    if binary && let Some(stem) = name.strip_suffix(".gcode") {
        name = format!("{stem}.bgcode");
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_time_reads_like_orcas() {
        assert_eq!(short_time(0.0), "0s");
        assert_eq!(short_time(0.4), "<1s");
        assert_eq!(short_time(42.0), "42s");
        assert_eq!(short_time(709.0), "11m49s");
        assert_eq!(short_time(3600.0 + 29.0), "1h0m");
        assert_eq!(short_time(3600.0 + 59.0 * 60.0 + 30.0), "2h0m");
        assert_eq!(short_time(90_061.0), "1d1h1m");
    }

    #[test]
    fn names_never_leave_the_folder() {
        assert_eq!(clean("../a/b:c?.gcode"), "_a_b_c_.gcode");
        assert_eq!(clean("  x.gcode. "), "x.gcode");
    }

    fn footer() -> Vec<u8> {
        b"; header\nT0\nG1 X1 E1\nT1\nG1 X2 E1\nT1\nT255\nT0\n\
          ; filament used [mm] = 1000.00, 500.00\n; filament used [cm3] = 2.41, 1.20\n\
          ; filament used [g] = 3.00, 1.50\n; total filament used [g] = 4.50\n; total filament cost = 0.11\n\
          ; total layers count = 10\n; estimated printing time (normal mode) = 1h 2m 31s\n"
            .to_vec()
    }

    #[test]
    fn the_default_format_names_the_part_filament_and_time() {
        let mut cfg = PrintConfig::default();
        cfg.raw
            .insert("filament_type".into(), serde_json::json!(["PLA", "PETG"]));
        let info = NameInfo {
            objects: vec!["Benchy v2.stl".into(), "b".into()],
            ..NameInfo::default()
        };
        assert_eq!(
            file_name(&cfg, &info, &footer(), false).unwrap(),
            "Benchy v2_PLA_1h3m.gcode"
        );
        assert_eq!(
            file_name(&cfg, &info, &footer(), true).unwrap(),
            "Benchy v2_PLA_1h3m.bgcode"
        );
        // Totals, tool changes and the plate.
        cfg.raw.insert(
            "filename_format".into(),
            serde_json::json!("{plate_name}-{plate_number} {total_weight}g {used_filament}m {total_toolchanges}x {num_objects} {filament_name}"),
        );
        cfg.raw.insert(
            "filament_settings_id".into(),
            serde_json::json!(["Generic PLA @BBL X1C", "Generic PETG"]),
        );
        let info = NameInfo {
            plate_name: "left/right".into(),
            plate_number: 3,
            ..info
        };
        assert_eq!(
            file_name(&cfg, &info, &footer(), false).unwrap(),
            "left_right-03 4.5g 1.5m 2x 2 Generic PLA.gcode"
        );
        // The moment of slicing, from the request.
        cfg.raw
            .insert("filename_format".into(), serde_json::json!("{timestamp}.gco"));
        cfg.now = Some((1_759_400_000, 120));
        assert_eq!(
            file_name(&cfg, &info, &footer(), false).unwrap(),
            "20251002-121320.gco"
        );
        // A template error is reported.
        cfg.raw
            .insert("filename_format".into(), serde_json::json!("{no_such_key}"));
        assert!(file_name(&cfg, &info, &footer(), false).is_err());
    }
}
