// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Lofts through profiles of lines and arcs as exact solids: each piece with an arc skinned and held to its true
// curves at every profile (a line paired with an arc as the line it is), the volume beside the mesh loft's, two real
// hulls and the join each took next, a spline hull's reply as before, and a closed loft through arcs still refused.
// Empty without the brep feature, so a workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
#[allow(
    dead_code,
    reason = "each test file uses its own share of what they have in common"
)]
mod common;

use common::{Held, held_to_its_curves, held_to_its_drawing, sha256, true_points};
use serde_json::{Value, json};
use std::f64::consts::{FRAC_1_SQRT_2, TAU};
use std::fmt::Write as _;
use sx_geom::exact as table;
use sx_geom::fm::Fm;
use sx_geom::sketch_loft::Curve;
use sx_geom::sketch_loft::exact::Kind;
use sx_geom::vec3::{self, V3};

/// Three hulls of real runs as they were sent: two of lines and arcs with the join each run made next, and one of
/// lines and a spline that was made exact before arcs were.
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/exact-loft-arcs.json")).unwrap()
}

fn level(z: f64, lp: &Value) -> Value {
    json!({
        "frame": { "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
        "loops": [lp],
    })
}

/// A `width` by `height` rectangle with its corners rounded at `radius`, each arc given by a point through it.
fn rounded(width: f64, height: f64, radius: f64) -> Value {
    let (x, y) = (width / 2.0 - radius, height / 2.0 - radius);
    let bend = radius * FRAC_1_SQRT_2;
    let arc = |to: [f64; 2], c: [f64; 2], d: [f64; 2]| json!({ "type": "arc", "to": to, "through": [c[0] + d[0] * bend, c[1] + d[1] * bend] });
    let line = |to: [f64; 2]| json!({ "type": "line", "to": to });
    json!({
        "start": [-x, -height / 2.0],
        "segments": [
            line([x, -height / 2.0]), arc([width / 2.0, -y], [x, -y], [1.0, -1.0]),
            line([width / 2.0, y]), arc([x, height / 2.0], [x, y], [1.0, 1.0]),
            line([-x, height / 2.0]), arc([-width / 2.0, y], [-x, y], [-1.0, 1.0]),
            line([-width / 2.0, -y]), arc([-x, -height / 2.0], [-x, -y], [-1.0, -1.0]),
        ],
    })
}

/// A hull section at `x`: a deck line across the top, each side down to the keel line through `side`, an arc or,
/// with `straight`, a line.
fn section(x: f64, deck: [f64; 2], side: [f64; 2], keel: [f64; 2], straight: bool) -> Value {
    let down = |to: [f64; 2], through: [f64; 2]| {
        if straight {
            json!({ "type": "line", "to": to })
        } else {
            json!({ "type": "arc", "to": to, "through": through })
        }
    };
    json!({
        "frame": { "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
        "loops": [{ "start": [-deck[0], deck[1]], "segments": [
            { "type": "line", "to": deck },
            down(keel, side),
            { "type": "line", "to": [-keel[0], keel[1]] },
            down([-deck[0], deck[1]], [-side[0], side[1]]),
        ]}],
    })
}

/// How a case's volume is held against the mesh loft's.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Volume {
    /// Within 0.2 percent of it.
    NearMesh,
    /// Over it. The mesh loft cuts corners through smooth sections there (the card
    /// mesh-smooth-loft-folds-hull-side), so it is no sound reference for the volume, and the body is held to its
    /// drawn curves and closed instead.
    OverMesh,
}

/// The lofts made exact here, with a line paired with an arc in the last two.
fn cases() -> Vec<(&'static str, Value, Volume)> {
    let f = fixture();
    let hull = |middle_straight: bool| {
        json!([
            section(-40.0, [6.0, 14.0], [5.6, 7.0], [3.0, 0.0], false),
            section(0.0, [10.0, 15.0], [9.6, 8.0], [5.0, 0.0], middle_straight),
            section(40.0, [5.0, 16.0], [4.7, 9.0], [2.5, 2.0], false),
        ])
    };
    let circle = json!({ "type": "circle", "center": [0, 0], "diameterMm": 20 });
    let square = json!({ "points": [[-10, -10], [10, -10], [10, 10], [-10, 10]] });
    vec![
        (
            "smooth, run 3's nine hull sections",
            f["run3"]["loft"].clone(),
            Volume::NearMesh,
        ),
        (
            "smooth, run b6r's nine hull sections",
            f["b6r"]["loft"].clone(),
            Volume::NearMesh,
        ),
        (
            "smooth, three hull sections",
            json!({ "profiles": hull(false), "smooth": true }),
            Volume::OverMesh,
        ),
        (
            "straight, three rounded rectangles",
            json!({
                "profiles": [
                    level(0.0, &rounded(40.0, 24.0, 6.0)),
                    level(15.0, &rounded(34.0, 20.0, 5.0)),
                    level(30.0, &rounded(30.0, 18.0, 3.0)),
                ],
            }),
            Volume::NearMesh,
        ),
        (
            "smooth, three hull sections, the middle one's sides straight",
            json!({ "profiles": hull(true), "smooth": true }),
            Volume::OverMesh,
        ),
        (
            "smooth, a circle to a square",
            json!({ "profiles": [level(0.0, &circle), level(20.0, &square)], "smooth": true }),
            Volume::NearMesh,
        ),
    ]
}

/// Where the body's triangles cross the plane through `origin` square to `normal`: each crossing edge's point on it.
fn sliced(mesh: &sx_brep::Mesh, origin: V3, normal: V3) -> Vec<V3> {
    let side = |p: V3| vec3::dot(vec3::sub(p, origin), normal);
    let mut out = Vec::new();
    for triangle in &mesh.triangles {
        let corners = triangle.map(|i| mesh.positions[i as usize]);
        for (one, two) in [(0, 1), (1, 2), (2, 0)] {
            let (near, far) = (side(corners[one]), side(corners[two]));
            if (near < 0.0) != (far < 0.0) {
                out.push(vec3::lerp(corners[one], corners[two], near / (near - far)));
            }
        }
    }
    out
}

/// Holds a loft between its sections: halfway between each two neighbors, the body cut there (its fine mesh sliced
/// at that plane) spans no farther across the sections' plane than the larger of the two, 0.01 mm over at most. A loft
/// that follows its sections never stands outside both. Gives each cut's span and its room, `[u min, u max, v min,
/// v max]` in mm.
fn within_its_neighbors(name: &str, request: &Value, mesh: &sx_brep::Mesh) -> Vec<String> {
    let v3 = |x: &Value| -> V3 { [0, 1, 2].map(|k| x[k].as_f64().unwrap()) };
    let profiles = request["profiles"].as_array().unwrap();
    let (across, up) = (v3(&profiles[0]["frame"]["u"]), v3(&profiles[0]["frame"]["v"]));
    let span = |points: &[V3]| -> [f64; 4] {
        let start = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
        points.iter().fold(start, |was, point| {
            let (along, high) = (vec3::dot(*point, across), vec3::dot(*point, up));
            [
                was[0].min(along),
                was[1].max(along),
                was[2].min(high),
                was[3].max(high),
            ]
        })
    };
    let mut read = Vec::new();
    let mut outside = Vec::new();
    for (k, pair) in profiles.windows(2).enumerate() {
        let [before, after] = [&pair[0], &pair[1]].map(|p| span(&true_points(p, 512)));
        let at = |key: &str| vec3::add(v3(&pair[0]["frame"][key]), v3(&pair[1]["frame"][key]));
        let normal = vec3::normalize(at("normal")).expect("a plane between the two");
        let cut = span(&sliced(mesh, vec3::scale(at("origin"), 0.5), normal));
        let room = [
            before[0].min(after[0]) - sx_brep::DRAWN_MM,
            before[1].max(after[1]) + sx_brep::DRAWN_MM,
            before[2].min(after[2]) - sx_brep::DRAWN_MM,
            before[3].max(after[3]) + sx_brep::DRAWN_MM,
        ];
        let line = format!(
            "between sections {} and {}, the body spans {cut:.4?} within {room:.4?}",
            k + 1,
            k + 2
        );
        if cut[0] < room[0] || cut[1] > room[1] || cut[2] < room[2] || cut[3] > room[3] {
            outside.push(line.clone());
        }
        read.push(line);
    }
    assert!(outside.is_empty(), "{name}: {}", outside.join("; "));
    read
}

#[test]
fn pieces_with_arcs_loft_to_exact_solids_held_to_their_true_curves() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let mut report = String::new();
    for (name, request, held_how) in cases() {
        // every profile's true curves within 0.01 mm of the body, the body closed, and the volume within 0.2 percent
        // of the mesh loft's or, where the mesh loft cuts corners, over it
        let held = if held_how == Volume::NearMesh {
            held_to_its_drawing(name, &request)
        } else {
            let held = held_to_its_curves(name, &request);
            assert!(
                held.volume > held.want,
                "{name}: volume {} not over the mesh loft's {}",
                held.volume,
                held.want
            );
            for line in within_its_neighbors(name, &request, &held.mesh) {
                writeln!(report, "BETWEEN {name}: {line}").unwrap();
            }
            held
        };
        let Held {
            lofted,
            mesh: close,
            off,
            volume,
            want,
        } = held;
        // a piece straight on every profile is a ruled side, any other a skinned one, and the ends are flat
        let pieces = &lofted.rails.pieces;
        let straight = pieces
            .iter()
            .filter(|p| p.curves.iter().all(|c| *c == Curve::Line))
            .count();
        let count = |kind: Kind| lofted.kinds.iter().filter(|k| **k == kind).count();
        assert_eq!(count(Kind::Ruled), straight, "{name}");
        assert_eq!(count(Kind::Skinned), pieces.len() - straight, "{name}");
        let per: Vec<String> = off.iter().map(|o| format!("{o:.6}")).collect();
        let share = (volume - want) / want;
        let lowest = close.positions.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
        writeln!(
            report,
            "ARCS {name}: {} pieces ({straight} straight), {} rails after {} doublings, drawing {:e} mm by read-back, \
             true curves to body by profile [{}] mm, volume {volume:.3} against {want:.3} mm3 ({:+.4} percent), \
             lowest z {lowest:.6}",
            pieces.len(),
            lofted.rails.rails.len(),
            lofted.doublings,
            lofted.drawn_mm,
            per.join(", "),
            share * 100.0,
        )
        .unwrap();
    }
    print!("{report}");
    assert_eq!(table::count(), start);
}

// ---- the ops, as a design that must stay exact asks them

fn op(name: &str, request: &Value) -> Value {
    let reply = sx_geom::json::call(name, &request.to_string()).unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&reply).unwrap()
}

/// The lowest z of a held body's mesh.
fn lowest(body: &Value) -> f64 {
    let mesh = op("brep.tessellate", &json!({ "body": body }));
    let numbers: Vec<f64> = mesh["positions"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|p| {
            p.as_array().map_or_else(
                || vec![p.as_f64().unwrap()],
                |q| q.iter().map(|x| x.as_f64().unwrap()).collect(),
            )
        })
        .collect();
    numbers.chunks(3).map(|p| p[2]).fold(f64::INFINITY, f64::min)
}

/// A rectangle extrude's outline as the kernel takes it (cad-history exact.ts loops): its corners, or with a corner
/// radius its lines and quarter arcs, moved to the placement's center.
fn rectangle(shape: &Value, center: [f64; 2]) -> Value {
    let (half_w, half_h) = (
        shape["widthMm"].as_f64().unwrap() / 2.0,
        shape["heightMm"].as_f64().unwrap() / 2.0,
    );
    let at = |x: f64, y: f64| json!([center[0] + x, center[1] + y]);
    let Some(radius) = shape["cornerRadiusMm"].as_f64() else {
        return json!({ "points": [at(-half_w, -half_h), at(half_w, -half_h), at(half_w, half_h), at(-half_w, half_h)] });
    };
    let (inner_w, inner_h) = (half_w - radius, half_h - radius);
    let quarter = |to: Value, c: Value| json!({ "to": to, "center": c, "sweepDeg": 90 });
    json!({
        "start": at(half_w, -inner_h),
        "segments": [
            { "to": at(half_w, inner_h) }, quarter(at(inner_w, half_h), at(inner_w, inner_h)),
            { "to": at(-inner_w, half_h) }, quarter(at(-half_w, inner_h), at(-inner_w, inner_h)),
            { "to": at(-half_w, -inner_h) }, quarter(at(-inner_w, -half_h), at(-inner_w, -inner_h)),
            { "to": at(inner_w, -half_h) }, quarter(at(half_w, -inner_h), at(inner_w, -inner_h)),
        ],
    })
}

/// The lowest z of run b6r's hull as an exact body, mm, as measured on 2026-11-14: under the bed by more than the
/// plate's 0.01 mm. Its sections at x 50, 110 and 160 draw each bilge as an arc from (11.2, 4) through (10.42, 1.2)
/// to (6.72, 0), whose circle bottoms out 0.118 mm under the keel line it meets, and the body follows that arc.
const KNOWN_B6R_LOWEST_MM: f64 = -0.117_776;

#[test]
fn the_two_real_hulls_and_the_join_each_run_made_next_stay_exact() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let f = fixture();
    for run in ["run3", "b6r"] {
        let mut loft = f[run]["loft"].clone();
        loft["operation"] = json!("new");
        loft["exact"] = json!(true);
        loft["withKeys"] = json!(true);
        let made = op("sketch.loft", &loft);
        assert!(made.get("exact").is_none(), "{run}: {}", made["exact"]);
        let hull = made["body"].clone();
        assert!(hull.is_u64(), "{run}: no held body");
        // the join as the design's replay sends it: its outline on its plane, one side up by its distance
        let j = &f[run]["join"];
        let c = &j["placement"]["center"];
        let o = &j["frame"]["origin"];
        let joined = op(
            "brep.extrude",
            &json!({
                "frame": { "origin": o, "normal": [0, 0, 1], "u": [1, 0, 0] },
                "polygons": [{ "outer": rectangle(&j["shape"], [c[0].as_f64().unwrap(), c[1].as_f64().unwrap()]), "holes": [] }],
                "fromMm": 0,
                "toMm": j["distance_mm"],
                "target": hull,
                "operation": "join",
                "withKeys": true,
            }),
        );
        assert_eq!(joined["touches"], json!(true), "{run}");
        let body = joined["body"].clone();
        assert!(body.is_u64(), "{run}: the join made no held body");
        // the app's plate calls a part off the bed whose lowest point is under it by more than 0.01 mm. Run b6r's own
        // bilge arcs dip under its keel line, and its body follows them as it should, so its dip is kept as measured
        // and this fails if it moves
        let (before, after) = (lowest(&hull), lowest(&body));
        println!("HULL {run}: lowest z {before:.6} mm lofted, {after:.6} mm after its join");
        if run == "b6r" {
            for z in [before, after] {
                assert!(
                    (z - KNOWN_B6R_LOWEST_MM).abs() <= 1e-6,
                    "{run}: the known dip is no longer {KNOWN_B6R_LOWEST_MM} mm but {z} mm"
                );
            }
        } else {
            assert!(before >= -0.01 && after >= -0.01, "{run}: {before} and {after}");
        }
        for b in [hull, body] {
            assert_eq!(op("brep.free", &json!({ "body": b }))["freed"], json!(true));
        }
    }
    assert_eq!(table::count(), start);
}

#[test]
fn a_spline_hull_lofts_exact_as_before() {
    if !sx_brep::KERNEL {
        return;
    }
    let mut loft = fixture()["b6"]["loft"].clone();
    loft["operation"] = json!("new");
    loft["exact"] = json!(true);
    loft["save"] = json!(true);
    let reply = sx_geom::json::call("sketch.loft", &loft.to_string()).unwrap();
    let made: Value = serde_json::from_str(&reply).unwrap();
    assert!(
        made.get("exact").is_none() && made["bodySmb"].is_string(),
        "{}",
        made["exact"]
    );
    // the whole reply, solid text and all, printed to compare with the commit before this one
    println!("SPLINE HULL reply sha256 {}", sha256(reply.as_bytes()));
}

#[test]
fn a_closed_loft_through_arcs_is_still_refused() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    // six rounded rectangles around a ring, each standing across it
    let ring: Vec<Value> = (0_u8..6)
        .map(|k| {
            let (s, c) = (TAU * f64::from(k) / 6.0).m_sin_cos();
            json!({
                "frame": { "origin": [60.0 * c, 60.0 * s, 0], "normal": [-s, c, 0], "u": [c, s, 0], "v": [0, 0, 1] },
                "loops": [rounded(16.0, 12.0, 3.0)],
            })
        })
        .collect();
    let reply = op(
        "sketch.loft",
        &json!({ "profiles": ring, "closed": true, "exact": true }),
    );
    assert_eq!(
        reply["exact"],
        json!({ "made": false, "why": "A closed loft through arcs, circles or ellipses is not made exact yet." })
    );
    assert!(reply.get("body").is_none() && reply.get("bodySmb").is_none());
    assert_eq!(table::count(), start);
}
