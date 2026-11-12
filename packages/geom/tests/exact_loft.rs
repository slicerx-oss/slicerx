// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft as an exact solid: the faces the kernel makes from the loft's rails, the volume they close, how far they
// are from the rails' own surface, and the body kept in the engine's table. Empty without the brep feature, so a
// workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
mod common;

use common::volume_near;
use serde_json::{Value, json};
use std::f64::consts::TAU;
use sx_brep::{Surface, Tessellation};
use sx_geom::exact as table;
use sx_geom::face::{self, Operation};
use sx_geom::faces;
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::exact::{self, Part};
use sx_geom::sketch_loft::{self, Density, Match, Options, Profile, Rails};
use sx_geom::vec3::{self, V3};

/// seven stations of a hull across x, six points each
fn hull() -> Value {
    let rows: [(f64, [f64; 4]); 7] = [
        (0.0, [2.5, 4.5, 6.3, 14.0]),
        (25.0, [5.5, 10.0, 8.1, 18.0]),
        (70.0, [6.3, 11.45, 9.3, 20.7]),
        (110.0, [6.3, 11.45, 9.3, 20.7]),
        (150.0, [5.8, 10.5, 9.0, 20.0]),
        (195.0, [2.8, 5.0, 8.6, 19.0]),
        (217.6, [0.5, 0.8, 8.1, 18.0]),
    ];
    let stations: Vec<Value> = rows
        .iter()
        .map(|&(x, [keel, beam, chine, deck])| {
            json!({
                "frame": { "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
                "loops": [{ "points": [
                    [-keel, 0], [-beam, chine], [-beam, deck], [beam, deck], [beam, chine], [keel, 0],
                ] }],
            })
        })
        .collect();
    Value::Array(stations)
}

fn rails_of(profiles: &Value, opts: &Value) -> Rails {
    let profiles: Vec<Profile> = serde_json::from_value(profiles.clone()).unwrap();
    let opts: Options = serde_json::from_value(opts.clone()).unwrap();
    match sketch_loft::rails(&profiles, &opts, &Density::default()).unwrap() {
        Match::Rails(r) => r,
        Match::Unmatched(why) => panic!("unmatched: {why}"),
    }
}

fn bezier_at(b: &[V3; 4], t: f64) -> V3 {
    let u = 1.0 - t;
    let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
    (0..4).fold([0.0; 3], |s, k| vec3::add(s, vec3::scale(b[k], w[k])))
}

/// How far `p` is from the straight line between rails `a` and `b` at the place along them where that is least:
/// the loft's own side between two neighboring rails.
fn off_the_side(a: &[[V3; 4]], b: &[[V3; 4]], p: V3) -> f64 {
    let spans = a.len();
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a place along the rail, held inside its spans"
    )]
    let far = |g: f64| {
        let span = (g.floor() as usize).min(spans - 1);
        #[allow(clippy::cast_precision_loss, reason = "a span count")]
        let along = g - span as f64;
        let (pa, pb) = (bezier_at(&a[span], along), bezier_at(&b[span], along));
        let across = vec3::sub(pb, pa);
        let share = (vec3::dot(vec3::sub(p, pa), across) / vec3::dot(across, across)).clamp(0.0, 1.0);
        vec3::len(vec3::sub(vec3::add(pa, vec3::scale(across, share)), p))
    };
    #[allow(clippy::cast_precision_loss, reason = "a span count")]
    let end = spans as f64;
    let steps = 64 * spans;
    #[allow(clippy::cast_precision_loss, reason = "a sample count")]
    let at = |k: usize| end * k as f64 / steps as f64;
    let best = (0..=steps)
        .min_by(|&i, &j| far(at(i)).total_cmp(&far(at(j))))
        .unwrap_or(0);
    // close in on the least between the two samples beside the best one
    let (mut lo, mut hi) = (at(best.saturating_sub(1)), at((best + 1).min(steps)));
    for _ in 0..200 {
        let (m1, m2) = (lo + (hi - lo) / 3.0, hi - (hi - lo) / 3.0);
        if far(m1) < far(m2) {
            hi = m2;
        } else {
            lo = m1;
        }
    }
    far(f64::midpoint(lo, hi))
}

#[test]
fn the_hull_is_eight_exact_faces_on_its_rails() {
    if !sx_brep::KERNEL {
        return;
    }
    let rails = rails_of(&hull(), &json!({ "smooth": true }));
    let lofted = exact::lofted(&rails).expect("the hull as a solid");
    // six sides, one for each stretch of the six-point stations, and the two ends
    let mut parts = lofted.parts.clone();
    parts.sort_by_key(|p| match *p {
        Part::Side(k) => k,
        Part::First => 6,
        Part::Last => 7,
    });
    assert_eq!(
        parts,
        [
            Part::Side(0),
            Part::Side(1),
            Part::Side(2),
            Part::Side(3),
            Part::Side(4),
            Part::Side(5),
            Part::First,
            Part::Last
        ]
    );
    // the volume inside the rails' own surface, measured at 4000 rows a span, is 71826.331984 mm3
    let volume = lofted.body.volume().expect("volume");
    // the kernel gives 71826.33189737417 on Linux and 71826.32873692371 with Apple clang on arm64
    assert!(volume_near(volume, 71_826.331_984), "{volume}");
    let mesh = lofted.body.tessellate(&Tessellation::default()).expect("a mesh");
    let n = rails.rails.len();
    let mut farthest = 0.0f64;
    for (triangle, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        match lofted.parts[face as usize] {
            Part::Side(k) => {
                assert_eq!(mesh.surfaces[face as usize], Surface::Spline);
                let (a, b) = (&rails.rails[k], &rails.rails[(k + 1) % n]);
                for &corner in triangle {
                    farthest = farthest.max(off_the_side(a, b, mesh.positions[corner as usize]));
                }
            }
            end => {
                assert!(matches!(mesh.surfaces[face as usize], Surface::Plane { .. }));
                let x = if end == Part::First { 0.0 } else { 217.6 };
                for &corner in triangle {
                    assert!((mesh.positions[corner as usize][0] - x).abs() < 1e-9);
                }
            }
        }
    }
    // every point of the kernel's sides is on the loft's own side between the same two rails
    assert!(farthest < 1e-9, "{farthest:e}");
}

fn parsed(profiles: &Value, opts: &Value) -> (Vec<Profile>, Options) {
    (
        serde_json::from_value(profiles.clone()).unwrap(),
        serde_json::from_value(opts.clone()).unwrap(),
    )
}

fn level(z: f64, lp: &Value) -> Value {
    json!({
        "frame": { "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] },
        "loops": [lp],
    })
}

fn rectangle(w: f64, h: f64) -> Value {
    let (x, y) = (w / 2.0, h / 2.0);
    json!({ "points": [[-x, -y], [x, -y], [x, y], [-x, y]] })
}

/// six squares around a circle of radius 40 about z, each on the plane through the axis
fn ring() -> Value {
    let sides = [10.0, 12.0, 14.0, 12.0, 10.0, 8.0];
    let lifts = [0.0, 3.0, 0.0, -3.0, 0.0, 2.0];
    let squares: Vec<Value> = sides
        .iter()
        .zip(lifts)
        .zip(0_u8..)
        .map(|((&side, lift), k)| {
            let (s, c) = (TAU * f64::from(k) / 6.0).m_sin_cos();
            json!({
                "frame": {
                    "origin": [40.0 * c, 40.0 * s, lift],
                    "normal": [-s, c, 0],
                    "u": [c, s, 0],
                    "v": [0, 0, 1],
                },
                "loops": [rectangle(side, side)],
            })
        })
        .collect();
    Value::Array(squares)
}

/// The plane each face of a body lies in and faces out along, as a unit normal and its offset, from the body's
/// triangles (counterclockwise seen from outside); none for a face whose triangles are not all in one plane. A
/// ruled face between straight rails is a spline surface in the kernel and can still lie in a plane.
fn planes(mesh: &sx_brep::Mesh) -> Vec<Option<(V3, f64)>> {
    let mut found: Vec<Option<(V3, f64)>> = vec![None; mesh.surfaces.len()];
    let mut flat = vec![true; mesh.surfaces.len()];
    for (triangle, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        let face = face as usize;
        let corners = triangle.map(|v| mesh.positions[v as usize]);
        let [a, b, c] = corners;
        if found[face].is_none() {
            found[face] = vec3::normalize(vec3::cross(vec3::sub(b, a), vec3::sub(c, a)))
                .map(|normal| (normal, vec3::dot(normal, a)));
        }
        let on = found[face].is_some_and(|(normal, offset)| {
            corners
                .iter()
                .all(|&p| (vec3::dot(normal, p) - offset).abs() < 1e-9)
        });
        flat[face] = flat[face] && on;
    }
    found
        .into_iter()
        .zip(flat)
        .map(|(plane, flat)| plane.filter(|_| flat))
        .collect()
}

/// The key of the mesh's face on this plane.
fn key_on(mesh: &TriMesh, plane: (V3, f64)) -> Option<u64> {
    let f = mesh.faces.as_ref()?;
    let at = f.table.iter().position(|s| match *s {
        faces::Surface::Plane { normal, offset } => {
            vec3::len(vec3::sub(normal, plane.0)) < 1e-9 && (offset - plane.1).abs() < 1e-9
        }
        _ => false,
    })?;
    f.keys.get(at).copied()
}

/// The mesh loft's result alone, and the kept body's planes and keys in face order.
type Keyed = (TriMesh, Vec<Option<(V3, f64)>>, Vec<u64>);

/// One keyed step two ways: the mesh loft alone, and the mesh loft with the exact body made beside it.
fn keyed_both_ways(profiles: &Value, opts: &Value) -> Keyed {
    let (profiles, opts) = parsed(profiles, opts);
    let start = table::count();
    let step = Some(0x5eed_1234);
    let alone = faces::with_key_salt(step, || {
        let mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
        face::apply(mesh, Operation::New, None).unwrap()
    });
    let (handle, beside) = faces::with_key_salt(step, || {
        let mut mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
        let handle = exact::hold_through(&profiles, &opts, &mut mesh).unwrap();
        (handle, face::apply(mesh, Operation::New, None).unwrap())
    });
    // the mesh loft's own answer does not change: the same points, triangles, faces and keys
    assert_eq!(beside.mesh, alone.mesh);
    assert!(alone.mesh.faces.as_ref().is_some_and(|f| !f.keys.is_empty()));
    assert!(table::with(handle, |_| ()).is_some());
    assert_eq!(table::count(), start + 1);
    let (planes, keys) = table::with(handle, |held| {
        let mesh = held.body.tessellate(&Tessellation::default()).unwrap();
        (planes(&mesh), held.keys.clone())
    })
    .expect("the body is held");
    assert_eq!(keys.len(), planes.len());
    assert!(keys.iter().all(|&k| k != 0));
    let mut each = keys.clone();
    each.sort_unstable();
    each.dedup();
    assert_eq!(each.len(), keys.len(), "every face has a key of its own");
    assert!(table::free(handle));
    assert!(!table::free(handle));
    assert_eq!(table::count(), start);
    (alone.mesh, planes, keys)
}

#[test]
fn a_block_s_faces_take_the_mesh_loft_s_keys() {
    if !sx_brep::KERNEL {
        return;
    }
    // two equal rectangles: four flat sides and two ends, each the mesh loft's own face
    let block = json!([
        level(0.0, &rectangle(20.0, 10.0)),
        level(15.0, &rectangle(20.0, 10.0))
    ]);
    let (mesh, planes, keys) = keyed_both_ways(&block, &json!({}));
    assert_eq!(keys.len(), 6);
    for (plane, key) in planes.iter().zip(&keys) {
        let plane = plane.expect("a flat face");
        assert_eq!(key_on(&mesh, plane), Some(*key), "{plane:?}");
    }
}

#[test]
fn the_hull_s_ends_take_the_mesh_loft_s_keys_and_its_sides_their_own() {
    if !sx_brep::KERNEL {
        return;
    }
    let (mesh, planes, keys) = keyed_both_ways(&hull(), &json!({ "smooth": true }));
    assert_eq!(keys.len(), 8);
    let mesh_keys = &mesh.faces.as_ref().unwrap().keys;
    let mut shared = Vec::new();
    for (plane, key) in planes.iter().zip(&keys) {
        match plane {
            // a face that lies in one plane from end to end is one face of the mesh loft too
            Some(plane) => {
                assert_eq!(key_on(&mesh, *plane), Some(*key), "{plane:?}");
                shared.push(plane.0.map(f64::round));
            }
            // the mesh loft cuts its other sides between profiles and has no face that runs a side's whole length
            None => assert!(!mesh_keys.contains(key)),
        }
    }
    // the two ends, and the bottom between the two keel points, which lies on the bed all the way
    shared.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(shared, [[-1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]]);
}

#[test]
fn outside_a_keyed_step_nothing_gets_keys() {
    if !sx_brep::KERNEL {
        return;
    }
    let (profiles, opts) = parsed(&hull(), &json!({}));
    let mut mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
    let before = mesh.clone();
    let handle = exact::hold_through(&profiles, &opts, &mut mesh).unwrap();
    assert_eq!(mesh, before);
    assert_eq!(table::with(handle, |held| held.keys.len()), Some(0));
    assert!(table::free(handle));
}

#[test]
fn a_closed_loft_is_one_face_a_stretch_and_no_ends() {
    if !sx_brep::KERNEL {
        return;
    }
    for (smooth, measured) in [(true, Some(30_372.705_932)), (false, None)] {
        let rails = rails_of(&ring(), &json!({ "closed": true, "smooth": smooth }));
        assert_eq!(rails.wrap, Some(0));
        let lofted = exact::lofted(&rails).expect("a ring");
        let mut parts = lofted.parts.clone();
        parts.sort_by_key(|p| match *p {
            Part::Side(k) => k,
            Part::First | Part::Last => usize::MAX,
        });
        assert_eq!(
            parts,
            [Part::Side(0), Part::Side(1), Part::Side(2), Part::Side(3)]
        );
        let volume = lofted.body.volume().expect("volume");
        // the volume inside the smooth ring's rails, measured at 4000 rows a span
        if let Some(measured) = measured {
            assert!(volume_near(volume, measured), "{volume}");
        }
        assert!(volume > 20_000.0, "{volume}");
    }
}

#[test]
fn what_cannot_be_made_exact_is_refused_and_nothing_is_kept() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let refused = |profiles: &Value, opts: &Value| {
        let (profiles, opts) = parsed(profiles, opts);
        let mut mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
        exact::hold_through(&profiles, &opts, &mut mesh)
            .expect_err("a refusal")
            .to_string()
    };
    let circle = |d: f64| json!({ "type": "circle", "center": [0, 0], "diameterMm": d });
    let spline = json!({ "type": "spline", "points": [[10, 0], [0, 8], [-10, 0], [0, -8]] });
    assert_eq!(
        refused(
            &json!([level(0.0, &circle(20.0)), level(20.0, &spline)]),
            &json!({})
        ),
        "loft: profile 2 is a closed spline, which has no corners to match its pieces between"
    );
    assert_eq!(
        refused(
            &json!([level(0.0, &circle(20.0)), level(20.0, &circle(24.0))]),
            &json!({})
        ),
        "loft: an exact loft is made only through profiles of straight lines for now; these have an arc, a circle or an ellipse"
    );
    assert_eq!(
        refused(&hull(), &json!({ "thicken": { "thicknessMm": 1 } })),
        "loft: a loft thickened into a shell is not made exact yet"
    );
    // from here on the rails are changed by hand into ones no loft would have
    let hull_rails = rails_of(&hull(), &json!({ "smooth": true }));
    let refused = |rails: &Rails| {
        let (profiles, opts) = parsed(&hull(), &json!({ "smooth": true }));
        let mut mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
        let why = match exact::hold(rails, &mut mesh) {
            Ok(handle) => format!("held as {handle}"),
            Err(e) => e.to_string(),
        };
        assert_eq!(
            exact::lofted(rails).map(|_| ()).map_err(|e| e.to_string()),
            Err(why.clone())
        );
        why
    };
    // a first section that is not flat cannot be an end
    let mut bent = hull_rails.clone();
    bent.rings[0].points[1][0] += 0.5;
    assert_eq!(
        refused(&bent),
        "loft: flat face: its loop does not lie in one plane"
    );
    // a rail with no length between two sections
    let block = json!([
        level(0.0, &rectangle(20.0, 10.0)),
        level(15.0, &rectangle(20.0, 10.0))
    ]);
    let mut still = rails_of(&block, &json!({}));
    let from = still.rails[0][0][0];
    still.rails[0][0] = [from; 4];
    assert_eq!(
        refused(&still),
        "loft: ruled face: a curve has a piece of no length"
    );
    // a rail that ends 1 mm off the last section: two sides no longer meet the end. The kernel closes a gap like
    // that by itself and calls the result a solid, so it is refused by the gap the kernel reports.
    let mut open = hull_rails.clone();
    let last = open.rails[2].len() - 1;
    open.rails[2][last][3][0] += 1.0;
    let why = refused(&open);
    assert!(
        why.starts_with("loft: stitch: the faces are ")
            && why.ends_with(" mm apart along a side they share; they must meet"),
        "{why}"
    );
    assert_eq!(table::count(), start);
}

#[test]
fn the_body_is_where_the_profiles_frames_put_it() {
    if !sx_brep::KERNEL {
        return;
    }
    // a 20 by 10 mm rectangle on a plane that is off the origin and leans back, and the same one 15 mm along that
    // plane's normal
    let (origin, normal) = ([100.0, -50.0, 30.0], [0.0, -0.6, 0.8]);
    let (u, v) = ([1.0, 0.0, 0.0], [0.0, 0.8, 0.6]);
    let at = |x: f64, y: f64, h: f64| [0, 1, 2].map(|i| origin[i] + x * u[i] + y * v[i] + h * normal[i]);
    let on = |h: f64| {
        json!({
            "frame": { "origin": at(0.0, 0.0, h), "normal": normal, "u": u, "v": v },
            "loops": [rectangle(20.0, 10.0)],
        })
    };
    let profiles = json!([on(0.0), on(15.0)]);
    let lofted = exact::lofted(&rails_of(&profiles, &json!({}))).expect("a block");
    let volume = lofted.body.volume().expect("volume");
    assert!((volume - 3000.0).abs() < 1e-6, "{volume}");
    let (min, max) = lofted.body.bounds().expect("bounds");
    let mut corners = Vec::new();
    for h in [0.0, 15.0] {
        for (x, y) in [(-10.0, -5.0), (10.0, -5.0), (10.0, 5.0), (-10.0, 5.0)] {
            corners.push(at(x, y, h));
        }
    }
    // and it is where the mesh loft of the same profiles is
    let (parsed_profiles, opts) = parsed(&profiles, &json!({}));
    let mesh = sketch_loft::loft_with(&parsed_profiles, &opts).unwrap();
    for i in 0..3 {
        let low = corners.iter().map(|c| c[i]).fold(f64::INFINITY, f64::min);
        let high = corners.iter().map(|c| c[i]).fold(f64::NEG_INFINITY, f64::max);
        assert!(
            (min[i] - low).abs() < 1e-9 && (max[i] - high).abs() < 1e-9,
            "{min:?} {max:?}"
        );
        let (mesh_low, mesh_high) = mesh
            .positions
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
                (lo.min(p[i]), hi.max(p[i]))
            });
        assert!((min[i] - mesh_low).abs() < 1e-9 && (max[i] - mesh_high).abs() < 1e-9);
    }
}

// ---- the op: sketch.loft asked to be exact

fn op(name: &str, request: &Value) -> String {
    sx_geom::json::call(name, &request.to_string()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn block() -> Value {
    json!([
        level(0.0, &rectangle(20.0, 10.0)),
        level(15.0, &rectangle(20.0, 10.0))
    ])
}

/// A reply's text with one of its fields taken out, comma and all.
fn without(reply: &str, field: &str) -> String {
    let (with_next, with_last) = (format!("{field},"), format!(",{field}"));
    assert!(reply.contains(field), "no {field} in the reply");
    if reply.contains(&with_next) {
        reply.replacen(&with_next, "", 1)
    } else {
        reply.replacen(&with_last, "", 1)
    }
}

/// The text of one field of a reply as the reply prints it.
fn printed(reply: &Value, key: &str) -> String {
    format!("\"{key}\":{}", reply[key])
}

#[test]
fn the_engine_says_which_ops_make_exact_bodies() {
    let ops: Value = serde_json::from_str(&op("exact.ops", &json!({}))).unwrap();
    if sx_brep::KERNEL {
        assert_eq!(ops, json!({ "ops": ["sketch.loft"] }));
    } else {
        assert_eq!(ops, json!({ "ops": [] }));
    }
}

#[test]
fn an_exact_loft_s_reply_is_the_loft_s_own_plus_the_body() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    for (profiles, smooth) in [(hull(), true), (block(), false)] {
        for keyed in [true, false] {
            let mut request = json!({ "profiles": profiles, "smooth": smooth, "withFaces": true });
            if keyed {
                request["keySalt"] = json!(77);
            }
            let plain = op("sketch.loft", &request);
            request["exact"] = json!(true);
            let asked = op("sketch.loft", &request);
            let reply: Value = serde_json::from_str(&asked).unwrap();
            let handle = reply["body"].as_u64().expect("a body");
            assert!(u32::try_from(handle).is_ok_and(|h| table::with(h, |_| ()).is_some()));
            let keys = reply["bodyKeys"].as_array().expect("its keys");
            // every byte of the loft's own reply, with the two fields added
            let rest = without(
                &without(&asked, &printed(&reply, "body")),
                &printed(&reply, "bodyKeys"),
            );
            assert_eq!(rest, plain, "smooth {smooth} keyed {keyed}");
            assert_eq!(keys.is_empty(), !keyed);
            // the body tessellates through the engine, and is saved as text the old load reads with its keys
            let held = json!({ "body": handle });
            let mesh: Value = serde_json::from_str(&op("brep.tessellate", &held)).unwrap();
            assert!(mesh["positions"].as_array().is_some_and(|p| !p.is_empty()));
            let saved: Value = serde_json::from_str(&op("brep.save", &held)).unwrap();
            sx_geom::json::allow_brep_text(true);
            let loaded: Value = serde_json::from_str(&op("brep.load", &json!({ "body": saved }))).unwrap();
            let old: Value =
                serde_json::from_str(&op("brep.tessellate", &json!({ "body": loaded["body"] }))).unwrap();
            let read: Vec<Value> = old["faces"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["key"].clone())
                .collect();
            if keyed {
                assert_eq!(&read, keys);
            } else {
                assert!(read.iter().all(|k| *k == json!(0)));
            }
            op("brep.free", &json!({ "body": loaded["body"] }));
            // asked as text: the same body, no number, nothing left in the table
            let held_now = table::count();
            request["save"] = json!(true);
            let texted = op("sketch.loft", &request);
            let reply: Value = serde_json::from_str(&texted).unwrap();
            assert!(reply.get("body").is_none() && reply.get("bodyKeys").is_none());
            assert_eq!(table::count(), held_now);
            assert_eq!(without(&texted, &printed(&reply, "bodySmb")), plain);
            let loaded: Value =
                serde_json::from_str(&op("brep.load", &json!({ "body": { "smb": reply["bodySmb"] } })))
                    .unwrap();
            let old: Value =
                serde_json::from_str(&op("brep.tessellate", &json!({ "body": loaded["body"] }))).unwrap();
            let again: Vec<Value> = old["faces"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["key"].clone())
                .collect();
            assert_eq!(again, read);
            op("brep.free", &json!({ "body": loaded["body"] }));
            sx_geom::json::allow_brep_text(false);
            assert_eq!(op("brep.free", &held), "{\"freed\":true}");
        }
    }
    assert_eq!(table::count(), start);
}

#[test]
fn a_loft_that_cannot_be_exact_answers_as_before_and_says_why() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let circle = |d: f64| json!({ "type": "circle", "center": [0, 0], "diameterMm": d });
    let spline = json!({ "type": "spline", "points": [[10, 0], [0, 8], [-10, 0], [0, -8]] });
    let target = json!({ "positions": [0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 30], "indices": [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] });
    let cases = [
        (
            json!({ "profiles": [level(0.0, &circle(20.0)), level(20.0, &circle(24.0))] }),
            "An exact loft is made only through profiles of straight lines for now; these have an arc, a circle or an ellipse.",
        ),
        (
            json!({ "profiles": [level(0.0, &circle(20.0)), level(20.0, &spline)] }),
            "Profile 2 is a closed spline, which has no corners to match its pieces between.",
        ),
        (
            json!({ "profiles": block(), "operation": "join", "target": { "mesh": target } }),
            "An exact loft is made only as a new body for now.",
        ),
    ];
    for (mut request, why) in cases {
        let plain = sx_geom::json::call("sketch.loft", &request.to_string());
        request["exact"] = json!(true);
        let asked = sx_geom::json::call("sketch.loft", &request.to_string());
        match (plain, asked) {
            (Ok(plain), Ok(asked)) => {
                let reply: Value = serde_json::from_str(&asked).unwrap();
                assert_eq!(reply["exact"], json!({ "made": false, "why": why }));
                assert!(reply.get("body").is_none() && reply.get("bodySmb").is_none());
                assert_eq!(without(&asked, &printed(&reply, "exact")), plain);
            }
            // what the mesh path refuses is refused the same with the ask
            (Err(plain), Err(asked)) => assert_eq!(asked.to_string(), plain.to_string()),
            (plain, asked) => panic!("{why}: {plain:?} without the ask and {asked:?} with it"),
        }
    }
    assert_eq!(table::count(), start);
}

#[test]
fn the_hull_s_and_a_block_s_edges_are_on_the_curves_their_faces_were_given() {
    if !sx_brep::KERNEL {
        return;
    }
    let block = json!([
        level(0.0, &rectangle(20.0, 10.0)),
        level(15.0, &rectangle(20.0, 10.0))
    ]);
    // the largest coordinate of each: 217.6 mm and 15 mm
    for (name, profiles, opts, size) in [
        ("hull, smooth", hull(), json!({ "smooth": true }), 217.6),
        ("hull, straight", hull(), json!({}), 217.6),
        ("block", block, json!({}), 15.0),
    ] {
        let lofted = exact::lofted(&rails_of(&profiles, &opts)).unwrap_or_else(|e| panic!("{name}: {e}"));
        println!(
            "EDGES {name}: the edges are {:e} mm from the curves given",
            lofted.off_mm
        );
        assert!(lofted.off_mm <= 1e-9 * size, "{name}: {:e} mm", lofted.off_mm);
    }
}

/// A held body's faces as `brep.tessellate` sorts them into the five kinds mesh operations know, and the kernel's
/// own kind of each face's surface.
fn sorted(body: u64) -> (Vec<Value>, Vec<String>) {
    let mesh: Value = serde_json::from_str(&op("brep.tessellate", &json!({ "body": body }))).unwrap();
    let list = |v: &Value| v.as_array().expect("a list").clone();
    let table = list(&mesh["faces"])
        .iter()
        .map(|f| f["surface"].clone())
        .collect();
    let kinds = list(&mesh["surfaces"])
        .iter()
        .map(|s| s["kind"].as_str().expect("a kind").to_owned())
        .collect();
    (table, kinds)
}

fn count(of: &[Value], kind: &str) -> usize {
    of.iter().filter(|s| s["kind"] == kind).count()
}

// a loft's sides are spline surfaces in the kernel, flat or not. Among the five kinds a flat one is a plane, as it
// is for the older solid operations; the kernel's own kind stays what it is
#[test]
fn a_loft_s_flat_sides_are_planes_among_the_five_kinds_and_its_curved_sides_are_not() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let lofted = |profiles: &Value, smooth: bool| -> u64 {
        let request = json!({ "profiles": profiles, "smooth": smooth, "exact": true });
        let reply: Value = serde_json::from_str(&op("sketch.loft", &request)).unwrap();
        reply["body"].as_u64().expect("a body")
    };
    let splines = |kinds: &[String]| kinds.iter().filter(|k| *k == "spline").count();
    let free = |body: u64| assert_eq!(op("brep.free", &json!({ "body": body })), r#"{"freed":true}"#);

    let body = lofted(&block(), false);
    let (table_of, kinds) = sorted(body);
    assert_eq!((splines(&kinds), kinds.len()), (4, 6), "{kinds:?}");
    for (normal, offset) in [
        ([1.0, 0.0, 0.0], 10.0),
        ([-1.0, 0.0, 0.0], 10.0),
        ([0.0, 1.0, 0.0], 5.0),
        ([0.0, -1.0, 0.0], 5.0),
        ([0.0, 0.0, 1.0], 15.0),
        ([0.0, 0.0, -1.0], 0.0),
    ] {
        let on = |s: &&Value| {
            s["kind"] == "plane"
                && (0..3).all(|k| (s["normal"][k].as_f64().expect("a normal") - normal[k]).abs() < 1e-9)
                && (s["offset"].as_f64().expect("an offset") - offset).abs() < 1e-9
        };
        assert_eq!(
            table_of.iter().filter(on).count(),
            1,
            "{normal:?} at {offset}: {table_of:?}"
        );
    }
    let info: Value = serde_json::from_str(&op("brep.info", &json!({ "body": body }))).unwrap();
    assert_eq!(info["faceTypes"], json!({ "plane": 6 }));
    free(body);

    // the same block with its middle a hundredth of a millimeter wider all round: the sides bow, and are no planes
    let bowed = json!([
        level(0.0, &rectangle(20.0, 10.0)),
        level(7.5, &rectangle(20.02, 10.02)),
        level(15.0, &rectangle(20.0, 10.0))
    ]);
    let body = lofted(&bowed, true);
    let (table_of, kinds) = sorted(body);
    assert_eq!((splines(&kinds), kinds.len()), (4, 6), "{kinds:?}");
    assert_eq!(
        (count(&table_of, "plane"), count(&table_of, "other")),
        (2, 4),
        "{table_of:?}"
    );
    free(body);

    // the hull: its two ends are planes, and so is the strip under the keel, which every station has at height 0;
    // the five sides that follow the stations are curved
    let body = lofted(&hull(), true);
    let (table_of, kinds) = sorted(body);
    assert_eq!((splines(&kinds), kinds.len()), (6, 8), "{kinds:?}");
    assert_eq!(
        (count(&table_of, "plane"), count(&table_of, "other")),
        (3, 5),
        "{table_of:?}"
    );
    free(body);
    assert_eq!(table::count(), start);
}
