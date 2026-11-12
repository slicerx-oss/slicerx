// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the mesh loft's output held bit for bit

#![cfg(feature = "cad")]
#![allow(clippy::many_single_char_names, reason = "points and sizes of test geometry")]

use serde_json::{Value, json};
use std::f64::consts::{FRAC_PI_2, TAU};
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::{self, Options, Profile};

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
