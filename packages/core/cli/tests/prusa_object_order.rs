// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The order a Prusa project prints its objects' brims and the objects in on the first layer (`objorder.rs`,
//! `object_order_rule` `chain`, set by the project read). Each object stands at the lowest vertex of its first layer
//! outline (the rightmost of equally low ones). The objects are put on a chain of the shortest links between those
//! points, at most two links an object and no loop, and printed from the end whose last record of its nearest
//! object is shorter: every brim first, each object's loops together, then the objects in the same order. Two
//! objects have rules of their own: their brims print the larger y first, then the larger x; the objects print
//! object 1 first when their y differs, and the larger x first when it is equal.
//!
//! The projects in tests/fixtures/brim-order are Prusa MK4S projects of 10 mm cubes with a 3 mm outer brim and one
//! skirt loop (`mk4p--scatter5-sk0` has none), except `mk4p--shapes3`, two right triangles and a cube turned 45
//! degrees (`mk4p--shapes3-own` is the same plate with a wall count of object 1's own); each test gives the
//! objects' first layer box centers, which the reader names the paths by.

#![allow(
    clippy::disallowed_methods,
    clippy::float_cmp,
    clippy::many_single_char_names,
    reason = "a G-code reader for the test: plate coordinates in mm"
)]

use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/brim-order/{name}.3mf"))
}

/// A temp dir that is removed when it drops, so a failed assert does not leave it behind.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The G-code of a project sliced with its own settings.
fn slice(name: &str) -> String {
    // Tests run side by side and may slice the same project, so each slice gets a folder of its own.
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = TempDir(
        std::env::temp_dir().join(format!("sx-prusa-object-order-{name}-{}-{n}", std::process::id())),
    );
    std::fs::create_dir_all(&tmp.0).unwrap();
    let out = tmp.0.join("out.gcode");
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

/// One path of the first layer: a run of extruding moves of one feature with no travel between them, and its box
/// `[x0, y0, x1, y1]`, mm.
#[derive(Debug)]
struct Path1 {
    feature: String,
    b: [f64; 4],
}

/// The extruding paths of the first layer, in print order. Arcs (G2, G3) count by their end points, which is enough
/// for these cubes.
fn first_layer_paths(gcode: &str) -> Vec<Path1> {
    let (mut x, mut y, mut z) = (0.0_f64, 0.0_f64, 0.0_f64);
    let mut relative_e = false;
    let mut e = 0.0_f64;
    let mut feature = String::new();
    let mut first_z: Option<f64> = None;
    let mut paths: Vec<Path1> = Vec::new();
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
                if nz != z {
                    z = nz;
                    open = false;
                }
                let moves = nx != x || ny != y;
                // The start G-code's purge line is not part of the plate.
                let plate = !feature.is_empty() && feature != "Custom";
                if de > 0.0 && moves && plate {
                    let fz = *first_z.get_or_insert(z);
                    if z > fz + 1e-3 {
                        break;
                    }
                    if !open {
                        paths.push(Path1 {
                            feature: feature.clone(),
                            b: [x, y, x, y],
                        });
                        open = true;
                    }
                    let p = paths.last_mut().unwrap();
                    p.b = [p.b[0].min(nx), p.b[1].min(ny), p.b[2].max(nx), p.b[3].max(ny)];
                } else if moves {
                    open = false;
                }
                (x, y) = (nx, ny);
            }
            _ => {}
        }
    }
    paths
}

/// What the first layer prints, in order: `S` for the skirt, `B<k>` for brim loops round object `k` (numbered from 1
/// in plate order, standing at `centers`), `B*` for loops round several objects, `W<k>` for object `k`'s own paths;
/// repeats of one in a row are one. Brim pieces round no object's center (slivers between brims that meet) are left
/// out.
fn order(paths: &[Path1], centers: &[[f64; 2]]) -> String {
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        let mid = [f64::midpoint(p.b[0], p.b[2]), f64::midpoint(p.b[1], p.b[3])];
        let t = match p.feature.as_str() {
            "Skirt" => "S".to_owned(),
            "Brim" => {
                let round: Vec<usize> = (0..centers.len())
                    .filter(|&k| {
                        let c = centers[k];
                        p.b[0] < c[0] && c[0] < p.b[2] && p.b[1] < c[1] && c[1] < p.b[3]
                    })
                    .collect();
                match round.as_slice() {
                    [] => continue,
                    [k] => format!("B{}", k + 1),
                    _ => "B*".to_owned(),
                }
            }
            _ => {
                let d = |k: usize| (centers[k][0] - mid[0]).hypot(centers[k][1] - mid[1]);
                let near = (0..centers.len()).min_by(|&a, &b| d(a).total_cmp(&d(b))).unwrap();
                format!("W{}", near + 1)
            }
        };
        if out.last() != Some(&t) {
            out.push(t);
        }
    }
    out.join(" ")
}

/// The first layer order of project `name`, whose objects stand at `centers` in plate order.
fn first_layer(name: &str, centers: &[[f64; 2]]) -> String {
    order(&first_layer_paths(&slice(name)), centers)
}

#[test]
fn objects_and_brims_print_along_the_chain_of_the_nearest_objects() {
    // Five scattered objects: 3-1 is the shortest link, and the last link (5-2) has the single object 5 on one side.
    let five = [
        [60.0, 160.0],
        [200.0, 40.0],
        [130.0, 110.0],
        [30.0, 50.0],
        [220.0, 170.0],
    ];
    assert_eq!(
        first_layer("mk4p--scatter5", &five),
        "S B5 B2 B3 B1 B4 W5 W2 W3 W1 W4"
    );
    // The same plate without a skirt.
    assert_eq!(
        first_layer("mk4p--scatter5-sk0", &five),
        "B5 B2 B3 B1 B4 W5 W2 W3 W1 W4"
    );
    // An L: 1-2 then 1-3, the last link, which starts at object 3.
    let ell = [[40.0, 40.0], [40.0, 170.0], [210.0, 40.0]];
    assert_eq!(first_layer("mk4p--ell3", &ell), "S B3 B1 B2 W3 W1 W2");
}

#[test]
fn the_end_whose_last_nearest_record_is_shorter_starts() {
    // Two pairs, 18 mm (1-2) and 21 mm (3-4) apart, joined by 2-3. Object 1 last records object 3, object 4 last
    // records object 2, which is farther: the chain starts at object 1, though its end link is the shorter one.
    let pairs = [[72.0, 100.0], [90.0, 100.0], [122.92, 102.302], [143.92, 102.302]];
    assert_eq!(
        first_layer("mk4p--pairs-joined", &pairs),
        "S B1 B2 B3 B4 W1 W2 W3 W4"
    );
}

#[test]
fn each_object_stands_at_the_lowest_vertex_of_its_first_layer() {
    // From the box centers the links would be 2-3 (49 mm) then 1-2 (107 mm), the chain 1 2 3. From the lowest
    // vertices, (73.2, 65.8), (166.9, 103.5) and (155.6, 46.5), they are 2-3 (58 mm) then 1-3 (85 mm).
    let shapes = [[62.617, 86.98], [166.89, 110.61], [170.6, 61.47]];
    assert_eq!(first_layer("mk4p--shapes3", &shapes), "S B1 B3 B2 W1 W3 W2");
}

#[test]
fn a_gap_0_03_mm_longer_decides_the_start() {
    let first = [[39.97, 105.0], [85.0, 105.0], [130.0, 105.0]];
    assert_eq!(first_layer("mk4p--row3-firstlong", &first), "S B1 B2 B3 W1 W2 W3");
    let last = [[40.0, 105.0], [85.0, 105.0], [130.03, 105.0]];
    assert_eq!(first_layer("mk4p--row3-lastlong", &last), "S B3 B2 B1 W3 W2 W1");
}

#[test]
fn two_objects_print_brims_by_y_then_x_and_objects_by_number_unless_y_is_equal() {
    // y differs: the brim of the object with the larger y first, object 1 first.
    assert_eq!(
        first_layer("mk4p--pair", &[[88.0, 144.0], [144.0, 124.0]]),
        "S B1 B2 W1 W2"
    );
    assert_eq!(
        first_layer("mk4p--pair-swap", &[[144.0, 124.0], [88.0, 144.0]]),
        "S B2 B1 W1 W2"
    );
    // x equal: the same.
    assert_eq!(
        first_layer("mk4p--col2", &[[125.0, 40.0], [125.0, 170.0]]),
        "S B2 B1 W1 W2"
    );
    // y equal: the larger x first, for the brims and the objects.
    assert_eq!(
        first_layer("mk4p--o2", &[[40.0, 105.0], [125.0, 105.0]]),
        "S B2 B1 W2 W1"
    );
    // Brims that meet: their shared loops first, then each object's own loops, the larger x first.
    assert_eq!(
        first_layer("mk4p--touch2", &[[100.0, 105.0], [114.0, 105.0]]),
        "S B* B2 B1 W2 W1"
    );
}

#[test]
fn lines_of_equal_gaps_take_equal_records_in_the_order_they_are_made() {
    // Lines of three at equal gaps, numbered from the low end: both start at object 3.
    let column = [[125.0, 30.0], [125.0, 75.0], [125.0, 120.0]];
    assert!(first_layer("mk4p--col3-eq", &column).starts_with("S B3 B2 B1 "));
    let row = [[40.0, 105.0], [125.0, 105.0], [210.0, 105.0]];
    assert!(first_layer("mk4p--o3", &row).starts_with("S B3 B2 B1 "));
}

/// The objects' own paths of a first layer order (`order`), without the skirt and brims.
fn objects_only(order: &str) -> String {
    order
        .split(' ')
        .filter(|t| t.starts_with('W'))
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn objects_with_settings_of_their_own_stand_at_the_same_points() {
    // The plate of two triangles and a turned cube again, once as it is and once with a wall count of object 1's
    // own, so each object slices as a session of its own. Both print the objects in the order the lowest vertices
    // give, 1 3 2; the box centers would give 1 2 3.
    let shapes = [[62.617, 86.98], [166.89, 110.61], [170.6, 61.47]];
    assert_eq!(objects_only(&first_layer("mk4p--shapes3", &shapes)), "W1 W3 W2");
    assert_eq!(
        objects_only(&first_layer("mk4p--shapes3-own", &shapes)),
        "W1 W3 W2"
    );
}
