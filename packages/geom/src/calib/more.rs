// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! more calibrations after `OrcaSlicer`'s dialogs and `GCode.cpp`
#![allow(
    clippy::indexing_slicing,
    clippy::format_push_string,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use super::{
    CalibModel, Label, RangeOverride, Result, Settings, apply_labels, bands, build, fmt_num, instr, object,
    positive, round6, settings, steps,
};
use crate::error::Error;
use crate::mesh::TriMesh;
use crate::pa::{self, GcodeOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaLineRequest {
    #[serde(flatten)]
    pub line: pa::PaLineParams,
    pub gcode: Option<GcodeOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaPatternRequest {
    #[serde(flatten)]
    pub pattern: pa::PaPatternParams,
    pub gcode: Option<GcodeOptions>,
}

fn plan_model(
    name: &str,
    plan: &pa::PathPlan,
    gcode: Option<&GcodeOptions>,
    lines: &[&str],
    values_key: &str,
) -> Result<CalibModel> {
    let mut expected = json!({
        "plan": serde_json::to_value(plan).map_err(|e| Error::Json(e.to_string()))?,
        values_key: plan.values,
        "suggestedSettings": plan.suggested_settings,
        "boundsMm": { "min": plan.min, "max": plan.max },
    });
    if let (Some(o), Some(map)) = (gcode, expected.as_object_mut()) {
        map.insert("gcode".to_owned(), Value::String(pa::render_gcode(plan, o)?));
    }
    Ok(CalibModel {
        name: name.into(),
        objects: Vec::new(),
        ranges: Vec::new(),
        instructions: instr(lines),
        expected,
    })
}

pub(super) fn pa_line(r: &PaLineRequest) -> Result<CalibModel> {
    let plan = pa::pa_line(&r.line)?;
    plan_model(
        "pa-line",
        &plan,
        r.gcode.as_ref(),
        &[
            "Print the G-code from expected.gcode (or follow expected.plan) on a clean, leveled bed. There is no model to slice.",
            "Each line has a slow, a fast and a slow section at one pressure advance value, from the bottom line up.",
            "Look for the line whose fast section keeps an even width with no bulge at the start and no gap at the end of the fast run.",
            "Its value is the number printed beside every second line, or expected.values at that line's index.",
        ],
        "pressureAdvance",
    )
}

pub(super) fn pa_pattern(r: &PaPatternRequest) -> Result<CalibModel> {
    let plan = pa::pa_pattern(&r.pattern)?;
    plan_model(
        "pa-pattern",
        &plan,
        r.gcode.as_ref(),
        &[
            "Print the G-code from expected.gcode (or follow expected.plan) with the suggested settings in expected.suggestedSettings.",
            "Each chevron is printed at its own pressure advance value over four layers, from left to right.",
            "Find the chevron with the sharpest point and no gaps or bulges along its walls.",
            "Its value is the number printed above every second chevron.",
        ],
        "pressureAdvance",
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VfaParams {
    pub start_mm_s: f64,
    pub end_mm_s: f64,
    pub step_mm_s: f64,
    /// height of one speed band (Orca changes speed every 5 mm)
    pub band_mm: f64,
    pub diameter_mm: f64,
    pub layer_height_mm: f64,
    pub labels: bool,
}

impl Default for VfaParams {
    fn default() -> Self {
        Self {
            start_mm_s: 40.0,
            end_mm_s: 200.0,
            step_mm_s: 10.0,
            band_mm: 5.0,
            diameter_mm: 30.0,
            layer_height_mm: 0.2,
            labels: true,
        }
    }
}

fn tower_settings(layer: f64, accel: f64, extra: &[(&str, Value)]) -> Settings {
    let mut s = settings(&[
        ("wall_loops", json!(1)),
        ("layer_height", json!(layer)),
        ("bottom_shell_layers", json!(3)),
        ("top_shell_layers", json!(0)),
        ("sparse_infill_density", json!("0%")),
        ("detect_thin_wall", json!(false)),
        ("enable_overhang_speed", json!(false)),
        ("slow_down_for_layer_cooling", json!(false)),
        ("slow_down_layer_time", json!(0)),
        ("outer_wall_speed", json!(200)),
        ("default_acceleration", json!(accel)),
        ("outer_wall_acceleration", json!(accel)),
        ("brim_type", json!("outer_only")),
        ("brim_width", json!(3.0)),
    ]);
    for (k, v) in extra {
        s.insert((*k).to_owned(), v.clone());
    }
    s
}

pub(super) fn vfa(p: &VfaParams) -> Result<CalibModel> {
    let speeds = steps("vfa", p.start_mm_s, p.end_mm_s, p.step_mm_s)?;
    positive("vfa startMmS", p.start_mm_s)?;
    positive("vfa bandMm", p.band_mm)?;
    positive("vfa diameterMm", p.diameter_mm)?;
    positive("vfa layerHeightMm", p.layer_height_mm)?;
    let n = speeds.len();
    let height = p.band_mm * n as f64;
    let labels = band_labels(&speeds, p.band_mm, p.labels, fmt_num);
    let mesh = tower_mesh(p.diameter_mm, height, &labels, p.band_mm);
    let spans = bands(height, n);
    let ranges = spans
        .iter()
        .zip(&speeds)
        .map(|(&(a, b), s)| RangeOverride {
            z_from_mm: a,
            z_to_mm: b,
            settings: settings(&[("outer_wall_speed", json!(*s))]),
        })
        .collect();
    let table: Vec<Value> = spans
        .iter()
        .zip(&speeds)
        .map(|(&(a, b), s)| json!({"zFromMm": a, "zToMm": b, "outerWallSpeedMmS": s}))
        .collect();
    Ok(CalibModel {
        name: "vfa".into(),
        objects: vec![object(
            "vfa",
            mesh,
            [0.0, 0.0],
            tower_settings(p.layer_height_mm, 5000.0, &[]),
        )],
        ranges,
        instructions: instr(&[
            "Print the tower with one wall and a solid base, slicing it with the object settings given.",
            "The outer wall speed rises with height in equal bands.",
            "Vertical fine artifacts are faint repeating ripples on the wall. Run a fingernail or a light across the wall and note the speeds where they fade or get worse.",
            "Pick a speed from a smooth band, keeping in mind that resonances repeat with speed and motor step patterns.",
        ]),
        expected: json!({
            "bands": table,
            "bandHeightMm": p.band_mm,
            "heightMm": height,
            "speedAtHeight": "speed = start + step * floor(z / bandHeightMm)",
        }),
    })
}

const FLAVORS: [&str; 4] = ["klipper", "marlin", "reprapFirmware", "repetier"];

fn shaper_gcode(flavor: &str, axis: char, freq: f64, damping: f64, shaper: &str) -> Option<String> {
    let mut params = String::new();
    match flavor {
        "klipper" => {
            if !shaper.is_empty() {
                params += &format!(" SHAPER_TYPE={shaper}");
            }
            let axes: &[char] = if axis == 'A' {
                &['X', 'Y']
            } else {
                std::slice::from_ref(&axis)
            };
            for a in axes {
                if freq > 0.0 {
                    params += &format!(" SHAPER_FREQ_{a}={freq:.2}");
                }
                if damping > 0.0 {
                    params += &format!(" DAMPING_RATIO_{a}={damping:.3}");
                }
            }
            (!params.is_empty()).then(|| format!("SET_INPUT_SHAPER{params}"))
        }
        "reprapFirmware" => {
            if !shaper.is_empty() && !shaper.eq_ignore_ascii_case("daa") {
                params += &format!(" P\"{shaper}\"");
            }
            if freq > 0.0 {
                params += &format!(" F{freq:.2}");
            }
            if damping > 0.0 {
                params += &format!(" S{damping:.3}");
            }
            (!params.is_empty()).then(|| format!("M593{params}"))
        }
        "marlin" => {
            if axis != 'A' {
                params += &format!(" {axis}");
            }
            if freq > 0.0 {
                params += &format!(" F{freq:.2}");
            }
            if damping > 0.0 {
                params += &format!(" D{damping:.3}");
            }
            (!params.is_empty()).then(|| format!("M593{params}"))
        }
        _ => None,
    }
}

fn flavor_map(f: impl Fn(&str) -> Option<String>) -> Value {
    let mut m = serde_json::Map::new();
    for fl in FLAVORS {
        if let Some(g) = f(fl) {
            m.insert(fl.to_owned(), Value::String(g));
        }
    }
    Value::Object(m)
}

fn band_labels(values: &[f64], band: f64, show: bool, text: impl Fn(f64) -> String) -> Vec<(f64, String)> {
    let n = values.len();
    if !show || n < 2 {
        return Vec::new();
    }
    (0..n)
        .step_by((n / 8).max(1))
        .map(|i| (band * (i as f64 + 0.5), text(values[i])))
        .collect()
}

fn tower_mesh(size: f64, height: f64, values: &[(f64, String)], band: f64) -> TriMesh {
    let mut mesh = build::box_mesh([0.0, 0.0, 0.0], [size, size, height]);
    let labels: Vec<Label> = values
        .iter()
        .map(|(z, text)| {
            Label::new(
                text.clone(),
                [size / 2.0, 0.0, *z],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, 1.0],
                (band * 2.5).clamp(2.0, 3.5),
            )
        })
        .collect();
    if !labels.is_empty() {
        mesh = apply_labels(mesh, &labels);
    }
    mesh
}

struct Tower<'a> {
    name: &'a str,
    size: f64,
    height: f64,
    band: f64,
    accel: f64,
    values: Vec<f64>,
    label_text: &'a dyn Fn(f64) -> String,
    commands: &'a dyn Fn(f64) -> (Value, Value),
    setup: Value,
    extra_settings: Vec<(&'a str, Value)>,
    instructions: &'a [&'a str],
    table_key: &'a str,
}

fn tower_model(t: &Tower<'_>, show_labels: bool) -> CalibModel {
    let n = t.values.len();
    let spans = bands(t.height, n);
    let labels = band_labels(&t.values, t.band, show_labels, t.label_text);
    let mesh = tower_mesh(t.size, t.height, &labels, t.band);
    let table: Vec<Value> = spans
        .iter()
        .zip(&t.values)
        .map(|(&(a, b), v)| {
            let (commands, gcode) = (t.commands)(*v);
            json!({
                "zFromMm": a,
                "zToMm": b,
                t.table_key: v,
                "commands": commands,
                "gcode": gcode,
            })
        })
        .collect();
    CalibModel {
        name: t.name.into(),
        objects: vec![object(
            t.name,
            mesh,
            [0.0, 0.0],
            tower_settings(0.2, t.accel, &t.extra_settings),
        )],
        ranges: Vec::new(),
        instructions: instr(t.instructions),
        expected: json!({
            "layerCommands": table,
            "setupGcode": t.setup,
            "bandHeightMm": t.band,
            "heightMm": t.height,
            "sizeMm": t.size,
        }),
    }
}

fn check_tower(what: &'static str, size: f64, height: f64, band: f64) -> Result<usize> {
    positive(what, size)?;
    positive(what, height)?;
    positive(what, band)?;
    let n = (height / band).round();
    if !(2.0..=200.0).contains(&n) {
        return Err(Error::invalid(
            what,
            "heightMm / bandMm must be between 2 and 200",
        ));
    }
    Ok(n as usize)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InputShapingFreqParams {
    pub start_hz: f64,
    pub end_hz: f64,
    pub start_y_hz: Option<f64>,
    pub end_y_hz: Option<f64>,
    pub damping_ratio: f64,
    /// shaper type (`mzv`, `zv`, `zvd`, `ei`, `2hump_ei`, `3hump_ei` on Klipper)
    pub shaper: String,
    pub size_mm: f64,
    pub height_mm: f64,
    pub band_mm: f64,
    pub labels: bool,
}

impl Default for InputShapingFreqParams {
    fn default() -> Self {
        Self {
            start_hz: 15.0,
            end_hz: 110.0,
            start_y_hz: None,
            end_y_hz: None,
            damping_ratio: 0.15,
            shaper: "mzv".to_owned(),
            size_mm: 40.0,
            height_mm: 60.0,
            band_mm: 1.0,
            labels: true,
        }
    }
}

pub(super) fn input_shaping_freq(p: &InputShapingFreqParams) -> Result<CalibModel> {
    let n = check_tower("input-shaping-freq", p.size_mm, p.height_mm, p.band_mm)?;
    if !(p.start_hz > 0.0
        && p.end_hz > 0.0
        && (p.start_hz - p.end_hz).abs() > 1e-9
        && (0.0..=1.0).contains(&p.damping_ratio))
    {
        return Err(Error::invalid(
            "input-shaping-freq",
            "frequencies must be above 0 and different, damping between 0 and 1",
        ));
    }
    let (sy, ey) = (p.start_y_hz.unwrap_or(p.start_hz), p.end_y_hz.unwrap_or(p.end_hz));
    let both = (sy - p.start_hz).abs() < 1e-9 && (ey - p.end_hz).abs() < 1e-9;
    let at = |i: usize, a: f64, b: f64| round6(a + (b - a) * i as f64 / (n as f64 - 1.0));
    let values: Vec<f64> = (0..n).map(|i| at(i, p.start_hz, p.end_hz)).collect();
    let index_of = |v: f64| values.iter().position(|x| (x - v).abs() < 1e-9).unwrap_or(0);
    let shaper = p.shaper.clone();
    let damping = p.damping_ratio;
    let commands = move |v: f64| {
        let i = index_of(v);
        let (fx, fy) = (v, at(i, sy, ey));
        if both {
            (
                json!([{ "type": "inputShaping", "axis": "A", "freqHz": fx }]),
                flavor_map(|f| shaper_gcode(f, 'A', fx, 0.0, "")),
            )
        } else {
            (
                json!([
                    { "type": "inputShaping", "axis": "X", "freqHz": fx },
                    { "type": "inputShaping", "axis": "Y", "freqHz": fy }
                ]),
                flavor_map(|f| {
                    let x = shaper_gcode(f, 'X', fx, 0.0, "")?;
                    let y = shaper_gcode(f, 'Y', fy, 0.0, "")?;
                    Some(format!("{x}\n{y}"))
                }),
            )
        }
    };
    let setup = json!({
        "commands": [{ "type": "inputShaping", "axis": "A", "shaper": shaper, "dampingRatio": damping, "freqHz": p.start_hz }],
        "gcode": flavor_map(|f| {
            let base = shaper_gcode(f, 'A', p.start_hz, damping, &shaper)?;
            Some(if f == "klipper" { format!("{base}\\nSET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=0") } else { base })
        }),
        "note": "Emit at the first layer; Orca also turns off the firmware's own input shaping and layer cooling slowdown for the test.",
    });
    Ok(tower_model(
        &Tower {
            name: "input-shaping-freq",
            size: p.size_mm,
            height: p.height_mm,
            band: p.band_mm,
            accel: 20000.0,
            values: values.clone(),
            label_text: &|v| fmt_num(v.round()),
            commands: &commands,
            setup,
            extra_settings: vec![("default_jerk", json!(0)), ("resonance_avoidance", json!(false))],
            instructions: &[
                "Print the tower at high acceleration with pressure advance on. The shaper frequency rises with height in steps.",
                "Ringing appears as ripples after each sharp corner, on the front face next to the numbers.",
                "Find the height where the ripples are weakest, read the frequency from expected.layerCommands and set it as the shaper frequency for that axis.",
                "If X and Y differ (startYHz and endYHz), run it once per axis and compare the faces that line up with each axis.",
            ],
            table_key: "freqHz",
        },
        p.labels,
    ))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InputShapingDampParams {
    pub freq_hz: f64,
    pub freq_y_hz: Option<f64>,
    pub start_damping: f64,
    pub end_damping: f64,
    pub shaper: String,
    pub size_mm: f64,
    pub height_mm: f64,
    pub band_mm: f64,
    pub labels: bool,
}

impl Default for InputShapingDampParams {
    fn default() -> Self {
        Self {
            freq_hz: 30.0,
            freq_y_hz: None,
            start_damping: 0.0,
            end_damping: 0.4,
            shaper: "mzv".to_owned(),
            size_mm: 40.0,
            height_mm: 60.0,
            band_mm: 1.0,
            labels: true,
        }
    }
}

pub(super) fn input_shaping_damp(p: &InputShapingDampParams) -> Result<CalibModel> {
    let n = check_tower("input-shaping-damp", p.size_mm, p.height_mm, p.band_mm)?;
    if !(p.freq_hz > 0.0
        && (0.0..=1.0).contains(&p.start_damping)
        && (0.0..=1.0).contains(&p.end_damping)
        && (p.start_damping - p.end_damping).abs() > 1e-9)
    {
        return Err(Error::invalid(
            "input-shaping-damp",
            "frequency must be above 0 and the damping ratios between 0 and 1 and different",
        ));
    }
    let values: Vec<f64> = (0..n)
        .map(|i| round6(p.start_damping + (p.end_damping - p.start_damping) * i as f64 / (n as f64 - 1.0)))
        .collect();
    let commands = |d: f64| {
        (
            json!([{ "type": "inputShaping", "axis": "A", "dampingRatio": d }]),
            flavor_map(|f| shaper_gcode(f, 'A', 0.0, d, "")),
        )
    };
    let fy = p.freq_y_hz.unwrap_or(p.freq_hz);
    let shaper = p.shaper.clone();
    let setup = json!({
        "commands": [
            { "type": "inputShaping", "axis": "X", "shaper": shaper, "freqHz": p.freq_hz },
            { "type": "inputShaping", "axis": "Y", "shaper": shaper, "freqHz": fy }
        ],
        "gcode": flavor_map(|f| {
            let x = shaper_gcode(f, 'X', p.freq_hz, 0.0, &shaper)?;
            let y = shaper_gcode(f, 'Y', fy, 0.0, &shaper)?;
            let base = format!("{x}\\n{y}");
            Some(if f == "klipper" { format!("{base}\\nSET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=0") } else { base })
        }),
        "note": "Emit at the first layer.",
    });
    Ok(tower_model(
        &Tower {
            name: "input-shaping-damp",
            size: p.size_mm,
            height: p.height_mm,
            band: p.band_mm,
            accel: 20000.0,
            values,
            label_text: &|v| format!("{v:.2}"),
            commands: &commands,
            setup,
            extra_settings: vec![("default_jerk", json!(0)), ("resonance_avoidance", json!(false))],
            instructions: &[
                "Print the tower with the shaper frequency fixed. The damping ratio rises with height in steps.",
                "Look for the height with the least ringing after the corners without rounded, smeared corners.",
                "Read that height's damping ratio from expected.layerCommands.",
            ],
            table_key: "dampingRatio",
        },
        p.labels,
    ))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CorneringParams {
    /// `jerk` (mm/s, also Klipper's square corner velocity) or `junctionDeviation` (mm, Marlin)
    pub mode: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub size_mm: f64,
    pub height_mm: f64,
    pub band_mm: f64,
    pub labels: bool,
}

impl Default for CorneringParams {
    fn default() -> Self {
        Self {
            mode: "jerk".to_owned(),
            start: None,
            end: None,
            size_mm: 40.0,
            height_mm: 40.0,
            band_mm: 1.0,
            labels: true,
        }
    }
}

pub(super) fn cornering(p: &CorneringParams) -> Result<CalibModel> {
    let n = check_tower("cornering", p.size_mm, p.height_mm, p.band_mm)?;
    let jd = match p.mode.as_str() {
        "jerk" => false,
        "junctionDeviation" => true,
        _ => return Err(Error::invalid("mode", "jerk or junctionDeviation")),
    };
    // Orca's limits: junction deviation 0 to 0.3 mm (warns above 0.25), jerk up to 100 (warns above 20)
    let (dstart, dend, max) = if jd { (0.0, 0.25, 0.3) } else { (1.0, 15.0, 100.0) };
    let (start, end) = (p.start.unwrap_or(dstart), p.end.unwrap_or(dend));
    if !(start >= 0.0 && end <= max && start < end) {
        return Err(Error::invalid(
            "cornering",
            format!("needs 0 <= start < end <= {max}"),
        ));
    }
    let values: Vec<f64> = (0..n)
        .map(|i| round6(start + (end - start) * i as f64 / (n as f64 - 1.0)))
        .collect();
    let commands = move |v: f64| {
        if jd {
            (
                json!([{ "type": "junctionDeviation", "mm": v }]),
                flavor_map(|f| (f == "marlin").then(|| format!("M205 J{v:.3}"))),
            )
        } else {
            (
                json!([{ "type": "jerkXy", "mmS": v }]),
                flavor_map(|f| match f {
                    "klipper" => Some(format!("SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY={v}")),
                    "repetier" => Some(format!("M207 X{v}")),
                    _ => Some(format!("M205 X{v} Y{v}")),
                }),
            )
        }
    };
    let setup = json!({
        "gcode": flavor_map(|f| (f == "klipper").then(|| "SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=0".to_owned())),
        "note": format!("Orca sets the machine limit to the end value ({end}) and turns the default jerk or junction deviation off, so the per band command is the only limit in force."),
    });
    Ok(tower_model(
        &Tower {
            name: "cornering",
            size: p.size_mm,
            height: p.height_mm,
            band: p.band_mm,
            accel: 2000.0,
            values,
            label_text: &|v| if jd { format!("{v:.3}") } else { fmt_num(v) },
            commands: &commands,
            setup,
            extra_settings: vec![
                (
                    if jd {
                        "machine_max_junction_deviation"
                    } else {
                        "machine_max_jerk_x"
                    },
                    json!(end),
                ),
                (
                    if jd {
                        "default_junction_deviation"
                    } else {
                        "default_jerk"
                    },
                    json!(0),
                ),
            ],
            instructions: &[
                "Print the tower with pressure advance on. The cornering limit rises with height in steps.",
                "Low values round the corners and slow the print; high values sharpen them and add ringing and possibly layer shifts.",
                "Pick the height where the corners are sharp with acceptable ringing and read the value from expected.layerCommands. Stay well under a value that shifts layers.",
            ],
            table_key: if jd { "junctionDeviationMm" } else { "jerkMmS" },
        },
        p.labels,
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::float_cmp)]
    use super::super::{CalibRequest, generate};
    use super::*;

    fn make(v: Value) -> CalibModel {
        generate(&serde_json::from_value::<CalibRequest>(v).unwrap()).unwrap()
    }

    fn solid(m: &CalibModel) {
        assert_eq!(m.objects.len(), 1, "{}", m.name);
        let mesh = &m.objects[0].mesh;
        assert!(
            mesh.edge_report().is_watertight(),
            "{}: {:?}",
            m.name,
            mesh.edge_report()
        );
        assert_eq!(mesh.components().len(), 1, "{}", m.name);
    }

    fn cmd(m: &CalibModel, i: usize) -> &Value {
        &m.expected["layerCommands"][i]
    }

    #[test]
    fn vfa_speeds_step_per_band() {
        let m = make(json!({ "test": "vfa" }));
        solid(&m);
        assert_eq!(m.ranges.len(), 17);
        assert_eq!(m.ranges[0].settings["outer_wall_speed"], json!(40.0));
        assert_eq!(m.ranges[16].settings["outer_wall_speed"], json!(200.0));
        assert!((m.ranges[16].z_to_mm - 85.0).abs() < 1e-9);
        assert_eq!(m.objects[0].settings["wall_loops"], json!(1));
        assert!(!m.objects[0].settings.contains_key("spiral_mode"));
        let bare = make(json!({ "test": "vfa", "labels": false }));
        assert!(bare.objects[0].mesh.volume() > m.objects[0].mesh.volume());
        assert!(
            generate(&CalibRequest::Vfa(VfaParams {
                step_mm_s: 0.0,
                ..VfaParams::default()
            }))
            .is_err()
        );
    }

    #[test]
    fn frequency_tower_sweeps_and_writes_firmware_commands() {
        let m = make(json!({ "test": "input-shaping-freq" }));
        solid(&m);
        let table = m.expected["layerCommands"].as_array().unwrap();
        assert_eq!(table.len(), 60);
        assert_eq!(table[0]["freqHz"], json!(15.0));
        assert_eq!(table[59]["freqHz"], json!(110.0));
        assert!((table[59]["zToMm"].as_f64().unwrap() - 60.0).abs() < 1e-9);
        let g = &cmd(&m, 0)["gcode"];
        assert_eq!(
            g["klipper"],
            "SET_INPUT_SHAPER SHAPER_FREQ_X=15.00 SHAPER_FREQ_Y=15.00"
        );
        assert_eq!(g["marlin"], "M593 F15.00");
        assert_eq!(g["reprapFirmware"], "M593 F15.00");
        assert_eq!(cmd(&m, 0)["commands"][0]["type"], "inputShaping");
        let setup = &m.expected["setupGcode"]["gcode"];
        let k = setup["klipper"].as_str().unwrap();
        assert!(
            k.contains("SHAPER_TYPE=mzv")
                && k.contains("DAMPING_RATIO_X=0.150")
                && k.contains("MINIMUM_CRUISE_RATIO=0"),
            "{k}"
        );
        assert!(setup["reprapFirmware"].as_str().unwrap().contains("P\"mzv\""));
        assert!(setup["marlin"].as_str().unwrap().contains("D0.150"));
        let xy = make(json!({ "test": "input-shaping-freq", "startYHz": 20, "endYHz": 80 }));
        assert_eq!(cmd(&xy, 59)["commands"].as_array().unwrap().len(), 2);
        assert_eq!(cmd(&xy, 59)["gcode"]["marlin"], "M593 X F110.00\nM593 Y F80.00");
        assert!(
            generate(&CalibRequest::InputShapingFreq(InputShapingFreqParams {
                start_hz: 50.0,
                end_hz: 50.0,
                ..InputShapingFreqParams::default()
            }))
            .is_err()
        );
    }

    #[test]
    fn damping_tower_sweeps_the_ratio() {
        let m = make(json!({ "test": "input-shaping-damp" }));
        solid(&m);
        assert_eq!(cmd(&m, 0)["dampingRatio"], json!(0.0));
        assert_eq!(cmd(&m, 59)["dampingRatio"], json!(0.4));
        assert_eq!(
            cmd(&m, 59)["gcode"]["klipper"],
            "SET_INPUT_SHAPER DAMPING_RATIO_X=0.400 DAMPING_RATIO_Y=0.400"
        );
        assert!(cmd(&m, 0)["gcode"].get("klipper").is_none());
        assert!(
            m.expected["setupGcode"]["gcode"]["klipper"]
                .as_str()
                .unwrap()
                .contains("SHAPER_FREQ_X=30.00")
        );
        assert!(
            generate(&CalibRequest::InputShapingDamp(InputShapingDampParams {
                end_damping: 1.5,
                ..InputShapingDampParams::default()
            }))
            .is_err()
        );
    }

    #[test]
    fn cornering_tower_uses_jerk_or_junction_deviation() {
        let j = make(json!({ "test": "cornering" }));
        solid(&j);
        assert_eq!(cmd(&j, 0)["jerkMmS"], json!(1.0));
        assert_eq!(cmd(&j, 39)["jerkMmS"], json!(15.0));
        assert_eq!(
            cmd(&j, 0)["gcode"]["klipper"],
            "SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=1"
        );
        assert_eq!(cmd(&j, 0)["gcode"]["marlin"], "M205 X1 Y1");
        assert_eq!(j.objects[0].settings["machine_max_jerk_x"], json!(15.0));
        let d = make(json!({ "test": "cornering", "mode": "junctionDeviation" }));
        assert_eq!(cmd(&d, 39)["junctionDeviationMm"], json!(0.25));
        assert_eq!(cmd(&d, 39)["gcode"]["marlin"], "M205 J0.250");
        assert!(cmd(&d, 39)["gcode"].get("klipper").is_none());
        assert_eq!(d.objects[0].settings["default_junction_deviation"], json!(0));
        for bad in [
            json!({ "test": "cornering", "mode": "speed" }),
            json!({ "test": "cornering", "mode": "junctionDeviation", "end": 0.5 }),
            json!({ "test": "cornering", "start": 5, "end": 2 }),
        ] {
            assert!(generate(&serde_json::from_value::<CalibRequest>(bad).unwrap()).is_err());
        }
    }

    #[test]
    fn pressure_advance_paths_come_as_plans_and_gcode() {
        let line = make(json!({ "test": "pa-line", "gcode": { "flavor": "klipper" } }));
        assert!(line.objects.is_empty() && line.ranges.is_empty());
        assert_eq!(line.expected["plan"]["layers"].as_array().unwrap().len(), 2);
        assert_eq!(line.expected["pressureAdvance"].as_array().unwrap().len(), 50);
        let g = line.expected["gcode"].as_str().unwrap();
        assert!(g.contains("SET_PRESSURE_ADVANCE ADVANCE=0.0980") && g.contains("G1 X"));
        let pattern = make(json!({ "test": "pa-pattern", "start": 0.0, "end": 0.04, "step": 0.01 }));
        assert_eq!(pattern.expected["plan"]["layers"].as_array().unwrap().len(), 4);
        assert!(pattern.expected.get("gcode").is_none());
        assert_eq!(pattern.expected["suggestedSettings"]["wall_loops"], 3);
        let marlin = make(json!({ "test": "pa-pattern", "gcode": { "flavor": "marlin" } }));
        assert!(
            marlin.expected["gcode"]
                .as_str()
                .unwrap()
                .contains("M900 K0.0050")
        );
    }
}
