// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A smooth loft stays within its sections: no dip below the lowest keel and no beam wider than the widest section on
//! unevenly spaced hull stations, while a twisted vase keeps to its twist as closely as the plain curve did.

#![cfg(feature = "cad")]
#![allow(clippy::many_single_char_names, reason = "sizes and results in short tests")]

use serde_json::{Value, json};
use std::f64::consts::PI;
use std::path::Path;
use sx_geom::fm::Fm;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}")))
        .unwrap()
}

/// the sections of `fixtures/hull-sections.json` under `key`
fn sections(key: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hull-sections.json");
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    fx[key].clone()
}

fn smooth_loft(profiles: &Value) -> Vec<[f64; 3]> {
    let m = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }));
    let p: Vec<f64> = m["mesh"]["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    p.chunks(3).map(|c| [c[0], c[1], c[2]]).collect()
}

/// the lowest and highest of each coordinate over `pts`
fn bounds(pts: impl Iterator<Item = [f64; 3]>) -> ([f64; 3], [f64; 3]) {
    pts.fold(([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]), |(lo, hi), p| {
        (
            std::array::from_fn(|k| lo[k].min(p[k])),
            std::array::from_fn(|k| hi[k].max(p[k])),
        )
    })
}

/// the points of hull stations across x (u along +y, v along +z), in place
fn station_points(profiles: &Value) -> impl Iterator<Item = [f64; 3]> + '_ {
    profiles.as_array().unwrap().iter().flat_map(|p| {
        let o: Vec<f64> = p["frame"]["origin"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        p["loops"][0]["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(move |q| [o[0], o[1] + q[0].as_f64().unwrap(), o[2] + q[1].as_f64().unwrap()])
    })
}

/// stations of the uneven hull, each moved up by its own amount
fn rocker(lift: [f64; 3]) -> Value {
    let mut s = sections("overshoot");
    let middle = s[1]["loops"].clone();
    for (p, up) in s.as_array_mut().unwrap().iter_mut().zip(lift) {
        p["loops"] = middle.clone();
        p["frame"]["origin"][2] = json!(up);
    }
    s
}

#[test]
fn unevenly_spaced_hull_stations_are_not_passed() {
    // 3 stations 8 and then 42 mm apart, and the 15 of a whole hull; f32 storage moves a corner by under 1e-5 mm
    for key in ["overshoot", "hull"] {
        let s = sections(key);
        let (slo, shi) = bounds(station_points(&s));
        let (lo, hi) = bounds(smooth_loft(&s).into_iter());
        for k in 0..3 {
            assert!(
                lo[k] >= slo[k] - 1e-5,
                "{key}: axis {k} goes to {} past {}",
                lo[k],
                slo[k]
            );
            assert!(
                hi[k] <= shi[k] + 1e-5,
                "{key}: axis {k} goes to {} past {}",
                hi[k],
                shi[k]
            );
        }
    }
}

#[test]
fn a_rocker_keel_dips_only_a_little_below_its_lowest_station() {
    // the middle station lowest, the stations 8 and then 42 mm apart: where the keel turns back the curve keeps its
    // way, held by the steps on both sides, so it passes the low station by under 0.02 mm (the plain curve, 0.136 mm)
    let s = rocker([1.0, 0.0, 0.6]);
    let (lo, _) = bounds(smooth_loft(&s).into_iter());
    assert!(lo[2] > -0.02, "{}", lo[2]);
}

/// the most a twisted regular polygon vase lofted through `n` sections goes inside and outside the true twisted
/// surface, mm
#[allow(clippy::cast_precision_loss, reason = "small counts")]
fn twist_error(sides: usize, n: usize) -> (f64, f64) {
    let (r, h, turn) = (20.0, 60.0, PI / 3.0);
    let profiles: Vec<Value> = (0..n)
        .map(|k| {
            let f = k as f64 / (n - 1) as f64;
            let pts: Vec<[f64; 2]> = (0..sides)
                .map(|j| {
                    let a = turn * f + 2.0 * PI * j as f64 / sides as f64;
                    [r * a.m_cos(), r * a.m_sin()]
                })
                .collect();
            json!({ "frame": { "origin": [0, 0, h * f], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] }, "loops": [{ "points": pts }] })
        })
        .collect();
    let apothem = r * (PI / sides as f64).m_cos();
    let (mut inside, mut outside) = (0.0_f64, 0.0_f64);
    for q in smooth_loft(&json!(profiles)) {
        let rad = q[0].m_hypot(q[1]);
        if rad < 1e-6 {
            continue;
        }
        // the polygon's own radius the way the point lies, turned back by the twist at its height
        let at = q[1].m_atan2(q[0]) - turn * q[2] / h;
        let most = (0..sides)
            .map(|j| (at - (2 * j + 1) as f64 * PI / sides as f64).m_cos())
            .fold(f64::NEG_INFINITY, f64::max);
        let d = rad - apothem / most;
        inside = inside.min(d);
        outside = outside.max(d);
    }
    (inside, outside)
}

#[test]
fn a_twisted_vase_keeps_to_its_twist() {
    // the plain curve's own figures: holding the curve on the hull leaves a twist as it was
    for (sides, n, inside, outside) in [
        (6, 5, -0.1000, 0.0030),
        (6, 9, -0.0245, 0.0005),
        (4, 5, -0.0985, 0.0050),
        (4, 9, -0.0245, 0.0005),
    ] {
        let (i, o) = twist_error(sides, n);
        assert!(
            i >= inside && o <= outside,
            "{sides} sides, {n} sections: {i:.4} inside, {o:.4} outside"
        );
    }
}
