// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Arrange's footprint and heimdall's layer check agree: a plate laid out the way Arrange lays it out (each object's
//! outline seen from above, nested with the brim, gap, excluded area and prime tower room the app gives it) slices
//! with no two objects' paths crossing, the prime tower's included. A figure kit of curved parts (standing crescents
//! and slivers, hooked arms, curved wings, two spheres) and a box, in two filaments with the prime tower on, on a
//! printer with an excluded corner; and seeded random plates of curved parts.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_lossless,
    clippy::many_single_char_names,
    clippy::type_complexity,
    clippy::too_many_lines,
    reason = "procedural test meshes: small counts, vector math on corners"
)]
#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]

use serde_json::{Value, json};
use std::f64::consts::PI;
use std::sync::Arc;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest};
use sx_core::collide::Kind;
use sx_geom::mesh::TriMesh;
use sx_geom::nest::{self, NestBed, NestItem, NestOptions, NestProblem, NestZone, SilhouetteOptions};
use sx_geom::poly2d::Polygon;

type P3 = [f64; 3];

/// A closed solid from a cap outline (a strip between `a` and `b`, point for point) swept along `dir` by `depth`,
/// placed by `map` from strip coordinates (u, v, w) to the mesh's own.
fn strip_solid(
    a: &[[f64; 2]],
    b: &[[f64; 2]],
    depth: f64,
    map: &dyn Fn([f64; 3]) -> P3,
) -> (Vec<P3>, Vec<[u32; 3]>) {
    let n = a.len();
    assert_eq!(n, b.len());
    // Ring order: a forward, then b backward.
    let ring: Vec<[f64; 2]> = a.iter().copied().chain(b.iter().rev().copied()).collect();
    let m = ring.len();
    let mut pos = Vec::new();
    for w in [0.0, depth] {
        for p in &ring {
            pos.push(map([p[0], p[1], w]));
        }
    }
    let idx_a = |i: usize| i as u32;
    let idx_b = |i: usize| (m - 1 - i) as u32;
    let mut tris = Vec::new();
    for i in 0..n - 1 {
        // bottom cap (w = 0) and top cap (w = depth)
        let q = [idx_a(i), idx_a(i + 1), idx_b(i + 1), idx_b(i)];
        tris.push([q[0], q[2], q[1]]);
        tris.push([q[0], q[3], q[2]]);
        let t = m as u32;
        tris.push([q[0] + t, q[1] + t, q[2] + t]);
        tris.push([q[0] + t, q[2] + t, q[3] + t]);
    }
    for i in 0..m {
        let j = (i + 1) % m;
        let (i0, j0, i1, j1) = (i as u32, j as u32, (i + m) as u32, (j + m) as u32);
        tris.push([i0, j0, j1]);
        tris.push([i0, j1, i1]);
    }
    orient(&pos, &mut tris);
    (pos, tris)
}

/// Turns every triangle round when the solid's signed volume is negative.
fn orient(pos: &[P3], tris: &mut [[u32; 3]]) {
    let vol: f64 = tris
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|i| pos[i as usize]);
            a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum();
    if vol < 0.0 {
        for t in tris.iter_mut() {
            t.swap(1, 2);
        }
    }
}

/// A solid of revolution about the z axis from a profile of (radius, z) that starts and ends on the axis.
fn lathe(profile: &[[f64; 2]], center: P3, sides: usize) -> (Vec<P3>, Vec<[u32; 3]>) {
    let mut pos = Vec::new();
    let mut tris = Vec::new();
    let rows = profile.len();
    for (r, z) in profile.iter().map(|p| (p[0], p[1])) {
        for k in 0..sides {
            let a = 2.0 * PI * k as f64 / sides as f64;
            pos.push([center[0] + r * a.cos(), center[1] + r * a.sin(), center[2] + z]);
        }
    }
    for i in 0..rows - 1 {
        for k in 0..sides {
            let kk = (k + 1) % sides;
            let (a, b, c, d) = (
                i * sides + k,
                i * sides + kk,
                (i + 1) * sides + kk,
                (i + 1) * sides + k,
            );
            tris.push([a as u32, b as u32, c as u32]);
            tris.push([a as u32, c as u32, d as u32]);
        }
    }
    // Degenerate triangles on the axis rows are dropped.
    tris.retain(|t| {
        let [a, b, c] = t.map(|i| pos[i as usize]);
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        n[0].hypot(n[1]).hypot(n[2]) > 1e-9
    });
    orient(&pos, &mut tris);
    (pos, tris)
}

/// A ball of radius `r` cut flat at the bottom so it stands on a disc `foot` across.
fn ball(r: f64, foot: f64, center_xy: [f64; 2], sides: usize) -> (Vec<P3>, Vec<[u32; 3]>) {
    let z0 = (r * r - (foot / 2.0) * (foot / 2.0)).sqrt();
    let t0 = (-z0 / r).acos();
    let mut prof = vec![[0.0, 0.0]];
    let steps = 24;
    for s in 0..=steps {
        let t = t0 - (t0 * s as f64 / steps as f64);
        prof.push([r * t.sin(), z0 + r * t.cos()]);
    }
    prof.push([0.0, z0 + r]);
    lathe(&prof, [center_xy[0], center_xy[1], 0.0], sides)
}

/// An arc of `n` points round (cx, cy), radius `r`, from angle `a0` to `a1` (radians).
fn arc(cx: f64, cy: f64, r: f64, a0: f64, a1: f64, n: usize) -> Vec<[f64; 2]> {
    (0..n)
        .map(|i| {
            let a = a0 + (a1 - a0) * i as f64 / (n - 1) as f64;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect()
}

fn merge(parts: &[(Vec<P3>, Vec<[u32; 3]>)]) -> (Vec<P3>, Vec<[u32; 3]>) {
    let mut pos = Vec::new();
    let mut tris = Vec::new();
    for (p, t) in parts {
        let base = pos.len() as u32;
        pos.extend_from_slice(p);
        tris.extend(t.iter().map(|x| x.map(|i| i + base)));
    }
    (pos, tris)
}

/// A crescent sliver standing on its edge: a crescent `len` tall in the xz plane, `thick` deep.
fn standing_crescent(len: f64, bow: f64, thick: f64) -> (Vec<P3>, Vec<[u32; 3]>) {
    let n = 40;
    // Outer and inner arcs through the tips at (0, 0) and (0, len), bulging to +u by `bow` and `bow` * 0.45.
    let arc_of = |bulge: f64| -> Vec<[f64; 2]> {
        let h = len / 2.0;
        let r = (h * h + bulge * bulge) / (2.0 * bulge);
        let cx = bulge - r;
        let a = (h / r).asin();
        arc(cx, h, r, -a, a, n)
    };
    let a = arc_of(bow);
    let b = arc_of(bow * 0.45);
    // Lean it so its lowest point is one tip: the sliver stands on a tip and its outer edge.
    strip_solid(&a, &b, thick, &|p| [p[0], p[2], p[1]])
}

/// A flat curved arm with a ball on its end, lying on the bed.
fn hooked_arm(len: f64, width: f64, height: f64) -> (Vec<P3>, Vec<[u32; 3]>) {
    let n = 30;
    let r = len;
    let a = arc(0.0, 0.0, r + width / 2.0, 0.0, 0.9, n);
    let b = arc(0.0, 0.0, r - width / 2.0, 0.0, 0.9, n);
    let band = strip_solid(&a, &b, height, &|p| [p[0], p[1], p[2]]);
    let end = [r * 0.9_f64.cos(), r * 0.9_f64.sin()];
    let knob = ball(width * 1.1, width * 0.8, end, 24);
    merge(&[band, knob])
}

/// A flat wing: a curved, tapering plate with a raised block at one end.
fn wing(len: f64) -> (Vec<P3>, Vec<[u32; 3]>) {
    let n = 36;
    let a: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let t = i as f64 / (n - 1) as f64;
            [len * t, 6.0 * (PI * t).sin() + 14.0 * (1.0 - t)]
        })
        .collect();
    let b: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let t = i as f64 / (n - 1) as f64;
            [len * t, 6.0 * (PI * t).sin() - 2.0 * (1.0 - t) - 0.5]
        })
        .collect();
    let plate = strip_solid(&a, &b, 4.0, &|p| [p[0], p[1], p[2]]);
    let block = strip_solid(
        &[[0.0, -2.5], [14.0, -2.5]],
        &[[0.0, 14.0], [14.0, 14.0]],
        22.0,
        &|p| [p[0], p[1], p[2]],
    );
    merge(&[plate, block])
}

fn cube(s: f64) -> (Vec<P3>, Vec<[u32; 3]>) {
    strip_solid(&[[0.0, 0.0], [s, 0.0]], &[[0.0, s], [s, s]], s, &|p| {
        [p[0], p[1], p[2]]
    })
}

/// The plate: name, mesh, filament slot.
fn kit() -> Vec<(String, (Vec<P3>, Vec<[u32; 3]>), u8)> {
    let mut v = Vec::new();
    v.push(("Body1".to_owned(), cube(42.0), 2));
    for k in 0..4 {
        v.push((
            format!("Crescent{k}"),
            standing_crescent(52.0 + 3.0 * f64::from(k), 9.0, 5.0),
            1 + (k % 2) as u8,
        ));
    }
    for k in 0..4 {
        v.push((format!("Arm{k}"), hooked_arm(34.0, 4.0, 5.0), 2 - (k % 2) as u8));
    }
    for k in 0..4 {
        v.push((
            format!("Wing{k}"),
            wing(66.0 + 2.0 * f64::from(k)),
            1 + (k % 2) as u8,
        ));
    }
    for k in 0..2 {
        v.push((format!("Sphere{k}"), ball(26.0, 30.0, [0.0, 0.0], 48), 1));
    }
    // Tall thin slivers standing on a narrow edge: the automatic brim makes them a wide one.
    for k in 0..2 {
        v.push((
            format!("Sliver{k}"),
            fin(44.0 + 6.0 * f64::from(k), 52.0, 2.2),
            2 - (k % 2) as u8,
        ));
    }
    v
}

/// The stock P1S request's configuration (bed, excluded corner, prime tower, auto brim), in two filaments.
fn p1s() -> Value {
    let path = format!(
        "{}/cli/tests/fixtures/xmark-p1s-request.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    req["config"].clone()
}

fn num(cfg: &Value, k: &str, d: f64) -> f64 {
    let v = &cfg[k];
    let v = v.as_array().and_then(|a| a.first()).unwrap_or(v);
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(d)
}

/// The app's brim estimate for a box as wide, deep and tall as the object (packages/settings/js/print-margins.ts).
fn app_auto_brim(cfg: &Value, w: f64, h: f64, height: f64) -> f64 {
    let diagonal = w.hypot(h);
    let ixx = w * h.powi(3) / 12.0;
    let iyy = h * w.powi(3) / 12.0;
    let speed = [
        "inner_wall_speed",
        "outer_wall_speed",
        "sparse_infill_speed",
        "internal_solid_infill_speed",
        "top_surface_speed",
        "support_speed",
    ]
    .iter()
    .map(|k| num(cfg, k, 0.0))
    .fold(0.0, f64::max);
    let hta = ((height / ixx) * h).max((height / iyy) * w) * height / 1920.0;
    let raw = 18.0_f64
        .min(1.5 * diagonal)
        .min((hta * speed).max(diagonal * 8.0 * height.min(30.0) / 200.0 / 30.0));
    if raw < 5.0 && raw < 1.5 * diagonal {
        return 0.0;
    }
    18.0_f64.min(raw.min(18.0) * 1.25)
}

type Shape = (Vec<P3>, Vec<[u32; 3]>);

/// A dome: half a ball of radius `r` on a flat foot, its top `r` high.
fn dome(r: f64) -> Shape {
    let mut prof = vec![[0.0, 0.0]];
    for s in 0..=20 {
        let t = std::f64::consts::FRAC_PI_2 * s as f64 / 20.0;
        prof.push([r * t.cos(), r * t.sin()]);
    }
    prof.push([0.0, r]);
    lathe(&prof, [0.0, 0.0, 0.0], 40)
}

/// A thin fin standing on its long edge: `len` long, `tall` high, `thick` thick.
fn fin(len: f64, tall: f64, thick: f64) -> Shape {
    strip_solid(
        &[[0.0, 0.0], [len, 0.0]],
        &[[0.0, tall], [len, tall]],
        thick,
        &|p| [p[0], p[2], p[1]],
    )
}

/// A C lying flat: an arc band of `sweep` radians, radius `r`, `w` wide, `h` tall.
fn c_shape(r: f64, w: f64, h: f64, sweep: f64) -> Shape {
    let a = arc(0.0, 0.0, r + w / 2.0, 0.0, sweep, 48);
    let b = arc(0.0, 0.0, r - w / 2.0, 0.0, sweep, 48);
    strip_solid(&a, &b, h, &|p| [p[0], p[1], p[2]])
}

/// An L bracket lying flat, legs `len` long and `w` wide, `h` tall.
fn ell(len: f64, w: f64, h: f64) -> Shape {
    strip_solid(
        &[[0.0, len], [0.0, 0.0], [len, 0.0]],
        &[[w, len], [w, w], [len, w]],
        h,
        &|p| [p[0], p[1], p[2]],
    )
}

fn rand01(s: &mut u64) -> f64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    (*s >> 11) as f64 / (1u64 << 53) as f64
}

/// A random plate of `n` curved, non-convex parts in two filaments.
fn random_plate(seed: u64, n: usize) -> Vec<(String, Shape, u8)> {
    let mut s = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
    let mut v = Vec::new();
    for k in 0..n {
        let r = |s: &mut u64, lo: f64, hi: f64| lo + (hi - lo) * rand01(s);
        let kind = (rand01(&mut s) * 8.0) as u32;
        let shape = match kind {
            0 => standing_crescent(r(&mut s, 30.0, 70.0), r(&mut s, 5.0, 12.0), r(&mut s, 3.0, 7.0)),
            1 => hooked_arm(r(&mut s, 20.0, 40.0), r(&mut s, 3.0, 6.0), r(&mut s, 3.0, 8.0)),
            2 => wing(r(&mut s, 40.0, 80.0)),
            3 => ball(r(&mut s, 10.0, 30.0), r(&mut s, 6.0, 20.0), [0.0, 0.0], 40),
            4 => dome(r(&mut s, 8.0, 25.0)),
            5 => fin(r(&mut s, 20.0, 60.0), r(&mut s, 20.0, 60.0), r(&mut s, 1.5, 4.0)),
            6 => c_shape(
                r(&mut s, 12.0, 35.0),
                r(&mut s, 3.0, 8.0),
                r(&mut s, 3.0, 20.0),
                r(&mut s, 3.0, 5.5),
            ),
            _ => {
                if rand01(&mut s) < 0.5 {
                    ell(r(&mut s, 20.0, 50.0), r(&mut s, 5.0, 12.0), r(&mut s, 3.0, 20.0))
                } else {
                    cube(r(&mut s, 10.0, 45.0))
                }
            }
        };
        let slot = if rand01(&mut s) < 0.5 { 1 } else { 2 };
        let names = ["Crescent", "Arm", "Wing", "Ball", "Dome", "Fin", "C", "Block"];
        v.push((format!("{}{k}", names[kind as usize]), shape, slot));
    }
    v
}

/// Lays out a plate the way the app's Arrange does (packages/app/src/plate/nest.ts and footprint.ts): each object's
/// outline seen from above, grown by its brim, nested with the 6 mm gap at any turn in 10 degree steps, clear of the
/// excluded corner and the room kept for the prime tower. Then slices it and lists every pair of objects (or object
/// and tower) whose paths cross, and anything printed in a keep-out zone.
fn arrange_and_slice(kit: &[(String, Shape, u8)], cfg: &Value, budget: f64) -> Vec<String> {
    let bed = 256.0;
    let mut items = Vec::new();
    for (k, (name, (pos, tris), _)) in kit.iter().enumerate() {
        let mesh = TriMesh::new(pos.clone(), tris.clone());
        let t = [
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            20.0 + 7.0 * k as f64,
            30.0,
            0.0,
            1.0,
        ];
        let s = nest::silhouette(&[mesh], Some(&t), &SilhouetteOptions::default());
        let polygons: Vec<Polygon> = s
            .outline
            .iter()
            .map(|r| Polygon {
                outer: r[0].clone(),
                holes: r[1..].to_vec(),
            })
            .collect();
        let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
        for p in pos {
            for a in 0..3 {
                lo[a] = lo[a].min(p[a]);
                hi[a] = hi[a].max(p[a]);
            }
        }
        let brim =
            app_auto_brim(cfg, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]).max(num(cfg, "brim_width", 0.0));
        let grow = brim + num(cfg, "brim_object_gap", 0.0);
        items.push((
            name.clone(),
            t,
            NestItem {
                id: name.clone(),
                polygons,
                grow,
                reach: grow,
                apart_extra: 0.0,
                copies: 1,
                hull: s.hull,
            },
        ));
    }
    let rect = |x: f64, y: f64, w: f64, h: f64| NestZone {
        polygons: vec![Polygon::simple(vec![
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
        ])],
    };
    let (tx, ty, side) = (
        num(cfg, "wipe_tower_x", 15.0),
        num(cfg, "wipe_tower_y", 220.0),
        num(cfg, "prime_tower_width", 35.0),
    );
    let pad = num(cfg, "prime_tower_brim_width", 3.0) + 1.0;
    let zones = vec![
        rect(0.0, 0.0, 18.0, 28.0),
        rect(tx - pad, ty - pad, side + 2.0 * pad, side + 2.0 * pad),
    ];
    let started = std::time::Instant::now();
    let out = nest::nest(NestProblem {
        bed: NestBed {
            width_mm: bed,
            depth_mm: bed,
            round: false,
        },
        items: items.iter().map(|i| i.2.clone()).collect(),
        fixed: vec![],
        zones,
        options: NestOptions {
            gap_mm: 6.0,
            safety_mm: 1.0,
            rotate: true,
            rotation_step_deg: 10.0,
            center: true,
            budget,
            ..NestOptions::default()
        },
    })
    .unwrap();
    eprintln!(
        "nest {} ms, placed {}, left {:?}",
        started.elapsed().as_millis(),
        out.placements.len(),
        out.left_over
    );
    let objects: Vec<Value> = out
        .placements
        .iter()
        .map(|p| {
            let t = items.iter().find(|i| i.0 == p.id).unwrap().1;
            let (s, c) = (p.angle_deg * PI / 180.0).sin_cos();
            let m = [
                c * t[0] - s * t[1],
                s * t[0] + c * t[1],
                0.0,
                0.0,
                c * t[4] - s * t[5],
                s * t[4] + c * t[5],
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
                0.0,
                c * t[12] - s * t[13] + p.offset[0],
                s * t[12] + c * t[13] + p.offset[1],
                0.0,
                1.0,
            ];
            json!({"id": p.id, "name": p.id, "mesh": p.id, "transform": m})
        })
        .collect();
    let req: SliceRequest = serde_json::from_value(json!({
        "plate": {"bed": {"widthMm": bed, "depthMm": bed, "heightMm": 250}, "objects": objects},
        "config": cfg,
        "options": {"trustedGcode": true},
    }))
    .unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = kit
        .iter()
        .map(|(name, (pos, tris), slot)| {
            let part = MeshPart {
                name: name.clone(),
                slot: *slot,
                color: None,
                positions: pos.iter().map(|p| p.map(|x| x as f32)).collect(),
                triangles: tris.clone(),
                paint: Vec::new(),
                support_paint: Vec::new(),
                seam_paint: Vec::new(),
                fuzzy_paint: Vec::new(),
                paint_texts: Vec::new(),
            };
            (
                name.clone(),
                Arc::new(Mesh {
                    name: name.clone(),
                    parts: vec![part],
                    ..Mesh::default()
                }),
            )
        })
        .collect();
    let started = std::time::Instant::now();
    let run = match api::run_request(&req, &move |id: &str| {
        Ok(meshes.iter().find(|m| m.0 == id).unwrap().1.clone())
    }) {
        Ok(r) => r,
        Err(e) => return vec![format!("refused: {e}")],
    };
    eprintln!("slice {} ms", started.elapsed().as_millis());
    run.report
        .collisions
        .iter()
        .filter(|c| c.kind == Kind::PathConflict || c.kind == Kind::KeepOut)
        .map(|c| {
            format!(
                "{:?} {} x {} layer {} at {:?}",
                c.kind,
                c.object_id,
                c.hit_id,
                c.layer + 1,
                c.at
            )
        })
        .collect()
}

/// The prime tower goes where it clears every object's first layer. A thin sliver standing on its edge gets an
/// automatic brim much wider than `brim_width`; the tower used to keep only `brim_width` from it, stood on that
/// brim, and their first layer paths crossed.
#[test]
fn an_arranged_figure_kit_slices_with_no_paths_crossing() {
    let hits = arrange_and_slice(&kit(), &p1s(), 6e6);
    assert!(hits.is_empty(), "{hits:?}");
}

/// Seeded plates of 12 to 25 random curved parts in two filaments: arranged, then sliced, no paths ever cross.
#[test]
fn random_plates_of_curved_parts_arrange_clear_of_each_other() {
    let cfg = p1s();
    let mut bad = Vec::new();
    for seed in 1..=6u64 {
        let n = 12 + (seed as usize * 5) % 14;
        let hits = arrange_and_slice(&random_plate(seed, n), &cfg, 1.5e6);
        eprintln!("seed {seed} ({n} parts): {} crossings", hits.len());
        for h in hits.iter().take(4) {
            eprintln!("   {h}");
        }
        if !hits.is_empty() {
            bad.push(seed);
        }
    }
    assert!(bad.is_empty(), "plates with crossings: {bad:?}");
}
