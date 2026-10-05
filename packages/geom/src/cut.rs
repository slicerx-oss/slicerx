// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! plane cuts into closed parts with caps and optional connectors, and cross sections
// indices come from validated meshes and from rings built here
#![allow(clippy::indexing_slicing)]

use crate::build;
use crate::convex::{self, ConvexSolid, Region};
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::mesh::{EdgeReport, TriMesh};
use crate::poly2d::{self, Polygon};
use crate::vec3::{self, Frame, Plane, V2, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Section {
    pub frame: Frame,
    pub polygons: Vec<Polygon>,
    pub open_chains: usize,
}

impl Section {
    pub fn area(&self) -> f64 {
        self.polygons.iter().map(Polygon::area).sum()
    }

    pub fn perimeter(&self) -> f64 {
        self.polygons.iter().map(Polygon::perimeter).sum()
    }

    pub fn islands(&self) -> usize {
        self.polygons.len()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    Vertex(u32),
    Edge(u32, u32),
}

pub fn section(mesh: &TriMesh, plane: &Plane) -> Section {
    let frame = Frame::from_normal(plane.origin(), plane.normal, None).unwrap_or(Frame::WORLD);
    let d: Vec<f64> = mesh.positions.iter().map(|&p| plane.distance(p)).collect();
    let neg = |i: u32| d[i as usize] < 0.0;
    let mut next: HashMap<Key, Key> = HashMap::new();
    let mut points: HashMap<Key, V3> = HashMap::new();
    let mut crossing = |n: u32, p: u32| -> Key {
        let key = if d[p as usize] == 0.0 {
            Key::Vertex(p)
        } else {
            Key::Edge(n.min(p), n.max(p))
        };
        points.entry(key).or_insert_with(|| {
            let (i, j) = (n.min(p), n.max(p));
            let (di, dj) = (d[i as usize], d[j as usize]);
            vec3::lerp(
                mesh.positions[i as usize],
                mesh.positions[j as usize],
                di / (di - dj),
            )
        });
        key
    };
    for t in &mesh.triangles {
        let s = t.map(neg);
        let negs = s.iter().filter(|&&x| x).count();
        if negs == 0 || negs == 3 {
            continue;
        }
        let (mut enter, mut exit) = (None, None);
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            match (s[k], s[(k + 1) % 3]) {
                (false, true) => enter = Some(crossing(b, a)),
                (true, false) => exit = Some(crossing(a, b)),
                _ => {}
            }
        }
        if let (Some(e), Some(x)) = (enter, exit)
            && e != x
        {
            next.insert(e, x);
        }
    }
    let mut rings = Vec::new();
    let mut open_chains = 0;
    let mut keys: Vec<Key> = next.keys().copied().collect();
    keys.sort_by_key(|k| match *k {
        Key::Vertex(v) => (0, v, 0),
        Key::Edge(a, b) => (1, a, b),
    });
    for start in keys {
        let Some(mut at) = next.remove(&start) else {
            continue;
        };
        let mut ring = vec![start];
        while at != start {
            ring.push(at);
            match next.remove(&at) {
                Some(n) => at = n,
                None => break,
            }
        }
        if at != start {
            open_chains += 1;
            continue;
        }
        let pts: Vec<V2> = ring
            .iter()
            .filter_map(|k| points.get(k).map(|&p| frame.project(p)))
            .collect();
        if pts.len() >= 3 {
            rings.push(pts);
        }
    }
    Section {
        frame,
        polygons: poly2d::nest(rings),
        open_chains,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectorKind {
    Pin,
    Dowel,
    Dovetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectorSpec {
    pub kind: ConnectorKind,
    pub diameter_mm: f64,
    pub depth_mm: f64,
    pub tolerance_mm: f64,
    pub depth_clearance_mm: f64,
    /// number of pins or dowels; `None` picks 1 or 2 per island by shape
    pub count: Option<usize>,
    pub positions: Vec<V3>,
    pub min_wall_mm: f64,
    pub dovetail_angle_deg: f64,
    pub segments: usize,
}

impl Default for ConnectorSpec {
    fn default() -> Self {
        Self {
            kind: ConnectorKind::Pin,
            diameter_mm: 5.0,
            depth_mm: 6.0,
            tolerance_mm: 0.15,
            depth_clearance_mm: 0.4,
            count: None,
            positions: Vec::new(),
            min_wall_mm: 1.2,
            dovetail_angle_deg: 15.0,
            segments: 32,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CutOptions {
    pub connector: Option<ConnectorSpec>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutReport {
    pub section_area_mm2: f64,
    pub seam_length_mm: f64,
    pub islands: usize,
    pub connectors: Vec<V3>,
    pub below_volume_mm3: f64,
    pub above_volume_mm3: f64,
    pub below_edges: EdgeReport,
    pub above_edges: EdgeReport,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CutResult {
    pub below: TriMesh,
    pub above: TriMesh,
    pub extras: Vec<TriMesh>,
    pub report: CutReport,
}

/// cuts `mesh` by `plane` into two closed parts, capping the cut faces and
/// adding connectors when asked.
///
/// ```
/// use sx_geom::{build, cut, Plane};
/// let cube = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
/// let r = cut::plane_cut(&cube, &Plane::horizontal(8.0), &cut::CutOptions::default()).unwrap();
/// assert!(r.below.edge_report().is_watertight());
/// assert!((r.below.volume() - 3200.0).abs() < 1e-6);
/// ```
pub fn plane_cut(mesh: &TriMesh, plane: &Plane, opts: &CutOptions) -> Result<CutResult> {
    mesh.validate("cut input")?;
    let Some(bounds) = mesh.bounds() else {
        return Err(Error::invalid("cut", "the mesh is empty"));
    };
    let sec = section(mesh, plane);
    let mut report = CutReport {
        section_area_mm2: sec.area(),
        seam_length_mm: sec.perimeter(),
        islands: sec.islands(),
        ..CutReport::default()
    };
    if sec.open_chains > 0 {
        report.warnings.push(format!(
            "the mesh is open where the plane crosses it ({} open chains); repair it for closed parts",
            sec.open_chains
        ));
    }
    let mut extras = Vec::new();
    let (below, above) = match &opts.connector {
        Some(spec) if !sec.polygons.is_empty() => {
            let plan = plan_connectors(mesh, plane, &sec, spec, &mut report)?;
            if plan.below_add.is_empty() && plan.below_remove.is_empty() && plan.above_remove.is_empty() {
                let (a, b) = convex::split_by_plane(mesh, plane)?;
                (a, b)
            } else {
                let below = convex::intersect(
                    mesh,
                    &Region::cut_with(*plane, &bounds, &plan.below_add, &plan.below_remove),
                )?;
                let above = convex::intersect(
                    mesh,
                    &Region::cut_with(plane.flipped(), &bounds, &[], &plan.above_remove),
                )?;
                extras = plan.extras;
                (below, above)
            }
        }
        _ => {
            let (a, b) = convex::split_by_plane(mesh, plane)?;
            (a, b)
        }
    };
    report.below_volume_mm3 = below.volume();
    report.above_volume_mm3 = above.volume();
    report.below_edges = below.edge_report();
    report.above_edges = above.edge_report();
    Ok(CutResult {
        below,
        above,
        extras,
        report,
    })
}

#[derive(Default)]
struct ConnectorPlan {
    below_add: Vec<ConvexSolid>,
    below_remove: Vec<ConvexSolid>,
    above_remove: Vec<ConvexSolid>,
    extras: Vec<TriMesh>,
}

#[allow(clippy::too_many_lines, reason = "one branch per connector kind")]
fn plan_connectors(
    mesh: &TriMesh,
    plane: &Plane,
    sec: &Section,
    spec: &ConnectorSpec,
    report: &mut CutReport,
) -> Result<ConnectorPlan> {
    if !(spec.diameter_mm > 0.0 && spec.depth_mm > 0.0 && spec.tolerance_mm >= 0.0) {
        return Err(Error::invalid("connector", "diameter and depth must be positive"));
    }
    let segs = spec.segments.clamp(8, 128);
    let mut plan = ConnectorPlan::default();
    let n = plane.normal;
    let axis_frame = |c: V2| Frame::from_normal(sec.frame.at(c, 0.0), n, Some(sec.frame.u));
    if spec.kind == ConnectorKind::Dovetail {
        let Some(largest) = sec.polygons.iter().max_by(|a, b| a.area().total_cmp(&b.area())) else {
            return Ok(plan);
        };
        let (center, clear) = pole(largest, None, None, f64::INFINITY);
        let (w, h) = (spec.diameter_mm, spec.depth_mm);
        let tan = spec.dovetail_angle_deg.clamp(0.0, 45.0).to_radians().m_tan();
        let need = w * 0.5 + h * tan + spec.tolerance_mm + spec.min_wall_mm;
        if clear < need {
            report.warnings.push(format!(
                "no room for a {w:.1} mm dovetail: the section is {:.1} mm wide at its widest point, {:.1} mm needed",
                clear * 2.0,
                need * 2.0
            ));
            return Ok(plan);
        }
        let axis = principal_axis(largest);
        let slide = vec3::add(
            vec3::scale(sec.frame.u, axis[0]),
            vec3::scale(sec.frame.v, axis[1]),
        );
        let Some(f) = Frame::from_normal(sec.frame.at(center, 0.0), n, Some(slide)) else {
            return Ok(plan);
        };
        let length = mesh.bounds().map_or(1000.0, |b| b.diagonal() * 1.5);
        plan.below_add.push(dovetail(&f, w, h, tan, length, 0.0));
        plan.above_remove
            .push(dovetail(&f, w, h, tan, length, spec.tolerance_mm));
        report.connectors.push(f.origin);
        return Ok(plan);
    }
    let r = spec.diameter_mm * 0.5;
    let r_socket = r + spec.tolerance_mm;
    let deep = spec.depth_mm + spec.depth_clearance_mm;
    let need = r_socket + spec.min_wall_mm;
    let centers = if spec.positions.is_empty() {
        let c = auto_centers(sec, need, spec);
        if c.is_empty() {
            report.warnings.push(format!(
                "no room for a {:.1} mm connector: the section needs {:.1} mm of material around its center",
                spec.diameter_mm,
                need * 2.0
            ));
        }
        c
    } else {
        spec.positions.iter().map(|&p| sec.frame.project(p)).collect()
    };
    let probe = |offset: f64, c: V2| {
        let s = section(
            mesh,
            &Plane {
                normal: n,
                offset: plane.offset + offset,
            },
        );
        s.polygons
            .iter()
            .any(|p| p.contains(c) && boundary_distance(p, c) >= need)
    };
    for c in centers {
        let ok = sec
            .polygons
            .iter()
            .any(|p| p.contains(c) && boundary_distance(p, c) >= need)
            && probe(deep * 0.5, c)
            && probe(deep, c)
            && (spec.kind != ConnectorKind::Dowel || probe(-deep * 0.5, c) && probe(-deep, c));
        if !ok {
            report.warnings.push(format!(
                "skipped a {:?} connector at ({:.1}, {:.1}): not enough material around it",
                spec.kind, c[0], c[1]
            ));
            continue;
        }
        let Some(f) = axis_frame(c) else {
            continue;
        };
        match spec.kind {
            ConnectorKind::Pin => {
                plan.below_add
                    .push(ConvexSolid::cylinder(&f, r, -1.0, spec.depth_mm, segs)?);
                plan.above_remove
                    .push(ConvexSolid::cylinder(&f, r_socket, -1.0, deep, segs)?);
            }
            ConnectorKind::Dowel => {
                plan.below_remove
                    .push(ConvexSolid::cylinder(&f, r_socket, -deep, 1.0, segs)?);
                plan.above_remove
                    .push(ConvexSolid::cylinder(&f, r_socket, -1.0, deep, segs)?);
                plan.extras
                    .push(build::cylinder(&Frame::WORLD, r, 0.0, spec.depth_mm * 2.0, segs));
            }
            ConnectorKind::Dovetail => {}
        }
        report.connectors.push(f.origin);
    }
    Ok(plan)
}

fn dovetail(f: &Frame, w: f64, h: f64, tan: f64, length: f64, grow: f64) -> ConvexSolid {
    let (cos, sin) = {
        let a = tan.m_atan();
        (a.m_cos(), a.m_sin())
    };
    let plane = |normal: V3, through: V3| Plane {
        normal,
        offset: vec3::dot(normal, through),
    };
    let side = |sign: f64| {
        let normal = vec3::add(vec3::scale(f.v, sign * cos), vec3::scale(f.w, -sin));
        Plane {
            normal,
            offset: vec3::dot(normal, f.at([0.0, sign * w * 0.5], 0.0)) + grow,
        }
    };
    ConvexSolid {
        planes: vec![
            side(1.0),
            side(-1.0),
            plane(f.w, f.at([0.0, 0.0], h + grow)),
            plane(vec3::scale(f.w, -1.0), f.at([0.0, 0.0], -1.0)),
            plane(f.u, f.at([length, 0.0], 0.0)),
            plane(vec3::scale(f.u, -1.0), f.at([-length, 0.0], 0.0)),
        ],
    }
}

fn auto_centers(sec: &Section, need: f64, spec: &ConnectorSpec) -> Vec<V2> {
    let mut polys: Vec<&Polygon> = sec.polygons.iter().collect();
    polys.sort_by(|a, b| b.area().total_cmp(&a.area()));
    let cap = need * 1.5;
    let mut out = Vec::new();
    let push = |q: V2, out: &mut Vec<V2>| {
        if out
            .iter()
            .all(|o| (o[0] - q[0]).m_hypot(o[1] - q[1]) >= need * 2.5)
        {
            out.push(q);
        }
    };
    for (i, p) in polys.iter().enumerate() {
        let mid = centroid(p);
        let (c, clear) = pole(p, None, Some(mid), cap);
        if clear < need {
            continue;
        }
        let axis = principal_axis(p);
        let extent = extent_along(p, axis);
        let two = match spec.count {
            Some(n) => n >= 2 && i == 0,
            None => extent > spec.diameter_mm * 8.0,
        };
        let quarter = extent * 0.25;
        let halves = two.then(|| {
            [1.0, -1.0].map(|sign| {
                let target = [
                    mid[0] + axis[0] * quarter * sign,
                    mid[1] + axis[1] * quarter * sign,
                ];
                pole(p, Some((axis, mid, sign)), Some(target), cap)
            })
        });
        match halves {
            Some(h) if h.iter().all(|x| x.1 >= need) => {
                for x in h {
                    push(x.0, &mut out);
                }
            }
            _ => push(c, &mut out),
        }
        if let Some(n) = spec.count
            && out.len() >= n
        {
            out.truncate(n);
            break;
        }
    }
    out
}

fn centroid(p: &Polygon) -> V2 {
    let r = &p.outer;
    let n = r.len();
    let (mut cx, mut cy, mut a2) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let (a, b) = (r[i], r[(i + 1) % n]);
        let w = a[0] * b[1] - b[0] * a[1];
        cx += (a[0] + b[0]) * w;
        cy += (a[1] + b[1]) * w;
        a2 += w;
    }
    if a2.abs() < 1e-12 {
        return r.first().copied().unwrap_or([0.0, 0.0]);
    }
    [cx / (3.0 * a2), cy / (3.0 * a2)]
}

fn pole(p: &Polygon, half: Option<(V2, V2, f64)>, target: Option<V2>, cap: f64) -> (V2, f64) {
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for q in &p.outer {
        for k in 0..2 {
            lo[k] = lo[k].min(q[k]);
            hi[k] = hi[k].max(q[k]);
        }
    }
    let allowed = |q: V2| {
        p.contains(q)
            && half.is_none_or(|(axis, c, sign)| {
                ((q[0] - c[0]) * axis[0] + (q[1] - c[1]) * axis[1]) * sign > 0.0
            })
    };
    let diag = (hi[0] - lo[0]).m_hypot(hi[1] - lo[1]).max(1e-9);
    let score = |q: V2| {
        if !allowed(q) {
            return -1.0;
        }
        let pull = target.map_or(0.0, |t| {
            (q[0] - t[0]).m_hypot(q[1] - t[1]) / diag * 1e-3 * cap.min(diag)
        });
        boundary_distance(p, q).min(cap) - pull
    };
    let n = 24;
    let mut best = (poly2d::interior_point(&p.outer), -1.0);
    for i in 0..=n {
        for j in 0..=n {
            let q = [
                lo[0] + (hi[0] - lo[0]) * f64::from(i) / f64::from(n),
                lo[1] + (hi[1] - lo[1]) * f64::from(j) / f64::from(n),
            ];
            let s = score(q);
            if s > best.1 {
                best = (q, s);
            }
        }
    }
    let mut step = (hi[0] - lo[0]).max(hi[1] - lo[1]) / f64::from(n);
    for _ in 0..12 {
        let mut moved = false;
        for (dx, dy) in [
            (1.0, 0.0),
            (-1.0, 0.0),
            (0.0, 1.0),
            (0.0, -1.0),
            (0.7, 0.7),
            (-0.7, -0.7),
            (0.7, -0.7),
            (-0.7, 0.7),
        ] {
            let q = [best.0[0] + dx * step, best.0[1] + dy * step];
            let s = score(q);
            if s > best.1 {
                best = (q, s);
                moved = true;
            }
        }
        if !moved {
            step *= 0.5;
        }
    }
    let clear = if best.1 >= 0.0 {
        boundary_distance(p, best.0).max(0.0)
    } else {
        0.0
    };
    (best.0, clear)
}

pub(crate) fn boundary_distance(p: &Polygon, q: V2) -> f64 {
    let mut best = f64::INFINITY;
    for r in std::iter::once(&p.outer).chain(&p.holes) {
        let n = r.len();
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 {
                (((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            best = best.min((q[0] - a[0] - dx * t).m_hypot(q[1] - a[1] - dy * t));
        }
    }
    best
}

pub(crate) fn principal_axis(p: &Polygon) -> V2 {
    let n = p.outer.len().max(1) as f64;
    let c = p
        .outer
        .iter()
        .fold([0.0, 0.0], |a, q| [a[0] + q[0] / n, a[1] + q[1] / n]);
    let (mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0);
    for q in &p.outer {
        let (x, y) = (q[0] - c[0], q[1] - c[1]);
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    }
    let angle = 0.5 * (2.0 * sxy).m_atan2(sxx - syy);
    [angle.m_cos(), angle.m_sin()]
}

fn extent_along(p: &Polygon, axis: V2) -> f64 {
    let proj = p.outer.iter().map(|q| q[0] * axis[0] + q[1] * axis[1]);
    let (lo, hi) = proj.fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), v| {
        (l.min(v), h.max(v))
    });
    (hi - lo).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    fn cube(s: f64) -> TriMesh {
        build::box_mesh([0.0; 3], [s, s, s])
    }

    #[test]
    fn section_of_a_torus_has_two_islands_across_its_axis() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 120, 60);
        let s = section(&t, &Plane::new([0.0; 3], [0.0, 1.0, 0.0]).unwrap());
        assert_eq!(s.islands(), 2);
        let expect = 2.0 * std::f64::consts::PI * 36.0;
        assert!((s.area() - expect).abs() / expect < 0.01, "{}", s.area());
        let flat = section(&t, &Plane::horizontal(0.0));
        assert_eq!(flat.islands(), 1);
        assert_eq!(flat.polygons[0].holes.len(), 1);
    }

    #[test]
    fn plain_cut_conserves_volume() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 150, 100);
        let plane = Plane::new([1.0, 2.0, 0.5], [0.3, 0.2, 1.0]).unwrap();
        let r = plane_cut(&t, &plane, &CutOptions::default()).unwrap();
        assert!(r.report.below_edges.is_watertight(), "{:?}", r.report.below_edges);
        assert!(r.report.above_edges.is_watertight(), "{:?}", r.report.above_edges);
        let total = r.below.volume() + r.above.volume();
        assert!((total - t.volume()).abs() < 1e-6 * t.volume());
    }

    #[test]
    fn pins_add_to_the_lower_part_and_sockets_remove_from_the_upper() {
        let c = cube(30.0);
        let spec = ConnectorSpec {
            kind: ConnectorKind::Pin,
            ..ConnectorSpec::default()
        };
        let r = plane_cut(
            &c,
            &Plane::horizontal(15.0),
            &CutOptions {
                connector: Some(spec.clone()),
            },
        )
        .unwrap();
        assert_eq!(r.report.connectors.len(), 1, "{:?}", r.report.warnings);
        assert!(r.report.below_edges.is_watertight(), "{:?}", r.report.below_edges);
        assert!(r.report.above_edges.is_watertight(), "{:?}", r.report.above_edges);
        let pin = Polygon::simple(poly2d::circle([0.0, 0.0], 2.5, 32)).area() * spec.depth_mm;
        assert!((r.below.volume() - (13_500.0 + pin)).abs() < 1e-6);
        let socket = Polygon::simple(poly2d::circle([0.0, 0.0], 2.65, 32)).area() * 6.4;
        assert!((r.above.volume() - (13_500.0 - socket)).abs() < 1e-6);
    }

    #[test]
    fn dowels_make_two_sockets_and_a_dowel() {
        let slab = build::box_mesh([0.0; 3], [120.0, 30.0, 40.0]);
        let r = plane_cut(
            &slab,
            &Plane::horizontal(20.0),
            &CutOptions {
                connector: Some(ConnectorSpec {
                    kind: ConnectorKind::Dowel,
                    ..ConnectorSpec::default()
                }),
            },
        )
        .unwrap();
        assert_eq!(r.report.connectors.len(), 2, "{:?}", r.report.warnings);
        assert_eq!(r.extras.len(), 2);
        assert!(r.report.below_edges.is_watertight(), "{:?}", r.report.below_edges);
        assert!(r.report.above_edges.is_watertight());
        assert!(r.below.volume() < 72_000.0 && r.above.volume() < 72_000.0);
    }

    #[test]
    fn dovetail_rail_and_channel() {
        let c = build::box_mesh([0.0; 3], [40.0, 30.0, 30.0]);
        let r = plane_cut(
            &c,
            &Plane::horizontal(12.0),
            &CutOptions {
                connector: Some(ConnectorSpec {
                    kind: ConnectorKind::Dovetail,
                    diameter_mm: 8.0,
                    depth_mm: 4.0,
                    ..ConnectorSpec::default()
                }),
            },
        )
        .unwrap();
        assert_eq!(r.report.connectors.len(), 1, "{:?}", r.report.warnings);
        assert!(r.report.below_edges.is_watertight(), "{:?}", r.report.below_edges);
        assert!(r.report.above_edges.is_watertight(), "{:?}", r.report.above_edges);
        let top = 8.0 + 2.0 * 4.0 * 15f64.to_radians().m_tan();
        let rail = f64::midpoint(8.0, top) * 4.0 * 40.0;
        assert!(
            (r.below.volume() - (40.0 * 30.0 * 12.0 + rail)).abs() < 1e-3,
            "{}",
            r.below.volume()
        );
        assert!(r.above.volume() < 40.0 * 30.0 * 18.0 - rail);
    }

    #[test]
    fn connector_without_room_is_skipped_with_a_warning() {
        let thin = build::box_mesh([0.0; 3], [4.0, 40.0, 20.0]);
        let r = plane_cut(
            &thin,
            &Plane::horizontal(10.0),
            &CutOptions {
                connector: Some(ConnectorSpec::default()),
            },
        )
        .unwrap();
        assert!(r.report.connectors.is_empty());
        assert!(!r.report.warnings.is_empty());
        assert!(r.report.below_edges.is_watertight());
    }

    #[test]
    #[ignore = "timing, run with --release -- --ignored --nocapture"]
    fn timing_on_30k_torus() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 150, 100);
        let plane = Plane::new([0.0, 0.0, 1.0], [0.1, 0.0, 1.0]).unwrap();
        let t0 = std::time::Instant::now();
        let s = section(&t, &plane);
        let t_section = t0.elapsed();
        let t0 = std::time::Instant::now();
        let r = plane_cut(&t, &plane, &CutOptions::default()).unwrap();
        let t_cut = t0.elapsed();
        let t0 = std::time::Instant::now();
        let pins = plane_cut(
            &t,
            &Plane::new([0.0; 3], [0.0, 1.0, 0.0]).unwrap(),
            &CutOptions {
                connector: Some(ConnectorSpec {
                    diameter_mm: 4.0,
                    depth_mm: 5.0,
                    ..ConnectorSpec::default()
                }),
            },
        )
        .unwrap();
        let t_pins = t0.elapsed();
        println!(
            "section {:?} ({} islands), cut {:?} (watertight {} {}), cut with pins {:?} ({} pins)",
            t_section,
            s.islands(),
            t_cut,
            r.report.below_edges.is_watertight(),
            r.report.above_edges.is_watertight(),
            t_pins,
            pins.report.connectors.len()
        );
    }
}
