// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft as an exact solid: the faces the kernel makes from the loft's rails, the volume they close, how far they
// are from the rails' own surface, and the body kept in the engine's table. Empty without the brep feature, so a
// workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use std::f64::consts::TAU;
use sx_brep::{Surface, Tessellation};
use sx_geom::face::{self, Operation};
use sx_geom::faces;
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::exact::{self, Part, table};
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
    assert!((volume - 71_826.331_984).abs() < 1e-3, "{volume}");
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

/// The plane each flat face of a body faces out along, as a unit normal and its offset, from the body's triangles
/// (counterclockwise seen from outside); none for a face that is not flat.
fn planes(mesh: &sx_brep::Mesh) -> Vec<Option<(V3, f64)>> {
    let mut out = vec![None; mesh.surfaces.len()];
    for (triangle, &face) in mesh.triangles.iter().zip(&mesh.faces) {
        let face = face as usize;
        if out[face].is_some() || !matches!(mesh.surfaces[face], Surface::Plane { .. }) {
            continue;
        }
        let [a, b, c] = triangle.map(|v| mesh.positions[v as usize]);
        if let Some(normal) = vec3::normalize(vec3::cross(vec3::sub(b, a), vec3::sub(c, a))) {
            out[face] = Some((normal, vec3::dot(normal, a)));
        }
    }
    out
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
    assert!(table::is_handle(u64::from(handle)));
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
    let mut ends = 0;
    for (plane, key) in planes.iter().zip(&keys) {
        match plane {
            // the two ends are the mesh loft's ends
            Some(plane) => {
                assert_eq!(key_on(&mesh, *plane), Some(*key), "{plane:?}");
                ends += 1;
            }
            // the mesh loft has no face that runs the whole length of one side: it cuts its sides between profiles
            None => assert!(!mesh_keys.contains(key)),
        }
    }
    assert_eq!(ends, 2);
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
            assert!((volume - measured).abs() < 0.05, "{volume}");
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
        "loft: profile 2 has a spline, which has no pieces to match"
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
        let why = exact::hold(rails, &mut mesh).expect_err("a refusal").to_string();
        assert_eq!(exact::lofted(rails).expect_err("a refusal").to_string(), why);
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
    // a rail that ends off the last section: two sides no longer meet the end, and the faces do not close
    let mut open = hull_rails.clone();
    let last = open.rails[2].len() - 1;
    open.rails[2][last][3][0] += 1.0;
    assert_eq!(
        refused(&open),
        "loft: stitch: the result is not a solid: its faces do not close"
    );
    assert_eq!(table::count(), start);
}
