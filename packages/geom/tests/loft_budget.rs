// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! how finely the mesh loft draws: a 9-profile closed-spline loft's splines at the exact path's 0.01 mm chord, a loft
//! past the triangle budget drawn coarser to keep within it, and lofts that drawing coarser cannot help made or refused
//! as before

#![cfg(feature = "cad")]

use serde_json::{Value, json};
use sx_geom::fm::Fm;
use sx_geom::hollow::closest_point_on_triangle;
use sx_geom::sketch_loft::{self, Options, Profile};
use sx_geom::sketch_spline;
use sx_geom::vec3::{self, V3};

/// the exact path's chord, which the mesh loft draws at, mm
const CHORD_MM: f64 = 0.01;
/// the most triangles a mesh loft body has
const BUDGET: usize = 250_000;

/// The sections of a 9-profile closed-spline loft 220 mm long, each grown by `scale` about the loft's start.
fn sections(scale: f64) -> Value {
    // (x, half width at the sides, the sides' upper and lower heights, top and bottom half widths, top, bottom)
    let at = [
        (0.0, 36.0, 25.5, 17.4, 19.8, 30.6, 30.0, 12.0),
        (8.0, 41.0, 28.5, 16.8, 22.55, 34.85, 35.0, 9.0),
        (30.0, 43.0, 30.5, 17.0, 23.65, 36.55, 38.0, 8.0),
        (75.0, 43.0, 32.0, 17.6, 23.65, 36.55, 40.0, 8.0),
        (110.0, 43.0, 32.75, 17.9, 23.65, 36.55, 41.0, 8.0),
        (150.0, 43.0, 32.75, 17.9, 23.65, 36.55, 41.0, 8.0),
        (190.0, 42.0, 34.25, 18.5, 23.1, 35.7, 43.0, 8.0),
        (210.0, 38.0, 34.0, 19.6, 20.9, 32.3, 42.0, 10.0),
        (220.0, 32.0, 31.75, 20.5, 17.6, 27.2, 38.0, 13.0),
    ];
    let profiles: Vec<Value> = at
        .iter()
        .map(|&(x, side, upper, lower, top_w, bottom_w, top, bottom)| {
            let p = |a: f64, b: f64| [a * scale, b * scale];
            json!({
                "frame": { "origin": [x * scale, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
                "loops": [{ "type": "spline", "points": [
                    p(top_w, top), p(side, upper), p(side, lower), p(bottom_w, bottom),
                    p(-bottom_w, bottom), p(-side, lower), p(-side, upper), p(-top_w, top),
                ] }],
            })
        })
        .collect();
    Value::Array(profiles)
}

fn smooth(profiles: &Value) -> sx_geom::Result<sx_geom::mesh::TriMesh> {
    let profiles: Vec<Profile> = serde_json::from_value(profiles.clone()).unwrap();
    sketch_loft::loft_with(
        &profiles,
        &Options {
            smooth: true,
            ..Options::default()
        },
    )
}

#[test]
fn a_closed_spline_lofts_splines_are_drawn_at_the_exact_paths_chord() {
    let all = sections(1.0);
    let m = smooth(&all).unwrap();
    // its splines drawn at 0.005 mm, this body had 121686 triangles
    let n = m.triangles.len();
    assert!(n <= 100_000, "{n} triangles");
    // the first section's spline, drawn finely, lies within the chord of the body's end
    let first = &all[0];
    let pts: Vec<[f64; 2]> = serde_json::from_value(first["loops"][0]["points"].clone()).unwrap();
    #[allow(clippy::cast_precision_loss, reason = "a small count")]
    let fine: Vec<[f64; 2]> = sketch_spline::spans(&pts, true)
        .iter()
        .flat_map(|b| (0..2000).map(move |k| sketch_spline::point(b, f64::from(k) / 2000.0)))
        .collect();
    let end: Vec<[V3; 3]> = m
        .triangles
        .iter()
        .map(|t| t.map(|i| m.positions[i as usize]))
        .filter(|c| c.iter().all(|p| p[0].abs() < 1e-9))
        .collect();
    let near = |q: V3, [a, b, c]: [V3; 3]| vec3::len(vec3::sub(closest_point_on_triangle(q, a, b, c), q));
    let off = fine
        .iter()
        .map(|p| {
            let q = [0.0, p[0], p[1]];
            end.iter().map(|&t| near(q, t)).fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max);
    assert!(off <= CHORD_MM + 1e-9, "{off} mm off the drawn section");
}

#[test]
fn a_loft_past_the_budget_is_drawn_coarser_to_keep_within_it() {
    // five times the size: drawn at 0.01 mm it would have about five times the triangles
    let m = smooth(&sections(5.0)).unwrap();
    let n = m.triangles.len();
    assert!(n <= BUDGET, "{n} triangles");
    assert!(n > BUDGET / 4, "{n} triangles: drawn coarser than it needs");
}

/// A ring of 4000 points, 50 mm across its radius, at `x` along the loft and `y` across.
fn dense(x: f64, y: f64) -> Value {
    let pts: Vec<[f64; 2]> = (0..4000)
        .map(|i| {
            let (s, c) = (std::f64::consts::TAU * f64::from(i) / 4000.0).m_sin_cos();
            [y + 50.0 * c, 50.0 * s]
        })
        .collect();
    json!({ "frame": { "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] }, "loops": [{ "points": pts }] })
}

#[test]
fn a_loft_drawing_coarser_cannot_help_is_made_as_before() {
    // straight rings of 4000 points draw the same at any tolerance: 40 of them make more than the budget
    let profiles: Vec<Profile> = serde_json::from_value(Value::Array(
        (0..40).map(|k| dense(f64::from(k) * 5.0, 0.0)).collect(),
    ))
    .unwrap();
    let m = sketch_loft::loft_with(&profiles, &Options::default()).unwrap();
    assert!(m.triangles.len() > BUDGET, "{} triangles", m.triangles.len());
}

#[test]
fn a_loft_past_the_point_limit_is_refused_as_before() {
    let profiles: Vec<Profile> =
        serde_json::from_value(json!([dense(0.0, 0.0), dense(10.0, 1000.0), dense(20.0, 0.0)])).unwrap();
    let e = sketch_loft::loft_with(
        &profiles,
        &Options {
            smooth: true,
            ..Options::default()
        },
    )
    .unwrap_err();
    assert_eq!(
        e.to_string(),
        "profiles: the smooth loft would have more than 1000000 points; use fewer or simpler profiles"
    );
}
