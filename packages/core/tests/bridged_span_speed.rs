// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Bridged wall pieces on Bambu Lab printers. A fully clear wall piece (an overhang wall) that is one straight line,
//! with supported wall at both ends, spans a gap like a bridge and prints at `bridge_speed`. Every other fully clear
//! piece keeps the clear speed (`overhang_totally_speed`), whatever the turn of the part. Nothing else about the
//! piece changes. Other printers keep the clear speed on every piece.
//!
//! The parts are our own procedural shapes: a slab 1 mm thick at z 2 to 3 laid on posts 2.1 mm tall, measured on the
//! first layer over air (z 2.2), on a stock printer as the app sets it up with classic walls and the clear speed
//! a project from the maker's app writes (10 mm/s).

#![allow(clippy::disallowed_methods, clippy::many_single_char_names)]

use serde_json::{Map, Value, json};
use std::sync::Arc;
use sx_core::api::{self, Mesh, SliceRequest};

fn root() -> String {
    format!("{}/../..", env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/{path}", root())).unwrap()).unwrap()
}

/// A shipped printer of `vendor` as the app sets it up, with uniform layers, classic walls, the clear speed at
/// 10 mm/s, no cooling slowdown (the parts are small), then `edits`.
fn printer(vendor: &str, model: &str, edits: &[(&str, &str)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in read("packages/settings/defaults.json").as_object().unwrap() {
        out.insert(k.clone(), v[1].clone());
    }
    let m = read(&format!("packages/profiles/resolved/{vendor}.json"))["models"][model].clone();
    let base = m["base"].as_str().unwrap().to_owned();
    for part in [&m["process"][&base], &m["filament"], &m["machine"]] {
        for (k, v) in part.as_object().unwrap() {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("smart_layer".into(), json!("off"));
    let stock = [
        ("wall_generator", "classic"),
        ("overhang_totally_speed", "10"),
        ("slow_down_for_layer_cooling", "0"),
    ];
    for (k, v) in stock.iter().chain(edits) {
        set(&mut out, k, v);
    }
    out
}

fn a1(edits: &[(&str, &str)]) -> Map<String, Value> {
    printer("bambu-lab", "bambu-a1", edits)
}

/// Sets `key` to `value`, as a list of one when the settings keep that key as a list.
fn set(cfg: &mut Map<String, Value>, key: &str, value: &str) {
    let v = if cfg.get(key).is_some_and(Value::is_array) {
        json!([value])
    } else {
        json!(value)
    };
    cfg.insert(key.to_owned(), v);
}

type P2 = (f64, f64);

fn cross(o: P2, a: P2, b: P2) -> f64 {
    (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
}

/// Ear clipping of a simple polygon given counterclockwise: triangles as index triples, counterclockwise.
fn ears(poly: &[P2]) -> Vec<[usize; 3]> {
    let mut idx: Vec<usize> = (0..poly.len()).collect();
    let mut out = Vec::new();
    while idx.len() > 3 {
        let n = idx.len();
        let ear = (0..n).find(|&k| {
            let (a, b, c) = (idx[(k + n - 1) % n], idx[k], idx[(k + 1) % n]);
            cross(poly[a], poly[b], poly[c]) > 1e-12
                && idx.iter().filter(|&&p| p != a && p != b && p != c).all(|&p| {
                    cross(poly[a], poly[b], poly[p]) < -1e-12
                        || cross(poly[b], poly[c], poly[p]) < -1e-12
                        || cross(poly[c], poly[a], poly[p]) < -1e-12
                })
        });
        let k = ear.expect("polygon has an ear");
        out.push([idx[(k + n - 1) % n], idx[k], idx[(k + 1) % n]]);
        idx.remove(k);
    }
    out.push([idx[0], idx[1], idx[2]]);
    out
}

fn ccw(poly: &[P2]) -> Vec<P2> {
    let area: f64 = (0..poly.len())
        .map(|i| cross((0.0, 0.0), poly[i], poly[(i + 1) % poly.len()]))
        .sum();
    if area > 0.0 {
        poly.to_vec()
    } else {
        poly.iter().rev().copied().collect()
    }
}

type Tri = [[f64; 3]; 3];

/// A solid between a bottom and a top polygon (the same polygon, counterclockwise once ordered) at z0 and z1.
fn prism(poly: &[P2], z0: f64, z1: f64) -> Vec<Tri> {
    let p = ccw(poly);
    let at = |i: usize, z: f64| [p[i].0, p[i].1, z];
    let mut tris = Vec::new();
    for [a, b, c] in ears(&p) {
        tris.push([at(a, z0), at(c, z0), at(b, z0)]);
        tris.push([at(a, z1), at(b, z1), at(c, z1)]);
    }
    for i in 0..p.len() {
        let j = (i + 1) % p.len();
        tris.push([at(i, z0), at(j, z0), at(j, z1)]);
        tris.push([at(i, z0), at(j, z1), at(i, z1)]);
    }
    tris
}

/// A solid lofted from polygon `lo` at z0 to polygon `hi` at z1 (same vertex count, counterclockwise, convex).
fn loft(lo: &[P2], z0: f64, hi: &[P2], z1: f64) -> Vec<Tri> {
    let n = lo.len();
    let mut tris = Vec::new();
    for i in 1..n - 1 {
        tris.push([
            [lo[0].0, lo[0].1, z0],
            [lo[i + 1].0, lo[i + 1].1, z0],
            [lo[i].0, lo[i].1, z0],
        ]);
        tris.push([
            [hi[0].0, hi[0].1, z1],
            [hi[i].0, hi[i].1, z1],
            [hi[i + 1].0, hi[i + 1].1, z1],
        ]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tris.push([
            [lo[i].0, lo[i].1, z0],
            [lo[j].0, lo[j].1, z0],
            [hi[j].0, hi[j].1, z1],
        ]);
        tris.push([
            [lo[i].0, lo[i].1, z0],
            [hi[j].0, hi[j].1, z1],
            [hi[i].0, hi[i].1, z1],
        ]);
    }
    tris
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<P2> {
    vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
}

fn circle(r: f64) -> Vec<P2> {
    (0..48)
        .map(|i| {
            let a = std::f64::consts::TAU * f64::from(i) / 48.0;
            (r * a.cos(), r * a.sin())
        })
        .collect()
}

/// Post height and slab top.
const POST: f64 = 2.1;
const SLAB: (f64, f64) = (2.0, 3.0);

/// Posts under a slab: each post a prism to [`POST`], the slab from z 2 to 3.
fn on_posts(posts: &[Vec<P2>], slab: &[P2]) -> Vec<Tri> {
    let mut t: Vec<Tri> = posts.iter().flat_map(|p| prism(p, 0.0, POST)).collect();
    t.extend(prism(slab, SLAB.0, SLAB.1));
    t
}

/// Two posts 6 x 10 with a gap between them, a slab across both.
fn gap(g: f64) -> Vec<Tri> {
    on_posts(
        &[rect(0.0, 0.0, 6.0, 10.0), rect(6.0 + g, 0.0, 12.0 + g, 10.0)],
        &rect(0.0, 0.0, 12.0 + g, 10.0),
    )
}

/// A 10 x 10 post with a 6 x 6 notch (a C open in +Y), a 10 x 10 slab on it: the slab spans the C's mouth.
fn c_post() -> Vec<Tri> {
    let c = [
        (0.0, 0.0),
        (10.0, 0.0),
        (10.0, 10.0),
        (8.0, 10.0),
        (8.0, 4.0),
        (2.0, 4.0),
        (2.0, 10.0),
        (0.0, 10.0),
    ];
    on_posts(&[c.to_vec()], &rect(0.0, 0.0, 10.0, 10.0))
}

/// The gap 15 posts with the slab's -Y side bent `dep` mm into the gap: one V point, or a half sine arc.
fn bent(dep: f64, arc: bool) -> Vec<Tri> {
    let mut slab = vec![(0.0, 0.0), (6.0, 0.0)];
    if arc {
        slab.extend((1..16).map(|i| {
            let t = f64::from(i) / 16.0;
            (6.0 + 15.0 * t, -dep * (std::f64::consts::PI * t).sin())
        }));
    } else {
        slab.push((13.5, -dep));
    }
    slab.extend([(21.0, 0.0), (27.0, 0.0), (27.0, 10.0), (0.0, 10.0)]);
    on_posts(&[rect(0.0, 0.0, 6.0, 10.0), rect(21.0, 0.0, 27.0, 10.0)], &slab)
}

/// A 10 x 10 pillar with a slab on it that sticks out 12 mm in +X.
fn t_slab() -> Vec<Tri> {
    on_posts(&[rect(0.0, 0.0, 10.0, 10.0)], &rect(0.0, 0.0, 22.0, 10.0))
}

/// A slab 12 mm long ending in a half circle of radius 5, on a 10 x 10 pillar.
fn round_end() -> Vec<Tri> {
    let mut slab = vec![(0.0, 0.0), (12.0, 0.0)];
    slab.extend((1..24).map(|i| {
        let a = std::f64::consts::PI * f64::from(i) / 24.0;
        (12.0 + 5.0 * a.sin(), 5.0 - 5.0 * a.cos())
    }));
    slab.extend([(12.0, 10.0), (0.0, 10.0)]);
    on_posts(&[rect(0.0, 0.0, 10.0, 10.0)], &slab)
}

/// An L-shaped slab on a 10 x 10 pillar.
fn l_slab() -> Vec<Tri> {
    let slab = [
        (0.0, 0.0),
        (22.0, 0.0),
        (22.0, 22.0),
        (12.0, 22.0),
        (12.0, 10.0),
        (0.0, 10.0),
    ];
    on_posts(&[rect(0.0, 0.0, 10.0, 10.0)], &slab)
}

/// A disk of diameter 20 on a post of diameter 6.
fn disk() -> Vec<Tri> {
    on_posts(&[circle(3.0)], &circle(10.0))
}

/// A 10 x 10 block, vertical to z 1, then all four sides leaning out `lean` degrees to z 4.
fn flare(lean: f64) -> Vec<Tri> {
    let t = 3.0 * lean.to_radians().tan();
    let lo = rect(0.0, 0.0, 10.0, 10.0);
    let mut tris = loft(&lo, 0.0, &lo, 1.0);
    tris.extend(loft(&lo, 1.0, &rect(-t, -t, 10.0 + t, 10.0 + t), 4.0));
    tris
}

/// Turned by `deg` degrees about the origin, then centered on the origin.
fn turned(tris: Vec<Tri>, deg: f64) -> Vec<Tri> {
    let (s, c) = deg.to_radians().sin_cos();
    let mut t: Vec<Tri> = tris
        .into_iter()
        .map(|tri| tri.map(|[x, y, z]| [x * c - y * s, x * s + y * c, z]))
        .collect();
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for v in t.iter().flatten() {
        (x0, y0, x1, y1) = (x0.min(v[0]), y0.min(v[1]), x1.max(v[0]), y1.max(v[1]));
    }
    let (cx, cy) = (x0.midpoint(x1), y0.midpoint(y1));
    for v in t.iter_mut().flatten() {
        v[0] -= cx;
        v[1] -= cy;
    }
    t
}

#[allow(clippy::cast_possible_truncation, reason = "coordinates of a few mm")]
fn stl(tris: &[Tri]) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        b.extend_from_slice(&[0u8; 12]);
        for v in t {
            for c in v {
                b.extend_from_slice(&(*c as f32).to_le_bytes());
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

/// Where part `i` sits: four columns 55 mm apart, rows 50 mm apart.
fn spot(i: usize) -> P2 {
    let (col, row) = (u32::try_from(i % 4).unwrap(), u32::try_from(i / 4).unwrap());
    (45.0 + 55.0 * f64::from(col), 40.0 + 50.0 * f64::from(row))
}

/// G-code of the parts, each centered on its [`spot`].
fn slice(parts: &[Vec<Tri>], config: &Map<String, Value>) -> String {
    let meshes: Vec<Arc<Mesh>> = parts
        .iter()
        .map(|p| Arc::new(Mesh::load(&stl(p), "m.stl").unwrap()))
        .collect();
    let objects: Vec<Value> = (0..parts.len())
        .map(|i| {
            let (x, y) = spot(i);
            json!({"id": format!("o{i}"), "name": format!("part{i}"), "mesh": i.to_string(),
                   "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"objects": objects},
        "config": Value::Object(config.clone()),
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let r = api::run_request(&req, &move |id: &str| {
        Ok(meshes[id.parse::<usize>().unwrap()].clone())
    })
    .unwrap();
    String::from_utf8(r.gcode).unwrap()
}

fn word(code: &str, k: char) -> Option<f64> {
    code.split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(k))
        .and_then(|v| v.parse().ok())
}

/// A run of overhang wall moves at one speed: its length (mm), speed (mm/s), and the Y of its middle.
#[derive(Debug, Clone, Copy)]
struct Run {
    len: f64,
    speed: f64,
    y: f64,
}

/// Per part: the overhang wall runs of the first layer over air (z 2.2), split where the speed changes or the
/// nozzle travels.
fn runs(gcode: &str, parts: usize) -> Vec<Vec<Run>> {
    let mut out: Vec<Vec<Run>> = vec![Vec::new(); parts];
    let (mut z, mut feature, mut f) = (0.0f64, String::new(), 0.0f64);
    let (mut x, mut y) = (0.0f64, 0.0f64);
    // The open run: its part, start, end, length and speed.
    let mut open: Option<(usize, P2, P2, f64, f64)> = None;
    let mut close = |open: &mut Option<(usize, P2, P2, f64, f64)>| {
        if let Some((i, a, b, len, speed)) = open.take() {
            out[i].push(Run {
                len,
                speed,
                y: a.1.midpoint(b.1),
            });
        }
    };
    for line in gcode.lines() {
        let code = line.split(';').next().unwrap_or("").trim();
        if let Some(v) = line
            .strip_prefix("; Z_HEIGHT: ")
            .or_else(|| line.strip_prefix(";Z:"))
        {
            z = v.trim().parse().unwrap();
        } else if let Some(name) = line
            .strip_prefix("; FEATURE: ")
            .or_else(|| line.strip_prefix(";TYPE:"))
        {
            name.trim().clone_into(&mut feature);
        } else if ["G0", "G1", "G2", "G3"].iter().any(|g| code.starts_with(g)) {
            if let Some(v) = word(code, 'F') {
                f = v;
            }
            let (nx, ny) = (word(code, 'X').unwrap_or(x), word(code, 'Y').unwrap_or(y));
            let moves = (nx, ny) != (x, y);
            // Arcs count by their chord, which is enough to tell the pieces apart.
            let wall = !code.starts_with("G0")
                && feature == "Overhang wall"
                && word(code, 'E').is_some_and(|e| e > 0.0)
                && (z - 2.2).abs() < 0.01;
            if moves {
                let speed = f / 60.0;
                let joins =
                    open.is_some_and(|(_, _, b, _, s)| wall && b == (x, y) && (s - speed).abs() < 1e-6);
                if joins {
                    if let Some(o) = open.as_mut() {
                        o.2 = (nx, ny);
                        o.3 += (nx - x).hypot(ny - y);
                    }
                } else {
                    close(&mut open);
                    if wall {
                        let mid = (x.midpoint(nx), y.midpoint(ny));
                        let i = (0..parts)
                            .min_by(|&a, &b| {
                                let d = |k: usize| (spot(k).0 - mid.0).hypot(spot(k).1 - mid.1);
                                d(a).total_cmp(&d(b))
                            })
                            .unwrap();
                        open = Some((i, (x, y), (nx, ny), (nx - x).hypot(ny - y), speed));
                    }
                }
            }
            (x, y) = (nx, ny);
        }
    }
    close(&mut open);
    out
}

/// Overhang wall runs of each part, whole loop pieces only (runs of 0.5 mm or more), as (length, speed).
fn summary(r: &[Run]) -> Vec<(f64, f64)> {
    r.iter()
        .filter(|r| r.len >= 0.5)
        .map(|r| ((r.len * 100.0).round() / 100.0, r.speed))
        .collect()
}

/// Asserts each part has `count` overhang wall pieces of length `len`, all at `speed`, and nothing else.
fn check_spans(what: &str, all: &[Vec<Run>], len: f64, count: usize, speed: f64) {
    for (i, r) in all.iter().enumerate() {
        let s = summary(r);
        assert!(
            s.len() == count
                && s.iter()
                    .all(|(l, v)| (l - len).abs() < 0.03 && (v - speed).abs() < 0.01),
            "{what}, part {i}: pieces {s:?}, want {count} x {len} mm at {speed} mm/s"
        );
    }
}

/// Asserts every overhang wall piece of every part prints at `speed`, and that each part has one.
fn check_all_at(what: &str, all: &[Vec<Run>], speed: f64) {
    for (i, r) in all.iter().enumerate() {
        let s = summary(r);
        assert!(
            !s.is_empty() && s.iter().all(|(_, v)| (v - speed).abs() < 0.01),
            "{what}, part {i}: pieces {s:?}, want all at {speed} mm/s"
        );
    }
}

/// Test 1: two posts with a 15 mm gap: the 14.60 mm piece on each side, outer and inner loop, prints at the bridge
/// speed (50), at turns 0, 30 and 90, on the A1 and the P1S, with classic and arachne walls.
#[test]
fn a_straight_piece_across_a_gap_prints_at_the_bridge_speed() {
    let parts: Vec<Vec<Tri>> = [0.0, 30.0, 90.0].iter().map(|&t| turned(gap(15.0), t)).collect();
    check_spans("a1", &runs(&slice(&parts, &a1(&[])), 3), 14.6, 4, 50.0);
    let p1s = printer("bambu-lab", "bambu-p1s", &[]);
    check_spans("p1s", &runs(&slice(&parts, &p1s), 3), 14.6, 4, 50.0);
    let arachne = a1(&[("wall_generator", "arachne")]);
    check_spans("arachne", &runs(&slice(&parts, &arachne), 3), 14.6, 4, 50.0);
}

/// Test 2: gaps of 3 and 30 mm: the 2.60 and 29.60 mm pieces print at the bridge speed.
#[test]
fn short_and_long_gaps_print_at_the_bridge_speed() {
    let all = runs(&slice(&[gap(3.0), gap(30.0)], &a1(&[])), 2);
    check_spans("gap 3", &all[..1], 2.6, 4, 50.0);
    check_spans("gap 30", &all[1..], 29.6, 4, 50.0);
}

/// Test 3: a slab across the 6 mm mouth of a C-shaped post: the 5.60 mm mouth piece prints at the bridge speed at
/// turns 0 and 180.
#[test]
fn the_mouth_of_a_c_post_prints_at_the_bridge_speed() {
    let parts = [turned(c_post(), 0.0), turned(c_post(), 180.0)];
    check_spans("c post", &runs(&slice(&parts, &a1(&[])), 2), 5.6, 2, 50.0);
}

/// Test 4: the speed is the bridge speed itself, not a limit on the clear speed: bridge speed 30 with a clear speed
/// of 60 gives 30.
#[test]
fn a_bridged_piece_takes_the_bridge_speed_even_below_the_clear_speed() {
    let cfg = a1(&[("bridge_speed", "30"), ("overhang_totally_speed", "60")]);
    check_spans("30 / 60", &runs(&slice(&[gap(15.0)], &cfg), 1), 14.6, 4, 30.0);
}

/// Test 5: a 1 mm V bend or a 1 mm arc on the -Y side of the gap: the bent side keeps the clear speed (10) and the
/// straight +Y side prints at the bridge speed (50).
#[test]
fn a_bent_piece_keeps_the_clear_speed() {
    let all = runs(&slice(&[bent(1.0, false), bent(1.0, true)], &a1(&[])), 2);
    for (what, r) in ["v bend", "arc"].iter().zip(&all) {
        let s: Vec<&Run> = r.iter().filter(|r| r.len >= 0.5).collect();
        #[allow(clippy::cast_precision_loss, reason = "a few runs")]
        let middle = s.iter().map(|r| r.y).sum::<f64>() / s.len().max(1) as f64;
        let straight: Vec<f64> = s.iter().filter(|r| r.y > middle).map(|r| r.speed).collect();
        let bend: Vec<f64> = s.iter().filter(|r| r.y < middle).map(|r| r.speed).collect();
        assert!(
            straight.len() == 2 && straight.iter().all(|v| (v - 50.0).abs() < 0.01),
            "{what}: straight side {s:?}"
        );
        assert!(
            bend.len() >= 2 && bend.iter().all(|v| (v - 10.0).abs() < 0.01),
            "{what}: bent side {s:?}"
        );
    }
}

/// Test 6: fully clear pieces that are not one straight line between supports keep the clear speed: a slab sticking
/// out 12 mm at turns 0 and 180, a round end, an L slab, a disk on a post, and blocks flaring out at 70 degrees.
/// (A flare at 50 degrees has no fully clear piece; its walls keep their degree speeds.)
#[test]
fn other_clear_pieces_keep_the_clear_speed() {
    let parts = [
        turned(t_slab(), 0.0),
        turned(t_slab(), 180.0),
        turned(round_end(), 0.0),
        turned(l_slab(), 0.0),
        turned(disk(), 0.0),
    ];
    check_all_at("slabs", &runs(&slice(&parts, &a1(&[])), parts.len()), 10.0);
    let flares = [turned(flare(50.0), 0.0), turned(flare(70.0), 0.0)];
    let g = slice(&flares, &a1(&[]));
    let all = runs(&g, 2);
    assert!(
        summary(&all[0]).iter().all(|(_, v)| (v - 10.0).abs() < 0.01),
        "flare 50: {:?}",
        summary(&all[0])
    );
    check_all_at("flare 70", &all[1..], 10.0);
}

/// Test 8: printers other than Bambu Lab keep the clear speed on a straight piece across a gap: it prints at the
/// speed of the clear pieces of a slab sticking out. With the overhang speeds off, every clear piece on the A1 is at
/// the bridge speed, as before.
#[test]
fn other_printers_and_overhang_speeds_off_are_unchanged() {
    let parts = [gap(15.0), t_slab()];
    for (vendor, model) in [("prusa", "prusa-mk4"), ("creality", "creality-ender-3-v3-ke")] {
        let all = runs(&slice(&parts, &printer(vendor, model, &[])), 2);
        let slab = summary(&all[1]);
        let clear = slab.first().map(|p| p.1).unwrap();
        assert!(
            slab.iter().all(|p| (p.1 - clear).abs() < 0.01),
            "{model} slab: {slab:?}"
        );
        // Each wall loop has its piece on both sides of the gap (three loops on some printers).
        let n = summary(&all[0]).len();
        assert!(n >= 4, "{model}: {:?}", summary(&all[0]));
        check_spans(model, &all[..1], 14.6, n, clear);
    }
    let off = a1(&[("enable_overhang_speed", "0"), ("bridge_speed", "40")]);
    let all = runs(&slice(&parts, &off), 2);
    check_all_at("overhang speeds off", &all, 40.0);
}
