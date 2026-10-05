// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the fixed nesting benchmark: irregular plates and a fill the bed plate for each, made the
//! same way every time so other slicers can arrange the very same parts
#![allow(
    clippy::many_single_char_names,
    clippy::needless_pass_by_value,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::too_many_lines,
    dead_code,
    reason = "a generator of fixed test shapes, shared by a test and an example that each use part of it"
)]

use std::f64::consts::{PI, TAU};
use sx_geom::TriMesh;
use sx_geom::fm::Fm;
use sx_geom::nest::poly::{self, Region, Ring};
use sx_geom::nest::{
    self, NestBed, NestItem, NestOptions, NestProblem, NestResult, Placement, SilhouetteOptions,
};
use sx_geom::poly2d::{self, Polygon};

/// the bed of a bambu lab a1
pub const BED_MM: f64 = 256.0;

pub struct Part {
    pub name: String,
    pub mesh: TriMesh,
    /// outline area, mm2
    pub area: f64,
}

pub struct Plate {
    pub name: String,
    /// part index into the plate's parts and how many copies
    pub parts: Vec<Part>,
    pub counts: Vec<u32>,
}

fn circle(r: f64, n: usize) -> Ring {
    poly2d::circle([0.0, 0.0], r, n)
}

fn rect(w: f64, h: f64) -> Ring {
    vec![
        [-w / 2.0, -h / 2.0],
        [w / 2.0, -h / 2.0],
        [w / 2.0, h / 2.0],
        [-w / 2.0, h / 2.0],
    ]
}

fn with_holes(outer: Ring, holes: Vec<Ring>) -> Region {
    let mut rings = vec![outer];
    for mut h in holes {
        if poly2d::signed_area(&h) > 0.0 {
            h.reverse();
        }
        rings.push(h);
    }
    poly::union_rings(&rings)
}

fn ell(len: f64, short: f64, w: f64) -> Region {
    with_holes(
        vec![[0.0, 0.0], [len, 0.0], [len, w], [w, w], [w, short], [0.0, short]],
        vec![],
    )
}

fn ring(ro: f64, ri: f64) -> Region {
    with_holes(circle(ro, 96), vec![circle(ri, 72)])
}

fn gear(teeth: u32, module: f64) -> Region {
    let z = f64::from(teeth);
    let rp = module * z / 2.0;
    let (ra, rf) = (rp + module, rp - 1.25 * module);
    let pitch = TAU / z;
    let mut pts = Vec::new();
    for k in 0..teeth {
        let c = f64::from(k) * pitch;
        for (da, r) in [(-0.27, rf), (-0.14, ra), (0.14, ra), (0.27, rf)] {
            let a = c + da * pitch;
            pts.push([r * a.m_cos(), r * a.m_sin()]);
        }
    }
    with_holes(pts, vec![circle((rf * 0.22).max(2.5), 32)])
}

fn blob(seed: u64, size: f64) -> Region {
    let mut s = seed
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    let mut rnd = || {
        s = s
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((s >> 11) as f64) / ((1u64 << 53) as f64)
    };
    let terms: Vec<(f64, f64, f64)> = [2.0, 3.0, 4.0, 5.0]
        .iter()
        .map(|k| (*k, 0.06 + 0.16 * rnd() / k * 2.0, rnd() * TAU))
        .collect();
    let pts: Ring = (0..160)
        .map(|i| {
            let a = TAU * f64::from(i) / 160.0;
            let r = size / 2.0
                * (0.72
                    + terms
                        .iter()
                        .map(|(k, amp, ph)| amp * (k * a + ph).m_cos())
                        .sum::<f64>());
            [r.max(size * 0.12) * a.m_cos(), r.max(size * 0.12) * a.m_sin()]
        })
        .collect();
    with_holes(pts, vec![])
}

fn crescent(size: f64) -> Region {
    let outer: Region = vec![vec![circle(size / 2.0, 96)]];
    let bite: Region = vec![vec![
        circle(size * 0.42, 96)
            .iter()
            .map(|p| [p[0] + size * 0.28, p[1]])
            .collect(),
    ]];
    poly::difference(&outer, &bite)
}

fn cclip(ro: f64, ri: f64) -> Region {
    let (a0, a1) = (PI / 5.0, TAU - PI / 5.0);
    let n = 64;
    let mut pts: Ring = (0..=n)
        .map(|i| a0 + (a1 - a0) * f64::from(i) / f64::from(n))
        .map(|a| [ro * a.m_cos(), ro * a.m_sin()])
        .collect();
    pts.extend(
        (0..=n)
            .rev()
            .map(|i| a0 + (a1 - a0) * f64::from(i) / f64::from(n))
            .map(|a| [ri * a.m_cos(), ri * a.m_sin()]),
    );
    with_holes(pts, vec![])
}

fn cross(span: f64, w: f64) -> Region {
    poly::union_rings(&[rect(span, w), rect(w, span)])
}

fn tee(span: f64, height: f64, w: f64) -> Region {
    let bar: Ring = rect(span, w)
        .iter()
        .map(|p| [p[0], p[1] + (height - w) / 2.0])
        .collect();
    let stem: Ring = rect(w, height);
    poly::union_rings(&[bar, stem])
}

fn frame(w: f64, h: f64, wall: f64) -> Region {
    with_holes(rect(w, h), vec![rect(w - 2.0 * wall, h - 2.0 * wall)])
}

fn star(r: f64) -> Region {
    let pts: Ring = (0..10)
        .map(|i| {
            let a = PI / 2.0 + PI * f64::from(i) / 5.0;
            let rr = if i % 2 == 0 { r } else { r * 0.45 };
            [rr * a.m_cos(), rr * a.m_sin()]
        })
        .collect();
    with_holes(pts, vec![])
}

fn tri(w: f64, h: f64) -> Region {
    with_holes(vec![[0.0, 0.0], [w, 0.0], [0.0, h]], vec![])
}

fn hook(len: f64, w: f64, r: f64) -> Region {
    let shaft: Ring = vec![[-w / 2.0, 0.0], [w / 2.0, 0.0], [w / 2.0, len], [-w / 2.0, len]];
    let n = 48;
    let (ro, ri) = (r + w / 2.0, r - w / 2.0);
    let mut arc: Ring = (0..=n)
        .map(|i| PI * f64::from(i) / f64::from(n))
        .map(|a| [-r + ro * (PI - a).m_cos(), -ro * a.m_sin()])
        .collect();
    arc.extend(
        (0..=n)
            .rev()
            .map(|i| PI * f64::from(i) / f64::from(n))
            .map(|a| [-r + ri * (PI - a).m_cos(), -ri * a.m_sin()]),
    );
    let tip: Ring = vec![
        [-2.0 * r - w / 2.0, 0.0],
        [-2.0 * r + w / 2.0, 0.0],
        [-2.0 * r + w / 2.0, len * 0.3],
        [-2.0 * r - w / 2.0, len * 0.3],
    ];
    poly::union_rings(&[shaft, arc, tip])
}

/// a flat part: the region extruded `h` mm up
fn extrude(r: &Region, h: f64) -> TriMesh {
    let mut m = TriMesh::default();
    for s in r {
        let Some(outer) = s.first() else { continue };
        let p = Polygon {
            outer: outer.clone(),
            holes: s.iter().skip(1).cloned().collect(),
        };
        let pts: Vec<[f64; 2]> = p.vertices().collect();
        let tris = poly2d::triangulate(&p).unwrap_or_default();
        let base = u32::try_from(m.positions.len()).unwrap_or(0);
        let n = u32::try_from(pts.len()).unwrap_or(0);
        for q in &pts {
            m.positions.push([q[0], q[1], 0.0]);
        }
        for q in &pts {
            m.positions.push([q[0], q[1], h]);
        }
        for t in &tris {
            m.triangles.push([base + t[0], base + t[2], base + t[1]]);
            m.triangles
                .push([base + n + t[0], base + n + t[1], base + n + t[2]]);
        }
        let mut start = 0u32;
        for ring in s {
            let len = u32::try_from(ring.len()).unwrap_or(0);
            for i in 0..len {
                let a = base + start + i;
                let b = base + start + (i + 1) % len;
                m.triangles.push([a, b, b + n]);
                m.triangles.push([a, b + n, a + n]);
            }
            start += len;
        }
    }
    m
}

fn mushroom() -> TriMesh {
    let mut m = extrude(&vec![vec![circle(6.0, 48)]], 15.0);
    let mut cap = extrude(&vec![vec![circle(25.0, 96)]], 4.0);
    cap.translate([0.0, 0.0, 15.0]);
    m.append(&cap);
    m
}

fn flat(name: &str, r: Region) -> Part {
    let area = poly::area(&r);
    Part {
        name: name.to_owned(),
        mesh: extrude(&r, 4.0),
        area,
    }
}

/// repeats the counts until the parts would cover `target` of the bed
fn fill_to(parts: &[Part], base: &[u32], target: f64) -> Vec<u32> {
    let mut counts = vec![0u32; parts.len()];
    let mut area = 0.0;
    'outer: loop {
        for (i, n) in base.iter().enumerate() {
            for _ in 0..*n {
                if area >= target * BED_MM * BED_MM {
                    break 'outer;
                }
                counts[i] += 1;
                area += parts[i].area;
            }
        }
    }
    counts
}

fn plate(name: &str, parts: Vec<Part>, base: &[u32]) -> Plate {
    let counts = fill_to(&parts, base, 0.9);
    Plate {
        name: name.to_owned(),
        parts,
        counts,
    }
}

fn fill(name: &str, part: Part) -> Plate {
    let n = ((BED_MM * BED_MM / part.area).floor() as u32 + 2).min(200);
    Plate {
        name: name.to_owned(),
        parts: vec![part],
        counts: vec![n],
    }
}

pub fn plates() -> Vec<Plate> {
    let mut out = vec![
        plate(
            "l-brackets",
            vec![
                flat("l80", ell(80.0, 80.0, 20.0)),
                flat("l60", ell(60.0, 60.0, 15.0)),
                flat("l50x30", ell(50.0, 30.0, 12.0)),
            ],
            &[1, 1, 1],
        ),
        plate(
            "rings-washers",
            vec![
                flat("ring100", ring(50.0, 35.0)),
                flat("ring70", ring(35.0, 22.5)),
                flat("ring40", ring(20.0, 12.5)),
                flat("washer20", ring(10.0, 4.0)),
            ],
            &[1, 1, 2, 3],
        ),
        plate(
            "gears",
            vec![
                flat("gear40", gear(40, 2.0)),
                flat("gear24", gear(24, 2.0)),
                flat("gear16", gear(16, 2.0)),
                flat("gear12", gear(12, 1.5)),
            ],
            &[1, 1, 2, 3],
        ),
        plate(
            "organic",
            (0..10)
                .map(|k| {
                    flat(
                        &format!("blob{k}"),
                        blob(k + 1, 40.0 + 5.0 * f64::from(u32::try_from(k).unwrap_or(0))),
                    )
                })
                .chain([
                    flat("crescent60", crescent(60.0)),
                    flat("crescent80", crescent(80.0)),
                ])
                .collect(),
            &[1; 12],
        ),
        plate(
            "mixed",
            vec![
                flat("plate150", with_holes(rect(150.0, 90.0), vec![rect(40.0, 30.0)])),
                flat("l60", ell(60.0, 60.0, 15.0)),
                flat("ring70", ring(35.0, 22.5)),
                flat("gear16", gear(16, 2.0)),
                flat("blob3", blob(3, 50.0)),
                flat("washer20", ring(10.0, 4.0)),
                Part {
                    name: "mushroom".into(),
                    mesh: mushroom(),
                    area: PI * 625.0,
                },
                flat("hook", hook(70.0, 10.0, 14.0)),
            ],
            &[1, 2, 2, 2, 2, 4, 2, 2],
        ),
        plate(
            "crosses-tees",
            vec![
                flat("cross60", cross(60.0, 18.0)),
                flat("tee60", tee(60.0, 50.0, 15.0)),
                flat("cross40", cross(40.0, 12.0)),
            ],
            &[1, 1, 1],
        ),
        plate(
            "c-clips",
            vec![
                flat("clip70", cclip(35.0, 23.0)),
                flat("clip50", cclip(25.0, 15.0)),
                flat("clip30", cclip(15.0, 9.0)),
            ],
            &[1, 1, 1],
        ),
        plate(
            "frames",
            vec![
                flat("frame120", frame(120.0, 90.0, 10.0)),
                flat("frame80", frame(80.0, 80.0, 10.0)),
                flat("block20x30", with_holes(rect(20.0, 30.0), vec![])),
                flat("block15", with_holes(rect(15.0, 15.0), vec![])),
            ],
            &[1, 1, 2, 2],
        ),
        plate(
            "stars",
            vec![
                flat("star40", star(40.0)),
                flat("star30", star(30.0)),
                flat("star20", star(20.0)),
            ],
            &[1, 1, 1],
        ),
        plate(
            "bars-triangles",
            vec![
                flat("bar200", with_holes(rect(200.0, 12.0), vec![])),
                flat("bar150", with_holes(rect(150.0, 15.0), vec![])),
                flat("tri80", tri(80.0, 50.0)),
                flat("tri50", tri(50.0, 30.0)),
            ],
            &[1, 1, 2, 2],
        ),
    ];
    let fills = vec![
        fill("fill-l60", flat("l60", ell(60.0, 60.0, 15.0))),
        fill("fill-ring70", flat("ring70", ring(35.0, 22.5))),
        fill("fill-gear24", flat("gear24", gear(24, 2.0))),
        fill("fill-crescent60", flat("crescent60", crescent(60.0))),
        fill("fill-hook", flat("hook", hook(70.0, 10.0, 14.0))),
        fill("fill-cross60", flat("cross60", cross(60.0, 18.0))),
        fill("fill-clip50", flat("clip50", cclip(25.0, 15.0))),
        fill("fill-frame80", flat("frame80", frame(80.0, 80.0, 10.0))),
        fill("fill-star30", flat("star30", star(30.0))),
        fill("fill-tri50", flat("tri50", tri(50.0, 30.0))),
    ];
    out.extend(fills);
    out
}

/// how one plate came out
pub struct Outcome {
    pub wanted: u32,
    pub placed: u32,
    /// outline area of the placed parts over the bed, percent
    pub utilization: f64,
    /// every part on the bed, `gap` from its edge and from every other part
    pub clear: bool,
    pub result: NestResult,
}

/// arranges a plate the way the app does: each part's outline from its mesh, then the nesting
pub fn arrange(p: &Plate, gap: f64, step: f64, passes: u32) -> Outcome {
    let problem = problem(p, gap, step, passes);
    let wanted = problem.items.iter().map(|i| i.copies).sum();
    // the check measures the exact outlines, not the simplified ones the nesting grew a little
    let exact = SilhouetteOptions {
        tolerance_mm: 0.0,
        ..SilhouetteOptions::default()
    };
    let shapes: Vec<(String, Vec<Polygon>)> = p
        .parts
        .iter()
        .map(|part| {
            let s = nest::silhouette(std::slice::from_ref(&part.mesh), None, &exact);
            (
                part.name.clone(),
                s.outline
                    .iter()
                    .map(|r| Polygon {
                        outer: r[0].clone(),
                        holes: r[1..].to_vec(),
                    })
                    .collect(),
            )
        })
        .collect();
    let result = nest::nest(problem).unwrap_or_else(|e| panic!("{}: {e}", p.name));
    let area: f64 = result
        .placements
        .iter()
        .map(|pl| p.parts.iter().find(|x| x.name == pl.id).map_or(0.0, |x| x.area))
        .sum();
    Outcome {
        wanted,
        placed: result.stats.placed,
        utilization: (area / (BED_MM * BED_MM) * 1000.0).round() / 10.0,
        clear: clear(&shapes, &result.placements, gap),
        result,
    }
}

/// the request the app would send for a plate: each part's outline from its mesh
pub fn problem(p: &Plate, gap: f64, step: f64, passes: u32) -> NestProblem {
    let mut items = Vec::new();
    for (part, n) in p.parts.iter().zip(&p.counts) {
        if *n == 0 {
            continue;
        }
        let s = nest::silhouette(
            std::slice::from_ref(&part.mesh),
            None,
            &SilhouetteOptions::default(),
        );
        let polygons: Vec<Polygon> = s
            .outline
            .iter()
            .map(|r| Polygon {
                outer: r[0].clone(),
                holes: r[1..].to_vec(),
            })
            .collect();
        items.push(NestItem {
            id: part.name.clone(),
            polygons,
            grow: 0.0,
            reach: 0.0,
            copies: *n,
            hull: s.hull,
        });
    }
    NestProblem {
        bed: NestBed {
            width_mm: BED_MM,
            depth_mm: BED_MM,
        },
        items,
        fixed: vec![],
        zones: vec![],
        options: NestOptions {
            gap_mm: gap,
            rotation_step_deg: step,
            passes,
            ..NestOptions::default()
        },
    }
}

/// true when every placed outline lies on the bed `gap` from its edge and `gap` from every other
pub fn clear(shapes: &[(String, Vec<Polygon>)], placements: &[Placement], gap: f64) -> bool {
    let placed: Vec<Region> = placements
        .iter()
        .map(|pl| {
            let polys = shapes
                .iter()
                .find(|s| s.0 == pl.id)
                .map(|s| s.1.clone())
                .unwrap_or_default();
            let rings: Vec<Ring> = polys
                .iter()
                .flat_map(|q| std::iter::once(q.outer.clone()).chain(q.holes.clone()))
                .collect();
            poly::translate(
                &poly::rotate(&poly::union_rings(&rings), poly::turn(pl.angle_deg)),
                pl.offset,
            )
        })
        .collect();
    let half = (gap / 2.0 - 0.01).max(0.0);
    let grown: Vec<Region> = placed
        .iter()
        .map(|r| {
            if half > 0.0 {
                poly::offset(r, half, 0.01)
            } else {
                r.clone()
            }
        })
        .collect();
    let mut ok = true;
    for (i, a) in grown.iter().enumerate() {
        let b = poly::bbox(&placed[i]);
        if b.min[0] < gap - 0.01
            || b.min[1] < gap - 0.01
            || b.max[0] > BED_MM - gap + 0.01
            || b.max[1] > BED_MM - gap + 0.01
        {
            eprintln!("part {i} leaves the bed: {b:?}");
            ok = false;
        }
        for (j, c) in grown.iter().enumerate().skip(i + 1) {
            if poly::bbox(a).overlaps(&poly::bbox(c)) && poly::area(&poly::intersection(a, c)) > 1e-6 {
                eprintln!("parts {i} and {j} are closer than {gap} mm");
                ok = false;
            }
        }
    }
    ok
}
