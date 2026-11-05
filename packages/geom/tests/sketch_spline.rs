// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! spline segments and loops in sketches: they flatten within the tolerance, so extrude and revolve take them
#![allow(clippy::many_single_char_names, reason = "loops and results in short tests")]

use serde_json::{Value, json};
use std::f64::consts::{PI, TAU};
use sx_geom::fm::Fm;
use sx_geom::json::call;

fn run(op: &str, req: &Value) -> Value {
    serde_json::from_str(&call(op, &req.to_string()).unwrap_or_else(|e| panic!("{op}: {e}"))).unwrap()
}

fn err(op: &str, req: &Value) -> String {
    call(op, &req.to_string()).unwrap_err().to_string()
}

fn on_circle(n: usize, r: f64, from: f64, to: f64) -> Vec<[f64; 2]> {
    (0..n)
        .map(|i| {
            #[allow(clippy::cast_precision_loss, reason = "small counts")]
            let a = from + (to - from) * i as f64 / n as f64;
            [r * a.m_cos(), r * a.m_sin()]
        })
        .collect()
}

fn extrude(loops: &Value, h: f64) -> Value {
    run(
        "shape.extrude",
        &json!({ "shape": { "type": "sketch", "loops": loops }, "spec": { "distanceMm": h } }),
    )
}

#[test]
fn a_spline_through_a_circle_extrudes_to_the_cylinder() {
    let loops = json!([{ "type": "spline", "points": on_circle(64, 20.0, 0.0, TAU) }]);
    let c = run("sketch.check", &json!({ "loops": loops }));
    assert_eq!(c["ok"], true, "{c}");
    let out = extrude(&loops, 10.0);
    assert_eq!(out["watertight"], true);
    assert_eq!(out["shells"], 1);
    let v = out["volumeMm3"].as_f64().unwrap();
    let want = PI * 400.0 * 10.0;
    assert!((v - want).abs() < 1e-3 * want, "{v} vs {want}");
}

#[test]
fn the_flattened_spline_is_within_the_tolerance_of_the_exact_one() {
    // a wavy star: the exact area of its bezier spans against the extruded mesh
    let pts: Vec<[f64; 2]> = (0..7)
        .map(|i| {
            let a = f64::from(i) * TAU / 7.0;
            let r = if i % 2 == 0 { 20.0 } else { 13.0 };
            [r * a.m_cos(), r * a.m_sin()]
        })
        .collect();
    let spans = sx_geom::sketch_spline::spans(&pts, true);
    let area = sx_geom::sketch_spline::area2(&spans).abs() / 2.0;
    let c = run(
        "sketch.check",
        &json!({ "loops": [{ "type": "spline", "points": pts }] }),
    );
    let length = c["loops"][0]["lengthMm"].as_f64().unwrap();
    let h = 5.0;
    let v = extrude(&json!([{ "type": "spline", "points": pts }]), h)["volumeMm3"]
        .as_f64()
        .unwrap();
    let tol = length * sx_geom::sketch_spline::TOL_MM * h;
    assert!((v - area * h).abs() <= tol, "{v} vs {} within {tol}", area * h);
}

#[test]
fn a_half_circle_spline_revolves_to_the_sphere() {
    // up the axis by a line, back down round a spline through the half circle
    let pts = on_circle(32, 20.0, -PI / 2.0, PI / 2.0);
    let loops = json!([{ "start": [0, 20], "segments": [
        { "type": "line", "to": [0, -20] },
        { "type": "spline", "points": &pts[1..], "to": [0, 20] },
    ]}]);
    let rev = run(
        "sketch.revolve",
        &json!({ "loops": loops, "axis": { "point": [0, 0], "direction": [0, 1] } }),
    );
    assert_eq!(rev["watertight"], true);
    let v = rev["volumeMm3"].as_f64().unwrap();
    let want = 4.0 / 3.0 * PI * 8000.0;
    assert!((v - want).abs() < 2e-3 * want, "{v} vs {want}");
}

#[test]
fn spline_problems_name_the_segment() {
    let twice = json!([{ "start": [0, 0], "segments": [
        { "type": "line", "to": [10, 0] },
        { "type": "spline", "points": [[12, 5], [12, 5]], "to": [0, 10] },
        { "type": "line", "to": [0, 0] },
    ]}]);
    let c = run("sketch.check", &json!({ "loops": twice }));
    assert_eq!(c["issues"][0]["kind"], "zeroLength", "{c}");
    assert_eq!(c["issues"][0]["segment"], 1);
    assert!(
        c["issues"][0]["message"]
            .as_str()
            .unwrap()
            .contains("spline segment 2"),
        "{c}"
    );
    let no_end = json!([{ "start": [0, 0], "segments": [{ "type": "spline", "points": [[5, 5]] }] }]);
    let c = run("sketch.check", &json!({ "loops": no_end }));
    assert!(
        c["issues"][0]["message"]
            .as_str()
            .unwrap()
            .contains("needs its end as to"),
        "{c}"
    );
    let eight = json!([{ "type": "spline", "points": [[0, 0], [10, 10], [20, 0], [10, -10], [0, 0.5], [-10, 10], [-20, 0], [-10, -10]] }]);
    let c = run("sketch.check", &json!({ "loops": eight }));
    assert_eq!(c["issues"][0]["kind"], "selfCrossing", "{c}");
    let two = json!([{ "type": "spline", "points": [[0, 0], [10, 0]] }]);
    let c = run("sketch.check", &json!({ "loops": two }));
    assert!(
        c["issues"][0]["message"]
            .as_str()
            .unwrap()
            .contains("3 or more points"),
        "{c}"
    );
}

#[test]
fn edits_keep_splines_as_points_or_say_why_not() {
    let blob = json!({ "type": "spline", "points": [[5, 0], [10, 4], [8, 9], [3, 6]] });
    let d = json!({ "start": [0, 0], "segments": [
        { "type": "line", "to": [-10, 0] },
        { "type": "spline", "points": [[-12, 6], [-6, 12]], "to": [0, 10] },
        { "type": "line", "to": [0, 0] },
    ]});
    let loops = json!([blob, d]);
    let m = run(
        "sketch.mirror",
        &json!({ "loops": loops, "pick": [0, 1], "axis": { "point": [20, 0], "direction": [0, 1] } }),
    );
    assert_eq!(m["loops"][2]["type"], "spline");
    assert_eq!(m["loops"][2]["points"][0], json!([35.0, 0.0]));
    assert_eq!(m["loops"][3]["segments"][1]["type"], "spline");
    assert_eq!(
        m["loops"][3]["segments"][1]["points"],
        json!([[52.0, 6.0], [46.0, 12.0]])
    );
    assert_eq!(m["loops"][3]["segments"][1]["to"], json!([40.0, 10.0]));
    let c = run("sketch.check", &json!({ "loops": m["loops"] }));
    assert_eq!(c["ok"], true, "{c}");
    let a = c["loops"][1]["areaMm2"].as_f64().unwrap();
    let b = c["loops"][3]["areaMm2"].as_f64().unwrap();
    assert!((a - b).abs() < 1e-6, "{a} {b}");
    let p = run(
        "sketch.pattern",
        &json!({ "loops": [blob], "pick": [0], "kind": "line", "count": 2, "step": [30, 0] }),
    );
    assert_eq!(p["loops"][1]["points"][1], json!([40.0, 4.0]));
    let e = err(
        "sketch.trim",
        &json!({ "loops": loops, "loop": 1, "segment": 0, "at": [-5, 0] }),
    );
    assert!(e.contains("doesn't work on sketches with splines yet"), "{e}");
    let e = err("sketch.intersect", &json!({ "loops": loops }));
    assert!(e.contains("splines"), "{e}");
    let e = err(
        "sketch.fillet",
        &json!({ "loops": [d], "corners": [{ "loop": 0, "vertex": 1 }], "radiusMm": 1 }),
    );
    assert!(e.contains("not between two straight lines"), "{e}");
    let e = err("sketch.curves", &json!({ "loops": [blob] }));
    assert!(e.contains("mesh path"), "{e}");
    // a corner between two lines of a loop with a spline still rounds
    let r = run(
        "sketch.fillet",
        &json!({ "loops": [d], "corners": [{ "loop": 0, "vertex": 0 }], "radiusMm": 1 }),
    );
    assert_eq!(r["loops"][0]["segments"][1]["type"], "spline", "{r}");
    assert_eq!(
        r["loops"][0]["segments"][1]["points"],
        json!([[-12.0, 6.0], [-6.0, 12.0]])
    );
}

#[test]
fn a_spline_segment_keeps_its_points_through_json() {
    let l = json!([{ "start": [0, 0], "segments": [
        { "type": "spline", "points": [[5, 3], [10, 0]], "to": [15, 5] },
        { "type": "line", "to": [0, 0] },
    ]}]);
    let loops: Vec<sx_geom::sketch::Loop> = serde_json::from_value(l.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(&loops).unwrap(),
        json!([{ "start": [0.0, 0.0], "segments": [
            { "type": "spline", "to": [15.0, 5.0], "points": [[5.0, 3.0], [10.0, 0.0]] },
            { "type": "line", "to": [0.0, 0.0] },
        ]}])
    );
}

fn first_issue(loops: &Value) -> (String, String) {
    let c = run("sketch.check", &json!({ "loops": loops }));
    let i = &c["issues"][0];
    (
        i["kind"].as_str().unwrap_or("").to_string(),
        i["message"].as_str().unwrap_or("").to_string(),
    )
}

#[test]
fn too_many_points_or_too_sharp_a_bend_is_refused() {
    // a span that would need more than the most steps one span may take
    let sharp = json!([{ "start": [0, 0], "segments": [
        { "type": "spline", "points": [[90_000, 0]], "to": [90_000, 10] },
        { "type": "line", "to": [0, 0] },
    ]}]);
    let (kind, message) = first_issue(&sharp);
    assert_eq!(kind, "tooDense", "{message}");
    assert!(
        message.contains("bends too sharply") && message.contains("0.005 mm"),
        "{message}"
    );
    // a closed zigzag fine enough to pass span by span, but with too many points for one loop
    let zig = |rows: usize, amp: f64, y0: f64| -> Vec<[f64; 2]> {
        (0..rows)
            .map(|i| {
                #[allow(clippy::cast_precision_loss, reason = "small counts")]
                let x = i as f64 * 2.0;
                [x, y0 + if i % 2 == 0 { amp } else { -amp }]
            })
            .collect()
    };
    let flat = |p: &[[f64; 2]]| sx_geom::sketch_spline::flatten_all(p, true, usize::MAX).map(|f| f.len());
    let big = zig(4000, 200.0, 0.0);
    let n = flat(&big).expect("every span within the step limit");
    assert!(n > sx_geom::sketch::RING_POINTS, "{n}");
    let (kind, message) = first_issue(&json!([{ "type": "spline", "points": big }]));
    assert_eq!(kind, "tooDense", "{message}");
    assert!(message.contains("65536 points"), "{message}");
    // loops each under the loop limit, together over the sketch limit
    let mut rows = 4000;
    while flat(&zig(rows, 200.0, 0.0)).unwrap() > sx_geom::sketch::RING_POINTS {
        rows -= 250;
    }
    let loops: Vec<Value> = (0..6)
        .map(|k| json!({ "type": "spline", "points": zig(rows, 200.0, f64::from(k) * 1000.0) }))
        .collect();
    let c = run("sketch.check", &json!({ "loops": loops }));
    let dense: Vec<&Value> = c["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "tooDense")
        .collect();
    assert_eq!(dense.len(), 1, "{}", c["issues"]);
    assert!(
        dense[0]["message"].as_str().unwrap().contains("262144 points"),
        "{}",
        dense[0]
    );
}

#[test]
fn degenerate_points_are_named_or_draw_cleanly() {
    let named = |loops: Value, want: &str| {
        let (kind, message) = first_issue(&loops);
        assert_eq!(kind, "zeroLength", "{message}");
        assert!(message.contains(want), "{message}");
    };
    // the closed loop's last point on its first
    named(
        json!([{ "type": "spline", "points": [[0, 0], [10, 0], [5, 8], [0, 0]] }]),
        "same point twice",
    );
    // a segment's first point on its start, and its last on its end
    named(
        json!([{ "start": [0, 0], "segments": [
            { "type": "spline", "points": [[0, 0], [5, 5]], "to": [10, 0] }, { "type": "line", "to": [0, 0] }]}]),
        "spline segment 1",
    );
    named(
        json!([{ "start": [0, 0], "segments": [
            { "type": "spline", "points": [[5, 5], [10, 0]], "to": [10, 0] }, { "type": "line", "to": [0, 0] }]}]),
        "spline segment 1",
    );
    // past the size limit
    let (_, message) = first_issue(&json!([{ "type": "spline", "points": [[0, 0], [200_000, 0], [5, 8]] }]));
    assert!(message.contains("not a number"), "{message}");
    // an empty segment
    let (_, message) = first_issue(&json!([{ "start": [0, 0], "segments": [
        { "type": "spline", "points": [], "to": [10, 0] }, { "type": "line", "to": [0, 0] }]}]));
    assert!(message.contains("1 or more points"), "{message}");
    // three points, a hairpin and a straight run all draw finite and closed
    for loops in [
        json!([{ "type": "spline", "points": [[0, 0], [10, 0], [5, 8]] }]),
        json!([{ "start": [0, 0], "segments": [
            { "type": "spline", "points": [[20, 0], [20, 3]], "to": [0, 3] }, { "type": "line", "to": [0, 0] }]}]),
        json!([{ "type": "spline", "points": [[0, 0], [5, 0], [10, 0], [10, 6], [0, 6]] }]),
    ] {
        let c = run("sketch.check", &json!({ "loops": loops }));
        assert_eq!(c["ok"], true, "{c}");
        let out = extrude(&loops, 2.0);
        assert_eq!(out["watertight"], true, "{out}");
        assert!(out["volumeMm3"].as_f64().unwrap().is_finite());
    }
}

#[test]
fn every_edit_near_a_spline_keeps_it_or_refuses() {
    let d = json!({ "start": [0, 0], "segments": [
        { "type": "line", "to": [-10, 0] },
        { "type": "spline", "points": [[-12, 6], [-6, 12]], "to": [0, 10] },
        { "type": "line", "to": [0, 0] },
    ]});
    let open = json!({ "start": [30, 0], "segments": [
        { "type": "line", "to": [40, 0] },
        { "type": "spline", "points": [[45, 5]], "to": [50, 0] },
    ]});
    // a chain with a spline segment goes on the mesh path, as a closed spline loop does
    let e = err("sketch.curves", &json!({ "loops": [d] }));
    assert!(e.contains("mesh path"), "{e}");
    let e = err(
        "sketch.extend",
        &json!({ "loops": [open], "loop": 0, "end": "end" }),
    );
    assert!(e.contains("splines"), "{e}");
    for (v, op, extra) in [
        (1, "sketch.fillet", json!({ "radiusMm": 1 })),
        (2, "sketch.fillet", json!({ "radiusMm": 1 })),
        (1, "sketch.chamfer", json!({ "distanceMm": 1 })),
        (2, "sketch.chamfer", json!({ "distanceMm": 1 })),
    ] {
        let mut req = json!({ "loops": [d], "corners": [{ "loop": 0, "vertex": v }] });
        req.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let e = err(op, &req);
        assert!(e.contains("not between two straight lines"), "{op} {v}: {e}");
    }
    let blob = json!({ "type": "spline", "points": [[5, 0], [10, 4], [8, 9], [3, 6]] });
    let e = err(
        "sketch.fillet",
        &json!({ "loops": [blob], "corners": [{ "loop": 0, "vertex": 0 }], "radiusMm": 1 }),
    );
    assert!(e.contains("smooth spline and has no corners"), "{e}");
    // mirror keeps every point, in order, and the area
    let m = run(
        "sketch.mirror",
        &json!({ "loops": [blob], "pick": [0], "axis": { "point": [20, 0], "direction": [0, 1] } }),
    );
    assert_eq!(
        m["loops"][1]["points"],
        json!([[35.0, 0.0], [30.0, 4.0], [32.0, 9.0], [37.0, 6.0]])
    );
    let c = run("sketch.check", &json!({ "loops": m["loops"] }));
    let (a, b) = (
        c["loops"][0]["areaMm2"].as_f64().unwrap(),
        c["loops"][1]["areaMm2"].as_f64().unwrap(),
    );
    assert!((a - b).abs() < 1e-6, "{a} {b}");
    // a quarter turn round the origin moves every point of a loop and of a chain's spline
    let p = run(
        "sketch.pattern",
        &json!({ "loops": [blob, d], "pick": [0, 1], "kind": "circle", "count": 2, "center": [0, 0], "angleDeg": 180 }),
    );
    let close = |v: &Value, want: &[[f64; 2]]| {
        let got: Vec<[f64; 2]> = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(got.len(), want.len(), "{v}");
        for (g, w) in got.iter().zip(want) {
            assert!((g[0] - w[0]).abs() < 1e-9 && (g[1] - w[1]).abs() < 1e-9, "{v}");
        }
    };
    close(
        &p["loops"][2]["points"],
        &[[-5.0, 0.0], [-10.0, -4.0], [-8.0, -9.0], [-3.0, -6.0]],
    );
    assert_eq!(p["loops"][3]["segments"][1]["type"], "spline");
    close(
        &p["loops"][3]["segments"][1]["points"],
        &[[12.0, -6.0], [6.0, -12.0]],
    );
    close(&json!([p["loops"][3]["segments"][1]["to"]]), &[[0.0, -10.0]]);
}
