// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sleipnir
// bin and layer indices are computed from clamped, non-negative floats that
// stay far below 2^52, and every access is bounded by the vector lengths
#![allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::mesh::TriMesh;
use crate::vec3;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LayerMode {
    Quality,
    Strength,
}

impl LayerMode {
    fn band(self) -> (f64, f64) {
        match self {
            Self::Quality => (0.2, 0.5),
            Self::Strength => (0.3, 0.5),
        }
    }
}

const GLOBAL_FLOOR: f64 = 0.2;
const GLOBAL_CEILING: f64 = 0.75;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LayerOptions {
    pub min_height_mm: Option<f64>,
    pub max_height_mm: Option<f64>,
    /// first layer height. it is never changed. defaults to 0.2 mm.
    pub first_layer_mm: f64,
    /// 0 to 100. how strongly the height profile is smoothed along Z: 0 keeps the raw demand, 100 follows the smoothed curve fully
    pub smoothing: f64,
    pub smoothing_radius_mm: Option<f64>,
    /// 0.05 to 1. largest relative change between neighboring layers.
    pub max_step_ratio: f64,
    pub z_step_mm: f64,
    pub base_height_mm: Option<f64>,
}

impl Default for LayerOptions {
    fn default() -> Self {
        Self {
            min_height_mm: None,
            max_height_mm: None,
            first_layer_mm: 0.2,
            smoothing: 70.0,
            smoothing_radius_mm: None,
            max_step_ratio: 0.25,
            z_step_mm: 0.01,
            base_height_mm: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerBounds {
    pub min_mm: f64,
    pub max_mm: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerZone {
    pub from_mm: f64,
    pub to_mm: f64,
    pub layers: usize,
    pub mean_height_mm: f64,
    pub class: &'static str,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMetrics {
    pub layer_count: usize,
    pub uniform_height_mm: f64,
    pub uniform_layer_count: usize,
    pub layers_vs_uniform: f64,
    pub mean_cusp_mm: f64,
    pub uniform_mean_cusp_mm: f64,
    pub max_cusp_mm: f64,
    pub uniform_max_cusp_mm: f64,
    pub step_change: StepChange,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepChange {
    pub mean: f64,
    pub max: f64,
    pub changes: usize,
    pub unsmoothed_mean: f64,
    pub unsmoothed_max: f64,
    pub unsmoothed_changes: usize,
    pub unsmoothed_layer_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerProfile {
    pub mode: LayerMode,
    pub layer_tops_mm: Vec<f64>,
    pub heights_mm: Vec<f64>,
    pub bounds: LayerBounds,
    pub overshoot_mm: f64,
    pub zones: Vec<LayerZone>,
    pub metrics: LayerMetrics,
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Reason {
    Wall = 0,
    Slope = 1,
    Overhang = 2,
    Top = 3,
}

impl Reason {
    fn label(self) -> &'static str {
        match self {
            Self::Wall => "wall",
            Self::Slope => "slope",
            Self::Overhang => "overhang",
            Self::Top => "top surface",
        }
    }
}

const FLAT_NZ: f64 = 0.98;
const OVERHANG_NZ: f64 = -0.05;

fn resolve_bounds(nozzle: f64, mode: LayerMode, o: &LayerOptions) -> LayerBounds {
    let (lo, hi) = mode.band();
    let mut min = (lo * nozzle).max(GLOBAL_FLOOR * nozzle);
    let mut max = (hi * nozzle).min(GLOBAL_CEILING * nozzle);
    if let Some(v) = o.min_height_mm.filter(|v| v.is_finite() && *v > 0.0) {
        min = min.max(v);
    }
    if let Some(v) = o.max_height_mm.filter(|v| v.is_finite() && *v > 0.0) {
        max = max.min(v);
    }
    if o.z_step_mm > 0.0 {
        // round inward so the bounds still hold after rounding
        let s = o.z_step_mm;
        min = (min / s - 1e-9).ceil() * s;
        max = ((max / s + 1e-9).floor() * s).max(min);
    }
    LayerBounds {
        min_mm: min,
        max_mm: max.max(min),
    }
}

fn check(nozzle: f64, o: &LayerOptions) -> Result<()> {
    if !nozzle.is_finite() || !(0.05..=2.0).contains(&nozzle) {
        return Err(Error::invalid("nozzleMm", "must be between 0.05 and 2 mm"));
    }
    if !o.first_layer_mm.is_finite() || o.first_layer_mm <= 0.0 || o.first_layer_mm > nozzle {
        return Err(Error::invalid(
            "firstLayerMm",
            "must be above 0 and at most the nozzle diameter",
        ));
    }
    if !(0.0..=100.0).contains(&o.smoothing) {
        return Err(Error::invalid("smoothing", "must be between 0 and 100"));
    }
    if o.smoothing_radius_mm.is_some_and(|r| !(0.0..=20.0).contains(&r)) {
        return Err(Error::invalid("smoothingRadiusMm", "must be between 0 and 20 mm"));
    }
    if !(0.05..=1.0).contains(&o.max_step_ratio) {
        return Err(Error::invalid("maxStepRatio", "must be between 0.05 and 1"));
    }
    if !o.z_step_mm.is_finite() || o.z_step_mm < 0.0 || o.z_step_mm > 0.2 {
        return Err(Error::invalid("zStepMm", "must be between 0 and 0.2 mm"));
    }
    Ok(())
}

struct Facet {
    z0: f64,
    z1: f64,
    nz: f64,
    area: f64,
}

fn facets(mesh: &TriMesh) -> Vec<Facet> {
    mesh.triangles
        .iter()
        .filter_map(|&t| {
            let [a, b, c] = mesh.corners(t);
            let n = vec3::tri_normal(a, b, c);
            let l = vec3::len(n);
            if l < 1e-12 {
                return None;
            }
            Some(Facet {
                z0: a[2].min(b[2]).min(c[2]),
                z1: a[2].max(b[2]).max(c[2]),
                nz: n[2] / l,
                area: l * 0.5,
            })
        })
        .collect()
}

#[derive(Clone)]
struct Demand {
    dz: f64,
    d: Vec<f64>,
    why: Vec<Reason>,
}

impl Demand {
    fn bin(&self, z: f64) -> usize {
        ((z / self.dz).floor().max(0.0) as usize).min(self.d.len().saturating_sub(1))
    }

    fn mark(&mut self, z0: f64, z1: f64, h: f64, why: Reason) {
        let a = self.bin(z0);
        let b = if z1 > z0 {
            (((z1 / self.dz).ceil() as usize).saturating_sub(1)).clamp(a, self.d.len() - 1)
        } else {
            a
        };
        for i in a..=b {
            if h < self.d[i] {
                self.d[i] = h;
                self.why[i] = why;
            }
        }
    }

    fn min_over(&self, z0: f64, z1: f64) -> f64 {
        let a = self.bin(z0);
        let b = (((z1 / self.dz).ceil() as usize).saturating_sub(1)).clamp(a, self.d.len() - 1);
        self.d[a..=b].iter().fold(f64::INFINITY, |m, &v| m.min(v))
    }
}

fn build_demand(facets: &[Facet], mode: LayerMode, bounds: LayerBounds, top_z: f64, z_step: f64) -> Demand {
    let (hmin, hmax) = (bounds.min_mm, bounds.max_mm);
    let dz = (hmin / 4.0).max(z_step / 2.0).max(0.005);
    let bins = ((top_z / dz).ceil() as usize + 2).max(2);
    let mut dem = Demand {
        dz,
        d: vec![hmax; bins],
        why: vec![Reason::Wall; bins],
    };
    let band = 2.0 * hmin;
    for f in facets {
        if f.z1 <= 1e-6 {
            continue;
        }
        let a = f.nz.abs();
        let down = f.nz < OVERHANG_NZ;
        let thin_ok = match mode {
            LayerMode::Quality => true,
            LayerMode::Strength => down,
        };
        if !thin_ok || a < 1e-6 {
            continue;
        }
        let h = (hmin / a).min(hmax);
        if h >= hmax {
            continue;
        }
        let why = if down {
            Reason::Overhang
        } else if a >= FLAT_NZ {
            Reason::Top
        } else {
            Reason::Slope
        };
        let z0 = if why == Reason::Top {
            (f.z0 - band).max(0.0)
        } else {
            f.z0
        };
        dem.mark(z0, f.z1, h, why);
    }
    dem
}

fn smooth(dem: &mut Demand, strength: f64, radius_mm: f64, max_step_ratio: f64, span_mm: f64) {
    let n = dem.d.len();
    let sigma = radius_mm / 2.0 / dem.dz;
    if strength > 0.0 && sigma >= 0.5 && n > 1 {
        let reach = (3.0 * sigma).ceil() as usize;
        let kernel: Vec<f64> = (0..=reach)
            .map(|k| (-0.5 * (k as f64 / sigma).m_powi(2)).m_exp())
            .collect();
        let orig = dem.d.clone();
        for (i, &o) in orig.iter().enumerate() {
            let lo = i.saturating_sub(reach);
            let hi = (i + reach + 1).min(n);
            let (mut sum, mut wsum) = (0.0, 0.0);
            for (j, &v) in orig.iter().enumerate().take(hi).skip(lo) {
                let w = kernel[i.abs_diff(j)];
                sum += w * v;
                wsum += w;
            }
            let blur = sum / wsum;
            dem.d[i] = o + strength * (blur - o).min(0.0);
        }
    }
    // Lipschitz in Z: at most `ratio` taller than the layer below per mm of height
    let ramp = if radius_mm > 0.0 {
        (span_mm / radius_mm).min(max_step_ratio)
    } else {
        max_step_ratio
    };
    let step = (max_step_ratio + strength * (ramp - max_step_ratio)) * dem.dz;
    for i in 1..n {
        dem.d[i] = dem.d[i].min(dem.d[i - 1] + step);
    }
    for i in (0..n.saturating_sub(1)).rev() {
        dem.d[i] = dem.d[i].min(dem.d[i + 1] + step);
    }
}

fn step_change(tops: &[f64], plain: &[f64], z_step: f64) -> StepChange {
    let stats = |t: &[f64]| {
        let h = heights(t);
        let tol = z_step.max(1e-6) * 0.5;
        let (mut sum, mut max, mut changes) = (0.0, 0.0_f64, 0usize);
        for w in h.get(1..).unwrap_or(&[]).windows(2) {
            let r = (w[1] / w[0] - 1.0).abs();
            sum += r;
            max = max.max(r);
            changes += usize::from((w[1] - w[0]).abs() > tol);
        }
        let n = h.len().saturating_sub(2).max(1);
        (sum / n as f64, max, changes)
    };
    let (mean, max, changes) = stats(tops);
    let (unsmoothed_mean, unsmoothed_max, unsmoothed_changes) = stats(plain);
    StepChange {
        mean,
        max,
        changes,
        unsmoothed_mean,
        unsmoothed_max,
        unsmoothed_changes,
        unsmoothed_layer_count: plain.len(),
    }
}

fn quantize_down(h: f64, step: f64) -> f64 {
    if step > 0.0 {
        (h / step + 1e-9).floor() * step
    } else {
        h
    }
}

fn march(dem: &Demand, top_z: f64, bounds: LayerBounds, o: &LayerOptions) -> Vec<f64> {
    let (hmin, hmax) = (bounds.min_mm, bounds.max_mm);
    let mut tops = vec![o.first_layer_mm];
    let mut z = o.first_layer_mm;
    let mut prev = o.first_layer_mm.clamp(hmin, hmax);
    while tops.len() < 200_000 {
        let mut h = hmax;
        for _ in 0..4 {
            let want = dem.min_over(z, z + h).max(hmin);
            if want >= h {
                break;
            }
            h = want;
        }
        h = quantize_down(h, o.z_step_mm)
            .min(quantize_down(prev * (1.0 + o.max_step_ratio), o.z_step_mm))
            .clamp(hmin, hmax);
        if z + h * 0.5 >= top_z {
            break;
        }
        z += h;
        prev = h;
        tops.push(z);
    }
    reach_top(&mut tops, top_z, bounds, o.z_step_mm);
    tops
}

/// Ends the plan exactly on the model's top: a layer marched past it is dropped, what is left goes to the layers
/// below while they stay within the bounds, and the rest becomes the last layer without leaving a sliver
/// (see [`finish_top`]). The first layer is never changed.
fn reach_top(tops: &mut Vec<f64>, top_z: f64, bounds: LayerBounds, step: f64) {
    while tops.len() > 1 && tops.last().is_some_and(|&t| t > top_z + 1e-9) {
        tops.pop();
    }
    let Some(&last) = tops.last() else { return };
    let mut short = top_z - last;
    if short <= 1e-9 {
        if tops.len() > 1
            && let Some(t) = tops.last_mut()
        {
            *t = top_z;
        }
        return;
    }
    let mut hs = heights(tops);
    let unit = if step > 0.0 { step } else { short / 8.0 };
    let mut grew = true;
    while short > 1e-9 && grew {
        grew = false;
        for h in hs.iter_mut().skip(1).rev() {
            if short <= 1e-9 {
                break;
            }
            let add = unit.min(short);
            if *h + add <= bounds.max_mm + 1e-9 {
                *h += add;
                short -= add;
                grew = true;
            }
        }
    }
    let mut z = 0.0;
    for (t, h) in tops.iter_mut().zip(&hs) {
        z += h;
        *t = z;
    }
    if short > 1e-9 {
        finish_top(tops, short, top_z, bounds);
    } else if tops.len() > 1
        && let Some(t) = tops.last_mut()
    {
        *t = top_z;
    }
}

/// The last `short` mm up to `top_z`. A remainder of at least about three quarters of the layer below (and the
/// least height) is its own layer. A thinner one is folded into the layer below when that stays within the
/// greatest height; otherwise the last two layers share the height evenly.
fn finish_top(tops: &mut Vec<f64>, short: f64, top_z: f64, bounds: LayerBounds) {
    let n = tops.len();
    let below = if n > 1 { tops[n - 2] } else { 0.0 };
    let h_last = tops[n - 1] - below;
    if n == 1 || short >= (0.75 * h_last).max(bounds.min_mm) - 1e-9 {
        tops.push(top_z);
    } else if h_last + short <= bounds.max_mm + 1e-9 {
        tops[n - 1] = top_z;
    } else {
        let half = (top_z - below) / 2.0;
        if half >= bounds.min_mm - 1e-9 {
            tops[n - 1] = below + half;
            tops.push(top_z);
        } else {
            tops[n - 1] = top_z;
        }
    }
}

fn heights(tops: &[f64]) -> Vec<f64> {
    let mut prev = 0.0;
    tops.iter()
        .map(|&t| {
            let h = t - prev;
            prev = t;
            h
        })
        .collect()
}

fn cusp(facets: &[Facet], tops: &[f64]) -> (f64, f64) {
    let (mut sum, mut area, mut worst) = (0.0, 0.0, 0.0_f64);
    for f in facets {
        let mid = f64::midpoint(f.z0, f.z1);
        let i = tops.partition_point(|&t| t <= mid).min(tops.len() - 1);
        let below = if i == 0 { 0.0 } else { tops[i - 1] };
        let c = (tops[i] - below) * f.nz.abs();
        sum += c * f.area;
        area += f.area;
        worst = worst.max(c);
    }
    (if area > 0.0 { sum / area } else { 0.0 }, worst)
}

fn uniform_tops(first: f64, h: f64, top_z: f64) -> Vec<f64> {
    let mut tops = vec![first];
    let mut z = first;
    while z + h * 0.5 < top_z && tops.len() < 200_000 {
        z += h;
        tops.push(z);
    }
    tops
}

fn zones(dem: &Demand, tops: &[f64], bounds: LayerBounds) -> Vec<LayerZone> {
    let span = (bounds.max_mm - bounds.min_mm).max(1e-9);
    let class = |h: f64| {
        let t = (h - bounds.min_mm) / span;
        if t <= 0.25 {
            "thin"
        } else if t >= 0.75 {
            "thick"
        } else {
            "mid"
        }
    };
    let mut out: Vec<LayerZone> = Vec::new();
    let mut from = 0.0;
    let mut acc: Option<(&'static str, f64, f64, usize)> = None; // class, from, sum, n
    let mut flush = |acc: &mut Option<(&'static str, f64, f64, usize)>, to: f64| {
        if let Some((c, a, sum, n)) = acc.take() {
            let reason = zone_reason(dem, a, to, c, bounds);
            out.push(LayerZone {
                from_mm: a,
                to_mm: to,
                layers: n,
                mean_height_mm: sum / n as f64,
                class: c,
                reason,
            });
        }
    };
    for (i, &t) in tops.iter().enumerate() {
        let h = t - from;
        let c = class(h);
        if i == 0 {
            from = t;
            continue;
        }
        match &mut acc {
            Some((ac, _, sum, n)) if *ac == c => {
                *sum += h;
                *n += 1;
            }
            _ => {
                flush(&mut acc, from);
                acc = Some((c, from, h, 1));
            }
        }
        from = t;
    }
    flush(&mut acc, from);
    absorb_short_zones(out)
}

fn absorb_short_zones(zones: Vec<LayerZone>) -> Vec<LayerZone> {
    let mut out: Vec<LayerZone> = Vec::with_capacity(zones.len());
    for z in zones {
        match out.last_mut() {
            Some(prev) if z.layers < 3 => {
                let total = prev.layers + z.layers;
                prev.mean_height_mm = (prev.mean_height_mm * prev.layers as f64
                    + z.mean_height_mm * z.layers as f64)
                    / total as f64;
                prev.layers = total;
                prev.to_mm = z.to_mm;
            }
            _ => out.push(z),
        }
    }
    out
}

fn zone_reason(dem: &Demand, a: f64, b: f64, class: &str, bounds: LayerBounds) -> &'static str {
    if class == "thick" {
        return Reason::Wall.label();
    }
    let pad = bounds.max_mm;
    let lo = dem.bin((a - pad).max(0.0));
    let hi = dem.bin(b + pad);
    let mut best = (f64::INFINITY, Reason::Wall);
    for i in lo..=hi {
        if dem.d[i] < best.0 {
            best = (dem.d[i], dem.why[i]);
        }
    }
    if class == "mid" && best.1 == Reason::Wall {
        "transition"
    } else {
        best.1.label()
    }
}

pub fn plan_layers(
    mesh: &TriMesh,
    nozzle_mm: f64,
    mode: LayerMode,
    opts: &LayerOptions,
) -> Result<LayerProfile> {
    check(nozzle_mm, opts)?;
    let top_z = mesh
        .bounds()
        .map(|b| b.max[2])
        .filter(|z| *z > 0.0)
        .ok_or_else(|| Error::geometry("layers", "the mesh is empty or sits below the bed"))?;
    let bounds = resolve_bounds(nozzle_mm, mode, opts);
    let fs = facets(mesh);
    let mut dem = build_demand(&fs, mode, bounds, top_z, opts.z_step_mm);
    let raw = dem.clone();
    let radius = opts
        .smoothing_radius_mm
        .filter(|r| *r > 0.0)
        .unwrap_or(8.0 * bounds.max_mm);
    let plain = {
        let mut d = raw.clone();
        smooth(&mut d, 0.0, 0.0, opts.max_step_ratio, 0.0);
        march(&d, top_z, bounds, opts)
    };
    smooth(
        &mut dem,
        opts.smoothing / 100.0,
        radius,
        opts.max_step_ratio,
        bounds.max_mm - bounds.min_mm,
    );
    let tops = march(&dem, top_z, bounds, opts);
    let hs = heights(&tops);
    let uniform_h = opts
        .base_height_mm
        .filter(|h| h.is_finite() && *h > 0.0)
        .unwrap_or(f64::midpoint(bounds.min_mm, bounds.max_mm));
    let uniform = uniform_tops(opts.first_layer_mm, uniform_h, top_z);
    let (mean, max) = cusp(&fs, &tops);
    let (u_mean, u_max) = cusp(&fs, &uniform);
    let last = tops.last().copied().unwrap_or(0.0);
    Ok(LayerProfile {
        mode,
        zones: zones(&raw, &tops, bounds),
        metrics: LayerMetrics {
            layer_count: tops.len(),
            uniform_height_mm: uniform_h,
            uniform_layer_count: uniform.len(),
            layers_vs_uniform: tops.len() as f64 / uniform.len() as f64,
            mean_cusp_mm: mean,
            uniform_mean_cusp_mm: u_mean,
            max_cusp_mm: max,
            uniform_max_cusp_mm: u_max,
            step_change: step_change(&tops, &plain, opts.z_step_mm),
        },
        layer_tops_mm: tops,
        heights_mm: hs,
        bounds,
        overshoot_mm: last - top_z,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;

    fn sphere() -> TriMesh {
        build::uv_sphere([0.0, 0.0, 15.0], 15.0, 60, 100)
    }

    fn cone(r: f64, h: f64, n: usize) -> TriMesh {
        let mut m = TriMesh::default();
        let ring = |i: usize| {
            let t = std::f64::consts::TAU * i as f64 / n as f64;
            [r * t.m_cos(), r * t.m_sin(), 0.0]
        };
        for i in 0..n {
            let (a, b) = (ring(i), ring(i + 1));
            m.push_triangle(a, b, [0.0, 0.0, h]);
            m.push_triangle([0.0, 0.0, 0.0], b, a);
        }
        m
    }

    fn opts() -> LayerOptions {
        LayerOptions::default()
    }

    fn assert_within(p: &LayerProfile) {
        let eps = 1e-6;
        for (i, &h) in p.heights_mm.iter().enumerate().skip(1) {
            assert!(
                h >= p.bounds.min_mm - eps && h <= p.bounds.max_mm + eps,
                "layer {i} height {h} outside {:?}",
                p.bounds
            );
        }
    }

    #[test]
    fn bounds_follow_mode_and_nozzle() {
        let q = resolve_bounds(0.4, LayerMode::Quality, &opts());
        assert!((q.min_mm - 0.08).abs() < 1e-9 && (q.max_mm - 0.2).abs() < 1e-9);
        let s = resolve_bounds(0.4, LayerMode::Strength, &opts());
        assert!((s.min_mm - 0.12).abs() < 1e-9 && (s.max_mm - 0.2).abs() < 1e-9);
        let o = LayerOptions {
            min_height_mm: Some(0.1),
            max_height_mm: Some(0.16),
            ..opts()
        };
        let t = resolve_bounds(0.4, LayerMode::Quality, &o);
        assert!((t.min_mm - 0.1).abs() < 1e-9 && (t.max_mm - 0.16).abs() < 1e-9);
        let o = LayerOptions {
            min_height_mm: Some(0.3),
            ..opts()
        };
        let c = resolve_bounds(0.4, LayerMode::Quality, &o);
        assert!(c.min_mm <= c.max_mm);
    }

    #[test]
    fn sphere_is_thin_at_the_poles_and_thick_at_the_equator() {
        let p = plan_layers(&sphere(), 0.4, LayerMode::Quality, &opts()).unwrap();
        assert_within(&p);
        let h_at = |z: f64| {
            let i = p.layer_tops_mm.partition_point(|&t| t < z);
            p.heights_mm[i.min(p.heights_mm.len() - 1)]
        };
        let (pole, equator) = (h_at(29.0), h_at(15.0));
        assert!(pole < 0.11, "pole {pole}");
        assert!(equator > 0.17, "equator {equator}");
        assert!(p.metrics.mean_cusp_mm < p.metrics.uniform_mean_cusp_mm);
        assert!(p.zones.iter().any(|z| z.class == "thin"));
        assert!(p.zones.iter().any(|z| z.class == "thick" && z.reason == "wall"));
    }

    #[test]
    fn cone_gets_one_height_along_its_slope() {
        let p = plan_layers(&cone(10.0, 17.3, 90), 0.4, LayerMode::Quality, &opts()).unwrap();
        assert_within(&p);
        let mid: Vec<f64> = p.heights_mm[10..p.heights_mm.len() - 10].to_vec();
        let lo = mid.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = mid.iter().copied().fold(0.0, f64::max);
        assert!(hi - lo < 0.02, "{lo}..{hi}");
        assert!(lo < 0.2 && lo >= p.bounds.min_mm);
    }

    #[test]
    fn straight_box_stays_thick_and_first_layer_is_kept() {
        let b = build::box_mesh([0.0; 3], [20.0, 20.0, 30.0]);
        let p = plan_layers(&b, 0.4, LayerMode::Quality, &opts()).unwrap();
        assert!((p.layer_tops_mm[0] - 0.2).abs() < 1e-12);
        let mid = &p.heights_mm[4..p.heights_mm.len() - 26];
        assert!(mid.iter().all(|&h| (h - 0.2).abs() < 1e-9), "{mid:?}");
        assert!(*p.heights_mm.last().unwrap() < 0.2);
        assert!(p.overshoot_mm == 0.0, "{}", p.overshoot_mm);
    }

    #[test]
    fn strength_stays_in_band_and_thins_only_under_overhangs() {
        let s = plan_layers(&sphere(), 0.4, LayerMode::Strength, &opts()).unwrap();
        assert_within(&s);
        assert!(s.bounds.min_mm >= 0.12 - 1e-9 && s.bounds.max_mm <= 0.2 + 1e-9);
        let n = s.heights_mm.len();
        let top = &s.heights_mm[n - 21..n - 1];
        assert!(top.iter().all(|&h| h > 0.19), "{top:?}");
        assert!(s.heights_mm[1..20].iter().any(|&h| h < 0.15));
    }

    #[test]
    fn heights_change_gradually_and_align_to_the_z_step() {
        let o = LayerOptions {
            z_step_mm: 0.04,
            max_step_ratio: 0.3,
            ..opts()
        };
        let p = plan_layers(&sphere(), 0.8, LayerMode::Quality, &o).unwrap();
        assert_within(&p);
        for &h in &p.heights_mm[1..] {
            let steps = h / 0.04;
            assert!((steps - steps.round()).abs() < 1e-6, "{h}");
        }
        for w in p.heights_mm[1..].windows(2) {
            let (a, b) = (w[0], w[1]);
            assert!(b <= a * 1.3 + 1e-9, "{a} then {b}");
            assert!(a <= b * 1.3 + 0.04 + 1e-9, "{a} then {b}");
        }
    }

    #[test]
    fn every_plan_reaches_the_model_top() {
        for h in [7.3, 10.0, 10.05, 12.34, 29.99, 30.0] {
            for step in [0.0, 0.01, 0.04] {
                let b = build::box_mesh([0.0; 3], [10.0, 10.0, h]);
                let o = LayerOptions {
                    z_step_mm: step,
                    ..opts()
                };
                for mode in [LayerMode::Quality, LayerMode::Strength] {
                    let p = plan_layers(&b, 0.4, mode, &o).unwrap();
                    let top = *p.layer_tops_mm.last().unwrap();
                    assert!(top.to_bits() == h.to_bits(), "h {h} step {step}: top {top}");
                    assert!(p.overshoot_mm == 0.0, "h {h} step {step}: {}", p.overshoot_mm);
                    assert_within(&p);
                }
            }
        }
    }

    #[test]
    fn smoothing_softens_transitions_and_keeps_the_rules() {
        let m = build::box_mesh([0.0; 3], [20.0, 20.0, 30.0]);
        let smooth = plan_layers(&m, 0.4, LayerMode::Quality, &opts()).unwrap();
        let sc = &smooth.metrics.step_change;
        assert!(sc.max < 0.8 * sc.unsmoothed_max, "{sc:?}");
        let dome = plan_layers(&sphere(), 0.4, LayerMode::Quality, &opts()).unwrap();
        let dc = &dome.metrics.step_change;
        assert!(dc.max <= dc.unsmoothed_max + 1e-12, "{dc:?}");
        assert_within(&smooth);
        assert!((smooth.layer_tops_mm[0] - 0.2).abs() < 1e-12);
        let off = LayerOptions {
            smoothing: 0.0,
            ..opts()
        };
        let raw = plan_layers(&m, 0.4, LayerMode::Quality, &off).unwrap();
        assert_eq!(raw.layer_tops_mm.len(), sc.unsmoothed_layer_count);
        assert!((raw.metrics.step_change.max - sc.unsmoothed_max).abs() < 1e-12);
        let thinnest = |p: &LayerProfile| p.heights_mm[1..].iter().copied().fold(f64::INFINITY, f64::min);
        assert!((thinnest(&smooth) - thinnest(&raw)).abs() < 0.011);
        let wide = LayerOptions {
            smoothing_radius_mm: Some(4.0),
            ..opts()
        };
        let w = plan_layers(&m, 0.4, LayerMode::Quality, &wide).unwrap();
        assert!(
            w.metrics.step_change.max <= sc.max + 1e-9,
            "{:?} vs {sc:?}",
            w.metrics.step_change
        );
        assert_within(&w);
        // 0 means automatic, as in the settings schema
        let zero = LayerOptions {
            smoothing_radius_mm: Some(0.0),
            ..opts()
        };
        let z = plan_layers(&m, 0.4, LayerMode::Quality, &zero).unwrap();
        assert_eq!(z.layer_tops_mm, smooth.layer_tops_mm);
        let bad = LayerOptions {
            smoothing_radius_mm: Some(-1.0),
            ..opts()
        };
        assert!(plan_layers(&m, 0.4, LayerMode::Quality, &bad).is_err());
    }

    #[test]
    fn saves_layers_against_thin_uniform_and_beats_thick_on_cusp() {
        let p = plan_layers(&sphere(), 0.4, LayerMode::Quality, &opts()).unwrap();
        let m = &p.metrics;
        assert!(m.layer_count < m.uniform_layer_count * 2);
        assert!(m.mean_cusp_mm < m.uniform_mean_cusp_mm);
        assert!(m.max_cusp_mm <= m.uniform_max_cusp_mm + 1e-9);
    }

    #[test]
    fn rejects_bad_input() {
        let s = sphere();
        assert!(plan_layers(&s, 0.0, LayerMode::Quality, &opts()).is_err());
        assert!(plan_layers(&TriMesh::default(), 0.4, LayerMode::Quality, &opts()).is_err());
        let o = LayerOptions {
            max_step_ratio: 2.0,
            ..opts()
        };
        assert!(plan_layers(&s, 0.4, LayerMode::Quality, &o).is_err());
    }
}
