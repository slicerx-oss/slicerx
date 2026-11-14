// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the rings a loft is made through, as sketch.loft.rings hands them out: matched point to point, each point on the
//! same rail as the mesh loft's own, the exact body's rails when asked for, and refused in the loft's words

#![cfg(feature = "cad")]
#![allow(clippy::cast_precision_loss, reason = "small counts")]

use serde_json::{Value, json};
use std::f64::consts::TAU;
use sx_geom::fm::Fm;
use sx_geom::sketch::{self, Loop};
use sx_geom::sketch_loft::{self, Options, Profile};
use sx_geom::vec3::V3;

fn level(z: f64) -> Value {
    json!({ "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] })
}

fn at(z: f64, lp: &Value) -> Value {
    json!({ "frame": level(z), "loops": [lp] })
}

/// a polygon of `n` corners on a circle of radius `r`, the first turned `turn` from +x
fn polygon(n: u32, r: f64, turn: f64) -> Value {
    let pts: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let (s, c) = (turn + TAU * f64::from(i) / f64::from(n)).m_sin_cos();
            [r * c, r * s]
        })
        .collect();
    json!({ "points": pts })
}

/// A D: a straight top from (-w, 0) to (w, 0) and a spline under it `depth` deep.
fn d_section(w: f64, depth: f64) -> Value {
    let points: Vec<[f64; 2]> = [
        (0.8, -0.5),
        (0.4, -0.95),
        (0.0, -1.0),
        (-0.4, -0.95),
        (-0.8, -0.5),
    ]
    .iter()
    .map(|&(x, y)| [x * w, y * depth])
    .collect();
    json!({ "start": [-w, 0], "segments": [
        { "type": "line", "to": [w, 0] },
        { "type": "spline", "points": points, "to": [-w, 0] },
    ] })
}

/// Lofts through sections of a straight top and a spline below, as the exact loft tests take them.
fn spline_loft(name: &str) -> Value {
    let all: Value = serde_json::from_str(include_str!("fixtures/exact-loft-splines.json")).unwrap();
    all[name].clone()
}

fn call(op: &str, req: &Value) -> Result<String, String> {
    sx_geom::json::call(op, &req.to_string()).map_err(|e| e.to_string())
}

fn rings_of(req: &Value) -> Value {
    serde_json::from_str(&call("sketch.loft.rings", req).unwrap()).unwrap()
}

fn parsed(req: &Value) -> (Vec<Profile>, Options) {
    let opts = json!({
        "smooth": req["smooth"].as_bool().unwrap_or(false),
        "closed": req["closed"].as_bool().unwrap_or(false),
    });
    (
        serde_json::from_value(req["profiles"].clone()).unwrap(),
        serde_json::from_value(opts).unwrap(),
    )
}

/// The reply's rings as points.
fn points(reply: &Value) -> Vec<Vec<V3>> {
    reply["rings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|ring| {
            ring.as_array()
                .unwrap()
                .iter()
                .map(|p| [0, 1, 2].map(|i| p[i].as_f64().unwrap()))
                .collect()
        })
        .collect()
}

/// How many points each profile's outline flattens to as drawn.
fn drawn_counts(req: &Value) -> Vec<usize> {
    req["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let loops: Vec<Loop> = serde_json::from_value(p["loops"].clone()).unwrap();
            sketch::polygons(&loops).unwrap()[0].outer.len()
        })
        .collect()
}

/// Every ring the same length, and each ring a row of the mesh loft, bit for bit: the mesh's points are its rows one
/// after another, so point `i` of a row is on rail `i`.
fn on_the_mesh_rails(name: &str, req: &Value) {
    let reply = rings_of(req);
    assert_eq!(reply["route"], "mesh", "{name}");
    let rings = points(&reply);
    let (profiles, opts) = parsed(req);
    assert_eq!(rings.len(), profiles.len(), "{name}");
    let n = rings[0].len();
    assert!(rings.iter().all(|r| r.len() == n), "{name}: ring lengths differ");
    let mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
    assert!(mesh.positions.len().is_multiple_of(n), "{name}");
    let bits = |p: &V3| p.map(f64::to_bits);
    let rows: Vec<Vec<[u64; 3]>> = mesh
        .positions
        .chunks(n)
        .map(|row| row.iter().map(bits).collect())
        .collect();
    let mut last = None;
    for (k, ring) in rings.iter().enumerate() {
        let ring: Vec<[u64; 3]> = ring.iter().map(bits).collect();
        let row = rows.iter().position(|r| *r == ring);
        assert!(row.is_some(), "{name}: ring {k} is no row of the mesh loft");
        // in loft order
        assert!(row > last, "{name}: ring {k} out of order");
        last = row;
    }
    // the same rings the engine lines up
    let matched = sketch_loft::matched_rings(&profiles, &opts).unwrap();
    assert_eq!(matched.rings, rings, "{name}");
    assert_eq!(reply["wrap"], json!(matched.wrap), "{name}");
    assert_eq!(reply["closedRings"], json!(matched.ring_closed), "{name}");
}

#[test]
fn every_ring_is_a_row_of_the_mesh_loft_straight_and_smooth() {
    let profiles = json!([
        at(0.0, &polygon(4, 10.0, 0.0)),
        at(15.0, &polygon(6, 9.0, 0.3)),
        at(30.0, &polygon(5, 7.0, 0.1)),
    ]);
    for smooth in [false, true] {
        let req = json!({ "profiles": profiles, "smooth": smooth });
        on_the_mesh_rails(&format!("polygons, smooth {smooth}"), &req);
        assert_eq!(rings_of(&req)["wrap"], Value::Null);
        assert_eq!(rings_of(&req)["closedRings"], true);
    }
    // operation and target are not read
    let joined = json!({ "profiles": profiles, "operation": "join", "target": { "mesh": "none" } });
    assert_eq!(
        call("sketch.loft.rings", &joined),
        call("sketch.loft.rings", &json!({ "profiles": profiles }))
    );
}

#[test]
fn spline_sections_that_flatten_to_different_counts_share_one_count() {
    let req = json!({
        "profiles": [at(0.0, &d_section(10.0, 2.0)), at(20.0, &d_section(14.0, 30.0)), at(40.0, &d_section(6.0, 9.0))],
        "smooth": true,
    });
    let drawn = drawn_counts(&req);
    assert!(drawn.iter().any(|&c| c != drawn[0]), "{drawn:?}");
    on_the_mesh_rails("D sections of different depths", &req);
    for name in ["dSections", "hull18"] {
        on_the_mesh_rails(name, &spline_loft(name));
    }
}

#[test]
fn landmarked_rings_keep_their_landmarks_on_one_rail() {
    let marked = |z: f64, r: f64, n: u32| {
        let mut p = at(z, &polygon(n, r, 0.0));
        p["landmarks"] = json!([[r, 0.0], [-r, 0.0]]);
        p
    };
    let req = json!({ "profiles": [marked(0.0, 10.0, 8), marked(20.0, 6.0, 12), marked(40.0, 9.0, 6)], "smooth": true });
    on_the_mesh_rails("landmarked polygons", &req);
    let rings = points(&rings_of(&req));
    // each landmark is on one rail through every ring
    let rail = |k: usize, x: f64| {
        rings[k]
            .iter()
            .position(|p| (p[0] - x).abs() < 1e-9 && p[1].abs() < 1e-9)
    };
    for side in [1.0, -1.0] {
        let first = rail(0, 10.0 * side);
        assert!(first.is_some(), "{side}");
        assert_eq!(rail(1, 6.0 * side), first, "{side}");
        assert_eq!(rail(2, 9.0 * side), first, "{side}");
    }
}

#[test]
fn a_closed_loft_says_where_its_rails_come_back() {
    // four squares around the z axis, each turned a little more about its own middle
    let frame = |a: f64| {
        let (s, c) = a.m_sin_cos();
        json!({ "origin": [30.0 * c, 30.0 * s, 0], "normal": [-s, c, 0], "u": [c, s, 0], "v": [0, 0, 1] })
    };
    let profiles: Vec<Value> = (0..4)
        .map(|k| {
            let a = TAU * f64::from(k) / 4.0;
            json!({ "frame": frame(a), "loops": [polygon(4, 5.0, 0.2 * f64::from(k))] })
        })
        .collect();
    let req = json!({ "profiles": profiles, "closed": true });
    let reply = rings_of(&req);
    let (p, opts) = parsed(&req);
    let matched = sketch_loft::matched_rings(&p, &opts).unwrap();
    assert!(matched.wrap.is_some());
    assert_eq!(reply["wrap"], json!(matched.wrap));
    on_the_mesh_rails("closed ring of squares", &req);
    // open: no wrap
    assert_eq!(rings_of(&json!({ "profiles": profiles }))["wrap"], Value::Null);
}

#[test]
fn the_same_request_gives_the_same_bytes() {
    for req in [spline_loft("dSections"), spline_loft("hull18")] {
        let first = call("sketch.loft.rings", &req).unwrap();
        assert_eq!(call("sketch.loft.rings", &req).unwrap(), first);
        let mut exact = req.clone();
        exact["exact"] = json!(true);
        let first = call("sketch.loft.rings", &exact).unwrap();
        assert_eq!(call("sketch.loft.rings", &exact).unwrap(), first);
    }
}

#[test]
fn a_refusal_is_the_loft_s_own() {
    let square = polygon(4, 10.0, 0.0);
    for req in [
        json!({ "profiles": [at(0.0, &square)] }),
        json!({ "profiles": [at(0.0, &square), at(0.0, &polygon(5, 4.0, 0.0))] }),
        json!({ "profiles": [at(0.0, &square), at(10.0, &square)], "closed": true }),
        json!({ "profiles": [at(0.0, &square), { "frame": level(10.0), "loops": [square], "open": true }] }),
        json!({ "profiles": "none" }),
    ] {
        let loft = call("sketch.loft", &req);
        assert!(loft.is_err(), "{req}");
        assert_eq!(call("sketch.loft.rings", &req), loft, "{req}");
    }
    assert_eq!(
        call("sketch.loft.rings", &json!({ "profiles": [at(0.0, &square)] })),
        Err("profiles: a loft needs 2 or more profiles".to_owned())
    );
}

#[cfg(not(feature = "brep"))]
#[test]
fn a_build_without_the_kernel_answers_the_mesh_rings_and_says_so() {
    let req = spline_loft("dSections");
    let mut exact = req.clone();
    exact["exact"] = json!(true);
    let reply = rings_of(&exact);
    assert_eq!(reply["route"], "mesh");
    assert_eq!(reply["rings"], rings_of(&req)["rings"]);
    assert_eq!(
        reply["exact"],
        json!({ "made": false, "why": "This build has no exact kernel." })
    );
}

#[cfg(feature = "brep")]
mod exact_route {
    use super::*;
    use sx_geom::sketch_loft::Density;
    use sx_geom::sketch_loft::exact::{self, MOST_DOUBLINGS};

    #[test]
    fn the_exact_route_hands_out_the_rails_the_body_is_made_on() {
        for name in ["dSections", "hull18"] {
            let mut req = spline_loft(name);
            req["exact"] = json!(true);
            let reply = rings_of(&req);
            if !sx_brep::KERNEL {
                assert_eq!(reply["exact"]["why"], "This build has no exact kernel.");
                continue;
            }
            assert_eq!(reply["route"], "exact", "{name}: {}", reply["exact"]);
            assert!(reply.get("exact").is_none(), "{name}");
            let (profiles, opts) = parsed(&req);
            let lofted =
                exact::lofted_through(&profiles, &opts, &Density::default(), MOST_DOUBLINGS).unwrap();
            let want: Vec<Vec<V3>> = lofted.rails.rings.iter().map(|r| r.points.clone()).collect();
            assert_eq!(points(&reply), want, "{name}");
            assert_eq!(reply["wrap"], json!(lofted.rails.wrap), "{name}");
            assert_eq!(reply["closedRings"], json!(lofted.rails.ring_closed), "{name}");
            let n = want[0].len();
            assert!(want.iter().all(|r| r.len() == n), "{name}");
            // the sketch.loft reply for the same request makes the body
            let loft: Value = serde_json::from_str(&call("sketch.loft", &req).unwrap()).unwrap();
            assert!(
                loft.get("bodySmb").is_some() || loft.get("body").is_some(),
                "{name}: {}",
                loft["exact"]
            );
            if let Some(body) = loft["body"].as_u64() {
                call("brep.free", &json!({ "body": body })).unwrap();
            }
        }
    }

    #[test]
    fn where_the_exact_body_is_not_made_the_mesh_rings_come_back_with_why() {
        let mut req = spline_loft("dSections");
        req["thicken"] = json!({ "thicknessMm": 1.0 });
        let mesh = rings_of(&req);
        req["exact"] = json!(true);
        let reply = rings_of(&req);
        assert_eq!(reply["route"], "mesh");
        assert_eq!(reply["rings"], mesh["rings"]);
        // worded as the loft words it, when the loft makes its mesh
        if let Ok(loft) = call("sketch.loft", &req) {
            let loft: Value = serde_json::from_str(&loft).unwrap();
            assert_eq!(reply["exact"], loft["exact"]);
        }
        if sx_brep::KERNEL {
            assert_eq!(
                reply["exact"]["why"],
                "A loft thickened into a shell is not made exact yet."
            );
        }
    }
}
