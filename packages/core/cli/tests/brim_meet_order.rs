// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Which object keeps its whole brim where the brims of two objects meet, and the order a cut brim prints in. Where
//! the objects use different filaments, the object on the lower filament keeps every loop and the other brim stops at
//! its edge. A brim cut short prints from the outside in: its outermost loop first, then the pieces of the loops
//! between, then the loop next to the object, right before the object's walls.
//!
//! The projects in tests/fixtures/brim-meet are Bambu Lab A1 projects of 20 x 20 x 1 mm boxes in a row along X at
//! Y 90, each on the filament set for it in the project, with a 3 mm outer brim and no brim gap, a 0.2 mm first layer
//! of 0.5 mm lines (brim loops 0.457 mm apart), elephant foot compensation 0.2, no skirt and the prime tower at
//! (200, 170): `a1--row2-f21` has boxes at X 98 (filament 2) and 122 (filament 1), `a1--row2-f12` the same boxes on
//! filaments 1 and 2, and `a1--row3-f212` and `a1--row3-f121` boxes at X 86, 110 and 134 on filaments 2, 1 and 2 and
//! on 1, 2 and 1. The boxes stand 4 mm apart, so their brims meet in the gap. `a1--row2-f21-b5` is `a1--row2-f21`
//! with a 5 mm brim. `a1--feet2` is one object on filament 1 of two such boxes at X 88.75 and 111.25 (2.5 mm apart, so
//! its two brims meet), and `a1--feet2-far` adds a box at (40, 200) on filament 1, far from it.
//!
//! Each brim run is measured per side of its box: the median distance of its points from the box's edge along the
//! straight part of that side.

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

/// Half the side of each box, mm.
const HALF: f64 = 10.0;
/// How near a side's distance must come, mm.
const TOL: f64 = 0.03;
/// The loops of a whole 3 mm brim, from the box out, mm.
const LOOPS: [f64; 6] = [0.229, 0.686, 1.143, 1.6, 2.057, 2.514];
/// The cut outermost loop's distance on the side facing the other box, mm.
const CUT: f64 = 1.029;
/// The span of the middle loops of a cut brim, between the loop next to the box and the outermost one, mm. Where the
/// cut loops end, and so how the middle loops join into pieces, is not pinned here.
const MIDDLE: [f64; 2] = [0.686, 2.057];

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/brim-meet/{name}.3mf"))
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
    let dir = TempDir(std::env::temp_dir().join(format!("sx-brim-meet-{name}-{}", std::process::id())));
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

/// The extruding paths of the first layer in print order: each one's feature and points, mm. Arcs (G2, G3 with I and
/// J) are sampled along their sweep.
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

/// One brim run: its box (index into the centers), its distance from the box's edge on each side (left, front,
/// right, back), None where it does not run along that side, and how far its farthest point lies from the box, mm.
#[derive(Debug)]
struct Run {
    object: usize,
    sides: [Option<f64>; 4],
    reach: f64,
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.len() < 20 {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        f64::midpoint(v[n / 2 - 1], v[n / 2])
    })
}

/// The brim runs of the first layer in print order, each measured against the box it lies nearest.
fn brim_runs(name: &str, centers: &[[f64; 2]]) -> Vec<Run> {
    first_layer_paths(&slice(name))
        .into_iter()
        .filter(|(f, _)| f.eq_ignore_ascii_case("brim"))
        .map(|(_, pts)| {
            let n = pts.len() as f64;
            let mid = [
                pts.iter().map(|p| p[0]).sum::<f64>() / n,
                pts.iter().map(|p| p[1]).sum::<f64>() / n,
            ];
            let object = (0..centers.len())
                .min_by(|&a, &b| {
                    let d = |c: [f64; 2]| (c[0] - mid[0]).hypot(c[1] - mid[1]);
                    d(centers[a]).total_cmp(&d(centers[b]))
                })
                .unwrap();
            let [cx, cy] = centers[object];
            let mut side: [Vec<f64>; 4] = Default::default();
            let mut reach = 0.0_f64;
            for w in pts.windows(2) {
                let (a, b) = (w[0], w[1]);
                let steps = ((b[0] - a[0]).hypot(b[1] - a[1]) / 0.05).ceil().max(1.0) as usize;
                for k in 0..steps {
                    let t = k as f64 / steps as f64;
                    let (px, py) = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
                    reach = reach.max(
                        ((px - cx).abs() - HALF)
                            .max(0.0)
                            .hypot(((py - cy).abs() - HALF).max(0.0)),
                    );
                    if (py - cy).abs() < HALF - 0.5 {
                        if px < cx - HALF {
                            side[0].push(cx - HALF - px);
                        } else if px > cx + HALF {
                            side[2].push(px - cx - HALF);
                        }
                    }
                    if (px - cx).abs() < HALF - 0.5 {
                        if py < cy - HALF {
                            side[1].push(cy - HALF - py);
                        } else if py > cy + HALF {
                            side[3].push(py - cy - HALF);
                        }
                    }
                }
            }
            Run {
                object,
                sides: side.map(median),
                reach,
            }
        })
        .collect()
}

fn near(v: Option<f64>, want: f64) -> bool {
    v.is_some_and(|v| (v - want).abs() <= TOL)
}

/// The runs of one box, in print order.
fn of(runs: &[Run], object: usize) -> Vec<&Run> {
    runs.iter().filter(|r| r.object == object).collect()
}

/// A whole brim: the six loops, each closed round all four sides at one distance.
fn assert_whole(name: &str, runs: &[&Run]) {
    let mut got: Vec<f64> = runs
        .iter()
        .map(|r| {
            let d = r.sides[0].unwrap_or(f64::NAN);
            assert!(
                r.sides.iter().all(|s| near(*s, d)),
                "{name}: a loop that is not whole: {r:?}"
            );
            d
        })
        .collect();
    got.sort_by(f64::total_cmp);
    assert_eq!(got.len(), LOOPS.len(), "{name}: loops {got:?}");
    for (g, w) in got.iter().zip(LOOPS) {
        assert!((g - w).abs() <= TOL, "{name}: loops {got:?}, want {LOOPS:?}");
    }
}

/// A brim cut on the side `facing` (0 left, 2 right) by the brim of the box next to it, printed from the outside in:
/// the outermost loop (cut to `CUT` on that side), the pieces of the middle loops off that side, then the loop next
/// to the box.
fn assert_cut(name: &str, runs: &[&Run], facing: usize) {
    let [outer, pieces @ .., inner] = runs else {
        panic!("{name}: no cut brim: {runs:?}");
    };
    assert!(!pieces.is_empty(), "{name}: no middle pieces: {runs:?}");
    for (i, s) in outer.sides.iter().enumerate() {
        let want = if i == facing { CUT } else { 2.514 };
        assert!(near(*s, want), "{name}: first run {outer:?}, want the outer loop");
    }
    for piece in pieces {
        for (i, s) in piece.sides.iter().enumerate() {
            if i == facing {
                assert!(s.is_none(), "{name}: piece {piece:?} runs along the cut side");
            } else {
                assert!(
                    s.is_some_and(|d| d > MIDDLE[0] - TOL && d < MIDDLE[1] + TOL),
                    "{name}: piece {piece:?}, want it between the inner and outer loops off the cut side"
                );
            }
        }
    }
    assert!(
        inner.sides.iter().all(|s| near(*s, 0.229)),
        "{name}: last run {inner:?}, want the loop next to the box"
    );
}

#[test]
fn where_two_filaments_meet_the_lower_filament_keeps_its_whole_brim() {
    let name = "a1--row2-f21";
    let runs = brim_runs(name, &[[98.0, 90.0], [122.0, 90.0]]);
    assert_whole(name, &of(&runs, 1));
    assert_cut(name, &of(&runs, 0), 2);
}

#[test]
fn a_middle_box_on_the_lower_filament_keeps_its_whole_brim_on_both_sides() {
    let name = "a1--row3-f212";
    let runs = brim_runs(name, &[[86.0, 90.0], [110.0, 90.0], [134.0, 90.0]]);
    assert_whole(name, &of(&runs, 1));
    assert_cut(name, &of(&runs, 0), 2);
    assert_cut(name, &of(&runs, 2), 0);
}

#[test]
fn a_cut_brim_prints_from_the_outside_in() {
    let name = "a1--row2-f12";
    let runs = brim_runs(name, &[[98.0, 90.0], [122.0, 90.0]]);
    assert_whole(name, &of(&runs, 0));
    assert_cut(name, &of(&runs, 1), 0);
}

/// The middle box of `a1--row3-f121` is cut on both sides, so its brim between the outermost loop and the loop next to
/// the box splits into a strip along its front and one along its back. Each strip prints whole, from the outside in,
/// before the other: the head crosses the box once, not at every loop.
#[test]
fn a_brim_cut_on_two_sides_prints_piece_by_piece() {
    let name = "a1--row3-f121";
    let runs = brim_runs(name, &[[86.0, 90.0], [110.0, 90.0], [134.0, 90.0]]);
    assert_whole(name, &of(&runs, 0));
    assert_whole(name, &of(&runs, 2));
    let middle = of(&runs, 1);
    let [outer, strips @ .., inner] = middle.as_slice() else {
        panic!("{name}: no cut brim: {middle:?}");
    };
    for (i, s) in outer.sides.iter().enumerate() {
        let want = if i % 2 == 0 { CUT } else { 2.514 };
        assert!(
            near(*s, want),
            "{name}: first run {outer:?}, want the outer loop cut on both sides"
        );
    }
    assert!(
        inner.sides.iter().all(|s| near(*s, 0.229)),
        "{name}: last run {inner:?}, want the loop next to the box"
    );
    // Each strip runs along one side only: 1 for the front, 3 for the back.
    let side_of = |r: &Run| -> usize {
        match r.sides {
            [None, Some(_), None, None] => 1,
            [None, None, None, Some(_)] => 3,
            _ => panic!("{name}: a middle run off a single side: {r:?}"),
        }
    };
    let sides: Vec<usize> = strips.iter().map(|r| side_of(r)).collect();
    let switches = sides.windows(2).filter(|w| w[0] != w[1]).count();
    assert!(
        sides.contains(&1) && sides.contains(&3) && switches == 1,
        "{name}: strips print by side {sides:?}, want one strip whole and then the other: {strips:?}"
    );
    for w in strips.windows(2).filter(|w| side_of(w[0]) == side_of(w[1])) {
        assert!(
            w[0].reach > w[1].reach + TOL,
            "{name}: a strip not from the outside in: {:?} then {:?}",
            w[0],
            w[1]
        );
    }
}

/// A cut brim prints its loops in pairs: each run goes out along one loop and back along another, joined round the
/// cut ends. The 5 mm brim of the filament 2 box of `a1--row2-f21-b5` is cut on its right to five such runs, from
/// the outermost pair (4.342 and 0.229 mm) in, each holding two loops.
#[test]
fn a_cut_brim_keeps_its_loops_in_pairs() {
    let name = "a1--row2-f21-b5";
    let runs = brim_runs(name, &[[98.0, 90.0], [122.0, 90.0]]);
    let cut = of(&runs, 0);
    let reaches: Vec<f64> = cut.iter().map(|r| r.reach).collect();
    let want = [4.342, 3.885, 3.428, 2.971, 2.514];
    assert_eq!(cut.len(), want.len(), "{name}: cut brim runs {cut:?}");
    for (r, w) in cut.iter().zip(want) {
        assert!(
            (r.reach - w).abs() <= TOL && r.sides[2].is_none(),
            "{name}: runs reach {reaches:?}, want {want:?} off the cut side: {r:?}"
        );
    }
    // Each run holds two loops: its median on the front and back lies between them, away from both.
    for r in &cut {
        for s in [r.sides[1], r.sides[3]] {
            assert!(
                s.is_some_and(|d| d > 0.229 + TOL && d < r.reach - TOL),
                "{name}: a run of one loop: {r:?}"
            );
        }
    }
}

/// The extent of each brim run of the first layer round the object standing at `center` (within 40 mm along X and 30 mm
/// along Y), in print order, in hundredths of a mm. Where a loop starts follows the nozzle, so a loop is told by its
/// extent.
fn brim_extents(name: &str, center: [f64; 2]) -> Vec<[i64; 4]> {
    first_layer_paths(&slice(name))
        .into_iter()
        .filter(|(f, _)| f.eq_ignore_ascii_case("brim"))
        .filter_map(|(_, pts)| {
            let b = pts.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
            });
            let mid = [f64::midpoint(b[0], b[2]), f64::midpoint(b[1], b[3])];
            ((mid[0] - center[0]).abs() < 40.0 && (mid[1] - center[1]).abs() < 30.0)
                .then(|| b.map(|v| (v * 100.0).round() as i64))
        })
        .collect()
}

/// The two feet of one object are not cut by each other: its brim prints in the same order whether or not another
/// object stands on the plate.
#[test]
fn an_objects_own_feet_do_not_cut_its_brim() {
    let alone = brim_extents("a1--feet2", [100.0, 90.0]);
    let with_far = brim_extents("a1--feet2-far", [100.0, 90.0]);
    assert!(alone.len() > 6, "a1--feet2: brim runs {alone:?}");
    assert_eq!(
        with_far, alone,
        "a1--feet2-far: the far object changed the two feet's brim"
    );
}
