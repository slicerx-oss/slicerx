// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The organic support test models, generated in code: boxes, prisms, cylinders and cones put together
//! into the 13 shapes the organic support tests and the parity runs use. Every model is centered on the
//! origin in X and Y with its lowest point at Z 0; the tests place it with a transform.
#![allow(dead_code, clippy::cast_precision_loss, clippy::cast_possible_truncation)]
#![allow(
    clippy::disallowed_methods,
    reason = "test geometry and G-code parsing: no output depends on last-bit rounding here"
)]
#![allow(clippy::many_single_char_names, reason = "vector math on triangle corners")]
#![allow(
    clippy::float_cmp,
    reason = "a G-code move with no XY change parses to the same values"
)]

use serde_json::{Value, json};
use std::f32::consts::TAU;
use sx_core::api::{Mesh, MeshPart};

/// A model with its plate position and the settings it is tested with.
pub struct Model {
    pub id: u32,
    pub name: &'static str,
    pub mesh: Mesh,
    /// Where the origin of the model goes on the plate (mm).
    pub at: [f32; 2],
    /// Settings over the organic support base.
    pub config: Value,
}

fn part(name: &str, positions: Vec<[f32; 3]>, triangles: Vec<[u32; 3]>) -> MeshPart {
    MeshPart {
        name: name.into(),
        slot: 1,
        positions,
        triangles,
        ..MeshPart::default()
    }
}

/// A box from `lo` to `hi`. Triangles 0 and 1 are the bottom face, 4 and 5 the face at the low Y.
pub fn cuboid(name: &str, lo: [f32; 3], hi: [f32; 3]) -> MeshPart {
    let positions = (0..8)
        .map(|i| {
            [
                if i & 1 == 0 { lo[0] } else { hi[0] },
                if i & 2 == 0 { lo[1] } else { hi[1] },
                if i & 4 == 0 { lo[2] } else { hi[2] },
            ]
        })
        .collect();
    part(
        name,
        positions,
        vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ],
    )
}

/// Rings of `n` points stacked along Z: `(z, center, radius)` for each, a radius of 0 being a point.
/// Closed at both ends.
pub fn lathe(name: &str, rings: &[(f32, [f32; 2], f32)], n: u32) -> MeshPart {
    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut starts: Vec<(u32, bool)> = Vec::new();
    for &(z, c, r) in rings {
        let start = positions.len() as u32;
        if r <= 0.0 {
            positions.push([c[0], c[1], z]);
            starts.push((start, true));
        } else {
            for i in 0..n {
                let a = TAU * i as f32 / n as f32;
                positions.push([c[0] + r * a.cos(), c[1] + r * a.sin(), z]);
            }
            starts.push((start, false));
        }
    }
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let at = |(s, point): (u32, bool), i: u32| if point { s } else { s + i % n };
    for w in starts.windows(2) {
        let (a, b) = (w[0], w[1]);
        for i in 0..n {
            let (a0, a1, b0, b1) = (at(a, i), at(a, i + 1), at(b, i), at(b, i + 1));
            if !a.1 {
                tris.push([a0, a1, b1]);
            }
            if !b.1 {
                tris.push([a0, b1, b0]);
            }
        }
    }
    // Caps: a fan on the first ring facing down and the last facing up.
    let mut cap = |ring: (u32, bool), up: bool| {
        if ring.1 {
            return;
        }
        let c = positions.len() as u32;
        let mut sum = [0.0f32; 3];
        for i in 0..n {
            let p = positions[(ring.0 + i) as usize];
            sum = [sum[0] + p[0], sum[1] + p[1], sum[2] + p[2]];
        }
        positions.push([sum[0] / n as f32, sum[1] / n as f32, sum[2] / n as f32]);
        for i in 0..n {
            let (x, y) = (ring.0 + i, ring.0 + (i + 1) % n);
            tris.push(if up { [x, y, c] } else { [y, x, c] });
        }
    };
    if let Some(&first) = starts.first() {
        cap(first, false);
    }
    if let Some(&last) = starts.last() {
        cap(last, true);
    }
    part(name, positions, tris)
}

pub fn cylinder(name: &str, c: [f32; 2], r: f32, z0: f32, z1: f32) -> MeshPart {
    lathe(name, &[(z0, c, r), (z1, c, r)], 64)
}

/// A prism of the convex polygon `profile` in the XZ plane (counterclockwise seen from -Y), from `y0` to
/// `y1`.
pub fn prism_xz(name: &str, profile: &[[f32; 2]], y0: f32, y1: f32) -> MeshPart {
    let n = profile.len() as u32;
    let mut positions: Vec<[f32; 3]> = Vec::new();
    for &y in &[y0, y1] {
        for p in profile {
            positions.push([p[0], y, p[1]]);
        }
    }
    let mut tris = Vec::new();
    for i in 1..n - 1 {
        tris.push([0, i, i + 1]);
        tris.push([n, n + i + 1, n + i]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        tris.push([i, n + i, j]);
        tris.push([j, n + i, n + j]);
    }
    part(name, positions, tris)
}

fn mesh(name: &str, parts: Vec<MeshPart>) -> Mesh {
    Mesh {
        name: name.into(),
        parts,
        ..Mesh::default()
    }
}

const MIDDLE: [f32; 2] = [128.0, 128.0];

/// 1: a 40 mm column with a 30 x 10 mm arm at 20 mm.
pub fn t_bar() -> Mesh {
    mesh(
        "t-bar",
        vec![
            cuboid("column", [-5.0, -5.0, 0.0], [5.0, 5.0, 40.0]),
            cuboid("arm", [-15.0, -5.0, 20.0], [15.0, 5.0, 23.0]),
        ],
    )
}

/// 2: a 10 mm stem under a 40 mm cap whose underside is flat at 15 mm.
pub fn mushroom() -> Mesh {
    mesh(
        "mushroom",
        vec![
            cylinder("stem", [0.0, 0.0], 5.0, 0.0, 15.5),
            cylinder("cap", [0.0, 0.0], 20.0, 15.0, 20.0),
        ],
    )
}

/// 3: three walls overhanging at 60, 45 and 30 degrees from vertical.
pub fn ramp() -> Mesh {
    let h = 15.0f32;
    let wedge = |name: &str, deg: f32, y0: f32| {
        let reach = h * deg.to_radians().tan();
        prism_xz(
            name,
            &[[-5.0, 0.0], [0.0, 0.0], [reach, h], [-5.0, h]],
            y0,
            y0 + 8.0,
        )
    };
    mesh(
        "ramp",
        vec![
            wedge("s60", 60.0, -16.0),
            wedge("s45", 45.0, -4.0),
            wedge("s30", 30.0, 8.0),
        ],
    )
}

/// 4: a 20 mm box with a 6 mm square hole through it and a shelf over it.
pub fn hole_shelf() -> Mesh {
    mesh(
        "hole-shelf",
        vec![
            cuboid("w", [-10.0, -10.0, 0.0], [-3.0, 10.0, 10.0]),
            cuboid("e", [3.0, -10.0, 0.0], [10.0, 10.0, 10.0]),
            cuboid("s", [-3.0, -10.0, 0.0], [3.0, -3.0, 10.0]),
            cuboid("n", [-3.0, 3.0, 0.0], [3.0, 10.0, 10.0]),
            cuboid("post", [12.0, -2.0, 0.0], [16.0, 2.0, 17.0]),
            cuboid("shelf", [-10.0, -10.0, 15.0], [16.0, 10.0, 17.0]),
        ],
    )
}

/// 5: a bridge over a flat-topped block. The block reaches 10 mm past the deck on each side, farther
/// than a branch travels in the 5 mm between them, so branches under the deck rest on it.
pub fn model_rest() -> Mesh {
    mesh(
        "model-rest",
        vec![
            cuboid("w", [-20.0, -5.0, 0.0], [-15.0, 5.0, 15.0]),
            cuboid("e", [15.0, -5.0, 0.0], [20.0, 5.0, 15.0]),
            cuboid("deck", [-20.0, -5.0, 15.0], [20.0, 5.0, 18.0]),
            cuboid("block", [-12.0, -15.0, 0.0], [12.0, 15.0, 10.0]),
        ],
    )
}

/// 6: a cone hanging tip down from a body held by a post.
pub fn sharp_tail() -> Mesh {
    mesh(
        "sharp-tail",
        vec![
            lathe(
                "cone",
                &[
                    (5.0, [0.0, 0.0], 0.0),
                    (15.0, [0.0, 0.0], 8.0),
                    (25.0, [0.0, 0.0], 8.0),
                ],
                64,
            ),
            cuboid("post", [12.0, -2.0, 0.0], [16.0, 2.0, 25.0]),
            cuboid("arm", [6.0, -2.0, 20.0], [16.0, 2.0, 25.0]),
        ],
    )
}

/// 7: a 150 mm tower with an arm at 140 mm.
pub fn tall() -> Mesh {
    mesh(
        "tall",
        vec![
            cuboid("tower", [-5.0, -5.0, 0.0], [5.0, 5.0, 150.0]),
            cuboid("arm", [5.0, -5.0, 140.0], [25.0, 5.0, 143.0]),
        ],
    )
}

/// 10: a 45 degree wedge whose overhang splits into two lobes above a single one.
pub fn fork() -> Mesh {
    let lower = prism_xz(
        "lower",
        &[[-5.0, 0.0], [0.0, 0.0], [8.0, 8.0], [-5.0, 8.0]],
        -10.0,
        10.0,
    );
    let upper = |name: &str, y0: f32| {
        prism_xz(
            name,
            &[[-5.0, 8.0], [8.0, 8.0], [15.0, 15.0], [-5.0, 15.0]],
            y0,
            y0 + 8.0,
        )
    };
    mesh("fork", vec![lower, upper("a", -10.0), upper("b", 2.0)])
}

/// 11: a 9 mm and a 15 mm straight bridge, each between two posts.
pub fn bridges() -> Mesh {
    let bridge = |y0: f32, span: f32| {
        let half = span / 2.0;
        vec![
            cuboid("p1", [-half - 5.0, y0, 0.0], [-half, y0 + 5.0, 10.0]),
            cuboid("p2", [half, y0, 0.0], [half + 5.0, y0 + 5.0, 10.0]),
            cuboid("deck", [-half - 5.0, y0, 10.0], [half + 5.0, y0 + 5.0, 12.0]),
        ]
    };
    let mut parts = bridge(-10.0, 9.0);
    parts.extend(bridge(5.0, 15.0));
    mesh("bridges", parts)
}

/// 12: the T-bar with support enforced on a vertical face of the column and blocked under half the arm.
pub fn painted() -> Mesh {
    let mut column = cuboid("column", [-5.0, -5.0, 0.0], [5.0, 5.0, 40.0]);
    let left = cuboid("arm-left", [-15.0, -5.0, 20.0], [0.0, 5.0, 23.0]);
    let mut right = cuboid("arm-right", [0.0, -5.0, 20.0], [15.0, 5.0, 23.0]);
    // Paint text "4" asks for support on a whole triangle, "8" keeps it out.
    let paint = |p: &mut MeshPart, tris: &[u32], text: &str| {
        for &t in tris {
            let tri = p.triangles[t as usize].map(|v| p.positions[v as usize]);
            p.support_paint.extend(sx_core::paint::decode(text, tri));
            p.paint_texts.push((2, t, text.to_owned()));
        }
    };
    paint(&mut column, &[4, 5], "4");
    paint(&mut right, &[0, 1], "8");
    mesh("painted", vec![column, left, right])
}

/// 13: a 0.6 mm and a 2 mm nub hanging under a flat ceiling.
pub fn bumps() -> Mesh {
    mesh(
        "bumps",
        vec![
            cuboid("w", [-15.0, -15.0, 0.0], [-12.0, 15.0, 13.0]),
            cuboid("e", [12.0, -15.0, 0.0], [15.0, 15.0, 13.0]),
            cuboid("ceiling", [-15.0, -15.0, 10.0], [15.0, 15.0, 13.0]),
            cylinder("small", [-5.0, 0.0], 0.3, 8.0, 10.2),
            cylinder("big", [5.0, 0.0], 1.0, 8.0, 10.2),
        ],
    )
}

/// All 13 models with their settings.
pub fn all() -> Vec<Model> {
    let m = |id, name, mesh, at, config| Model {
        id,
        name,
        mesh,
        at,
        config,
    };
    vec![
        m(1, "t-bar", t_bar(), MIDDLE, json!({})),
        m(2, "mushroom", mushroom(), MIDDLE, json!({})),
        m(3, "ramp", ramp(), MIDDLE, json!({})),
        m(4, "hole-shelf", hole_shelf(), MIDDLE, json!({})),
        m(
            5,
            "model-rest",
            model_rest(),
            MIDDLE,
            json!({ "support_interface_bottom_layers": 2 }),
        ),
        m(6, "sharp-tail", sharp_tail(), MIDDLE, json!({})),
        m(7, "tall", tall(), MIDDLE, json!({})),
        m(
            8,
            "raft",
            t_bar(),
            MIDDLE,
            json!({ "raft_layers": 3, "raft_expansion": 1.5 }),
        ),
        // The arm's far end 2 mm from the bed's right edge (256 mm).
        m(9, "bed-edge", t_bar(), [256.0 - 2.0 - 15.0, 128.0], json!({})),
        m(10, "fork", fork(), MIDDLE, json!({})),
        m(11, "bridges", bridges(), MIDDLE, json!({})),
        m(12, "painted", painted(), MIDDLE, json!({})),
        m(13, "bumps", bumps(), MIDDLE, json!({})),
    ]
}

/// Settings every organic test starts from: organic trees on the v2 engine.
pub fn organic_config(extra: &Value, quirks: &str) -> Value {
    let mut c = json!({
        "enable_support": true,
        "support_type": "tree(auto)",
        "support_style": "organic",
        "organic_support_engine": "v2",
        "organic_quirks": quirks,
        "brim_width": 0,
        "brim_type": "no_brim",
        "layer_height": 0.2,
        "initial_layer_print_height": 0.2
    });
    if let (Some(dst), Some(src)) = (c.as_object_mut(), extra.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    c
}

/// Binary STL of a mesh, every part in one solid, moved by `at`.
pub fn stl(m: &Mesh, at: [f32; 2]) -> Vec<u8> {
    let tris: usize = m.parts.iter().map(|p| p.triangles.len()).sum();
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&(tris as u32).to_le_bytes());
    for p in &m.parts {
        for t in &p.triangles {
            let v = t.map(|i| {
                let q = p.positions[i as usize];
                [q[0] + at[0], q[1] + at[1], q[2]]
            });
            let (a, b) = (
                [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]],
                [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]],
            );
            let n = [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ];
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-12);
            for x in [n[0] / l, n[1] / l, n[2] / l] {
                out.extend_from_slice(&x.to_le_bytes());
            }
            for q in v {
                for x in q {
                    out.extend_from_slice(&x.to_le_bytes());
                }
            }
            out.extend_from_slice(&[0, 0]);
        }
    }
    out
}

/// One layer's support segments: `(interface, start, end)`.
pub type SupportSegs = Vec<(bool, [f32; 2], [f32; 2])>;

/// Support extrusions of a G-code file: per layer (print Z), the segments of `;TYPE:Support` and
/// `;TYPE:Support interface` moves, as `(interface, [x0, y0], [x1, y1])`.
pub fn support_moves(gcode: &str) -> Vec<(f32, SupportSegs)> {
    let mut layers: Vec<(f32, SupportSegs)> = Vec::new();
    let mut kind: Option<bool> = None;
    let mut pos = [0.0f32; 2];
    let mut z = 0.0f32;
    let mut relative_e = false;
    let mut last_e = 0.0f32;
    for line in gcode.lines() {
        let line = line.trim();
        if let Some(t) = line.strip_prefix(";TYPE:") {
            kind = match t {
                "Support" => Some(false),
                "Support interface" | "Support transition" => Some(true),
                _ => None,
            };
            continue;
        }
        if let Some(v) = line.strip_prefix(";Z:") {
            if let Ok(nz) = v.trim().parse::<f32>() {
                z = nz;
            }
            continue;
        }
        if line.starts_with("M83") {
            relative_e = true;
        }
        if line.starts_with("M82") {
            relative_e = false;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        if !(code.starts_with("G1 ") || code.starts_with("G0 ")) {
            continue;
        }
        let mut next = pos;
        let mut e: Option<f32> = None;
        for w in code.split_whitespace().skip(1) {
            let (k, v) = w.split_at(1);
            let Ok(v) = v.parse::<f32>() else { continue };
            match k {
                "X" => next[0] = v,
                "Y" => next[1] = v,
                "Z" => z = v,
                "E" => e = Some(v),
                _ => {}
            }
        }
        let extrudes = match e {
            Some(v) if relative_e => v > 0.0,
            Some(v) => {
                let d = v - last_e;
                last_e = v;
                d > 0.0
            }
            None => false,
        };
        if extrudes
            && next != pos
            && let Some(iface) = kind
        {
            if layers.last().is_none_or(|(lz, _)| (lz - z).abs() > 1e-4) {
                layers.push((z, Vec::new()));
            }
            if let Some((_, segs)) = layers.last_mut() {
                segs.push((iface, pos, next));
            }
        }
        pos = next;
    }
    layers
}

/// A 3MF of a mesh as one object, every part merged and moved by `at`, with each triangle's paint text
/// as the attribute Bambu Studio and Orca read (`paint_color`, `paint_seam`, `paint_supports`,
/// `paint_fuzzy_skin`), so the reference binary sees the paint an STL drops.
pub fn threemf(m: &Mesh, at: [f32; 2]) -> Vec<u8> {
    use std::fmt::Write as _;
    const ATTR: [&str; 4] = ["paint_color", "paint_seam", "paint_supports", "paint_fuzzy_skin"];
    let (mut vx, mut tx, mut base) = (String::new(), String::new(), 0u32);
    for p in &m.parts {
        for q in &p.positions {
            let _ = write!(
                vx,
                r#"<vertex x="{}" y="{}" z="{}"/>"#,
                q[0] + at[0],
                q[1] + at[1],
                q[2]
            );
        }
        for (i, t) in p.triangles.iter().enumerate() {
            let _ = write!(
                tx,
                r#"<triangle v1="{}" v2="{}" v3="{}""#,
                t[0] + base,
                t[1] + base,
                t[2] + base
            );
            for (layer, tri, text) in &p.paint_texts {
                if *tri as usize == i {
                    let _ = write!(tx, r#" {}="{text}""#, ATTR[usize::from(*layer)]);
                }
            }
            tx.push_str("/>");
        }
        base += p.positions.len() as u32;
    }
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>{vx}</vertices><triangles>{tx}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>"#
    );
    let types = r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#;
    stored_zip(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
    ])
}

/// A stored (uncompressed) ZIP of the given entries.
fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in entries {
        let offset = out.len() as u32;
        let crc = crc32(data);
        for (dst, sig) in [(&mut out, 0x0403_4b50u32), (&mut central, 0x0201_4b50u32)] {
            dst.extend_from_slice(&sig.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&20u16.to_le_bytes());
            }
            dst.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            dst.extend_from_slice(&crc.to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(data.len() as u32).to_le_bytes());
            dst.extend_from_slice(&(name.len() as u16).to_le_bytes());
            dst.extend_from_slice(&0u16.to_le_bytes());
            if sig == 0x0201_4b50 {
                dst.extend_from_slice(&[0; 10]);
                dst.extend_from_slice(&offset.to_le_bytes());
            }
            dst.extend_from_slice(name.as_bytes());
        }
        out.extend_from_slice(data);
    }
    let at = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&at.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 == 1 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}
