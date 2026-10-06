// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! the face shape tool
// ring indices are taken modulo their length; triangle indices come from
// the validated mesh
#![allow(clippy::indexing_slicing)]

use crate::boolean::{self, BoolOp, BooleanOptions, BooleanReport};
use crate::build;
use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::measure::Topology;
use crate::mesh::TriMesh;
use crate::outline::{self, TextOptions};
use crate::poly2d::{self, Polygon};
use crate::sketch;
use crate::svg;
use crate::vec3::{self, Frame, V2, V3};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

/// joins and cuts reach this far past the face so the boolean never meets two coincident faces
const OVERLAP_MM: f64 = 0.01;
const ARC_TOL_MM: f64 = 0.005;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceFrame {
    pub origin: V3,
    pub normal: V3,
    pub u: V3,
    pub v: V3,
}

impl FaceFrame {
    pub fn for_normal(origin: V3, normal: V3) -> Result<Self> {
        let w =
            vec3::normalize(normal).ok_or_else(|| Error::invalid("normal", "must be a non-zero vector"))?;
        let u = if w[2].abs() > 0.9 {
            vec3::normalize([1.0 - w[0] * w[0], -w[0] * w[1], -w[0] * w[2]]).unwrap_or([1.0, 0.0, 0.0])
        } else {
            vec3::normalize(vec3::cross([0.0, 0.0, 1.0], w)).unwrap_or([1.0, 0.0, 0.0])
        };
        let v = vec3::cross(w, u);
        Ok(Self {
            origin,
            normal: w,
            u,
            v,
        })
    }

    pub fn bed(origin: V2) -> Self {
        Self {
            origin: [origin[0], origin[1], 0.0],
            normal: [0.0, 0.0, 1.0],
            u: [1.0, 0.0, 0.0],
            v: [0.0, 1.0, 0.0],
        }
    }

    pub fn checked(&self) -> Result<Frame> {
        let w =
            vec3::normalize(self.normal).ok_or_else(|| Error::invalid("frame", "normal must be non-zero"))?;
        Frame::from_normal(self.origin, w, Some(self.u)).ok_or_else(|| Error::invalid("frame", "bad axes"))
    }

    fn frame(&self) -> Frame {
        Frame {
            origin: self.origin,
            u: self.u,
            v: self.v,
            w: self.normal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacePick {
    pub frame: FaceFrame,
    pub outline: Vec<Polygon>,
    pub area_mm2: f64,
    pub at: V2,
    pub min: V2,
    pub max: V2,
    pub triangles: Vec<u32>,
}

pub fn pick_face(mesh: &TriMesh, triangle: u32, at: V3) -> Result<FacePick> {
    mesh.validate("face")?;
    if triangle as usize >= mesh.triangles.len() {
        return Err(Error::invalid("triangle", "out of range"));
    }
    let topo = Topology::new(mesh);
    let region = topo.flat_region(triangle);
    let boundary = topo.region_boundary(&region);
    if boundary.iter().all(|(a, b)| !topo.is_sharp(*a, *b)) && !rounded_all_round(&topo, &region, &boundary) {
        return Err(Error::invalid("face", "pick a flat face"));
    }
    let normal = topo.normals[triangle as usize];
    let (mut acc, mut area) = ([0.0; 3], 0.0);
    for &t in &region {
        let [a, b, c] = topo.corners(t);
        let w = vec3::len(vec3::tri_normal(a, b, c)) * 0.5;
        acc = vec3::add(acc, vec3::scale(vec3::add(vec3::add(a, b), c), w / 3.0));
        area += w;
    }
    if area <= 0.0 {
        return Err(Error::invalid("face", "the face has no area"));
    }
    let origin = vec3::scale(acc, 1.0 / area);
    let frame = FaceFrame::for_normal(origin, normal)?;
    let f = frame.frame();
    let rings = chain_loops(&boundary)
        .into_iter()
        .map(|l| l.into_iter().map(|p| f.project(p)).collect::<Vec<V2>>())
        .filter(|r| r.len() >= 3)
        .collect::<Vec<_>>();
    let outline = poly2d::nest(rings);
    let (min, max) = outline.iter().flat_map(|p| p.outer.iter()).fold(
        ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]),
        |(lo, hi), v| {
            (
                [lo[0].min(v[0]), lo[1].min(v[1])],
                [hi[0].max(v[0]), hi[1].max(v[1])],
            )
        },
    );
    Ok(FacePick {
        frame,
        outline,
        area_mm2: area,
        at: f.project(at),
        min,
        max,
        triangles: region,
    })
}

/// a flat face rounded all round meets only strips much smaller than itself; a facet of a curved
/// surface meets facets of its own size
fn rounded_all_round(topo: &Topology<'_>, region: &[u32], boundary: &[(V3, V3)]) -> bool {
    let area = topo.area(region);
    let mut seen: HashSet<u32> = region.iter().copied().collect();
    for &(a, b) in boundary {
        for &n in topo.edge_faces(a, b) {
            if seen.contains(&n) {
                continue;
            }
            let strip = topo.flat_region(n);
            if topo.area(&strip) * 4.0 > area {
                return false;
            }
            seen.extend(strip);
        }
    }
    true
}

fn chain_loops(edges: &[(V3, V3)]) -> Vec<Vec<V3>> {
    let k = |p: V3| p.map(|c| (c + 0.0).to_bits());
    let mut next: HashMap<[u64; 3], Vec<usize>> = HashMap::new();
    for (i, (a, _)) in edges.iter().enumerate() {
        next.entry(k(*a)).or_default().push(i);
    }
    let mut used = vec![false; edges.len()];
    let mut loops = Vec::new();
    for s in 0..edges.len() {
        if used[s] {
            continue;
        }
        let mut ring = Vec::new();
        let mut i = s;
        loop {
            used[i] = true;
            ring.push(edges[i].0);
            let Some(j) = next
                .get(&k(edges[i].1))
                .and_then(|c| c.iter().copied().find(|&j| !used[j]))
            else {
                break;
            };
            i = j;
        }
        loops.push(ring);
    }
    loops
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PolygonFit {
    #[default]
    Inscribed,
    Circumscribed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Shape {
    Rectangle {
        width_mm: f64,
        height_mm: f64,
        #[serde(default)]
        corner_radius_mm: f64,
    },
    Circle {
        diameter_mm: f64,
    },
    Slot {
        length_mm: f64,
        width_mm: f64,
    },
    Polygon {
        sides: usize,
        diameter_mm: f64,
        #[serde(default)]
        fit: PolygonFit,
    },
    Text {
        text: String,
        size_mm: f64,
        #[serde(default)]
        letter_spacing_mm: f64,
        #[serde(default)]
        line_spacing: Option<f64>,
        #[serde(default)]
        align: outline::Align,
    },
    Sketch {
        loops: Vec<sketch::Loop>,
    },
    Svg {
        svg: String,
        width_mm: f64,
        #[serde(default)]
        tolerance_mm: Option<f64>,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Placement {
    pub center: V2,
    pub rotation_deg: f64,
}

fn positive(v: f64, what: &'static str) -> Result<f64> {
    if v.is_finite() && v > 0.0 && v <= 10_000.0 {
        Ok(v)
    } else {
        Err(Error::invalid(what, "between 0 and 10000 mm"))
    }
}

fn arc(c: V2, r: f64, a0: f64, a1: f64, segs: usize, out: &mut Vec<V2>) {
    for i in 0..=segs {
        let a = a0 + (a1 - a0) * i as f64 / segs as f64;
        out.push([c[0] + r * a.m_cos(), c[1] + r * a.m_sin()]);
    }
}

/// segments for a full circle of radius `r` (at least 24, at most 256)
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "clamped")]
fn circle_segs(r: f64) -> usize {
    let half = (1.0 - (ARC_TOL_MM / r).min(1.0)).m_acos();
    if half <= 0.0 {
        return 256;
    }
    ((PI / half).ceil() as usize).clamp(24, 256).next_multiple_of(4)
}

#[allow(clippy::too_many_lines, reason = "one arm per shape kind")]
fn shape_polygons(
    shape: &Shape,
    at: &Placement,
    font: Option<&[u8]>,
    inset: f64,
    segs_r: Option<f64>,
) -> Result<Vec<Polygon>> {
    let mut polys = match *shape {
        Shape::Rectangle {
            width_mm,
            height_mm,
            corner_radius_mm,
        } => {
            let (w, h) = (positive(width_mm, "widthMm")?, positive(height_mm, "heightMm")?);
            let r0 = corner_radius_mm;
            if !(r0.is_finite() && r0 >= 0.0 && r0 <= w.min(h) / 2.0) {
                return Err(Error::invalid(
                    "cornerRadiusMm",
                    "between 0 and half the shorter side",
                ));
            }
            let (w, h) = (w - 2.0 * inset, h - 2.0 * inset);
            if w <= 0.0 || h <= 0.0 {
                return Err(taper_error());
            }
            if r0 == 0.0 {
                vec![Polygon::simple(poly2d::rect(
                    [-w / 2.0, -h / 2.0],
                    [w / 2.0, h / 2.0],
                ))]
            } else {
                let r = (r0 - inset).max(0.01).min(w.min(h) / 2.0);
                let quarter = (circle_segs(segs_r.unwrap_or(r0)) / 4).max(2);
                let (x, y) = (w / 2.0 - r, h / 2.0 - r);
                let mut ring = Vec::new();
                arc([x, y], r, 0.0, PI / 2.0, quarter, &mut ring);
                arc([-x, y], r, PI / 2.0, PI, quarter, &mut ring);
                arc([-x, -y], r, PI, 1.5 * PI, quarter, &mut ring);
                arc([x, -y], r, 1.5 * PI, 2.0 * PI, quarter, &mut ring);
                ring.dedup();
                vec![Polygon::simple(ring)]
            }
        }
        Shape::Circle { diameter_mm } => {
            let r0 = positive(diameter_mm, "diameterMm")? / 2.0;
            let r = r0 - inset;
            if r <= 0.0 {
                return Err(taper_error());
            }
            vec![Polygon::simple(poly2d::circle(
                [0.0, 0.0],
                r,
                circle_segs(segs_r.unwrap_or(r0)),
            ))]
        }
        Shape::Slot { length_mm, width_mm } => {
            let (l, w) = (positive(length_mm, "lengthMm")?, positive(width_mm, "widthMm")?);
            if w > l {
                return Err(Error::invalid("widthMm", "at most the length"));
            }
            let r0 = w / 2.0;
            let r = r0 - inset;
            if r <= 0.0 {
                return Err(taper_error());
            }
            let x = l / 2.0 - r0;
            let half = (circle_segs(segs_r.unwrap_or(r0)) / 2).max(4);
            let mut ring = Vec::new();
            arc([x, 0.0], r, -PI / 2.0, PI / 2.0, half, &mut ring);
            arc([-x, 0.0], r, PI / 2.0, 1.5 * PI, half, &mut ring);
            ring.dedup();
            vec![Polygon::simple(ring)]
        }
        Shape::Polygon {
            sides,
            diameter_mm,
            fit,
        } => {
            if !(3..=64).contains(&sides) {
                return Err(Error::invalid("sides", "3 to 64"));
            }
            let d = positive(diameter_mm, "diameterMm")?;
            let n = sides as f64;
            let apothem0 = match fit {
                PolygonFit::Inscribed => d / 2.0 * (PI / n).m_cos(),
                PolygonFit::Circumscribed => d / 2.0,
            };
            let apothem = apothem0 - inset;
            if apothem <= 0.0 {
                return Err(taper_error());
            }
            let r = apothem / (PI / n).m_cos();
            let start = -PI / 2.0 - PI / n;
            let ring = (0..sides)
                .map(|i| {
                    let a = start + 2.0 * PI * i as f64 / n;
                    [r * a.m_cos(), r * a.m_sin()]
                })
                .collect();
            vec![Polygon::simple(ring)]
        }
        Shape::Text {
            ref text,
            size_mm,
            letter_spacing_mm,
            line_spacing,
            align,
        } => {
            if inset != 0.0 {
                return Err(Error::invalid("taperDeg", "text cannot be tapered"));
            }
            let opts = TextOptions {
                size_mm,
                letter_spacing_mm,
                line_spacing: line_spacing.unwrap_or(1.0),
                align,
                ..TextOptions::default()
            };
            outline::text_shape(text, font, &opts)?.polygons
        }
        Shape::Sketch { ref loops } => inset_free(sketch::polygons(loops)?, inset)?,
        Shape::Svg {
            ref svg,
            width_mm,
            tolerance_mm,
        } => inset_free(
            svg::outline(svg, width_mm, tolerance_mm.unwrap_or(0.02))?.0,
            inset,
        )?,
    };
    if !(at.center.iter().all(|c| c.is_finite()) && at.rotation_deg.is_finite()) {
        return Err(Error::invalid("placement", "must be finite"));
    }
    let (s, c) = at.rotation_deg.to_radians().m_sin_cos();
    for p in polys
        .iter_mut()
        .flat_map(|p| p.outer.iter_mut().chain(p.holes.iter_mut().flatten()))
    {
        *p = [
            at.center[0] + c * p[0] - s * p[1],
            at.center[1] + s * p[0] + c * p[1],
        ];
    }
    Ok(polys)
}

fn inset_free(polys: Vec<Polygon>, inset: f64) -> Result<Vec<Polygon>> {
    if inset == 0.0 {
        return Ok(polys);
    }
    sketch::inset_keeping_vertices(&polys, inset).ok_or_else(taper_error)
}

fn taper_error() -> Error {
    Error::invalid(
        "taperDeg",
        "the taper closes the shape before the full distance; use a smaller angle or distance",
    )
}

pub fn profile(shape: &Shape, at: &Placement, font: Option<&[u8]>) -> Result<Vec<Polygon>> {
    shape_polygons(shape, at, font, 0.0, None)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Extent {
    #[default]
    OneSide,
    Symmetric,
    TwoSides,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    #[default]
    New,
    Join,
    Cut,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtrudeSpec {
    pub distance_mm: f64,
    pub extent: Extent,
    pub distance2_mm: f64,
    pub flip: bool,
    /// draft in degrees, -45 to 45; positive narrows away from the face
    pub taper_deg: f64,
    pub operation: Operation,
}

impl Default for ExtrudeSpec {
    fn default() -> Self {
        Self {
            distance_mm: 5.0,
            extent: Extent::OneSide,
            distance2_mm: 0.0,
            flip: false,
            taper_deg: 0.0,
            operation: Operation::New,
        }
    }
}

fn piece(
    shape: &Shape,
    at: &Placement,
    font: Option<&[u8]>,
    frame: &Frame,
    lo: f64,
    hi: f64,
    tan: f64,
) -> Result<TriMesh> {
    if tan == 0.0 {
        let polys = shape_polygons(shape, at, font, 0.0, None)?;
        return build::extrude(&polys, frame, lo, hi);
    }
    let seg_r = match *shape {
        Shape::Rectangle { corner_radius_mm, .. } => corner_radius_mm,
        Shape::Circle { diameter_mm } => diameter_mm / 2.0,
        Shape::Slot { width_mm, .. } => width_mm / 2.0,
        _ => 1.0,
    };
    let ring_at =
        |h: f64| -> Result<Vec<Polygon>> { shape_polygons(shape, at, font, h.abs() * tan, Some(seg_r)) };
    let (low, high) = (ring_at(lo)?, ring_at(hi)?);
    let mut out = TriMesh::default();
    for (a, b) in low.iter().zip(&high) {
        let top: Vec<V2> = b.vertices().collect();
        if top.len() != a.vertices().count() {
            return Err(taper_error());
        }
        out.append(&build::loft(std::slice::from_ref(a), frame, lo, hi, |_, i| {
            top[i]
        })?);
    }
    Ok(out)
}

pub fn tool_body(
    frame: &FaceFrame,
    shape: &Shape,
    at: &Placement,
    font: Option<&[u8]>,
    spec: &ExtrudeSpec,
) -> Result<TriMesh> {
    let (a, b) = ends(spec)?;
    body(frame, shape, at, font, spec, a, b)
}

/// Where the tool body starts and ends along the face normal, mm from the face.
fn ends(spec: &ExtrudeSpec) -> Result<(f64, f64)> {
    let d = spec.distance_mm;
    if !(d.is_finite() && d.abs() > 1e-6 && d.abs() <= 10_000.0) {
        return Err(Error::invalid(
            "distanceMm",
            "must not be zero (at most 10000 mm)",
        ));
    }
    if !(spec.taper_deg.is_finite() && spec.taper_deg.abs() <= 45.0) {
        return Err(Error::invalid("taperDeg", "between -45 and 45"));
    }
    let sign = if (spec.operation == Operation::Cut) ^ spec.flip ^ (d < 0.0) {
        -1.0
    } else {
        1.0
    };
    let d = d.abs();
    let (mut a, mut b) = match spec.extent {
        Extent::OneSide => (0.0, sign * d),
        Extent::Symmetric => (-d, d),
        Extent::TwoSides => {
            let d2 = spec.distance2_mm;
            if !(d2.is_finite() && d2 > 0.0) {
                return Err(Error::invalid("distance2Mm", "must be above 0"));
            }
            (0.0 - sign * d2, sign * d)
        }
    };
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    // joins start a hair inside the body and cuts a hair outside, so the boolean never meets the face
    if spec.extent == Extent::OneSide {
        if a == 0.0 && spec.operation == Operation::Join {
            a = -OVERLAP_MM;
        } else if b == 0.0 && spec.operation == Operation::Cut {
            b = OVERLAP_MM;
        }
    }
    Ok((a, b))
}

fn body(
    frame: &FaceFrame,
    shape: &Shape,
    at: &Placement,
    font: Option<&[u8]>,
    spec: &ExtrudeSpec,
    a: f64,
    b: f64,
) -> Result<TriMesh> {
    let f = frame.checked()?;
    let tan = spec.taper_deg.to_radians().m_tan();
    if tan == 0.0 || a >= 0.0 || b <= 0.0 {
        return piece(shape, at, font, &f, a, b, tan);
    }
    let low = piece(shape, at, font, &f, a, 0.0, tan)?;
    let high = piece(shape, at, font, &f, 0.0, b, tan)?;
    Ok(boolean::boolean(&[low], &[high], BoolOp::Union, &BooleanOptions::default())?.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtrudeResult {
    pub mesh: TriMesh,
    pub tool: TriMesh,
    pub report: ExtrudeReport,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtrudeReport {
    pub volume_change_mm3: f64,
    pub touches: bool,
    pub shells: usize,
    pub watertight: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boolean: Option<BooleanReport>,
}

pub fn extrude(
    frame: &FaceFrame,
    shape: &Shape,
    at: &Placement,
    font: Option<&[u8]>,
    spec: &ExtrudeSpec,
    target: Option<&TriMesh>,
) -> Result<ExtrudeResult> {
    let (a, b) = ends(spec)?;
    let mut tool = body(frame, shape, at, font, spec, a, b)?;
    // A cut whose far end lands flush on a face of the body would leave a skin of no thickness there: the
    // kernel keeps the two coincident faces. Such an end goes a hair past the face, as the near end does; an
    // end inside the body (a blind pocket) stays exactly where it was asked.
    if let (Operation::Cut, Some(t)) = (spec.operation, target) {
        let f = frame.checked()?;
        let far = |h: f64| h != 0.0 && h.abs() != OVERLAP_MM && flush(t, &tool, &f, h);
        let (ea, eb) = (far(a), far(b));
        if ea || eb {
            let (a2, b2) = (
                if ea { a - OVERLAP_MM } else { a },
                if eb { b + OVERLAP_MM } else { b },
            );
            tool = body(frame, shape, at, font, spec, a2, b2)?;
        }
    }
    apply(tool, spec.operation, target)
}

/// True when the end cap of `tool` at height `h` above the face frame `f` lies on a face of `target`: some
/// triangle of the target in that plane holds a point of the cap.
pub(crate) fn flush(target: &TriMesh, tool: &TriMesh, f: &Frame, h: f64) -> bool {
    const TOL: f64 = 1e-5;
    let height = |p: V3| vec3::dot(f.w, vec3::sub(p, f.origin)) - h;
    let flat = |tri: [u32; 3], m: &TriMesh| m.corners(tri).iter().all(|&p| height(p).abs() < TOL);
    let local = |p: V3| {
        let q = vec3::sub(p, f.origin);
        [vec3::dot(q, f.u), vec3::dot(q, f.v)]
    };
    let caps: Vec<V2> = tool
        .triangles
        .iter()
        .filter(|&&t| flat(t, tool))
        .map(|&t| {
            let c = tool.corners(t);
            local(vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0))
        })
        .collect();
    if caps.is_empty() {
        return false;
    }
    target.triangles.iter().filter(|&&t| flat(t, target)).any(|&t| {
        let [a, b, c] = target.corners(t).map(local);
        caps.iter().any(|&p| in_triangle(p, a, b, c))
    })
}

/// True when `p` is inside the triangle `a b c` or on its edges, in either winding.
fn in_triangle(p: V2, a: V2, b: V2, c: V2) -> bool {
    let side = |o: V2, q: V2| (q[0] - o[0]) * (p[1] - o[1]) - (q[1] - o[1]) * (p[0] - o[0]);
    let (d1, d2, d3) = (side(a, b), side(b, c), side(c, a));
    let eps = 1e-12;
    !((d1 < -eps || d2 < -eps || d3 < -eps) && (d1 > eps || d2 > eps || d3 > eps))
}

pub fn apply(tool: TriMesh, operation: Operation, target: Option<&TriMesh>) -> Result<ExtrudeResult> {
    let opts = BooleanOptions::default();
    match (operation, target) {
        (Operation::New, _) => {
            let (mesh, r) = boolean::boolean(std::slice::from_ref(&tool), &[], BoolOp::Union, &opts)?;
            Ok(ExtrudeResult {
                report: ExtrudeReport {
                    volume_change_mm3: r.volume_mm3,
                    touches: true,
                    shells: r.shells,
                    watertight: r.watertight,
                    boolean: None,
                },
                mesh,
                tool,
            })
        }
        (_, None) => Err(Error::invalid("target", "join and cut need the body to change")),
        (op, Some(t)) => {
            let before = boolean::Solid::new(t)?;
            let tool_solid = boolean::Solid::new(&tool)?;
            let v0 = before.volume();
            let shells0 = before.to_mesh().components().len();
            let bop = if op == Operation::Join {
                BoolOp::Union
            } else {
                BoolOp::Difference
            };
            let (mesh, r) = boolean::boolean_solids(&[before], &[tool_solid], bop, &opts)?;
            if op == Operation::Cut && r.empty {
                return Err(Error::geometry("extrude", "the cut removes the whole body"));
            }
            let dv = r.volume_mm3 - v0;
            let changed = dv.abs() > 1e-9 * v0.abs().max(1.0);
            let touches = changed && (op != Operation::Join || r.shells <= shells0);
            Ok(ExtrudeResult {
                report: ExtrudeReport {
                    volume_change_mm3: dv,
                    touches,
                    shells: r.shells,
                    watertight: r.watertight,
                    boolean: Some(r),
                },
                mesh,
                tool,
            })
        }
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp, reason = "frames of axis-aligned faces are exact")]
mod tests {
    use super::*;

    fn top_pick(m: &TriMesh) -> FacePick {
        let t = m
            .triangles
            .iter()
            .position(|&t| vec3::normalize(m.normal(t)).unwrap()[2] > 0.99)
            .unwrap();
        let t = u32::try_from(t).unwrap();
        let c = m.corners(m.triangles[t as usize]);
        let at = vec3::scale(vec3::add(vec3::add(c[0], c[1]), c[2]), 1.0 / 3.0);
        pick_face(m, t, at).unwrap()
    }

    #[test]
    fn pick_top_face_frame_and_outline() {
        let m = build::box_mesh([0.0; 3], [40.0, 20.0, 5.0]);
        let p = top_pick(&m);
        assert!(vec3::len(vec3::sub(p.frame.origin, [20.0, 10.0, 5.0])) < 1e-9);
        assert_eq!(p.frame.u, [1.0, 0.0, 0.0]);
        assert!((p.area_mm2 - 800.0).abs() < 1e-9);
        assert_eq!(p.outline.len(), 1);
        assert!((p.outline[0].area() - 800.0).abs() < 1e-9);
        assert!((p.min[0] + 20.0).abs() < 1e-9 && (p.max[1] - 10.0).abs() < 1e-9);
        let side = m
            .triangles
            .iter()
            .position(|&t| vec3::normalize(m.normal(t)).unwrap()[0] > 0.99)
            .map(|i| u32::try_from(i).unwrap())
            .unwrap();
        let s = pick_face(&m, side, [40.0, 10.0, 2.0]).unwrap();
        assert!(s.frame.v[2] > 0.999 && s.frame.u[2].abs() < 1e-12);
    }

    /// Area of the triangles of `m` that lie in the plane z = `z` and face `up` or down.
    fn area_at(m: &TriMesh, z: f64, up: bool) -> f64 {
        m.triangles
            .iter()
            .map(|&t| m.corners(t))
            .filter(|c| c.iter().all(|p| (p[2] - z).abs() < 1e-9))
            .map(|c| vec3::tri_normal(c[0], c[1], c[2]))
            .filter(|n| (n[2] > 0.0) == up)
            .map(|n| vec3::len(n) * 0.5)
            .sum()
    }

    fn cut_circle(depth: f64) -> ExtrudeResult {
        let m = build::box_mesh([0.0; 3], [40.0, 20.0, 5.0]);
        let p = top_pick(&m);
        let spec = ExtrudeSpec {
            distance_mm: depth,
            operation: Operation::Cut,
            ..ExtrudeSpec::default()
        };
        let at = Placement {
            center: [-10.0, 0.0],
            rotation_deg: 0.0,
        };
        extrude(
            &p.frame,
            &Shape::Circle { diameter_mm: 6.0 },
            &at,
            None,
            &spec,
            Some(&m),
        )
        .unwrap()
    }

    #[test]
    fn a_cut_as_deep_as_the_body_opens_the_far_side() {
        let r = cut_circle(5.0);
        let hole = -r.report.volume_change_mm3 / 5.0;
        assert!((hole - PI * 9.0).abs() < 0.02 * PI * 9.0, "{hole}");
        assert!(r.report.watertight);
        // No zero-thickness skin over the far end: the bottom loses the hole's area and nothing faces up there.
        assert!(
            (area_at(&r.mesh, 0.0, false) - (800.0 - hole)).abs() < 1e-6,
            "{}",
            area_at(&r.mesh, 0.0, false)
        );
        assert!(
            area_at(&r.mesh, 0.0, true) < 1e-9,
            "{}",
            area_at(&r.mesh, 0.0, true)
        );
    }

    #[test]
    fn a_blind_pocket_keeps_its_exact_depth() {
        let r = cut_circle(3.0);
        let floor = area_at(&r.mesh, 2.0, true);
        assert!(floor > 0.9 * PI * 9.0, "{floor}");
        assert!(
            (-r.report.volume_change_mm3 - floor * 3.0).abs() < 1e-6,
            "{:?}",
            r.report
        );
        assert!((area_at(&r.mesh, 0.0, false) - 800.0).abs() < 1e-9);
    }

    #[test]
    fn join_cut_and_new() {
        let m = build::box_mesh([0.0; 3], [40.0, 20.0, 5.0]);
        let p = top_pick(&m);
        let circle = Shape::Circle { diameter_mm: 6.0 };
        let at = Placement {
            center: [-10.0, 0.0],
            rotation_deg: 0.0,
        };
        let spec = ExtrudeSpec {
            distance_mm: 3.0,
            operation: Operation::Join,
            ..ExtrudeSpec::default()
        };
        let r = extrude(&p.frame, &circle, &at, None, &spec, Some(&m)).unwrap();
        let boss = PI * 9.0 * 3.0;
        assert!(r.report.touches && r.report.shells == 1 && r.report.watertight);
        assert!(
            (r.report.volume_change_mm3 - boss).abs() < 0.01 * boss,
            "{:?}",
            r.report
        );
        let hole = ExtrudeSpec {
            distance_mm: 2.0,
            operation: Operation::Cut,
            ..ExtrudeSpec::default()
        };
        let slot = Shape::Slot {
            length_mm: 12.0,
            width_mm: 4.0,
        };
        let r = extrude(
            &p.frame,
            &slot,
            &Placement {
                center: [8.0, 0.0],
                rotation_deg: 90.0,
            },
            None,
            &hole,
            Some(&m),
        )
        .unwrap();
        let area = 8.0 * 4.0 + PI * 4.0;
        assert!(
            (r.report.volume_change_mm3 + area * 2.0).abs() < 0.01 * area * 2.0,
            "{:?}",
            r.report
        );
        let b = r.mesh.bounds().unwrap();
        assert!((b.max[2] - 5.0).abs() < 1e-9);
        let all = ExtrudeSpec {
            distance_mm: 10.0,
            operation: Operation::Cut,
            ..ExtrudeSpec::default()
        };
        let big = Shape::Rectangle {
            width_mm: 50.0,
            height_mm: 30.0,
            corner_radius_mm: 0.0,
        };
        assert!(extrude(&p.frame, &big, &Placement::default(), None, &all, Some(&m)).is_err());
        let far = extrude(
            &p.frame,
            &circle,
            &Placement {
                center: [100.0, 0.0],
                rotation_deg: 0.0,
            },
            None,
            &spec,
            Some(&m),
        )
        .unwrap();
        assert!(!far.report.touches);
        let hex = Shape::Polygon {
            sides: 6,
            diameter_mm: 10.0,
            fit: PolygonFit::Circumscribed,
        };
        let r = extrude(
            &FaceFrame::bed([0.0, 0.0]),
            &hex,
            &Placement::default(),
            None,
            &ExtrudeSpec::default(),
            None,
        )
        .unwrap();
        let area = 6.0 * 25.0 * (PI / 6.0).m_tan();
        assert!((r.mesh.volume() - area * 5.0).abs() < 1e-6, "{}", r.mesh.volume());
        let b = r.mesh.bounds().unwrap();
        assert!((b.max[1] - b.min[1] - 10.0).abs() < 1e-9);
    }

    #[test]
    fn reversed_cut_and_join_change_nothing() {
        let m = build::box_mesh([0.0; 3], [40.0, 20.0, 5.0]);
        let p = top_pick(&m);
        let circle = Shape::Circle { diameter_mm: 6.0 };
        let at = Placement {
            center: [-10.0, 0.0],
            rotation_deg: 0.0,
        };
        let spec = ExtrudeSpec {
            distance_mm: 3.0,
            operation: Operation::Join,
            ..ExtrudeSpec::default()
        };
        let hole = ExtrudeSpec {
            distance_mm: 2.0,
            operation: Operation::Cut,
            ..ExtrudeSpec::default()
        };
        let out = extrude(
            &p.frame,
            &circle,
            &at,
            None,
            &ExtrudeSpec { flip: true, ..hole },
            Some(&m),
        )
        .unwrap();
        assert!(!out.report.touches, "{:?}", out.report);
        assert!(out.report.volume_change_mm3.abs() < 1e-6, "{:?}", out.report);
        let inside = extrude(
            &p.frame,
            &circle,
            &at,
            None,
            &ExtrudeSpec { flip: true, ..spec },
            Some(&m),
        )
        .unwrap();
        assert!(!inside.report.touches, "{:?}", inside.report);
        assert!(
            inside.report.volume_change_mm3.abs() < 1e-6,
            "{:?}",
            inside.report
        );
    }

    #[test]
    fn taper_text_and_rounded_rect() {
        let frame = FaceFrame::bed([0.0, 0.0]);
        let rr = Shape::Rectangle {
            width_mm: 20.0,
            height_mm: 10.0,
            corner_radius_mm: 2.0,
        };
        let taper = ExtrudeSpec {
            distance_mm: 4.0,
            taper_deg: 10.0,
            ..ExtrudeSpec::default()
        };
        let r = extrude(&frame, &rr, &Placement::default(), None, &taper, None).unwrap();
        assert!(r.report.watertight);
        let t = 4.0 * 10f64.to_radians().m_tan();
        let b = r.mesh.bounds().unwrap();
        assert!((b.max[0] - 10.0).abs() < 1e-9);
        let top_x = r
            .mesh
            .positions
            .iter()
            .filter(|p| (p[2] - 4.0).abs() < 1e-9)
            .map(|p| p[0])
            .fold(f64::MIN, f64::max);
        assert!((top_x - (10.0 - t)).abs() < 1e-9);
        let sym = ExtrudeSpec {
            extent: Extent::Symmetric,
            ..taper
        };
        let r = extrude(
            &frame,
            &Shape::Circle { diameter_mm: 8.0 },
            &Placement::default(),
            None,
            &sym,
            None,
        )
        .unwrap();
        assert!(r.report.watertight && r.report.shells == 1);
        let text = Shape::Text {
            text: "SX 42".into(),
            size_mm: 8.0,
            letter_spacing_mm: 0.0,
            line_spacing: None,
            align: outline::Align::Center,
        };
        let r = extrude(
            &frame,
            &text,
            &Placement::default(),
            None,
            &ExtrudeSpec {
                distance_mm: 1.5,
                ..ExtrudeSpec::default()
            },
            None,
        )
        .unwrap();
        assert!(r.report.watertight && r.report.shells >= 4);
        assert!(extrude(&frame, &text, &Placement::default(), None, &taper, None).is_err());
        assert!(
            extrude(
                &frame,
                &rr,
                &Placement::default(),
                None,
                &ExtrudeSpec {
                    distance_mm: 0.0,
                    ..ExtrudeSpec::default()
                },
                None
            )
            .is_err()
        );
        let steep = ExtrudeSpec {
            distance_mm: 40.0,
            taper_deg: 30.0,
            ..ExtrudeSpec::default()
        };
        assert!(extrude(&frame, &rr, &Placement::default(), None, &steep, None).is_err());
    }

    #[test]
    fn svg_outline_on_a_face() {
        let art = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <path fill-rule="evenodd" d="M0 0H100V100H0Z M20 20V80H80V20Z"/>
            <circle cx="50" cy="50" r="10" fill="#ff0000"/></svg>"##;
        let shape = Shape::Svg {
            svg: art.to_owned(),
            width_mm: 20.0,
            tolerance_mm: None,
        };
        let at = Placement {
            center: [0.0, 0.0],
            rotation_deg: 0.0,
        };
        let polys = profile(&shape, &at, None).unwrap();
        assert_eq!(polys.len(), 2, "{polys:?}");
        let (lo, hi) =
            polys
                .iter()
                .flat_map(|p| p.outer.iter())
                .fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), p| {
                    (
                        [lo[0].min(p[0]), lo[1].min(p[1])],
                        [hi[0].max(p[0]), hi[1].max(p[1])],
                    )
                });
        assert!((hi[0] - lo[0] - 20.0).abs() < 1e-6 && (lo[0] + 10.0).abs() < 1e-6);
        let area: f64 = polys.iter().map(Polygon::area).sum();
        let expect = 400.0 - 144.0 + PI * 4.0;
        assert!((area - expect).abs() < 0.25, "{area}");
        let m = build::box_mesh([0.0; 3], [40.0, 40.0, 5.0]);
        let p = top_pick(&m);
        let cut = ExtrudeSpec {
            distance_mm: 1.0,
            operation: Operation::Cut,
            ..ExtrudeSpec::default()
        };
        let r = extrude(&p.frame, &shape, &at, None, &cut, Some(&m)).unwrap();
        assert!(r.report.watertight && r.report.shells == 1);
        assert!((r.report.volume_change_mm3 + area).abs() < 1e-3, "{:?}", r.report);
        let raised = ExtrudeSpec {
            distance_mm: 1.0,
            operation: Operation::Join,
            taper_deg: 20.0,
            ..ExtrudeSpec::default()
        };
        let r = extrude(&p.frame, &shape, &at, None, &raised, Some(&m)).unwrap();
        assert!(r.report.watertight && r.report.volume_change_mm3 < expect);
        let empty = Shape::Svg {
            svg: "<svg/>".to_owned(),
            width_mm: 10.0,
            tolerance_mm: None,
        };
        assert!(profile(&empty, &at, None).is_err());
        let zero = Shape::Svg {
            svg: art.to_owned(),
            width_mm: 0.0,
            tolerance_mm: None,
        };
        assert!(
            profile(&zero, &at, None)
                .unwrap_err()
                .to_string()
                .contains("widthMm")
        );
    }
}
