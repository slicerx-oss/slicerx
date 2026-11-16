// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A solid hollowed to a wall at a true constant distance: a box and a cylinder shelled open at the top and closed,
// against their closed forms, at three sizes and far from the origin; every point of the inner side read back the wall
// from the outer one; the faces the shell kept carry their keys; and the refusals. Empty without the typed feature, so
// a workspace test run that names every test target passes over it.
#![cfg(feature = "typed")]
use std::collections::HashSet;
use std::f64::consts::PI;
use sx_brep::{Body, Error, Face, Mesh, Surface, Tessellation};

type P = [f64; 3];

/// How far a wall may come out from the distance asked, in mm.
const WALL_MM: f64 = 0.01;

/// Fine triangles for a body of about `scale` times 40 mm, so a small one is read at as many points as a large one.
fn fine(scale: f64) -> Tessellation {
    Tessellation {
        chord_mm: 0.002 * scale,
        max_edge_mm: 0.8 * scale,
        ..Tessellation::default()
    }
}

/// Each face's mesh points off its edges.
fn inside_points(m: &Mesh) -> Vec<Vec<P>> {
    let on_edge: HashSet<u32> = m.edges.iter().flat_map(|e| e.points.iter().copied()).collect();
    let mut out = vec![Vec::new(); m.surfaces.len()];
    let mut seen = HashSet::new();
    for (t, &f) in m.triangles.iter().zip(&m.faces) {
        for &v in t {
            if !on_edge.contains(&v) && seen.insert(v) {
                out[f as usize].push(m.positions[v as usize]);
            }
        }
    }
    out
}

/// The farthest any point of the shell's inner side, below `below`, is from `wall` off the solid it was made from, and
/// how many points were read.
fn wall_off(from: &Body, shelled: &Body, wall: f64, below: f64, scale: f64) -> (f64, usize) {
    let (mut worst, mut n) = (0.0f64, 0);
    for points in inside_points(&shelled.tessellate(&fine(scale)).expect("a mesh")) {
        let d: Vec<f64> = points
            .iter()
            .filter(|p| p[2] < below)
            .map(|&p| from.distance_to(p).expect("a distance"))
            .collect();
        // the outer side's own points are on the solid
        if d.first().is_none_or(|&first| first < wall / 2.0) {
            continue;
        }
        n += d.len();
        worst = d.iter().fold(worst, |w, x| w.max((x - wall).abs()));
    }
    (worst, n)
}

fn top(body: &Body, at: P) -> Face<'_> {
    let faces = body.faces().expect("faces");
    *faces
        .iter()
        .find(|f| {
            matches!(f.surface(), Surface::Plane { .. }) && f.distance_to(at).expect("a distance") < 1e-9
        })
        .expect("the top face")
}

fn close(a: f64, b: f64, rel: f64) {
    assert!((a - b).abs() <= rel * b.abs(), "{a} != {b}");
}

#[test]
fn a_box_shelled_has_its_closed_form_and_a_true_wall_at_every_size_and_place() {
    if !sx_brep::KERNEL {
        return;
    }
    for scale in [0.1, 1.0, 10.0] {
        for origin in [[0.0; 3], [1000.0, -700.0, 400.0]] {
            let [ox, oy, oz] = origin;
            let (width, depth, height, wall) = (40.0 * scale, 30.0 * scale, 20.0 * scale, 2.0 * scale);
            let mut block = Body::cuboid(origin, [width, depth, height]).expect("a box");
            block.set_keys(&[11, 12, 13, 14, 15, 16]).expect("keys");
            let open = top(&block, [ox + width / 2.0, oy + depth / 2.0, oz + height]);
            let cup = block.shell(wall, &[open]).expect("a cup");
            close(
                cup.volume().expect("volume"),
                width * depth * height - (width - 2.0 * wall) * (depth - 2.0 * wall) * (height - wall),
                1e-6,
            );
            // five outer faces and five inner ones, and the rim
            assert_eq!(cup.faces().expect("faces").len(), 11);
            let (off, n) = wall_off(&block, &cup, wall, oz + height - wall - 0.05 * scale, scale);
            assert!(
                n > 100 && off <= WALL_MM,
                "scale {scale} at {origin:?}: {off} mm over {n} points"
            );
            // the faces kept on the box's surface carry the box's keys, the rim left of the top its key
            let keys: HashSet<u64> = cup.keys().expect("keys").into_iter().collect();
            assert!((11..=16).all(|k| keys.contains(&k)), "{keys:?}");
            let hollow = block.shell(wall, &[]).expect("a closed hollow");
            close(
                hollow.volume().expect("volume"),
                width * depth * height - (width - 2.0 * wall) * (depth - 2.0 * wall) * (height - 2.0 * wall),
                1e-6,
            );
            let (off, _) = wall_off(&block, &hollow, wall, f64::INFINITY, scale);
            assert!(off <= WALL_MM, "{off}");
        }
    }
}

#[test]
fn a_cylinder_shelled_keeps_a_round_wall_of_the_thickness_asked() {
    if !sx_brep::KERNEL {
        return;
    }
    for scale in [0.1, 1.0, 10.0] {
        for base in [[0.0; 3], [1000.0, -700.0, 400.0]] {
            let (r, h, wall) = (10.0 * scale, 20.0 * scale, 2.0 * scale);
            let c = Body::cylinder(base, r, h).expect("a cylinder");
            let open = top(&c, [base[0], base[1], base[2] + h]);
            let cup = c.shell(wall, &[open]).expect("a cup");
            close(
                cup.volume().expect("volume"),
                PI * (r * r * h - (r - wall).powi(2) * (h - wall)),
                1e-6,
            );
            let (off, n) = wall_off(&c, &cup, wall, base[2] + h - wall - 0.05 * scale, scale);
            assert!(
                n > 100 && off <= WALL_MM,
                "scale {scale} at {base:?}: {off} mm over {n} points"
            );
            let hollow = c.shell(wall, &[]).expect("a closed hollow");
            close(
                hollow.volume().expect("volume"),
                PI * (r * r * h - (r - wall).powi(2) * (h - 2.0 * wall)),
                1e-6,
            );
        }
    }
}

#[test]
fn a_shell_is_refused_in_words_before_the_kernel_is_asked() {
    if !sx_brep::KERNEL {
        return;
    }
    let b = Body::cuboid([0.0; 3], [10.0; 3]).expect("a box");
    let other = Body::cuboid([20.0; 3], [10.0; 3]).expect("a box");
    let why = |made: Result<Body, Error>| made.expect_err("a refusal").to_string();
    assert_eq!(why(b.shell(0.0, &[])), "wall: must be more than 0 mm");
    assert_eq!(why(b.shell(f64::NAN, &[])), "wall: must be a finite number");
    assert_eq!(why(b.shell(1000.5, &[])), "wall: must be at most 1000 mm");
    let theirs = other.faces().expect("faces")[0];
    assert_eq!(
        why(b.shell(1.0, &[theirs])),
        "open: each open face must be one of this body's"
    );
}
