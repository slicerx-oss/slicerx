// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft as an exact solid: the faces the kernel makes from the loft's rails, the volume they close, how far they
// are from the rails' own surface, and the body kept in the engine's table. Empty without the brep feature, so a
// workspace test run that names every test target passes over it.
#![cfg(feature = "brep")]
use serde_json::{Value, json};
use sx_brep::{Surface, Tessellation};
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
        let s = (g.floor() as usize).min(spans - 1);
        #[allow(clippy::cast_precision_loss, reason = "a span count")]
        let t = g - s as f64;
        let (pa, pb) = (bezier_at(&a[s], t), bezier_at(&b[s], t));
        let across = vec3::sub(pb, pa);
        let v = (vec3::dot(vec3::sub(p, pa), across) / vec3::dot(across, across)).clamp(0.0, 1.0);
        vec3::len(vec3::sub(vec3::add(pa, vec3::scale(across, v)), p))
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
