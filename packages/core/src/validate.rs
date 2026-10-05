// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The G-code validator behind the correctness gates: no extruding move with
//! negative E, retraction never deeper than a limit, no move outside the bed,
//! Z never goes down, absolute XYZ with relative E.

/// What the validator found.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct GcodeReport {
    /// First errors found (at most 20), with 1-based line numbers.
    pub errors: Vec<String>,
    pub error_count: usize,
    pub layers: u32,
    pub moves: u64,
    /// Sum of positive E on moves with XY, mm.
    pub extruded_mm: f64,
}

impl GcodeReport {
    pub fn ok(&self) -> bool {
        self.error_count == 0
    }
}

/// The deepest retraction a config writes: the travel retraction or, at a tool change, the tool change one.
pub fn deepest_retraction(c: &crate::config::PrintConfig) -> f64 {
    let toolchange = match c.raw.get("retract_length_toolchange") {
        Some(serde_json::Value::Array(a)) => {
            a.iter().filter_map(serde_json::Value::as_f64).fold(0.0, f64::max)
        }
        Some(v) => v.as_f64().unwrap_or(0.0),
        None => 10.0,
    };
    c.retraction_length.max(toolchange).max(0.0)
}

/// Checks `gcode` against a bed rectangle `[min_x, min_y, max_x, max_y]` and
/// a maximum height, both in mm. `max_retract` is the deepest retraction allowed.
pub fn validate_gcode(gcode: &[u8], bed: [f64; 4], max_z: f64, max_retract: f64) -> GcodeReport {
    let mut r = GcodeReport::default();
    let err = |r: &mut GcodeReport, line: usize, msg: &str| {
        r.error_count += 1;
        if r.errors.len() < 20 {
            r.errors.push(format!("line {}: {msg}", line + 1));
        }
    };
    let mut z = 0.0f64;
    let mut relative_e = false;
    let mut e_pos = 0.0f64;
    let mut absolute_xyz = true;
    let mut retracted = 0.0f64;
    // The layer's own Z from `;Z:`; a hop may lift above it and come back down to it.
    let mut layer_z: Option<f64> = None;
    // A spiral vase layer starts one layer height lower, at the top of the layer below.
    let mut layer_h = 0.0f64;
    let mut in_wipe = false;
    let eps = 1e-3;
    for (ln, raw) in gcode.split(|&c| c == b'\n').enumerate() {
        let line = raw.split(|&c| c == b';').next().unwrap_or(&[]);
        if crate::extras::is_layer_mark(raw) {
            r.layers += 1;
        } else if raw.starts_with(b";WIPE_START") || raw.starts_with(b"; WIPE_START") {
            in_wipe = true;
        } else if raw.starts_with(b";WIPE_END") || raw.starts_with(b"; WIPE_END") {
            in_wipe = false;
        } else if let Some(v) = raw
            .strip_prefix(b";Z:")
            .or_else(|| raw.strip_prefix(b"; Z_HEIGHT:"))
        {
            layer_z = std::str::from_utf8(v).ok().and_then(|t| t.trim().parse().ok());
        } else if let Some(v) = raw
            .strip_prefix(b";HEIGHT:")
            .or_else(|| raw.strip_prefix(b"; LAYER_HEIGHT:"))
        {
            layer_h = std::str::from_utf8(v)
                .ok()
                .and_then(|t| t.trim().parse().ok())
                .unwrap_or(0.0);
        }
        let Ok(text) = std::str::from_utf8(line) else {
            err(&mut r, ln, "not UTF-8");
            continue;
        };
        let mut words = text.split_ascii_whitespace();
        let Some(cmd) = words.next() else { continue };
        match cmd {
            "M83" => relative_e = true,
            "M82" => relative_e = false,
            "G92" => {
                for w in words {
                    if let Some(v) = w.strip_prefix('E').and_then(|t| t.parse::<f64>().ok()) {
                        e_pos = v;
                    }
                }
            }
            "G90" => absolute_xyz = true,
            "G91" => absolute_xyz = false,
            "G0" | "G1" | "G2" | "G3" => {
                let (mut x, mut y, mut nz, mut e) = (None, None, None, None);
                for w in words {
                    let (k, v) = w.split_at(1);
                    let Ok(v) = v.parse::<f64>() else {
                        err(&mut r, ln, "bad number");
                        continue;
                    };
                    match k {
                        "X" => x = Some(v),
                        "Y" => y = Some(v),
                        "Z" => nz = Some(v),
                        "E" => e = Some(v),
                        _ => {}
                    }
                }
                r.moves += 1;
                if !absolute_xyz {
                    // A relative move is fine in the start sequence (a lift before homing),
                    // not once layers begin.
                    if r.layers > 0 {
                        err(&mut r, ln, "relative XYZ is not expected");
                    }
                    x = None;
                    y = None;
                    nz = nz.map(|d| z + d);
                }
                // Absolute extruder distances count from the last G92 E.
                if !relative_e && let Some(abs) = e {
                    e = Some(abs - e_pos);
                    e_pos = abs;
                }
                if let Some(x) = x
                    && (x < bed[0] - eps || x > bed[2] + eps)
                {
                    err(&mut r, ln, "X outside the bed");
                }
                if let Some(y) = y
                    && (y < bed[1] - eps || y > bed[3] + eps)
                {
                    err(&mut r, ln, "Y outside the bed");
                }
                if let Some(nz) = nz {
                    if nz + eps < layer_z.map_or(z, |lz| lz - layer_h) {
                        err(&mut r, ln, "Z went down");
                    }
                    if nz > max_z + eps {
                        err(&mut r, ln, "Z above the printable height");
                    }
                    z = nz;
                }
                if let Some(e) = e {
                    let xy = x.is_some() || y.is_some();
                    if xy && !(in_wipe && e < 0.0) {
                        if e < 0.0 {
                            err(&mut r, ln, "negative E on an extruding move");
                        }
                        if retracted > eps {
                            err(&mut r, ln, "extruding while retracted");
                        }
                        r.extruded_mm += e;
                    } else {
                        retracted -= e;
                        if retracted > max_retract + eps {
                            err(&mut r, ln, "retraction deeper than allowed");
                        }
                        // A restart extra pushes a little past the retracted amount.
                        if retracted < -1.0 - eps {
                            err(&mut r, ln, "unretract without a retraction");
                        } else if retracted < 0.0 {
                            // The extra stays in the line as extrusion.
                            retracted = 0.0;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catches_bad_moves() {
        let g = b"G90\nM83\nG1 Z0.2\nG1 X10 Y10 E0.5\nG1 X300 Y10 E0.1\nG1 Z0.1\nG1 X10 Y20 E-0.1\n";
        let r = validate_gcode(g, [0.0, 0.0, 256.0, 256.0], 250.0, 2.0);
        assert_eq!(r.error_count, 3, "{:?}", r.errors);
    }

    #[test]
    fn accepts_retraction_cycle() {
        let g = b"G90\nM83\nG1 E-0.8 F1800\nG1 Z0.2\nG0 X10 Y10\nG1 E0.8\nG1 X20 Y10 E0.4\n";
        assert!(validate_gcode(g, [0.0, 0.0, 256.0, 256.0], 250.0, 2.0).ok());
    }
}
