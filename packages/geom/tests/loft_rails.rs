// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the mesh loft's output held bit for bit, and the rails and matched pieces a loft hands out

#![cfg(feature = "cad")]
#![allow(clippy::many_single_char_names, reason = "points and sizes of test geometry")]
#![allow(clippy::cast_precision_loss, reason = "small counts")]

use serde_json::{Value, json};
use std::f64::consts::{FRAC_PI_2, TAU};
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::{self, Curve, Density, Match, Options, Profile, Rails};
use sx_geom::sketch_spline;
use sx_geom::vec3::{self, V3};

fn level(z: f64) -> Value {
    json!({ "origin": [0, 0, z], "normal": [0, 0, 1], "u": [1, 0, 0], "v": [0, 1, 0] })
}

fn at(z: f64, lp: &Value) -> Value {
    json!({ "frame": level(z), "loops": [lp] })
}

fn circle(c: [f64; 2], d: f64) -> Value {
    json!({ "type": "circle", "center": c, "diameterMm": d })
}

fn ellipse(w: f64, h: f64) -> Value {
    json!({ "type": "ellipse", "center": [0, 0], "widthMm": w, "heightMm": h })
}

fn square(c: [f64; 2], s: f64) -> Value {
    let h = s / 2.0;
    json!({ "points": [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h]] })
}

/// a polygon of `n` corners on a circle of radius `r`, the first on +x
fn polygon(n: u32, r: f64) -> Value {
    let pts: Vec<[f64; 2]> = (0..n)
        .map(|i| {
            let (s, c) = (TAU * f64::from(i) / f64::from(n)).m_sin_cos();
            [r * c, r * s]
        })
        .collect();
    json!({ "points": pts })
}

/// a `w` by `h` rectangle about the origin with its corners rounded at `r`: four lines and four arcs
fn rounded(w: f64, h: f64, r: f64) -> Value {
    let (x, y) = (w / 2.0, h / 2.0);
    let arc = |to: [f64; 2]| json!({ "type": "arc", "to": to, "radiusMm": r });
    let line = |to: [f64; 2]| json!({ "type": "line", "to": to });
    json!({
        "start": [-x + r, -y],
        "segments": [
            line([x - r, -y]), arc([x, -y + r]),
            line([x, y - r]), arc([x - r, y]),
            line([-x + r, y]), arc([-x, y - r]),
            line([-x, -y + r]), arc([-x + r, -y]),
        ],
    })
}

/// seven stations of a hull across x, six points each
fn hull() -> Value {
    let rows: [(f64, [f64; 6]); 7] = [
        (0.0, [2.5, 4.5, 6.3, 14.0, 0.0, 0.0]),
        (25.0, [5.5, 10.0, 8.1, 18.0, 0.0, 0.0]),
        (70.0, [6.3, 11.45, 9.3, 20.7, 0.0, 0.0]),
        (110.0, [6.3, 11.45, 9.3, 20.7, 0.0, 0.0]),
        (150.0, [5.8, 10.5, 9.0, 20.0, 0.0, 0.0]),
        (195.0, [2.8, 5.0, 8.6, 19.0, 0.0, 0.0]),
        (217.6, [0.5, 0.8, 8.1, 18.0, 0.0, 0.0]),
    ];
    let stations: Vec<Value> = rows
        .iter()
        .map(|&(x, [keel, beam, chine, deck, ..])| {
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

/// a hull half-section across x with a round bilge of radius `r`, and its landmarks when `marked`
fn station(x: f64, b: f64, d: f64, r: f64, marked: bool) -> Value {
    let mut pts = vec![[0.0, 0.0], [0.0, -d], [b - r, -d]];
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "small counts"
    )]
    let segs = (4.0 * r).ceil().max(2.0) as u32;
    for j in 1..segs {
        let (s, c) = (FRAC_PI_2 * (f64::from(j) / f64::from(segs) - 1.0)).m_sin_cos();
        pts.push([b - r + r * c, -d + r + r * s]);
    }
    pts.extend([[b, -d + r], [b, 0.0]]);
    let marks: Vec<[f64; 2]> = if marked {
        vec![
            [0.0, 0.0],
            [0.0, -d],
            [b - r, -d],
            [b, -d + r],
            [b, -0.4 * d],
            [b, 0.0],
        ]
    } else {
        Vec::new()
    };
    json!({
        "frame": { "origin": [x, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1] },
        "loops": [{ "points": pts }],
        "landmarks": marks,
    })
}

fn bilge_hull(marked: bool) -> Value {
    let rows = [
        (0.0, 3.0, 6.0, 1.0),
        (20.0, 8.0, 8.0, 3.0),
        (40.0, 12.0, 9.0, 5.0),
        (60.0, 12.0, 9.0, 5.0),
        (80.0, 7.0, 7.0, 2.5),
    ];
    Value::Array(
        rows.iter()
            .map(|&(x, b, d, r)| station(x, b, d, r, marked))
            .collect(),
    )
}

/// six squares around a circle of radius 40 about z, each on the plane through the axis
fn ring() -> Value {
    let sides = [10.0, 12.0, 14.0, 12.0, 10.0, 8.0];
    let lifts = [0.0, 3.0, 0.0, -3.0, 0.0, 2.0];
    let squares: Vec<Value> = (0..6u32)
        .map(|k| {
            let (s, c) = (TAU * f64::from(k) / 6.0).m_sin_cos();
            let i = k as usize;
            json!({
                "frame": {
                    "origin": [40.0 * c, 40.0 * s, lifts[i]],
                    "normal": [-s, c, 0],
                    "u": [c, s, 0],
                    "v": [0, 0, 1],
                },
                "loops": [square([0.0, 0.0], sides[i])],
            })
        })
        .collect();
    Value::Array(squares)
}

/// open chains one above another, each a bent strip
fn strips() -> Value {
    let chain = |z: f64, bow: f64| {
        json!({
            "frame": level(z),
            "loops": [{ "points": [[-10, 0], [-4, bow], [4, bow], [10, 0]] }],
            "open": true,
        })
    };
    json!([chain(0.0, 3.0), chain(10.0, 5.0), chain(22.0, 2.0)])
}

/// the mesh lofts whose output is held: a name, the profiles and the options
fn cases() -> Vec<(&'static str, Value, Value)> {
    let smooth = json!({ "smooth": true });
    let plain = json!({});
    vec![
        (
            "frustum",
            json!([
                at(0.0, &square([0.0, 0.0], 20.0)),
                at(10.0, &square([0.0, 0.0], 10.0))
            ]),
            plain.clone(),
        ),
        (
            "square to circle",
            json!([
                at(0.0, &square([0.0, 0.0], 20.0)),
                at(30.0, &circle([0.0, 0.0], 10.0))
            ]),
            plain.clone(),
        ),
        (
            "square to hexagon",
            json!([at(0.0, &square([0.0, 0.0], 20.0)), at(15.0, &polygon(6, 9.0))]),
            plain.clone(),
        ),
        (
            "tilted circle",
            json!([
                at(0.0, &square([0.0, 0.0], 16.0)),
                {
                    "frame": { "origin": [0, 0, 20], "normal": [0.6, 0, 0.8], "u": [0.8, 0, -0.6], "v": [0, 1, 0] },
                    "loops": [circle([0.0, 0.0], 12.0)],
                },
            ]),
            plain.clone(),
        ),
        ("hull", hull(), smooth.clone()),
        ("hull ruled", hull(), plain.clone()),
        ("bilge hull landmarked", bilge_hull(true), smooth.clone()),
        ("bilge hull by count", bilge_hull(false), smooth.clone()),
        ("ring", ring(), json!({ "smooth": true, "closed": true })),
        ("ring ruled", ring(), json!({ "closed": true })),
        (
            "circles",
            json!([
                at(0.0, &circle([0.0, 0.0], 20.0)),
                at(15.0, &circle([0.0, 0.0], 30.0)),
                at(30.0, &circle([0.0, 0.0], 20.0)),
                at(45.0, &circle([0.0, 0.0], 24.0)),
            ]),
            smooth.clone(),
        ),
        (
            "ellipses and circles",
            json!([
                at(0.0, &ellipse(30.0, 16.0)),
                at(20.0, &circle([0.0, 0.0], 24.0)),
                at(40.0, &ellipse(20.0, 28.0)),
                at(60.0, &circle([0.0, 0.0], 20.0)),
            ]),
            smooth.clone(),
        ),
        (
            "rounded rectangles",
            json!([
                at(0.0, &rounded(40.0, 24.0, 6.0)),
                at(20.0, &rounded(30.0, 20.0, 4.0)),
                at(40.0, &rounded(36.0, 28.0, 8.0)),
                at(60.0, &rounded(34.0, 22.0, 5.0)),
            ]),
            smooth.clone(),
        ),
        (
            "hexagons and circles",
            json!([
                at(0.0, &polygon(6, 12.0)),
                at(20.0, &circle([0.0, 0.0], 24.0)),
                at(40.0, &polygon(6, 10.0)),
                at(60.0, &circle([0.0, 0.0], 18.0)),
            ]),
            smooth.clone(),
        ),
        (
            "strips thickened",
            strips(),
            json!({ "smooth": true, "thicken": { "thicknessMm": 1.5 } }),
        ),
    ]
}

/// FNV-1a over 64 bits
struct Hash(u64);

impl Hash {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 = (self.0 ^ u64::from(x)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

/// every bit of a mesh: its positions, its triangles, each triangle's face and the face table
fn mesh_hash(m: &TriMesh) -> u64 {
    let mut h = Hash::new();
    h.bytes(&(m.positions.len() as u64).to_le_bytes());
    for p in &m.positions {
        for c in p {
            h.bytes(&c.to_bits().to_le_bytes());
        }
    }
    h.bytes(&(m.triangles.len() as u64).to_le_bytes());
    for t in &m.triangles {
        for i in t {
            h.bytes(&i.to_le_bytes());
        }
    }
    let f = m.faces.as_ref().expect("a loft tags its faces");
    for id in &f.ids {
        h.bytes(&id.to_le_bytes());
    }
    // the table's floats print as the shortest digits that read back the same, so the text holds their bits
    h.bytes(format!("{:?} {:?}", f.table, f.keys).as_bytes());
    h.0
}

fn mesh_of(profiles: &Value, opts: &Value) -> TriMesh {
    let profiles: Vec<Profile> = serde_json::from_value(profiles.clone()).unwrap();
    let opts: Options = serde_json::from_value(opts.clone()).unwrap();
    sketch_loft::loft_with(&profiles, &opts).unwrap()
}

/// What `mesh_hash` gave for each of `cases` before the loft's stages were shared with the rails.
const HELD: [(&str, u64); 15] = [
    ("frustum", 0x674f_9fe3_8fd1_41fb),
    ("square to circle", 0x2a5f_d5f6_2fea_644e),
    ("square to hexagon", 0xd453_1adb_b9a7_0962),
    ("tilted circle", 0x955d_4e6e_6d8e_1e66),
    ("hull", 0x6a99_3f8c_d0c6_4aac),
    ("hull ruled", 0xcd51_81a4_8e22_8045),
    ("bilge hull landmarked", 0x8e55_0e52_a394_af36),
    ("bilge hull by count", 0xb666_6260_3f95_37f1),
    ("ring", 0x2095_0f7b_d27a_48e5),
    ("ring ruled", 0xf99a_da7e_45fe_5732),
    ("circles", 0xee31_55f8_02a2_e0c1),
    ("ellipses and circles", 0xeb46_7534_b28b_447e),
    ("rounded rectangles", 0xfba8_e4e5_2b3e_f966),
    ("hexagons and circles", 0x063b_90fb_27b4_38d4),
    ("strips thickened", 0x8475_bda9_2a09_079d),
];

#[test]
fn mesh_lofts_keep_every_bit() {
    let got: Vec<(&str, u64)> = cases()
        .iter()
        .map(|(name, profiles, opts)| (*name, mesh_hash(&mesh_of(profiles, opts))))
        .collect();
    for (name, h) in &got {
        eprintln!("    (\"{name}\", 0x{h:016x}),");
    }
    assert_eq!(got, HELD);
}

fn match_of(profiles: &Value, opts: &Value, density: &Density) -> Match {
    let profiles: Vec<Profile> = serde_json::from_value(profiles.clone()).unwrap();
    let opts: Options = serde_json::from_value(opts.clone()).unwrap();
    sketch_loft::rails(&profiles, &opts, density).unwrap()
}

fn rails_of(profiles: &Value, opts: &Value) -> Rails {
    match match_of(profiles, opts, &Density::default()) {
        Match::Rails(r) => r,
        Match::Unmatched(why) => panic!("unmatched: {why}"),
    }
}

fn refused(profiles: &Value, opts: &Value) -> String {
    let profiles: Vec<Profile> = serde_json::from_value(profiles.clone()).unwrap();
    let opts: Options = serde_json::from_value(opts.clone()).unwrap();
    let mesh = sketch_loft::loft_with(&profiles, &opts).unwrap_err().to_string();
    let rails = sketch_loft::rails(&profiles, &opts, &Density::default())
        .unwrap_err()
        .to_string();
    assert_eq!(
        rails, mesh,
        "the rails and the mesh loft refuse in the same words"
    );
    rails
}

/// the point at `t` along a cubic, summed as the mesh loft sums it
fn bezier_at(b: &[V3; 4], t: f64) -> V3 {
    let u = 1.0 - t;
    let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
    (0..4).fold([0.0; 3], |s, k| vec3::add(s, vec3::scale(b[k], w[k])))
}

/// the rows the mesh loft cuts a span's curves into: enough to keep every chord within 0.005 mm
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a small count"
)]
fn span_rows(curves: &[[V3; 4]]) -> usize {
    let most = curves
        .iter()
        .map(|b| {
            let dd = |i: usize, j: usize, k: usize| {
                vec3::len(vec3::add(vec3::sub(b[i], vec3::scale(b[j], 2.0)), b[k]))
            };
            let most = 6.0 * dd(0, 1, 2).max(dd(1, 2, 3));
            (most / (8.0 * sketch_loft::SMOOTH_TOL_MM)).sqrt().ceil().max(1.0)
        })
        .fold(1.0f64, f64::max);
    most as usize
}

/// the rails sampled into rows: `per_span` rows a span, or as many as the mesh loft takes
fn rows_of(r: &Rails, per_span: Option<usize>) -> Vec<Vec<V3>> {
    let spans = r.rails[0].len();
    let mut rows = Vec::new();
    for s in 0..spans {
        let curves: Vec<[V3; 4]> = r.rails.iter().map(|rail| rail[s]).collect();
        let m = if r.smooth {
            per_span.unwrap_or_else(|| span_rows(&curves))
        } else {
            1
        };
        rows.push(r.rings[s].points.clone());
        for j in 1..m {
            let t = j as f64 / m as f64;
            rows.push(curves.iter().map(|b| bezier_at(b, t)).collect());
        }
    }
    if r.wrap.is_none() {
        rows.push(r.rings[spans].points.clone());
    }
    rows
}

/// the volume inside closed rows with flat ends: two triangles a quad, and a fan over each end
fn volume(rows: &[Vec<V3>]) -> f64 {
    let n = rows[0].len();
    let six = |a: V3, b: V3, c: V3| vec3::dot(a, vec3::cross(b, c));
    let mut v = 0.0;
    for k in 0..rows.len() - 1 {
        for i in 0..n {
            let (a0, a1) = (rows[k][i], rows[k][(i + 1) % n]);
            let (b0, b1) = (rows[k + 1][i], rows[k + 1][(i + 1) % n]);
            v += six(a0, a1, b1) + six(a0, b1, b0);
        }
    }
    let (first, last) = (&rows[0], &rows[rows.len() - 1]);
    for i in 1..n - 1 {
        v += six(first[0], first[i + 1], first[i]) + six(last[0], last[i], last[i + 1]);
    }
    (v / 6.0).abs()
}

fn bits(rows: &[Vec<V3>]) -> Vec<[u64; 3]> {
    rows.iter().flatten().map(|p| p.map(f64::to_bits)).collect()
}

#[test]
fn rails_are_the_curves_the_mesh_loft_samples() {
    let smooth = json!({ "smooth": true });
    let around = json!({ "smooth": true, "closed": true });
    for (name, profiles, opts) in [
        ("hull", hull(), smooth.clone()),
        ("hull ruled", hull(), json!({})),
        ("bilge hull landmarked", bilge_hull(true), smooth.clone()),
        ("bilge hull by count", bilge_hull(false), smooth.clone()),
        (
            "square to hexagon",
            json!([at(0.0, &square([0.0, 0.0], 20.0)), at(15.0, &polygon(6, 9.0))]),
            smooth,
        ),
        ("ring", ring(), around),
        ("ring ruled", ring(), json!({ "closed": true })),
    ] {
        let r = rails_of(&profiles, &opts);
        let mesh = mesh_of(&profiles, &opts);
        let mesh: Vec<[u64; 3]> = mesh.positions.iter().map(|p| p.map(f64::to_bits)).collect();
        assert_eq!(bits(&rows_of(&r, None)), mesh, "{name}");
        // lines alone: every stretch is its own piece
        assert_eq!(r.pieces.len(), r.rings[0].points.len(), "{name}");
        assert!(
            r.pieces
                .iter()
                .all(|p| p.stretches == 1 && p.curves.iter().all(|c| !c.curved()))
        );
    }
}

#[test]
fn the_hull_s_rails_hold_their_measured_volumes() {
    let r = rails_of(&hull(), &json!({ "smooth": true }));
    assert_eq!((r.rings.len(), r.rails.len()), (7, 6));
    // six spans a rail: 19 control points once joined
    assert!(r.rails.iter().all(|rail| rail.len() == 6));
    assert!(r.ring_closed && r.wrap.is_none());
    // every point is a drawn corner
    assert!(r.rings.iter().all(|g| g.corners.iter().all(|&c| c)));
    let rows = rows_of(&r, None);
    assert_eq!(rows.len(), 126);
    let v = volume(&rows);
    assert!((v - 71_821.757_548).abs() < 2e-6, "{v}");
    // the surface itself, at 4000 rows a span
    let v = volume(&rows_of(&r, Some(4000)));
    assert!((v - 71_826.331_984).abs() < 2e-5, "{v}");
    let ruled = rails_of(&hull(), &json!({}));
    let v = volume(&rows_of(&ruled, None));
    assert!((v - 69_702.135_833).abs() < 2e-6, "{v}");
    // a straight rail is a straight cubic
    let b = ruled.rails[1][2];
    let mid = bezier_at(&b, 0.5);
    let half = vec3::scale(vec3::add(b[0], b[3]), 0.5);
    assert!(vec3::len(vec3::sub(mid, half)) < 1e-12);
}

fn near(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).m_hypot(a[1] - b[1]) < 1e-9
}

fn on_circle(r: f64, deg: f64) -> [f64; 2] {
    let (s, c) = deg.to_radians().m_sin_cos();
    [r * c, r * s]
}

#[test]
fn a_circle_is_split_where_a_hexagon_s_corners_land() {
    let profiles = json!([at(0.0, &polygon(6, 12.0)), at(20.0, &circle([0.0, 0.0], 24.0))]);
    let r = rails_of(&profiles, &json!({ "smooth": true }));
    assert_eq!(r.pieces.len(), 6);
    let (hex, round) = (&r.rings[0], &r.rings[1]);
    assert_eq!((hex.points.len(), round.points.len()), (72, 72));
    for (j, p) in r.pieces.iter().enumerate() {
        assert_eq!((p.first, p.stretches), (12 * j, 12));
        // a side of the hexagon pairs with a sixth of the circle
        assert_eq!(p.curves[0], Curve::Line);
        let Curve::Arc {
            center,
            radius,
            from,
            sweep,
        } = p.curves[1]
        else {
            panic!("{:?}", p.curves[1]);
        };
        assert!(near(center, [0.0, 0.0]) && (radius - 12.0).abs() < 1e-12);
        let turn = 60.0 * j as f64;
        assert!((from.to_degrees() - turn).abs() < 1e-9, "{from}");
        assert!((sweep.to_degrees() - 60.0).abs() < 1e-9, "{sweep}");
        let (a, b) = (on_circle(12.0, turn), on_circle(12.0, turn + 60.0));
        for g in 0..12 {
            let i = 12 * j + g;
            let f = g as f64 / 12.0;
            assert!(
                near(hex.flat[i], [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]),
                "{i}"
            );
            assert!(near(round.flat[i], on_circle(12.0, turn + 5.0 * g as f64)), "{i}");
            // the hexagon's corners are its own; the circle has none, only places it was split
            assert_eq!(hex.corners[i], g == 0);
            assert!(!round.corners[i]);
        }
    }
    // the same pairs with the circle first
    let back = json!([at(0.0, &circle([0.0, 0.0], 24.0)), at(20.0, &polygon(6, 12.0))]);
    let b = rails_of(&back, &json!({ "smooth": true }));
    assert_eq!(b.pieces.len(), 6);
    for i in 0..72 {
        assert!(
            near(b.rings[0].flat[i], round.flat[i]) && near(b.rings[1].flat[i], hex.flat[i]),
            "{i}"
        );
    }
    // the caller sets how many rails a piece gets
    let fine = Density {
        arc_step_deg: 2.5,
        least: 1,
    };
    let Match::Rails(f) = match_of(&profiles, &json!({}), &fine) else {
        panic!("unmatched");
    };
    assert!(f.pieces.iter().all(|p| p.stretches == 24));
    let coarse = Density {
        arc_step_deg: 90.0,
        least: 1,
    };
    let Match::Rails(c) = match_of(&profiles, &json!({}), &coarse) else {
        panic!("unmatched");
    };
    assert_eq!(c.rings[0].points.len(), 6);
}

#[test]
fn a_profile_on_a_plane_facing_back_matches_the_same() {
    // the hexagon's plane faces down the loft, so it is drawn clockwise as the loft sees it
    let down = json!({
        "frame": { "origin": [0, 0, 0], "normal": [0, 0, -1], "u": [1, 0, 0], "v": [0, -1, 0] },
        "loops": [polygon(6, 12.0)],
    });
    let r = rails_of(&json!([down, at(20.0, &circle([0.0, 0.0], 24.0))]), &json!({}));
    assert_eq!(r.pieces.len(), 6);
    let (hex, round) = (&r.rings[0].points, &r.rings[1].points);
    let mut turned = 0.0;
    for i in 0..72 {
        // a corner's rail leaves the hexagon and meets the circle at the same angle about the loft
        let (h, c) = (hex[i], round[i]);
        let across = h[0] * c[1] - h[1] * c[0];
        assert!(
            i % 12 != 0 || (across.abs() < 1e-9 && h[0] * c[0] + h[1] * c[1] > 0.0),
            "{i}"
        );
        let next = round[(i + 1) % 72];
        turned += c[0] * next[1] - c[1] * next[0];
    }
    // and both rings go around counterclockwise about it
    assert!(turned > 0.0);
    assert!(
        r.rings[0]
            .corners
            .iter()
            .enumerate()
            .all(|(i, &c)| c == (i % 12 == 0))
    );
}

#[test]
fn an_ellipse_and_a_circle_match_by_angle_all_the_way_around() {
    let profiles = json!([at(0.0, &ellipse(30.0, 16.0)), at(20.0, &circle([0.0, 0.0], 24.0))]);
    let r = rails_of(&profiles, &json!({ "smooth": true }));
    // no corner on either: one piece, a rail every 10 degrees
    assert_eq!(r.pieces.len(), 1);
    let p = &r.pieces[0];
    assert_eq!((p.first, p.stretches), (0, 36));
    let Curve::Ellipse {
        half_width,
        half_height,
        from,
        sweep,
        ..
    } = p.curves[0]
    else {
        panic!("{:?}", p.curves[0]);
    };
    assert_eq!((half_width, half_height), (15.0, 8.0));
    assert!(from.abs() < 1e-9 && (sweep.to_degrees() - 360.0).abs() < 1e-9);
    let Curve::Arc {
        radius, from, sweep, ..
    } = p.curves[1]
    else {
        panic!("{:?}", p.curves[1]);
    };
    assert!((radius - 12.0).abs() < 1e-12 && from.abs() < 1e-9 && (sweep.to_degrees() - 360.0).abs() < 1e-9);
    for i in 0..36 {
        let (s, c) = (10.0 * i as f64).to_radians().m_sin_cos();
        // the ellipse goes by the angle that maps it to a circle
        assert!(near(r.rings[0].flat[i], [15.0 * c, 8.0 * s]), "{i}");
        assert!(near(r.rings[1].flat[i], [12.0 * c, 12.0 * s]), "{i}");
        assert!(!r.rings[0].corners[i] && !r.rings[1].corners[i]);
    }
}

#[test]
fn rounded_rectangles_pair_line_to_line_and_arc_to_arc() {
    let profiles = json!([
        at(0.0, &rounded(40.0, 24.0, 6.0)),
        at(20.0, &rounded(30.0, 20.0, 4.0)),
        at(40.0, &rounded(36.0, 28.0, 8.0)),
    ]);
    let r = rails_of(&profiles, &json!({ "smooth": true }));
    assert_eq!(r.pieces.len(), 8);
    for (j, p) in r.pieces.iter().enumerate() {
        assert_eq!((p.first, p.stretches), (12 * j, 12));
        assert!(
            p.curves.iter().all(|c| c.curved() == (j % 2 == 1)),
            "{:?}",
            p.curves
        );
        for (k, c) in p.curves.iter().enumerate() {
            if let Curve::Arc { radius, sweep, .. } = *c {
                assert!((radius - [6.0, 4.0, 8.0][k]).abs() < 1e-9);
                assert!((sweep.to_degrees() - 90.0).abs() < 1e-9);
            }
        }
    }
    for g in &r.rings {
        assert_eq!(g.points.len(), 96);
        assert!(g.corners.iter().enumerate().all(|(i, &c)| c == (i % 12 == 0)));
    }
    // each ring starts where its first line does
    assert!(near(r.rings[0].flat[0], [-14.0, -12.0]) && near(r.rings[2].flat[0], [-10.0, -14.0]));
}

#[test]
fn unlike_profiles_are_each_split_at_the_other_s_corners() {
    let profiles = json!([
        at(0.0, &square([0.0, 0.0], 20.0)),
        at(15.0, &polygon(6, 9.0)),
        at(30.0, &circle([0.0, 0.0], 14.0)),
    ]);
    let r = rails_of(&profiles, &json!({ "smooth": true }));
    // four corners and six, none shared
    assert_eq!(r.pieces.len(), 10);
    let own = |k: usize| r.rings[k].corners.iter().filter(|&&c| c).count();
    assert_eq!((own(0), own(1), own(2)), (4, 6, 0));
    assert!(r.rings.iter().all(|g| g.points.len() == r.rings[0].points.len()));
    for p in &r.pieces {
        assert!(!p.curves[0].curved() && !p.curves[1].curved() && p.curves[2].curved());
    }
    // the square is turned to the hexagon by its mirror lines, so the pieces mirror too
    let width = |p: &sketch_loft::Piece| match p.curves[2] {
        Curve::Arc { sweep, .. } => sweep.to_degrees(),
        _ => 0.0,
    };
    let mut widths: Vec<f64> = r.pieces.iter().map(width).collect();
    widths.sort_by(f64::total_cmp);
    assert!((widths.iter().sum::<f64>() - 360.0).abs() < 1e-9);
    assert!((widths[0] - widths[3]).abs() < 1e-6, "{widths:?}");
}

#[test]
fn a_closed_loft_s_rails_are_periodic() {
    let opts = json!({ "smooth": true, "closed": true });
    let circles: Vec<Value> = (0..6u32)
        .map(|k| {
            let (s, c) = (TAU * f64::from(k) / 6.0).m_sin_cos();
            json!({
                "frame": { "origin": [40.0 * c, 40.0 * s, 0], "normal": [-s, c, 0], "u": [c, s, 0], "v": [0, 0, 1] },
                "loops": [circle([0.0, 0.0], 10.0 + f64::from(k % 2))],
            })
        })
        .collect();
    for (name, profiles) in [("squares", ring()), ("circles", Value::Array(circles))] {
        let r = rails_of(&profiles, &opts);
        let n = r.rails.len();
        let shift = r.wrap.expect("a closed loft says how its rails come around");
        for (i, rail) in r.rails.iter().enumerate() {
            assert_eq!(rail.len(), 6, "{name}");
            let (last, first) = (rail[5], r.rails[(i + shift) % n][0]);
            // it ends on the point the next time around starts from, and leaves it the way it arrived
            assert_eq!(
                last[3].map(f64::to_bits),
                first[0].map(f64::to_bits),
                "{name} rail {i}"
            );
            let into = vec3::normalize(vec3::sub(last[3], last[2])).unwrap();
            let out = vec3::normalize(vec3::sub(first[1], first[0])).unwrap();
            assert!(vec3::len(vec3::sub(into, out)) < 1e-12, "{name} rail {i}");
            for s in 1..6 {
                assert_eq!(rail[s - 1][3].map(f64::to_bits), rail[s][0].map(f64::to_bits));
            }
        }
    }
}

#[test]
fn a_landmark_overrides_the_least_twist() {
    let mark = |mut p: Value, l: [f64; 2]| {
        p["landmarks"] = json!([l]);
        p
    };
    let profiles = json!([
        mark(at(0.0, &polygon(6, 12.0)), [12.0, 0.0]),
        mark(at(20.0, &circle([0.0, 0.0], 24.0)), on_circle(12.0, 30.0)),
    ]);
    let r = rails_of(&profiles, &json!({ "smooth": true }));
    assert_eq!(r.pieces.len(), 6);
    // the hexagon's first corner goes to the mark on the circle, 30 degrees on from the least twist
    assert!(near(r.rings[0].flat[0], [12.0, 0.0]));
    assert!(near(r.rings[1].flat[0], on_circle(12.0, 30.0)));
    assert!(near(r.rings[1].flat[12], on_circle(12.0, 90.0)));
    // a landmark is a point the circle has itself
    let own: Vec<usize> = (0..72).filter(|&i| r.rings[1].corners[i]).collect();
    assert_eq!(own, [0]);
    // on lines alone the landmarks are the rings' own points, the same rails on every ring
    let h = rails_of(&bilge_hull(true), &json!({ "smooth": true }));
    let own = |k: usize| -> Vec<usize> {
        (0..h.rings[k].corners.len())
            .filter(|&i| h.rings[k].corners[i])
            .collect()
    };
    assert_eq!(own(0).len(), 6);
    assert!((1..5).all(|k| own(k) == own(0)));
}

#[test]
fn profiles_that_cannot_be_matched_say_why() {
    let unmatched = |profiles: &Value, opts: &Value| match match_of(profiles, opts, &Density::default()) {
        Match::Unmatched(why) => why,
        Match::Rails(_) => panic!("matched"),
    };
    let spline = json!({ "type": "spline", "points": [[10, 0], [0, 8], [-10, 0], [0, -8]] });
    assert_eq!(
        unmatched(
            &json!([at(0.0, &circle([0.0, 0.0], 20.0)), at(20.0, &spline)]),
            &json!({})
        ),
        "profile 2 is a closed spline, which has no corners to match its pieces between"
    );
    let bow = |z: f64| {
        json!({
            "frame": level(z),
            "loops": [{ "start": [-10, 0], "segments": [{ "type": "arc", "to": [10, 0], "through": [0, 4] }] }],
            "open": true,
        })
    };
    assert_eq!(
        unmatched(
            &json!([bow(0.0), bow(10.0)]),
            &json!({ "thicken": { "thicknessMm": 1 } })
        ),
        "profile 1 is an open chain, and open chains with arcs have no piece matching yet"
    );
    // what is wrong with the profiles themselves is refused as the mesh loft refuses it
    let disc = |z: f64| at(z, &circle([0.0, 0.0], 20.0));
    assert_eq!(
        refused(&json!([disc(0.0)]), &json!({})),
        "profiles: a loft needs 2 or more profiles"
    );
    assert_eq!(
        refused(&json!([disc(0.0), disc(10.0)]), &json!({ "closed": true })),
        "profiles: a closed loft needs 3 or more profiles"
    );
    assert_eq!(
        refused(&json!([disc(0.0), disc(0.0)]), &json!({})),
        "loft: profiles 1 and 2 touch or cross; space them apart along the loft"
    );
    assert_eq!(
        refused(&json!([at(0.0, &square([0.0, 0.0], 20.0))]), &json!({})),
        "profiles: a loft needs 2 or more profiles"
    );
    let marked = |z: f64, l: [f64; 2]| {
        let mut p = disc(z);
        p["landmarks"] = json!([l]);
        p
    };
    assert_eq!(
        refused(
            &json!([marked(0.0, [10.0, 0.0]), marked(10.0, [3.0, 3.0])]),
            &json!({})
        ),
        "profiles: profile 2: landmark 1 at (3.000, 3.000) is not on the profile"
    );
    let mut bare = disc(10.0);
    bare["landmarks"] = json!([]);
    assert_eq!(
        refused(&json!([marked(0.0, [10.0, 0.0]), bare]), &json!({})),
        "profiles: profile 2 marks 0 landmarks and profile 1 marks 1; every profile marks the same landmarks"
    );
    let none = Density {
        arc_step_deg: 0.0,
        least: 12,
    };
    let two: Vec<Profile> = serde_json::from_value(json!([disc(0.0), disc(10.0)])).unwrap();
    assert_eq!(
        sketch_loft::rails(&two, &Options::default(), &none)
            .unwrap_err()
            .to_string(),
        "density: needs an arc step above 0 degrees and 1 or more stretches a piece"
    );
}

/// whether every rail of `r` has a twin in `other` once each of its points is passed through `flip`
fn mirrored(r: &Rails, other: &Rails, flip: impl Fn(V3) -> V3) -> bool {
    let n = r.rails.len();
    let same = |a: V3, b: V3| vec3::len(vec3::sub(a, b)) < 1e-6;
    n == other.rails.len()
        && (0..n).all(|i| {
            (0..n).any(|j| {
                r.rings
                    .iter()
                    .zip(&other.rings)
                    .all(|(g, h)| same(flip(g.points[i]), h.points[j]))
            })
        })
}

fn across_x(p: V3) -> V3 {
    [-p[0], p[1], p[2]]
}

fn across_y(p: V3) -> V3 {
    [p[0], -p[1], p[2]]
}

/// a profile at `z` turned `deg` about the loft
fn turned(z: f64, deg: f64, lp: &Value) -> Value {
    let (s, c) = deg.to_radians().m_sin_cos();
    json!({
        "frame": { "origin": [0, 0, z], "normal": [0, 0, 1], "u": [c, s, 0], "v": [-s, c, 0] },
        "loops": [lp],
    })
}

/// The share of the shorter piece beside a corner within which another profile's corner is that corner.
const SNAP_SHARE: f64 = 0.05;

/// Fails when a rail that starts a piece lies within the snap reach of a ring's own corner without being one of
/// that ring's own corners: the least width a matched piece may have beside a corner.
fn no_slivers(r: &Rails) {
    for (k, g) in r.rings.iter().enumerate() {
        let n = g.points.len();
        // how far along the ring each point is
        let mut at = vec![0.0; n + 1];
        for i in 0..n {
            at[i + 1] = at[i] + vec3::len(vec3::sub(g.points[(i + 1) % n], g.points[i]));
        }
        let gap = |a: usize, b: usize| {
            let d = (at[a] - at[b]).abs();
            d.min(at[n] - d)
        };
        let own: Vec<usize> = (0..n).filter(|&i| g.corners[i]).collect();
        for (c, &i) in own.iter().enumerate() {
            let m = own.len();
            let shorter = gap(i, own[(c + 1) % m]).min(gap(i, own[(c + m - 1) % m]));
            // the ring's chords are a little shorter than its arcs
            let reach = 0.98 * SNAP_SHARE * shorter;
            for p in &r.pieces {
                assert!(
                    g.corners[p.first] || gap(p.first, i) > reach,
                    "ring {k}: rail {} is {} from the corner at {i}, within {reach}",
                    p.first,
                    gap(p.first, i)
                );
            }
        }
    }
}

#[test]
fn a_sharp_corner_takes_the_end_of_a_facing_round() {
    // the square's corners land 0.66 mm from where the rounds end, within a twentieth of its 24 mm sides
    let profiles = json!([
        at(0.0, &square([0.0, 0.0], 24.0)),
        at(20.0, &rounded(30.0, 20.0, 4.0))
    ]);
    let r = rails_of(&profiles, &json!({}));
    assert_eq!(r.pieces.len(), 8);
    let own = |k: usize| r.rings[k].corners.iter().filter(|&&c| c).count();
    assert_eq!((own(0), own(1)), (4, 8));
    // each round pairs with a stretch of the square's side that ends at its corner
    let rounds: Vec<&sketch_loft::Piece> = r.pieces.iter().filter(|p| p.curves[1].curved()).collect();
    assert_eq!(rounds.len(), 4);
    for p in rounds {
        assert_eq!(p.curves[0], Curve::Line);
        let end = (p.first + p.stretches) % r.rings[0].points.len();
        assert!(r.rings[0].corners[p.first] != r.rings[0].corners[end], "{p:?}");
    }
    // no swirl: the rails mirror across both of the shapes' mirror lines
    assert!(mirrored(&r, &r, across_x) && mirrored(&r, &r, across_y));
    no_slivers(&r);
    // the same rails with the rounded rectangle first
    let back = json!([
        at(0.0, &rounded(30.0, 20.0, 4.0)),
        at(20.0, &square([0.0, 0.0], 24.0))
    ]);
    let b = rails_of(&back, &json!({}));
    assert_eq!(b.pieces.len(), 8);
    assert!(mirrored(&b, &b, across_x) && mirrored(&b, &b, across_y));
    no_slivers(&b);
}

#[test]
fn mirrored_profiles_get_mirrored_rails() {
    let shape = rounded(30.0, 20.0, 4.0);
    for deg in [7.0, 20.0, 33.0, 45.0] {
        let one = json!([at(0.0, &square([0.0, 0.0], 24.0)), turned(20.0, deg, &shape)]);
        // a rounded rectangle turned the other way is its mirror image
        let other = json!([at(0.0, &square([0.0, 0.0], 24.0)), turned(20.0, -deg, &shape)]);
        let (a, b) = (rails_of(&one, &json!({})), rails_of(&other, &json!({})));
        assert_eq!(a.pieces.len(), b.pieces.len(), "{deg}");
        assert!(mirrored(&a, &b, across_x), "{deg}");
        no_slivers(&a);
    }
    no_slivers(&rails_of(
        &json!([
            at(0.0, &square([0.0, 0.0], 20.0)),
            at(15.0, &polygon(6, 9.0)),
            at(30.0, &circle([0.0, 0.0], 14.0)),
        ]),
        &json!({}),
    ));
}

#[test]
fn a_sharp_corner_facing_the_middle_of_a_short_round_splits_it_in_half() {
    // both ends of each 1.57 mm round are as near the square's corner, so neither takes its rail
    let profiles = json!([
        at(0.0, &square([0.0, 0.0], 24.0)),
        at(20.0, &rounded(24.0, 24.0, 1.0))
    ]);
    let r = rails_of(&profiles, &json!({}));
    assert_eq!(r.pieces.len(), 12);
    let own = |k: usize| r.rings[k].corners.iter().filter(|&&c| c).count();
    assert_eq!((own(0), own(1)), (4, 8));
    assert!(mirrored(&r, &r, across_x) && mirrored(&r, &r, across_y));
    for i in (0..r.rings[0].points.len()).filter(|&i| r.rings[0].corners[i]) {
        let q = r.rings[1].flat[i];
        // the square's corner meets the round at its middle, on the diagonal
        assert!(
            (q[0].abs() - q[1].abs()).abs() < 1e-6 && !r.rings[1].corners[i],
            "{q:?}"
        );
    }
    // a round too short to matter still keeps both its ends: the nearer takes the corner's rail
    let tiny = json!([
        at(0.0, &square([0.0, 0.0], 24.0)),
        at(20.0, &rounded(25.0, 24.0, 0.3))
    ]);
    let t = rails_of(&tiny, &json!({}));
    let own = |k: usize| t.rings[k].corners.iter().filter(|&&c| c).count();
    assert_eq!((t.pieces.len(), own(0), own(1)), (8, 4, 8));
}

#[test]
fn a_landmark_keeps_its_rail_from_a_corner_within_reach() {
    let mark = |mut p: Value, l: [f64; 2]| {
        p["landmarks"] = json!([l]);
        p
    };
    // the mark sits 0.3 mm along the bottom line from the end of a round, where the square's corner would take that end
    let profiles = json!([
        mark(at(0.0, &square([0.0, 0.0], 24.0)), [-12.0, -12.0]),
        mark(at(20.0, &rounded(30.0, 20.0, 4.0)), [-10.7, -10.0]),
    ]);
    let r = rails_of(&profiles, &json!({}));
    let (sq, rr) = (&r.rings[0], &r.rings[1]);
    let i = (0..sq.flat.len())
        .find(|&i| near(sq.flat[i], [-12.0, -12.0]))
        .unwrap();
    assert!(near(rr.flat[i], [-10.7, -10.0]) && sq.corners[i] && rr.corners[i]);
    // the round's end keeps a rail of its own
    let j = (0..rr.flat.len())
        .find(|&j| near(rr.flat[j], [-11.0, -10.0]))
        .unwrap();
    assert!(rr.corners[j] && !sq.corners[j] && j != i);
}

fn unmatched(profiles: &Value, opts: &Value) -> String {
    match match_of(profiles, opts, &Density::default()) {
        Match::Unmatched(why) => why,
        Match::Rails(_) => panic!("matched"),
    }
}

/// a profile on the plane through the z axis `around` degrees about it, 40 mm out, turned `turn` degrees in that
/// plane
fn spoke(around: f64, turn: f64, lp: &Value) -> Value {
    let (s, c) = around.to_radians().m_sin_cos();
    let (ts, tc) = turn.to_radians().m_sin_cos();
    json!({
        "frame": {
            "origin": [40.0 * c, 40.0 * s, 0],
            "normal": [-s, c, 0],
            "u": [tc * c, tc * s, ts],
            "v": [-ts * c, -ts * s, tc],
        },
        "loops": [lp],
    })
}

#[test]
fn a_ring_whose_rails_do_not_come_back_is_unmatched() {
    // three rounded squares around a ring, each turned 30 degrees on from the one before. From each to the next
    // the least twist keeps corner on corner, and from the last back to the first it is 30 degrees on again, which
    // is the first one's next corner: a rail comes back a quarter of the way around from where it set out.
    let lp = rounded(12.0, 12.0, 2.0);
    let ring = json!([
        spoke(0.0, 0.0, &lp),
        spoke(120.0, 30.0, &lp),
        spoke(240.0, 60.0, &lp),
    ]);
    assert_eq!(
        unmatched(&ring, &json!({ "closed": true })),
        "the pieces do not come back onto themselves around the ring, so its rails would not close"
    );
    // the same three with no turn close
    let still = json!([
        spoke(0.0, 0.0, &lp),
        spoke(120.0, 0.0, &lp),
        spoke(240.0, 0.0, &lp),
    ]);
    let r = rails_of(&still, &json!({ "closed": true }));
    assert_eq!((r.pieces.len(), r.wrap), (8, Some(0)));
}

#[test]
fn a_piece_too_thin_to_match_is_unmatched() {
    // two landmarks a quarter of the way apart on the first circle and half a millionth of a millimeter apart on
    // the second: each landmark is a rail, so the piece between them has no width on the second profile
    let mark = |mut p: Value, l: [[f64; 2]; 2]| {
        p["landmarks"] = json!(l);
        p
    };
    let thin = (5e-7_f64 / 12.0).to_degrees();
    let profiles = json!([
        mark(
            at(0.0, &circle([0.0, 0.0], 24.0)),
            [on_circle(12.0, 0.0), on_circle(12.0, 90.0)]
        ),
        mark(
            at(20.0, &circle([0.0, 0.0], 24.0)),
            [on_circle(12.0, 0.0), on_circle(12.0, thin)]
        ),
    ]);
    assert_eq!(
        unmatched(&profiles, &json!({})),
        "profile 2 would be cut into a piece too thin to match"
    );
}

/// two matched rings seen from above: each ring, the rails between paired points, and a dot where a piece starts
fn picture(r: &Rails) -> String {
    use std::fmt::Write as _;
    let (a, b) = (&r.rings[0].flat, &r.rings[1].flat);
    let reach = a
        .iter()
        .chain(b)
        .fold(0.0f64, |m, p| m.max(p[0].abs()).max(p[1].abs()))
        + 2.0;
    let path = |ring: &[[f64; 2]]| -> String {
        let mut d = String::new();
        for (i, p) in ring.iter().enumerate() {
            let _ = write!(d, "{}{:.4} {:.4} ", if i == 0 { "M" } else { "L" }, p[0], -p[1]);
        }
        d + "Z"
    };
    let mut s = String::new();
    let _ = writeln!(
        s,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{:.1} {:.1} {:.1} {:.1}\" width=\"800\" height=\"800\">",
        -reach,
        -reach,
        2.0 * reach,
        2.0 * reach
    );
    let _ = writeln!(
        s,
        "<rect x=\"{:.1}\" y=\"{:.1}\" width=\"100%\" height=\"100%\" fill=\"white\"/>",
        -reach, -reach
    );
    for i in 0..a.len() {
        let _ = writeln!(
            s,
            "<line x1=\"{:.4}\" y1=\"{:.4}\" x2=\"{:.4}\" y2=\"{:.4}\" stroke=\"#888\" stroke-width=\"0.06\"/>",
            a[i][0], -a[i][1], b[i][0], -b[i][1]
        );
    }
    for (ring, color) in [(a, "#1f5fbf"), (b, "#bf3f1f")] {
        let _ = writeln!(
            s,
            "<path d=\"{}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"0.15\"/>",
            path(ring)
        );
        for p in &r.pieces {
            let q = ring[p.first];
            let _ = writeln!(
                s,
                "<circle cx=\"{:.4}\" cy=\"{:.4}\" r=\"0.35\" fill=\"{color}\"/>",
                q[0], -q[1]
            );
        }
    }
    s + "</svg>\n"
}

/// Prints the matched pairs as pictures; run with `--ignored --nocapture` and cut the output at the marked lines.
#[test]
#[ignore = "prints pictures to look at"]
fn pictures_of_matched_pairs() {
    let pairs = [
        (
            "circle-to-hexagon",
            json!([at(0.0, &polygon(6, 12.0)), at(20.0, &circle([0.0, 0.0], 24.0))]),
        ),
        (
            "ellipse-to-circle",
            json!([at(0.0, &ellipse(30.0, 16.0)), at(20.0, &circle([0.0, 0.0], 24.0))]),
        ),
        (
            "rounded-rectangles",
            json!([
                at(0.0, &rounded(40.0, 24.0, 6.0)),
                at(20.0, &rounded(30.0, 20.0, 4.0))
            ]),
        ),
        (
            "square-to-rounded-rectangle",
            json!([
                at(0.0, &square([0.0, 0.0], 24.0)),
                at(20.0, &rounded(30.0, 20.0, 4.0))
            ]),
        ),
    ];
    for (name, profiles) in pairs {
        println!("-----8<----- {name}.svg");
        print!("{}", picture(&rails_of(&profiles, &json!({}))));
        println!("-----8<----- end");
    }
}

/// A D: a straight top from (-w, 0) to (w, 0) and a spline under it `depth` deep, drawn clockwise.
fn d_section(w: f64, depth: f64) -> Value {
    json!({ "start": [-w, 0], "segments": [
        { "type": "line", "to": [w, 0] },
        { "type": "spline", "points": d_points(w, depth), "to": [-w, 0] },
    ] })
}

/// The points a D's spline is drawn through between its ends.
fn d_points(w: f64, depth: f64) -> Vec<[f64; 2]> {
    [
        (0.8, -0.5),
        (0.4, -0.95),
        (0.0, -1.0),
        (-0.4, -0.95),
        (-0.8, -0.5),
    ]
    .iter()
    .map(|&(x, y)| [x * w, y * depth])
    .collect()
}

/// How far `p` is from the spline through `through`: from the nearest chord of it drawn far finer than the slicing
/// tolerance, so to well within a micrometer.
fn off_spline(p: [f64; 2], through: &[[f64; 2]]) -> f64 {
    let mut points = vec![through[0]];
    for b in sketch_spline::spans(through, false) {
        points.extend(sketch_spline::flatten(&b, 4096));
    }
    points
        .windows(2)
        .map(|w| {
            let (a, b) = (w[0], w[1]);
            let d = [b[0] - a[0], b[1] - a[1]];
            let f =
                (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1])).clamp(0.0, 1.0);
            (p[0] - a[0] - f * d[0]).m_hypot(p[1] - a[1] - f * d[1])
        })
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn a_line_and_a_spline_match_piece_for_piece() {
    let sizes = [(0.0, 10.0, 8.0), (12.0, 8.0, 6.0), (25.0, 9.0, 7.0)];
    let profiles: Vec<Value> = sizes.iter().map(|&(z, w, d)| at(z, &d_section(w, d))).collect();
    let r = rails_of(&json!(profiles), &json!({ "smooth": true }));
    assert_eq!(r.pieces.len(), 2);
    let line = r
        .pieces
        .iter()
        .position(|p| p.curves.iter().all(|c| *c == Curve::Line))
        .expect("a line piece");
    let spline = r
        .pieces
        .iter()
        .position(|p| p.curves.iter().all(|c| matches!(c, Curve::Spline { .. })))
        .expect("a spline piece");
    assert_ne!(line, spline);
    let n = r.rings[0].flat.len();
    for (ring, &(_, w, d)) in r.rings.iter().zip(&sizes) {
        // counterclockwise about the way the loft goes, whichever way it was drawn
        let area: f64 = (0..n)
            .map(|i| {
                let (a, b) = (ring.flat[i], ring.flat[(i + 1) % n]);
                a[0] * b[1] - a[1] * b[0]
            })
            .sum();
        assert!(area > 0.0, "{area}");
        // the two corners are the line's ends, each where the drawing has it
        let corners: Vec<[f64; 2]> = (0..n)
            .filter(|&i| ring.corners[i])
            .map(|i| ring.flat[i])
            .collect();
        assert_eq!(corners.len(), 2, "{corners:?}");
        assert!(
            corners.contains(&[w, 0.0]) && corners.contains(&[-w, 0.0]),
            "{corners:?}"
        );
        // every point of the line piece is on the line, and every point of the spline piece on the spline drawn
        let mut through = vec![[w, 0.0]];
        through.extend(d_points(w, d));
        through.push([-w, 0.0]);
        let piece = |k: usize| {
            let p = &r.pieces[k];
            (p.first..=p.first + p.stretches).map(move |i| ring.flat[i % n])
        };
        assert!(
            piece(line).all(|p| p[1] == 0.0 && p[0].abs() <= w),
            "{:?}",
            ring.flat
        );
        let off = piece(spline).map(|p| off_spline(p, &through)).fold(0.0, f64::max);
        assert!(off <= 1e-6, "{off:e}");
    }
}

#[test]
fn a_spline_is_matched_only_to_a_spline() {
    let arc_beside = json!({ "start": [-10, 0], "segments": [
        { "type": "line", "to": [10, 0] },
        { "type": "arc", "to": [0, -10], "through": [7.071_067_811_865_476, -7.071_067_811_865_476] },
        { "type": "spline", "points": [[-7, -7]], "to": [-10, 0] },
    ] });
    let opts = json!({});
    let unmatched = |profiles: &Value| match match_of(profiles, &opts, &Density::default()) {
        Match::Unmatched(why) => why,
        Match::Rails(_) => panic!("matched"),
    };
    assert_eq!(
        unmatched(&json!([
            at(0.0, &d_section(10.0, 8.0)),
            at(20.0, &square([0.0, -4.0], 16.0))
        ])),
        "a spline is matched only to a spline, and profile 2 has none where profile 1 has one"
    );
    assert_eq!(
        unmatched(&json!([at(0.0, &arc_beside), at(20.0, &arc_beside)])),
        "profile 1 has an arc beside a spline, which has no pieces to match yet"
    );
    let around = json!({ "start": [10, 0], "segments": [
        { "type": "spline", "points": [[0, 8], [-10, 0], [0, -8]], "to": [10, 0] },
    ] });
    assert_eq!(
        unmatched(&json!([at(0.0, &d_section(10.0, 8.0)), at(20.0, &around)])),
        "profile 2 is a closed spline, which has no corners to match its pieces between"
    );
}
