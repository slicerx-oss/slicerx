// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! automatic import
// indices come from meshes built and validated in this module
#![allow(clippy::indexing_slicing)]

use super::{Confidence, ImportedModel, Unit, UnitInfo, detect_unit};
use crate::boolean::{BoolOp, BooleanOptions, Solid, boolean_solids};
use crate::convex::point_inside_mesh;
use crate::error::Result;
use crate::mesh::{Aabb, TriMesh};
use crate::repair::{self, RepairOptions, RepairReport};
use crate::vec3::{self, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::hash_map::Entry;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoOptions {
    pub repair: bool,
    /// rebuild self-intersecting parts up to this many triangles (the rebuild costs about as much as a boolean)
    pub rebuild_max_triangles: usize,
    pub max_hole_edges: usize,
    pub split: bool,
    pub declared_unit: Option<Unit>,
}

impl Default for AutoOptions {
    fn default() -> Self {
        Self {
            repair: true,
            rebuild_max_triangles: 150_000,
            max_hole_edges: 256,
            split: true,
            declared_unit: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub name: String,
    pub slot: u8,
    pub color: Option<String>,
    pub mesh: TriMesh,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InObject {
    pub name: String,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRepair {
    #[serde(flatten)]
    pub repair: RepairReport,
    pub self_intersections_fixed: usize,
    pub self_intersecting_left: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutObject {
    pub name: String,
    pub parts: Vec<Part>,
    pub repair: ObjectRepair,
    /// a body split from a one-part file: a later crossing check rebuilds each of its shells on its own, as the import does
    pub per_shell: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitSuggestion {
    pub unit: Unit,
    /// multiply positions by this to get millimeters (1 when already mm)
    pub scale: f64,
    pub confidence: Confidence,
    pub auto_apply: bool,
    pub reason: String,
    pub size_before: V3,
    pub size_after: V3,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AutoImport {
    pub objects: Vec<OutObject>,
    pub unit: UnitSuggestion,
    pub summary: Vec<String>,
    pub warnings: Vec<String>,
}

pub fn objects_of(model: &ImportedModel) -> Vec<InObject> {
    let mut out: Vec<InObject> = model
        .bodies
        .iter()
        .map(|b| InObject {
            name: b.name.clone(),
            parts: Vec::new(),
        })
        .collect();
    for p in &model.parts {
        if let Some(o) = out.get_mut(p.body) {
            o.parts.push(Part {
                name: p.name.clone(),
                slot: p.slot,
                color: p.color.clone(),
                mesh: p.mesh.clone(),
            });
        }
    }
    out.retain(|o| !o.parts.is_empty());
    if model.format == "stl" && out.len() > 1 {
        let mut merged = TriMesh::default();
        for o in &out {
            for p in &o.parts {
                merged.append(&p.mesh);
            }
        }
        return vec![InObject {
            name: model.name.clone(),
            parts: vec![Part {
                name: model.name.clone(),
                slot: 1,
                color: None,
                mesh: merged,
            }],
        }];
    }
    out
}

pub fn stl_header_unit(bytes: &[u8]) -> Option<Unit> {
    let head = bytes.get(..80)?;
    let text: String = head
        .iter()
        .map(|&b| {
            if b.is_ascii_graphic() || b == b' ' {
                char::from(b.to_ascii_lowercase())
            } else {
                ' '
            }
        })
        .collect();
    for key in ["units", "unit"] {
        if let Some(i) = text.find(key) {
            let rest = text[i + key.len()..].trim_start_matches([' ', '=', ':']);
            let word: String = rest.chars().take_while(char::is_ascii_alphabetic).collect();
            if let Some(u) = Unit::parse(&word).or(match word.as_str() {
                "inches" => Some(Unit::Inch),
                "meters" | "metres" => Some(Unit::Meter),
                "millimeters" | "millimetres" => Some(Unit::Millimeter),
                _ => None,
            }) {
                return Some(u);
            }
        }
    }
    None
}

fn union_bounds(objects: &[InObject]) -> Option<Aabb> {
    objects
        .iter()
        .flat_map(|o| &o.parts)
        .filter_map(|p| p.mesh.bounds())
        .reduce(|a, b| Aabb {
            min: [
                a.min[0].min(b.min[0]),
                a.min[1].min(b.min[1]),
                a.min[2].min(b.min[2]),
            ],
            max: [
                a.max[0].max(b.max[0]),
                a.max[1].max(b.max[1]),
                a.max[2].max(b.max[2]),
            ],
        })
}

fn inch_like(size: V3) -> bool {
    size.iter().all(|&s| {
        let k = s * 16.0;
        s > 0.0 && (k - k.round()).abs() < 1e-3
    }) && size.iter().any(|&s| (s - s.round()).abs() > 1e-6)
}

fn suggest_unit(objects: &[InObject], file: &UnitInfo, opts: &AutoOptions) -> UnitSuggestion {
    let size = union_bounds(objects).map_or([0.0; 3], |b| b.size());
    let mk = |unit: Unit, scale: f64, confidence: Confidence, reason: String| UnitSuggestion {
        unit,
        scale,
        confidence,
        auto_apply: (scale - 1.0).abs() > f64::EPSILON && confidence != Confidence::None,
        reason,
        size_before: size,
        size_after: size.map(|s| s * scale),
    };
    if let Some(u) = opts.declared_unit {
        return mk(
            u,
            u.mm(),
            Confidence::Declared,
            format!("the file says {}", unit_name(u)),
        );
    }
    if let Some(u) = file.declared {
        return mk(
            u,
            1.0,
            Confidence::Declared,
            format!("the file says {}; converted to mm", unit_name(u)),
        );
    }
    let guess = detect_unit(size.iter().copied().fold(0.0, f64::max));
    if guess.detected == Unit::Inch && inch_like(size) {
        return mk(
            Unit::Inch,
            Unit::Inch.mm(),
            Confidence::High,
            "every side is a whole number of sixteenths, which reads as inches".to_owned(),
        );
    }
    mk(
        guess.detected,
        guess.suggested_scale,
        guess.confidence,
        guess.reason,
    )
}

fn unit_name(u: Unit) -> &'static str {
    match u {
        Unit::Micron => "microns",
        Unit::Millimeter => "millimeters",
        Unit::Centimeter => "centimeters",
        Unit::Meter => "meters",
        Unit::Inch => "inches",
        Unit::Foot => "feet",
    }
}

type TriKey = [[u64; 3]; 3];

fn tri_key(m: &TriMesh, t: [u32; 3]) -> TriKey {
    let mut k = t.map(|i| m.positions[i as usize].map(|c| (c + 0.0).to_bits()));
    k.sort_unstable();
    k
}

fn repair_object(parts: &[Part], opts: &AutoOptions) -> Result<(Vec<TriMesh>, RepairReport)> {
    let mut merged = TriMesh::default();
    let mut owner: HashMap<TriKey, usize> = HashMap::new();
    for (i, p) in parts.iter().enumerate() {
        for &t in &p.mesh.triangles {
            owner.entry(tri_key(&p.mesh, t)).or_insert(i);
        }
        merged.append(&p.mesh);
    }
    let ropts = RepairOptions {
        max_hole_edges: opts.max_hole_edges,
        ..RepairOptions::default()
    };
    let (fixed, report) = repair::repair(&merged, &ropts)?;
    if parts.len() == 1 {
        return Ok((vec![fixed], report));
    }
    let mut which: Vec<Option<usize>> = fixed
        .triangles
        .iter()
        .map(|&t| owner.get(&tri_key(&fixed, t)).copied())
        .collect();
    let mut by_edge: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (i, t) in fixed.triangles.iter().enumerate() {
        for j in 0..3 {
            let (a, b) = (t[j], t[(j + 1) % 3]);
            by_edge.entry((a.min(b), a.max(b))).or_default().push(i);
        }
    }
    loop {
        let mut changed = false;
        for i in 0..which.len() {
            if which[i].is_some() {
                continue;
            }
            let t = fixed.triangles[i];
            let found = (0..3).find_map(|j| {
                let (a, b) = (t[j], t[(j + 1) % 3]);
                by_edge.get(&(a.min(b), a.max(b)))?.iter().find_map(|&n| which[n])
            });
            if found.is_some() {
                which[i] = found;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut out: Vec<Vec<[u32; 3]>> = vec![Vec::new(); parts.len()];
    for (i, t) in fixed.triangles.iter().enumerate() {
        out[which[i].unwrap_or(0)].push(*t);
    }
    Ok((out.iter().map(|tris| fixed.subset(tris)).collect(), report))
}

/// What a closed mesh that crosses itself becomes.
#[derive(Debug, Clone, PartialEq)]
pub enum SelfCrossing {
    /// open, or closed without crossing itself
    None,
    /// rebuilt without the crossings
    Fixed(TriMesh),
    /// it crosses itself and stays so: bigger than `max_triangles`, or the rebuild failed
    Left,
}

/// Checks a closed mesh for faces that cross each other and rebuilds it when it has at most `max_triangles`; with
/// `per_shell`, each crossing shell is rebuilt on its own, so loose bodies stay apart. The import runs this on each
/// part, and an app can run it later on its own (`import.selfIntersections`), after it has shown the model.
pub fn self_crossing(m: &TriMesh, max_triangles: usize, per_shell: bool) -> SelfCrossing {
    if !m.edge_report().is_watertight() || !Solid::new(m).is_ok_and(|s| s.self_intersects()) {
        return SelfCrossing::None;
    }
    if m.triangles.len() > max_triangles {
        return SelfCrossing::Left;
    }
    rebuild_crossing_shells(m, per_shell).map_or(SelfCrossing::Left, SelfCrossing::Fixed)
}

fn rebuild_crossing_shells(m: &TriMesh, per_shell: bool) -> Option<TriMesh> {
    let shells = if per_shell { edge_shells(m) } else { Vec::new() };
    if shells.len() < 2 {
        return Solid::new(m)
            .ok()?
            .rebuilt(false)
            .ok()
            .filter(|r| r.volume() > 0.0)
            .map(|r| r.to_mesh());
    }
    let mut out = TriMesh::default();
    let mut fixed = false;
    for s in &shells {
        let crossing = s.volume() > 0.0 && Solid::new(s).is_ok_and(|x| x.self_intersects());
        if crossing {
            let r = Solid::new(s).ok()?.rebuilt(false).ok()?;
            if r.volume() <= 0.0 {
                return None;
            }
            out.append(&r.to_mesh());
            fixed = true;
        } else {
            out.append(s);
        }
    }
    fixed.then_some(out)
}

pub(crate) fn edge_shells(m: &TriMesh) -> Vec<TriMesh> {
    let n = m.triangles.len();
    let mut parent: Vec<usize> = (0..n).collect();
    let mut first: HashMap<(u32, u32), usize> = HashMap::with_capacity(n * 2);
    for (i, t) in m.triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            match first.entry((a.min(b), a.max(b))) {
                Entry::Occupied(e) => {
                    let (ra, rb) = (find(&mut parent, *e.get()), find(&mut parent, i));
                    parent[rb] = ra;
                }
                Entry::Vacant(e) => {
                    e.insert(i);
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<[u32; 3]>> = HashMap::new();
    let mut order = Vec::new();
    for (i, t) in m.triangles.iter().enumerate() {
        let r = find(&mut parent, i);
        groups
            .entry(r)
            .or_insert_with(|| {
                order.push(r);
                Vec::new()
            })
            .push(*t);
    }
    let mut out: Vec<TriMesh> = order
        .into_iter()
        .filter_map(|r| groups.remove(&r))
        .map(|tris| m.subset(&tris))
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.triangles.len()));
    out
}

fn group_shells(m: &TriMesh) -> Vec<Vec<TriMesh>> {
    let shells = edge_shells(m);
    if shells.len() < 2 {
        return vec![vec![m.clone()]];
    }
    let diag = m.bounds().map_or(1.0, |b| b.diagonal());
    let tol = (diag * 1e-5).max(1e-3);
    let boxes: Vec<Aabb> = shells
        .iter()
        .map(|s| {
            s.bounds().unwrap_or(Aabb {
                min: [0.0; 3],
                max: [0.0; 3],
            })
        })
        .collect();
    let vols: Vec<f64> = shells.iter().map(TriMesh::volume).collect();
    let n = shells.len();
    let mut body_of: Vec<usize> = (0..n).collect();
    for i in 0..n {
        if vols[i] >= 0.0 {
            continue;
        }
        let probe = shells[i].positions[0];
        let holder = (0..n)
            .filter(|&j| j != i && vols[j] > 0.0 && contains_box(&boxes[j], &boxes[i]))
            .filter(|&j| point_inside_mesh(&shells[j], probe))
            .min_by(|&a, &b| vols[a].total_cmp(&vols[b]));
        if let Some(j) = holder {
            body_of[i] = j;
        }
    }
    let bodies: Vec<usize> = (0..n).filter(|&i| body_of[i] == i).collect();
    let mut body_mesh: HashMap<usize, TriMesh> = bodies.iter().map(|&b| (b, shells[b].clone())).collect();
    for i in 0..n {
        if body_of[i] != i
            && let Some(m) = body_mesh.get_mut(&body_of[i])
        {
            m.append(&shells[i]);
        }
    }
    let mut parent: Vec<usize> = (0..bodies.len()).collect();
    for a in 0..bodies.len() {
        for b in a + 1..bodies.len() {
            let (ia, ib) = (bodies[a], bodies[b]);
            if !boxes_meet(&boxes[ia], &boxes[ib], tol) {
                continue;
            }
            if touch(&body_mesh[&ia], &body_mesh[&ib], tol) {
                let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                parent[rb] = ra;
            }
        }
    }
    let mut groups: Vec<(usize, Vec<TriMesh>)> = Vec::new();
    for (k, &b) in bodies.iter().enumerate() {
        let r = find(&mut parent, k);
        let mesh = body_mesh.remove(&b).unwrap_or_default();
        match groups.iter_mut().find(|g| g.0 == r) {
            Some(g) => g.1.push(mesh),
            None => groups.push((r, vec![mesh])),
        }
    }
    groups.into_iter().map(|g| g.1).collect()
}

fn contains_box(outer: &Aabb, inner: &Aabb) -> bool {
    (0..3).all(|k| outer.min[k] <= inner.min[k] && inner.max[k] <= outer.max[k])
}

fn boxes_meet(a: &Aabb, b: &Aabb, tol: f64) -> bool {
    (0..3).all(|k| a.min[k] - tol <= b.max[k] && b.min[k] - tol <= a.max[k])
}

fn point_tri_distance(p: V3, a: V3, b: V3, c: V3) -> f64 {
    let n = vec3::tri_normal(a, b, c);
    if let Some(nn) = vec3::normalize(n) {
        let d = vec3::dot(vec3::sub(p, a), nn);
        let q = vec3::sub(p, vec3::scale(nn, d));
        let inside = [(a, b), (b, c), (c, a)]
            .iter()
            .all(|&(x, y)| vec3::dot(vec3::cross(vec3::sub(y, x), vec3::sub(q, x)), n) >= 0.0);
        if inside {
            return d.abs();
        }
    }
    [(a, b), (b, c), (c, a)]
        .iter()
        .map(|&(x, y)| {
            let xy = vec3::sub(y, x);
            let l2 = vec3::dot(xy, xy);
            let t = if l2 > 0.0 {
                (vec3::dot(vec3::sub(p, x), xy) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            vec3::len(vec3::sub(p, vec3::add(x, vec3::scale(xy, t))))
        })
        .fold(f64::INFINITY, f64::min)
}

fn touch(a: &TriMesh, b: &TriMesh, tol: f64) -> bool {
    let (Some(ba), Some(bb)) = (a.bounds(), b.bounds()) else {
        return false;
    };
    let lo = [0, 1, 2].map(|k| ba.min[k].max(bb.min[k]) - tol);
    let hi = [0, 1, 2].map(|k| ba.max[k].min(bb.max[k]) + tol);
    let in_box = |p: &V3| (0..3).all(|k| lo[k] <= p[k] && p[k] <= hi[k]);
    let tris_in = |m: &TriMesh| -> Vec<[V3; 3]> {
        m.triangles
            .iter()
            .map(|&t| m.corners(t))
            .filter(|c| {
                (0..3).all(|k| c.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min) <= hi[k])
                    && (0..3).all(|k| c.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max) >= lo[k])
            })
            .collect()
    };
    for (x, y) in [(a, b), (b, a)] {
        let pts: Vec<V3> = x.positions.iter().copied().filter(in_box).collect();
        if pts.is_empty() {
            continue;
        }
        let tris = tris_in(y);
        let step = (pts.len() / 400).max(1);
        for p in pts.iter().step_by(step) {
            if tris
                .iter()
                .take(50_000)
                .any(|t| point_tri_distance(*p, t[0], t[1], t[2]) <= tol)
            {
                return true;
            }
            if point_inside_mesh(y, *p) {
                return true;
            }
        }
    }
    if let (Ok(sa), Ok(sb)) = (Solid::new(a), Solid::new(b))
        && let Ok((m, _)) = boolean_solids(&[sa], &[sb], BoolOp::Intersection, &BooleanOptions::default())
    {
        return m.volume() > tol * tol * tol;
    }
    false
}

pub fn auto_import(objects: Vec<InObject>, file_unit: &UnitInfo, opts: &AutoOptions) -> Result<AutoImport> {
    let unit = suggest_unit(&objects, file_unit, opts);
    let mut out = Vec::new();
    let mut warnings = Vec::new();
    let mut total = ObjectRepair::default();
    for obj in objects {
        let (meshes, report) = if opts.repair {
            repair_object(&obj.parts, opts)?
        } else {
            (
                obj.parts.iter().map(|p| p.mesh.clone()).collect(),
                RepairReport::default(),
            )
        };
        let mut rep = ObjectRepair {
            repair: report,
            ..ObjectRepair::default()
        };
        let mut parts = Vec::new();
        for (p, mut m) in obj.parts.iter().zip(meshes) {
            if opts.repair && opts.rebuild_max_triangles > 0 {
                match self_crossing(&m, opts.rebuild_max_triangles, opts.split && obj.parts.len() == 1) {
                    SelfCrossing::None => {}
                    SelfCrossing::Fixed(r) => {
                        m = r;
                        rep.self_intersections_fixed += 1;
                    }
                    SelfCrossing::Left => rep.self_intersecting_left += 1,
                }
            }
            parts.push(Part {
                name: p.name.clone(),
                slot: p.slot,
                color: p.color.clone(),
                mesh: m,
            });
        }
        add_report(&mut total, &rep);
        if opts.split && parts.len() == 1 {
            let part = parts.remove(0);
            let groups = group_shells(&part.mesh);
            let many_groups = groups.len() > 1;
            for (gi, g) in groups.into_iter().enumerate() {
                let name = if many_groups {
                    format!("{} {}", obj.name, gi + 1)
                } else {
                    obj.name.clone()
                };
                let many_parts = g.len() > 1;
                out.push(OutObject {
                    name: name.clone(),
                    parts: g
                        .into_iter()
                        .enumerate()
                        .map(|(k, mesh)| Part {
                            name: if many_parts {
                                format!("{name} part {}", k + 1)
                            } else {
                                name.clone()
                            },
                            slot: part.slot,
                            color: part.color.clone(),
                            mesh,
                        })
                        .collect(),
                    repair: if gi == 0 {
                        rep.clone()
                    } else {
                        ObjectRepair::default()
                    },
                    per_shell: true,
                });
            }
        } else {
            out.push(OutObject {
                name: obj.name,
                parts,
                repair: rep,
                per_shell: false,
            });
        }
    }
    let mut summary = Vec::new();
    if let Some(s) = repair_sentence(&total) {
        summary.push(s);
    }
    if total.repair.holes_left_open > 0 || total.repair.non_manifold_edges > 0 {
        warnings.push(format!(
            "{} holes stay open and {} edges are shared by more than two faces; the slicer closes what it can",
            total.repair.holes_left_open, total.repair.non_manifold_edges
        ));
    }
    if total.self_intersecting_left > 0 {
        warnings.push(format!(
            "{} parts still cross themselves (too large to rebuild during import)",
            total.self_intersecting_left
        ));
    }
    if unit.auto_apply {
        summary.push(format!(
            "Scaled from {} to millimeters (x{}).",
            unit_name(unit.unit),
            trim(unit.scale)
        ));
    }
    let parts_total: usize = out.iter().map(|o| o.parts.len()).sum();
    if out.len() > 1 {
        summary.push(format!("Split into {} objects.", out.len()));
    } else if parts_total > 1 && out.first().is_some_and(|o| o.parts.len() > 1) {
        summary.push(format!("Loaded as one object with {parts_total} parts."));
    }
    Ok(AutoImport {
        objects: out,
        unit,
        summary,
        warnings,
    })
}

fn trim(x: f64) -> String {
    let s = format!("{x:.4}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

fn add_report(t: &mut ObjectRepair, r: &ObjectRepair) {
    let (a, b) = (&mut t.repair, &r.repair);
    a.vertices_merged += b.vertices_merged;
    a.degenerate_removed += b.degenerate_removed;
    a.duplicates_removed += b.duplicates_removed;
    a.triangles_flipped += b.triangles_flipped;
    a.holes_filled += b.holes_filled;
    a.holes_left_open += b.holes_left_open;
    a.non_manifold_edges += b.non_manifold_edges;
    t.self_intersections_fixed += r.self_intersections_fixed;
    t.self_intersecting_left += r.self_intersecting_left;
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn repair_sentence(r: &ObjectRepair) -> Option<String> {
    let x = &r.repair;
    let mut bits = Vec::new();
    if x.holes_filled > 0 {
        bits.push(format!("closed {}", plural(x.holes_filled, "hole", "holes")));
    }
    if x.triangles_flipped > 0 {
        bits.push(format!(
            "flipped {}",
            plural(x.triangles_flipped, "face", "faces")
        ));
    }
    if x.duplicates_removed + x.degenerate_removed > 0 {
        bits.push(format!(
            "removed {}",
            plural(
                x.duplicates_removed + x.degenerate_removed,
                "bad face",
                "bad faces"
            )
        ));
    }
    if r.self_intersections_fixed > 0 {
        bits.push(format!(
            "fixed self-intersections in {}",
            plural(r.self_intersections_fixed, "part", "parts")
        ));
    }
    if bits.is_empty() {
        return None;
    }
    Some(format!("Repaired: {}.", bits.join(", ")))
}

fn find(p: &mut [usize], mut x: usize) -> usize {
    while p[x] != x {
        p[x] = p[p[x]];
        x = p[x];
    }
    x
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "box corners and unit scales are exact")]
mod tests {
    use super::*;
    use crate::build;

    fn one(mesh: TriMesh) -> Vec<InObject> {
        vec![InObject {
            name: "m".into(),
            parts: vec![Part {
                name: "m".into(),
                slot: 1,
                color: None,
                mesh,
            }],
        }]
    }

    fn mm() -> UnitInfo {
        detect_unit(100.0)
    }

    #[test]
    fn repairs_holes_and_flips_and_reports() {
        let mut m = build::box_mesh([0.0; 3], [20.0, 20.0, 20.0]);
        m.faces = None;
        m.triangles.pop();
        m.triangles[0] = [m.triangles[0][0], m.triangles[0][2], m.triangles[0][1]];
        let r = auto_import(one(m), &mm(), &AutoOptions::default()).unwrap();
        let o = &r.objects[0];
        assert!(o.parts[0].mesh.edge_report().is_watertight());
        assert!(o.repair.repair.holes_filled == 1 && o.repair.repair.triangles_flipped >= 1);
        assert!(
            r.summary[0].starts_with("Repaired: closed 1 hole, flipped"),
            "{:?}",
            r.summary
        );
        assert!(!r.unit.auto_apply);
    }

    #[test]
    fn splits_far_shells_and_keeps_touching_and_cavities() {
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        let mut cavity = build::box_mesh([3.0; 3], [6.0, 6.0, 6.0]);
        cavity.flip();
        m.append(&cavity);
        m.append(&build::box_mesh([10.0, 0.0, 0.0], [15.0, 5.0, 5.0]));
        m.append(&build::box_mesh([40.0, 0.0, 0.0], [45.0, 5.0, 5.0]));
        m.append(&build::box_mesh([60.0, 4.0, 0.0], [80.0, 6.0, 2.0]));
        m.append(&build::box_mesh([69.0, -5.0, 0.5], [71.0, 15.0, 1.5]));
        let r = auto_import(one(m), &mm(), &AutoOptions::default()).unwrap();
        let shape: Vec<usize> = r.objects.iter().map(|o| o.parts.len()).collect();
        assert_eq!(shape.len(), 3, "{shape:?}");
        assert!(shape.contains(&2));
        let first = r
            .objects
            .iter()
            .find(|o| o.parts.iter().any(|p| p.mesh.bounds().unwrap().min[0] == 0.0))
            .unwrap();
        assert_eq!(first.parts.len(), 2);
        let hollow = first
            .parts
            .iter()
            .find(|p| p.mesh.bounds().unwrap().max[0] == 10.0)
            .unwrap();
        assert!((hollow.mesh.volume() - (1000.0 - 27.0)).abs() < 1e-6);
        assert!(r.summary.iter().any(|s| s == "Split into 3 objects."));
    }

    #[test]
    fn units_from_size_header_and_declared() {
        let small = build::box_mesh([0.0; 3], [1.5, 0.75, 0.25]);
        let r = auto_import(one(small.clone()), &detect_unit(1.5), &AutoOptions::default()).unwrap();
        assert_eq!(r.unit.unit, Unit::Inch);
        assert_eq!(r.unit.confidence, Confidence::High);
        assert!(r.unit.auto_apply && (r.unit.size_after[0] - 38.1).abs() < 1e-9);
        let tiny = build::box_mesh([0.0; 3], [0.2, 0.1, 0.05]);
        let r = auto_import(one(tiny), &detect_unit(0.2), &AutoOptions::default()).unwrap();
        assert_eq!(r.unit.unit, Unit::Meter);
        let opts = AutoOptions {
            declared_unit: Some(Unit::Millimeter),
            ..AutoOptions::default()
        };
        let r = auto_import(one(small), &detect_unit(1.5), &opts).unwrap();
        assert!(!r.unit.auto_apply && r.unit.scale == 1.0);
        let mut head = [b' '; 84];
        head[..20].copy_from_slice(b"exported units=inch ");
        assert_eq!(stl_header_unit(&head), Some(Unit::Inch));
        assert_eq!(stl_header_unit(&[b' '; 84]), None);
    }

    #[test]
    fn self_intersection_is_rebuilt() {
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        m.append(&build::box_mesh([5.0, 5.0, 5.0], [15.0, 15.0, 15.0]));
        let opts = AutoOptions {
            split: false,
            ..AutoOptions::default()
        };
        let r = auto_import(one(m), &mm(), &opts).unwrap();
        let o = &r.objects[0];
        assert_eq!(o.repair.self_intersections_fixed, 1, "{:?}", o.repair);
        assert!((o.parts[0].mesh.volume() - (2000.0 - 125.0)).abs() < 1e-6);
    }

    #[test]
    fn the_crossing_check_runs_on_its_own_too() {
        let mut m = build::box_mesh([0.0; 3], [10.0, 10.0, 10.0]);
        m.append(&build::box_mesh([5.0, 5.0, 5.0], [15.0, 15.0, 15.0]));
        match self_crossing(&m, 150_000, false) {
            SelfCrossing::Fixed(r) => assert!((r.volume() - (2000.0 - 125.0)).abs() < 1e-6),
            other => panic!("{other:?}"),
        }
        // Too big to rebuild: it says so and leaves the mesh.
        assert_eq!(self_crossing(&m, 11, false), SelfCrossing::Left);
        assert_eq!(
            self_crossing(&build::box_mesh([0.0; 3], [1.0; 3]), 150_000, true),
            SelfCrossing::None
        );
        // The import with the check left out keeps the crossing mesh as it is.
        let skip = AutoOptions {
            split: false,
            rebuild_max_triangles: 0,
            ..AutoOptions::default()
        };
        let r = auto_import(one(m), &mm(), &skip).unwrap();
        assert_eq!(r.objects[0].repair.self_intersections_fixed, 0);
        assert_eq!(r.objects[0].repair.self_intersecting_left, 0);
    }
}
