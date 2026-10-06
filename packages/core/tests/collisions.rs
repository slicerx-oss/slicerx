// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! heimdall's collision check through whole requests: each kind of collision on a plate built for it, the fixes
//! it offers, shards, and no strike on plates the makers' own rules accept, for every shipped printer.

use serde_json::{Value, json};
use std::sync::Arc;
mod common;

use sx_core::api::{self, Mesh, MeshPart, SliceRequest, SliceRun};
use sx_core::collide::report::FixKind;
use sx_core::collide::{Kind, Part, Severity};

fn cuboid(x: [f32; 2], y: [f32; 2], z: [f32; 2], slot: u8) -> MeshPart {
    let mut positions = Vec::new();
    for zi in z {
        for (xi, yi) in [(x[0], y[0]), (x[1], y[0]), (x[1], y[1]), (x[0], y[1])] {
            positions.push([xi, yi, zi]);
        }
    }
    let mut triangles = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
    for k in 0..4u32 {
        let n = (k + 1) % 4;
        triangles.push([k, n, 4 + n]);
        triangles.push([k, 4 + n, 4 + k]);
    }
    MeshPart {
        name: format!("part {slot}"),
        slot,
        color: None,
        positions,
        triangles,
        paint: Vec::new(),
        support_paint: Vec::new(),
        seam_paint: Vec::new(),
        fuzzy_paint: Vec::new(),
    }
}

fn mesh(parts: Vec<MeshPart>) -> Arc<Mesh> {
    Arc::new(Mesh {
        name: "box".into(),
        parts,
    })
}

/// A box `w` by `d` by `h` mm with its front left corner at the origin.
fn block(w: f32, d: f32, h: f32) -> Arc<Mesh> {
    mesh(vec![cuboid([0.0, w], [0.0, d], [0.0, h], 1)])
}

/// Slices `objects` (name, mesh, x, y) by object, in that order, with `extra` settings and options.
fn run(objects: &[(&str, Arc<Mesh>, f32, f32)], extra: Value, options: Value) -> SliceRun {
    let mut cfg = json!({"brim_width": 0, "skirt_loops": 0, "print_sequence": "by object"});
    if let Value::Object(m) = extra {
        cfg.as_object_mut().unwrap().extend(m);
    }
    let list: Vec<Value> = objects
        .iter()
        .map(|(name, _, x, y)| json!({"id": name, "name": name, "mesh": name, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,0,1]}))
        .collect();
    let mut req = json!({"plate": {"objects": list}, "config": cfg});
    req["options"] = options;
    let req: SliceRequest = serde_json::from_value(req).unwrap();
    let meshes: Vec<(String, Arc<Mesh>)> = objects
        .iter()
        .map(|(n, m, _, _)| ((*n).to_owned(), m.clone()))
        .collect();
    common::run_request(&req, &move |id: &str| {
        Ok(meshes
            .iter()
            .find(|(n, _)| n == id)
            .map(|(_, m)| m.clone())
            .unwrap())
    })
    .unwrap()
}

fn kinds(r: &SliceRun) -> Vec<(Kind, Part, Severity, String, String)> {
    r.report
        .collisions
        .iter()
        .map(|c| (c.kind, c.part, c.severity, c.object_id.clone(), c.hit_id.clone()))
        .collect()
}

#[test]
fn the_gantry_clips_a_tall_object_printed_first_and_printing_it_last_clears_it() {
    let rod = json!({"extruder_clearance_height_to_rod": 10, "extruder_clearance_dist_to_rod": 40});
    let r = run(
        &[
            ("tall", block(20.0, 20.0, 20.0), 60.0, 100.0),
            ("low", block(20.0, 20.0, 6.0), 140.0, 100.0),
        ],
        rod.clone(),
        json!({}),
    );
    assert_eq!(
        kinds(&r),
        [(
            Kind::Gantry,
            Part::Gantry,
            Severity::Hit,
            "low".into(),
            "tall".into()
        )]
    );
    let c = &r.report.collisions[0];
    assert!(c.title.contains("gantry hits tall"), "{}", c.title);
    // 20 mm against a beam 10 mm over the first layer's nozzle: about 9.8 mm deep, from the low box's first layer.
    assert!((c.depth_mm - 9.8).abs() < 0.3, "{}", c.depth_mm);
    assert!(c.time_s > 0.0 && c.time_s < r.report.stats.time_s);
    // The low box's first layer comes after the tall box's last.
    assert!(c.layer >= 100, "{}", c.layer);
    let order = r
        .report
        .collision_fixes
        .iter()
        .find(|f| f.kind == FixKind::Reorder)
        .unwrap();
    assert_eq!(order.title, "Print tall last");
    assert_eq!(order.order, ["low", "tall"]);
    assert!(order.one_click && order.clears == [0]);
    assert!(
        r.report
            .collision_fixes
            .iter()
            .any(|f| f.kind == FixKind::ByLayer && f.one_click)
    );
    // In that order nothing meets: the tall box prints over the finished low one, which is under the rod.
    let r = run(
        &[
            ("low", block(20.0, 20.0, 6.0), 140.0, 100.0),
            ("tall", block(20.0, 20.0, 20.0), 60.0, 100.0),
        ],
        rod,
        json!({}),
    );
    assert!(r.report.collisions.is_empty(), "{:?}", kinds(&r));
}

#[test]
fn the_gantry_counts_only_within_its_reach_and_the_frame_counts_everywhere() {
    let tall = json!({"extruder_clearance_height_to_rod": 10, "extruder_clearance_dist_to_rod": 40});
    // 100 mm apart in y, past the 40 mm reach of the beam
    let far = [
        ("first", block(20.0, 20.0, 20.0), 60.0, 40.0),
        ("second", block(20.0, 20.0, 6.0), 60.0, 160.0),
    ];
    assert!(run(&far, tall.clone(), json!({})).report.collisions.is_empty());
    let r = run(
        &far,
        json!({"extruder_clearance_height_to_rod": 10, "extruder_clearance_height_to_lid": 15}),
        json!({}),
    );
    assert_eq!(
        kinds(&r),
        [(
            Kind::Gantry,
            Part::Lid,
            Severity::Hit,
            "second".into(),
            "first".into()
        )]
    );
    assert!(r.report.collisions[0].title.contains("frame hits first"));
    // 30 mm apart in y is within it
    let near = [
        ("first", block(20.0, 20.0, 20.0), 60.0, 40.0),
        ("second", block(20.0, 20.0, 6.0), 60.0, 90.0),
    ];
    let r = run(&near, tall, json!({}));
    assert!(
        kinds(&r)
            .iter()
            .any(|k| k.0 == Kind::Gantry && k.2 == Severity::Hit)
    );
}

#[test]
fn objects_under_the_hotend_need_no_clearance_and_taller_ones_inside_the_radius_are_close_calls() {
    // Two 2 mm plates 10 mm apart: only the nozzle could reach them, and it does not.
    let thin = [
        ("a", block(20.0, 20.0, 2.0), 60.0, 100.0),
        ("b", block(20.0, 20.0, 2.0), 90.0, 100.0),
    ];
    assert!(run(&thin, json!({}), json!({})).report.collisions.is_empty());
    // The first one 2 mm and the second 6 mm: the hotend passes over the first (Orca and Bambu Studio refuse it).
    let mixed = [
        ("a", block(20.0, 20.0, 2.0), 60.0, 100.0),
        ("b", block(20.0, 20.0, 6.0), 90.0, 100.0),
    ];
    assert!(run(&mixed, json!({}), json!({})).report.collisions.is_empty());
    // 30 mm apart against a 40 mm radius: the generic head clears, the profile's margin does not.
    let apart = |gap: f32| {
        [
            ("tall", block(20.0, 20.0, 20.0), 60.0, 100.0),
            ("short", block(20.0, 20.0, 6.0), 80.0 + gap, 100.0),
        ]
    };
    let r = run(&apart(30.0), json!({}), json!({}));
    assert_eq!(
        kinds(&r),
        [(
            Kind::Hotend,
            Part::Toolhead,
            Severity::Close,
            "short".into(),
            "tall".into()
        )]
    );
    assert!(
        r.report.collisions[0].detail.contains("40 mm"),
        "{}",
        r.report.collisions[0].detail
    );
    assert!(
        r.report
            .collision_fixes
            .iter()
            .any(|f| f.kind == FixKind::Spread && f.mm == Some(11.0))
    );
    assert!(
        run(&apart(41.0), json!({}), json!({}))
            .report
            .collisions
            .is_empty()
    );
    let r = run(&apart(41.0), json!({"extruder_clearance_radius": 60}), json!({}));
    assert_eq!(r.report.collisions.len(), 1);
    // A skirt around each object that reaches toward the other brings the nozzle inside the radius.
    let six = [
        ("a", block(20.0, 20.0, 6.0), 60.0, 100.0),
        ("b", block(20.0, 20.0, 6.0), 125.0, 100.0),
    ];
    assert!(run(&six, json!({}), json!({})).report.collisions.is_empty());
    let skirt = json!({"skirt_type": "perobject", "skirt_loops": 2, "skirt_distance": 25});
    assert_eq!(run(&six, skirt, json!({})).report.collisions.len(), 1);
}

#[test]
fn the_toolhead_hits_a_tall_neighbor_and_the_order_that_clears_it_is_offered() {
    // A 5 mm box 8 mm beside a 30 mm one: the generic head's body (from 12 mm up, 22 mm to the side) meets it; the
    // other way round nothing as low as the box reaches past the nozzle's sock.
    let objects = [
        ("tall", block(20.0, 20.0, 30.0), 60.0, 100.0),
        ("low", block(20.0, 20.0, 5.0), 88.0, 100.0),
    ];
    let r = run(&objects, json!({}), json!({}));
    let hit = r
        .report
        .collisions
        .iter()
        .find(|c| c.kind == Kind::Hotend && c.severity == Severity::Hit)
        .expect("a toolhead hit");
    assert_eq!(
        (hit.object_id.as_str(), hit.hit_id.as_str(), hit.part),
        ("low", "tall", Part::Toolhead)
    );
    assert!(hit.push_mm > 5.0, "{}", hit.push_mm);
    // The strike sits on the tall box's side facing the low one.
    assert!(hit.point[0] > 75.0 && hit.point[0] < 81.0, "{:?}", hit.point);
    let order = r
        .report
        .collision_fixes
        .iter()
        .find(|f| f.kind == FixKind::Reorder)
        .unwrap();
    assert_eq!(order.order, ["low", "tall"]);
}

#[test]
fn a_travel_between_the_islands_of_one_object_runs_through_the_object_printed_before() {
    // Two 4 mm feet 120 mm apart, one object, with a 15 mm box between them printed first.
    let feet = mesh(vec![
        cuboid([0.0, 15.0], [0.0, 15.0], [0.0, 4.0], 1),
        cuboid([120.0, 135.0], [0.0, 15.0], [0.0, 4.0], 1),
    ]);
    let r = run(
        &[
            ("box", block(15.0, 15.0, 15.0), 90.0, 100.0),
            ("feet", feet, 30.0, 100.0),
        ],
        json!({"extruder_clearance_height_to_rod": 60}),
        json!({}),
    );
    let travel = r
        .report
        .collisions
        .iter()
        .find(|c| c.kind == Kind::NozzleTravelThroughPart)
        .unwrap_or_else(|| panic!("{:?}", kinds(&r)));
    assert_eq!(
        (travel.object_id.as_str(), travel.hit_id.as_str()),
        ("feet", "box")
    );
    assert!(travel.depth_mm > 10.0);
    assert!(
        r.report
            .collision_fixes
            .iter()
            .any(|f| f.kind == FixKind::RaiseLift && !f.one_click)
    );
}

/// A U1 plate: a 30 mm box at the back in the way to the dock, printed first, then a two-color box at the front.
fn u1_plate(change: &str) -> SliceRun {
    let two = mesh(vec![
        cuboid([0.0, 14.0], [0.0, 14.0], [0.0, 3.0], 1),
        cuboid([14.0, 28.0], [0.0, 14.0], [0.0, 3.0], 2),
    ]);
    run(
        &[
            ("back", block(30.0, 20.0, 30.0), 25.0, 200.0),
            ("front", two, 30.0, 40.0),
        ],
        json!({
            "printer_model": "Snapmaker U1",
            "nozzle_diameter": [0.4, 0.4, 0.4, 0.4],
            "printable_area": ["0.5x1", "270.5x1", "270.5x271", "0.5x271"],
            "printable_height": 270,
            "enable_prime_tower": false,
            "change_filament_gcode": change,
        }),
        json!({"printerId": "snapmaker-u1"}),
    )
}

#[test]
fn a_tool_change_to_the_u1_dock_crosses_a_box_printed_before_unless_the_change_lifts_over_it() {
    let r = u1_plate("T[next_extruder]");
    let trip = r
        .report
        .collisions
        .iter()
        .find(|c| matches!(c.kind, Kind::ToolChange | Kind::Dock))
        .unwrap_or_else(|| panic!("{:?}", kinds(&r)));
    assert_eq!((trip.object_id.as_str(), trip.hit_id.as_str()), ("front", "back"));
    assert!(trip.change.is_some());
    assert!(
        trip.title.contains("tool change crosses back") || trip.title.contains("dock"),
        "{}",
        trip.title
    );
    assert!(
        r.report
            .collision_fixes
            .iter()
            .any(|f| f.kind == FixKind::MoveObject && f.object_id.as_deref() == Some("back"))
    );
    // The maker's change G-code lifts over the highest layer printed so far.
    let r = u1_plate("G1 Z{max_layer_z + 2}\nT[next_extruder]");
    assert!(
        !r.report
            .collisions
            .iter()
            .any(|c| matches!(c.kind, Kind::ToolChange | Kind::Dock)),
        "{:?}",
        kinds(&r)
    );
}

#[test]
fn shards_report_the_same_collisions_as_one_run() {
    let rod = json!({"extruder_clearance_height_to_rod": 10});
    let objects = [
        ("tall", block(20.0, 20.0, 20.0), 60.0, 100.0),
        ("low", block(20.0, 20.0, 6.0), 140.0, 100.0),
    ];
    let one = run(&objects, rod.clone(), json!({"shards": 1}));
    let four = run(&objects, rod, json!({"shards": 4}));
    assert!(!one.report.collisions.is_empty());
    assert_eq!(one.report.collisions, four.report.collisions);
    assert_eq!(one.report.collision_fixes, four.report.collision_fixes);
}

#[test]
fn printing_by_layer_has_nothing_to_check() {
    let objects = [
        ("tall", block(20.0, 20.0, 20.0), 60.0, 100.0),
        ("low", block(20.0, 20.0, 6.0), 85.0, 100.0),
    ];
    let r = run(
        &objects,
        json!({"print_sequence": "by layer", "extruder_clearance_height_to_rod": 5}),
        json!({}),
    );
    assert!(r.report.collisions.is_empty());
}

/// An object of a test plate: its name (also its mesh id), mesh and place, mm.
type Placed = (String, Arc<Mesh>, f32, f32);

/// A number of a profile value as Orca writes them: a string, or the first of a list.
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Array(a) => a.first().and_then(num),
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// A by-object row of 12 mm boxes along the middle of the bed of `machine`, spaced as the maker's rule asks
/// (`extruder_clearance_max_radius` on a Bambu Lab printer, `extruder_clearance_radius` elsewhere), the last one taller
/// than the gantry and printed last. None when the bed holds fewer than two.
fn makers_plate(id: &str, m: &serde_json::Map<String, Value>) -> Option<Vec<Placed>> {
    let get = |k: &str, d: f64| m.get(k).and_then(num).unwrap_or(d);
    let radius = if id.starts_with("bambu-") {
        get("extruder_clearance_max_radius", 68.0)
    } else {
        get("extruder_clearance_radius", 40.0)
    };
    let rod = get("extruder_clearance_height_to_rod", 40.0);
    let area: Vec<[f64; 2]> = m["printable_area"]
        .as_array()?
        .iter()
        .filter_map(|p| {
            let (x, y) = p.as_str()?.split_once('x')?;
            Some([x.parse().ok()?, y.parse().ok()?])
        })
        .collect();
    let (x0, x1) = area
        .iter()
        .fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p[0]), a.1.max(p[0])));
    let (y0, y1) = area
        .iter()
        .fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p[1]), a.1.max(p[1])));
    let size = 12.0;
    let gap = radius + 2.0;
    let fits = |n: u32| f64::from(n) * size + f64::from(n - 1) * gap + 20.0 <= x1 - x0;
    let n = if fits(3) {
        3
    } else if fits(2) {
        2
    } else {
        return None;
    };
    let tall = (rod * 1.3).min(get("printable_height", 250.0) - 10.0).max(12.0);
    #[allow(clippy::cast_possible_truncation, reason = "plate positions in mm")]
    Some(
        (0..n)
            .map(|i| {
                let h = if i + 1 == n { tall } else { 8.0 };
                let x = x0 + 10.0 + f64::from(i) * (size + gap);
                (
                    format!("o{i}"),
                    block(size as f32, size as f32, h as f32),
                    x as f32,
                    f64::midpoint(y0, y1) as f32,
                )
            })
            .collect(),
    )
}

/// For every shipped printer: a by-object row of boxes spaced as the maker's own rule asks, the tallest last,
/// meets nothing.
#[test]
fn no_strike_on_plates_the_makers_rules_accept() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../profiles/machine.json");
    let file: Value = serde_json::from_slice(&std::fs::read(root).unwrap()).unwrap();
    let mut checked = 0;
    for (id, model) in file["models"].as_object().unwrap() {
        let m = model["machine"].as_object().unwrap();
        let Some(objects) = makers_plate(id, m) else {
            continue;
        };
        let mut cfg = Value::Object(m.clone());
        cfg.as_object_mut().unwrap().extend(
            json!({"brim_width": 0, "skirt_loops": 0, "print_sequence": "by object", "enable_prime_tower": false})
                .as_object()
                .unwrap()
                .clone(),
        );
        let list: Vec<Value> = objects
            .iter()
            .map(|(name, _, x, y)| json!({"id": name, "name": name, "mesh": name, "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,0,1]}))
            .collect();
        let req: SliceRequest = serde_json::from_value(json!({
            "plate": {"objects": list},
            "config": cfg,
            "options": {"printerId": id, "emitPreview": false},
        }))
        .unwrap();
        let r = match common::run_request(&req, &move |k: &str| {
            Ok(objects
                .iter()
                .find(|(n, ..)| n == k)
                .map(|(_, m, ..)| m.clone())
                .unwrap())
        }) {
            Ok(r) => r,
            // A profile this engine cannot slice by object is no plate to check.
            Err(api::Error::Config { .. }) => continue,
            Err(e) => panic!("{id}: {e}"),
        };
        let hits: Vec<_> = r
            .report
            .collisions
            .iter()
            .filter(|c| c.severity == Severity::Hit)
            .map(|c| c.title.clone())
            .collect();
        assert!(hits.is_empty(), "{id}: {hits:?}");
        checked += 1;
    }
    assert!(checked > 40, "{checked}");
}
