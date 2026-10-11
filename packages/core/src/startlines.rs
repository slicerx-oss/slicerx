// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The start G-code's own extrusions, such as a purge line or the A1's extrusion calibration lines,
//! drawn with the first layer as custom paths, since they print before it. They are read from the
//! finished G-code, so they always show what the file does.

use crate::extras::{FLAG_PATH_START, SegExtra};
use crate::fm::Fm as _;

/// One extruding move of the start G-code.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StartMove {
    pub from: (f32, f32),
    pub to: (f32, f32),
    pub z: f32,
    /// Bead width and height, micrometers.
    pub width_um: u16,
    pub height_um: u16,
    /// 0-based tool.
    pub tool: u8,
    /// Feed rate, tenths of mm/s.
    pub speed: u16,
    /// Volumetric flow, mm³/s.
    pub flow: f32,
    /// 1-based line in the file.
    pub line: u32,
    /// The first move of a run of extrusions.
    pub path_start: bool,
}

fn word(words: &[&str], letter: char) -> Option<f64> {
    words
        .iter()
        .find_map(|w| w.strip_prefix(letter))
        .and_then(|v| v.parse().ok())
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::too_many_arguments,
    reason = "format fields are f32 and u16; one move's fields"
)]
fn move_of(
    from: (f64, f64),
    to: (f64, f64),
    z: f64,
    de: f64,
    feed: f64,
    tool: u8,
    line: u32,
    start: bool,
    area: f64,
    nozzle: f64,
) -> StartMove {
    let len = (to.0 - from.0).m_hypot(to.1 - from.1);
    // the bead: the filament the move pushes out, spread over its length at the move's height
    let h = z.clamp(0.05, 1.0);
    let w = (de * area / (len * h)).clamp(nozzle * 0.5, nozzle * 4.0);
    let speed = feed / 60.0;
    StartMove {
        from: (from.0 as f32, from.1 as f32),
        to: (to.0 as f32, to.1 as f32),
        z: z as f32,
        width_um: (w * 1000.0).round().clamp(0.0, 65535.0) as u16,
        height_um: (h * 1000.0).round().clamp(0.0, 65535.0) as u16,
        tool,
        speed: (speed * 10.0).round().clamp(0.0, 65535.0) as u16,
        flow: (de * area / len * speed) as f32,
        line,
        path_start: start,
    }
}

/// The extruding moves of the start G-code: everything before the first layer's marker. Moves that only
/// prime or retract in place, and moves before the position is known (after homing), are left out.
pub fn read(gcode: &str, filament_diameter: f64, nozzle: f64) -> Vec<StartMove> {
    // the start ends at the first layer's marker; a file with none has no layers to put it with
    let Some(end) = crate::extras::LAYER_MARKS
        .iter()
        .filter_map(|m| {
            if gcode.starts_with(m) {
                Some(0)
            } else {
                gcode.find(&format!("\n{m}"))
            }
        })
        .min()
    else {
        return Vec::new();
    };
    let head = gcode.get(..end).unwrap_or_default();
    let area = std::f64::consts::PI * (filament_diameter / 2.0).m_powi(2);
    let mut out = Vec::new();
    let (mut abs_xyz, mut abs_e) = (true, true);
    let (mut x, mut y, mut z) = (None::<f64>, None::<f64>, None::<f64>);
    let (mut e, mut feed, mut tool) = (0.0f64, 1200.0f64, 0u8);
    let mut extruding = false;
    for (i, raw) in head.lines().enumerate() {
        let line = u32::try_from(i + 1).unwrap_or(u32::MAX);
        let text = raw.split(';').next().unwrap_or("").trim();
        let words: Vec<&str> = text.split_whitespace().collect();
        let Some((&cmd, args)) = words.split_first() else {
            continue;
        };
        match cmd {
            "G90" => abs_xyz = true,
            "G91" => abs_xyz = false,
            "M82" => abs_e = true,
            "M83" => abs_e = false,
            "G28" => {
                // homing leaves the head where the firmware puts it, which the file does not say: the axes it
                // names, or all of them
                let named = |a: char| args.iter().any(|w| w.starts_with(a));
                let all = !named('X') && !named('Y') && !named('Z');
                if all || named('X') {
                    x = None;
                }
                if all || named('Y') {
                    y = None;
                }
                if all || named('Z') {
                    z = None;
                }
                extruding = false;
            }
            "G92" => {
                if let Some(v) = word(args, 'E') {
                    e = v;
                }
                x = word(args, 'X').or(x);
                y = word(args, 'Y').or(y);
                z = word(args, 'Z').or(z);
            }
            c if c.starts_with('T') => {
                if let Ok(t) = c.get(1..).unwrap_or("").parse::<u8>() {
                    tool = t;
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                if let Some(f) = word(args, 'F') {
                    feed = f;
                }
                let step = |at: Option<f64>, v: Option<f64>| match (v, abs_xyz) {
                    (Some(v), true) => Some(v),
                    (Some(v), false) => at.map(|a| a + v),
                    (None, _) => at,
                };
                let (nx, ny, nz) = (
                    step(x, word(args, 'X')),
                    step(y, word(args, 'Y')),
                    step(z, word(args, 'Z')),
                );
                let de = word(args, 'E').map_or(0.0, |v| if abs_e { v - e } else { v });
                if let Some(v) = word(args, 'E') {
                    e = if abs_e { v } else { e + v };
                }
                let laid = match (x, y, nx, ny, nz) {
                    (Some(x0), Some(y0), Some(x1), Some(y1), Some(zz))
                        if de > 1e-6 && (x1 - x0).m_hypot(y1 - y0) > 1e-3 =>
                    {
                        out.push(move_of(
                            (x0, y0),
                            (x1, y1),
                            zz,
                            de,
                            feed,
                            tool,
                            line,
                            !extruding,
                            area,
                            nozzle,
                        ));
                        true
                    }
                    _ => false,
                };
                // a travel, a lift or a retraction ends the run
                let still = |a: Option<f64>, b: Option<f64>| match (a, b) {
                    (Some(a), Some(b)) => (a - b).abs() < 1e-9,
                    (None, None) => true,
                    _ => false,
                };
                extruding =
                    laid || (extruding && de.abs() <= 1e-6 && still(nx, x) && still(ny, y) && still(nz, z));
                (x, y, z) = (nx, ny, nz);
            }
            _ => {}
        }
    }
    out
}

/// The extras of the start moves, in the same order: their line, the start of each run, and the first
/// layer's nozzle temperature (`temp_c`), which the start heats to.
pub fn extras(moves: &[StartMove], temp_c: u16) -> Vec<SegExtra> {
    moves
        .iter()
        .map(|m| SegExtra {
            flags: if m.path_start { FLAG_PATH_START } else { 0 },
            line: m.line,
            temp_c,
            ..SegExtra::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // An A1's start, cut down: homing, a priming dab in place, two calibration lines at the front, a lift.
    const A1: &str = "M83\nG90\nG28\nG1 X-38 Y20 Z0.3 F1200\nG1 E10 F300\nG1 X18 Y0.5 F12000\nG1 Z0.3\nG1 X68 E5 F1200\nG1 X118 E5\nG1 E-.8\nG1 Z1\nG1 X120 Y5\n;LAYER_CHANGE\n;Z:0.2\nG1 X40 Y40 E2\n";

    #[test]
    fn reads_the_lines_before_the_first_layer_and_leaves_out_a_dab_in_place() {
        let m = read(A1, 1.75, 0.4);
        assert_eq!(m.len(), 2);
        assert_eq!(
            (m[0].from, m[0].to, m[1].to),
            ((18.0, 0.5), (68.0, 0.5), (118.0, 0.5))
        );
        assert_eq!((m[0].z, m[0].line, m[1].line), (0.3, 8, 9));
        // one run: the first move starts it
        assert!(m[0].path_start && !m[1].path_start);
        // 5 mm of 1.75 mm filament over 50 mm at 0.3 mm high is a bead about 0.8 mm wide
        assert!((790..=810).contains(&m[0].width_um), "{}", m[0].width_um);
        assert_eq!(m[0].speed, 200);
        // nothing from the layers
        assert!(m.iter().all(|s| s.line < 13));
    }

    #[test]
    fn reads_absolute_extrusion_and_relative_moves() {
        let g = "M82\nG92 E0\nG1 X10 Y10 Z0.2 F600\nG91\nG1 X20 E2\nG90\nG1 X60 Y10 E4\n;LAYER_CHANGE\n";
        let m = read(g, 1.75, 0.4);
        assert_eq!(
            m.iter().map(|s| (s.from, s.to)).collect::<Vec<_>>(),
            vec![((10.0, 10.0), (30.0, 10.0)), ((30.0, 10.0), (60.0, 10.0))]
        );
    }

    #[test]
    fn homing_one_axis_keeps_the_others() {
        // the A1 homes Z alone after its XY moves; the calibration lines then start from the known X and Y
        let g = "G90\nM83\nG1 X108 Y-0.5 F30000\nG28 Z P0 T300\nG1 Z0.3\nG0 X128 E8\n; CHANGE_LAYER\n";
        let m = read(g, 1.75, 0.4);
        assert_eq!(
            m.iter().map(|s| (s.from, s.to, s.z)).collect::<Vec<_>>(),
            vec![((108.0, -0.5), (128.0, -0.5), 0.3)]
        );
    }

    #[test]
    fn a_file_with_no_layer_marker_or_no_known_position_draws_nothing() {
        assert!(read("G1 X10 Y10 Z.2\nG1 X20 E1\n", 1.75, 0.4).is_empty());
        assert!(read("G28\nG1 X20 E1\n;LAYER_CHANGE\n", 1.75, 0.4).is_empty());
    }
}
