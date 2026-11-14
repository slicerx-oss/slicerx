// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the mesh loft keeps each profile's corners matched to the same corners: lofted bodies drawn with lines and
//! splines or arcs (`fixtures/loft-corner-sections.json`) keep a sharp top edge from end to end, a straight side,
//! and whole ends

#![cfg(feature = "cad")]
#![allow(clippy::cast_precision_loss, reason = "small counts")]

use serde_json::Value;
use std::collections::HashMap;
use sx_geom::fm::Fm;
use sx_geom::mesh::TriMesh;
use sx_geom::sketch_loft::{self, Options, Profile};
use sx_geom::vec3::{self, V3};

/// The smooth mesh loft of the sections under `key` in the fixture.
fn lofted(key: &str) -> TriMesh {
    let all: Value = serde_json::from_str(include_str!("fixtures/loft-corner-sections.json")).unwrap();
    let profiles: Vec<Profile> = serde_json::from_value(all[key]["profiles"].clone()).unwrap();
    sketch_loft::loft_with(
        &profiles,
        &Options {
            smooth: true,
            ..Options::default()
        },
    )
    .unwrap()
}

fn normal(m: &TriMesh, t: usize) -> V3 {
    let [p0, p1, p2] = m.triangles[t].map(|i| m.positions[i as usize]);
    vec3::normalize(vec3::cross(vec3::sub(p1, p0), vec3::sub(p2, p0))).expect("a triangle with area")
}

/// Each edge (lower vertex first) and the triangles on it.
fn edges(m: &TriMesh) -> HashMap<(u32, u32), Vec<usize>> {
    let mut at: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (t, tri) in m.triangles.iter().enumerate() {
        for j in 0..3 {
            let (a, b) = (tri[j], tri[(j + 1) % 3]);
            at.entry((a.min(b), a.max(b))).or_default().push(t);
        }
    }
    at
}

/// The points where the plane x = `x` cuts the mesh's triangles.
fn section(m: &TriMesh, x: f64) -> Vec<V3> {
    let mut out = Vec::new();
    for tri in &m.triangles {
        let corners = tri.map(|i| m.positions[i as usize]);
        for j in 0..3 {
            let (from, to) = (corners[j], corners[(j + 1) % 3]);
            if (from[0] - x) * (to[0] - x) < 0.0 {
                let t = (x - from[0]) / (to[0] - from[0]);
                out.push(vec3::add(from, vec3::scale(vec3::sub(to, from), t)));
            }
        }
    }
    out
}

#[test]
fn a_top_edge_stays_sharp_between_its_sections() {
    // sections of a top line and two splines down to the lowest line: the top meets the sides at a right angle on
    // every one
    let m = lofted("top_edge");
    let flat = |t: usize| {
        normal(&m, t)[2] > 0.99999
            && m.triangles[t]
                .iter()
                .all(|&i| (m.positions[i as usize][2] - 15.0).abs() < 1e-6)
    };
    let mut folds = Vec::new();
    let (mut from, mut to) = (f64::MAX, f64::MIN);
    for ((va, vb), ts) in edges(&m) {
        let [one, two] = ts[..] else { continue };
        if flat(one) == flat(two) {
            continue;
        }
        let (pa, pb) = (m.positions[va as usize], m.positions[vb as usize]);
        // the top's own edge, not a step down off the end of it
        if pa[2] < 15.0 - 1e-6 || pb[2] < 15.0 - 1e-6 {
            continue;
        }
        let fold = vec3::dot(normal(&m, one), normal(&m, two))
            .clamp(-1.0, 1.0)
            .m_acos()
            .to_degrees();
        folds.push((pa[0].min(pb[0]), fold));
        from = from.min(pa[0].min(pb[0]));
        to = to.max(pa[0].max(pb[0]));
    }
    let soft: Vec<_> = folds.iter().filter(|&&(_, f)| f < 39.0).collect();
    assert!(
        soft.is_empty(),
        "{} of {} top edge segments fold under 39 degrees: {soft:?}",
        soft.len(),
        folds.len()
    );
    // from the first section to the last
    assert!(
        from <= 1.0 + 1e-9 && to >= 213.0 - 1e-9,
        "top edge from x {from} to {to}"
    );
}

#[test]
fn a_side_stays_out_where_its_sections_put_it() {
    // the side runs straight down from the top edge at x 60, 10.97 mm out on the exact loft
    let m = lofted("straight_side");
    let out = section(&m, 60.0)
        .iter()
        .filter(|p| (9.0..=11.5).contains(&p[2]) && p[1] < 0.0)
        .map(|p| -p[1])
        .fold(f64::MAX, f64::min);
    assert!(
        (out - 10.97).abs() <= 0.05,
        "the side is {out} mm out at x 60 from z 9 to 11.5"
    );
}

#[test]
fn an_arc_loft_keeps_its_ends_whole_and_on_the_bed() {
    let m = lofted("arc_loft");
    // closed: every edge between two triangles
    let open: Vec<_> = edges(&m)
        .into_iter()
        .filter(|(_, ts)| ts.len() != 2)
        .map(|(e, _)| e)
        .collect();
    assert!(open.is_empty(), "{} edges not between two triangles", open.len());
    let low = m.positions.iter().map(|p| p[2]).fold(f64::MAX, f64::min);
    assert!(low >= 0.0, "the lowest line dips to z {low}");
    // the top near either end keeps its width: the cut's top, where the top runs flat across
    for (x, want) in [(-90.3, 17.97), (104.7, 6.15)] {
        let cut = section(&m, x);
        let top = cut.iter().map(|p| p[2]).fold(f64::MIN, f64::max);
        let top_line: Vec<f64> = cut
            .iter()
            .filter(|p| (p[2] - top).abs() < 1e-4)
            .map(|p| p[1])
            .collect();
        let w = top_line.iter().copied().fold(f64::MIN, f64::max)
            - top_line.iter().copied().fold(f64::MAX, f64::min);
        assert!((w - want).abs() <= 0.1, "the top is {w} mm wide at x {x}");
    }
}
