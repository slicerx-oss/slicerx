// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where the first brim loop sits against the first layer's outer wall when elephant foot compensation pulls that wall
//! in. A Prusa project grows its brim from the compensated outline (`brim_use_efc_outline`, set by the project read),
//! so the gap from the outer wall to the brim stays the same whatever the compensation. A Bambu Lab project grows it
//! from the outline before compensation, so the gap grows by the compensation.
//!
//! The projects in tests/fixtures/brim-efc are one 10 x 10 x 3 mm box on a 0.2 mm first layer with a 3 mm outer brim.
//! `mk4p--e<C>-s<S>` is a Prusa MK4S project (settings in `Slic3r_PE.config`, 0.5 mm first layer lines) with
//! `elefant_foot_compensation` C and `brim_separation` S. `p1s--e<C>-g0.5` is a Bambu Lab P1S project with
//! compensation C and `brim_object_gap` 0.5.
//!
//! The gap is the distance from the outer wall's centerline to the first brim loop's centerline on each of the four
//! sides (bounding boxes of the paths on the first layer), mm.

#![allow(
    clippy::disallowed_methods,
    clippy::float_cmp,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::path::{Path, PathBuf};

/// How near a gap must come, mm.
const TOL: f64 = 0.01;
/// The gap at no compensation and no separation on these projects: half of each 0.5 mm line less their overlap, mm.
const BASE_GAP: f64 = 0.479;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/brim-efc/{name}.3mf"))
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The G-code of a project, sliced with its own settings.
fn slice(name: &str) -> String {
    let dir = TempDir(std::env::temp_dir().join(format!("sx-brim-efc-{name}-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let out = dir.0.join("out.gcode");
    let o = std::process::Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(fixture(name))
        .args(["--plate", "1", "-o"])
        .arg(&out)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    std::fs::read_to_string(&out).unwrap()
}

/// The extruding paths of the first layer: each one's feature and points, mm. Arcs (G2, G3 with I and J) are
/// sampled along their sweep, so a bounding box holds the whole arc.
fn first_layer_paths(gcode: &str) -> Vec<(String, Vec<[f64; 2]>)> {
    let (mut x, mut y, mut z) = (0.0_f64, 0.0_f64, 0.0_f64);
    let mut relative_e = false;
    let mut e = 0.0_f64;
    let mut feature = String::new();
    let mut first_z: Option<f64> = None;
    let mut paths: Vec<(String, Vec<[f64; 2]>)> = Vec::new();
    let mut open = false;
    for line in gcode.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(';') {
            let rest = rest.trim();
            if let Some(f) = rest
                .strip_prefix("TYPE:")
                .or_else(|| rest.strip_prefix("FEATURE:"))
            {
                f.trim().clone_into(&mut feature);
                open = false;
            }
            continue;
        }
        let code = line.split(';').next().unwrap_or("");
        let mut words = code.split_whitespace();
        let Some(cmd) = words.next() else { continue };
        match cmd {
            "M83" => relative_e = true,
            "M82" => relative_e = false,
            "G92" => {
                for w in words {
                    if let Some(v) = w.strip_prefix('E') {
                        e = v.parse().unwrap_or(0.0);
                    }
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let get =
                    |c: char| -> Option<f64> { words.clone().find_map(|w| w.strip_prefix(c)?.parse().ok()) };
                let (nx, ny, nz) = (
                    get('X').unwrap_or(x),
                    get('Y').unwrap_or(y),
                    get('Z').unwrap_or(z),
                );
                let de = match get('E') {
                    Some(v) if relative_e => v,
                    Some(v) => {
                        let d = v - e;
                        e = v;
                        d
                    }
                    None => 0.0,
                };
                let (i, j) = (get('I'), get('J'));
                if nz != z {
                    z = nz;
                    open = false;
                }
                let moves = nx != x || ny != y;
                if de > 0.0 && moves {
                    let fz = *first_z.get_or_insert(z);
                    if z > fz + 1e-3 {
                        break;
                    }
                    if !open {
                        paths.push((feature.clone(), vec![[x, y]]));
                        open = true;
                    }
                    let pts = &mut paths.last_mut().unwrap().1;
                    if let (true, Some(i)) = (cmd == "G2" || cmd == "G3", i) {
                        let (cx, cy) = (x + i, y + j.unwrap_or(0.0));
                        let r = (x - cx).hypot(y - cy);
                        let a0 = (y - cy).atan2(x - cx);
                        let mut a1 = (ny - cy).atan2(nx - cx);
                        let tau = std::f64::consts::TAU;
                        if cmd == "G3" {
                            while a1 <= a0 {
                                a1 += tau;
                            }
                        } else {
                            while a1 >= a0 {
                                a1 -= tau;
                            }
                        }
                        let n = ((a1 - a0).abs() * r / 0.05).ceil().max(2.0);
                        let steps = n as usize;
                        for k in 1..=steps {
                            let a = a0 + (a1 - a0) * k as f64 / n;
                            pts.push([cx + r * a.cos(), cy + r * a.sin()]);
                        }
                    } else {
                        pts.push([nx, ny]);
                    }
                } else if moves {
                    open = false;
                }
                x = nx;
                y = ny;
            }
            _ => {}
        }
    }
    paths
}

fn bbox(points: &[[f64; 2]]) -> [f64; 4] {
    points
        .iter()
        .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
            [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
        })
}

/// The gap on each side (left, front, right, back) from the box's first layer outer wall to the brim loop nearest it.
fn brim_gaps(name: &str) -> [f64; 4] {
    let paths = first_layer_paths(&slice(name));
    let area = |b: &[f64; 4]| (b[2] - b[0]) * (b[3] - b[1]);
    let wall = paths
        .iter()
        .filter(|(f, _)| f.eq_ignore_ascii_case("outer wall"))
        .map(|(_, p)| bbox(p))
        .max_by(|a, b| area(a).total_cmp(&area(b)))
        .unwrap_or_else(|| panic!("{name}: no first layer outer wall"));
    let inner = paths
        .iter()
        .filter(|(f, _)| f.eq_ignore_ascii_case("brim"))
        .map(|(_, p)| bbox(p))
        .filter(|b| b[0] < wall[0] && b[1] < wall[1] && b[2] > wall[2] && b[3] > wall[3])
        .min_by(|a, b| area(a).total_cmp(&area(b)))
        .unwrap_or_else(|| panic!("{name}: no brim loop round the box"));
    [
        wall[0] - inner[0],
        wall[1] - inner[1],
        inner[2] - wall[2],
        inner[3] - wall[3],
    ]
}

fn assert_gap(name: &str, want: f64) {
    let gaps = brim_gaps(name);
    assert!(
        gaps.iter().all(|g| (g - want).abs() <= TOL),
        "{name}: brim gaps {gaps:?}, want {want:.3} on every side"
    );
}

#[test]
fn a_prusa_projects_brim_keeps_its_gap_to_the_compensated_wall() {
    for c in ["0", "0.2", "0.4"] {
        for (s, separation) in [("0", 0.0), ("0.5", 0.5)] {
            assert_gap(&format!("mk4p--e{c}-s{s}"), BASE_GAP + separation);
        }
    }
}

#[test]
fn a_bambu_lab_projects_brim_gap_grows_by_the_compensation() {
    assert_gap("p1s--e0-g0.5", BASE_GAP + 0.5);
    assert_gap("p1s--e0.2-g0.5", BASE_GAP + 0.5 + 0.2);
}
