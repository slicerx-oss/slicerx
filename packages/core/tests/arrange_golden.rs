// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The arrange's golden file, `packages/settings/fixtures/arrange-golden.json`: a set of plates (their meshes, the
//! printer's settings and what the arrange is asked for) and the layout `api::arrange_request` gives each, the call
//! `sx arrange --request`, the MCP server's `slicerx_arrange_file` and the desktop app's Arrange all make. The app's
//! tests read the same file (packages/app/test/arrange-golden.test.ts), so the app lands on these layouts too, on the
//! engine's path and on its own geometry worker's. `SX_BLESS=1 cargo test -p sx-core --test arrange_golden` writes it.
#![allow(clippy::disallowed_methods, reason = "test geometry, not engine output")]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "small test shapes in mm"
)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use sx_core::api::{self, Mesh, MeshPart, SliceRequest};

/// A mesh's corners and triangles.
type Shell = (Vec<[f32; 3]>, Vec<[u32; 3]>);
/// An object of a case: its id, name, mesh, filament slot, turn about Z (degrees) and place (mm).
type Object = (String, String, &'static str, u8, f64, [f64; 2]);

fn golden_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../settings/fixtures/arrange-golden.json")
}

/// A closed prism: the counterclockwise `outline` swept up by `height`, its caps the triangles `cap` of the outline.
fn prism(outline: &[[f32; 2]], cap: &[[u32; 3]], height: f32) -> Shell {
    let n = outline.len() as u32;
    let mut positions: Vec<[f32; 3]> = outline.iter().map(|p| [p[0], p[1], 0.0]).collect();
    positions.extend(outline.iter().map(|p| [p[0], p[1], height]));
    let mut tris = Vec::new();
    for t in cap {
        tris.push([t[0], t[2], t[1]]);
        tris.push([t[0] + n, t[1] + n, t[2] + n]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tris.push([i, j, j + n]);
        tris.push([i, j + n, i + n]);
    }
    (positions, tris)
}

fn cuboid(w: f32, d: f32, h: f32) -> Shell {
    prism(
        &[[0.0, 0.0], [w, 0.0], [w, d], [0.0, d]],
        &[[0, 1, 2], [0, 2, 3]],
        h,
    )
}

/// An L: a 40 by 10 mm bar with a 10 by 20 mm arm up its left end, `h` tall.
fn ell(h: f32) -> Shell {
    prism(
        &[
            [0.0, 0.0],
            [40.0, 0.0],
            [40.0, 10.0],
            [10.0, 10.0],
            [10.0, 30.0],
            [0.0, 30.0],
        ],
        &[[0, 1, 2], [0, 2, 3], [0, 3, 5], [3, 4, 5]],
        h,
    )
}

/// A transform turning by `deg` about Z and moving to `at` (mm, machine coordinates), column-major.
fn placed(deg: f64, at: [f64; 2]) -> Vec<f64> {
    let (s, c) = deg.to_radians().sin_cos();
    let r = |v: f64| (v * 1e6).round() / 1e6;
    vec![
        r(c),
        r(s),
        0.0,
        0.0,
        r(-s),
        r(c),
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        at[0],
        at[1],
        0.0,
        1.0,
    ]
}

/// The A1's settings from the request fixtures (its 256 mm bed, the nozzle wrap check corner at x 226 to 256, y 224 to
/// 256), with no prime tower, and `extra` on top.
fn a1(extra: &Value) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("cli/tests/fixtures/xmark-2color-a1-request.json");
    let req: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut c = req["config"].clone();
    c["enable_prime_tower"] = json!(false);
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

struct Case {
    name: &'static str,
    /// The plate's bed, when not the A1's.
    bed: Option<Value>,
    config: Value,
    arrange: Value,
    objects: Vec<Object>,
}

fn copies(
    prefix: &str,
    label: &str,
    mesh: &'static str,
    n: usize,
    slot: u8,
    turn: f64,
    from: [f64; 2],
) -> Vec<Object> {
    (0..n)
        .map(|k| {
            let f = k as f64;
            (
                format!("{prefix}{}", k + 1),
                format!("{label} {}", k + 1),
                mesh,
                slot,
                turn,
                [from[0] + 3.0 * f, from[1] + 2.0 * f],
            )
        })
        .collect()
}

#[allow(clippy::too_many_lines, reason = "the cases spelled out in full")]
fn cases() -> Vec<Case> {
    let by_object = json!({"print_sequence": "by object"});
    vec![
        Case {
            bed: None,
            name: "by layer on an A1: mixed parts, turned as imported, clear of the wrap check corner",
            config: a1(&json!({})),
            arrange: json!({}),
            objects: [
                copies("bar", "Bar", "box40x20x10", 4, 1, 0.0, [100.0, 100.0]),
                copies("ell", "Ell", "ell8", 3, 1, 30.0, [110.0, 90.0]),
                copies("block", "Block", "box25x25x30", 3, 1, 0.0, [90.0, 120.0]),
            ]
            .concat(),
        },
        Case {
            bed: None,
            name: "by object on an A1: three parts the extruder clearance apart",
            config: a1(&by_object),
            arrange: json!({}),
            objects: copies("part", "Part", "box30x30x15", 3, 1, 0.0, [100.0, 100.0]),
        },
        Case {
            bed: None,
            name: "by object on an A1: parts taller than the gantry rod in lanes of their own",
            config: a1(&by_object),
            arrange: json!({}),
            objects: [
                copies("tower", "Tower", "box20x20x40", 2, 1, 0.0, [100.0, 100.0]),
                copies("low", "Low", "box20x20x10", 3, 1, 0.0, [120.0, 90.0]),
            ]
            .concat(),
        },
        Case {
            bed: None,
            name: "by layer: more parts than the bed holds, and one larger than the bed",
            config: a1(&json!({})),
            arrange: json!({}),
            objects: [
                copies("tile", "Tile", "box50x50x5", 26, 1, 0.0, [60.0, 60.0]),
                vec![(
                    "plank".to_owned(),
                    "Plank".to_owned(),
                    "box300x40x5",
                    1,
                    0.0,
                    [0.0, 100.0],
                )],
            ]
            .concat(),
        },
        Case {
            bed: None,
            name: "by layer in two filaments: room kept for the prime tower",
            config: a1(
                &json!({"enable_prime_tower": true, "prime_tower_width": 35, "wipe_tower_x": 165, "wipe_tower_y": 215}),
            ),
            arrange: json!({}),
            objects: [
                copies("red", "Red", "box40x20x10", 3, 1, 0.0, [100.0, 100.0]),
                copies("blue", "Blue", "box40x20x10", 3, 2, 0.0, [110.0, 110.0]),
            ]
            .concat(),
        },
        Case {
            bed: None,
            name: "the parts asked to stay keep their place, the others are packed round them, square, at a quick search",
            config: a1(&json!({})),
            arrange: json!({"keep": ["stay1", "stay2"], "rotate": false, "spacingMm": 4, "effort": "quick"}),
            objects: [
                vec![
                    (
                        "stay1".to_owned(),
                        "Stay 1".to_owned(),
                        "box40x20x10",
                        1,
                        0.0,
                        [108.0, 118.0],
                    ),
                    (
                        "stay2".to_owned(),
                        "Stay 2".to_owned(),
                        "ell8",
                        1,
                        90.0,
                        [60.0, 40.0],
                    ),
                ],
                copies("move", "Move", "box25x25x30", 6, 1, 15.0, [100.0, 100.0]),
            ]
            .concat(),
        },
        Case {
            bed: None,
            name: "by layer, turned in 45 degree steps with a thorough search",
            config: a1(&json!({})),
            arrange: json!({"stepDeg": 45, "effort": "thorough"}),
            objects: copies("ell", "Ell", "ell8", 8, 1, 20.0, [100.0, 100.0]),
        },
        Case {
            name: "a delta's round bed centered on 0, 0: turned parts stay on it",
            bed: Some(json!({ "widthMm": 300, "depthMm": 300, "heightMm": 410, "round": true })),
            config: delta(&json!({})),
            arrange: json!({}),
            objects: [
                copies("ell", "Ell", "ell8", 6, 1, 30.0, [-20.0, -20.0]),
                copies("bar", "Bar", "box40x20x10", 4, 1, 60.0, [10.0, -10.0]),
            ]
            .concat(),
        },
    ]
}

/// A delta's round bed, 150 mm across its radius and centered on 0, 0, as a 64 point outline.
fn delta(extra: &Value) -> Value {
    let area: Vec<[f64; 2]> = (0..64)
        .map(|k| {
            let a = f64::from(k) * std::f64::consts::TAU / 64.0;
            [
                (150.0 * a.cos() * 1000.0).round() / 1000.0,
                (150.0 * a.sin() * 1000.0).round() / 1000.0,
            ]
        })
        .collect();
    let mut c = a1(&json!({}));
    for (k, v) in [
        ("printable_area", json!(area)),
        ("printer_model", json!("FLSun V400")),
        ("head_wrap_detect_zone", json!([])),
        ("bed_exclude_area", json!([])),
    ] {
        c[k] = v;
    }
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

fn meshes() -> BTreeMap<&'static str, Shell> {
    BTreeMap::from([
        ("box40x20x10", cuboid(40.0, 20.0, 10.0)),
        ("box25x25x30", cuboid(25.0, 25.0, 30.0)),
        ("box30x30x15", cuboid(30.0, 30.0, 15.0)),
        ("box20x20x40", cuboid(20.0, 20.0, 40.0)),
        ("box20x20x10", cuboid(20.0, 20.0, 10.0)),
        ("box50x50x5", cuboid(50.0, 50.0, 5.0)),
        ("box300x40x5", cuboid(300.0, 40.0, 5.0)),
        ("ell8", ell(8.0)),
    ])
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// The layout as the file keeps it: the report without the plate check, which is the check's own golden's, but with
/// how many strikes it is sure of; numbers to a thousandth.
fn kept(layout: &Value) -> Value {
    let mut out = layout.clone();
    if let Some(check) = out.as_object_mut().and_then(|o| o.remove("check")) {
        let sure = check["collisions"]
            .as_array()
            .zip(check["certainty"].as_array())
            .map_or(0, |(c, s)| {
                c.iter()
                    .zip(s)
                    .filter(|(c, s)| c["severity"] == "hit" && *s == "sure")
                    .count()
            });
        out["sureStrikes"] = json!(sure);
    }
    let round_all = |objects: &mut Value| {
        for o in objects.as_array_mut().into_iter().flatten() {
            if let Some(t) = o["transform"].as_array_mut() {
                for v in t.iter_mut() {
                    *v = json!(round3(v.as_f64().unwrap_or(0.0)));
                }
            }
        }
    };
    round_all(&mut out["objects"]);
    // Each new plate as the plate itself: its objects to a thousandth, without its check.
    for p in out["plates"].as_array_mut().into_iter().flatten() {
        if let Some(o) = p.as_object_mut() {
            o.remove("check");
        }
        round_all(&mut p["objects"]);
    }
    out
}

fn golden() -> Value {
    let meshes = meshes();
    let mesh_json: serde_json::Map<String, Value> = meshes
        .iter()
        .map(|(k, (p, t))| {
            (
                (*k).to_owned(),
                json!({ "positions": p.iter().flatten().collect::<Vec<_>>(), "indices": t.iter().flatten().collect::<Vec<_>>() }),
            )
        })
        .collect();
    let held: BTreeMap<&str, Arc<Mesh>> = meshes
        .iter()
        .map(|(k, (p, t))| {
            (
                *k,
                Arc::new(Mesh {
                    name: (*k).to_owned(),
                    parts: vec![MeshPart {
                        name: (*k).to_owned(),
                        slot: 1,
                        positions: p.clone(),
                        triangles: t.clone(),
                        ..MeshPart::default()
                    }],
                    ..Mesh::default()
                }),
            )
        })
        .collect();
    let cases: Vec<Value> = cases()
        .into_iter()
        .map(|c| {
            let objects: Vec<Value> = c
                .objects
                .iter()
                .map(|(id, name, mesh, slot, turn, at)| {
                    let mut o = json!({ "id": id, "name": name, "mesh": mesh, "transform": placed(*turn, *at) });
                    if *slot != 1 {
                        o["slotOverrides"] = json!({ (*mesh).to_owned(): slot });
                    }
                    o
                })
                .collect();
            // As the app asks: the objects with no room laid out on new plates in the same call.
            let mut arrange = c.arrange.clone();
            arrange["newPlates"] = json!(true);
            let req = json!({
                "plate": { "bed": c.bed.clone().unwrap_or_else(|| json!({ "widthMm": 256, "depthMm": 256, "heightMm": 256 })), "placement": "arrange", "arrange": arrange, "objects": objects },
                "config": c.config,
            });
            let mut r: SliceRequest = serde_json::from_value(req.clone()).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            let layout = api::arrange_request(&mut r, &|id: &str| {
                held.get(id).cloned().ok_or_else(|| sx_core::Error::Config { key: "plate.objects.mesh", reason: id.to_owned() })
            })
            .unwrap_or_else(|e| panic!("{}: {e}", c.name));
            // Every placed object lies on the printable area where its new transform puts it: inside the area's box,
            // and on a round bed inside its circle.
            let area: Vec<[f64; 2]> = serde_json::from_value(c.config["printable_area"].clone()).unwrap();
            let (x0, y0) = (area.iter().map(|p| p[0]).fold(f64::MAX, f64::min), area.iter().map(|p| p[1]).fold(f64::MAX, f64::min));
            let (x1, y1) = (area.iter().map(|p| p[0]).fold(f64::MIN, f64::max), area.iter().map(|p| p[1]).fold(f64::MIN, f64::max));
            let round = req["plate"]["bed"]["round"] == json!(true);
            for o in &layout.objects {
                let mesh = &c.objects.iter().find(|x| x.0 == o.id).unwrap().2;
                let t = &o.transform;
                for p in &meshes[mesh].0 {
                    let (x, y) = (
                        f64::from(t[0] * p[0] + t[4] * p[1] + t[8] * p[2] + t[12]),
                        f64::from(t[1] * p[0] + t[5] * p[1] + t[9] * p[2] + t[13]),
                    );
                    let inside = if round { x.hypot(y) <= (x1 - x0) / 2.0 + 1e-3 } else { x >= x0 - 1e-3 && x <= x1 + 1e-3 && y >= y0 - 1e-3 && y <= y1 + 1e-3 };
                    assert!(inside, "{}: {} reaches {x:.2}, {y:.2}, off the printable area", c.name, o.id);
                }
            }
            json!({ "name": c.name, "request": req, "layout": kept(&serde_json::to_value(&layout).unwrap()) })
        })
        .collect();
    json!({
        "comment": "Written by packages/core/tests/arrange_golden.rs (SX_BLESS=1 cargo test -p sx-core --test arrange_golden); read by packages/app/test/arrange-golden.test.ts. Each case is a request with plate.placement arrange, its meshes under meshes by id, and the layout the engine's arrange gives it (sx arrange --request, the desktop app's Arrange, the MCP server's slicerx_arrange_file), without the plate check but with how many strikes it is sure of. Machine coordinates, mm; transforms column-major.",
        "meshes": mesh_json,
        "cases": cases,
    })
}

#[test]
fn the_golden_file_holds_the_arrange_layouts() {
    let text = serde_json::to_string_pretty(&golden()).unwrap_or_default() + "\n";
    let path = golden_path();
    if std::env::var_os("SX_BLESS").is_some() {
        std::fs::write(&path, &text).unwrap_or_else(|e| panic!("writing {}: {e}", path.display()));
    }
    let saved = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        saved == text,
        "{} is out of date: run SX_BLESS=1 cargo test -p sx-core --test arrange_golden",
        path.display()
    );
}

/// `arrange_request_with` hands over the plate's first layout once, before the plate check runs on it, so a host can
/// show it at once: by layer it is the layout itself; by object, the one the check may still widen.
#[test]
fn the_first_layout_comes_before_the_check() {
    let meshes = meshes();
    let held: BTreeMap<&str, Arc<Mesh>> = meshes
        .iter()
        .map(|(k, (p, t))| {
            (
                *k,
                Arc::new(Mesh {
                    name: (*k).to_owned(),
                    parts: vec![MeshPart {
                        name: (*k).to_owned(),
                        slot: 1,
                        positions: p.clone(),
                        triangles: t.clone(),
                        ..MeshPart::default()
                    }],
                    ..Mesh::default()
                }),
            )
        })
        .collect();
    let get = |id: &str| {
        held.get(id).cloned().ok_or_else(|| sx_core::Error::Config {
            key: "plate.objects.mesh",
            reason: id.to_owned(),
        })
    };
    for c in cases() {
        let objects: Vec<Value> = c
            .objects
            .iter()
            .map(|(id, name, mesh, _, turn, at)| json!({ "id": id, "name": name, "mesh": mesh, "transform": placed(*turn, *at) }))
            .collect();
        let req = json!({
            "plate": { "bed": c.bed.clone().unwrap_or_else(|| json!({ "widthMm": 256, "depthMm": 256, "heightMm": 256 })), "placement": "arrange", "arrange": c.arrange, "objects": objects },
            "config": c.config,
        });
        let mut r: SliceRequest = serde_json::from_value(req).unwrap();
        let mut first = Vec::new();
        let last = api::arrange_request_with(&mut r, &get, &mut |a| {
            first.push(serde_json::to_value(a).unwrap());
        })
        .unwrap();
        assert_eq!(first.len(), 1, "{}: the first layout comes once", c.name);
        assert!(
            first[0].get("check").is_none(),
            "{}: the first layout comes before the check",
            c.name
        );
        if !last.by_object {
            assert_eq!(
                first[0]["objects"],
                serde_json::to_value(&last.objects).unwrap(),
                "{}: by layer the first layout is the layout",
                c.name
            );
        }
    }
}
