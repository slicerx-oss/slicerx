// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! a surface made a solid: the sheet offset to one side, the other or both, with walls along its open edges
// vertex and triangle indices come from the mesh given, which is checked first
#![allow(clippy::indexing_slicing)]

use crate::boolean;
use crate::error::{Error, Result};
use crate::faces;
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::vec3::{self, V3};
use rustc_hash::FxHashMap;
use serde::Deserialize;

/// The thickest shell one thicken makes, mm.
pub const MAX_THICKNESS_MM: f64 = 1000.0;
/// A vertex at a crease moves at most this many times the thickness, so the sheet keeps its thickness across it.
const MAX_MITER: f64 = 2.0;

/// How thick to make a surface, and to which side of it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thicken {
    pub thickness_mm: f64,
    #[serde(default)]
    pub side: Side,
}

/// The side of the surface the material goes: the way its triangles face, the other way, or half each way.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    #[default]
    Outward,
    Inward,
    Center,
}

impl Side {
    fn word(self) -> &'static str {
        match self {
            Self::Outward => "outward",
            Self::Inward => "inward",
            Self::Center => "centered",
        }
    }
}

/// The solid of `t.thickness_mm` grown from `surface`, an open or closed sheet whose triangles all face one way:
/// outward is the way they face. Each vertex moves along its normal, scaled at a crease so the faces on either side
/// keep the thickness; the open edges get walls straight across the shell. Refused when the shell would fold over
/// itself where the sheet bends tighter than the thickness, or run into itself where parts of the sheet are close.
pub fn thicken(surface: &TriMesh, t: &Thicken) -> Result<TriMesh> {
    let th = t.thickness_mm;
    if !(th.is_finite() && th > 0.0 && th <= MAX_THICKNESS_MM) {
        return Err(Error::invalid(
            "thicken",
            format!("thicknessMm must be more than 0 and at most {MAX_THICKNESS_MM} mm"),
        ));
    }
    let n = surface.positions.len();
    let boundary = open_edges(surface)?;
    let offsets = vertex_offsets(surface)?;
    let (lo, hi) = match t.side {
        Side::Outward => (0.0, th),
        Side::Inward => (-th, 0.0),
        Side::Center => (-th / 2.0, th / 2.0),
    };
    for d in [lo, hi] {
        if d != 0.0 {
            folds(surface, &offsets, d, t)?;
        }
    }
    let at = |d: f64| -> Vec<V3> {
        surface
            .positions
            .iter()
            .zip(&offsets)
            .map(|(&p, &o)| vec3::add(p, vec3::scale(o, d)))
            .collect()
    };
    let mut positions = at(hi);
    positions.extend(at(lo));
    let mut m = TriMesh {
        positions,
        triangles: Vec::with_capacity(surface.triangles.len() * 2),
        faces: None,
    };
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the mesh was checked below 2^31 vertices"
    )]
    let low = |v: u32| v + n as u32;
    m.triangles.extend_from_slice(&surface.triangles);
    m.triangles.extend(
        surface
            .triangles
            .iter()
            .map(|&[a, b, c]| [low(a), low(c), low(b)]),
    );
    for (a, b) in boundary {
        m.triangles.push([b, a, low(a)]);
        m.triangles.push([b, low(a), low(b)]);
    }
    let e = m.edge_report();
    if !e.is_watertight() {
        return Err(Error::geometry(
            "thicken",
            "the surface is not one clean sheet, so the shell would not close; check that the profiles do not cross themselves",
        ));
    }
    if boolean::Solid::new(&m).is_ok_and(|s| s.self_intersects()) {
        return Err(Error::geometry(
            "thicken",
            format!(
                "a {th} mm {} shell runs into itself where parts of the surface are closer than that; use a thinner shell or move those parts apart",
                t.side.word()
            ),
        ));
    }
    m.faces = Some(faces::recognize(&m));
    Ok(m)
}

/// The surface's open edges, each the way a triangle runs along it. Fails when an edge has more than two triangles or
/// two triangles that run along it the same way (the sheet does not face one way).
fn open_edges(m: &TriMesh) -> Result<Vec<(u32, u32)>> {
    m.validate("thicken")?;
    if m.triangles.is_empty() {
        return Err(Error::invalid("thicken", "there is no surface to thicken"));
    }
    let mut edges: FxHashMap<(u32, u32), u32> = FxHashMap::default();
    for t in &m.triangles {
        for k in 0..3 {
            *edges.entry((t[k], t[(k + 1) % 3])).or_insert(0) += 1;
        }
    }
    let mut open = Vec::new();
    for (&(a, b), &c) in &edges {
        if c > 1 || edges.get(&(b, a)).copied().unwrap_or(0) > 1 {
            return Err(Error::geometry(
                "thicken",
                "the surface folds onto itself or turns over along an edge, so it has no one outward side",
            ));
        }
        if !edges.contains_key(&(b, a)) {
            open.push((a, b));
        }
    }
    open.sort_unstable();
    Ok(open)
}

/// Each vertex's offset: along its normal (its triangles' normals weighted by their angle there), long enough to move
/// it one unit off each of its triangles' planes, and at most `MAX_MITER` long.
fn vertex_offsets(m: &TriMesh) -> Result<Vec<V3>> {
    let n = m.positions.len();
    let mut sum = vec![[0.0; 3]; n];
    let mut face_normals = Vec::with_capacity(m.triangles.len());
    for t in &m.triangles {
        let p = t.map(|i| m.positions[i as usize]);
        let nf = vec3::normalize(vec3::tri_normal(p[0], p[1], p[2]));
        face_normals.push(nf);
        let Some(nf) = nf else { continue };
        for k in 0..3 {
            let (a, b) = (vec3::sub(p[(k + 1) % 3], p[k]), vec3::sub(p[(k + 2) % 3], p[k]));
            let c = (vec3::dot(a, b) / (vec3::len(a) * vec3::len(b))).clamp(-1.0, 1.0);
            let w = c.m_acos();
            sum[t[k] as usize] = vec3::add(sum[t[k] as usize], vec3::scale(nf, w));
        }
    }
    let mut normals = Vec::with_capacity(n);
    for (i, s) in sum.iter().enumerate() {
        let Some(v) = vec3::normalize(*s) else {
            let p = m.positions[i];
            return Err(Error::geometry(
                "thicken",
                format!(
                    "the surface has no clear outward side at ({:.2}, {:.2}, {:.2}) mm, where it turns back on itself",
                    p[0], p[1], p[2]
                ),
            ));
        };
        normals.push(v);
    }
    // the least dot product with a triangle's normal at each vertex: the miter that keeps that triangle's distance
    let mut least = vec![1.0f64; n];
    for (t, nf) in m.triangles.iter().zip(&face_normals) {
        let Some(nf) = nf else { continue };
        for &v in t {
            let d = vec3::dot(normals[v as usize], *nf);
            least[v as usize] = least[v as usize].min(d);
        }
    }
    Ok(normals
        .iter()
        .zip(&least)
        .map(|(&nv, &d)| vec3::scale(nv, 1.0 / d.max(1.0 / MAX_MITER)))
        .collect())
}

/// Whether a triangle turns over when the sheet moves `d` along the offsets.
fn turned(m: &TriMesh, offsets: &[V3], tri: [u32; 3], d: f64) -> bool {
    let p = tri.map(|i| m.positions[i as usize]);
    let q = tri.map(|i| vec3::add(m.positions[i as usize], vec3::scale(offsets[i as usize], d)));
    let before = vec3::tri_normal(p[0], p[1], p[2]);
    let after = vec3::tri_normal(q[0], q[1], q[2]);
    vec3::dot(before, after) <= 0.0
}

/// Fails when moving the sheet `d` turns a triangle over: the shell is thicker there than the sheet's bend allows.
/// The sentence names where and the most that side takes.
fn folds(m: &TriMesh, offsets: &[V3], d: f64, t: &Thicken) -> Result<()> {
    let Some(&first) = m.triangles.iter().find(|&&tri| turned(m, offsets, tri, d)) else {
        return Ok(());
    };
    // the largest move that turns no triangle over, to a hundredth of a millimeter
    let any = |x: f64| m.triangles.iter().any(|&tri| turned(m, offsets, tri, x));
    let (mut ok, mut bad) = (0.0f64, d.abs());
    while bad - ok > 0.005 {
        let mid = f64::midpoint(ok, bad);
        if any(mid * d.signum()) {
            bad = mid;
        } else {
            ok = mid;
        }
    }
    let worst = m
        .triangles
        .iter()
        .find(|&&tri| turned(m, offsets, tri, bad * d.signum()))
        .copied()
        .unwrap_or(first);
    let c = vec3::scale(
        worst
            .iter()
            .fold([0.0; 3], |s, &i| vec3::add(s, m.positions[i as usize])),
        1.0 / 3.0,
    );
    let most = if t.side == Side::Center { ok * 2.0 } else { ok };
    let other = match t.side {
        Side::Inward => "outward",
        Side::Outward => "inward",
        Side::Center => "to one side",
    };
    Err(Error::geometry(
        "thicken",
        format!(
            "a {} mm {} shell folds over itself where the surface bends tightest, near ({:.2}, {:.2}, {:.2}) mm; the bend there takes at most {:.2} mm {}, so use a thinner shell or thicken {other}",
            t.thickness_mm,
            t.side.word(),
            c[0],
            c[1],
            c[2],
            most,
            t.side.word()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat grid in the xy plane, `w` by `h` mm with `nx` by `ny` cells, facing up.
    #[allow(clippy::cast_possible_truncation, reason = "small grids")]
    fn sheet(w: f64, h: f64, nx: usize, ny: usize) -> TriMesh {
        let mut m = TriMesh::default();
        for j in 0..=ny {
            for i in 0..=nx {
                m.positions
                    .push([w * i as f64 / nx as f64, h * j as f64 / ny as f64, 0.0]);
            }
        }
        let at = |i: usize, j: usize| (j * (nx + 1) + i) as u32;
        for j in 0..ny {
            for i in 0..nx {
                m.triangles.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)]);
                m.triangles.push([at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
            }
        }
        m
    }

    fn th(mm: f64, side: Side) -> Thicken {
        Thicken {
            thickness_mm: mm,
            side,
        }
    }

    #[test]
    fn a_flat_sheet_is_its_area_times_the_thickness() {
        let s = sheet(20.0, 10.0, 4, 3);
        for side in [Side::Outward, Side::Inward, Side::Center] {
            let m = thicken(&s, &th(2.0, side)).unwrap();
            assert!(m.edge_report().is_watertight(), "{side:?}");
            assert!((m.volume() - 400.0).abs() < 1e-9, "{side:?} {}", m.volume());
            let b = m.bounds().unwrap();
            let want = match side {
                Side::Outward => (0.0, 2.0),
                Side::Inward => (-2.0, 0.0),
                Side::Center => (-1.0, 1.0),
            };
            assert!((b.min[2] - want.0).abs() < 1e-12 && (b.max[2] - want.1).abs() < 1e-12);
        }
    }

    #[test]
    fn a_crease_keeps_its_thickness() {
        // a sheet bent 90 degrees along x = 10: the outer faces stay 2 mm off each half
        let mut s = sheet(20.0, 10.0, 2, 1);
        for p in &mut s.positions {
            if p[0] > 10.0 {
                *p = [10.0, p[1], p[0] - 10.0];
            }
        }
        // the bent sheet faces into the corner: outward fills the inside of the L, inward wraps its outside
        for (side, area) in [
            (Side::Outward, 10.0 * 2.0 + 2.0 * 8.0),
            (Side::Inward, 12.0 * 2.0 + 2.0 * 10.0),
        ] {
            let m = thicken(&s, &th(2.0, side)).unwrap();
            assert!(m.edge_report().is_watertight());
            assert!((m.volume() - area * 10.0).abs() < 1e-9, "{side:?} {}", m.volume());
        }
    }

    #[test]
    fn refuses_what_it_cannot_make() {
        let s = sheet(10.0, 10.0, 1, 1);
        let err = |t: Thicken| thicken(&s, &t).unwrap_err().to_string();
        assert_eq!(
            err(th(0.0, Side::Outward)),
            "thicken: thicknessMm must be more than 0 and at most 1000 mm"
        );
        assert!(err(th(f64::NAN, Side::Outward)).contains("more than 0"));
        let mut flipped = s.clone();
        flipped.triangles[1] = [
            flipped.triangles[1][0],
            flipped.triangles[1][2],
            flipped.triangles[1][1],
        ];
        assert!(
            thicken(&flipped, &th(1.0, Side::Outward))
                .unwrap_err()
                .to_string()
                .contains("no one outward side")
        );
    }

    #[test]
    fn a_sharp_crease_stays_closed() {
        // a sheet folded back 150 degrees along x = 10: the miter is held to twice the thickness there
        let mut s = sheet(20.0, 10.0, 2, 1);
        let (c, sn) = (150f64.to_radians().m_cos(), 150f64.to_radians().m_sin());
        for p in &mut s.positions {
            if p[0] > 10.0 {
                let d = p[0] - 10.0;
                *p = [10.0 + d * c, p[1], d * sn];
            }
        }
        for side in [Side::Outward, Side::Inward] {
            let m = thicken(&s, &th(0.5, side)).unwrap();
            assert!(m.edge_report().is_watertight(), "{side:?}");
            // two 10 by 10 slabs 0.5 mm thick, less the wedge the clamped miter cuts off inside the fold
            assert!(m.volume() > 65.0 && m.volume() < 100.0, "{side:?} {}", m.volume());
        }
    }
}
