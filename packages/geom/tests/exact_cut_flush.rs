// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cuts whose start face lies on a body's surface, on exact solids: rows of round cuts flush on a long lofted body's
// flat sides, on a lofted side that bulges out and meets the plane along a line, on a box side and on a cylinder side
// the plane is tangent to, each beside the same cut started a hair outside; and a pocket cut from a plane inside a
// box, which stays as asked. Skipped in a build without the kernel, and empty without the brep feature.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::f64::consts::PI;

fn run(op: &str, req: &Value) -> Result<Value, String> {
    let reply = sx_geom::json::call(op, &req.to_string()).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&reply).expect("reply is JSON"))
}

fn free(body: &Value) {
    run("brep.free", &json!({ "body": body })).expect("freed");
}

const DEPTH: f64 = 0.8;
const DIAMETER: f64 = 1.2;

/// One round cut's floor.
fn disk() -> f64 {
    PI * DIAMETER * DIAMETER / 4.0
}

/// `n` circles in a row along u, `pitch` apart, centered on the frame's origin.
fn row(n: u32, pitch: f64) -> Vec<Value> {
    (0..n)
        .map(|i| {
            let x = f64::from(i) * pitch - f64::from(n - 1) * pitch / 2.0;
            json!({ "outer": { "center": [x, 0], "diameterMm": DIAMETER }, "holes": [] })
        })
        .collect()
}

/// What a cut made: its faces and the volume it took from the body.
#[derive(Debug)]
struct Made {
    faces: u64,
    removed: f64,
}

/// A body's volume and faces.
fn info(body: &Value) -> (f64, u64) {
    let i = run("brep.info", &json!({ "body": body })).expect("info");
    assert_eq!(i["manifold"], true, "{i}");
    (i["volumeMm3"].as_f64().unwrap(), i["faces"].as_u64().unwrap())
}

/// A cut `DEPTH` deep into `body` from a plane through `at` facing `normal`, moved `gap` out along it (a negative
/// gap starts in the body). `flip` asks it as a flipped cut: the frame faces into the body and the cut runs along it.
fn cut(
    body: &Value,
    at: [f64; 3],
    normal: [f64; 3],
    gap: f64,
    polygons: &[Value],
    flip: bool,
) -> Result<Made, String> {
    let origin: Vec<f64> = (0..3).map(|k| at[k] + normal[k] * gap).collect();
    let (n, from, to) = if flip {
        (normal.map(|c| -c), 0.0, DEPTH)
    } else {
        (normal, -DEPTH, 0.0)
    };
    let r = run(
        "brep.extrude",
        &json!({ "frame": { "origin": origin, "u": [1, 0, 0], "normal": n }, "polygons": polygons, "fromMm": from, "toMm": to, "target": body, "operation": "cut" }),
    )?;
    assert_eq!(r["touches"], true, "{r}");
    let (before, _) = info(body);
    let (after, faces) = info(&r["body"]);
    free(&r["body"]);
    Ok(Made {
        faces,
        removed: before - after,
    })
}

/// A flush or near-flush cut beside the same cut from `gap` mm outside: the same faces, the solid closed, and the
/// volume the gap left plus the slab between, within `slack` mm3.
fn like_the_gap_cut(what: &str, made: &Result<Made, String>, gap_cut: &Made, slab: f64, slack: f64) {
    let made = made.as_ref().unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(made.faces, gap_cut.faces, "{what}: {made:?} beside {gap_cut:?}");
    let want = gap_cut.removed + slab;
    assert!(
        (made.removed - want).abs() <= slack,
        "{what}: removed {} mm3, want {want}",
        made.removed
    );
}

/// A loft section at `x` across y and z: a flat floor, sloped sides, and upright sides split in two faces at z 9.5.
fn section(x: f64, w: f64, floor: f64, top: f64) -> Value {
    json!({
        "frame": { "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
        "loops": [{ "points": [[-w * 0.6, floor], [w * 0.6, floor], [w, floor + 4.0], [w, 9.5], [w, top], [-w, top], [-w, 9.5], [-w, floor + 4.0]] }],
    })
}

fn loft(sections: &[Value]) -> Value {
    run(
        "sketch.loft",
        &json!({ "profiles": sections, "smooth": true, "operation": "new", "exact": true, "withKeys": true }),
    )
    .expect("loft")["body"]
        .clone()
}

const GAP: f64 = 1e-4;
/// how near a curved body's volume reads back, as a share of it: what one cut takes is read to that, not finer
const READ: f64 = 1e-7;

#[test]
fn rows_of_round_cuts_flush_on_a_long_lofted_body_s_sides_stay_exact() {
    if !sx_brep::KERNEL {
        return;
    }
    // nine sections, the middle three as wide as each other, so each side is flat from x 60 to 130
    let body = loft(&[
        section(0.0, 2.0, 5.0, 14.0),
        section(10.0, 6.0, 3.0, 14.0),
        section(30.0, 9.0, 1.0, 13.5),
        section(60.0, 11.0, 0.0, 13.0),
        section(95.0, 11.0, 0.0, 13.0),
        section(130.0, 11.0, 0.0, 13.0),
        section(160.0, 9.0, 1.0, 13.5),
        section(180.0, 5.0, 4.0, 14.5),
        section(190.0, 2.0, 5.0, 15.0),
    ]);
    let (volume, _) = info(&body);
    for n in [12, 24] {
        let polygons = row(n, 3.0);
        // across the split between a side's two faces, and wholly above it
        for (side, at) in [
            ("one side", [95.0_f64, 11.0, 9.0]),
            ("the other side", [95.0, -11.0, 9.0]),
            ("one side above the split", [95.0, 11.0, 11.5]),
        ] {
            let normal = [0.0, at[1].signum(), 0.0];
            let gap_cut = cut(&body, at, normal, GAP, &polygons, false).expect("the cut from just outside");
            let what = format!("{n} round cuts flush on {side}");
            like_the_gap_cut(
                &what,
                &cut(&body, at, normal, 0.0, &polygons, false),
                &gap_cut,
                f64::from(n) * disk() * GAP,
                READ * volume,
            );
        }
    }
    free(&body);
}

#[test]
fn round_cuts_on_a_bulging_lofted_side_that_meets_the_plane_along_a_line_stay_exact() {
    if !sx_brep::KERNEL {
        return;
    }
    // the side bulges out along the body, widest at x 60, where the plane y 11 meets it along an upright line
    let body = loft(&[
        section(0.0, 9.0, 0.0, 13.0),
        section(30.0, 10.5, 0.0, 13.0),
        section(60.0, 11.0, 0.0, 13.0),
        section(90.0, 10.5, 0.0, 13.0),
        section(120.0, 9.0, 0.0, 13.0),
    ]);
    let (volume, _) = info(&body);
    let (at, normal) = ([60.0, 11.0, 11.5], [0.0, 1.0, 0.0]);
    for n in [1, 12] {
        let polygons = row(n, 1.5);
        let gap_cut = cut(&body, at, normal, GAP, &polygons, false).expect("the cut from just outside");
        // on the line, and a hair in the body there, so part of the start face is in the body and part out of it
        for gap in [0.0, -GAP] {
            let what = format!("{n} round cuts on the touching line, {gap} mm out");
            like_the_gap_cut(
                &what,
                &cut(&body, at, normal, gap, &polygons, false),
                &gap_cut,
                f64::from(n) * disk() * (GAP - gap),
                READ * volume,
            );
        }
    }
    free(&body);
}

#[test]
fn round_cuts_flush_on_a_box_side_take_their_depth_and_no_skin() {
    if !sx_brep::KERNEL {
        return;
    }
    let body =
        run("brep.box", &json!({ "min": [0, 0, 0], "max": [40, 20, 10] })).expect("box")["body"].clone();
    let (at, normal) = ([20.0, 20.0, 5.0], [0.0, 1.0, 0.0]);
    for n in [1, 24] {
        let polygons = row(n, 1.5);
        let gap_cut = cut(&body, at, normal, GAP, &polygons, false).expect("the cut from just outside");
        let floor = f64::from(n) * disk();
        assert!(
            (gap_cut.removed - floor * (DEPTH - GAP)).abs() < 1e-5 * floor,
            "{gap_cut:?}"
        );
        // flush, and started a hair in the side: the cut takes its depth from the side, leaving no skin of faces
        for (gap, flip) in [(0.0, false), (0.0, true), (-GAP, false), (-GAP, true)] {
            let what = format!(
                "{n} round cuts on a box side, {gap} mm out{}",
                if flip { ", flipped" } else { "" }
            );
            like_the_gap_cut(
                &what,
                &cut(&body, at, normal, gap, &polygons, flip),
                &gap_cut,
                floor * (GAP - gap),
                1e-5 * floor,
            );
        }
        // from well outside the cut is as asked
        let clear = cut(&body, at, normal, 0.75, &polygons, false).expect("the cut from outside");
        assert!(
            (clear.removed - floor * (DEPTH - 0.75)).abs() < 1e-4 * floor,
            "{clear:?}"
        );
    }
    free(&body);
}

#[test]
fn a_round_cut_whose_start_plane_is_tangent_to_a_cylinder_side_stays_exact() {
    if !sx_brep::KERNEL {
        return;
    }
    let body = run(
        "brep.cylinder",
        &json!({ "origin": [0, 0, 0], "axis": [0, 0, 1], "diameterMm": 20, "heightMm": 20 }),
    )
    .expect("cylinder")["body"]
        .clone();
    let (volume, _) = info(&body);
    let (at, normal) = ([0.0, 10.0, 10.0], [0.0, 1.0, 0.0]);
    for n in [1, 4] {
        let polygons = row(n, 1.5);
        let gap_cut = cut(&body, at, normal, GAP, &polygons, false).expect("the cut from just outside");
        for gap in [0.0, -GAP] {
            let what = format!("{n} round cuts tangent to a cylinder side, {gap} mm out");
            like_the_gap_cut(
                &what,
                &cut(&body, at, normal, gap, &polygons, false),
                &gap_cut,
                f64::from(n) * disk() * (GAP - gap),
                READ * volume,
            );
        }
    }
    free(&body);
}

#[test]
fn a_pocket_cut_from_a_plane_inside_a_box_starts_where_it_was_asked() {
    if !sx_brep::KERNEL {
        return;
    }
    let body =
        run("brep.box", &json!({ "min": [0, 0, 0], "max": [40, 20, 10] })).expect("box")["body"].clone();
    for n in [1, 24] {
        let made = cut(
            &body,
            [20.0, 10.0, 5.0],
            [0.0, 0.0, 1.0],
            0.0,
            &row(n, 1.5),
            false,
        )
        .expect("the pocket");
        let want = f64::from(n) * disk() * DEPTH;
        assert!(
            (made.removed - want).abs() < 1e-5 * want,
            "{n} round pockets: removed {} mm3, want {want}",
            made.removed
        );
    }
    free(&body);
}
