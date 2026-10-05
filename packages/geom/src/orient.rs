// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! orientation analysis
// cell and triangle indices are computed from grid sizes and mesh lengths
// that are clamped in this module
#![allow(clippy::indexing_slicing)]
#![allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]

use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::vec3::{self, V3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

type Matrix3 = [[f64; 3]; 3];

const IDENTITY: Matrix3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Orientation {
    Matrix {
        matrix: Matrix3,
    },
    Down {
        down: V3,
    },
    /// Euler angles in degrees about the world X, Y and Z axes, applied in that order
    #[serde(rename_all = "camelCase")]
    Euler {
        euler_deg: V3,
    },
}

impl Orientation {
    pub fn to_matrix(&self) -> Matrix3 {
        match *self {
            Self::Matrix { matrix } => matrix,
            Self::Down { down } => down_matrix(down),
            Self::Euler { euler_deg } => {
                let [rx, ry, rz] = euler_deg.map(f64::to_radians);
                let (sx, cx) = rx.m_sin_cos();
                let (sy, cy) = ry.m_sin_cos();
                let (sz, cz) = rz.m_sin_cos();
                let mx = [[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]];
                let my = [[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]];
                let mz = [[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]];
                mat_mul(mz, mat_mul(my, mx))
            }
        }
    }
}

fn mat_mul(a: Matrix3, b: Matrix3) -> Matrix3 {
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    r
}

fn mat_apply(m: &Matrix3, p: V3) -> V3 {
    [vec3::dot(m[0], p), vec3::dot(m[1], p), vec3::dot(m[2], p)]
}

fn down_matrix(down: V3) -> Matrix3 {
    let Some(d) = vec3::normalize(down) else {
        return IDENTITY;
    };
    let target = [0.0, 0.0, -1.0];
    let c = vec3::dot(d, target);
    if c > 1.0 - 1e-12 {
        return IDENTITY;
    }
    if c < -1.0 + 1e-12 {
        return [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];
    }
    let v = vec3::cross(d, target);
    let k = 1.0 / (1.0 + c);
    [
        [
            1.0 - k * (v[1] * v[1] + v[2] * v[2]),
            -v[2] + k * v[0] * v[1],
            v[1] + k * v[0] * v[2],
        ],
        [
            v[2] + k * v[0] * v[1],
            1.0 - k * (v[0] * v[0] + v[2] * v[2]),
            -v[0] + k * v[1] * v[2],
        ],
        [
            -v[1] + k * v[0] * v[2],
            v[0] + k * v[1] * v[2],
            1.0 - k * (v[0] * v[0] + v[1] * v[1]),
        ],
    ]
}

/// how [`OrientReport::score`] combines the measurements. each term is made
/// dimensionless first, so weights compare across models of any size:
///
/// ```text
/// score = support_volume * (support volume / model volume)
///       + overhang_area  * (overhang area / surface area)
///       + height         * (height / model size)
///       - bed_contact    * (contact area / footprint area)
///       + tiny_contact_penalty   when contact < 1 percent of the footprint
/// ```
///
/// where model size is the diameter of the smallest sphere around the
/// vertex centroid that holds the part, and footprint is the XY bounding
/// rectangle. lower scores are better.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScoreWeights {
    /// weight of support volume relative to model volume. default 1.0.
    pub support_volume: f64,
    /// weight of overhang area relative to surface area. default 0.5.
    pub overhang_area: f64,
    /// weight of height relative to model size, a print time proxy. default 0.3.
    pub height: f64,
    /// bonus for bed contact relative to footprint. default 0.3.
    pub bed_contact: f64,
    /// added when contact is under 1 percent of the footprint, because the part would tip or detach
    pub tiny_contact_penalty: f64,
}

impl Default for ScoreWeights {
    fn default() -> Self {
        Self {
            support_volume: 1.0,
            overhang_area: 0.5,
            height: 0.3,
            bed_contact: 0.3,
            tiny_contact_penalty: 3.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OrientOptions {
    /// overhang threshold in degrees from vertical (see the module docs)
    pub overhang_angle_deg: f64,
    pub grid_mm: Option<f64>,
    /// faces whose vertices are all within this height of the bed count as bed contact and never as overhangs
    pub bed_contact_tolerance_mm: f64,
    pub weights: ScoreWeights,
}

impl Default for OrientOptions {
    fn default() -> Self {
        Self {
            overhang_angle_deg: 45.0,
            grid_mm: None,
            bed_contact_tolerance_mm: 0.05,
            weights: ScoreWeights::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OrientReport {
    pub matrix: Matrix3,
    /// surface area of faces steeper than the overhang angle, in mm^2
    pub overhang_area_mm2: f64,
    pub support_volume_mm3: f64,
    pub support_contact_area_mm2: f64,
    /// area of down-facing faces within the tolerance of the bed, in mm^2
    pub bed_contact_area_mm2: f64,
    pub height_mm: f64,
    pub footprint_mm: [f64; 2],
    pub score: f64,
}

impl Default for OrientReport {
    fn default() -> Self {
        Self {
            matrix: IDENTITY,
            overhang_area_mm2: 0.0,
            support_volume_mm3: 0.0,
            support_contact_area_mm2: 0.0,
            bed_contact_area_mm2: 0.0,
            height_mm: 0.0,
            footprint_mm: [0.0; 2],
            score: 0.0,
        }
    }
}

pub fn analyze(mesh: &TriMesh, o: &Orientation, opts: &OrientOptions) -> OrientReport {
    let matrix = o.to_matrix();
    let mut report = OrientReport {
        matrix,
        ..OrientReport::default()
    };
    if mesh.triangles.is_empty() {
        return report;
    }
    let pos: Vec<V3> = mesh.positions.iter().map(|&p| mat_apply(&matrix, p)).collect();
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for &i in mesh.triangles.iter().flatten() {
        let p = pos[i as usize];
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let size = vec3::sub(hi, lo);
    report.height_mm = size[2];
    report.footprint_mm = [size[0], size[1]];
    let corner = |t: [u32; 3]| {
        t.map(|i| {
            let p = pos[i as usize];
            [p[0] - lo[0], p[1] - lo[1], p[2] - lo[2]]
        })
    };

    let sin_limit = opts.overhang_angle_deg.clamp(0.0, 90.0).to_radians().m_sin();
    let tol = opts.bed_contact_tolerance_mm.max(0.0);
    let long = size[0].max(size[1]);
    let cell = opts
        .grid_mm
        .filter(|g| g.is_finite() && *g > 0.0)
        .unwrap_or(long / 160.0)
        .max(long / 2048.0)
        .max(1e-6);
    let nx = ((size[0] / cell).ceil() as usize).max(1);
    let ny = ((size[1] / cell).ceil() as usize).max(1);

    let mut hits: Vec<(u32, f64, bool)> = Vec::with_capacity(mesh.triangles.len());
    let (mut total_area, mut model_volume) = (0.0, 0.0);
    let (off_x, off_y) = (0.5031, 0.4973);
    for &t in &mesh.triangles {
        let [a, b, c] = corner(t);
        let n = vec3::tri_normal(a, b, c);
        let twice_area = vec3::len(n);
        let area = twice_area * 0.5;
        total_area += area;
        model_volume += vec3::dot(a, vec3::cross(b, c)) / 6.0;
        if twice_area < 1e-18 {
            continue;
        }
        let nz = n[2] / twice_area;
        let max_z = a[2].max(b[2]).max(c[2]);
        let on_bed = max_z <= tol;
        let overhang = nz < 0.0 && -nz > sin_limit && !on_bed;
        if nz < 0.0 && on_bed {
            report.bed_contact_area_mm2 += area;
        }
        if overhang {
            report.overhang_area_mm2 += area;
            report.support_contact_area_mm2 += area * -nz;
        }
        if n[2].abs() < 1e-12 * twice_area {
            continue;
        }
        rasterize([a, b, c], n, (cell, nx, ny), (off_x, off_y), |idx, z| {
            hits.push((idx, z, overhang));
        });
    }

    hits.sort_unstable_by(|p, q| p.0.cmp(&q.0).then(p.1.total_cmp(&q.1)));
    let cell_area = cell * cell;
    let mut volume = 0.0;
    let mut prev: Option<(u32, f64)> = None;
    for &(idx, z, overhang) in &hits {
        let below = match prev {
            Some((pi, pz)) if pi == idx => pz,
            _ => 0.0,
        };
        if overhang {
            volume += (z - below).max(0.0) * cell_area;
        }
        prev = Some((idx, z));
    }
    report.support_volume_mm3 = volume;
    report.score = score(&report, total_area, model_volume, mesh, &pos, opts);
    report
}

fn rasterize(
    [a, b, c]: [V3; 3],
    n: V3,
    (cell, nx, ny): (f64, usize, usize),
    (off_x, off_y): (f64, f64),
    mut hit: impl FnMut(u32, f64),
) {
    let (min_x, max_x) = (a[0].min(b[0]).min(c[0]), a[0].max(b[0]).max(c[0]));
    let (min_y, max_y) = (a[1].min(b[1]).min(c[1]), a[1].max(b[1]).max(c[1]));
    let i0 = ((min_x / cell - off_x).ceil().max(0.0)) as usize;
    let j0 = ((min_y / cell - off_y).ceil().max(0.0)) as usize;
    let i1 = (((max_x / cell - off_x).floor()).max(-1.0) + 1.0) as usize;
    let j1 = (((max_y / cell - off_y).floor()).max(-1.0) + 1.0) as usize;
    let d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if d == 0.0 {
        return;
    }
    for j in j0..j1.min(ny) {
        let y = (j as f64 + off_y) * cell;
        for i in i0..i1.min(nx) {
            let x = (i as f64 + off_x) * cell;
            let w0 = ((b[0] - x) * (c[1] - y) - (b[1] - y) * (c[0] - x)) / d;
            let w1 = ((c[0] - x) * (a[1] - y) - (c[1] - y) * (a[0] - x)) / d;
            let w2 = 1.0 - w0 - w1;
            if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                continue;
            }
            let z = (n[0] * (a[0] - x) + n[1] * (a[1] - y)) / n[2] + a[2];
            hit((j * nx + i) as u32, z);
        }
    }
}

fn score(r: &OrientReport, area: f64, volume: f64, mesh: &TriMesh, pos: &[V3], opts: &OrientOptions) -> f64 {
    let w = &opts.weights;
    let (mut sum, mut count) = ([0.0; 3], 0.0f64);
    for &i in mesh.triangles.iter().flatten() {
        sum = vec3::add(sum, pos[i as usize]);
        count += 1.0;
    }
    let centroid = vec3::scale(sum, 1.0 / count.max(1.0));
    let radius = mesh
        .triangles
        .iter()
        .flatten()
        .map(|&i| vec3::len(vec3::sub(pos[i as usize], centroid)))
        .fold(0.0, f64::max);
    let size = (2.0 * radius).max(1e-9);
    let volume = if volume > 1e-9 {
        volume
    } else {
        (r.footprint_mm[0] * r.footprint_mm[1] * r.height_mm).max(1e-9)
    };
    let footprint = (r.footprint_mm[0] * r.footprint_mm[1]).max(1e-9);
    let contact = r.bed_contact_area_mm2 / footprint;
    let mut s = w.support_volume * r.support_volume_mm3 / volume
        + w.overhang_area * r.overhang_area_mm2 / area.max(1e-9)
        + w.height * r.height_mm / size
        - w.bed_contact * contact.min(1.0);
    if contact < 0.01 {
        s += w.tiny_contact_penalty;
    }
    s
}

pub fn candidates(mesh: &TriMesh, max: usize) -> Vec<Orientation> {
    let mut pool = flat_regions(mesh);
    pool.extend([
        [0.0, 0.0, -1.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [-1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, -1.0, 0.0],
    ]);
    let cos_same = 3.0f64.to_radians().m_cos();
    let mut out: Vec<V3> = Vec::new();
    for d in pool {
        if out.len() >= max {
            break;
        }
        if out.iter().all(|&e| vec3::dot(e, d) < cos_same) {
            out.push(d);
        }
    }
    out.into_iter().map(|down| Orientation::Down { down }).collect()
}

fn flat_regions(mesh: &TriMesh) -> Vec<V3> {
    struct Bucket {
        area: f64,
        best_area: f64,
        normal: V3,
    }
    let mut buckets: HashMap<[i32; 3], Bucket> = HashMap::new();
    let mut total = 0.0;
    for &t in &mesh.triangles {
        let [a, b, c] = mesh.corners(t);
        let n = vec3::tri_normal(a, b, c);
        let l = vec3::len(n);
        let area = l * 0.5;
        total += area;
        let Some(u) = vec3::normalize(n) else {
            continue;
        };
        let key = u.map(|x| (x * 20.0).round() as i32);
        let e = buckets.entry(key).or_insert(Bucket {
            area: 0.0,
            best_area: 0.0,
            normal: u,
        });
        e.area += area;
        if area > e.best_area {
            e.best_area = area;
            e.normal = u;
        }
    }
    let mut list: Vec<Bucket> = buckets
        .into_values()
        .filter(|b| b.area >= 0.005 * total)
        .collect();
    list.sort_by(|p, q| {
        q.area.total_cmp(&p.area).then(
            p.normal
                .partial_cmp(&q.normal)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    let cos_merge = 2.0f64.to_radians().m_cos();
    let mut merged: Vec<(V3, f64)> = Vec::new();
    for b in list {
        if let Some(m) = merged.iter_mut().find(|m| vec3::dot(m.0, b.normal) > cos_merge) {
            m.1 += b.area;
        } else {
            merged.push((b.normal, b.area));
        }
    }
    merged.sort_by(|p, q| q.1.total_cmp(&p.1));
    // a flat region needs about 2 percent of the surface to be worth a try
    merged
        .into_iter()
        .filter(|m| m.1 >= 0.02 * total)
        .map(|m| m.0)
        .collect()
}

pub fn rank(mesh: &TriMesh, opts: &OrientOptions, max_candidates: usize) -> Vec<OrientReport> {
    let mut reports: Vec<OrientReport> = candidates(mesh, max_candidates)
        .iter()
        .map(|o| analyze(mesh, o, opts))
        .collect();
    reports.sort_by(|a, b| a.score.total_cmp(&b.score));
    reports
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;
    use crate::poly2d::{self, Polygon};
    use crate::vec3::Frame;

    fn frustum() -> TriMesh {
        let poly = Polygon::simple(poly2d::circle([0.0, 0.0], 20.0, 48));
        build::loft(&[poly], &Frame::WORLD, 0.0, 10.0, |p, _| {
            [p[0] * 0.25, p[1] * 0.25]
        })
        .unwrap()
    }

    fn down(d: V3) -> Orientation {
        Orientation::Down { down: d }
    }

    #[test]
    fn frustum_on_its_base_needs_no_support() {
        let r = analyze(&frustum(), &down([0.0, 0.0, -1.0]), &OrientOptions::default());
        assert!(r.support_volume_mm3 < 1.0, "{r:?}");
        assert!(r.overhang_area_mm2 < 1e-9);
        let base = std::f64::consts::PI * 400.0;
        assert!(r.bed_contact_area_mm2 > 0.95 * base);
        assert!((r.height_mm - 10.0).abs() < 1e-9);
    }

    #[test]
    fn upside_down_frustum_needs_a_lot() {
        let m = frustum();
        let up = analyze(&m, &down([0.0, 0.0, 1.0]), &OrientOptions::default());
        let good = analyze(&m, &down([0.0, 0.0, -1.0]), &OrientOptions::default());
        assert!(up.support_volume_mm3 > 3000.0, "{up:?}");
        assert!(up.overhang_area_mm2 > 1000.0);
        assert!(up.score > good.score);
    }

    #[test]
    fn box_lies_flat_when_height_matters() {
        let b = build::box_mesh([0.0; 3], [10.0, 20.0, 40.0]);
        let opts = OrientOptions {
            weights: ScoreWeights {
                support_volume: 0.0,
                overhang_area: 0.0,
                height: 1.0,
                bed_contact: 0.0,
                tiny_contact_penalty: 0.0,
            },
            ..OrientOptions::default()
        };
        let ranked = rank(&b, &opts, 12);
        let best = &ranked[0];
        assert!((best.height_mm - 10.0).abs() < 1e-9, "{best:?}");
        assert!((best.bed_contact_area_mm2 - 800.0).abs() < 1e-6);
    }

    #[test]
    fn rank_is_sorted_and_deduplicated() {
        let m = frustum();
        let ranked = rank(&m, &OrientOptions::default(), 12);
        assert!(ranked.len() >= 3);
        assert!(ranked.windows(2).all(|w| w[0].score <= w[1].score));
        let c = candidates(&m, 12);
        assert!(c.len() <= 12);
        assert_eq!(candidates(&m, 2).len(), 2);
    }

    #[test]
    fn sphere_support_volume_is_within_analytic_bounds() {
        let r = 10.0;
        let s = build::uv_sphere([3.0, 4.0, 5.0], r, 40, 80);
        let rep = analyze(&s, &down([0.0, 0.0, -1.0]), &OrientOptions::default());
        let exact = 2.0 * std::f64::consts::PI * r.m_powi(3) * (0.25 + (0.5f64.m_powf(1.5) - 1.0) / 3.0);
        assert!(
            rep.support_volume_mm3 > 0.8 * exact,
            "{} vs {exact}",
            rep.support_volume_mm3
        );
        assert!(
            rep.support_volume_mm3 < 1.2 * exact,
            "{} vs {exact}",
            rep.support_volume_mm3
        );
        assert!((rep.height_mm - 2.0 * r).abs() < 1e-9);
        assert!(rep.score > 1.0);
    }

    #[test]
    fn orientation_json_forms() {
        let m: Orientation = serde_json::from_str(r#"{"matrix":[[1,0,0],[0,1,0],[0,0,1]]}"#).unwrap();
        assert_eq!(m.to_matrix(), IDENTITY);
        let d: Orientation = serde_json::from_str(r#"{"down":[0,1,0]}"#).unwrap();
        let p = mat_apply(&d.to_matrix(), [0.0, 1.0, 0.0]);
        assert!((p[2] + 1.0).abs() < 1e-12);
        let e: Orientation = serde_json::from_str(r#"{"eulerDeg":[90,0,0]}"#).unwrap();
        let p = mat_apply(&e.to_matrix(), [0.0, 1.0, 0.0]);
        assert!((p[2] - 1.0).abs() < 1e-12);
        let up = down([0.0, 0.0, 1.0]).to_matrix();
        assert!((mat_apply(&up, [0.0, 0.0, 1.0])[2] + 1.0).abs() < 1e-12);
        let v = serde_json::to_value(analyze(
            &build::box_mesh([0.0; 3], [1.0; 3]),
            &e,
            &OrientOptions::default(),
        ))
        .unwrap();
        assert!(v.get("supportVolumeMm3").is_some());
        assert!(v.get("footprintMm").is_some());
    }

    #[test]
    fn down_matrix_is_a_rotation() {
        for d in [[1.0, 2.0, 3.0], [0.0, 0.0, 1.0], [-1.0, 0.5, -0.2]] {
            let m = down_matrix(d);
            let n = vec3::normalize(d).unwrap();
            let p = mat_apply(&m, n);
            assert!((p[2] + 1.0).abs() < 1e-9);
            let det = vec3::dot(m[0], vec3::cross(m[1], m[2]));
            assert!((det - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    #[ignore = "timing, run with --release -- --ignored --nocapture"]
    fn timing_on_30k_torus() {
        let t = build::torus([0.0; 3], 20.0, 6.0, 150, 100);
        let start = std::time::Instant::now();
        let r = analyze(&t, &down([0.0, 0.0, -1.0]), &OrientOptions::default());
        println!("analyze 30k torus: {:?} {r:?}", start.elapsed());
        let start = std::time::Instant::now();
        let ranked = rank(&t, &OrientOptions::default(), 12);
        println!("rank {} candidates: {:?}", ranked.len(), start.elapsed());
    }
}
