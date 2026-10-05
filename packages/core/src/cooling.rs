// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A layer's time as Orca's cooling buffer measures it on the layer's G-code
//! (`CoolingBuffer::parse_layer_gcode`), which decides the cooling slowdown and the fan.
//!
//! Each `G0` to `G3` move takes its length (XYZ, an arc along the arc, or the extruder's travel when only E
//! moves) over its feed rate, with no acceleration, and each `G4` its wait. Moves before the layer's first
//! extrusion do not count: the layer change and the travel to the first path belong to no layer.
//! Everything after it does, the travels, retractions, wipes and custom G-code inside the layer (a timelapse
//! shot on a bed slinger) included.

use crate::fm::Fm as _;

/// Seconds the cooling buffer gives the layer whose G-code is `text`.
pub(crate) fn layer_time(text: &[u8]) -> f64 {
    let mut at = [0.0f64; 4];
    let mut feed = 0.0;
    let mut relative = false;
    let mut relative_e = true;
    let mut started = false;
    let mut t = 0.0;
    for line in text.split(|&b| b == b'\n') {
        let line = line.split(|&b| b == b';').next().unwrap_or(&[]);
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        let mut words = line.split_ascii_whitespace();
        let value = |w: &str| w.get(1..).and_then(|v| v.parse::<f64>().ok());
        let cmd = words.next();
        match cmd {
            Some("G90") => relative = false,
            Some("G91") => relative = true,
            Some("M82") => relative_e = false,
            Some("M83") => relative_e = true,
            Some("G92") => {
                for w in words {
                    if let (Some("E" | "e"), Some(v)) = (w.get(..1), value(w)) {
                        at[3] = v;
                    }
                }
            }
            Some("G4") if started => {
                for w in words {
                    match (w.get(..1), value(w)) {
                        (Some("S" | "s"), Some(v)) => t += v,
                        (Some("P" | "p"), Some(v)) => t += v / 1000.0,
                        _ => {}
                    }
                }
            }
            Some(g @ ("G0" | "G1" | "G2" | "G3")) => {
                let mut to = at;
                if relative_e {
                    to[3] = 0.0;
                }
                let (mut i, mut j) = (0.0, 0.0);
                let mut xy = false;
                for w in words {
                    let Some(v) = value(w) else { continue };
                    let axis = match w.get(..1) {
                        Some("X" | "x") => 0,
                        Some("Y" | "y") => 1,
                        Some("Z" | "z") => 2,
                        Some("E" | "e") => 3,
                        Some("F" | "f") => {
                            if v > 0.0 {
                                feed = v / 60.0;
                            }
                            continue;
                        }
                        Some("I" | "i") => {
                            i = v;
                            continue;
                        }
                        Some("J" | "j") => {
                            j = v;
                            continue;
                        }
                        _ => continue,
                    };
                    xy |= axis < 2;
                    // E is a distance in relative mode and a position otherwise; X, Y and Z follow G90 and G91.
                    let shift = if axis < 3 && relative {
                        at.get(axis).copied().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    if let Some(slot) = to.get_mut(axis) {
                        *slot = shift + v;
                    }
                }
                let de = if relative_e { to[3] } else { to[3] - at[3] };
                let dz = to[2] - at[2];
                let dxy = if g == "G2" || g == "G3" {
                    arc_length([at[0], at[1]], [to[0], to[1]], [at[0] + i, at[1] + j], g == "G3")
                } else {
                    (to[0] - at[0]).m_hypot(to[1] - at[1])
                };
                if !started && de > 0.0 && xy && dxy > 0.0 {
                    started = true;
                }
                let len = dxy.m_hypot(dz);
                let len = if len > 0.0 { len } else { de.abs() };
                if started && feed > 0.0 {
                    t += len / feed;
                }
                if relative_e {
                    to[3] = at[3];
                }
                at = to;
            }
            _ => {}
        }
    }
    t
}

/// The length of the arc from `a` to `b` around `c`, counterclockwise when `ccw`; a full circle when they
/// meet.
fn arc_length(a: [f64; 2], b: [f64; 2], c: [f64; 2], ccw: bool) -> f64 {
    let r = (a[0] - c[0]).m_hypot(a[1] - c[1]);
    let start = (a[1] - c[1]).m_atan2(a[0] - c[0]);
    let end = (b[1] - c[1]).m_atan2(b[0] - c[0]);
    let tau = std::f64::consts::TAU;
    let mut sweep = if ccw { end - start } else { start - end };
    sweep = sweep.rem_euclid(tau);
    if sweep < 1e-9 {
        sweep = tau;
    }
    r * sweep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_from_the_first_extrusion() {
        // The layer change, the travel and the unretract before the first extrusion do not count.
        let g = "G1 Z0.4 F600\nG0 X10 Y0 F6000\nG1 E0.8 F1800\nG1 F600\nG1 X20 Y0 E0.5\n\
                 G1 E-0.8 F1800\nG0 X20 Y30 F6000\nG4 P500\nG2 X20 Y50 I0 J10 F600 E1\n";
        let t = layer_time(g.as_bytes());
        let half_circle = std::f64::consts::PI * 10.0;
        let want = 10.0 / 10.0 + 0.8 / 30.0 + 30.0 / 100.0 + 0.5 + half_circle / 10.0;
        assert!((t - want).abs() < 1e-9, "{t} {want}");
    }

    #[test]
    fn a_layer_with_no_extrusion_takes_no_time() {
        assert!(layer_time(b"G1 Z1 F600\nG0 X100 F6000\nG4 S2\n").abs() < f64::EPSILON);
    }
}
