// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! linear and circular arrays

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport};
use crate::error::{Error, Result};
use crate::faces::{Faces, Surface};
use crate::fm::Fm as _;
use crate::mesh::{Aabb, TriMesh};
use crate::vec3::{self, V3};
use crate::xform::{self, Mat4};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::f64::consts::{PI, TAU};

pub const MAX_COPIES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ArraySpec {
    Linear {
        count: usize,
        /// offset between neighbors in mm, for example `[25, 0, 0]`
        step: V3,
        #[serde(default)]
        count2: Option<usize>,
        #[serde(default)]
        step2: Option<V3>,
    },
    Circular {
        count: usize,
        center: V3,
        /// default +Z
        #[serde(default)]
        axis: Option<V3>,
        #[serde(default)]
        angle_deg: Option<f64>,
        #[serde(default)]
        rotate_copies: Option<bool>,
    },
}

pub fn transforms(spec: &ArraySpec) -> Result<Vec<Mat4>> {
    let check = |n: usize, what: &'static str| {
        if n == 0 {
            Err(Error::invalid(what, "must be at least 1"))
        } else {
            Ok(n)
        }
    };
    match spec {
        ArraySpec::Linear {
            count,
            step,
            count2,
            step2,
        } => {
            let n1 = check(*count, "count")?;
            let n2 = check(count2.unwrap_or(1), "count2")?;
            if n1.saturating_mul(n2) > MAX_COPIES {
                return Err(Error::invalid("count", format!("at most {MAX_COPIES} copies")));
            }
            let s2 = step2.unwrap_or([0.0; 3]);
            if !step.iter().chain(&s2).all(|c| c.is_finite()) {
                return Err(Error::invalid("step", "must be finite"));
            }
            if n2 > 1 && vec3::len(s2) == 0.0 {
                return Err(Error::invalid("step2", "needed for a grid"));
            }
            let mut out = Vec::with_capacity(n1 * n2);
            for j in 0..n2 {
                for i in 0..n1 {
                    let d = vec3::add(vec3::scale(*step, i as f64), vec3::scale(s2, j as f64));
                    out.push(xform::translation(d));
                }
            }
            Ok(out)
        }
        ArraySpec::Circular {
            count,
            center,
            axis,
            angle_deg,
            ..
        } => {
            let n = check(*count, "count")?;
            if n > MAX_COPIES {
                return Err(Error::invalid("count", format!("at most {MAX_COPIES} copies")));
            }
            let axis = vec3::normalize(axis.unwrap_or([0.0, 0.0, 1.0]))
                .ok_or_else(|| Error::invalid("axis", "must be a non-zero vector"))?;
            let sweep = angle_deg.unwrap_or(360.0);
            if !(sweep.is_finite() && sweep.abs() <= 360.0) {
                return Err(Error::invalid("angleDeg", "between -360 and 360"));
            }
            let full = (sweep.abs() - 360.0).abs() < 1e-9;
            let step = if full {
                sweep / n as f64
            } else if n > 1 {
                sweep / (n - 1) as f64
            } else {
                0.0
            };
            Ok((0..n)
                .map(|i| xform::rotation_about(*center, axis, (step * i as f64).to_radians()))
                .collect())
        }
    }
}

pub fn transforms_for(mesh: &TriMesh, spec: &ArraySpec) -> Result<Vec<Mat4>> {
    let ts = transforms(spec)?;
    if let ArraySpec::Circular {
        rotate_copies: Some(false),
        ..
    } = spec
    {
        let c = mesh.bounds().map_or([0.0; 3], |b| b.center());
        return Ok(ts
            .iter()
            .map(|t| xform::translation(vec3::sub(xform::apply(t, c), c)))
            .collect());
    }
    Ok(ts)
}

/// copies whose bounds overlap another copy's (a quick check; touching bounds count when they overlap by more than 1 micron)
pub fn overlapping(mesh: &TriMesh, ts: &[Mat4]) -> bool {
    let boxes: Vec<Aabb> = ts
        .iter()
        .filter_map(|t| xform::transformed(mesh, t).bounds())
        .collect();
    let eps = 1e-3;
    boxes.iter().enumerate().any(|(i, a)| {
        boxes.iter().skip(i + 1).any(|b| {
            a.min
                .iter()
                .zip(&a.max)
                .zip(b.min.iter().zip(&b.max))
                .all(|((amin, amax), (bmin, bmax))| amin + eps < *bmax && bmin + eps < *amax)
        })
    })
}

pub fn merged(mesh: &TriMesh, spec: &ArraySpec, opts: &BooleanOptions) -> Result<(TriMesh, BooleanReport)> {
    let ts = transforms_for(mesh, spec)?;
    let lined = match turn(spec) {
        Some(t) => lined_up(mesh, &t, *opts)?,
        None => None,
    };
    let (mut all, part, bores) = match &lined {
        Some(l) => (l.once.clone(), &l.rest, &l.bores[..]),
        None => (Vec::new(), mesh, &[][..]),
    };
    if !part.triangles.is_empty() {
        let copies = distinct(part, &ts, &all);
        all.extend(copies);
    }
    if bores.is_empty() {
        boolean::boolean_array(&all, &[], BoolOp::Union, *opts)
    } else {
        boolean::boolean_array(&all, bores, BoolOp::Difference, *opts)
    }
}

/// a circular array's axis, as a frame with `w` along it, and the copies a full turn would take
struct Turn {
    frame: vec3::Frame,
    steps: usize,
}

fn turn(spec: &ArraySpec) -> Option<Turn> {
    let ArraySpec::Circular {
        count,
        center,
        axis,
        angle_deg,
        rotate_copies,
    } = spec
    else {
        return None;
    };
    // only copies all round a full turn cover a round from every side
    let full = (angle_deg.unwrap_or(360.0).abs() - 360.0).abs() < 1e-9;
    if *count < 2 || *count > MAX_COPIES || *rotate_copies == Some(false) || !full {
        return None;
    }
    let w = vec3::normalize(axis.unwrap_or([0.0, 0.0, 1.0]))?;
    let u = vec3::normalize(vec3::any_perpendicular(w))?;
    Some(Turn {
        frame: vec3::Frame {
            origin: *center,
            u,
            v: vec3::cross(w, u),
            w,
        },
        steps: *count,
    })
}

/// a faceted round on the array's axis
struct Round {
    radius: f64,
    h: (f64, f64),
    facets: usize,
    phase: f64,
    sides: Vec<usize>,
    /// how many bands the wall is split into along the axis
    bands: usize,
    /// a bore's wall, facing the axis
    inner: bool,
    /// how far its corners sit from the ideal prism, at most `ROUND_TOL`
    dev: f64,
}

/// what to join once, what to copy, and the bores to cut after the union
struct Lined {
    once: Vec<TriMesh>,
    rest: TriMesh,
    bores: Vec<TriMesh>,
}

/// how close corners must be to count as on one round, in mm
const ROUND_TOL: f64 = 1e-4;

/// the most volume a solid round may miss and still count as solid, in mm3
const MAX_LOSS: f64 = 1e-3;

/// what to join once and what to copy, with the rounds on the axis lined up so copies don't leave slivers
fn lined_up(mesh: &TriMesh, t: &Turn, opts: BooleanOptions) -> Result<Option<Lined>> {
    let local = in_turn(mesh, t);
    let rounds = rounds(mesh, &local);
    let facets = |r: &Round| r.facets.div_ceil(t.steps) * t.steps;
    if let [r] = &rounds[..]
        && !r.inner
        && plain(mesh, &local, r)
    {
        return Ok(Some(Lined {
            once: Vec::new(),
            rest: prism(mesh, &local, t, r, facets(r), false),
            bores: Vec::new(),
        }));
    }
    if rounds.iter().all(|r| r.facets % t.steps == 0) {
        return Ok(None);
    }
    let (inner, outer): (Vec<&Round>, Vec<&Round>) = rounds.iter().partition(|r| r.inner);
    // the corners' drift over the surface, capped so a small recess on a big round still counts
    let within = |got: f64, own: &TriMesh, r: &Round| {
        (got - own.volume()).abs() <= (r.dev.max(1e-9) * own.area()).min(MAX_LOSS)
    };
    let meet = |a: &TriMesh, b: &TriMesh| {
        #[cfg(test)]
        MEETS.set(MEETS.get() + 1);
        boolean::boolean_array(
            std::slice::from_ref(a),
            std::slice::from_ref(b),
            BoolOp::Intersection,
            opts,
        )
        .ok()
        .map(|(m, _)| m.volume())
    };
    // a bore is filled before copying and cut once after, so it must be empty through
    for r in &inner {
        // a full ring of wall, and nothing but that wall out to the fill: no groove gets sealed behind a skin
        let fill = facets(r);
        if r.sides.len() != 2 * r.facets * r.bands
            || !clear_inside(
                mesh,
                &local,
                r,
                fill,
                r.radius / (PI / fill as f64).m_cos(),
                &r.sides,
            )
        {
            return Ok(None);
        }
    }
    let filled = if inner.is_empty() {
        mesh.clone()
    } else {
        let fills: Vec<TriMesh> = inner
            .iter()
            .map(|r| prism(mesh, &local, t, r, facets(r), true))
            .collect();
        boolean::boolean_array(std::slice::from_ref(mesh), &fills, BoolOp::Union, opts)?.0
    };
    let misaligned: Vec<&Round> = outer.into_iter().filter(|r| r.facets % t.steps != 0).collect();
    // a wrap fills what it covers: each round must be solid through, its own prism inside the part
    let filled_local = if inner.is_empty() {
        local.clone()
    } else {
        in_turn(&filled, t)
    };
    for r in &misaligned {
        // with no bore filled the part is the mesh itself, so the round's own wall can be left out
        let own_wall: &[usize] = if inner.is_empty() { &r.sides } else { &[] };
        if clear_inside(&filled, &filled_local, r, r.facets, r.radius, own_wall) {
            continue;
        }
        let own = prism(mesh, &local, t, r, r.facets, false);
        if !meet(&own, &filled).is_some_and(|v| within(v, &own, r)) {
            return Ok(None);
        }
    }
    let once: Vec<TriMesh> = misaligned
        .iter()
        .map(|r| prism(mesh, &local, t, r, facets(r), true))
        .collect();
    let rest = if once.is_empty() {
        filled
    } else {
        boolean::boolean_array(std::slice::from_ref(&filled), &once, BoolOp::Difference, opts)?.0
    };
    // stored corners that drift past the wrap leave slivers of no volume, which the copies would only multiply
    let rest = solid(&rest);
    let rest = if rest.triangles.is_empty() {
        rest
    } else {
        let wraps: Vec<(&Round, usize)> = misaligned.iter().map(|r| (*r, facets(r))).collect();
        sunk(rest, t, &wraps)
    };
    let bores = inner
        .iter()
        .map(|r| prism(mesh, &local, t, r, facets(r), false))
        .collect();
    Ok(Some(Lined { once, rest, bores }))
}

/// how far the corners a copy has on a wrap are moved into it, in mm
const SINK: f64 = 1e-3;

/// corners on a wrap moved `SINK` into it along the copy's own faces; a copy only touching it crosses it once stored
#[allow(clippy::cast_precision_loss, reason = "facet counts are small")]
fn sunk(mut m: TriMesh, t: &Turn, wraps: &[(&Round, usize)]) -> TriMesh {
    let local = in_turn(&m, t);
    // the outward normal of the wrap's face a point lies on; the faces sit at the round's radius
    let wrap = |q: V3| {
        wraps.iter().find_map(|&(r, facets)| {
            if q[2] < r.h.0 - ROUND_TOL || q[2] > r.h.1 + ROUND_TOL {
                return None;
            }
            let pitch = TAU / facets as f64;
            let k = ((q[1].m_atan2(q[0]) - r.phase) / pitch).floor() + 0.5;
            let (s, c) = (r.phase + k * pitch).m_sin_cos();
            ((q[0] * c + q[1] * s - r.radius).abs() <= ROUND_TOL)
                .then(|| vec3::add(vec3::scale(t.frame.u, c), vec3::scale(t.frame.v, s)))
        })
    };
    let on: Vec<Option<V3>> = local.iter().map(|&q| wrap(q)).collect();
    // the planes of the copy's faces at those corners, but not of its faces lying on the wrap
    let mut planes: Vec<Vec<V3>> = vec![Vec::new(); local.len()];
    for tri in &m.triangles {
        let [a, b, c] = m.corners(*tri);
        let Some(n) = vec3::normalize(vec3::tri_normal(a, b, c)) else {
            continue;
        };
        let mid = tri
            .iter()
            .filter_map(|&i| local.get(i as usize))
            .fold([0.0; 3], |s, &q| vec3::add(s, vec3::scale(q, 1.0 / 3.0)));
        if wrap(mid).is_some_and(|w| vec3::dot(w, n).abs() > 1.0 - 1e-6) {
            continue;
        }
        for &i in tri {
            if let (Some(Some(_)), Some(ps)) = (on.get(i as usize), planes.get_mut(i as usize))
                && !ps.iter().any(|p| vec3::dot(*p, n).abs() > 1.0 - 1e-6)
            {
                ps.push(n);
            }
        }
    }
    // a piece whose copies meet on the wrap stays put: sunk the same depth, their faces there would meet again
    let piece = pieces(&m);
    let mut angles: HashMap<usize, Vec<f64>> = HashMap::new();
    for ((q, w), &k) in local.iter().zip(&on).zip(&piece) {
        if w.is_some() {
            angles.entry(k).or_default().push(q[1].m_atan2(q[0]));
        }
    }
    let wide: HashSet<usize> = angles
        .into_iter()
        .filter(|(_, a)| span(a) >= TAU / t.steps as f64 - 1e-9)
        .map(|(k, _)| k)
        .collect();
    for (((p, w), ps), k) in m.positions.iter_mut().zip(&on).zip(&planes).zip(&piece) {
        let Some(w) = *w else {
            continue;
        };
        if wide.contains(k) {
            continue;
        }
        // along both planes at a corner of the copy, in its one plane on an edge, straight in on a face
        let d = match ps.as_slice() {
            [] => vec3::scale(w, -1.0),
            [a] => vec3::sub(vec3::scale(*a, vec3::dot(w, *a)), w),
            [a, b] => {
                let d = vec3::cross(*a, *b);
                if vec3::dot(d, w) > 0.0 {
                    vec3::scale(d, -1.0)
                } else {
                    d
                }
            }
            _ => continue,
        };
        // a direction mostly along the wrap would move the corner far for little depth
        let depth = -vec3::dot(d, w);
        if depth > 0.5 * vec3::len(d) {
            *p = vec3::add(*p, vec3::scale(d, SINK / depth));
        }
    }
    m
}

/// the mesh without its pieces of no more than `MAX_LOSS` volume
fn solid(m: &TriMesh) -> TriMesh {
    let piece = pieces(m);
    let of = |tri: &[u32; 3]| piece.get(tri[0] as usize).copied().unwrap_or(0);
    let mut volume: HashMap<usize, f64> = HashMap::new();
    for tri in &m.triangles {
        let [a, b, c] = m.corners(*tri);
        *volume.entry(of(tri)).or_default() += vec3::dot(a, vec3::cross(b, c)) / 6.0;
    }
    let keep: Vec<usize> = (0..m.triangles.len())
        .filter(|&k| {
            m.triangles
                .get(k)
                .and_then(|tri| volume.get(&of(tri)))
                .is_some_and(|v| v.abs() > MAX_LOSS)
        })
        .collect();
    if keep.is_empty() {
        TriMesh::default()
    } else if keep.len() == m.triangles.len() {
        m.clone()
    } else {
        m.subset_of(&keep)
    }
}

/// the connected piece each corner is in
fn pieces(m: &TriMesh) -> Vec<usize> {
    fn root(up: &mut [usize], mut x: usize) -> usize {
        while let Some(&p) = up.get(x)
            && p != x
        {
            let pp = up.get(p).copied().unwrap_or(p);
            if let Some(u) = up.get_mut(x) {
                *u = pp;
            }
            x = pp;
        }
        x
    }
    let mut up: Vec<usize> = (0..m.positions.len()).collect();
    for tri in &m.triangles {
        let a = root(&mut up, tri[0] as usize);
        for &i in &tri[1..] {
            let b = root(&mut up, i as usize);
            if let Some(u) = up.get_mut(b) {
                *u = a;
            }
        }
    }
    (0..up.len()).map(|i| root(&mut up, i)).collect()
}

/// how far round the axis the angles reach, the largest gap between them left out
fn span(angles: &[f64]) -> f64 {
    let mut a = angles.to_vec();
    a.sort_by(f64::total_cmp);
    let (Some(first), Some(last)) = (a.first(), a.last()) else {
        return 0.0;
    };
    let gap = a
        .windows(2)
        .filter_map(|w| Some(w.get(1)? - w.first()?))
        .fold(first + TAU - last, f64::max);
    TAU - gap
}

#[cfg(test)]
thread_local! {
    /// volume checks run on this thread, for tests
    static MEETS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// the mesh's corners in the turn's frame, `w` along the axis
fn in_turn(mesh: &TriMesh, t: &Turn) -> Vec<V3> {
    mesh.positions
        .iter()
        .map(|&p| {
            let d = vec3::sub(p, t.frame.origin);
            [
                vec3::dot(d, t.frame.u),
                vec3::dot(d, t.frame.v),
                vec3::dot(d, t.frame.w),
            ]
        })
        .collect()
}

/// whether no face but `skip` reaches inside an `n` sided prism of the round, shrunk past its drift; then it is all one side
/// (a feature shallower than the drift is not seen)
#[allow(clippy::cast_precision_loss, reason = "facet counts are small")]
fn clear_inside(mesh: &TriMesh, local: &[V3], r: &Round, facets: usize, radius: f64, skip: &[usize]) -> bool {
    let n = facets as f64;
    // a corner can drift both out and along the circle, so its chord reaches up to about 1.41 times the drift in
    let tol = 1.5 * r.dev + 1e-9;
    let apothem = radius * (PI / n).m_cos();
    if apothem <= 2.0 * tol || r.h.1 - r.h.0 <= 2.0 * tol {
        return false;
    }
    let inner = apothem - tol;
    let scale = inner / apothem;
    let at = |k: f64| (r.phase + TAU * k / n).m_sin_cos();
    let corners: Vec<[f64; 2]> = (0..facets)
        .map(|j| {
            let (s, c) = at(j as f64);
            [radius * scale * c, radius * scale * s]
        })
        .collect();
    let normals: Vec<[f64; 2]> = (0..facets)
        .map(|k| {
            let (s, c) = at(k as f64 + 0.5);
            [c, s]
        })
        .collect();
    let (z0, z1) = (r.h.0 + tol, r.h.1 - tol);
    let mut skipped = vec![false; mesh.triangles.len()];
    for &k in skip {
        if let Some(s) = skipped.get_mut(k) {
            *s = true;
        }
    }
    mesh.triangles.iter().zip(&skipped).all(|(tri, &skip)| {
        let p = tri.map(|i| local.get(i as usize).copied().unwrap_or_default());
        if skip || p.iter().all(|q| q[2] <= z0) || p.iter().all(|q| q[2] >= z1) {
            return true;
        }
        // apart if a side of the prism or of the triangle's shadow has them on opposite sides
        if normals
            .iter()
            .any(|m| p.iter().all(|q| q[0] * m[0] + q[1] * m[1] >= inner))
        {
            return true;
        }
        let mut edges = (0..3).filter_map(|e| {
            let a = p.get(e)?;
            let b = p.get((e + 1) % 3)?;
            let c = p.get((e + 2) % 3)?;
            Some((*a, [b[1] - a[1], a[0] - b[0]], *c))
        });
        edges.any(|(a, m, c)| {
            let side = |q: [f64; 2]| (q[0] - a[0]) * m[0] + (q[1] - a[1]) * m[1];
            if m[0] == 0.0 && m[1] == 0.0 {
                return false;
            }
            let sc = side([c[0], c[1]]);
            if sc == 0.0 {
                // a wall seen edge on: apart when the prism is all to one side of its line
                return corners.iter().all(|&q| side(q) >= 0.0) || corners.iter().all(|&q| side(q) <= 0.0);
            }
            corners.iter().all(|&q| side(q) * sc <= 0.0)
        })
    })
}

fn radius_of(p: V3) -> f64 {
    p[0].m_hypot(p[1])
}

/// the faceted rounds on the axis: side facets with all three corners at one radius and parallel to the axis
#[allow(
    clippy::too_many_lines,
    reason = "one pass over the side facets, round by round"
)]
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a facet count checked to a small positive range"
)]
fn rounds(mesh: &TriMesh, local: &[V3]) -> Vec<Round> {
    let at = |i: u32| local.get(i as usize).copied().unwrap_or_default();
    let mut sides: Vec<(f64, usize, bool)> =
        mesh.triangles
            .iter()
            .enumerate()
            .filter_map(|(k, tri)| {
                let rs = tri.map(|i| radius_of(at(i)));
                let r = rs.iter().sum::<f64>() / 3.0;
                let [a, b, c] = tri.map(at);
                let n = vec3::normalize(vec3::tri_normal(a, b, c))?;
                let mid = vec3::scale(vec3::add(vec3::add(a, b), c), 1.0 / 3.0);
                (r > ROUND_TOL && rs.iter().all(|x| (x - r).abs() < ROUND_TOL) && n[2].abs() < 1e-6)
                    .then_some((r, k, n[0] * mid[0] + n[1] * mid[1] < 0.0))
            })
            .collect();
    sides.sort_by(|a, b| a.2.cmp(&b.2).then(a.0.total_cmp(&b.0)));
    let wall: HashSet<usize> = sides.iter().map(|s| s.1).collect();
    // corners on a flat face across the axis, and the faces that are no wall at each corner
    let mut flat = vec![false; local.len()];
    let mut other: Vec<Vec<usize>> = vec![Vec::new(); local.len()];
    for (k, tri) in mesh.triangles.iter().enumerate() {
        let [a, b, c] = tri.map(at);
        let across = vec3::normalize(vec3::tri_normal(a, b, c)).is_some_and(|n| n[2].abs() > 1.0 - 1e-6);
        for &i in tri {
            if let (Some(f), Some(o)) = (flat.get_mut(i as usize), other.get_mut(i as usize)) {
                *f |= across;
                if !wall.contains(&k) {
                    o.push(k);
                }
            }
        }
    }
    sides
        .chunk_by(|a, b| a.2 == b.2 && b.0 - a.0 < ROUND_TOL)
        .filter_map(|group| {
            let radius = group.iter().map(|g| g.0).sum::<f64>() / group.len() as f64;
            let inner = group.first().is_some_and(|g| g.2);
            let ids: Vec<u32> = group
                .iter()
                .filter_map(|g| mesh.triangles.get(g.1))
                .flatten()
                .copied()
                .collect();
            let mut corners: Vec<V3> = ids.iter().map(|&i| at(i)).collect();
            let h0 = corners.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
            let h1 = corners.iter().map(|p| p[2]).fold(f64::NEG_INFINITY, f64::max);
            let to_end = |z: f64| (z - h0).abs().min((z - h1).abs());
            let end = |z: f64| to_end(z) <= ROUND_TOL;
            // ends on flat faces across the axis, so a sphere's middle band is no cylinder
            if h1 - h0 < ROUND_TOL
                || !ids
                    .iter()
                    .all(|&i| !end(at(i)[2]) || flat.get(i as usize) == Some(&true))
            {
                return None;
            }
            let mut hs: Vec<f64> = corners.iter().map(|p| p[2]).collect();
            hs.sort_by(f64::total_cmp);
            hs.dedup_by(|b, a| *b - *a < ROUND_TOL);
            let eps = ROUND_TOL / radius;
            corners.sort_by(|a, b| a[1].m_atan2(a[0]).total_cmp(&b[1].m_atan2(b[0])));
            let mut angles: Vec<f64> = corners.iter().map(|p| p[1].m_atan2(p[0])).collect();
            angles.dedup_by(|b, a| *b - *a < eps);
            let gap = angles
                .windows(2)
                .filter_map(|w| Some(w.get(1)? - w.first()?))
                .fold(f64::INFINITY, f64::min);
            let facets = (TAU / gap).round();
            if !(3.0..=16384.0).contains(&facets) {
                return None;
            }
            let phase = *angles.first()?;
            let pitch = TAU / facets;
            let off = angles
                .iter()
                .map(|a| {
                    let k = (a - phase) / pitch;
                    (k - k.round()).abs() * pitch * radius
                })
                .fold(0.0, f64::max);
            let regular = off < ROUND_TOL;
            let dev = corners
                .iter()
                .map(|p| {
                    (radius_of(*p) - radius)
                        .abs()
                        .max(if end(p[2]) { to_end(p[2]) } else { 0.0 })
                })
                .fold(off, f64::max);
            // a tessellated round, not a polygon; the wrap moves it out at most 0.01 mm
            let half = (PI / facets).m_cos();
            let fine = radius * (1.0 - half) <= 0.05 && radius * (1.0 / half - 1.0) <= 0.01;
            if !(regular && fine && 2 * angles.len() >= facets as usize) {
                return None;
            }
            // corners between the ends only on walls, so a wall split into bands counts but a groove or a step does
            // not; an outer round also takes faces wholly outside it, such as a tooth or a lug joined on the wall
            let outside = |p: V3| {
                let k = ((p[1].m_atan2(p[0]) - phase) / pitch).floor() + 0.5;
                let (s, c) = (phase + k * pitch).m_sin_cos();
                p[0] * c + p[1] * s >= radius * half - ROUND_TOL
            };
            let clear = |k: &usize| {
                mesh.triangles
                    .get(*k)
                    .is_some_and(|tri| tri.iter().all(|&j| outside(at(j))))
            };
            let between = ids.iter().all(|&i| {
                end(at(i)[2])
                    || other
                        .get(i as usize)
                        .is_some_and(|o| o.is_empty() || (!inner && o.iter().all(clear)))
            });
            between.then(|| Round {
                radius,
                h: (h0, h1),
                facets: facets as usize,
                phase,
                sides: group.iter().map(|g| g.1).collect(),
                bands: hs.len() - 1,
                inner,
                dev,
            })
        })
        .collect()
}

/// whether the mesh is the whole round and its two flat caps, closed, and nothing else
fn plain(mesh: &TriMesh, local: &[V3], r: &Round) -> bool {
    let at = |i: u32| local.get(i as usize).copied().unwrap_or_default();
    let caps = mesh
        .triangles
        .iter()
        .filter(|tri| {
            let ps = tri.map(at);
            [r.h.0, r.h.1].iter().any(|h| {
                ps.iter()
                    .all(|p| (p[2] - h).abs() < ROUND_TOL && radius_of(*p) < r.radius + ROUND_TOL)
            })
        })
        .count();
    caps + r.sides.len() == mesh.triangles.len()
        && r.sides.len() == 2 * r.facets * r.bands
        && mesh.edge_report().is_watertight()
}

/// the round as a prism with fanned caps, so every copy is the same triangles; wrapped, it holds the old facets
#[allow(clippy::cast_possible_truncation, reason = "vertex counts stay below 2^32")]
fn prism(mesh: &TriMesh, local: &[V3], t: &Turn, r: &Round, facets: usize, wrap: bool) -> TriMesh {
    let f = &t.frame;
    let radius = if wrap {
        r.radius / (PI / facets as f64).m_cos()
    } else {
        r.radius
    };
    let point = |x: f64, y: f64, h: f64| {
        vec3::add(
            f.origin,
            vec3::add(
                vec3::add(vec3::scale(f.u, x), vec3::scale(f.v, y)),
                vec3::scale(f.w, h),
            ),
        )
    };
    let mut positions = Vec::with_capacity(2 * facets + 2);
    for h in [r.h.0, r.h.1] {
        for j in 0..facets {
            let (s, c) = (r.phase + TAU * j as f64 / facets as f64).m_sin_cos();
            positions.push(point(radius * c, radius * s, h));
        }
    }
    positions.push(point(0.0, 0.0, r.h.0));
    positions.push(point(0.0, 0.0, r.h.1));
    let n = facets as u32;
    let mut triangles = Vec::with_capacity(4 * facets);
    let mut ids = Vec::with_capacity(4 * facets);
    for j in 0..n {
        let k = (j + 1) % n;
        triangles.extend([
            [j, k, n + k],
            [j, n + k, n + j],
            [2 * n, k, j],
            [2 * n + 1, n + j, n + k],
        ]);
        ids.extend([1, 1, 0, 2]);
    }
    let mut out = TriMesh::new(positions, triangles);
    // the faces the round had, with their keys, so a later step still finds them
    let base = vec3::dot(f.w, f.origin);
    let table = vec![
        Surface::Plane {
            normal: vec3::scale(f.w, -1.0),
            offset: -(base + r.h.0),
        },
        Surface::Cylinder {
            origin: f.origin,
            axis: f.w,
            radius: r.radius,
        },
        Surface::Plane {
            normal: f.w,
            offset: base + r.h.1,
        },
    ];
    let keys = mesh
        .faces
        .as_ref()
        .filter(|faces| !faces.keys.is_empty())
        .map(|faces| {
            let key_of = |tri: Option<usize>| {
                tri.and_then(|t| faces.ids.get(t))
                    .and_then(|&id| faces.keys.get(id as usize))
                    .copied()
                    .unwrap_or(0)
            };
            let cap = |h: f64| {
                mesh.triangles.iter().position(|tri| {
                    tri.iter().all(|&i| {
                        let p = local.get(i as usize).copied().unwrap_or_default();
                        (p[2] - h).abs() < ROUND_TOL && radius_of(p) < r.radius + ROUND_TOL
                    })
                })
            };
            vec![
                key_of(cap(r.h.0)),
                key_of(r.sides.first().copied()),
                key_of(cap(r.h.1)),
            ]
        })
        .unwrap_or_default();
    out.faces = Some(Faces { ids, table, keys });
    out
}

/// the copies snapped onto earlier corners, without exact duplicates, which add nothing to a union
fn distinct(part: &TriMesh, ts: &[Mat4], once: &[TriMesh]) -> Vec<TriMesh> {
    let mut seen: HashMap<[i64; 3], V3> = HashMap::new();
    for &p in once.iter().flat_map(|m| &m.positions) {
        seen.entry(grid(p)).or_insert(p);
    }
    let mut kept: Vec<(TriMesh, Vec<[[i64; 3]; 3]>)> = Vec::new();
    for t in ts {
        let mut c = xform::transformed(part, t);
        for p in &mut c.positions {
            if let Some(q) = near(&seen, *p) {
                *p = q;
            }
        }
        for &p in &c.positions {
            seen.entry(grid(p)).or_insert(p);
        }
        let shape = shape(&c);
        if !kept.iter().any(|(_, s)| *s == shape) {
            kept.push((c, shape));
        }
    }
    kept.into_iter().map(|(c, _)| c).collect()
}

const GRID: f64 = 1e-6;

#[allow(
    clippy::cast_possible_truncation,
    reason = "coordinates in mm over 1e-6 stay far inside i64"
)]
fn grid(p: V3) -> [i64; 3] {
    p.map(|c| (c / GRID).round() as i64)
}

/// a corner kept before within a micron of `p`
fn near(seen: &HashMap<[i64; 3], V3>, p: V3) -> Option<V3> {
    let [x, y, z] = grid(p);
    let close = |k: [i64; 3]| {
        seen.get(&k)
            .copied()
            .filter(|&q| vec3::len(vec3::sub(p, q)) < GRID)
    };
    close([x, y, z]).or_else(|| {
        (-1..=1)
            .flat_map(|i| (-1..=1).flat_map(move |j| (-1..=1).map(move |k| [x + i, y + j, z + k])))
            .find_map(close)
    })
}

/// the triangles as sorted grid corners, equal for the same triangles in any order
fn shape(m: &TriMesh) -> Vec<[[i64; 3]; 3]> {
    let mut out: Vec<[[i64; 3]; 3]> = m
        .triangles
        .iter()
        .map(|&t| {
            let [a, b, c] = m.corners(t).map(grid);
            if a <= b && a <= c {
                [a, b, c]
            } else if b <= c {
                [b, c, a]
            } else {
                [c, a, b]
            }
        })
        .collect();
    out.sort_unstable();
    out
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "transforms are built from exact values")]
mod tests {
    use super::*;
    use crate::build;

    #[test]
    fn linear_grid_and_merge() {
        let m = build::box_mesh([0.0; 3], [10.0, 10.0, 5.0]);
        let spec = ArraySpec::Linear {
            count: 3,
            step: [12.0, 0.0, 0.0],
            count2: Some(2),
            step2: Some([0.0, 12.0, 0.0]),
        };
        let ts = transforms(&spec).unwrap();
        assert_eq!(ts.len(), 6);
        assert_eq!(ts[0], xform::IDENTITY);
        assert!(!overlapping(&m, &ts));
        let (u, r) = merged(&m, &spec, &BooleanOptions::default()).unwrap();
        assert_eq!(r.shells, 6);
        assert!((u.volume() - 3000.0).abs() < 1e-6);
        let spec = ArraySpec::Linear {
            count: 3,
            step: [8.0, 0.0, 0.0],
            count2: None,
            step2: None,
        };
        assert!(overlapping(&m, &transforms(&spec).unwrap()));
        let (u, r) = merged(&m, &spec, &BooleanOptions::default()).unwrap();
        assert_eq!(r.shells, 1);
        assert!((u.volume() - 26.0 * 10.0 * 5.0).abs() < 1e-6);
    }

    #[test]
    fn circular_full_and_partial() {
        let m = build::box_mesh([20.0, -2.0, 0.0], [24.0, 2.0, 4.0]);
        let spec = ArraySpec::Circular {
            count: 4,
            center: [0.0; 3],
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        };
        let ts = transforms_for(&m, &spec).unwrap();
        let c = xform::apply(&ts[1], [22.0, 0.0, 2.0]);
        assert!(vec3::len(vec3::sub(c, [0.0, 22.0, 2.0])) < 1e-9);
        let spec = ArraySpec::Circular {
            count: 3,
            center: [0.0; 3],
            axis: Some([0.0, 0.0, 1.0]),
            angle_deg: Some(90.0),
            rotate_copies: Some(false),
        };
        let ts = transforms_for(&m, &spec).unwrap();
        let c = xform::apply(&ts[2], [22.0, 0.0, 2.0]);
        assert!(vec3::len(vec3::sub(c, [0.0, 22.0, 2.0])) < 1e-9);
        assert!((ts[1][0] - 1.0).abs() < 1e-12 && ts[1][1].abs() < 1e-12);
        assert!(
            transforms(&ArraySpec::Circular {
                count: 0,
                center: [0.0; 3],
                axis: None,
                angle_deg: None,
                rotate_copies: None
            })
            .is_err()
        );
    }

    fn around_z(count: usize, center: V3) -> ArraySpec {
        ArraySpec::Circular {
            count,
            center,
            axis: None,
            angle_deg: None,
            rotate_copies: None,
        }
    }

    fn joined(m: &TriMesh, spec: &ArraySpec) -> (TriMesh, BooleanReport, f64) {
        let t = std::time::Instant::now();
        let (u, r) = merged(m, spec, &BooleanOptions::default()).unwrap();
        (u, r, t.elapsed().as_secs_f64())
    }

    #[test]
    fn a_round_part_arrayed_about_its_own_axis_joins_fast() {
        // 100 facets in 12 copies miss each other by under 5 microns: the fold used to run for minutes
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 100);
        let (u, r, secs) = joined(&m, &around_z(12, [0.0; 3]));
        assert!(secs < 2.0, "{secs} s");
        assert!(
            (u.volume() - m.volume()).abs() < 1e-3 * m.volume(),
            "{} vs {}",
            u.volume(),
            m.volume()
        );
        assert!(r.watertight && r.shells == 1, "{r:?}");
        // one prism of 108 facets, no slivers, its corners on the same circle
        assert_eq!(u.triangles.len(), 4 * 108);
        assert!(
            u.positions
                .iter()
                .all(|&p| radius_of(p) < 1e-9 || (radius_of(p) - 9.5).abs() < 1e-9)
        );
        // 9 copies of an 84 facet one, off its center
        let m = build::cylinder(
            &crate::vec3::Frame {
                origin: [21.0, 0.0, 0.0],
                ..crate::vec3::Frame::WORLD
            },
            6.5,
            0.0,
            10.0,
            84,
        );
        let (u, r, secs) = joined(&m, &around_z(9, [21.0, 0.0, 0.0]));
        assert!(secs < 2.0, "{secs} s");
        assert!(
            (u.volume() - m.volume()).abs() < 1e-3 * m.volume(),
            "{} vs {}",
            u.volume(),
            m.volume()
        );
        assert!(r.watertight && r.shells == 1, "{r:?}");
        assert_eq!(u.triangles.len(), 4 * 90);
    }

    #[test]
    fn a_hub_with_one_tooth_arrayed_about_the_hub_makes_a_gear() {
        // a 100 facet hub of r 9.5 with one tooth, from a recorded session
        let m = hub_tooth();
        let hub = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 100).volume();
        let tooth = m.volume() - hub;
        assert!(tooth > 1.0, "{tooth}");
        let (u, r, secs) = joined(&m, &around_z(12, [0.0; 3]));
        assert!(r.watertight && r.shells == 1, "{r:?}");
        let want = hub + 12.0 * tooth;
        assert!(
            (u.volume() - want).abs() < 2e-3 * want,
            "{} vs {want} ({secs} s)",
            u.volume()
        );
        // the hub once and twelve teeth, not twelve hubs' slivers
        assert!(u.triangles.len() < 2 * m.triangles.len(), "{}", u.triangles.len());
        assert!(secs < 2.0, "{secs} s");
    }

    #[test]
    fn a_round_with_its_wall_split_along_the_axis_joins_fast() {
        // a loose guard: a busy hosted runner took 2.2 s where a quiet machine takes 0.4 s.
        // the old one at a time join (3.7 s for the disc, 27 s for the ring, f3d303f77) left
        // slivers that the storage asserts fail anyway
        const SLOW: f64 = 20.0;
        // an extruded 70 mm disc or ring comes back with each side facet cut into 10 bands
        let banded = |m: &TriMesh| {
            let m = crate::remesh::tidy_flat(m, &crate::remesh::RemeshOptions::default());
            let mut hs: Vec<f64> = m.positions.iter().map(|p| p[2]).collect();
            hs.sort_by(f64::total_cmp);
            hs.dedup();
            assert!(hs.len() > 2, "{hs:?}");
            m
        };
        let disc = banded(&cylinder_at(35.0, 0.0, 10.0, 188));
        let (u, r, secs) = joined(&disc, &around_z(12, [0.0; 3]));
        assert!(secs < SLOW, "{secs} s");
        assert!(r.watertight && r.shells == 1, "{r:?}");
        assert!((u.volume() - disc.volume()).abs() < 1e-3 * disc.volume());
        assert!(boolean::storage_mesh(&u).is_ok());
        assert_eq!(u.triangles.len(), 4 * 192);
        let ring = banded(&cut(
            &cylinder_at(35.0, 0.0, 10.0, 188),
            &cylinder_at(32.5, -1.0, 11.0, 180),
        ));
        let (u, r, secs) = joined(&ring, &around_z(30, [0.0; 3]));
        assert!(secs < SLOW, "{secs} s");
        assert!(r.watertight && r.shells == 1, "{r:?}");
        // a 210 sided wrap round the 180 sided bore, as for a tube in one band
        let want = ngon(210, 35.0 / (PI / 210.0).m_cos(), 10.0) - ngon(180, 32.5, 10.0);
        assert!(
            (u.volume() - want).abs() < 1e-6 * want,
            "{} vs {want}",
            u.volume()
        );
        assert!(boolean::storage_mesh(&u).is_ok());
        // made on the bed, then stored in the part's own frame: a few corners drift past the wrap
        #[allow(clippy::cast_possible_truncation, reason = "the stored precision")]
        let stored = |mut m: TriMesh| {
            for p in &mut m.positions {
                *p = p.map(|v| f64::from(v as f32));
            }
            m
        };
        let at = crate::vec3::Frame {
            origin: [182.65, 188.25, 0.0],
            ..crate::vec3::Frame::WORLD
        };
        let ring = banded(&cut(
            &build::cylinder(&at, 35.0, 0.0, 10.0, 188),
            &build::cylinder(&at, 32.5, -1.0, 11.0, 180),
        ));
        let ring = stored(xform::transformed(
            &stored(ring),
            &xform::translation([-214.65, -220.25, 0.0]),
        ));
        let (u, r, secs) = joined(&ring, &around_z(30, [-32.0, -32.0, 0.0]));
        assert!(secs < SLOW, "{secs} s");
        assert!(r.watertight && r.shells == 1, "{r:?}");
        assert!(boolean::storage_mesh(&u).is_ok());
    }

    #[test]
    fn copies_that_land_on_the_part_add_nothing() {
        // 96 facets already line up with 12 copies: one prism comes back, no union in between
        let m = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 96);
        let (u, r, _) = joined(&m, &around_z(12, [0.0; 3]));
        assert_eq!(u.triangles.len(), 4 * 96);
        assert!((u.volume() - m.volume()).abs() < 1e-9 * m.volume() && r.shells == 1);
        // a box's diagonals turn onto other diagonals, so its copies stay and join to the same box
        let m = build::box_mesh([-5.0, -5.0, 0.0], [5.0, 5.0, 4.0]);
        let (u, r, _) = joined(&m, &around_z(4, [0.0; 3]));
        assert!((u.volume() - 400.0).abs() < 1e-9 && r.shells == 1 && r.watertight);
    }

    #[test]
    fn only_faceted_rounds_on_the_array_axis_are_lined_up() {
        let lined = |m: &TriMesh, spec: &ArraySpec| {
            lined_up(m, &turn(spec).unwrap(), BooleanOptions::default()).unwrap()
        };
        let cyl = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 100);
        // another center or another axis: the part stays as it is
        assert!(lined(&cyl, &around_z(12, [30.0, 0.0, 0.0])).is_none());
        let about_x = ArraySpec::Circular {
            count: 12,
            center: [0.0; 3],
            axis: Some([1.0, 0.0, 0.0]),
            angle_deg: None,
            rotate_copies: None,
        };
        assert!(lined(&cyl, &about_x).is_none());
        // a hexagon is a polygon, not a round, and a sphere has no straight sides
        let hex = build::cylinder(&crate::vec3::Frame::WORLD, 9.5, 0.0, 10.0, 6);
        assert!(lined(&hex, &around_z(4, [0.0; 3])).is_none());
        for rings in [32, 33] {
            let ball = build::uv_sphere([0.0; 3], 9.5, rings, 64);
            assert!(lined(&ball, &around_z(12, [0.0; 3])).is_none(), "{rings} rings");
        }
        // the round on the axis: a plain one is rebuilt, a hub is wrapped at most 0.01 mm out
        let l = lined(&cyl, &around_z(12, [0.0; 3])).unwrap();
        assert!(l.once.is_empty() && l.bores.is_empty() && l.rest.triangles.len() == 4 * 108);
        let once = lined(&hub_tooth(), &around_z(12, [0.0; 3])).unwrap().once;
        let out = once
            .iter()
            .flat_map(|m| &m.positions)
            .map(|&p| radius_of(p))
            .fold(0.0, f64::max);
        assert!(once.len() == 1 && out > 9.5 && out - 9.5 <= 0.01, "{out}");
    }

    fn hub_tooth() -> TriMesh {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/array-hub-tooth.json")).unwrap();
        let nums = |k: &str| {
            v[k].as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect::<Vec<_>>()
        };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "fixture indices"
        )]
        let idx: Vec<u32> = nums("indices").iter().map(|&i| i as u32).collect();
        TriMesh::from_flat(&nums("positions"), &idx).unwrap()
    }

    fn cylinder_at(r: f64, h0: f64, h1: f64, sides: usize) -> TriMesh {
        build::cylinder(&crate::vec3::Frame::WORLD, r, h0, h1, sides)
    }

    fn cut(a: &TriMesh, b: &TriMesh) -> TriMesh {
        boolean::boolean(
            std::slice::from_ref(a),
            std::slice::from_ref(b),
            BoolOp::Difference,
            &BooleanOptions::default(),
        )
        .unwrap()
        .0
    }

    /// a prism of `n` sides on a circle of radius r, h high
    #[allow(clippy::cast_precision_loss, reason = "small side counts")]
    fn ngon(n: usize, r: f64, h: f64) -> f64 {
        let n = n as f64;
        0.5 * n * r * r * (TAU / n).m_sin() * h
    }

    #[test]
    fn a_bored_hub_tube_or_cup_in_twelve_copies_stays_fast_and_stores() {
        let spec = around_z(12, [0.0; 3]);
        let t = turn(&spec).unwrap();
        let close =
            |got: f64, want: f64, tol: f64| assert!((got - want).abs() < tol * want, "{got} vs {want}");
        let check = |part: &TriMesh| {
            let l = lined_up(part, &t, BooleanOptions::default()).unwrap().unwrap();
            assert!(!l.bores.is_empty());
            let (u, r, secs) = joined(part, &spec);
            assert!(r.watertight && r.shells == 1, "{r:?}");
            assert!(secs < 10.0, "{secs} s");
            assert!(boolean::storage_mesh(&u).is_ok());
            assert!(
                u.triangles.len() < 4 * part.triangles.len(),
                "{}",
                u.triangles.len()
            );
            u
        };
        // the tube: a 108 sided wrap round a 108 sided bore
        let tube = cut(
            &cylinder_at(9.5, 0.0, 10.0, 100),
            &cylinder_at(7.5, -1.0, 11.0, 100),
        );
        let u = check(&tube);
        let wrap = 9.5 / (PI / 108.0).m_cos();
        close(u.volume(), ngon(108, wrap, 10.0) - ngon(108, 7.5, 10.0), 1e-6);
        // the bore's corners stay on its circle
        let on = |u: &TriMesh, below: f64, r: f64, at_least: usize| {
            let near: Vec<f64> = u
                .positions
                .iter()
                .map(|&p| radius_of(p))
                .filter(|&d| d < below)
                .collect();
            near.len() >= at_least && near.iter().all(|d| (d - r).abs() < 1e-6)
        };
        assert!(on(&u, 8.5, 7.5, 108));
        // a cup keeps its pocket, now 72 sided
        let cup = cut(
            &cylinder_at(9.5, 0.0, 10.0, 100),
            &cylinder_at(7.0, 4.0, 11.0, 64),
        );
        let u = check(&cup);
        close(u.volume(), ngon(108, wrap, 10.0) - ngon(72, 7.0, 6.0), 1e-6);
        // hub minus bore plus one more tooth per copy
        let part = hub_tooth();
        let tooth = part.volume() - cylinder_at(9.5, 0.0, 10.0, 100).volume();
        let bored = cut(&part, &cylinder_at(2.5, -1.0, 11.0, 40));
        let u = check(&bored);
        close(
            u.volume(),
            part.volume() + 11.0 * tooth - ngon(48, 2.5, 10.0),
            1e-3,
        );
        assert!(on(&u, 3.5, 2.5, 48));
        // a counterbore: two bores, each lined up and cut
        let solid = cylinder_at(9.5, 0.0, 10.0, 100);
        let counter = cut(
            &cut(&solid, &cylinder_at(2.5, -1.0, 11.0, 40)),
            &cylinder_at(4.0, 7.0, 11.0, 64),
        );
        let l = lined_up(&counter, &t, BooleanOptions::default())
            .unwrap()
            .unwrap();
        assert_eq!(l.bores.len(), 2);
        let u = check(&counter);
        close(
            u.volume(),
            ngon(108, wrap, 10.0) - ngon(48, 2.5, 7.0) - ngon(72, 4.0, 3.0),
            1e-6,
        );
        let near: Vec<f64> = u
            .positions
            .iter()
            .map(|&p| radius_of(p))
            .filter(|&d| d < 5.0)
            .collect();
        let count = |r: f64| near.iter().filter(|d| (*d - r).abs() < 1e-6).count();
        assert!(count(2.5) >= 48 && count(4.0) >= 72 && count(2.5) + count(4.0) == near.len());
    }

    #[test]
    fn a_splined_or_off_axis_bore_takes_the_plain_join() {
        let solid = cylinder_at(9.5, 0.0, 10.0, 100);
        // three grooves open into an 80 sided bore in a plate: no outer round checks them, the bore's own rule must
        let plate = build::box_mesh([-8.0, -8.0, 0.0], [8.0, 8.0, 10.0]);
        let mut splined = cut(&plate, &cylinder_at(2.5, -1.0, 11.0, 80));
        for k in 0..3 {
            let (sn, cs) = (TAU * f64::from(k) / 3.0).m_sin_cos();
            let (w, r0, r1) = (0.15, 2.0, 3.2);
            let q = vec![
                [r0 * cs + w * sn, r0 * sn - w * cs],
                [r1 * cs + w * sn, r1 * sn - w * cs],
                [r1 * cs - w * sn, r1 * sn + w * cs],
                [r0 * cs - w * sn, r0 * sn + w * cs],
            ];
            let groove = build::extrude(
                &[crate::poly2d::Polygon::simple(q)],
                &crate::vec3::Frame::WORLD,
                -1.0,
                11.0,
            )
            .unwrap();
            splined = cut(&splined, &groove);
        }
        let spec = around_z(3, [0.0; 3]);
        let t = turn(&spec).unwrap();
        let local = splined.positions.clone();
        assert!(rounds(&splined, &local).iter().any(|r| r.inner && r.facets == 80));
        assert!(
            lined_up(&splined, &t, BooleanOptions::default())
                .unwrap()
                .is_none()
        );
        // the grooves stay open: no sealed void, and about 6 mm3 less than the same plate without them
        let (u, r, _) = joined(&splined, &spec);
        assert!(r.watertight && r.shells == 1, "{r:?}");
        let (whole, _, _) = joined(&cut(&plate, &cylinder_at(2.5, -1.0, 11.0, 80)), &spec);
        let open = whole.volume() - u.volume();
        assert!((5.0..7.5).contains(&open), "{open}");
        // bores beside the axis are no rounds of it, and their walls stop the wrap
        let one = cut(&solid, &cylinder_at_xy([5.0, 0.0], 1.5, 40));
        let two = cut(&one, &cylinder_at_xy([-5.0, 0.0], 1.5, 40));
        let t12 = turn(&around_z(12, [0.0; 3])).unwrap();
        for part in [one, two] {
            assert!(
                lined_up(&part, &t12, BooleanOptions::default())
                    .unwrap()
                    .is_none()
            );
        }
    }

    fn cylinder_at_xy(c: [f64; 2], r: f64, n: usize) -> TriMesh {
        build::extrude(
            &[crate::poly2d::Polygon::simple(crate::poly2d::circle(c, r, n))],
            &crate::vec3::Frame::WORLD,
            -1.0,
            11.0,
        )
        .unwrap()
    }

    #[test]
    fn a_small_recess_on_a_big_round_is_not_filled() {
        let t = turn(&around_z(12, [0.0; 3])).unwrap();
        let disc = cylinder_at(100.0, 0.0, 20.0, 256);
        // a 0.8 mm socket on the axis (0.51 mm3) and a 0.01 mm deep engraving on the top (0.4 mm3)
        let socket = cut(&disc, &build::box_mesh([-0.4, -0.4, 19.2], [0.4, 0.4, 21.0]));
        let mark = cut(&disc, &build::box_mesh([30.0, -1.0, 19.99], [50.0, 1.0, 21.0]));
        // stored in f32 the disc drifts a few microns, which over its surface would cover a 0.2 mm3 socket
        let mut coarse = cut(&disc, &build::box_mesh([-0.25, -0.25, 19.2], [0.25, 0.25, 21.0]));
        #[allow(clippy::cast_possible_truncation, reason = "the stored precision")]
        for p in &mut coarse.positions {
            *p = p.map(|v| f64::from(v as f32));
        }
        for part in [socket, mark, coarse] {
            let rs = rounds(&part, &part.positions);
            assert!(rs.len() == 1 && rs.iter().all(|r| !r.inner && r.facets % 12 != 0));
            assert!(lined_up(&part, &t, BooleanOptions::default()).unwrap().is_none());
        }
        assert!(lined_up(&disc, &t, BooleanOptions::default()).unwrap().is_some());
    }

    #[test]
    fn the_end_cleanup_keeps_the_geometry() {
        // in 15 copies the hub's teeth meet on its wrap, and the join crosses itself on the exact engine; the robust
        // pass cleans it and keeps its shape
        let spec = around_z(15, [0.0; 3]);
        let (a, r) = merged(&hub_tooth(), &spec, &BooleanOptions::default()).unwrap();
        let exact = BooleanOptions {
            engine: boolean::Engine::Exact,
            keep_inverted: false,
        };
        let (e, _) = merged(&hub_tooth(), &spec, &exact).unwrap();
        assert!(boolean::Solid::new(&e).unwrap().self_intersects());
        assert!(r.engine == "robust" && r.watertight && r.shells == 1, "{r:?}");
        assert!(!boolean::Solid::new(&a).unwrap().self_intersects() && boolean::storage_mesh(&a).is_ok());
        assert!((a.volume() - e.volume()).abs() < 1e-6 * e.volume());
        let (ba, be) = (a.bounds().unwrap(), e.bounds().unwrap());
        assert!(
            ba.min
                .iter()
                .chain(&ba.max)
                .zip(be.min.iter().chain(&be.max))
                .all(|(x, y)| (x - y).abs() < 1e-6)
        );
    }

    #[test]
    fn only_a_full_turn_of_a_solid_round_is_lined_up() {
        // a half disc of 100 facet resolution
        let mut arc: Vec<[f64; 2]> = (0..=50)
            .map(|k| {
                let a = std::f64::consts::PI * (f64::from(k) / 50.0 - 0.5);
                [9.5 * a.m_cos(), 9.5 * a.m_sin()]
            })
            .collect();
        arc.dedup();
        let half = build::extrude(
            &[crate::poly2d::Polygon::simple(arc)],
            &crate::vec3::Frame::WORLD,
            0.0,
            10.0,
        )
        .unwrap();
        // a partial sweep is never lined up: two copies 30 degrees apart are just those copies
        let sweep = ArraySpec::Circular {
            count: 2,
            center: [0.0; 3],
            axis: None,
            angle_deg: Some(30.0),
            rotate_copies: None,
        };
        assert!(turn(&sweep).is_none());
        let copies: Vec<TriMesh> = transforms(&sweep)
            .unwrap()
            .iter()
            .map(|t| xform::transformed(&half, t))
            .collect();
        let (plain, _) =
            boolean::boolean_array(&copies, &[], BoolOp::Union, BooleanOptions::default()).unwrap();
        let (u, _, _) = joined(&half, &sweep);
        assert!((u.volume() - plain.volume()).abs() < 1e-9 * plain.volume());
        // a full turn of the half disc: its round is not all material, so it is not wrapped
        let t = turn(&around_z(12, [0.0; 3])).unwrap();
        let rs = rounds(&half, &half.positions);
        assert!(rs.len() == 1 && rs.iter().all(|r| !r.inner && r.facets == 100));
        assert!(lined_up(&half, &t, BooleanOptions::default()).unwrap().is_none());
        // 6 copies over 150 degrees, copies that stay put, and one copy leave the round alone
        for spec in [
            ArraySpec::Circular {
                count: 6,
                center: [0.0; 3],
                axis: None,
                angle_deg: Some(150.0),
                rotate_copies: None,
            },
            ArraySpec::Circular {
                count: 12,
                center: [0.0; 3],
                axis: None,
                angle_deg: None,
                rotate_copies: Some(false),
            },
            around_z(1, [0.0; 3]),
        ] {
            assert!(turn(&spec).is_none(), "{spec:?}");
        }
        let cyl = cylinder_at(9.5, 0.0, 10.0, 100);
        let (u, _, _) = joined(&cyl, &around_z(1, [0.0; 3]));
        assert!((u.volume() - cyl.volume()).abs() < 1e-9 * cyl.volume());
        assert_eq!(u.triangles.len(), cyl.triangles.len());
    }

    #[test]
    #[ignore = "the robust engine takes about 18 s on this in a release build"]
    fn the_exact_and_robust_engines_agree_on_the_gear() {
        let spec = around_z(12, [0.0; 3]);
        let (a, _) = merged(&hub_tooth(), &spec, &BooleanOptions::default()).unwrap();
        let robust = BooleanOptions {
            engine: boolean::Engine::Robust,
            keep_inverted: false,
        };
        let (b, _) = merged(&hub_tooth(), &spec, &robust).unwrap();
        assert!((a.volume() - b.volume()).abs() < 1e-6 * a.volume());
        let tooth = hub_tooth().volume() - cylinder_at(9.5, 0.0, 10.0, 100).volume();
        let want = cylinder_at(9.5, 0.0, 10.0, 100).volume() + 12.0 * tooth;
        assert!((a.volume() - want).abs() < 2e-3 * want);
    }

    #[test]
    fn a_solid_round_or_an_empty_bore_needs_no_intersection() {
        let t = turn(&around_z(12, [0.0; 3])).unwrap();
        let tube = cut(
            &cylinder_at(9.5, 0.0, 10.0, 100),
            &cylinder_at(7.5, -1.0, 11.0, 100),
        );
        let bored = cut(&hub_tooth(), &cylinder_at(2.5, -1.0, 11.0, 40));
        for part in [hub_tooth(), bored, tube] {
            MEETS.set(0);
            assert!(lined_up(&part, &t, BooleanOptions::default()).unwrap().is_some());
            assert_eq!(MEETS.get(), 0);
        }
        // anything reaching inside still gets the volume check
        let disc = cylinder_at(100.0, 0.0, 20.0, 256);
        let socket = cut(&disc, &build::box_mesh([-0.4, -0.4, 19.2], [0.4, 0.4, 21.0]));
        let mark = cut(&disc, &build::box_mesh([30.0, -1.0, 19.99], [50.0, 1.0, 21.0]));
        for part in [socket, mark] {
            MEETS.set(0);
            let _ = lined_up(&part, &t, BooleanOptions::default()).unwrap();
            assert!(MEETS.get() >= 1);
        }
    }

    /// a round stored in f32, as the app sends it, about a moved and maybe tilted axis
    fn stored(r: f64, sides: usize, frame: &crate::vec3::Frame, bore: Option<f64>) -> TriMesh {
        let mut m = build::cylinder(frame, r, 0.0, 20.0, sides);
        if let Some(b) = bore {
            m = cut(&m, &build::cylinder(frame, b, -1.0, 21.0, sides));
        }
        #[allow(clippy::cast_possible_truncation, reason = "the stored precision")]
        for p in &mut m.positions {
            *p = p.map(|v| f64::from(v as f32));
        }
        m
    }

    #[test]
    fn a_stored_round_moved_or_tilted_needs_no_intersection() {
        let tilted = vec3::normalize([0.3, -0.2, 1.0]).unwrap();
        let u = vec3::normalize(vec3::any_perpendicular(tilted)).unwrap();
        let frames = [
            ([103.0, 57.0, 2.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            ([30.3, 5.1, 2.2], tilted, u),
        ];
        for (origin, w, u) in frames {
            let frame = crate::vec3::Frame {
                origin,
                u,
                v: vec3::cross(w, u),
                w,
            };
            let spec = ArraySpec::Circular {
                count: 12,
                center: origin,
                axis: Some(w),
                angle_deg: None,
                rotate_copies: None,
            };
            let t = turn(&spec).unwrap();
            for part in [
                stored(100.0, 256, &frame, None),
                stored(9.5, 100, &frame, Some(7.5)),
            ] {
                MEETS.set(0);
                assert!(
                    lined_up(&part, &t, BooleanOptions::default()).unwrap().is_some(),
                    "{origin:?}"
                );
                assert_eq!(MEETS.get(), 0, "{origin:?}");
            }
        }
    }

    #[test]
    fn a_bore_with_a_feature_beside_its_wall_takes_the_plain_join() {
        // a slot from the top stops 7 microns behind the bore's wall: inside the fill, outside the wall
        let plate = build::box_mesh([-8.0, -8.0, 0.0], [8.0, 8.0, 10.0]);
        let bored = cut(&plate, &cylinder_at(2.5, -1.0, 11.0, 40));
        let (sn, cs) = (PI / 40.0).m_sin_cos();
        let (w, r0, r1) = (0.2, 2.499, 3.5);
        let q = vec![
            [r0 * cs + w * sn, r0 * sn - w * cs],
            [r1 * cs + w * sn, r1 * sn - w * cs],
            [r1 * cs - w * sn, r1 * sn + w * cs],
            [r0 * cs - w * sn, r0 * sn + w * cs],
        ];
        let slot = build::extrude(
            &[crate::poly2d::Polygon::simple(q)],
            &crate::vec3::Frame::WORLD,
            5.0,
            11.0,
        )
        .unwrap();
        let part = cut(&bored, &slot);
        let rs = rounds(&part, &part.positions);
        assert!(
            rs.iter()
                .any(|r| r.inner && r.facets == 40 && r.sides.len() == 80)
        );
        let t = turn(&around_z(3, [0.0; 3])).unwrap();
        assert!(lined_up(&part, &t, BooleanOptions::default()).unwrap().is_none());
        assert!(lined_up(&bored, &t, BooleanOptions::default()).unwrap().is_some());
    }

    #[test]
    fn clear_inside_sees_only_faces_that_reach_in() {
        // a 12 sided prism of radius 10, 0 to 10 high, and one triangle at a time
        let r = Round {
            radius: 10.0,
            h: (0.0, 10.0),
            facets: 12,
            phase: 0.0,
            sides: Vec::new(),
            bands: 1,
            inner: false,
            dev: 0.0,
        };
        let clear = |p: [V3; 3], skip: &[usize]| {
            let m = TriMesh::new(p.to_vec(), vec![[0, 1, 2]]);
            clear_inside(&m, &m.positions, &r, 12, 10.0, skip)
        };
        // inside, outside, and across it with no corner inside
        assert!(!clear([[0.0, 0.0, 5.0], [1.0, 0.0, 5.0], [0.0, 1.0, 5.0]], &[]));
        assert!(clear([[20.0, 0.0, 5.0], [21.0, 0.0, 5.0], [20.0, 1.0, 5.0]], &[]));
        assert!(!clear(
            [[-30.0, -1.0, 5.0], [30.0, -1.0, 5.0], [0.0, 30.0, 5.0]],
            &[]
        ));
        // above or below the open height, or on the cap
        assert!(clear([[0.0, 0.0, 12.0], [1.0, 0.0, 12.0], [0.0, 1.0, 12.0]], &[]));
        assert!(clear([[0.0, 0.0, 10.0], [1.0, 0.0, 10.0], [0.0, 1.0, 10.0]], &[]));
        // on a side of the prism, touching it from outside
        let (a, b) = (0.0_f64.m_sin_cos(), (PI / 6.0).m_sin_cos());
        assert!(clear(
            [
                [10.0 * a.1, 10.0 * a.0, 1.0],
                [10.0 * b.1, 10.0 * b.0, 1.0],
                [10.0 * a.1, 10.0 * a.0, 9.0]
            ],
            &[]
        ));
        // a wall seen edge on: outside, then through the middle
        assert!(clear(
            [[12.0, -5.0, 1.0], [12.0, 5.0, 1.0], [12.0, 5.0, 9.0]],
            &[]
        ));
        assert!(!clear([[0.0, -5.0, 1.0], [0.0, 5.0, 1.0], [0.0, 5.0, 9.0]], &[]));
        // left out on purpose
        assert!(clear([[0.0, 0.0, 5.0], [1.0, 0.0, 5.0], [0.0, 1.0, 5.0]], &[0]));
    }

    /// a hub, banded as an extrude leaves it or not, with a box tooth joined on its wall, both stored in f32
    #[cfg(feature = "cad")]
    #[allow(clippy::cast_possible_truncation, reason = "the stored precision")]
    fn toothed(r: f64, sides: usize, banded: bool, z: (f64, f64), root: f64) -> TriMesh {
        let in_f32 = |mut m: TriMesh| {
            for p in &mut m.positions {
                *p = p.map(|v| f64::from(v as f32));
            }
            m
        };
        let mut hub = cylinder_at(r, 0.0, 10.0, sides);
        if banded {
            hub = crate::remesh::tidy_flat(&hub, &crate::remesh::RemeshOptions::default());
        }
        let tooth = build::box_mesh([r - root, -2.0, z.0], [r + 5.0, 2.0, z.1]);
        in_f32(
            crate::face::apply(tooth, crate::face::Operation::Join, Some(&in_f32(hub)))
                .unwrap()
                .mesh,
        )
    }

    /// the merged array checked against the union of its wrap and the copies laid on it, which is right in f64
    #[cfg(feature = "cad")]
    fn stores_as_the_union(part: &TriMesh, count: usize) -> f64 {
        let spec = around_z(count, [0.0; 3]);
        let l = lined_up(part, &turn(&spec).unwrap(), BooleanOptions::default())
            .unwrap()
            .unwrap();
        let wrap = &l.once[0];
        let rest = cut(part, wrap);
        let mut all = vec![wrap.clone()];
        all.extend(
            transforms(&spec)
                .unwrap()
                .iter()
                .map(|t| xform::transformed(&rest, t)),
        );
        let (want, _) = boolean::boolean_array(&all, &[], BoolOp::Union, BooleanOptions::default()).unwrap();
        let (u, r, secs) = joined(part, &spec);
        assert!(r.watertight && r.shells == 1, "{r:?}");
        assert!(
            (u.volume() - want.volume()).abs() < 1e-6 * want.volume(),
            "{} vs {}",
            u.volume(),
            want.volume()
        );
        let s = boolean::storage_mesh(&u).unwrap();
        assert!(s.edge_report().is_watertight() && s.components().len() == 1);
        secs
    }

    #[cfg(feature = "cad")]
    #[test]
    fn a_banded_hub_with_a_tooth_arrayed_about_it_stores() {
        // an extruded 70 or 100 mm hub with a tooth joined on its wall, the tooth full height or within one band
        // triangles each join may hand the kernel, in the order of the loops: a debug build counted 12808, 47038, 21024,
        // 97620, 13942, 45954, 23064 and 101220, and without the round-wrap lineup the first case counted 243762
        let mut limits = [14_000, 52_000, 23_000, 107_000, 15_300, 50_500, 25_400, 111_000].into_iter();
        for (r, sides) in [(35.0, 188), (50.0, 224)] {
            for z in [(0.0, 10.0), (3.2, 3.8)] {
                let part = toothed(r, sides, true, z, 0.5);
                for count in [12, 30] {
                    let _ = stores_as_the_union(&part, count);
                    let spent = boolean::SPENT.get();
                    let limit = limits.next().unwrap();
                    assert!(
                        spent < limit,
                        "r {r} {z:?} x{count}: {spent} triangles, limit {limit}"
                    );
                }
            }
        }
    }

    #[cfg(feature = "cad")]
    #[test]
    fn a_hub_with_a_box_tooth_in_twelve_copies_stores() {
        // the copies used to touch the hub's wrap without joining it, and crossed it once stored
        for root in [0.5, 3.0] {
            let part = toothed(9.5, 100, false, (0.0, 10.0), root);
            let secs = stores_as_the_union(&part, 12);
            assert!(secs < 2.0, "{secs} s");
        }
        // a tooth within one band of the wall
        let part = toothed(9.5, 100, true, (3.2, 3.8), 0.5);
        assert!(stores_as_the_union(&part, 12) < 2.0);
        // 7 copies put a wrap face on the hub's corners, which leave slivers once stored; 30 overlap their teeth
        let part = toothed(9.5, 100, false, (0.0, 10.0), 0.5);
        for count in [7, 30] {
            assert!(stores_as_the_union(&part, count) < 2.0, "x{count}");
        }
    }

    #[cfg(feature = "cad")]
    #[test]
    fn a_lug_beside_the_tooth_keeps_the_hub_lined_up() {
        let tooth = toothed(35.0, 188, true, (0.0, 10.0), 0.5);
        // halfway between two teeth, so no copy of the tooth lands on it
        let lug = xform::transformed(
            &build::box_mesh([34.0, -1.5, 4.0], [38.0, 1.5, 8.0]),
            &xform::rotation_about([0.0; 3], [0.0, 0.0, 1.0], (15.0_f64).to_radians()),
        );
        let part = crate::face::apply(lug, crate::face::Operation::Join, Some(&tooth))
            .unwrap()
            .mesh;
        assert!(stores_as_the_union(&part, 12) < 2.0);
    }

    #[test]
    fn a_groove_or_a_step_in_a_banded_wall_takes_the_plain_join() {
        let disc = crate::remesh::tidy_flat(
            &cylinder_at(35.0, 0.0, 10.0, 188),
            &crate::remesh::RemeshOptions::default(),
        );
        let t = turn(&around_z(12, [0.0; 3])).unwrap();
        // a keyway in the middle of the wall, and a step cut down from the top
        let groove = cut(&disc, &build::box_mesh([33.5, -1.0, 3.0], [36.0, 1.0, 7.0]));
        let step = cut(&disc, &build::box_mesh([33.0, -3.0, 6.0], [36.0, 3.0, 11.0]));
        for part in [groove, step] {
            assert!(
                rounds(&part, &part.positions)
                    .iter()
                    .all(|r| r.inner || (r.radius - 35.0).abs() > 1e-3)
            );
            assert!(lined_up(&part, &t, BooleanOptions::default()).unwrap().is_none());
        }
        assert!(lined_up(&disc, &t, BooleanOptions::default()).unwrap().is_some());
    }
}
