// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! One wall on top surfaces in a Bambu Studio project, which sets it with `top_one_wall_type` (`all top`, `topmost` or
//! `not apply`) and leaves `only_one_wall_top` unread: the type decides, whatever `only_one_wall_top` says.
//!
//! The projects in tests/fixtures/one-wall-top are A1 projects (0.20 mm Standard, two classic walls, sparse infill
//! 15 %) of 26 strips 2.2 mm tall along 45 degrees, 30.9 mm long and 1.596 to 2.540 mm wide. The checks read the top
//! layer of the strip 2.162 mm wide: `oow1-not` has `only_one_wall_top` 1 with `not apply`, `oow0-all` has
//! `only_one_wall_top` 0 with `all top`.

#![allow(
    clippy::disallowed_methods,
    clippy::cast_possible_truncation,
    clippy::float_cmp,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/one-wall-top")
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn slice(case: &str) -> String {
    let dir = TempDir(std::env::temp_dir().join(format!("sx-one-wall-top-{case}-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let out = dir.0.join("out.gcode");
    let o = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixtures().join(format!("a1--n-cl-sp15-L2-p0-{case}.3mf")))
        .args(["--plate", "1", "-o"])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{case}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(&out).unwrap()
}

/// The strip 2.162 mm wide: its center on the plate, its length and its width, mm. It runs along 45 degrees.
const STRIP: ([f64; 2], f64, f64) = ([121.208_593, 134.791_407], 30.9, 2.162);

/// One extrusion on the top layer: its feature, its length, and how far its middle sits from the strip's center line
/// across the strip and along it, mm.
struct Bead {
    feature: String,
    length: f64,
    across: f64,
    along: f64,
}

/// The extrusions of the last layer (after the last layer change), arcs measured along the arc.
fn top_layer(gcode: &str) -> Vec<Bead> {
    let layers = gcode.lines().filter(|l| l.starts_with("; CHANGE_LAYER")).count();
    assert!(layers > 0, "a layer change");
    let (sin, cos) = 45f64.to_radians().sin_cos();
    let mut at = [0.0f64; 2];
    let mut e_abs = 0.0f64;
    let mut relative = true;
    let (mut seen, mut feature) = (0, String::new());
    let mut beads = Vec::new();
    for line in gcode.lines() {
        seen += usize::from(line.starts_with("; CHANGE_LAYER"));
        if let Some(f) = line.strip_prefix("; FEATURE: ") {
            f.trim().clone_into(&mut feature);
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let word = code.split_whitespace().next().unwrap_or("");
        match word {
            "M83" => relative = true,
            "M82" => relative = false,
            "G92" => {
                if let Some(v) = code.split_whitespace().find_map(|t| t.strip_prefix('E')) {
                    e_abs = v.parse().unwrap();
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let get = |k: char| {
                    code.split_whitespace()
                        .skip(1)
                        .find_map(|t| t.strip_prefix(k))
                        .and_then(|v| v.parse::<f64>().ok())
                };
                let to = [get('X').unwrap_or(at[0]), get('Y').unwrap_or(at[1])];
                let de = get('E').map_or(0.0, |e| {
                    if relative {
                        e
                    } else {
                        let step = e - e_abs;
                        e_abs = e;
                        step
                    }
                });
                let length = match (word, get('I'), get('J')) {
                    ("G2" | "G3", Some(di), Some(dj)) => {
                        let center = [at[0] + di, at[1] + dj];
                        let from = (at[1] - center[1]).atan2(at[0] - center[0]);
                        let till = (to[1] - center[1]).atan2(to[0] - center[0]);
                        let mut sweep = if word == "G3" { till - from } else { from - till };
                        if sweep <= 0.0 {
                            sweep += std::f64::consts::TAU;
                        }
                        di.hypot(dj) * sweep
                    }
                    _ => (to[0] - at[0]).hypot(to[1] - at[1]),
                };
                if seen == layers && de > 0.0 && length > 0.0 {
                    let mid = [
                        f64::midpoint(at[0], to[0]) - STRIP.0[0],
                        f64::midpoint(at[1], to[1]) - STRIP.0[1],
                    ];
                    beads.push(Bead {
                        feature: feature.clone(),
                        length,
                        along: mid[0] * cos + mid[1] * sin,
                        across: -mid[0] * sin + mid[1] * cos,
                    });
                }
                at = to;
            }
            _ => {}
        }
    }
    beads
}

/// Per feature, the printed length on the top layer of the strip 2.162 mm wide and its count of beads longer than
/// 5 mm (the long sides of the walls, the surface lines).
fn strip_features(gcode: &str) -> BTreeMap<String, (f64, usize)> {
    let mut out: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    for b in top_layer(gcode) {
        if b.across.abs() <= STRIP.2 / 2.0 + 0.05 && b.along.abs() <= STRIP.1 / 2.0 + 0.5 {
            let e = out.entry(b.feature).or_default();
            e.0 += b.length;
            e.1 += usize::from(b.length > 5.0);
        }
    }
    out
}

/// Inner wall length on the whole top layer.
fn top_inner_wall(gcode: &str) -> f64 {
    top_layer(gcode)
        .iter()
        .filter(|b| b.feature == "Inner wall")
        .map(|b| b.length)
        .sum()
}

#[test]
fn not_apply_keeps_both_walls_on_top_whatever_only_one_wall_top_says() {
    // `only_one_wall_top` 1 with `not apply`: two walls, the inner one along both long sides, and the strip between
    // them too narrow for a top surface line, so gap fill only.
    let g = slice("oow1-not");
    let f = strip_features(&g);
    let inner = f.get("Inner wall").copied().unwrap_or_default();
    assert!(
        inner.0 > 55.0 && inner.1 >= 2,
        "inner wall on the strip's top layer: {inner:?} ({f:?})"
    );
    assert!(
        !f.contains_key("Top surface"),
        "no top surface line on the strip: {f:?}"
    );
    assert!(
        f.get("Gap infill").is_some_and(|g| g.0 > 5.0),
        "gap fill between the inner walls: {f:?}"
    );
}

#[test]
fn all_top_gives_one_wall_on_top_whatever_only_one_wall_top_says() {
    // `only_one_wall_top` 0 with `all top`: one wall on the top layer everywhere, and the strip gets top surface lines
    // where two walls left room for gap fill only.
    let g = slice("oow0-all");
    let inner = top_inner_wall(&g);
    assert!(inner < 1e-6, "inner wall on the top layer: {inner:.3} mm");
    let f = strip_features(&g);
    let top = f.get("Top surface").copied().unwrap_or_default();
    assert!(top.1 >= 3, "top surface lines on the strip: {top:?} ({f:?})");
}
