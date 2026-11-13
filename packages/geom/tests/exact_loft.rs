// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft as an exact solid: the faces the kernel makes from the loft's rails, the volume they close, how far they
// are from the rails' own surface, and the body kept in the engine's table. Empty without the brep feature, so a
// workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
mod common;

use common::{farthest_off_its_faces, off_its_face, sampled, volume_near};
use serde_json::{Value, json};
use std::f64::consts::TAU;
use sx_brep::{Surface, Tessellation};
use sx_geom::exact as table;
use sx_geom::face::{self, Operation};
use sx_geom::faces;
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::exact::{self, Kind, Part};
use sx_geom::sketch_loft::{self, Curve, Density, Match, Options, Profile, Rails};
use sx_geom::sketch_spline;
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
        "loft: an exact loft is made only through profiles of straight lines and splines for now; these have an arc, a circle or an ellipse"
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
            "An exact loft is made only through profiles of straight lines and splines for now; these have an arc, a circle or an ellipse.",
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

/// Lofts through sections of a straight top and a spline below: three D sections, and the 18 sections of a hull
/// drawn by hand (its stations with a straight deck and a spline from deck edge to deck edge through the keel).
const SPLINE_LOFTS: &str = include_str!("fixtures/exact-loft-splines.json");

fn spline_loft(name: &str) -> Value {
    let all: Value = serde_json::from_str(SPLINE_LOFTS).unwrap();
    all[name].clone()
}

/// The profiles and options of a loft request.
fn request_parts(request: &Value) -> (Vec<Profile>, Options) {
    let opts = json!({ "smooth": request["smooth"].as_bool().unwrap_or(false) });
    parsed(&request["profiles"], &opts)
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    Sha256::digest(bytes).iter().fold(String::new(), |mut hex, b| {
        let _ = write!(hex, "{b:02x}");
        hex
    })
}

#[test]
fn the_mesh_loft_of_spline_sections_is_the_same_to_the_byte() {
    // the replies before spline pieces were matched, recorded from the code the change starts from
    let circle = json!({ "type": "circle", "center": [0, 0], "diameterMm": 20.0 });
    let spline = json!({ "type": "spline", "points": [[10, 0], [0, 8], [-10, 0], [0, -8]] });
    for (name, request, want) in [
        (
            "D sections",
            spline_loft("dSections"),
            "4bd25dd36c211d3cc0f592fac23df379ac2bc67208ec653707157ba609b97f9a",
        ),
        (
            "hull of 18 sections",
            spline_loft("hull18"),
            "938b933be5b10ea85366f0692fb991bf554380f7b74d5764715450762a95f5df",
        ),
        (
            "circle to a closed spline",
            json!({ "profiles": [level(0.0, &circle), level(20.0, &spline)] }),
            "aa6f0c1dcb856151e03f0eb3d98d53e5069bae7b96cd40e4d2c8c6d0f6e91f5b",
        ),
    ] {
        let reply = sx_geom::json::call("sketch.loft", &request.to_string()).unwrap();
        assert_eq!(sha256(reply.as_bytes()), want, "{name}");
    }
}

/// The points of a section as drawn, in space: its straight piece and its spline, each piece cut into `per` steps.
fn drawn_section(section: &Value, per: usize) -> Vec<V3> {
    let v3 = |v: &Value| -> V3 { [0, 1, 2].map(|i| v[i].as_f64().unwrap()) };
    let v2 = |v: &Value| -> [f64; 2] { [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()] };
    let frame = &section["frame"];
    let (origin, u, v) = (v3(&frame["origin"]), v3(&frame["u"]), v3(&frame["v"]));
    let lp = &section["loops"][0];
    let segments = lp["segments"].as_array().unwrap();
    let start = v2(&segments[0]["to"]);
    let spline = &segments[1];
    let mut through = vec![start];
    through.extend(spline["points"].as_array().unwrap().iter().map(v2));
    through.push(v2(&spline["to"]));
    // the straight piece from the loop's start, then the spline back to it
    let top = v2(&lp["start"]);
    #[allow(clippy::cast_precision_loss, reason = "a step count")]
    let mut flat: Vec<[f64; 2]> = (0..=per)
        .map(|i| {
            let f = i as f64 / per as f64;
            [top[0] + (start[0] - top[0]) * f, top[1] + (start[1] - top[1]) * f]
        })
        .collect();
    for b in sketch_spline::spans(&through, false) {
        flat.extend(sketch_spline::flatten(&b, per));
    }
    flat.iter()
        .map(|p| vec3::add(origin, vec3::add(vec3::scale(u, p[0]), vec3::scale(v, p[1]))))
        .collect()
}

/// The farthest any of `points` is from the triangles `triangles` over `positions`. The triangles are filed in a
/// grid of `cell` mm, and the cells are searched outward from each point until no unsearched cell could hold a
/// nearer triangle.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "grid cells of a body a few hundred mm across"
)]
fn farthest_from(points: &[V3], positions: &[V3], triangles: &[[u32; 3]], cell: f64) -> f64 {
    use std::collections::HashMap;
    let key = |p: V3| p.map(|c| (c / cell).floor() as i64);
    let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    for (i, t) in triangles.iter().enumerate() {
        let corners = t.map(|v| positions[v as usize]);
        let (lo, hi) = (
            key([0, 1, 2].map(|a| corners.iter().map(|c| c[a]).fold(f64::INFINITY, f64::min))),
            key([0, 1, 2].map(|a| corners.iter().map(|c| c[a]).fold(f64::NEG_INFINITY, f64::max))),
        );
        for x in lo[0]..=hi[0] {
            for y in lo[1]..=hi[1] {
                for z in lo[2]..=hi[2] {
                    grid.entry([x, y, z]).or_default().push(i);
                }
            }
        }
    }
    let near = |p: V3| -> f64 {
        let at = key(p);
        let mut best = f64::INFINITY;
        for r in 0_i64..1000 {
            for x in -r..=r {
                for y in -r..=r {
                    for z in -r..=r {
                        if x.abs().max(y.abs()).max(z.abs()) != r {
                            continue;
                        }
                        for &i in grid.get(&[at[0] + x, at[1] + y, at[2] + z]).into_iter().flatten() {
                            let [a, b, c] = triangles[i].map(|v| positions[v as usize]);
                            let q = sx_geom::hollow::closest_point_on_triangle(p, a, b, c);
                            best = best.min(vec3::len(vec3::sub(q, p)));
                        }
                    }
                }
            }
            // any triangle not yet searched is more than r cells away
            if best <= r as f64 * cell {
                break;
            }
        }
        best
    };
    points.iter().map(|&p| near(p)).fold(0.0, f64::max)
}

/// Whether the mesh loft is the reference an exact loft of `profiles` is held to. The mesh loft flattens every
/// section into a ring of points and joins the rings point for point by count. Where a section is straight lines
/// alone, or one whole circle or ellipse, that keeps each corner on the corners of the sections beside it (or there
/// is no corner), so its sides are the loft's own. Where a section mixes corners with curves, the curves flatten to
/// different counts on different sections and the mesh loft joins a corner of one section to a point along the curve
/// of the next, so its side leans off the corners between sections. There the exact loft is held to the drawing: the
/// sections as drawn at their stations, and its corner rails, which join the drawn corners as the loft defines them.
fn mesh_loft_keeps_corners(profiles: &Value) -> bool {
    profiles.as_array().unwrap().iter().all(|p| {
        p["loops"].as_array().unwrap().iter().all(|lp| {
            let kind = lp["type"].as_str().unwrap_or("path");
            let segments = lp["segments"].as_array().map_or(&[][..], Vec::as_slice);
            matches!(kind, "circle" | "ellipse") || segments.iter().all(|s| s["type"] == "line")
        })
    })
}

/// The farthest any of `points` is from the nearest of a body's edges, by each edge's own curve.
fn farthest_from_edges(points: &[V3], edges: &[sx_brep::Edge<'_>]) -> f64 {
    points
        .iter()
        .map(|&p| {
            edges
                .iter()
                .map(|edge| edge.distance_to(p).expect("a distance"))
                .fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max)
}

/// How far the exact body of a loft is from its mesh loft, each way.
struct Measured {
    body_to_mesh: f64,
}

/// Every corner rail of `rails` runs from drawn corner to drawn corner of `sections`, and the body's deck edges lie
/// on it within 0.01 mm all along it, not only at the sections; says how far, in mm.
fn corner_rails_checked(name: &str, rails: &Rails, sections: &[Value], edges: &[sx_brep::Edge<'_>]) -> f64 {
    let mut rail_to_edges = 0.0f64;
    for piece in &rails.pieces {
        let rail = &rails.rails[piece.first % rails.rails.len()];
        for (k, ring) in rails.rings.iter().enumerate() {
            let at = if k < rail.len() {
                rail[k][0]
            } else {
                rail[k - 1][3]
            };
            assert!(
                ring.corners[piece.first],
                "{name}: rail {} is no corner on section {}",
                piece.first,
                k + 1
            );
            assert_eq!(
                at.map(f64::to_bits),
                ring.points[piece.first].map(f64::to_bits),
                "{name}"
            );
            let corner = ring.flat[piece.first];
            let section = &sections[k]["loops"][0];
            let drawn: Vec<[f64; 2]> = [&section["start"], &section["segments"][0]["to"]]
                .iter()
                .map(|v| [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()])
                .collect();
            assert!(
                drawn
                    .iter()
                    .any(|d| vec3::len([d[0] - corner[0], d[1] - corner[1], 0.0]) <= 1e-12),
                "{name}"
            );
        }
        let along: Vec<V3> = rail
            .iter()
            .flat_map(|b| (0..64).map(move |i| bezier_at(b, f64::from(i) / 64.0)))
            .chain(rail.last().map(|b| b[3]))
            .collect();
        rail_to_edges = rail_to_edges.max(farthest_from_edges(&along, edges));
    }
    assert!(rail_to_edges <= sx_brep::DRAWN_MM, "{name}: {rail_to_edges} mm");
    rail_to_edges
}

/// The exact loft of `request`, a loft of sections each a straight top and a spline below, checked against its
/// drawing:
/// - a solid with its edges on the curves its faces were given;
/// - each straight piece's side a ruled face (a deck stays flat), each spline piece's side skinned, the ends flat;
/// - every drawn section within 0.01 mm of the body at its station;
/// - every corner rail running from drawn corner to drawn corner, and the body's deck edges on those rails within
///   0.01 mm all along them, not only at the stations.
///
/// Says how far the body, the mesh loft and the drawn sections are from each other, and gives the distances to the
/// mesh loft. Those are held here only where the mesh loft keeps corners ([`mesh_loft_keeps_corners`]).
fn spline_loft_checked(name: &str, request: &Value) -> Measured {
    let (profiles, opts) = request_parts(request);
    let lofted = exact::lofted_through(&profiles, &opts, &Density::default(), exact::MOST_DOUBLINGS)
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    let rails = &lofted.rails;
    let size = rails
        .rings
        .iter()
        .flat_map(|r| r.points.iter().flatten())
        .fold(1.0f64, |m, c| m.max(c.abs()));
    println!(
        "EDGES {name}: the edges are {:e} mm from the curves given; drawn sections {:e} mm off at the stations as read \
         back, after {} doublings",
        lofted.off_mm, lofted.drawn_mm, lofted.doublings
    );
    assert!(lofted.off_mm <= 1e-9 * size, "{name}: {:e} mm", lofted.off_mm);
    assert!(
        lofted.drawn_mm <= sx_brep::DRAWN_MM,
        "{name}: {} mm",
        lofted.drawn_mm
    );
    assert_eq!(lofted.kinds.len(), lofted.parts.len());
    for (part, kind) in lofted.parts.iter().zip(&lofted.kinds) {
        let want = match *part {
            Part::Side(k) if rails.pieces[k].curves.iter().all(|c| *c == Curve::Line) => Kind::Ruled,
            Part::Side(k) => {
                assert!(
                    rails.pieces[k]
                        .curves
                        .iter()
                        .all(|c| matches!(c, Curve::Spline { .. })),
                    "{name}"
                );
                Kind::Skinned
            }
            Part::First | Part::Last => Kind::Flat,
        };
        assert_eq!(*kind, want, "{name}: {part:?}");
    }
    let volume = lofted.body.volume().expect("volume");
    assert!(volume > 0.0, "{name}: {volume}");
    // distances to the body are the kernel's own, from each point to the nearest point of the body's surface
    let to_body = |points: &[V3]| -> f64 {
        points
            .iter()
            .map(|&p| lofted.body.distance_to(p).expect("a distance"))
            .fold(0.0, f64::max)
    };
    let cell = 0.5;
    // every drawn section at its station
    let sections = request["profiles"].as_array().unwrap();
    let mut drawn_to_body = 0.0f64;
    for (k, section) in sections.iter().enumerate() {
        let off = to_body(&drawn_section(section, 256));
        assert!(
            off <= sx_brep::DRAWN_MM,
            "{name}: section {} is {off} mm off the body",
            k + 1
        );
        drawn_to_body = drawn_to_body.max(off);
    }
    let edges = lofted.body.edges().expect("edges");
    let rail_to_edges = corner_rails_checked(name, rails, sections, &edges);
    let mesh = sketch_loft::loft_with(&profiles, &opts).unwrap();
    let mesh_to_body = to_body(&mesh.positions);
    // the kernel's own triangles, fine enough to measure to a hundredth of a millimeter, checked by their volume.
    // They are for measuring only and not held to their chord
    let body = lofted
        .body
        .tessellate_as_made(&Tessellation {
            chord_mm: 1e-4,
            max_edge_mm: 0.25,
            ..Tessellation::default()
        })
        .expect("a mesh");
    let tessellated: f64 = body
        .triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|v| body.positions[v as usize]);
            vec3::dot(a, vec3::cross(b, c)) / 6.0
        })
        .sum();
    assert!(
        (tessellated - volume).abs() <= 1e-4 * volume,
        "{name}: {tessellated} against {volume}"
    );
    let body_to_mesh = farthest_from(&body.positions, &mesh.positions, &mesh.triangles, cell);
    let drawn: Vec<V3> = sections.iter().flat_map(|s| drawn_section(s, 256)).collect();
    let drawn_to_mesh = farthest_from(&drawn, &mesh.positions, &mesh.triangles, cell);
    println!(
        "DIST {name}: drawn sections to body {drawn_to_body:.6} mm, corner rails to the body's edges \
         {rail_to_edges:.6} mm, body to mesh loft {body_to_mesh:.6} mm, mesh loft to body {mesh_to_body:.6} mm, \
         drawn sections to mesh loft {drawn_to_mesh:.6} mm, volume {volume:.6} mm3"
    );
    if mesh_loft_keeps_corners(&request["profiles"]) {
        assert!(body_to_mesh <= 0.01 && mesh_to_body <= 0.01, "{name}");
    }
    Measured { body_to_mesh }
}

#[test]
fn d_sections_loft_into_a_solid_held_to_their_drawing() {
    if !sx_brep::KERNEL {
        return;
    }
    let mut request = spline_loft("dSections");
    assert!(!mesh_loft_keeps_corners(&request["profiles"]));
    let straight = spline_loft_checked("D sections, straight", &request);
    // A record of the mesh loft missing the corners, as measured on 2026-11-12: it joins station 2's deck corner
    // (8, 0, 12) to points on station 1's spline, so the body's deck edge, which runs corner to corner, is this far
    // from it between the stations. A later piece makes the mesh loft keep corners; then this becomes the normal
    // rule, within 0.01 mm both ways.
    assert!(
        (0.70..=0.76).contains(&straight.body_to_mesh),
        "the mesh loft misses the corners by {} mm, not about 0.729",
        straight.body_to_mesh
    );
    request["smooth"] = json!(true);
    spline_loft_checked("D sections, smooth", &request);
}

#[test]
fn a_hull_of_18_hand_drawn_sections_lofts_into_a_solid_held_to_its_drawing() {
    if !sx_brep::KERNEL {
        return;
    }
    let request = spline_loft("hull18");
    assert!(!mesh_loft_keeps_corners(&request["profiles"]));
    spline_loft_checked("hull of 18 sections", &request);
}

#[test]
fn a_loft_too_coarse_to_hold_its_drawing_is_refused_in_words() {
    if !sx_brep::KERNEL {
        return;
    }
    let (profiles, opts) = request_parts(&spline_loft("dSections"));
    // two rails a piece and no doubling: the spline's skin cuts straight across its bend
    let coarse = Density {
        arc_step_deg: 180.0,
        least: 2,
    };
    let start = table::count();
    assert_eq!(
        exact::lofted_through(&profiles, &opts, &coarse, 0)
            .expect_err("a refusal")
            .to_string(),
        "loft: the exact solid came out more than 0.01 mm from a drawn section"
    );
    assert_eq!(table::count(), start);
    // allowed to double, the same rails come close enough
    let doubled = exact::lofted_through(&profiles, &opts, &coarse, 6).expect("doubled until it holds");
    assert!(doubled.doublings > 0 && doubled.drawn_mm <= sx_brep::DRAWN_MM);
}

/// What a body's triangles are held to at a chord: every triangle's middle and the middle of each of its sides is
/// within the chord of the triangle's own face, the mesh is closed, every point on an edge of the body is on that
/// edge's curve, and every corner normal is a unit vector on the side its triangle faces. Answers the triangle
/// count and the farthest any sample is from its face.
fn held_to_its_chord(name: &str, body: &sx_brep::Body, chord: f64) -> (usize, f64) {
    let how = Tessellation {
        chord_mm: chord,
        ..Tessellation::default()
    };
    let started = std::time::Instant::now();
    let mesh = body.tessellate(&how).unwrap_or_else(|e| panic!("{name}: {e}"));
    println!(
        "CHORD {name} at {chord}: {} triangles in {:.0} ms",
        mesh.triangles.len(),
        started.elapsed().as_secs_f64() * 1e3
    );
    within_its_chord(name, body, &mesh, chord)
}

fn within_its_chord(name: &str, body: &sx_brep::Body, mesh: &sx_brep::Mesh, chord: f64) -> (usize, f64) {
    use std::collections::HashMap;
    let edges = body.edges().unwrap();
    let at = |v: u32| mesh.positions[v as usize];
    let mut users: HashMap<(u32, u32), usize> = HashMap::new();
    for triangle in &mesh.triangles {
        for k in 0..3 {
            let (from, to) = (triangle[k], triangle[(k + 1) % 3]);
            *users.entry((from.min(to), from.max(to))).or_default() += 1;
        }
    }
    assert!(users.values().all(|&n| n == 2), "{name}: the mesh is not closed");
    let (worst, face, sample) = farthest_off_its_faces(body, mesh, chord);
    assert!(
        worst <= chord,
        "{name}: a triangle of face {face} is {worst:e} mm from it at {sample:?}"
    );
    for (triangle, normals) in mesh.triangles.iter().zip(&mesh.normals) {
        let [pa, pb, pc] = triangle.map(at);
        if let Some(normals) = normals {
            let winding = vec3::cross(vec3::sub(pb, pa), vec3::sub(pc, pa));
            for n in normals {
                assert!(
                    (vec3::len(*n) - 1.0).abs() <= 1e-9,
                    "{name}: a normal of length {}",
                    vec3::len(*n)
                );
                assert!(
                    vec3::dot(*n, winding) > 0.0,
                    "{name}: a normal against its triangle"
                );
            }
        }
    }
    let size = mesh
        .positions
        .iter()
        .flatten()
        .fold(1.0_f64, |most, c| most.max(c.abs()));
    for (edge, run) in edges.iter().zip(&mesh.edges) {
        for &v in &run.points {
            let off = edge.distance_to(at(v)).unwrap();
            assert!(off <= 1e-9 * size, "{name}: a point {off:e} mm off its edge");
        }
    }
    println!("CHORD {name} at {chord}: farthest {worst:.5} mm");
    (mesh.triangles.len(), worst)
}

// the triangles of a lofted body are within the chord asked of every one of its faces. The kernel alone leaves the
// two sides that narrow to the bow five times too coarse, whatever chord it is asked for
#[test]
fn a_loft_s_triangles_are_within_the_chord_asked() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let lofted = |profiles: &Value| -> u32 {
        let request = json!({ "profiles": profiles, "smooth": true, "exact": true });
        let reply: Value = serde_json::from_str(&op("sketch.loft", &request)).unwrap();
        u32::try_from(reply["body"].as_u64().expect("a body")).unwrap()
    };
    // a tight turn between two flatter stretches, as a bilge has
    let bilge = json!([
        level(0.0, &rectangle(20.0, 10.0)),
        level(10.0, &rectangle(20.0, 10.0)),
        level(11.0, &rectangle(22.0, 11.0)),
        level(12.0, &rectangle(24.0, 12.0)),
        level(22.0, &rectangle(24.0, 12.0))
    ]);
    // sides that narrow almost to a point, as a bow does
    let bow = json!([
        level(0.0, &rectangle(20.0, 10.0)),
        level(15.0, &rectangle(12.0, 6.0)),
        level(30.0, &rectangle(0.2, 0.1))
    ]);
    for (name, profiles) in [("hull", hull()), ("bilge", bilge), ("bow", bow)] {
        let body = lofted(&profiles);
        table::with(body, |held| {
            let (coarse, _) = held_to_its_chord(name, &held.body, 0.01);
            let (fine, _) = held_to_its_chord(name, &held.body, 0.002);
            assert!(
                fine >= coarse,
                "{name}: {fine} triangles at a fifth of the chord, {coarse} at the chord"
            );
        })
        .expect("held");
        assert_eq!(op("brep.free", &json!({ "body": body })), r#"{"freed":true}"#);
    }
    assert_eq!(table::count(), start);
}

/// A body's triangles at the default chord are within it of every face, or the body is refused in words when
/// bringing them there passes the limits tessellation keeps: never triangles that miss.
fn within_its_chord_or_refused(name: &str, body: &sx_brep::Body) {
    let how = Tessellation::default();
    let started = std::time::Instant::now();
    match body.tessellate(&how) {
        Ok(mesh) => {
            println!(
                "CHORD {name}: {} triangles in {:.0} ms",
                mesh.triangles.len(),
                started.elapsed().as_secs_f64() * 1e3
            );
            within_its_chord(name, body, &mesh, how.chord_mm);
        }
        Err(refused) => {
            let said = refused.to_string();
            println!(
                "CHORD {name}: refused in {:.0} ms: {said}",
                started.elapsed().as_secs_f64() * 1e3
            );
            assert!(
                said.starts_with("tessellate: the triangles stay ")
                    && said.ends_with(" mm asked for; ask for a larger chord"),
                "{said}"
            );
        }
    }
}

// one spline face wraps the hull drawn by hand, and the kernel's triangles of it are three times past the chord in
// places. Asked for exact, the loft is a body whose triangles are within the chord, or it is the mesh loft to the
// byte and says why
#[test]
fn the_drawn_hull_is_a_body_within_the_chord_or_a_mesh_loft_that_says_why() {
    if !sx_brep::KERNEL {
        return;
    }
    let start = table::count();
    let mut request = spline_loft("hull18");
    request.as_object_mut().expect("a request").remove("exact");
    let plain = sx_geom::json::call("sketch.loft", &request.to_string()).expect("the mesh loft");
    request["exact"] = json!(true);
    let asked = sx_geom::json::call("sketch.loft", &request.to_string()).expect("the loft");
    let reply: Value = serde_json::from_str(&asked).unwrap();
    if let Some(body) = reply["body"].as_u64() {
        let body = u32::try_from(body).unwrap();
        println!("CHORD drawn hull: an exact body");
        table::with(body, |held| within_its_chord_or_refused("drawn hull", &held.body)).expect("held");
        assert_eq!(op("brep.free", &json!({ "body": body })), r#"{"freed":true}"#);
    } else {
        println!("CHORD drawn hull: {}", reply["exact"]);
        assert_eq!(
            reply["exact"],
            json!({
                "made": false,
                "why": "The exact solid could not be shown within 0.01 mm of its surface, so this loft was made as a mesh."
            })
        );
        assert!(reply.get("body").is_none() && reply.get("bodySmb").is_none());
        assert_eq!(without(&asked, &printed(&reply, "exact")), plain);
    }
    assert_eq!(table::count(), start);
}

// the hull drawn by hand is thinner than the chord at its bow: its two sides are a few hundredths of a millimeter
// apart there. The face's own closest point then answers with a point of the far side, even for a point of the
// surface itself, so a triangle is measured by the nearer of two points of the face: that one, and the surface's
// point at the triangle's own place
#[test]
fn a_body_thinner_than_the_chord_is_measured_by_the_nearer_of_two_points_of_its_face() {
    if !sx_brep::KERNEL {
        return;
    }
    let request = spline_loft("hull18");
    let (profiles, opts) = request_parts(&request);
    let drawn = exact::lofted_through(&profiles, &opts, &Density::default(), exact::MOST_DOUBLINGS)
        .expect("the drawn hull");
    let chord = Tessellation::default().chord_mm;
    let faces = drawn.body.faces().unwrap();
    // the kernel's own triangles: places the closest point calls past the chord and the surface's own point does not
    let made = drawn
        .body
        .tessellate_as_made(&Tessellation::default())
        .expect("a mesh");
    let mut thin = 0;
    for (face, sample, on) in sampled(&made) {
        let Some((points, places, shares)) = on else {
            continue;
        };
        let face = faces[face as usize];
        if face.distance_to(sample).unwrap() <= chord || off_its_face(face, sample, chord, on, &[]) > chord {
            continue;
        }
        thin += 1;
        // the triangle's corners are the surface's points at their places, so the places are the face's own
        let middle = [0, 1].map(|k| (places[0][k] + places[1][k] + places[2][k]) / 3.0);
        let inward = places.map(|uv| [0, 1].map(|k| uv[k] + (middle[k] - uv[k]) * 1e-9));
        for (corner, place) in points.iter().zip(inward) {
            let there = face.point_at(place).expect("a corner's place");
            assert!(
                vec3::len(vec3::sub(there, *corner)) <= 1e-6,
                "{corner:?} at {place:?}"
            );
        }
        // the surface's point at the sample's own share of those places is a point of the face, and within the
        // chord of the sample
        let uv = [0, 1].map(|k| {
            inward[0][k]
                + shares[0] * (inward[1][k] - inward[0][k])
                + shares[1] * (inward[2][k] - inward[0][k])
        });
        let there = face.point_at(uv).expect("a place inside the triangle");
        let near = vec3::len(vec3::sub(there, sample));
        if near <= chord {
            // a record of the kernel's answer as measured on 2026-11-12, not a rule: asked how far that point of
            // the surface is from the face, it is not always 0, and asked about the sample it is past the chord
            println!(
                "THIN at {sample:?}: the surface's own point is {near:.5} mm away; the closest point says {:.5} mm, \
                 and {:e} mm for the surface's point itself",
                face.distance_to(sample).unwrap(),
                face.distance_to(there).unwrap()
            );
        }
    }
    assert!(thin > 0, "no place of the hull reads as thin now");
    println!("THIN {thin} places are within the chord by the surface's point and not by the closest point");
    // held to the chord, every triangle is within it by the nearer of the two, or the hull is refused in words
    within_its_chord_or_refused("drawn hull", &drawn.body);
}

// triangles as the kernel made them can miss their chord, so they are for measuring only: nothing in the engine's
// source asks for them
#[test]
fn no_operation_takes_triangles_as_the_kernel_made_them() {
    fn sources(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("a source folder").flatten() {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    sources(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    assert!(files.len() > 10, "{} source files", files.len());
    for file in files {
        let text = std::fs::read_to_string(&file).expect("a source file");
        assert!(!text.contains("tessellate_as_made"), "{}", file.display());
    }
}
