// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! freeform lofts through the engine's JSON: smooth sides, rings, and open profiles thickened into shells

#![cfg(feature = "cad")]
#![allow(clippy::many_single_char_names, reason = "points and sizes of test geometry")]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::f64::consts::PI;
use sx_geom::fm::Fm;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&sx_geom::json::call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}")))
        .unwrap()
}

fn fails(op: &str, req: &Value) -> String {
    sx_geom::json::call(op, &req.to_string()).unwrap_err().to_string()
}

fn level(z: f64) -> Value {
    json!({ "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] })
}

fn circle(c: [f64; 2], d: f64) -> Value {
    json!({ "type": "circle", "center": c, "diameterMm": d })
}

fn points(m: &Value) -> Vec<[f64; 3]> {
    m["mesh"]["positions"]
        .as_array()
        .unwrap()
        .chunks(3)
        .map(|c| {
            [
                c[0].as_f64().unwrap(),
                c[1].as_f64().unwrap(),
                c[2].as_f64().unwrap(),
            ]
        })
        .collect()
}

fn solid(m: &Value) {
    assert_eq!(m["watertight"], true, "{}", m["edges"]);
    assert_eq!(m["shells"], 1);
}

fn volume(m: &Value) -> f64 {
    m["volumeMm3"].as_f64().unwrap()
}

#[test]
fn a_smooth_loft_through_equal_circles_is_a_cylinder() {
    let profiles: Vec<Value> = [0.0, 7.0, 20.0, 26.0]
        .iter()
        .map(|&z| json!({ "frame": level(z), "loops": [circle([0.0, 0.0], 20.0)] }))
        .collect();
    let m = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }));
    solid(&m);
    // every point of the sides is on the cylinder (the flat ends may have points inside)
    for p in points(&m)
        .into_iter()
        .filter(|p| p[2] > 1e-6 && p[2] < 26.0 - 1e-6)
    {
        let r = p[0].m_hypot(p[1]);
        assert!((r - 10.0).abs() < 1e-4, "{p:?} is {r} from the axis");
    }
    // the flattened circle's own area times the height
    let ruled = run("sketch.loft", &json!({ "profiles": profiles }));
    assert!(
        (volume(&m) - volume(&ruled)).abs() < 1e-3,
        "{} {}",
        volume(&m),
        volume(&ruled)
    );
    assert!((volume(&m) - PI * 100.0 * 26.0).abs() < PI * 100.0 * 26.0 * 1e-3);
}

/// The points of the side through the +x point of every circle centered on y = 0, from the bottom up.
fn track(m: &Value) -> Vec<[f64; 3]> {
    let mut by_z: BTreeMap<i64, [f64; 3]> = BTreeMap::new();
    for p in points(m).into_iter().filter(|p| p[1].abs() < 1e-4) {
        #[allow(clippy::cast_possible_truncation, reason = "test heights are small")]
        let key = (p[2] * 1e4).round() as i64;
        let e = by_z.entry(key).or_insert(p);
        if p[0] > e[0] {
            *e = p;
        }
    }
    by_z.into_values().collect()
}

fn turn_deg(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    let dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let len = |w: [f64; 3]| (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt();
    (dot / (len(u) * len(v))).clamp(-1.0, 1.0).m_acos().to_degrees()
}

#[test]
fn smooth_sides_leave_a_middle_profile_the_way_they_arrive() {
    let profiles = json!([
        { "frame": level(0.0), "loops": [circle([0.0, 0.0], 10.0)] },
        { "frame": level(10.0), "loops": [circle([8.0, 0.0], 10.0)] },
        { "frame": level(20.0), "loops": [circle([0.0, 0.0], 10.0)] },
    ]);
    // the turn at the middle circle, and the larger of the turns at the points either side of it
    let kink = |m: &Value| {
        let t = track(m);
        let i = t.iter().position(|p| (p[2] - 10.0).abs() < 1e-4).unwrap();
        assert!((t[i][0] - 13.0).abs() < 1e-4, "{:?}", t[i]);
        let side = if i >= 2 && i + 2 < t.len() {
            turn_deg(t[i - 2], t[i - 1], t[i]).max(turn_deg(t[i], t[i + 1], t[i + 2]))
        } else {
            0.0
        };
        (turn_deg(t[i - 1], t[i], t[i + 1]), side)
    };
    // straight sides bend 77 degrees at the middle circle
    let ruled = run("sketch.loft", &json!({ "profiles": profiles }));
    assert!(kink(&ruled).0 > 70.0);
    // smooth ones turn there no more than at their neighboring rows: one step of the curve, no corner
    let smooth = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }));
    solid(&smooth);
    let (at, side) = kink(&smooth);
    assert!(
        at < 10.0 && at <= 1.5 * side + 0.1,
        "{at} at the middle, {side} beside it"
    );
}

#[test]
fn a_closed_loft_is_a_watertight_ring() {
    // eight circles around the z axis on planes through it: a torus 20 mm out, 3 mm thick
    let profiles: Vec<Value> = (0..8)
        .map(|k| {
            let a = f64::from(k) * PI / 4.0;
            let frame = json!({
                "origin": [20.0 * a.m_cos(), 20.0 * a.m_sin(), 0.0],
                "normal": [-a.m_sin(), a.m_cos(), 0.0],
                "u": [a.m_cos(), a.m_sin(), 0.0],
                "v": [0, 0, 1],
            });
            json!({ "frame": frame, "loops": [circle([0.0, 0.0], 6.0)] })
        })
        .collect();
    let torus = 2.0 * PI * PI * 20.0 * 9.0;
    let m = run(
        "sketch.loft",
        &json!({ "profiles": profiles, "closed": true, "smooth": true }),
    );
    solid(&m);
    assert!(
        (volume(&m) - torus).abs() < torus * 0.02,
        "{} vs {torus}",
        volume(&m)
    );
    let ruled = run("sketch.loft", &json!({ "profiles": profiles, "closed": true }));
    solid(&ruled);
    assert!(volume(&ruled) < volume(&m));
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": profiles[..2], "closed": true })
        ),
        "profiles: a closed loft needs 3 or more profiles"
    );
}

fn open_at(z: f64, pts: &[[f64; 2]]) -> Value {
    json!({ "frame": level(z), "open": true, "loops": [{ "points": pts }] })
}

#[test]
fn a_thickened_flat_sheet_is_its_area_times_the_thickness() {
    let line = [[0.0, 0.0], [20.0, 0.0]];
    for side in ["outward", "inward", "center"] {
        let m = run(
            "sketch.loft",
            &json!({ "profiles": [open_at(0.0, &line), open_at(10.0, &line)], "thicken": { "thicknessMm": 2, "side": side } }),
        );
        solid(&m);
        assert!((volume(&m) - 400.0).abs() < 1e-6, "{side}: {}", volume(&m));
    }
    // a surface on its own is no solid
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [open_at(0.0, &line), open_at(10.0, &line)] })
        ),
        "thicken: open profiles make a surface; give thicken to make it a solid"
    );
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [open_at(0.0, &line), { "frame": level(10.0), "loops": [circle([0.0, 0.0], 4.0)] }], "thicken": { "thicknessMm": 1 } })
        ),
        "profiles: profile 2 is closed and profile 1 is open; a loft's profiles are all closed or all open"
    );
}

#[test]
fn a_thickened_shell_that_runs_into_itself_is_refused() {
    // two runs of the chain 1 mm apart: a 2 mm shell centered on them overlaps
    let hook = [
        [0.0, 0.0],
        [40.0, 0.0],
        [40.0, 20.0],
        [-10.0, 20.0],
        [-10.0, 1.0],
        [30.0, 1.0],
    ];
    let req = |mm: f64| json!({ "profiles": [open_at(0.0, &hook), open_at(10.0, &hook)], "thicken": { "thicknessMm": mm, "side": "center" } });
    solid(&run("sketch.loft", &req(0.5)));
    assert_eq!(
        fails("sketch.loft", &req(2.0)),
        "thicken: a 2 mm centered shell runs into itself where parts of the surface are closer than that; use a thinner shell or move those parts apart"
    );
}

fn half_circle(r: f64, n: u32) -> Vec<[f64; 2]> {
    (0..=n)
        .map(|i| {
            let a = PI + PI * f64::from(i) / f64::from(n);
            [r * a.m_cos(), r * a.m_sin()]
        })
        .collect()
}

#[test]
fn an_inward_shell_thicker_than_a_tight_bend_is_refused() {
    let u = half_circle(3.0, 48);
    let req = |mm: f64, side: &str| json!({ "profiles": [open_at(0.0, &u), open_at(10.0, &u)], "thicken": { "thicknessMm": mm, "side": side } });
    // outward and thin inward shells fit; the half pipe's inside is 3 mm across from its axis
    for (mm, side) in [(5.0, "outward"), (2.0, "inward")] {
        let m = run("sketch.loft", &req(mm, side));
        solid(&m);
        let (ro, ri) = if side == "outward" {
            (3.0 + mm, 3.0)
        } else {
            (3.0, 3.0 - mm)
        };
        let want = PI / 2.0 * (ro * ro - ri * ri) * 10.0;
        assert!(
            (volume(&m) - want).abs() < want * 0.01,
            "{side}: {} vs {want}",
            volume(&m)
        );
    }
    let err = fails("sketch.loft", &req(5.0, "inward"));
    assert!(
        err.starts_with(
            "thicken: a 5 mm inward shell folds over itself where the surface bends tightest, near ("
        ),
        "{err}"
    );
    let most: f64 = err
        .split("takes at most ")
        .nth(1)
        .and_then(|s| s.split(' ').next())
        .and_then(|s| s.parse().ok())
        .unwrap();
    assert!(most > 2.9 && most <= 3.0, "{err}");
    assert!(err.ends_with("use a thinner shell or thicken outward"), "{err}");
}

#[test]
fn a_hull_from_eight_stations_is_one_closed_shell() {
    // stations along x, each a U open at the deck (z = 0), fuller amidships
    let half_breadth = [3.0, 8.0, 11.0, 12.0, 12.0, 11.0, 9.0, 5.0];
    let depth = [4.0, 7.0, 8.0, 8.5, 8.5, 8.0, 7.0, 5.0];
    let profiles: Vec<Value> = (0..8)
        .map(|k| {
            let pts: Vec<[f64; 2]> = (0..=24)
                .map(|i| {
                    let a = PI + PI * f64::from(i) / 24.0;
                    [half_breadth[k] * a.m_cos(), depth[k] * a.m_sin()]
                })
                .collect();
            #[allow(clippy::cast_precision_loss, reason = "eight stations")]
            let x = 15.0 * k as f64;
            let frame = json!({ "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] });
            json!({ "frame": frame, "open": true, "loops": [{ "points": pts }] })
        })
        .collect();
    let shell = |mm: f64| {
        run(
            "sketch.loft",
            &json!({ "profiles": profiles, "smooth": true, "thicken": { "thicknessMm": mm, "side": "outward" } }),
        )
    };
    let m = shell(1.2);
    solid(&m);
    let b = &m["bounds"];
    assert!(b["min"][0].as_f64().unwrap().abs() < 1.5 && (b["max"][0].as_f64().unwrap() - 105.0).abs() < 1.5);
    assert!(
        b["max"][2].as_f64().unwrap().abs() < 0.05,
        "the deck edge stays at z = 0"
    );
    // outward wraps the skin: past the widest and deepest station by the thickness
    assert!(b["max"][1].as_f64().unwrap() > 12.0 + 1.1, "{b}");
    assert!(b["min"][2].as_f64().unwrap() < -8.5 - 1.1, "{b}");
    // a shell 1.2 mm thick over the skin (its area from a hundredth of a millimeter shell): a little more than the area
    // times the thickness, since outward grows the hull's round skin, and an inward shell would be less
    let skin = volume(&shell(0.01)) / 0.01;
    let per = volume(&m) / 1.2;
    assert!(per > skin && per < skin * 1.1, "{per} vs {skin}");
}

/// A hull half-section across x with its landmarks (see the loft's own tests): deck center, keel, both bilge ends,
/// waterline and sheer.
fn half_station(x: f64, b: f64, d: f64, r: f64) -> Value {
    let mut pts = vec![[0.0, 0.0], [0.0, -d], [b - r, -d]];
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "small counts"
    )]
    let segs = (4.0 * r).ceil().max(2.0) as u32;
    for j in 1..segs {
        let a = -PI / 2.0 + PI / 2.0 * f64::from(j) / f64::from(segs);
        pts.push([b - r + r * a.m_cos(), -d + r + r * a.m_sin()]);
    }
    pts.extend([[b, -d + r], [b, 0.0]]);
    let frame = json!({ "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] });
    json!({
        "frame": frame,
        "loops": [{ "points": pts }],
        "landmarks": [[0.0, 0.0], [0.0, -d], [b - r, -d], [b, -d + r], [b, -0.4 * d], [b, 0.0]],
    })
}

#[test]
fn half_sections_close_on_a_flat_mirror_seam() {
    let stations: Vec<Value> = [
        (0.0, 3.0, 6.0, 1.0),
        (20.0, 8.0, 8.0, 3.0),
        (40.0, 12.0, 9.0, 5.0),
        (60.0, 12.0, 9.0, 5.0),
        (80.0, 7.0, 7.0, 2.5),
    ]
    .iter()
    .map(|&(x, b, d, r)| half_station(x, b, d, r))
    .collect();
    let half = run("sketch.loft", &json!({ "profiles": stations, "smooth": true }));
    solid(&half);
    // the centerline side stays on y = 0 all the way along
    let pts = points(&half);
    assert!(pts.iter().all(|p| p[1] > -1e-6), "a point crosses the seam");
    assert!(pts.iter().filter(|p| p[1].abs() < 1e-6).count() > 2 * 5);
    // so the half and its mirror image join into one closed hull of twice the volume
    let mirrored = {
        let mut m = half["mesh"].clone();
        let pos: Vec<f64> = pts.iter().flat_map(|p| [p[0], -p[1], p[2]]).collect();
        m["positions"] = json!(pos);
        let idx: Vec<u64> = m["indices"]
            .as_array()
            .unwrap()
            .chunks(3)
            .flat_map(|t| {
                [
                    t[0].as_u64().unwrap(),
                    t[2].as_u64().unwrap(),
                    t[1].as_u64().unwrap(),
                ]
            })
            .collect();
        m["indices"] = json!(idx);
        m
    };
    let whole = run(
        "boolean",
        &json!({ "op": "union", "a": [{ "mesh": half["mesh"] }, { "mesh": mirrored }], "b": [] }),
    );
    solid(&whole);
    let v = volume(&half);
    assert!(
        (volume(&whole) - 2.0 * v).abs() < 2.0 * v * 1e-6,
        "{} vs {}",
        volume(&whole),
        2.0 * v
    );
}

fn arc_at(frame: &Value, pts: &[[f64; 2]], marks: &[[f64; 2]]) -> Value {
    json!({ "frame": frame, "open": true, "loops": [{ "points": pts }], "landmarks": marks })
}

#[test]
fn sections_that_bow_opposite_ways_make_a_twisted_panel_not_a_bow_tie() {
    // both drawn left to right, the first bowing up, the second down
    let up = [[-10.0, 0.0], [-5.0, 1.5], [0.0, 2.0], [5.0, 1.5], [10.0, 0.0]];
    let down = up.map(|p| [p[0], -p[1]]);
    let thick = json!({ "thicknessMm": 1, "side": "center" });
    let m = run(
        "sketch.loft",
        &json!({ "profiles": [open_at(0.0, &up), open_at(10.0, &down)], "thicken": thick }),
    );
    solid(&m);
    let b = &m["bounds"];
    assert!(b["max"][0].as_f64().unwrap() > 10.0 && b["min"][0].as_f64().unwrap() < -10.0);
    // the second drawn right to left still runs end to end with the first
    let back: Vec<[f64; 2]> = down.iter().rev().copied().collect();
    let drawn_back = run(
        "sketch.loft",
        &json!({ "profiles": [open_at(0.0, &up), open_at(10.0, &back)], "thicken": thick }),
    );
    assert!((volume(&drawn_back) - volume(&m)).abs() < volume(&m) * 1e-9);
    // the same with each end and the middle marked, and one profile drawn right to left
    let marked = run(
        "sketch.loft",
        &json!({ "profiles": [arc_at(&level(0.0), &up, &[[-10.0, 0.0], [0.0, 2.0], [10.0, 0.0]]), arc_at(&level(10.0), &back, &[[-10.0, 0.0], [0.0, -2.0], [10.0, 0.0]])], "thicken": thick }),
    );
    solid(&marked);
    assert!(
        (volume(&marked) - volume(&m)).abs() < volume(&m) * 0.02,
        "{} {}",
        volume(&marked),
        volume(&m)
    );
    // only the middle marked: the chain drawn backward still runs end to end with its neighbor
    let middle = run(
        "sketch.loft",
        &json!({ "profiles": [arc_at(&level(0.0), &up, &[[0.0, 2.0]]), arc_at(&level(10.0), &back, &[[0.0, -2.0]])], "thicken": thick }),
    );
    solid(&middle);
}

#[test]
fn open_chain_landmarks_at_the_ends_count_as_the_ends() {
    let u = half_circle(5.0, 24);
    let thick = json!({ "thicknessMm": 0.5 });
    // ends typed to two decimals are the ends
    let near = |p: [f64; 2]| [p[0] + 0.004, p[1] - 0.003];
    let m = run(
        "sketch.loft",
        &json!({ "profiles": [arc_at(&level(0.0), &u, &[near(u[0]), [0.0, -5.0], near(u[24])]), arc_at(&level(10.0), &u, &[u[0], [0.0, -5.0], u[24]])], "thicken": thick }),
    );
    solid(&m);
    // one profile marks the start and the middle, the other the middle and a point past it: refused, never cut short
    let q = u[18];
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [arc_at(&level(0.0), &u, &[u[0], [0.0, -5.0]]), arc_at(&level(10.0), &u, &[[0.0, -5.0], q])], "thicken": thick })
        ),
        "profiles: profile 2 and profile 1 mark different numbers of landmarks between their ends (2 and 1); mark the same points on every profile"
    );
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [arc_at(&level(0.0), &u, &[[0.0, -5.0], q]), arc_at(&level(10.0), &u, &[u[0], [0.0, -5.0]])], "thicken": thick })
        ),
        "profiles: profile 2 and profile 1 mark different numbers of landmarks between their ends (1 and 2); mark the same points on every profile"
    );
    // the start and the middle against the middle and the end: the same counts, but not the same points
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [arc_at(&level(0.0), &u, &[u[0], [0.0, -5.0]]), arc_at(&level(10.0), &u, &[[0.0, -5.0], u[24]])], "thicken": thick })
        ),
        "profiles: profile 2's landmark 1 is between its ends and profile 1's is at its start; mark the same points on every profile"
    );
    // a lone start against a lone end of a chain drawn the same way
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [arc_at(&level(0.0), &u, &[u[0]]), arc_at(&level(10.0), &u, &[u[24]])], "thicken": thick })
        ),
        "profiles: profile 2's landmark 1 is at its end and profile 1's is at its start; mark the same points on every profile"
    );
    // the same point marked on a chain drawn the other way is its end, and it lofts
    let back: Vec<[f64; 2]> = u.iter().rev().copied().collect();
    solid(&run(
        "sketch.loft",
        &json!({ "profiles": [arc_at(&level(0.0), &u, &[u[0]]), arc_at(&level(10.0), &back, &[u[0]])], "thicken": thick }),
    ));
}

#[test]
fn a_closed_profile_with_one_or_two_landmarks_lofts_upside_down() {
    let square = |s: f64| json!({ "points": [[-s, -s], [s, -s], [s, s], [-s, s]] });
    let down = json!({ "origin": [0, 0, 10], "normal": [0, 0, -1], "u": [1, 0, 0], "v": [0, -1, 0] });
    for marks in [vec![[-10.0, -10.0]], vec![[-10.0, -10.0], [10.0, 10.0]]] {
        let top: Vec<[f64; 2]> = marks.iter().map(|p| [p[0] / 2.0, -p[1] / 2.0]).collect();
        let m = run(
            "sketch.loft",
            &json!({ "profiles": [
                { "frame": level(0.0), "loops": [square(10.0)], "landmarks": marks },
                { "frame": down, "loops": [square(5.0)], "landmarks": top },
            ] }),
        );
        solid(&m);
        let v = 10.0 / 3.0 * (400.0 + 100.0 + 200.0);
        assert!(
            (volume(&m) - v).abs() < 1e-6,
            "{} landmarks: {}",
            marks.len(),
            volume(&m)
        );
    }
}

#[test]
fn an_open_profile_sweeps_into_a_shell() {
    let path = json!({ "points": [[0, 0, 0], [0, 0, 20]] });
    let u = half_circle(5.0, 48);
    let back: Vec<[f64; 2]> = u.iter().rev().copied().collect();
    for pts in [&u, &back] {
        for (side, ro, ri) in [("outward", 6.0, 5.0), ("inward", 5.0, 4.0)] {
            let m = run(
                "sketch.sweep",
                &json!({ "profile": { "open": true, "loops": [{ "points": pts }] }, "path": path, "thicken": { "thicknessMm": 1, "side": side } }),
            );
            solid(&m);
            let want = PI / 2.0 * (ro * ro - ri * ri) * 20.0;
            assert!(
                (volume(&m) - want).abs() < want * 0.01,
                "{side}: {} vs {want}",
                volume(&m)
            );
        }
    }
    // along a bent path too
    let bent = json!({ "points": [[0, 0, 0], [0, 0, 20], [0, 10, 30]] });
    solid(&run(
        "sketch.sweep",
        &json!({ "profile": { "open": true, "loops": [{ "points": u }] }, "path": bent, "thicken": { "thicknessMm": 1 } }),
    ));
    // a closed profile thickened is a tube
    let tube = run(
        "sketch.sweep",
        &json!({ "profile": { "loops": [circle([0.0, 0.0], 10.0)] }, "path": path, "thicken": { "thicknessMm": 1 } }),
    );
    solid(&tube);
    let want = PI * (36.0 - 25.0) * 20.0;
    assert!((volume(&tube) - want).abs() < want * 0.01, "{}", volume(&tube));
    assert_eq!(
        fails(
            "sketch.sweep",
            &json!({ "profile": { "open": true, "loops": [{ "points": u }] }, "path": path })
        ),
        "thicken: an open profile makes a surface; give thicken to make it a solid"
    );
}

#[test]
fn closed_profiles_thickened_make_a_tube() {
    let profiles = json!([
        { "frame": level(0.0), "loops": [circle([0.0, 0.0], 20.0)] },
        { "frame": level(10.0), "loops": [circle([0.0, 0.0], 20.0)] },
    ]);
    for (side, ro, ri) in [("outward", 11.0, 10.0), ("inward", 10.0, 9.0)] {
        let m = run(
            "sketch.loft",
            &json!({ "profiles": profiles, "thicken": { "thicknessMm": 1, "side": side } }),
        );
        solid(&m);
        let want = PI * (ro * ro - ri * ri) * 10.0;
        assert!(
            (volume(&m) - want).abs() < want * 0.01,
            "{side}: {} vs {want}",
            volume(&m)
        );
    }
}

/// `n` profiles on planes through the z axis, `r` mm out, each `loop_at(k)` on its own plane.
fn around(n: u32, r: f64, turn_deg: f64, loop_at: impl Fn(u32) -> Value) -> Vec<Value> {
    (0..n)
        .map(|k| {
            let a = (f64::from(k) * turn_deg).to_radians();
            let frame = json!({
                "origin": [r * a.m_cos(), r * a.m_sin(), 0.0],
                "normal": [-a.m_sin(), a.m_cos(), 0.0],
                "u": [a.m_cos(), a.m_sin(), 0.0],
                "v": [0, 0, 1],
            });
            let mut p = loop_at(k);
            p["frame"] = frame;
            p
        })
        .collect()
}

#[test]
fn rings_thickened_and_rings_of_open_chains() {
    // a hollow torus: eight 6 mm circles around the z axis, 20 mm out, made a 1 mm shell outward
    let circles = around(8, 20.0, 45.0, |_| json!({ "loops": [circle([0.0, 0.0], 6.0)] }));
    let m = run(
        "sketch.loft",
        &json!({ "profiles": circles, "closed": true, "smooth": true, "thicken": { "thicknessMm": 1 } }),
    );
    assert_eq!(m["watertight"], true);
    assert_eq!(m["shells"], 2, "an outer and an inner skin");
    let want = 2.0 * PI * PI * 20.0 * (16.0 - 9.0);
    assert!(
        (volume(&m) - want).abs() < want * 0.03,
        "{} vs {want}",
        volume(&m)
    );
    // a trough around the axis: eight open half circles, 3 mm across, made a 1 mm shell
    let u = half_circle(3.0, 24);
    let troughs = around(
        8,
        20.0,
        45.0,
        |_| json!({ "open": true, "loops": [{ "points": u }] }),
    );
    let m = run(
        "sketch.loft",
        &json!({ "profiles": troughs, "closed": true, "smooth": true, "thicken": { "thicknessMm": 1 } }),
    );
    solid(&m);
    // a half pipe 3 to 4 mm out, carried around a 20 mm circle
    let want = PI / 2.0 * (16.0 - 9.0) * 2.0 * PI * 20.0;
    assert!(
        (volume(&m) - want).abs() < want * 0.03,
        "{} vs {want}",
        volume(&m)
    );
}

#[test]
fn smooth_lofts_say_what_is_wrong() {
    let ring = |x: f64, z: f64, d: f64| json!({ "frame": level(z), "loops": [circle([x, 0.0], d)] });
    // a smooth loft that comes back around onto its start runs into itself
    let spiral = around(6, 20.0, 121.0, |_| json!({ "loops": [circle([0.0, 0.0], 6.0)] }));
    assert_eq!(
        fails("sketch.loft", &json!({ "profiles": spiral, "smooth": true })),
        "loft: the lofted body runs into itself; space the profiles further apart or make them smaller"
    );
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [ring(0.0, 0.0, 10.0), ring(20_000.0, 1.0, 10.0), ring(0.0, 2.0, 10.0)], "smooth": true })
        ),
        "loft: the smooth sides bend too sharply between profiles 1 and 2; space them more evenly or make the change between them smaller"
    );
    // 4000 points a ring and over 250 rows
    let many = |x: f64, z: f64| {
        let pts: Vec<[f64; 2]> = (0..4000)
            .map(|i| {
                let a = 2.0 * PI * f64::from(i) / 4000.0;
                [x + 50.0 * a.m_cos(), 50.0 * a.m_sin()]
            })
            .collect();
        json!({ "frame": level(z), "loops": [{ "points": pts }] })
    };
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": [many(0.0, 0.0), many(1000.0, 10.0), many(0.0, 20.0)], "smooth": true })
        ),
        "profiles: the smooth loft would have more than 1000000 points; use fewer or simpler profiles"
    );
    // a ring that goes around twice runs into itself
    let twice = around(6, 20.0, 121.0, |_| json!({ "loops": [circle([0.0, 0.0], 6.0)] }));
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": twice, "closed": true, "smooth": true })
        ),
        "loft: the lofted body runs into itself; space the profiles further apart or make them smaller"
    );
}

#[test]
fn smooth_through_two_or_three_profiles() {
    let two = json!([
        { "frame": level(0.0), "loops": [circle([0.0, 0.0], 20.0)] },
        { "frame": level(10.0), "loops": [circle([3.0, 0.0], 10.0)] },
    ]);
    let ruled = run("sketch.loft", &json!({ "profiles": two }));
    let smooth = run("sketch.loft", &json!({ "profiles": two, "smooth": true }));
    solid(&smooth);
    assert!(
        (volume(&smooth) - volume(&ruled)).abs() < 1e-6,
        "{} {}",
        volume(&smooth),
        volume(&ruled)
    );
    // the fewest a ring takes
    let three = around(3, 20.0, 120.0, |_| json!({ "loops": [circle([0.0, 0.0], 6.0)] }));
    let m = run(
        "sketch.loft",
        &json!({ "profiles": three, "closed": true, "smooth": true }),
    );
    solid(&m);
    // fuller than straight sides between the three, short of the round torus the three sit on
    let ruled = run("sketch.loft", &json!({ "profiles": three, "closed": true }));
    let torus = 2.0 * PI * PI * 20.0 * 9.0;
    assert!(
        volume(&m) > volume(&ruled) && volume(&m) < torus,
        "{} {} {torus}",
        volume(&m),
        volume(&ruled)
    );
}

#[test]
fn a_centered_shell_takes_twice_one_side() {
    let u = half_circle(3.0, 48);
    let err = fails(
        "sketch.loft",
        &json!({ "profiles": [open_at(0.0, &u), open_at(10.0, &u)], "thicken": { "thicknessMm": 8, "side": "center" } }),
    );
    let most: f64 = err
        .split("takes at most ")
        .nth(1)
        .and_then(|s| s.split(' ').next())
        .and_then(|s| s.parse().ok())
        .unwrap();
    assert!(most > 5.8 && most <= 6.0, "{err}");
    assert!(
        err.contains("8 mm centered shell") && err.ends_with("thicken to one side"),
        "{err}"
    );
}

#[test]
fn open_chains_turn_with_their_planes() {
    // three troughs 120 degrees apart around the z axis, the fewest a ring takes, and each chain's inside meets the next
    // one's inside
    let u = half_circle(3.0, 24);
    let thick = json!({ "thicknessMm": 1 });
    let troughs = around(
        3,
        20.0,
        120.0,
        |_| json!({ "open": true, "loops": [{ "points": u }] }),
    );
    let ruled = run(
        "sketch.loft",
        &json!({ "profiles": troughs, "closed": true, "thicken": thick }),
    );
    solid(&ruled);
    let smooth = run(
        "sketch.loft",
        &json!({ "profiles": troughs, "closed": true, "smooth": true, "thicken": thick }),
    );
    solid(&smooth);
    // a half pipe 3 to 4 mm out: fuller with smooth sides than straight ones, short of carrying it around a circle
    let ring = PI / 2.0 * (16.0 - 9.0) * 2.0 * PI * 20.0;
    assert!(
        volume(&ruled) < volume(&smooth) && volume(&smooth) < ring,
        "{} {} {ring}",
        volume(&ruled),
        volume(&smooth)
    );
    // an elbow of two of them, the second drawn either way
    let back: Vec<[f64; 2]> = u.iter().rev().copied().collect();
    let elbow = |second: &[[f64; 2]]| {
        let mut p = around(
            2,
            20.0,
            120.0,
            |_| json!({ "open": true, "loops": [{ "points": u }] }),
        );
        p[1]["loops"][0]["points"] = json!(second);
        run("sketch.loft", &json!({ "profiles": p, "thicken": thick }))
    };
    let (a, b) = (elbow(&u), elbow(&back));
    solid(&a);
    solid(&b);
    assert!(
        (volume(&a) - volume(&b)).abs() < volume(&a) * 1e-9,
        "{} {}",
        volume(&a),
        volume(&b)
    );
    // one landmark on each elbow chain, at its start: it sets the chain's way, drawn either way, and the elbow comes out
    // as it does unmarked
    let marked_elbow = |second: &[[f64; 2]], mark: [f64; 2]| {
        let mut p = around(
            2,
            20.0,
            120.0,
            |_| json!({ "open": true, "loops": [{ "points": u }], "landmarks": [u[0]] }),
        );
        p[1]["loops"][0]["points"] = json!(second);
        p[1]["landmarks"] = json!([mark]);
        json!({ "profiles": p, "thicken": thick })
    };
    for second in [&u, &back] {
        let m = run("sketch.loft", &marked_elbow(second, u[0]));
        assert!(
            (volume(&m) - volume(&a)).abs() < volume(&a) * 1e-6,
            "{} {}",
            volume(&m),
            volume(&a)
        );
    }
    // its start against the second's end, both drawn the same way
    assert_eq!(
        fails("sketch.loft", &marked_elbow(&u, u[24])),
        "profiles: profile 2's landmark 1 is at its end and profile 1's is at its start; mark the same points on every profile"
    );
}

#[test]
fn landmarks_say_how_a_ring_of_strips_closes() {
    let thick = json!({ "thicknessMm": 1 });
    // four flat strips around the axis, each turned 45 degrees more in its plane: the last meets the first half a turn
    // around, which the ring can't close without its sides crossing
    let strips = around(4, 20.0, 90.0, |k| {
        let a = (f64::from(k) * 45.0).to_radians();
        let (c, s) = (3.0 * a.m_cos(), 3.0 * a.m_sin());
        json!({ "open": true, "loops": [{ "points": [[-c, -s], [c, s]] }] })
    });
    assert_eq!(
        fails(
            "sketch.loft",
            &json!({ "profiles": strips, "closed": true, "thicken": thick })
        ),
        "loft: profile 4 meets profile 1 the other way around where the ring closes, so its sides would cross; turn the profiles so they line up around the ring"
    );
    // the same strips with landmarks at the points `marks` gives from each strip's end (c, s)
    let ring = |turn: f64, marks: &dyn Fn(f64, f64) -> Value| {
        let strips = around(4, 20.0, 90.0, |k| {
            let a = (f64::from(k) * turn).to_radians();
            let (c, s) = (3.0 * a.m_cos(), 3.0 * a.m_sin());
            json!({ "open": true, "loops": [{ "points": [[-c, -s], [c, s]] }], "landmarks": marks(c, s) })
        });
        json!({ "profiles": strips, "closed": true, "thicken": thick })
    };
    // with both ends of every strip marked, the landmarks say how the ring closes: start to start
    let marked = |turn: f64| ring(turn, &|c, s| json!([[-c, -s], [c, s]]));
    solid(&run("sketch.loft", &marked(25.0)));
    // turned 35 degrees each, the closing span twists the strip 105 degrees: placed by shape it would meet profile 1 the
    // other way around, but the landmarks hold it start to start, and smooth sides spread the twist into a good shell
    let mut twisted = marked(35.0);
    twisted["smooth"] = json!(true);
    let m = run("sketch.loft", &twisted);
    solid(&m);
    // short of the 6 by 1 mm band carried flat around the circle, since the twist narrows it between profiles
    let band = 6.0 * 2.0 * PI * 20.0;
    assert!(
        volume(&m) > band * 0.8 && volume(&m) < band,
        "{} {band}",
        volume(&m)
    );
    // turned 45 degrees each, that closing span twists the strip 135 degrees, so the shell folds onto itself
    let err = fails("sketch.loft", &marked(45.0));
    assert!(
        err.starts_with("thicken: a 1 mm outward shell runs into itself"),
        "{err}"
    );
    // one landmark between the ends sets no strip's way, so the ring is placed by shape and refused where it closes
    assert_eq!(
        fails("sketch.loft", &ring(45.0, &|_, _| json!([[0.0, 0.0]]))),
        "loft: profile 4 meets profile 1 the other way around where the ring closes, so its sides would cross; turn the profiles so they line up around the ring"
    );
    // one landmark at the same end of every strip says as much as marking that end and then the other: the twisted ring
    // builds as it does with both marked, and the folded one is refused by its shell, not told to turn profiles whose
    // ends already match
    let smooth = |marks: &dyn Fn(f64, f64) -> Value| {
        let mut r = ring(35.0, marks);
        r["smooth"] = json!(true);
        let m = run("sketch.loft", &r);
        solid(&m);
        volume(&m)
    };
    for end in [-1.0, 1.0] {
        let lone = smooth(&|c, s| json!([[end * c, end * s]]));
        let both = smooth(&|c, s| json!([[end * c, end * s], [-end * c, -end * s]]));
        assert!((lone - both).abs() < both * 1e-9, "{end}: {lone} {both}");
        let err = fails("sketch.loft", &ring(45.0, &|c, s| json!([[end * c, end * s]])));
        assert!(
            err.starts_with("thicken: a 1 mm outward shell runs into itself"),
            "{err}"
        );
    }
}

#[test]
fn a_lone_end_landmark_sets_the_shell_side() {
    // two straight chains 20 mm long, 10 mm apart, thickened 1 mm outward: which face the wall lands on follows the
    // way each chain runs, so a landmark at the end turns it, as marking the end and then the start does
    let sheet = |marks: &[[f64; 2]]| {
        let p = |z: f64| json!({ "frame": level(z), "open": true, "loops": [{ "points": [[0.0, 0.0], [20.0, 0.0]] }], "landmarks": marks });
        let m = run(
            "sketch.loft",
            &json!({ "profiles": [p(0.0), p(10.0)], "thicken": { "thicknessMm": 1 } }),
        );
        solid(&m);
        let pts = points(&m);
        let lo = pts.iter().fold([f64::MAX; 3], |a, p| {
            [a[0].min(p[0]), a[1].min(p[1]), a[2].min(p[2])]
        });
        let hi = pts.iter().fold([f64::MIN; 3], |a, p| {
            [a[0].max(p[0]), a[1].max(p[1]), a[2].max(p[2])]
        });
        (lo, hi)
    };
    let near = |a: ([f64; 3], [f64; 3]), b: ([f64; 3], [f64; 3])| {
        (0..3).all(|i| (a.0[i] - b.0[i]).abs() < 1e-9 && (a.1[i] - b.1[i]).abs() < 1e-9)
    };
    let plain = sheet(&[]);
    let start = sheet(&[[0.0, 0.0]]);
    let end = sheet(&[[20.0, 0.0]]);
    let both = sheet(&[[20.0, 0.0], [0.0, 0.0]]);
    assert!(near(plain, start), "{plain:?} {start:?}");
    assert!(near(end, both), "{end:?} {both:?}");
    // the same box, its wall on the other face of the sheet
    let y = |b: ([f64; 3], [f64; 3])| [b.0[1], b.1[1]];
    let (p, e) = (y(plain), y(end));
    assert!(
        (p[1] - p[0] - 1.0).abs() < 1e-9 && (e[1] - e[0] - 1.0).abs() < 1e-9,
        "{p:?} {e:?}"
    );
    assert!(
        (p[0] + e[1]).abs() < 1e-9 && (p[1] + e[0]).abs() < 1e-9,
        "{p:?} {e:?}"
    );
}

#[test]
fn a_smooth_loft_shells_open_at_the_top_to_the_voxel_wall() {
    // eight points a profile, each wider and turned on from the last: curved sides, so the wall is the voxel one
    let ring = |r: f64, turn: f64| {
        let points: Vec<[f64; 2]> = (0..8)
            .map(|i| {
                let a = turn + PI / 4.0 * f64::from(i);
                [r * a.m_cos(), r * a.m_sin()]
            })
            .collect();
        json!({ "points": points })
    };
    let profiles = json!([
        { "frame": level(0.0), "loops": [ring(15.0, 0.0)] },
        { "frame": level(15.0), "loops": [ring(19.0, 0.26)] },
        { "frame": level(30.0), "loops": [ring(24.0, 0.52)] },
    ]);
    let loft = run("sketch.loft", &json!({ "profiles": profiles, "smooth": true }));
    let open = json!([{ "at": [0, 0, 30], "normal": [0, 0, 1] }]);
    let m = run(
        "shell",
        &json!({ "mesh": loft["mesh"], "open": open, "wallMm": 3 }),
    );
    solid(&m);
    let r = &m["report"];
    assert_eq!(r["exact"], false);
    assert!(r["note"].as_str().unwrap().contains("curved"), "{r}");
    // what cutting the hollowed loft out of the loft for the cavity made, before the inner wall stood for it
    assert!(
        (volume(&m) - 12_270.26).abs() < 12_270.26 * 1e-4,
        "{}",
        volume(&m)
    );
    let tris = m["mesh"]["indices"].as_array().unwrap().len() / 3;
    assert!(tris.abs_diff(31_312) < 313, "{tris}");
}

fn rect(w: f64, h: f64) -> Value {
    json!({ "points": [[-w / 2.0, -h / 2.0], [w / 2.0, -h / 2.0], [w / 2.0, h / 2.0], [-w / 2.0, h / 2.0]] })
}

fn up(h: f64) -> Value {
    json!({ "points": [[0, 0, 0], [0, 0, h]] })
}

#[test]
fn a_straight_taper_is_the_frustum() {
    let m = run(
        "sketch.sweep",
        &json!({ "profile": { "loops": [circle([0.0, 0.0], 20.0)] }, "path": up(30.0), "scaleEnd": 0.5 }),
    );
    solid(&m);
    let want = PI * 30.0 / 3.0 * (100.0 + 50.0 + 25.0);
    assert!((volume(&m) / want - 1.0).abs() < 5e-3, "{} vs {want}", volume(&m));
    // the top is the 10 mm circle (its flat face may have points inside)
    let top: Vec<f64> = points(&m)
        .into_iter()
        .filter(|p| (p[2] - 30.0).abs() < 1e-9)
        .map(|p| p[0].m_hypot(p[1]))
        .collect();
    let most = top.iter().copied().fold(0.0f64, f64::max);
    assert!((most - 5.0).abs() < 1e-4, "{most}");
    // eased, the same ends and a fuller middle
    let eased = run(
        "sketch.sweep",
        &json!({ "profile": { "loops": [circle([0.0, 0.0], 20.0)] }, "path": up(30.0), "scaleEnd": [0.5, 0.5], "ease": "smooth" }),
    );
    solid(&eased);
    assert!(volume(&eased) > volume(&m), "{} {}", volume(&eased), volume(&m));
}

#[test]
fn a_twisted_square_keeps_the_prism_volume_and_height() {
    let m = run(
        "sketch.sweep",
        &json!({ "profile": { "loops": [rect(10.0, 10.0)] }, "path": up(30.0), "twistDeg": 90 }),
    );
    solid(&m);
    // within the arc tolerance over the four sides
    assert!(
        (volume(&m) - 3000.0).abs() < 40.0 * 30.0 * 0.005,
        "{}",
        volume(&m)
    );
    let pts = points(&m);
    let (lo, hi) = pts
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), p| (lo.min(p[2]), hi.max(p[2])));
    assert!(lo.abs() < 1e-9 && (hi - 30.0).abs() < 1e-9, "{lo} {hi}");
    // every side point is on the square turned by its share of the quarter turn
    for p in pts.iter().filter(|p| p[2] > 1e-6 && p[2] < 30.0 - 1e-6) {
        let (s, c) = (-p[2] / 30.0 * PI / 2.0).m_sin_cos();
        let (x, y) = (p[0] * c - p[1] * s, p[0] * s + p[1] * c);
        let edge = x.abs().max(y.abs());
        assert!((edge - 5.0).abs() < 1e-4, "{p:?} turns back to ({x}, {y})");
    }
    let top: Vec<&[f64; 3]> = pts.iter().filter(|p| (p[2] - 30.0).abs() < 1e-9).collect();
    assert!(
        top.iter()
            .all(|p| p[0].abs() <= 5.0 + 1e-4 && p[1].abs() <= 5.0 + 1e-4)
    );
    // a quarter turn on its own corners would pinch; the steps in between keep the sides close
    assert!(pts.len() > 40, "{}", pts.len());
}

#[test]
fn an_arc_with_twist_and_scale_is_one_closed_shell() {
    let path = json!({ "loops": [{ "start": [30, 0], "segments": [{ "type": "arc", "center": [0, 0], "sweepDeg": 90 }] }] });
    let profile = json!({ "frame": { "origin": [30, 0, 0], "normal": [0, 1, 0], "u": [-1, 0, 0], "v": [0, 0, 1] }, "loops": [rect(6.0, 3.0)] });
    for ease in ["linear", "smooth"] {
        let m = run(
            "sketch.sweep",
            &json!({ "profile": profile, "path": path, "twistDeg": 60, "scaleEnd": [1.5, 0.8], "ease": ease }),
        );
        solid(&m);
        assert_eq!(m["edges"]["nonManifoldEdges"], 0, "{}", m["edges"]);
        // between the start's area and the end's along the quarter arc
        let len = 30.0 * PI / 2.0;
        let v = volume(&m);
        assert!(v > 18.0 * len * 0.99 && v < 18.0 * 1.2 * len, "{ease}: {v}");
    }
}

#[test]
fn a_taper_says_what_is_wrong() {
    let profile = json!({ "loops": [circle([0.0, 0.0], 10.0)] });
    assert_eq!(
        fails(
            "sketch.sweep",
            &json!({ "profile": profile, "path": up(10.0), "scaleEnd": 0 })
        ),
        "scaleEnd: the end scale must be 0.05 or more of the start, not 0"
    );
    assert_eq!(
        fails(
            "sketch.sweep",
            &json!({ "profile": profile, "path": up(10.0), "scaleEnd": [1, 0.01] })
        ),
        "scaleEnd: the end scale must be 0.05 or more of the start, not 0.01"
    );
    // a 10 mm circle round an 8 mm bend fits, but grown to three times its size it crosses on the inside
    let bend = json!({ "loops": [{ "start": [8, 0], "segments": [{ "type": "arc", "center": [0, 0], "sweepDeg": 90 }] }] });
    let side = json!({ "frame": { "origin": [8, 0, 0], "normal": [0, 1, 0], "u": [-1, 0, 0], "v": [0, 0, 1] }, "loops": [circle([0.0, 0.0], 10.0)] });
    solid(&run("sketch.sweep", &json!({ "profile": side, "path": bend })));
    let e = fails(
        "sketch.sweep",
        &json!({ "profile": side, "path": bend, "scaleEnd": 3 }),
    );
    assert!(
        e.starts_with("sweep: the path bends too tightly for the profile near (")
            && e.ends_with("use a wider bend or a smaller profile or end scale"),
        "{e}"
    );
    assert_eq!(
        fails(
            "sketch.sweep",
            &json!({ "profile": profile, "path": { "loops": [{ "points": [[0, 0], [0, 10]] }], "smooth": true } })
        ),
        "path: smooth is for a path of points; draw a spline for a smooth path on a plane"
    );
}

#[test]
fn a_thickened_open_profile_tapers() {
    let u = half_circle(5.0, 48);
    let m = run(
        "sketch.sweep",
        &json!({ "profile": { "open": true, "loops": [{ "points": u }] }, "path": up(20.0), "thicken": { "thicknessMm": 1 }, "scaleEnd": 0.5 }),
    );
    solid(&m);
    // half rings 1 mm thick on a radius running from 5 to 2.5 mm
    let want = PI / 2.0 * (2.0 * 3.75 + 1.0) * 20.0;
    assert!((volume(&m) / want - 1.0).abs() < 0.02, "{} vs {want}", volume(&m));
}

#[test]
fn a_smooth_path_of_points_is_a_bent_tube() {
    // seven points on a quarter circle of 30 mm, rising from the bed and leaning over to run along x
    let given: Vec<[f64; 3]> = (0..7)
        .map(|k| {
            let a = (f64::from(k) * 15.0).to_radians();
            [30.0 - 30.0 * a.m_cos(), 0.0, 30.0 * a.m_sin()]
        })
        .collect();
    // the profile square to the curve where it starts, along its first chord
    let a = 7.5f64.to_radians();
    let (s, c) = (a.m_sin(), a.m_cos());
    let frame = json!({ "origin": [0, 0, 0], "normal": [s, 0, c], "u": [c, 0, -s], "v": [0, 1, 0] });
    let m = run(
        "sketch.sweep",
        &json!({ "profile": { "frame": frame, "loops": [circle([0.0, 0.0], 4.0)] }, "path": { "points": given, "smooth": true } }),
    );
    solid(&m);
    // the curve through them is longer than the chords and close to the arc, so the tube is close to the torus piece
    let area = PI * 4.0;
    let (chords, arc) = (6.0 * 60.0 * (7.5f64.to_radians()).m_sin(), 15.0 * PI);
    let along = volume(&m) / area;
    assert!(
        along > chords * 0.999 && along < arc * 1.005,
        "{along} between {chords} and {arc}"
    );
    // and its sides stay near the arc all the way (the curve's ends straighten a little against their mirrored neighbors)
    for p in points(&m) {
        let r = (p[0] - 30.0).m_hypot(p[2]);
        let y = p[1];
        let off = (r - 30.0).m_hypot(y);
        assert!(off < 2.0 + 0.2, "{p:?} is {off} from the arc");
    }
}
