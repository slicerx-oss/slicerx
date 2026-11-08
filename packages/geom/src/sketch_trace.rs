// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tracing an image into closed rings: a value per pixel, specks cleaned away, sub-pixel marching squares.
// inside regions are 8-connected and outside ones 4-connected, in the cleanup and in the ambiguous cells alike, so
// every ring is closed and simple and bounds exactly one region. rings are in working px with y up, the image
// spanning 0 to w and 0 to h: outer rings counterclockwise, holes clockwise.
// pixel and edge offsets are within the field, made from its own width and height
#![allow(clippy::indexing_slicing)]
// grid coordinates run one cell past each side, so they are signed; they stay far below 2^31
#![allow(
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_possible_truncation
)]

use crate::error::{Error, Result};
use crate::fm::Fm as _;
use crate::poly2d::{self, signed_area};
use crate::raster::{self, Raster};
use crate::sketch::{self, IssueKind, Loop, MAX_MM, SketchCheck};
use crate::sketch_fit::{self, Builder, Counts, MAX_SAMPLES};
use crate::sketch_spline;
use crate::vec3::V2;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// The working size's long side unless set.
pub const DEFAULT_SIDE: usize = 2048;
/// More rings than this are refused.
pub const MAX_LOOPS: usize = 2000;
/// Colors picked at once.
pub const MAX_COLORS: usize = 8;
/// keeps a crossing off the pixel centers, so two rings never share a point
const EPS: f32 = 1e-4;
/// The largest color tolerance; no two colors are much further apart.
pub const MAX_TOLERANCE: f64 = 100.0;
/// More crossings than this are refused, before any is kept.
// each crossing costs up to about 80 bytes while the rings are made (its map entry with the map's spare room, its
// start, its point), so 1 << 20 of them stay near 80 MB beside the 128 MB of a 4096 px field and its labels: within
// 250 MB. a 4096 px photo of fine detail had about 80000.
pub const MAX_CROSSINGS: usize = 1 << 20;
/// how far past the tolerance a color is fully outside
const COLOR_BAND: f32 = 12.0;
/// marks a region that touches the image edge, beside its pixel count
const EDGE: u32 = 1 << 31;

/// What counts as inside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Opaque areas when the image has transparency, else the dark side of an automatic threshold.
    #[default]
    Auto,
    Dark,
    Light,
    /// Pixels near a picked color.
    Color,
    /// Opaque areas.
    Alpha,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TraceOptions {
    pub mode: Mode,
    /// Luminance 0 to 255 for dark and light; none picks it from the histogram.
    pub threshold: Option<f64>,
    /// sRGB colors for the color mode.
    pub colors: Vec<[u8; 3]>,
    /// The color distance still inside, in perceptual units (a just visible difference is about 2).
    pub color_tolerance: f64,
    /// Inside regions with fewer pixels are dropped, and holes with fewer are filled (working px).
    pub speck_px: f64,
    /// The working size's long side.
    pub max_side_px: usize,
}

impl Default for TraceOptions {
    fn default() -> Self {
        Self {
            mode: Mode::Auto,
            threshold: None,
            colors: Vec::new(),
            color_tolerance: 12.0,
            speck_px: 0.0,
            max_side_px: DEFAULT_SIDE,
        }
    }
}

/// A value per pixel, rows from the bottom: inside where it is above zero.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub w: usize,
    pub h: usize,
    pub v: Vec<f32>,
}

/// Regions the cleanup took away.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Dropped {
    pub specks: usize,
    pub holes: usize,
}

/// An outer ring and the holes in it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shape {
    pub outer: Vec<V2>,
    pub holes: Vec<Vec<V2>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Traced {
    pub shapes: Vec<Shape>,
    pub image_px: [usize; 2],
    pub working_px: [usize; 2],
    pub dropped: Dropped,
    /// The mode used, auto resolved.
    pub mode: Mode,
    /// The luminance threshold used, for dark and light.
    pub threshold: Option<f64>,
}

/// Traces a PNG or JPEG file.
pub fn trace_bytes(bytes: &[u8], o: &TraceOptions) -> Result<Traced> {
    let r = raster::decode(bytes).map_err(|u| Error::invalid("image", format!("the file {}", u.why())))?;
    run(Cow::Owned(r), o)
}

/// Traces an image.
pub fn trace(r: &Raster, o: &TraceOptions) -> Result<Traced> {
    run(Cow::Borrowed(r), o)
}

fn run(r: Cow<'_, Raster>, o: &TraceOptions) -> Result<Traced> {
    stages(r, o, &|_| o.speck_px, 0).map(|(t, _)| t)
}

/// The trace with the speck size taken from the field, and the working image reduced to `preview` px kept when that
/// is above 0.
fn stages(
    r: Cow<'_, Raster>,
    o: &TraceOptions,
    speck: &dyn Fn(&Field) -> f64,
    preview: usize,
) -> Result<(Traced, Option<Raster>)> {
    if o.max_side_px == 0 || o.max_side_px > raster::MAX_SIDE {
        return Err(Error::invalid_arg(format!(
            "the working size is 1 to {} px",
            raster::MAX_SIDE
        )));
    }
    let image_px = [r.file_size.0, r.file_size.1];
    let work = if r.w.max(r.h) > o.max_side_px {
        let small = r.reduced(o.max_side_px);
        drop(r);
        Cow::Owned(small)
    } else {
        r
    };
    let working_px = [work.w, work.h];
    let (mut f, mode, threshold) = field(&work, o)?;
    let small = (preview > 0).then(|| work.reduced(preview));
    // an owned image is let go before the labels are made, so the two are never held at once
    drop(work);
    let speck_px = speck(&f);
    if !(speck_px >= 0.0 && speck_px.is_finite()) {
        return Err(Error::invalid_arg("the speck size is 0 or more"));
    }
    let dropped = despeckle(&mut f, speck_px);
    if !f.v.iter().any(|&v| v > 0.0) {
        return Err(nothing_inside(mode));
    }
    let shapes = contours(&f)?;
    let traced = Traced {
        shapes,
        image_px,
        working_px,
        dropped,
        mode,
        threshold,
    };
    Ok((traced, small))
}

/// The refusal of a trace with nothing inside, in the words of the setting to change for `mode`.
fn nothing_inside(mode: Mode) -> Error {
    Error::invalid(
        "image",
        if mode == Mode::Color {
            "nothing is near the picked colors; pick another color or raise the tolerance"
        } else {
            "nothing is inside; change what to trace or the threshold"
        },
    )
}

/// sRGB luminance, 0 to 255.
fn luma(p: [u8; 4]) -> f32 {
    0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])
}

/// The threshold that best splits a histogram in two (largest between-group variance), none for one value.
// the middle of a run of equal best splits, so a pure black and white image splits at 127
#[must_use]
pub fn otsu(hist: &[u64; 256]) -> Option<u8> {
    let n: u64 = hist.iter().sum();
    let total: f64 = hist.iter().enumerate().map(|(i, &c)| i as f64 * c as f64).sum();
    let (mut w0, mut sum0) = (0u64, 0f64);
    let (mut best, mut lo, mut hi) = (-1f64, None, 0usize);
    for (t, &c) in hist.iter().enumerate() {
        w0 += c;
        sum0 += t as f64 * c as f64;
        if w0 == 0 {
            continue;
        }
        let w1 = n - w0;
        if w1 == 0 {
            break;
        }
        let (a, b) = (w0 as f64, w1 as f64);
        let d = sum0 / a - (total - sum0) / b;
        let var = a * b * d * d;
        if var > best * (1.0 + 1e-12) {
            best = var;
            lo = Some(t);
            hi = t;
        } else if var >= best * (1.0 - 1e-12) {
            hi = t;
        }
    }
    lo.map(|lo| u8::try_from(usize::midpoint(lo, hi)).unwrap_or(u8::MAX))
}

/// `OKLab` of an sRGB color, times 100.
fn oklab(lut: &[f32; 256], p: [u8; 3]) -> [f32; 3] {
    let [r, g, b] = p.map(|c| f64::from(lut[usize::from(c)]));
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).m_cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).m_cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).m_cbrt();
    [
        0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
    ]
    .map(|v| (v * 100.0) as f32)
}

fn linear_lut() -> [f32; 256] {
    let mut t = [0f32; 256];
    for (i, v) in t.iter_mut().enumerate() {
        let c = i as f64 / 255.0;
        let lin = if c <= 0.040_45 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).m_powf(2.4)
        };
        *v = lin as f32;
    }
    t
}

/// The value per pixel for `o`, with the mode and threshold used.
pub fn field(r: &Raster, o: &TraceOptions) -> Result<(Field, Mode, Option<f64>)> {
    let clear = r.px.iter().any(|p| p[3] < 128);
    let mode = match o.mode {
        Mode::Auto if clear => Mode::Alpha,
        Mode::Auto => Mode::Dark,
        m => m,
    };
    let threshold = match mode {
        Mode::Dark | Mode::Light => Some(match o.threshold {
            Some(t) if (0.0..=255.0).contains(&t) => t,
            Some(_) => return Err(Error::invalid_arg("the threshold is 0 to 255")),
            None => {
                let mut hist = [0u64; 256];
                for p in r.px.iter().filter(|p| p[3] >= 128) {
                    hist[luma(*p).round() as usize & 255] += 1;
                }
                let t = otsu(&hist).ok_or_else(|| {
                    Error::invalid(
                        "image",
                        "the image is one flat tone, so there is nothing to trace",
                    )
                })?;
                f64::from(t)
            }
        }),
        _ => None,
    };
    let lut = linear_lut();
    let picks: Vec<[f32; 3]> = if mode == Mode::Color {
        if o.colors.is_empty() {
            return Err(Error::invalid_arg("pick a color to trace"));
        }
        if o.colors.len() > MAX_COLORS {
            return Err(Error::invalid_arg(format!("pick at most {MAX_COLORS} colors")));
        }
        if !(0.0..=MAX_TOLERANCE).contains(&o.color_tolerance) {
            return Err(Error::invalid_arg(format!(
                "the color tolerance is 0 to {MAX_TOLERANCE}"
            )));
        }
        o.colors.iter().map(|&c| oklab(&lut, c)).collect()
    } else {
        Vec::new()
    };
    let t = threshold.unwrap_or(0.0) as f32;
    let tol = o.color_tolerance as f32;
    // photos repeat colors, and three cube roots a pixel are most of the color mode's time
    let mut seen: FxHashMap<[u8; 3], f32> = FxHashMap::default();
    let mut value = |p: [u8; 4]| -> f32 {
        // in luminance units, so a hard edge against a clear pixel lands halfway at a middle threshold
        let alpha = (f32::from(p[3]) - 127.5) / 255.0;
        let v = match mode {
            Mode::Dark => (t + 0.5 - luma(p)) / 255.0,
            Mode::Light => (luma(p) - t - 0.5) / 255.0,
            Mode::Color => {
                let rgb = [p[0], p[1], p[2]];
                let near = || {
                    let c = oklab(&lut, rgb);
                    let d = picks
                        .iter()
                        .map(|k| {
                            let (a, b, e) = (c[0] - k[0], c[1] - k[1], c[2] - k[2]);
                            (a * a + b * b + e * e).sqrt()
                        })
                        .fold(f32::INFINITY, f32::min);
                    // inside up to the tolerance, the picked color itself at 0. a picked color and a far one sit at
                    // 0.5 and -0.5, so a hard edge between them lands halfway as in the other modes; colors near
                    // the tolerance move the edge toward them
                    if d <= tol {
                        let half = tol / 2.0;
                        if half > 0.0 {
                            0.5 - 0.25 * ((d - half) / half).clamp(0.0, 1.0)
                        } else {
                            0.5
                        }
                    } else {
                        -0.5 * ((d - tol) / COLOR_BAND).min(1.0)
                    }
                };
                match seen.get(&rgb) {
                    Some(&v) => v,
                    // a bounded memo, so a photo of all distinct colors costs no more memory than its pixels
                    None if seen.len() < 1 << 20 => *seen.entry(rgb).or_insert_with(near),
                    None => near(),
                }
            }
            Mode::Alpha | Mode::Auto => return alpha,
        };
        // a clear pixel is outside whatever its color
        if p[3] < 255 { v.min(alpha) } else { v }
    };
    let (w, h) = (r.w, r.h);
    let mut v = Vec::with_capacity(w * h);
    for y in (0..h).rev() {
        for &p in &r.px[y * w..(y + 1) * w] {
            v.push(value(p));
        }
    }
    Ok((Field { w, h, v }, mode, threshold))
}

/// Labels the inside or outside regions from 1 in scan order, each with its pixel count, or none past `limit` rings.
// inside regions are 8-connected and each has an outer ring; outside ones are 4-connected and those clear of the
// image edge are holes. a region is its count, with EDGE set when it touches the image edge
fn label(f: &Field, inside: bool, labels: &mut Vec<u32>, limit: usize) -> Option<Vec<u32>> {
    let (w, h) = (f.w, f.h);
    labels.clear();
    labels.resize(w * h, 0);
    let mut regions = Vec::new();
    let mut rings = 0usize;
    let mut stack: Vec<u32> = Vec::new();
    let is = |i: usize| (f.v[i] > 0.0) == inside;
    for start in 0..w * h {
        if labels[start] != 0 || !is(start) {
            continue;
        }
        let id = u32::try_from(regions.len() + 1).unwrap_or(u32::MAX);
        let (mut count, mut edge) = (0u32, false);
        labels[start] = id;
        stack.push(start as u32);
        while let Some(i) = stack.pop() {
            let i = i as usize;
            count += 1;
            let (x, y) = (i % w, i / w);
            edge |= x == 0 || y == 0 || x + 1 == w || y + 1 == h;
            for (dx, dy) in [
                (-1, 0),
                (1, 0),
                (0, -1),
                (0, 1),
                (-1, -1),
                (1, -1),
                (-1, 1),
                (1, 1),
            ]
            .into_iter()
            .take(if inside { 8 } else { 4 })
            {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                if labels[j] == 0 && is(j) {
                    labels[j] = id;
                    stack.push(j as u32);
                }
            }
        }
        regions.push(if edge { count | EDGE } else { count });
        rings += usize::from(inside || !edge);
        if rings > limit {
            return None;
        }
    }
    Some(regions)
}

/// Drops inside regions of fewer than `min_px` pixels, then fills holes of fewer.
pub fn despeckle(f: &mut Field, min_px: f64) -> Dropped {
    let mut out = Dropped::default();
    if min_px <= 1.0 {
        return out;
    }
    let small = |r: u32| f64::from(r & !EDGE) < min_px;
    let mut labels = Vec::new();
    let regions = label(f, true, &mut labels, usize::MAX).unwrap_or_default();
    out.specks = regions.iter().filter(|&&r| small(r)).count();
    if out.specks > 0 {
        for (v, &l) in f.v.iter_mut().zip(&labels) {
            if l != 0 && small(regions[l as usize - 1]) {
                *v = -*v;
            }
        }
    }
    let regions = label(f, false, &mut labels, usize::MAX).unwrap_or_default();
    let hole = |r: &u32| r & EDGE == 0 && small(*r);
    out.holes = regions.iter().filter(|r| hole(r)).count();
    if out.holes > 0 {
        for (v, &l) in f.v.iter_mut().zip(&labels) {
            if l != 0 && hole(&regions[l as usize - 1]) {
                *v = (-*v).max(EPS);
            }
        }
    }
    out
}

/// The pixel sides between inside and outside, the image edge included: one ring point each.
fn crossings(f: &Field) -> usize {
    let (w, h) = (f.w, f.h);
    let inside = |x: usize, y: usize| f.v[y * w + x] > 0.0;
    let mut n = 0;
    for y in 0..h {
        for x in 0..w {
            let c = inside(x, y);
            if x + 1 < w {
                n += usize::from(c != inside(x + 1, y));
            }
            if y + 1 < h {
                n += usize::from(c != inside(x, y + 1));
            }
            // the sides on the image edge
            let edges =
                usize::from(x == 0) + usize::from(x + 1 == w) + usize::from(y == 0) + usize::from(y + 1 == h);
            n += if c { edges } else { 0 };
        }
    }
    n
}

/// The inside labels and regions of `f`, or why it has too much to trace.
// crossings and rings (the inside regions and the holes) are counted before any crossing is kept
fn within_limits(f: &Field) -> Result<(Vec<u32>, Vec<u32>)> {
    if crossings(f) > MAX_CROSSINGS {
        return Err(Error::invalid(
            "image",
            "the outlines are too detailed to trace; raise Remove specks under, or use a simpler image",
        ));
    }
    let too_many = || {
        Error::invalid(
            "image",
            format!("more than {MAX_LOOPS} loops; raise Remove specks under, or use a simpler image"),
        )
    };
    let mut labels = Vec::new();
    let holes = label(f, false, &mut labels, MAX_LOOPS)
        .ok_or_else(too_many)?
        .iter()
        .filter(|&&r| r & EDGE == 0)
        .count();
    let regions = label(f, true, &mut labels, MAX_LOOPS - holes).ok_or_else(too_many)?;
    Ok((labels, regions))
}

/// The rings along the zero line of `f`, grouped into shapes in scan order of their regions.
pub fn contours(f: &Field) -> Result<Vec<Shape>> {
    let (w, h) = (f.w as i64, f.h as i64);
    let (labels, regions) = within_limits(f)?;
    // the image sits in a ring of outside pixels, each the negative of its neighbor inside, so every contour closes
    // and one along the image edge lands on it
    let at = |x: i64, y: i64| -> f32 {
        if x >= 0 && y >= 0 && x < w && y < h {
            f.v[(y * w + x) as usize]
        } else {
            let n = f.v[(y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize];
            if n > 0.0 { -n } else { -1.0 }
        }
    };
    let stride = w + 2;
    // grid edges: even ids run from a pixel center to the one on its right, odd ids to the one above
    let hid = |x: i64, y: i64| ((y + 1) * stride + x + 1) as u64 * 2;
    let vid = |x: i64, y: i64| hid(x, y) + 1;
    let mut next: FxHashMap<u64, u64> = FxHashMap::default();
    let mut starts = Vec::new();
    for cy in -1..h {
        for cx in -1..w {
            // corners counterclockwise from the bottom left, and the edge leaving each
            let c = [at(cx, cy), at(cx + 1, cy), at(cx + 1, cy + 1), at(cx, cy + 1)].map(|v| v > 0.0);
            if c == [c[0]; 4] {
                continue;
            }
            let e = [hid(cx, cy), vid(cx + 1, cy), hid(cx, cy + 1), vid(cx, cy)];
            for k in 0..4 {
                if !c[k] || c[(k + 1) % 4] {
                    continue;
                }
                // a contour leaving across edge k comes back in across the next edge going in; pairing so keeps
                // diagonal inside corners joined (8-connected inside)
                let mut j = (k + 1) % 4;
                while c[j] || !c[(j + 1) % 4] {
                    j = (j + 1) % 4;
                }
                next.insert(e[k], e[j]);
                starts.push(e[k]);
            }
        }
    }
    let corners = |id: u64| {
        let base = (id / 2) as i64;
        let (x, y) = (base % stride - 1, base / stride - 1);
        if id.is_multiple_of(2) {
            ((x, y), (x + 1, y))
        } else {
            ((x, y), (x, y + 1))
        }
    };
    let point = |id: u64| -> V2 {
        let ((ax, ay), (bx, by)) = corners(id);
        let lift = |v: f32| if v > 0.0 { v.max(EPS) } else { v.min(-EPS) };
        let (va, vb) = (lift(at(ax, ay)), lift(at(bx, by)));
        let t = f64::from(va / (va - vb));
        [
            ax as f64 + 0.5 + t * (bx - ax) as f64,
            ay as f64 + 0.5 + t * (by - ay) as f64,
        ]
    };
    let region_of = |id: u64| {
        let ((ax, ay), (bx, by)) = corners(id);
        let (x, y) = if at(ax, ay) > 0.0 { (ax, ay) } else { (bx, by) };
        labels[(y * w + x) as usize] as usize - 1
    };
    let mut shapes = vec![Shape::default(); regions.len()];
    for s in starts {
        if !next.contains_key(&s) {
            continue;
        }
        let mut ring = Vec::new();
        let mut e = s;
        loop {
            ring.push(point(e));
            e = next
                .remove(&e)
                .ok_or_else(|| Error::geometry("sketch.trace", "a contour did not close"))?;
            if e == s {
                break;
            }
        }
        let shape = &mut shapes[region_of(s)];
        if signed_area(&ring) > 0.0 {
            shape.outer = ring;
        } else {
            shape.holes.push(ring);
        }
    }
    Ok(shapes)
}

/// What a traced run of points may become.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Lines,
    /// Lines and arcs.
    Arcs,
    /// Lines, arcs and splines.
    #[default]
    Curves,
}

/// The sketch trace's settings, in sketch mm where they have a size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SketchTraceOptions {
    pub mode: Mode,
    pub threshold: Option<f64>,
    /// `#rrggbb` colors for the color mode.
    pub colors: Vec<String>,
    pub color_tolerance: f64,
    /// Inside regions smaller than this are dropped and holes smaller filled, mm².
    pub speck_mm2: f64,
    /// The most a fitted curve strays from the traced edge; half a working pixel when absent.
    pub smoothing_mm: Option<f64>,
    pub fit: Fit,
    /// A turn sharper than this over about 2 px is a corner.
    pub corner_angle_deg: f64,
    /// The traced shapes' width, or height, or the size of one image pixel; width 50 mm when none is set.
    pub width_mm: Option<f64>,
    pub height_mm: Option<f64>,
    pub mm_per_px: Option<f64>,
    /// Where the middle of the traced shapes lands, sketch mm.
    pub center: V2,
    pub max_side_px: usize,
    /// A PNG of the working image with the loops drawn over it.
    pub preview_image: bool,
}

impl Default for SketchTraceOptions {
    fn default() -> Self {
        Self {
            mode: Mode::Auto,
            threshold: None,
            colors: Vec::new(),
            color_tolerance: 12.0,
            speck_mm2: 0.5,
            smoothing_mm: None,
            fit: Fit::Curves,
            corner_angle_deg: 50.0,
            width_mm: None,
            height_mm: None,
            mm_per_px: None,
            center: [0.0, 0.0],
            max_side_px: DEFAULT_SIDE,
            preview_image: false,
        }
    }
}

/// An image traced into sketch loops.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchTrace {
    pub loops: Vec<Loop>,
    pub counts: Counts,
    pub size_mm: V2,
    /// mm per pixel of the image as the file has it.
    pub mm_per_px: f64,
    pub image_px: [usize; 2],
    pub working_px: [usize; 2],
    pub dropped: Dropped,
    pub check: SketchCheck,
    pub warnings: Vec<String>,
    pub mode: Mode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    /// Working px (y up) to sketch mm: `[scale, dx, dy]`, for drawing the loops over the image.
    pub px_to_mm: [f64; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_png: Option<String>,
}

/// More segments than this are refused.
pub const MAX_SEGMENTS: usize = 20_000;
/// The preview image's long side.
const PREVIEW_SIDE: usize = 1024;
/// The fit's work, in point distances measured, before a call stops: about a second natively, where a busy 12
/// megapixel photo takes under a million.
pub const FIT_BUDGET: u64 = 60_000_000;
/// How many times a crossing fit is tried again; the last is the traced points as lines.
const REFITS: u32 = 6;
/// How near a crossing, in working px, the traced points are kept as they are.
const PIN_PX: f64 = 2.0;
/// the turn is measured this far either side of a point, working px
const CORNER_WINDOW_PX: f64 = 2.0;

/// `#rrggbb` as a color.
fn hex_color(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

/// The work a fit may still do.
struct Budget(u64);

impl Budget {
    fn spend(&mut self, n: usize) -> Result<()> {
        self.0 = self.0.saturating_sub(n as u64);
        if self.0 == 0 {
            return Err(Error::invalid(
                "image",
                "this image takes too long to trace; raise Smoothing or Remove specks under, or use a simpler image",
            ));
        }
        Ok(())
    }
}

/// Fits the runs of one traced ring, in working px, into a loop in sketch mm.
struct RingFit<'a> {
    tol: f64,
    fit: Fit,
    place: [f64; 6],
    budget: &'a mut Budget,
    missed: usize,
}

impl RingFit<'_> {
    fn mm(&self, p: V2) -> V2 {
        [
            self.place[0] * p[0] + self.place[4],
            self.place[3] * p[1] + self.place[5],
        ]
    }

    /// Adds `pts` (a run from its first point to its last) to `b`, with `cand` the run's thinned points.
    fn run(&mut self, b: &mut Builder, pts: &[V2], cand: &[usize]) -> Result<()> {
        let last = pts.len() - 1;
        if last == 0 {
            return Ok(());
        }
        let (a, z) = (pts[0], pts[last]);
        self.budget.spend(pts.len())?;
        let (far, off) = pts
            .iter()
            .enumerate()
            .map(|(i, &p)| (i, sketch_fit::to_segment(p, a, z)))
            .fold((0, 0.0), |best, x| if x.1 > best.1 { x } else { best });
        if off <= self.tol || last == 1 {
            b.line(self.mm(z));
            return Ok(());
        }
        if self.fit != Fit::Lines
            && let Some((c, r, through)) = self.arc(pts)?
        {
            b.arc(self.mm(z), self.mm(through), self.mm(c), r * self.place[0]);
            return Ok(());
        }
        if self.fit == Fit::Curves && self.spline(b, pts, cand)? {
            return Ok(());
        }
        // split where the run strays most from its chord
        let at = if far == 0 || far == last { last / 2 } else { far };
        let (l, r) = split_cand(cand, at);
        self.run(b, &pts[..=at], &l)?;
        self.run(b, &pts[at..], &r)
    }

    /// An arc through both ends of `pts` with its center on their bisector (least squares), when every point is
    /// within the tolerance of it: the center, radius and a point in the middle of it.
    fn arc(&mut self, pts: &[V2]) -> Result<Option<(V2, f64, V2)>> {
        let (a, z) = (pts[0], pts[pts.len() - 1]);
        let chord = sketch_fit::dist(a, z);
        if pts.len() < 3 || chord < 1e-6 {
            return Ok(None);
        }
        let m = [f64::midpoint(a[0], z[0]), f64::midpoint(a[1], z[1])];
        let nrm = [-(z[1] - a[1]) / chord, (z[0] - a[0]) / chord];
        let mq = [m[0] - a[0], m[1] - a[1]];
        // a point p on the circle meets |q|^2 - 2 m'.q = 2 t n.q, with q = p - a and the center at m + t n
        let (mut num, mut den) = (0.0, 0.0);
        for p in pts {
            let q = [p[0] - a[0], p[1] - a[1]];
            let e = q[0] * q[0] + q[1] * q[1] - 2.0 * (mq[0] * q[0] + mq[1] * q[1]);
            let g = 2.0 * (nrm[0] * q[0] + nrm[1] * q[1]);
            num += e * g;
            den += g * g;
        }
        self.budget.spend(pts.len())?;
        if den <= 0.0 {
            return Ok(None);
        }
        let t = num / den;
        let c = [m[0] + t * nrm[0], m[1] + t * nrm[1]];
        let r = sketch_fit::dist(a, c);
        // nearly straight, the arc is a line that missed
        if !(r.is_finite() && r * self.place[0] < 1e5) {
            return Ok(None);
        }
        if pts.iter().any(|&p| (sketch_fit::dist(p, c) - r).abs() > self.tol) {
            return Ok(None);
        }
        let mid = pts[pts.len() / 2];
        let d = sketch_fit::dist(mid, c);
        if d <= 0.0 {
            return Ok(None);
        }
        Ok(Some((
            c,
            r,
            [c[0] + r * (mid[0] - c[0]) / d, c[1] + r * (mid[1] - c[1]) / d],
        )))
    }

    /// A spline through the run's thinned points and more where it strays most, when it meets the tolerance within
    /// the most points a spline takes.
    fn spline(&mut self, b: &mut Builder, pts: &[V2], cand: &[usize]) -> Result<bool> {
        let last = pts.len() - 1;
        let mut idx: Vec<usize> = cand.to_vec();
        loop {
            let through: Vec<V2> = idx.iter().map(|&i| pts[i]).collect();
            // the run between two through points, at the same fraction of its points
            let along = |j: usize, s: f64| -> V2 {
                let (i0, i1) = (idx[j], idx[j + 1]);
                let x = i0 as f64 + s * (i1 - i0) as f64;
                let k = (x.floor() as usize).min(last - 1);
                let u = x - k as f64;
                [
                    pts[k][0] + u * (pts[k + 1][0] - pts[k][0]),
                    pts[k][1] + u * (pts[k + 1][1] - pts[k][1]),
                ]
            };
            self.budget.spend(3 * idx.len())?;
            let spans = sketch_spline::spans(&through, false);
            let (worst, off) = spans
                .iter()
                .enumerate()
                .map(|(j, s)| {
                    let e = (1..4)
                        .map(|q| {
                            let t = f64::from(q) / 4.0;
                            sketch_fit::dist(sketch_fit::bez(s, t), along(j, t))
                        })
                        .fold(0.0, f64::max);
                    (j, e)
                })
                .fold((0, 0.0), |best, x| if x.1 > best.1 { x } else { best });
            if off <= self.tol {
                let inner = through[1..through.len() - 1]
                    .iter()
                    .map(|&p| self.mm(p))
                    .collect();
                b.spline(self.mm(pts[last]), inner);
                return Ok(true);
            }
            let (i0, i1) = (idx[worst], idx[worst + 1]);
            if idx.len() > MAX_SAMPLES || i1 - i0 < 2 {
                // a run this short that still misses goes in as it is, a little further off
                if pts.len() <= 4 {
                    self.missed += 1;
                    let inner = through[1..through.len() - 1]
                        .iter()
                        .map(|&p| self.mm(p))
                        .collect();
                    b.spline(self.mm(pts[last]), inner);
                    return Ok(true);
                }
                return Ok(false);
            }
            idx.insert(worst + 1, usize::midpoint(i0, i1));
        }
    }
}

/// The thinned points either side of `at`, each list with its run's ends.
fn split_cand(cand: &[usize], at: usize) -> (Vec<usize>, Vec<usize>) {
    let mut l: Vec<usize> = cand.iter().copied().filter(|&i| i < at).collect();
    l.push(at);
    let mut r: Vec<usize> = vec![0];
    r.extend(cand.iter().copied().filter(|&i| i > at).map(|i| i - at));
    (l, r)
}

/// The point `d` along `ring` from point `i`, forward or back.
fn walk(ring: &[V2], i: usize, d: f64, forward: bool) -> V2 {
    let n = ring.len();
    let (mut at, mut left) = (i, d);
    for _ in 0..n {
        let next = if forward { (at + 1) % n } else { (at + n - 1) % n };
        let step = sketch_fit::dist(ring[at], ring[next]);
        if step >= left && step > 0.0 {
            let u = left / step;
            return [
                ring[at][0] + u * (ring[next][0] - ring[at][0]),
                ring[at][1] + u * (ring[next][1] - ring[at][1]),
            ];
        }
        left -= step;
        at = next;
    }
    ring[at]
}

/// The corners among the points that turn sharply: points close along the ring are one corner (marching squares cuts
/// a sharp corner into a short chamfer), at the meeting of the edges coming in and going out when it is close by.
fn corner_points(ring: &[V2], turned: &[usize]) -> Vec<(usize, usize, V2)> {
    let n = ring.len();
    if turned.is_empty() {
        return Vec::new();
    }
    let step = |i: usize| sketch_fit::dist(ring[i], ring[(i + 1) % n]);
    let apart = |a: usize, b: usize| (0..(b + n - a) % n).map(|j| step((a + j) % n)).sum::<f64>();
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for &i in turned {
        match groups.last_mut() {
            Some(g) if apart(g.1, i) <= 2.0 * CORNER_WINDOW_PX => g.1 = i,
            _ => groups.push((i, i)),
        }
    }
    // the last group may run on into the first round the ring
    if groups.len() > 1
        && let (Some(&first), Some(&last)) = (groups.first(), groups.last())
        && apart(last.1, first.0) <= 2.0 * CORNER_WINDOW_PX
    {
        groups[0].0 = last.0;
        groups.pop();
        groups.rotate_left(1);
    }
    groups
        .into_iter()
        .map(|(a, b)| {
            let (p, q) = (
                walk(ring, a, CORNER_WINDOW_PX, false),
                walk(ring, b, CORNER_WINDOW_PX, true),
            );
            let (u, v) = (sketch_fit::sub2(ring[a], p), sketch_fit::sub2(q, ring[b]));
            let den = u[0] * v[1] - u[1] * v[0];
            let w = sketch_fit::sub2(ring[b], p);
            let t = (w[0] * v[1] - w[1] * v[0]) / den;
            let x = [p[0] + t * u[0], p[1] + t * u[1]];
            let near = den.abs() > 1e-9 && sketch_fit::dist(x, ring[a]) <= CORNER_WINDOW_PX;
            (a, b, if near { x } else { ring[a] })
        })
        .collect()
}

/// The circle through `ring` by least squares, when every point is within `tol` of it.
fn ring_circle(ring: &[V2], tol: f64) -> Option<(V2, f64)> {
    if ring.len() < 8 {
        return None;
    }
    let n = ring.len() as f64;
    let c0 = ring
        .iter()
        .fold([0.0, 0.0], |s, p| [s[0] + p[0] / n, s[1] + p[1] / n]);
    // x^2 + y^2 + d x + e y + f = 0 round the centroid, by its normal equations
    let (mut sxx, mut sxy, mut syy, mut sx, mut sy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut bx, mut by, mut b1) = (0.0, 0.0, 0.0);
    for p in ring {
        let (x, y) = (p[0] - c0[0], p[1] - c0[1]);
        let z = -(x * x + y * y);
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
        sx += x;
        sy += y;
        bx += z * x;
        by += z * y;
        b1 += z;
    }
    let m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    let det = |m: [[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d0 = det(m);
    if d0.abs() < 1e-12 {
        return None;
    }
    let col = |k: usize| {
        let mut c = m;
        for (row, v) in c.iter_mut().zip([bx, by, b1]) {
            row[k] = v;
        }
        det(c) / d0
    };
    let (d, e, f) = (col(0), col(1), col(2));
    let c = [-d / 2.0 + c0[0], -e / 2.0 + c0[1]];
    let r2 = d * d / 4.0 + e * e / 4.0 - f;
    if r2.is_nan() || r2 <= 0.0 {
        return None;
    }
    let r = r2.sqrt();
    ring.iter()
        .all(|&p| (sketch_fit::dist(p, c) - r).abs() <= tol)
        .then_some((c, r))
}

/// One traced ring as a sketch loop: thinned, split at its corners, each run fitted.
fn fit_ring(
    ring: &[V2],
    o: &SketchTraceOptions,
    tol: f64,
    place: [f64; 6],
    pins: &[usize],
    budget: &mut Budget,
) -> Result<(Option<Loop>, usize)> {
    let n = ring.len();
    let keep = poly2d::simplify_ring_keep(ring, tol / 4.0);
    budget.spend(n * 4)?;
    let kept: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    let limit = o.corner_angle_deg.to_radians();
    let turned: Vec<usize> = kept
        .iter()
        .copied()
        .filter(|&i| {
            let (back, fwd) = (
                walk(ring, i, CORNER_WINDOW_PX, false),
                walk(ring, i, CORNER_WINDOW_PX, true),
            );
            let (u, v) = (sketch_fit::sub2(ring[i], back), sketch_fit::sub2(fwd, ring[i]));
            let turn = (u[0] * v[1] - u[1] * v[0])
                .m_atan2(u[0] * v[0] + u[1] * v[1])
                .abs();
            turn > limit
        })
        .collect();
    let mut corners = corner_points(ring, &turned);
    if !pins.is_empty() {
        // pinned points are kept as they are, so a corner round one gives way to them
        let holds = |a: usize, b: usize, i: usize| {
            if a <= b {
                (a..=b).contains(&i)
            } else {
                i >= a || i <= b
            }
        };
        corners.retain(|&(a, b, _)| !pins.iter().any(|&i| holds(a, b, i)));
        corners.extend(pins.iter().map(|&i| (i, i, ring[i])));
        corners.sort_unstable_by_key(|c| c.0);
    }
    let mut f = RingFit {
        tol,
        fit: o.fit,
        place,
        budget,
        missed: 0,
    };
    if corners.is_empty()
        && o.fit != Fit::Lines
        && pins.is_empty()
        && let Some((c, r)) = ring_circle(ring, tol)
    {
        return Ok((Some(sketch_fit::circle(f.mm(c), r * place[0])), 0));
    }
    // a loop takes two pieces at least, so a ring with under two corners is split across as well
    if corners.is_empty() {
        let i = kept.first().copied().unwrap_or(0);
        corners.push((i, i, ring[i]));
    }
    if corners.len() == 1 {
        let (a, b, _) = corners[0];
        let opposite = (b + n / 2) % n;
        let near = kept
            .iter()
            .copied()
            .filter(|&i| i != a && i != b)
            .min_by_key(|&i| i.abs_diff(opposite))
            .unwrap_or(opposite);
        corners.push((near, near, ring[near]));
        corners.sort_unstable_by_key(|c| c.0);
    }
    let mut b = Builder::new(f.mm(corners[0].2));
    for (k, &(_, end, at)) in corners.iter().enumerate() {
        let (next, _, to) = corners[(k + 1) % corners.len()];
        // the ring's points strictly between the two corners, with the corners' own points at the ends
        let gap = (next + n - end) % n;
        let inner: Vec<usize> = (1..gap).map(|j| (end + j) % n).collect();
        let mut pts = Vec::with_capacity(inner.len() + 2);
        pts.push(at);
        pts.extend(inner.iter().map(|&i| ring[i]));
        pts.push(to);
        let mut cand: Vec<usize> = vec![0];
        cand.extend((0..inner.len()).filter(|&j| keep[inner[j]]).map(|j| j + 1));
        cand.push(pts.len() - 1);
        f.run(&mut b, &pts, &cand)?;
    }
    let missed = f.missed;
    Ok((b.finish(tol * place[0]), missed))
}

/// The index of the ring point nearest `p`.
fn closest(ring: &[V2], p: V2) -> usize {
    (0..ring.len())
        .min_by(|&a, &b| sketch_fit::dist(ring[a], p).total_cmp(&sketch_fit::dist(ring[b], p)))
        .unwrap_or(0)
}

/// Where segment `s` of a loop starts and ends.
fn piece_ends(l: &Loop, s: usize) -> Option<(V2, V2)> {
    let from = if s == 0 {
        l.start?
    } else {
        l.segments.get(s - 1)?.to?
    };
    Some((from, l.segments.get(s)?.to?))
}

/// A traced ring as lines through every point, which never cross where the trace did not.
fn exact_ring(ring: &[V2], place: [f64; 6]) -> Option<Loop> {
    let mm = |p: V2| [place[0] * p[0] + place[4], place[3] * p[1] + place[5]];
    let mut b = Builder::new(mm(*ring.first()?));
    for &p in &ring[1..] {
        b.line(mm(p));
    }
    b.finish(0.0)
}

/// Fits that cross themselves or each other, fitted again until none do.
struct Untangle<'a> {
    o: &'a SketchTraceOptions,
    /// The smoothing, working px.
    tol: f64,
    place: [f64; 6],
    /// The round from which a ring still crossing is kept as traced.
    refits: u32,
    max_segments: usize,
}

/// A crossing on one loop: where, and the stretch of its ring under the crossing piece, from a point and how many
/// points on; None when the check gives no point or piece.
type Near = Option<(V2, usize, usize)>;

impl Untangle<'_> {
    /// Keeps every ring with no fit as traced. Then, where a fit crosses itself or a neighbor (both loops of a pair
    /// that cross), keeps the traced points round the crossing as they are and fits the crossing piece tighter,
    /// reaching further each round; from the last round on, every loop still crossing is kept as traced, until
    /// nothing crosses. No ring loses its loop: one too small to keep as traced, or a sketch with no room for the
    /// traced points, is refused. Gives the rounds that ran.
    fn run(&self, rings: &[&Vec<V2>], fitted: &mut [Option<Loop>], budget: &mut Budget) -> Result<u32> {
        let mut exact = vec![false; rings.len()];
        for (i, f) in fitted.iter_mut().enumerate() {
            if let Some(l) = f {
                sketch_fit::tidy_loop(l);
            } else {
                *f = Some(self.exact(rings[i])?);
                exact[i] = true;
            }
        }
        let mut near: Vec<Vec<Near>> = vec![Vec::new(); rings.len()];
        let mut round = 0;
        loop {
            let crossing = self.crossings(rings, fitted, budget)?;
            if crossing.is_empty() {
                return Ok(round);
            }
            round += 1;
            let mut bad: Vec<usize> = crossing.iter().map(|c| c.0).collect();
            bad.sort_unstable();
            bad.dedup();
            for (i, at) in crossing {
                near[i].push(at);
            }
            // traced rings never cross, so this is a trace drawn finer than the sketch keeps
            if bad.iter().all(|&i| exact[i]) {
                return Err(Self::too_small());
            }
            let mut room = self.room(fitted);
            for i in bad {
                if exact[i] {
                    continue;
                }
                let ring = rings[i];
                let n = ring.len();
                if round >= self.refits || near[i].iter().any(Option::is_none) {
                    budget.spend(n)?;
                    let have = fitted[i].as_ref().map_or(0, |l| l.segments.len().max(1));
                    let need = n.saturating_sub(have);
                    if room < need {
                        return Err(Error::invalid(
                            "image",
                            format!(
                                "the outlines run too close together to keep apart within {} segments; lower Smoothing or raise Remove specks under",
                                self.max_segments
                            ),
                        ));
                    }
                    room -= need;
                    fitted[i] = Some(self.exact(ring)?);
                    exact[i] = true;
                    continue;
                }
                let tight = poly2d::simplify_ring_keep(ring, self.tol / f64::from(1u32 << (round + 1)));
                budget.spend(n * (4 + near[i].len()))?;
                let reach = PIN_PX * f64::from(1u32 << (round - 1));
                let mut pinned = vec![false; n];
                for &(at, from, len) in near[i].iter().flatten() {
                    for (j, pin) in pinned.iter_mut().enumerate() {
                        *pin |= sketch_fit::dist(ring[j], at) <= reach;
                    }
                    for j in (0..=len).map(|j| (from + j) % n) {
                        pinned[j] |= tight[j];
                    }
                }
                let pins: Vec<usize> = (0..n).filter(|&j| pinned[j]).collect();
                fitted[i] = Some(
                    if let Some(mut l) = fit_ring(ring, self.o, self.tol, self.place, &pins, budget)?.0 {
                        sketch_fit::tidy_loop(&mut l);
                        l
                    } else {
                        exact[i] = true;
                        self.exact(ring)?
                    },
                );
            }
        }
    }

    /// Each loop on a crossing, both where two loops cross, with the crossing as `near` keeps it.
    fn crossings(
        &self,
        rings: &[&Vec<V2>],
        fitted: &[Option<Loop>],
        budget: &mut Budget,
    ) -> Result<Vec<(usize, Near)>> {
        // every ring has a loop by now, so a loop's index is its ring's
        let loops: Vec<Loop> = fitted.iter().flatten().cloned().collect();
        let place = self.place;
        let to_px = |p: V2| [(p[0] - place[4]) / place[0], (p[1] - place[5]) / place[3]];
        let mut out = Vec::new();
        for issue in sketch::check(&loops).issues {
            if !matches!(issue.kind, IssueKind::SelfCrossing | IssueKind::LoopsCross) {
                continue;
            }
            let sides = std::iter::once((issue.loop_index, issue.segment))
                .chain(issue.other.map(|(l, s)| (l, Some(s))));
            for (li, seg) in sides {
                let Some(&ring) = rings.get(li) else {
                    continue;
                };
                budget.spend(ring.len() * 2)?;
                let piece = seg.and_then(|s| piece_ends(&loops[li], s));
                let at = issue.at.zip(piece).map(|(at, (p, q))| {
                    let (a, b) = (closest(ring, to_px(p)), closest(ring, to_px(q)));
                    // the shorter way round, since a piece that closes the loop may end just short of where it began
                    let n = ring.len();
                    let (fwd, back) = ((b + n - a) % n, (a + n - b) % n);
                    let (from, len) = if fwd <= back { (a, fwd) } else { (b, back) };
                    (to_px(at), from, len)
                });
                out.push((li, at));
            }
        }
        Ok(out)
    }

    /// The segments the sketch still has room for.
    fn room(&self, fitted: &[Option<Loop>]) -> usize {
        self.max_segments
            .saturating_sub(fitted.iter().flatten().map(|l| l.segments.len().max(1)).sum())
    }

    /// `ring` as traced, or a refusal when it is too small to draw.
    fn exact(&self, ring: &[V2]) -> Result<Loop> {
        let mut l = exact_ring(ring, self.place).ok_or_else(Self::too_small)?;
        sketch_fit::tidy_loop(&mut l);
        Ok(l)
    }

    fn too_small() -> Error {
        Error::invalid(
            "image",
            "a traced outline is too small to draw at this size; make the trace larger or raise Remove specks under",
        )
    }
}

/// Traces a PNG or JPEG file into sketch loops.
pub fn sketch_trace_bytes(bytes: &[u8], o: &SketchTraceOptions) -> Result<SketchTrace> {
    let r = raster::decode(bytes).map_err(|u| Error::invalid("image", format!("the file {}", u.why())))?;
    sketch_trace(Cow::Owned(r), o)
}

/// Traces an image into sketch loops, sized and placed.
#[allow(
    clippy::too_many_lines,
    reason = "checks, the trace, the scale, the fit and the reply in one pass"
)]
pub fn sketch_trace(r: Cow<'_, Raster>, o: &SketchTraceOptions) -> Result<SketchTrace> {
    let colors = o
        .colors
        .iter()
        .map(|c| hex_color(c).ok_or_else(|| Error::invalid("colors", format!("{c} is not a #rrggbb color"))))
        .collect::<Result<Vec<_>>>()?;
    let sizes = [("widthMm", o.width_mm), ("heightMm", o.height_mm)];
    for (what, v) in sizes {
        if v.is_some_and(|v| !(v.is_finite() && v > 0.0 && v <= 10_000.0)) {
            return Err(Error::invalid(what, "between 0 and 10000 mm"));
        }
    }
    if o.mm_per_px
        .is_some_and(|v| !(v.is_finite() && v > 0.0 && v <= 100.0))
    {
        return Err(Error::invalid("mmPerPx", "between 0 and 100 mm"));
    }
    if [o.width_mm.is_some(), o.height_mm.is_some(), o.mm_per_px.is_some()]
        .iter()
        .filter(|&&s| s)
        .count()
        > 1
    {
        return Err(Error::invalid("size", "set one of widthMm, heightMm and mmPerPx"));
    }
    if o.smoothing_mm
        .is_some_and(|v| !(v.is_finite() && (0.01..=10.0).contains(&v)))
    {
        return Err(Error::invalid("smoothingMm", "between 0.01 and 10 mm"));
    }
    if !(o.speck_mm2.is_finite() && (0.0..=1e6).contains(&o.speck_mm2)) {
        return Err(Error::invalid("speckMm2", "0 or more"));
    }
    if !(o.corner_angle_deg.is_finite() && (1.0..=179.0).contains(&o.corner_angle_deg)) {
        return Err(Error::invalid("cornerAngleDeg", "between 1 and 179 degrees"));
    }
    if !o.center.iter().all(|c| c.is_finite() && c.abs() <= 10_000.0) {
        return Err(Error::invalid("center", "within 10000 mm of the origin"));
    }
    let core = TraceOptions {
        mode: o.mode,
        threshold: o.threshold,
        colors,
        color_tolerance: o.color_tolerance,
        speck_px: 0.0,
        max_side_px: o.max_side_px,
    };
    let image_w = r.file_size.0 as f64;
    let width = o
        .width_mm
        .or((o.height_mm.is_none() && o.mm_per_px.is_none()).then_some(50.0));
    // mm per working px from the size, given the inside's extent in working px
    let scale = |work_w: usize, ext: V2| -> f64 {
        if let Some(m) = o.mm_per_px {
            m * image_w / work_w as f64
        } else if let Some(h) = o.height_mm {
            h / ext[1]
        } else {
            width.unwrap_or(50.0) / ext[0]
        }
    };
    // specks are measured at the scale of the regions that are not specks at the scale of all of them; the shapes'
    // own extent after cleanup sets the scale of the sketch
    let speck = |f: &Field| -> f64 {
        if o.speck_mm2 == 0.0 {
            return 0.0;
        }
        let mut labels = Vec::new();
        let Some(regions) = label(f, true, &mut labels, 1 << 20) else {
            return 0.0;
        };
        let mut bb = vec![[usize::MAX, usize::MAX, 0, 0]; regions.len()];
        for (i, &l) in labels.iter().enumerate() {
            if l != 0 {
                let (x, y, b) = (i % f.w, i / f.w, &mut bb[l as usize - 1]);
                *b = [b[0].min(x), b[1].min(y), b[2].max(x + 1), b[3].max(y + 1)];
            }
        }
        drop(labels);
        let k_of = |min_px: f64| -> Option<f64> {
            let mut u = [usize::MAX, usize::MAX, 0, 0];
            for (r, b) in regions.iter().zip(&bb) {
                if f64::from(r & !EDGE) >= min_px {
                    u = [u[0].min(b[0]), u[1].min(b[1]), u[2].max(b[2]), u[3].max(b[3])];
                }
            }
            (u[0] != usize::MAX).then(|| scale(f.w, [(u[2] - u[0]) as f64, (u[3] - u[1]) as f64]))
        };
        let Some(k0) = k_of(0.0) else {
            return 0.0;
        };
        let k1 = k_of(o.speck_mm2 / (k0 * k0)).unwrap_or(k0);
        o.speck_mm2 / (k1 * k1)
    };
    let preview = if o.preview_image { PREVIEW_SIDE } else { 0 };
    let (traced, small) = stages(r, &core, &speck, preview)?;
    let rings = traced
        .shapes
        .iter()
        .flat_map(|s| std::iter::once(&s.outer).chain(&s.holes));
    let (lo, hi) = rings
        .flatten()
        .fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(lo, hi), p| {
            (
                [lo[0].min(p[0]), lo[1].min(p[1])],
                [hi[0].max(p[0]), hi[1].max(p[1])],
            )
        });
    let ext = [hi[0] - lo[0], hi[1] - lo[1]];
    let k = scale(traced.working_px[0], ext);
    if !(k.is_finite() && k > 0.0) {
        return Err(nothing_inside(traced.mode));
    }
    if ext[0] * k > MAX_MM || ext[1] * k > MAX_MM {
        return Err(Error::invalid(
            "size",
            format!(
                "the trace is {:.0} x {:.0} mm, over the {MAX_MM:.0} mm a sketch takes",
                ext[0] * k,
                ext[1] * k
            ),
        ));
    }
    let tol_mm = o.smoothing_mm.unwrap_or(0.5 * k).max(0.01);
    let place = sketch_fit::placement(lo, hi, k, o.center);
    let mut budget = Budget(FIT_BUDGET);
    let rings: Vec<&Vec<V2>> = traced
        .shapes
        .iter()
        .flat_map(|s| std::iter::once(&s.outer).chain(&s.holes))
        .collect();
    let mut fitted = Vec::with_capacity(rings.len());
    let mut missed = 0;
    for ring in &rings {
        let (l, m) = fit_ring(ring, o, tol_mm / k, place, &[], &mut budget)?;
        missed += m;
        fitted.push(l);
    }
    let fix = Untangle {
        o,
        tol: tol_mm / k,
        place,
        refits: REFITS,
        max_segments: MAX_SEGMENTS,
    };
    fix.run(&rings, &mut fitted, &mut budget)?;
    let loops: Vec<Loop> = fitted.into_iter().flatten().collect();
    let segments: usize = loops.iter().map(|l| l.segments.len().max(1)).sum();
    if segments > MAX_SEGMENTS {
        return Err(Error::invalid(
            "image",
            format!(
                "the trace has {segments} segments, more than {MAX_SEGMENTS}; raise Remove specks under or Smoothing"
            ),
        ));
    }
    if loops.is_empty() {
        return Err(nothing_inside(traced.mode));
    }
    let mut warnings = Vec::new();
    if missed > 0 {
        warnings.push(format!(
            "{missed} short {} a little further off than Smoothing",
            if missed == 1 { "curve stays" } else { "curves stay" }
        ));
    }
    let check = sketch::check(&loops);
    let preview_png = match small {
        Some(img) => Some(preview_png(&img, traced.working_px, &check, place)?),
        None => None,
    };
    let working_w = traced.working_px[0] as f64;
    Ok(SketchTrace {
        counts: sketch_fit::count(&loops),
        loops,
        size_mm: [sketch_fit::tidy(ext[0] * k), sketch_fit::tidy(ext[1] * k)],
        mm_per_px: k * working_w / image_w,
        image_px: traced.image_px,
        working_px: traced.working_px,
        dropped: traced.dropped,
        check,
        warnings,
        mode: traced.mode,
        threshold: traced.threshold,
        px_to_mm: [k, place[4], place[5]],
        preview_png,
    })
}

/// The image with the loops drawn over it, as a PNG in base64.
fn preview_png(img: &Raster, working: [usize; 2], check: &SketchCheck, place: [f64; 6]) -> Result<String> {
    let mut px = img.px.clone();
    let (w, h) = (img.w, img.h);
    // sketch mm to working px (y up) to preview px (y down)
    let s = w as f64 / working[0] as f64;
    let to_px = |p: V2| -> (f64, f64) {
        let x = (p[0] - place[4]) / place[0];
        let y = (p[1] - place[5]) / place[3];
        (x * s, (working[1] as f64 - y) * s)
    };
    let mut dot = |x: f64, y: f64| {
        for (dx, dy) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            let (xi, yi) = ((x + dx - 0.5).floor(), (y + dy - 0.5).floor());
            if xi >= 0.0 && yi >= 0.0 && (xi as usize) < w && (yi as usize) < h {
                px[yi as usize * w + xi as usize] = [240, 40, 140, 255];
            }
        }
    };
    for poly in &check.polygons {
        for ring in std::iter::once(&poly.outer).chain(&poly.holes) {
            for (i, &a) in ring.iter().enumerate() {
                let (b, a) = (to_px(ring[(i + 1) % ring.len()]), to_px(a));
                let steps =
                    ((b.0 - a.0).abs().max((b.1 - a.1).abs()).ceil() as usize).clamp(1, 4 * PREVIEW_SIDE);
                for k in 0..=steps {
                    let t = k as f64 / steps as f64;
                    dot(a.0 + t * (b.0 - a.0), a.1 + t * (b.1 - a.1));
                }
            }
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc
            .write_header()
            .map_err(|e| Error::geometry("sketch.trace", e.to_string()))?;
        writer
            .write_image_data(px.as_flattened())
            .map_err(|e| Error::geometry("sketch.trace", e.to_string()))?;
    }
    Ok(crate::json::base64_encode(&out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::tests::png;

    const WHITE: [u8; 4] = [255, 255, 255, 255];
    const BLACK: [u8; 4] = [0, 0, 0, 255];

    /// An image drawn by coverage: `cover(x, y)` gives the color at a point, sampled 16 x 16 a pixel over `bg`.
    fn draw(w: usize, h: usize, bg: [u8; 4], cover: impl Fn(f64, f64) -> Option<[u8; 4]>) -> Raster {
        let mut px = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0f64; 4];
                for sy in 0..16 {
                    for sx in 0..16 {
                        let p = cover(
                            x as f64 + (f64::from(sx) + 0.5) / 16.0,
                            y as f64 + (f64::from(sy) + 0.5) / 16.0,
                        )
                        .unwrap_or(bg);
                        for (a, c) in acc.iter_mut().zip(p) {
                            *a += f64::from(c) / 256.0;
                        }
                    }
                }
                px.push(acc.map(|v| v.round() as u8));
            }
        }
        Raster::new(w, h, px).unwrap()
    }

    fn area(s: &Shape) -> f64 {
        signed_area(&s.outer) + s.holes.iter().map(|h| signed_area(h)).sum::<f64>()
    }

    fn bbox(ring: &[V2]) -> [f64; 4] {
        ring.iter()
            .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
            })
    }

    fn opts() -> TraceOptions {
        TraceOptions::default()
    }

    #[test]
    fn otsu_splits_two_groups_and_takes_the_middle_of_a_flat_best() {
        let mut h = [0u64; 256];
        h[0] = 50;
        h[255] = 50;
        assert_eq!(otsu(&h), Some(127));
        let mut h = [0u64; 256];
        h[20..40].fill(10);
        h[180..200].fill(10);
        let t = otsu(&h).unwrap();
        assert!((39..180).contains(&t), "{t}");
        let mut flat = [0u64; 256];
        flat[90] = 7;
        assert_eq!(otsu(&flat), None);
    }

    #[test]
    fn a_square_is_one_loop_with_its_corners_within_half_a_pixel() {
        let img = draw(140, 140, WHITE, |x, y| {
            ((20.0..120.0).contains(&x) && (20.0..120.0).contains(&y)).then_some(BLACK)
        });
        let t = trace(&img, &opts()).unwrap();
        assert_eq!(t.mode, Mode::Dark);
        assert_eq!(t.threshold, Some(127.0));
        assert_eq!(t.shapes.len(), 1);
        let s = &t.shapes[0];
        assert!(s.holes.is_empty());
        let b = bbox(&s.outer);
        for (got, want) in b.iter().zip([20.0, 20.0, 120.0, 120.0]) {
            assert!((got - want).abs() < 0.5, "{b:?}");
        }
        assert!((area(s) - 10_000.0).abs() < 1.0, "{}", area(s));
        assert!(signed_area(&s.outer) > 0.0);
        assert_eq!(t.working_px, [140, 140]);
    }

    #[test]
    fn an_anti_aliased_circle_keeps_its_diameter_within_one_percent() {
        let img = draw(120, 120, WHITE, |x, y| {
            ((x - 60.0).m_hypot(y - 60.0) < 40.0).then_some(BLACK)
        });
        let t = trace(&img, &opts()).unwrap();
        assert_eq!(t.shapes.len(), 1);
        let s = &t.shapes[0];
        let d = (4.0 * area(s) / std::f64::consts::PI).sqrt();
        assert!((d - 80.0).abs() < 0.8, "{d}");
        let b = bbox(&s.outer);
        assert!(
            (b[2] - b[0] - 80.0).abs() < 0.8 && (b[3] - b[1] - 80.0).abs() < 0.8,
            "{b:?}"
        );
    }

    #[test]
    fn a_ring_is_an_outer_loop_and_a_hole_with_its_area_within_one_percent() {
        let img = draw(120, 120, WHITE, |x, y| {
            let r = (x - 60.0).m_hypot(y - 60.0);
            (20.0..40.0).contains(&r).then_some(BLACK)
        });
        let t = trace(&img, &opts()).unwrap();
        assert_eq!(t.shapes.len(), 1);
        let s = &t.shapes[0];
        assert_eq!(s.holes.len(), 1);
        assert!(signed_area(&s.outer) > 0.0 && signed_area(&s.holes[0]) < 0.0);
        let want = std::f64::consts::PI * (40.0 * 40.0 - 20.0 * 20.0);
        assert!((area(s) / want - 1.0).abs() < 0.01, "{} vs {want}", area(s));
    }

    /// A 200 px image: a black square, 25 black 2 px specks outside it and 25 white pinholes in it, from a seed.
    fn speckled() -> Raster {
        let mut seed = 0x2545_f491_u64;
        let mut rand = |n: u64| {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (seed >> 33) % n
        };
        let mut dots: Vec<(usize, usize, bool)> = Vec::new();
        while dots.len() < 50 {
            // cells 5 px apart, so no two dots and no dot and the square edge touch
            let (cx, cy) = (rand(39) as usize * 5 + 5, rand(39) as usize * 5 + 5);
            let inner = (55..=140).contains(&cx) && (55..=140).contains(&cy);
            let outer = !(45..=150).contains(&cx) || !(45..=150).contains(&cy);
            let want_inner = dots.iter().filter(|d| d.2).count() < 25;
            let fits = if want_inner { inner } else { outer };
            if fits && !dots.iter().any(|d| d.0 == cx && d.1 == cy) {
                dots.push((cx, cy, want_inner));
            }
        }
        let mut px = vec![WHITE; 200 * 200];
        for y in 50..150 {
            for x in 50..150 {
                px[y * 200 + x] = BLACK;
            }
        }
        for (cx, cy, inner) in dots {
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                px[(cy + dy) * 200 + cx + dx] = if inner { WHITE } else { BLACK };
            }
        }
        Raster::new(200, 200, px).unwrap()
    }

    #[test]
    fn specks_and_pinholes_go_with_cleanup_and_stay_without() {
        let img = speckled();
        let raw = trace(&img, &opts()).unwrap();
        assert_eq!(raw.shapes.len(), 26);
        assert_eq!(raw.shapes.iter().map(|s| s.holes.len()).sum::<usize>(), 25);
        assert_eq!(raw.dropped, Dropped::default());
        let clean = trace(
            &img,
            &TraceOptions {
                speck_px: 5.0,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(clean.shapes.len(), 1);
        assert!(clean.shapes[0].holes.is_empty());
        assert_eq!(
            clean.dropped,
            Dropped {
                specks: 25,
                holes: 25
            }
        );
        assert!((area(&clean.shapes[0]) - 10_000.0).abs() < 1.0);
        // a region of exactly the limit stays
        let kept = trace(
            &img,
            &TraceOptions {
                speck_px: 4.0,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(kept.dropped, Dropped::default());
    }

    #[test]
    fn picking_red_traces_only_the_red_disk() {
        let red = [220, 30, 40, 255];
        let blue = [30, 60, 210, 255];
        let img = draw(160, 100, WHITE, |x, y| {
            if (x - 40.0).m_hypot(y - 50.0) < 25.0 {
                Some(red)
            } else if (90.0..140.0).contains(&x) && (25.0..75.0).contains(&y) {
                Some(blue)
            } else {
                None
            }
        });
        let pick = |colors: Vec<[u8; 3]>| {
            trace(
                &img,
                &TraceOptions {
                    mode: Mode::Color,
                    colors,
                    ..opts()
                },
            )
            .unwrap()
        };
        let t = pick(vec![[220, 30, 40]]);
        assert_eq!(t.mode, Mode::Color);
        assert_eq!(t.shapes.len(), 1);
        let b = bbox(&t.shapes[0].outer);
        assert!((b[0] - 15.0).abs() < 1.0 && (b[2] - 65.0).abs() < 1.0, "{b:?}");
        let want = std::f64::consts::PI * 625.0;
        assert!(
            (area(&t.shapes[0]) / want - 1.0).abs() < 0.04,
            "{}",
            area(&t.shapes[0])
        );
        assert_eq!(pick(vec![[220, 30, 40], [30, 60, 210]]).shapes.len(), 2);
        // a near shade is within the tolerance
        assert_eq!(pick(vec![[210, 40, 50]]).shapes.len(), 1);
    }

    #[test]
    fn a_45_degree_edge_is_straight_to_a_tenth_of_a_pixel() {
        // the lower left triangle of a 100 px square, image y down: inside where y > x
        let img = draw(120, 120, WHITE, |x, y| {
            ((10.0..110.0).contains(&x) && (10.0..110.0).contains(&y) && y - 10.0 > x - 10.0).then_some(BLACK)
        });
        let dark = TraceOptions {
            mode: Mode::Dark,
            threshold: Some(127.0),
            ..opts()
        };
        let t = trace(&img, &dark).unwrap();
        assert_eq!(t.shapes.len(), 1);
        // in y up the diagonal is x + y = 120
        let worst = t.shapes[0]
            .outer
            .iter()
            .filter(|p| p[0] > 15.0 && p[0] < 105.0 && p[1] > 15.0 && p[1] < 105.0)
            .map(|p| (p[0] + p[1] - 120.0).abs() / 2f64.sqrt())
            .fold(0.0, f64::max);
        assert!(worst < 0.1, "{worst}");
    }

    #[test]
    fn a_png_with_transparency_traces_its_opaque_part() {
        // a light gray square on a clear white background: dark misses it and light takes the background
        let mut rgba = [255u8, 255, 255, 0].repeat(60 * 60);
        for y in 10..50 {
            for x in 10..50 {
                rgba[(y * 60 + x) * 4..(y * 60 + x + 1) * 4].copy_from_slice(&[230, 230, 230, 255]);
            }
        }
        let file = png(60, 60, 4, &rgba, None);
        let t = trace_bytes(&file, &opts()).unwrap();
        assert_eq!(t.mode, Mode::Alpha);
        assert_eq!(t.shapes.len(), 1);
        assert!((area(&t.shapes[0]) - 1600.0).abs() < 1.0);
        // clear pixels stay outside whatever their color
        let light = trace_bytes(
            &file,
            &TraceOptions {
                mode: Mode::Light,
                threshold: Some(100.0),
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(light.shapes.len(), 1);
        assert!((area(&light.shapes[0]) - 1600.0).abs() < 1.0);
        assert!(
            trace_bytes(
                &file,
                &TraceOptions {
                    mode: Mode::Dark,
                    threshold: Some(100.0),
                    ..opts()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn the_jpeg_fixture_traces_to_its_square() {
        let file = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/trace/square.jpg"
        ))
        .unwrap();
        let t = trace_bytes(&file, &opts()).unwrap();
        assert_eq!(t.image_px, [48, 32]);
        assert_eq!(t.shapes.len(), 1);
        let b = bbox(&t.shapes[0].outer);
        // x 4 to 20, rows 4 to 20 from the top: y 12 to 28 from the bottom
        for (got, want) in b.iter().zip([4.0, 12.0, 20.0, 28.0]) {
            assert!((got - want).abs() < 0.5, "{b:?}");
        }
    }

    #[test]
    fn diagonal_neighbors_join_inside_and_split_outside() {
        // two inside pixels touching at a corner are one region; two outside ones are two holes
        let mut f = Field {
            w: 2,
            h: 2,
            v: vec![1.0, -1.0, -1.0, 1.0],
        };
        let s = contours(&f).unwrap();
        assert_eq!(s.len(), 1);
        assert!(s[0].holes.is_empty());
        let mut block = vec![1.0f32; 16];
        block[5] = -1.0;
        block[10] = -1.0;
        f = Field { w: 4, h: 4, v: block };
        let s = contours(&f).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].holes.len(), 2);
        // and the cleanup counts them the same way
        assert_eq!(despeckle(&mut f.clone(), 2.0), Dropped { specks: 0, holes: 2 });
    }

    #[test]
    fn bad_input_is_refused_with_a_reason() {
        let msg = |r: Result<Traced>| r.unwrap_err().to_string();
        assert!(msg(trace_bytes(b"GIF89a", &opts())).contains("not a PNG or JPEG"));
        let white = Raster::new(8, 8, vec![WHITE; 64]).unwrap();
        assert!(msg(trace(&white, &opts())).contains("one flat tone"));
        let light = TraceOptions {
            mode: Mode::Dark,
            threshold: Some(10.0),
            ..opts()
        };
        assert!(msg(trace(&white, &light)).contains("nothing is inside"));
        let color = TraceOptions {
            mode: Mode::Color,
            ..opts()
        };
        assert!(msg(trace(&white, &color)).contains("pick a color"));
        // a color the image does not have names the color mode's own settings
        let red = TraceOptions {
            colors: vec![[255, 0, 0]],
            color_tolerance: 0.0,
            ..color.clone()
        };
        assert_eq!(
            msg(trace(&white, &red)),
            "image: nothing is near the picked colors; pick another color or raise the tolerance"
        );
        let nine = TraceOptions {
            colors: vec![[0, 0, 0]; 9],
            ..color
        };
        assert!(msg(trace(&white, &nine)).contains("at most 8"));
        let big = TraceOptions {
            max_side_px: 5000,
            ..opts()
        };
        assert!(msg(trace(&white, &big)).contains("working size"));
        // every other pixel of every other row: 2500 separate dots
        let mut px = vec![WHITE; 100 * 100];
        for y in (0..100).step_by(2) {
            for x in (0..100).step_by(2) {
                px[y * 100 + x] = BLACK;
            }
        }
        let dots = Raster::new(100, 100, px).unwrap();
        assert_eq!(
            msg(trace(&dots, &opts())),
            "image: more than 2000 loops; raise Remove specks under, or use a simpler image"
        );
        assert!(
            msg(trace(
                &dots,
                &TraceOptions {
                    speck_px: 2.0,
                    ..opts()
                }
            ))
            .contains("nothing is inside")
        );
    }

    #[test]
    fn the_same_image_traces_the_same_twice_and_reduces_to_the_working_size() {
        let img = draw(300, 200, WHITE, |x, y| {
            ((x - 150.0).m_hypot(y - 100.0) < 80.0).then_some(BLACK)
        });
        let o = TraceOptions {
            max_side_px: 100,
            ..opts()
        };
        let a = trace(&img, &o).unwrap();
        assert_eq!(a, trace(&img, &o).unwrap());
        assert_eq!(a.working_px, [100, 67]);
        assert_eq!(a.image_px, [300, 200]);
        assert_eq!(a.shapes.len(), 1);
    }

    /// A field of `n` single inside pixels two apart, in rows of 50.
    fn dots(n: usize) -> Field {
        let (w, h) = (100, n.div_ceil(50) * 2);
        let mut v = vec![-0.5f32; w * h];
        for i in 0..n {
            v[(i / 50) * 2 * w + (i % 50) * 2] = 0.5;
        }
        Field { w, h, v }
    }

    #[test]
    fn exactly_the_ring_limit_traces_and_one_more_is_refused() {
        assert_eq!(contours(&dots(MAX_LOOPS)).unwrap().len(), MAX_LOOPS);
        assert!(contours(&dots(MAX_LOOPS + 1)).is_err());
        // holes count too: one block with 1999 pinholes is 2000 rings
        let (w, h) = (100, 86);
        let mut v = vec![0.5f32; w * h];
        for i in 0..MAX_LOOPS {
            v[(1 + (i / 48) * 2) * w + 1 + (i % 48) * 2] = -0.5;
        }
        assert!(contours(&Field { w, h, v: v.clone() }).is_err());
        v[w + 1] = 0.5;
        let s = contours(&Field { w, h, v }).unwrap();
        assert_eq!((s.len(), s[0].holes.len()), (1, MAX_LOOPS - 1));
    }

    #[test]
    fn a_4096_checkerboard_is_refused_before_its_crossings_are_kept() {
        let n = 4096;
        let v = (0..n * n)
            .map(|i| if (i % n + i / n) % 2 == 0 { 0.5 } else { -0.5 })
            .collect();
        let f = Field { w: n, h: n, v };
        let t = std::time::Instant::now();
        assert_eq!(contours(&f).unwrap_err().to_string(), TOO_DETAILED);
        // keeping its 33 million crossings took seconds and gigabytes; a loose bound for a debug build
        assert!(t.elapsed().as_secs_f64() < 10.0, "{:?}", t.elapsed());
    }

    #[test]
    fn a_shape_touching_the_image_edge_reaches_it() {
        let all = Field {
            w: 30,
            h: 20,
            v: vec![0.5; 600],
        };
        let s = contours(&all).unwrap();
        let b = bbox(&s[0].outer);
        for (got, want) in b.iter().zip([0.0, 0.0, 30.0, 20.0]) {
            assert!((got - want).abs() < 1e-9, "{b:?}");
        }
        // a square flush with the top left corner of the image, in y up from 25 to 40
        let img = draw(40, 40, WHITE, |x, y| (x < 15.0 && y < 15.0).then_some(BLACK));
        let t = trace(&img, &opts()).unwrap();
        let b = bbox(&t.shapes[0].outer);
        for (got, want) in b.iter().zip([0.0, 25.0, 15.0, 40.0]) {
            assert!((got - want).abs() < 0.01, "{b:?}");
        }
        assert!((area(&t.shapes[0]) - 225.0).abs() < 0.6, "{}", area(&t.shapes[0]));
    }

    #[test]
    fn a_tolerance_of_0_picks_exactly_the_color_and_a_tight_one_leaves_a_near_shade() {
        let mut px = vec![WHITE; 100];
        for p in &mut px[..30] {
            *p = [220, 30, 40, 255];
        }
        for p in &mut px[60..70] {
            *p = [210, 40, 50, 255];
        }
        let img = Raster::new(10, 10, px).unwrap();
        let pick = |color_tolerance: f64| {
            trace(
                &img,
                &TraceOptions {
                    mode: Mode::Color,
                    colors: vec![[220, 30, 40]],
                    color_tolerance,
                    ..opts()
                },
            )
            .unwrap()
        };
        let exact = pick(0.0);
        assert_eq!(exact.shapes.len(), 1);
        assert!((area(&exact.shapes[0]) - 30.0).abs() < 1.0);
        assert_eq!(pick(1.0).shapes.len(), 1);
        assert_eq!(pick(12.0).shapes.len(), 2);
    }

    #[test]
    fn every_bad_option_is_refused_with_its_reason() {
        let img = draw(20, 20, WHITE, |x, y| {
            (x > 5.0 && y > 5.0 && x < 15.0 && y < 15.0).then_some(BLACK)
        });
        let color = |colors: usize, color_tolerance: f64| TraceOptions {
            mode: Mode::Color,
            colors: vec![[0, 0, 0]; colors],
            color_tolerance,
            ..opts()
        };
        let dark = |t: f64| TraceOptions {
            mode: Mode::Dark,
            threshold: Some(t),
            ..opts()
        };
        let cases = [
            (dark(256.0), "argument: the threshold is 0 to 255"),
            (dark(f64::NAN), "argument: the threshold is 0 to 255"),
            (dark(-1.0), "argument: the threshold is 0 to 255"),
            (
                TraceOptions {
                    speck_px: -1.0,
                    ..opts()
                },
                "argument: the speck size is 0 or more",
            ),
            (
                TraceOptions {
                    speck_px: f64::NAN,
                    ..opts()
                },
                "argument: the speck size is 0 or more",
            ),
            (
                TraceOptions {
                    max_side_px: 0,
                    ..opts()
                },
                "argument: the working size is 1 to 4096 px",
            ),
            (color(1, -1.0), "argument: the color tolerance is 0 to 100"),
            (color(1, f64::NAN), "argument: the color tolerance is 0 to 100"),
            (color(1, 1e10), "argument: the color tolerance is 0 to 100"),
            (color(9, 12.0), "argument: pick at most 8 colors"),
        ];
        for (o, want) in cases {
            assert_eq!(trace(&img, &o).unwrap_err().to_string(), want);
        }
        assert_eq!(trace(&img, &color(8, 12.0)).unwrap().shapes.len(), 1);
    }

    #[test]
    fn light_takes_the_light_side_of_the_automatic_threshold() {
        let img = draw(40, 40, BLACK, |x, y| {
            ((10.0..30.0).contains(&x) && (10.0..30.0).contains(&y)).then_some(WHITE)
        });
        let t = trace(
            &img,
            &TraceOptions {
                mode: Mode::Light,
                ..opts()
            },
        )
        .unwrap();
        assert_eq!(t.threshold, Some(127.0));
        assert_eq!(t.shapes.len(), 1);
        assert!((area(&t.shapes[0]) - 400.0).abs() < 1.0);
    }

    #[test]
    fn a_half_clear_dark_pixel_is_outside_in_dark_mode() {
        let mut px = vec![WHITE; 25];
        px[12] = [0, 0, 0, 100];
        px[6] = BLACK;
        let img = Raster::new(5, 5, px).unwrap();
        let t = trace(
            &img,
            &TraceOptions {
                mode: Mode::Dark,
                threshold: Some(127.0),
                ..opts()
            },
        )
        .unwrap();
        // the black pixel alone, not joined to its half clear neighbor at the corner
        assert_eq!(t.shapes.len(), 1);
        assert!(area(&t.shapes[0]) < 0.75, "{}", area(&t.shapes[0]));
    }

    #[test]
    fn cleanup_joins_specks_at_corners_and_leaves_background_at_the_edge() {
        // two pixels touching at a corner are one 2 px region, kept at a limit of 2
        let mut f = Field {
            w: 6,
            h: 6,
            v: vec![-0.5; 36],
        };
        f.v[2 * 6 + 2] = 0.5;
        f.v[3 * 6 + 3] = 0.5;
        assert_eq!(despeckle(&mut f.clone(), 2.0), Dropped::default());
        assert_eq!(despeckle(&mut f, 3.0), Dropped { specks: 1, holes: 0 });
        // a white notch on the image edge is background; one pixel inside is a hole
        let mut f = Field {
            w: 6,
            h: 6,
            v: vec![0.5; 36],
        };
        f.v[3] = -0.5;
        assert_eq!(despeckle(&mut f.clone(), 4.0), Dropped::default());
        f.v[3 * 6 + 3] = -0.5;
        assert_eq!(despeckle(&mut f, 4.0), Dropped { specks: 0, holes: 1 });
        // a speck in a small hole goes, and then the hole is filled
        let mut f = Field {
            w: 9,
            h: 9,
            v: vec![0.5; 81],
        };
        for y in 3..6 {
            for x in 3..6 {
                f.v[y * 9 + x] = -0.5;
            }
        }
        f.v[4 * 9 + 4] = 0.5;
        assert_eq!(despeckle(&mut f, 10.0), Dropped { specks: 1, holes: 1 });
        assert!(f.v.iter().all(|&v| v > 0.0));
    }

    const TOO_DETAILED: &str =
        "image: the outlines are too detailed to trace; raise Remove specks under, or use a simpler image";

    #[test]
    fn a_4096_comb_of_one_region_is_refused_before_its_crossings_are_kept() {
        // one region: a solid top band and a tooth in every other column, 16 million crossings
        let n = 4096;
        let v: Vec<f32> = (0..n * n)
            .map(|i| {
                if i / n >= n - 8 || (i % n) % 2 == 0 {
                    0.5
                } else {
                    -0.5
                }
            })
            .collect();
        let f = Field { w: n, h: n, v };
        let mut labels = Vec::new();
        assert_eq!(label(&f, true, &mut labels, usize::MAX).unwrap().len(), 1);
        drop(labels);
        assert!(crossings(&f) > MAX_CROSSINGS);
        let t = std::time::Instant::now();
        assert_eq!(contours(&f).unwrap_err().to_string(), TOO_DETAILED);
        assert!(t.elapsed().as_secs_f64() < 10.0, "{:?}", t.elapsed());
    }

    #[test]
    fn the_crossing_count_is_every_pixel_side_between_inside_and_outside() {
        // one pixel: four sides, the image edge included
        assert_eq!(
            crossings(&Field {
                w: 1,
                h: 1,
                v: vec![0.5]
            }),
            4
        );
        assert_eq!(
            crossings(&Field {
                w: 3,
                h: 2,
                v: vec![0.5; 6]
            }),
            10
        );
        assert_eq!(
            crossings(&Field {
                w: 3,
                h: 2,
                v: vec![-0.5; 6]
            }),
            0
        );
        let f = dots(MAX_LOOPS);
        assert_eq!(crossings(&f), 4 * MAX_LOOPS);
        // what contours keeps is exactly what was counted
        let points: usize = contours(&f)
            .unwrap()
            .iter()
            .map(|s| s.outer.len() + s.holes.iter().map(Vec::len).sum::<usize>())
            .sum();
        assert_eq!(points, crossings(&f));
    }

    #[test]
    fn isolated_dots_across_a_4096_image_are_refused_on_the_ring_count() {
        // 8192 single pixels, far under the crossing limit, so the inside count trips
        let (w, h) = (4096, 8);
        let v = (0..w * h)
            .map(|i| {
                if (i % w) % 2 == 0 && (i / w) % 2 == 0 {
                    0.5
                } else {
                    -0.5
                }
            })
            .collect();
        let f = Field { w, h, v };
        assert!(crossings(&f) < MAX_CROSSINGS);
        assert_eq!(
            contours(&f).unwrap_err().to_string(),
            "image: more than 2000 loops; raise Remove specks under, or use a simpler image"
        );
    }

    /// The field value of one pixel of `c` when `pick` is picked at `tolerance`.
    fn color_value(c: [u8; 3], pick: [u8; 3], tolerance: f64) -> f32 {
        let img = Raster::new(1, 1, vec![[c[0], c[1], c[2], 255]]).unwrap();
        let o = TraceOptions {
            mode: Mode::Color,
            colors: vec![pick],
            color_tolerance: tolerance,
            ..opts()
        };
        field(&img, &o).unwrap().0.v[0]
    }

    #[test]
    fn the_color_value_steps_down_from_the_pick_to_the_tolerance_and_out_over_a_band() {
        let (pick, near) = ([220, 30, 40], [140, 110, 120]);
        let lut = linear_lut();
        let (a, b) = (oklab(&lut, pick), oklab(&lut, near));
        let (x, y, z) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        let d = (x * x + y * y + z * z).sqrt();
        assert!(d > 13.0 && d < 40.0, "{d}");
        let d = f64::from(d);
        let at = |tol: f64| color_value(near, pick, tol);
        let close = |got: f32, want: f32| (got - want).abs() < 1e-3;
        assert!(close(color_value(pick, pick, 0.0), 0.5));
        // within half the tolerance, full; at the tolerance, a quarter; just past it, about 0
        assert!(close(at(2.0 * d), 0.5), "{}", at(2.0 * d));
        assert!(close(at(1.5 * d), 0.5 - 0.25 / 3.0), "{}", at(1.5 * d));
        assert!(close(at(d), 0.25), "{}", at(d));
        assert!(at(d - 0.01) < 0.0 && at(d - 0.01) > -0.01, "{}", at(d - 0.01));
        // past it, half way out at 6 and fully out at 12
        assert!(close(at(d - 6.0), -0.25), "{}", at(d - 6.0));
        assert!(close(at(d - 12.0), -0.5), "{}", at(d - 12.0));
        assert!(close(at(0.0), -0.5));
    }

    #[test]
    fn a_picked_color_on_a_far_one_has_its_edge_halfway_at_any_tolerance() {
        let red = [220, 30, 40, 255];
        let img = draw(20, 20, BLACK, |x, y| {
            ((5.0..15.0).contains(&x) && (5.0..15.0).contains(&y)).then_some(red)
        });
        // black is 61 away, past 40 and its band
        for tol in [0.0, 12.0, 40.0] {
            let t = trace(
                &img,
                &TraceOptions {
                    mode: Mode::Color,
                    colors: vec![[220, 30, 40]],
                    color_tolerance: tol,
                    ..opts()
                },
            )
            .unwrap();
            assert_eq!(t.shapes.len(), 1, "{tol}");
            // 100 less the four cut corners
            assert!(
                (area(&t.shapes[0]) - 99.5).abs() < 0.1,
                "{tol}: {}",
                area(&t.shapes[0])
            );
        }
    }

    #[test]
    fn the_largest_tolerance_is_taken_and_takes_in_the_whole_image() {
        let mut px = vec![[220, 30, 40, 255]; 200];
        px[57] = BLACK;
        px[123] = WHITE;
        let img = Raster::new(20, 10, px).unwrap();
        let color = |color_tolerance: f64| TraceOptions {
            mode: Mode::Color,
            colors: vec![[220, 30, 40]],
            color_tolerance,
            ..opts()
        };
        let t = trace(&img, &color(MAX_TOLERANCE)).unwrap();
        assert_eq!(t.shapes.len(), 1);
        assert!(t.shapes[0].holes.is_empty());
        let b = bbox(&t.shapes[0].outer);
        for (got, want) in b.iter().zip([0.0, 0.0, 20.0, 10.0]) {
            assert!((got - want).abs() < 1e-6, "{b:?}");
        }
        assert_eq!(
            trace(&img, &color(MAX_TOLERANCE + 1e-4)).unwrap_err().to_string(),
            "argument: the color tolerance is 0 to 100"
        );
    }

    fn sk(img: &Raster, o: &SketchTraceOptions) -> SketchTrace {
        let r = sketch_trace(Cow::Borrowed(img), o).unwrap();
        assert!(r.check.ok, "{:?}", r.check.issues);
        r
    }

    /// Fit to a width of `w` px in mm, so a working px is a mm.
    fn mm_px(w: f64) -> SketchTraceOptions {
        SketchTraceOptions {
            width_mm: Some(w),
            speck_mm2: 0.0,
            ..SketchTraceOptions::default()
        }
    }

    fn kinds(l: &Loop) -> Vec<&str> {
        l.segments.iter().map(|s| s.kind.as_str()).collect()
    }

    #[test]
    fn a_square_is_one_loop_of_four_lines_with_its_corners_in_place() {
        let img = draw(140, 140, WHITE, |x, y| {
            ((20.0..120.0).contains(&x) && (20.0..120.0).contains(&y)).then_some(BLACK)
        });
        let r = sk(&img, &mm_px(100.0));
        assert_eq!(r.loops.len(), 1);
        assert_eq!(kinds(&r.loops[0]), ["line"; 4]);
        assert_eq!(
            r.counts,
            Counts {
                lines: 4,
                arcs: 0,
                splines: 0,
                circles: 0
            }
        );
        // the middle lands on the origin; every corner within half a px of the square's
        let mut corners: Vec<V2> = r.loops[0].segments.iter().filter_map(|s| s.to).collect();
        corners.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for (got, want) in corners
            .iter()
            .zip([[-50.0, -50.0], [-50.0, 50.0], [50.0, -50.0], [50.0, 50.0]])
        {
            assert!(sketch_fit::dist(*got, want) < 0.5, "{corners:?}");
        }
        assert!(
            (r.size_mm[0] - 100.0).abs() < 0.5 && (r.check.area_mm2 - 10_000.0).abs() < 50.0,
            "{r:?}"
        );
        assert_eq!(r.image_px, [140, 140]);
        assert!((r.mm_per_px - 1.0).abs() < 0.01, "{}", r.mm_per_px);
    }

    #[test]
    fn a_circle_is_one_circle_loop_within_one_percent() {
        let img = draw(120, 120, WHITE, |x, y| {
            ((x - 60.0).m_hypot(y - 60.0) < 40.0).then_some(BLACK)
        });
        let r = sk(
            &img,
            &SketchTraceOptions {
                mm_per_px: Some(1.0),
                speck_mm2: 0.0,
                ..SketchTraceOptions::default()
            },
        );
        assert_eq!(r.loops.len(), 1);
        assert_eq!(r.loops[0].kind.as_deref(), Some("circle"));
        let d = r.loops[0].diameter_mm.unwrap();
        assert!((d - 80.0).abs() < 0.8, "{d}");
        assert_eq!(r.counts.circles, 1);
    }

    #[test]
    fn a_ring_is_an_outer_loop_and_a_hole_with_the_area_within_one_percent() {
        let img = draw(120, 120, WHITE, |x, y| {
            (20.0..40.0)
                .contains(&(x - 60.0).m_hypot(y - 60.0))
                .then_some(BLACK)
        });
        let r = sk(
            &img,
            &SketchTraceOptions {
                mm_per_px: Some(1.0),
                speck_mm2: 0.0,
                ..SketchTraceOptions::default()
            },
        );
        assert_eq!(r.loops.len(), 2);
        let roles: Vec<_> = r.check.loops.iter().map(|l| l.role).collect();
        assert_eq!(roles, [sketch::Role::Outer, sketch::Role::Hole]);
        let want = std::f64::consts::PI * (40.0 * 40.0 - 20.0 * 20.0);
        assert!(
            (r.check.area_mm2 / want - 1.0).abs() < 0.01,
            "{}",
            r.check.area_mm2
        );
    }

    #[test]
    fn specks_under_the_size_in_mm2_go_and_their_counts_come_back() {
        // the speckled image's square is 100 px; at 1 mm a px, its 4 px specks and pinholes are 4 mm2
        let img = speckled();
        let at = |speck_mm2: f64| SketchTraceOptions {
            width_mm: Some(100.0),
            speck_mm2,
            ..SketchTraceOptions::default()
        };
        let clean = sk(&img, &at(5.0));
        assert_eq!(clean.loops.len(), 1);
        assert_eq!(
            clean.dropped,
            Dropped {
                specks: 25,
                holes: 25
            }
        );
        let kept = sk(&img, &at(3.0));
        assert_eq!(kept.loops.len(), 51);
        assert_eq!(kept.dropped, Dropped::default());
        // the same specks at twice the size are 16 mm2
        let big = SketchTraceOptions {
            width_mm: Some(200.0),
            speck_mm2: 10.0,
            ..SketchTraceOptions::default()
        };
        assert_eq!(sk(&img, &big).dropped, Dropped::default());
    }

    #[test]
    fn picking_red_traces_the_red_disk_as_a_circle() {
        let red = [220, 30, 40, 255];
        let img = draw(160, 100, WHITE, |x, y| {
            if (x - 40.0).m_hypot(y - 50.0) < 25.0 {
                Some(red)
            } else if (90.0..140.0).contains(&x) && (25.0..75.0).contains(&y) {
                Some([30, 60, 210, 255])
            } else {
                None
            }
        });
        let o = SketchTraceOptions {
            mode: Mode::Color,
            colors: vec!["#dc1e28".into()],
            ..mm_px(50.0)
        };
        let r = sk(&img, &o);
        assert_eq!(r.loops.len(), 1);
        assert_eq!(r.loops[0].kind.as_deref(), Some("circle"));
        assert!(
            (r.loops[0].diameter_mm.unwrap() - 50.0).abs() < 1.0,
            "{:?}",
            r.loops[0]
        );
    }

    #[test]
    fn a_45_degree_edge_is_one_line_with_no_staircase() {
        let img = draw(120, 120, WHITE, |x, y| {
            ((10.0..110.0).contains(&x) && (10.0..110.0).contains(&y) && y > x).then_some(BLACK)
        });
        let r = sk(&img, &mm_px(100.0));
        assert_eq!(kinds(&r.loops[0]), ["line"; 3]);
    }

    #[test]
    fn fit_to_lines_makes_no_curves_and_lines_and_arcs_no_splines() {
        // a disk with a bite out of it: round runs between two corners
        let img = draw(120, 120, WHITE, |x, y| {
            ((x - 60.0).m_hypot(y - 60.0) < 40.0 && !(x > 60.0 && y > 60.0)).then_some(BLACK)
        });
        let lines = sk(
            &img,
            &SketchTraceOptions {
                fit: Fit::Lines,
                ..mm_px(80.0)
            },
        );
        assert!(
            lines.counts.lines > 8 && lines.counts.arcs + lines.counts.splines + lines.counts.circles == 0,
            "{:?}",
            lines.counts
        );
        let arcs = sk(
            &img,
            &SketchTraceOptions {
                fit: Fit::Arcs,
                ..mm_px(80.0)
            },
        );
        assert_eq!(arcs.counts.splines, 0);
        assert!(arcs.counts.arcs >= 1, "{:?}", arcs.counts);
        assert!(
            arcs.counts.lines + arcs.counts.arcs < lines.counts.lines,
            "{:?} {:?}",
            arcs.counts,
            lines.counts
        );
    }

    #[test]
    fn smoothing_bounds_how_far_the_loops_stray_from_the_traced_edge() {
        // a wavy blob: every fitted point stays within Smoothing of the traced rings
        let img = draw(160, 160, WHITE, |x, y| {
            let (dx, dy) = (x - 80.0, y - 80.0);
            let a = dy.m_atan2(dx);
            (dx.m_hypot(dy) < 50.0 + 8.0 * (5.0 * a).m_sin()).then_some(BLACK)
        });
        for smoothing in [0.2, 1.0] {
            let o = SketchTraceOptions {
                smoothing_mm: Some(smoothing),
                mm_per_px: Some(1.0),
                speck_mm2: 0.0,
                ..SketchTraceOptions::default()
            };
            let r = sk(&img, &o);
            let traced = trace(&img, &TraceOptions::default()).unwrap();
            let [k, dx, dy] = r.px_to_mm;
            let ring: Vec<V2> = traced.shapes[0]
                .outer
                .iter()
                .map(|p| [k * p[0] + dx, k * p[1] + dy])
                .collect();
            let drawn = &r.check.polygons[0].outer;
            let off = drawn
                .iter()
                .map(|&p| {
                    (0..ring.len())
                        .map(|i| sketch_fit::to_segment(p, ring[i], ring[(i + 1) % ring.len()]))
                        .fold(f64::INFINITY, f64::min)
                })
                .fold(0.0, f64::max);
            // the drawn curve is flattened finely and checked at a few points a span, so a little over
            assert!(off < 1.5 * smoothing, "{smoothing}: {off}");
            assert!(r.counts.splines > 0, "{:?}", r.counts);
        }
    }

    #[test]
    fn a_png_with_transparency_and_the_jpeg_fixture_trace() {
        let mut rgba = [255u8, 255, 255, 0].repeat(60 * 60);
        for y in 10..50 {
            for x in 10..50 {
                rgba[(y * 60 + x) * 4..(y * 60 + x + 1) * 4].copy_from_slice(&[230, 230, 230, 255]);
            }
        }
        let r = sketch_trace_bytes(&png(60, 60, 4, &rgba, None), &mm_px(40.0)).unwrap();
        assert_eq!(r.mode, Mode::Alpha);
        assert_eq!(kinds(&r.loops[0]), ["line"; 4]);
        let jpeg = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/trace/square.jpg"
        ))
        .unwrap();
        let j = sketch_trace_bytes(&jpeg, &mm_px(16.0)).unwrap();
        assert!(j.check.ok);
        assert_eq!(j.image_px, [48, 32]);
        assert_eq!(kinds(&j.loops[0]), ["line"; 4]);
    }

    #[test]
    fn the_size_comes_from_a_width_a_height_or_a_pixel_size_and_the_middle_lands_at_the_center() {
        let img = draw(300, 200, WHITE, |x, y| {
            ((50.0..250.0).contains(&x) && (50.0..150.0).contains(&y)).then_some(BLACK)
        });
        let w = sk(
            &img,
            &SketchTraceOptions {
                center: [100.0, 50.0],
                ..SketchTraceOptions::default()
            },
        );
        assert!(
            (w.size_mm[0] - 50.0).abs() < 1e-6 && (w.size_mm[1] - 25.0).abs() < 0.2,
            "{:?}",
            w.size_mm
        );
        let mid = |r: &SketchTrace| {
            let b = r.check.polygons[0]
                .outer
                .iter()
                .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
                    [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
                });
            [f64::midpoint(b[0], b[2]), f64::midpoint(b[1], b[3])]
        };
        assert!(sketch_fit::dist(mid(&w), [100.0, 50.0]) < 0.05, "{:?}", mid(&w));
        let h = sk(
            &img,
            &SketchTraceOptions {
                height_mm: Some(10.0),
                ..SketchTraceOptions::default()
            },
        );
        assert!((h.size_mm[1] - 10.0).abs() < 1e-6, "{:?}", h.size_mm);
        // a pixel size is of the image as the file has it, at any working size
        let p = sk(
            &img,
            &SketchTraceOptions {
                mm_per_px: Some(0.1),
                max_side_px: 100,
                ..SketchTraceOptions::default()
            },
        );
        assert_eq!(p.working_px, [100, 67]);
        assert!((p.size_mm[0] - 20.0).abs() < 0.4, "{:?}", p.size_mm);
        assert!((p.mm_per_px - 0.1).abs() < 1e-9);
    }

    #[test]
    fn bad_options_and_images_are_refused_with_a_reason() {
        let img = draw(20, 20, WHITE, |x, y| {
            (x > 5.0 && y > 5.0 && x < 15.0 && y < 15.0).then_some(BLACK)
        });
        let msg = |o: SketchTraceOptions| sketch_trace(Cow::Borrowed(&img), &o).unwrap_err().to_string();
        let d = SketchTraceOptions::default;
        assert_eq!(
            msg(SketchTraceOptions {
                colors: vec!["red".into()],
                ..d()
            }),
            "colors: red is not a #rrggbb color"
        );
        assert_eq!(
            msg(SketchTraceOptions {
                width_mm: Some(1.0),
                height_mm: Some(1.0),
                ..d()
            }),
            "size: set one of widthMm, heightMm and mmPerPx"
        );
        assert_eq!(
            msg(SketchTraceOptions {
                smoothing_mm: Some(0.001),
                ..d()
            }),
            "smoothingMm: between 0.01 and 10 mm"
        );
        assert_eq!(
            msg(SketchTraceOptions {
                corner_angle_deg: 0.0,
                ..d()
            }),
            "cornerAngleDeg: between 1 and 179 degrees"
        );
        assert_eq!(
            msg(SketchTraceOptions {
                mm_per_px: Some(0.0),
                ..d()
            }),
            "mmPerPx: between 0 and 100 mm"
        );
        assert_eq!(
            msg(SketchTraceOptions {
                speck_mm2: -1.0,
                ..d()
            }),
            "speckMm2: 0 or more"
        );
        assert_eq!(
            msg(SketchTraceOptions {
                center: [1e9, 0.0],
                ..d()
            }),
            "center: within 10000 mm of the origin"
        );
        let white = Raster::new(8, 8, vec![WHITE; 64]).unwrap();
        assert!(
            sketch_trace(Cow::Borrowed(&white), &d())
                .unwrap_err()
                .to_string()
                .contains("one flat tone")
        );
        assert!(
            sketch_trace_bytes(b"GIF89a", &d())
                .unwrap_err()
                .to_string()
                .contains("not a PNG or JPEG")
        );
        // 2001 dots are too many loops; 1500 are fine but too many segments are refused past the limit
        let many = |n: usize| {
            let mut px = vec![WHITE; 200 * 200];
            for i in 0..n {
                let (x, y) = (2 + (i % 66) * 3, 2 + (i / 66) * 3);
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    px[(y + dy) * 200 + x + dx] = BLACK;
                }
            }
            Raster::new(200, 200, px).unwrap()
        };
        let o = SketchTraceOptions {
            speck_mm2: 0.0,
            mm_per_px: Some(1.0),
            ..d()
        };
        assert!(
            sketch_trace(Cow::Owned(many(2001)), &o)
                .unwrap_err()
                .to_string()
                .contains("more than 2000 loops")
        );
        assert_eq!(
            sketch_trace(Cow::Owned(many(1500)), &o).unwrap().loops.len(),
            1500
        );
    }

    #[test]
    fn the_same_image_traces_the_same_twice_and_the_preview_is_a_png() {
        let img = draw(160, 160, WHITE, |x, y| {
            let (dx, dy) = (x - 80.0, y - 80.0);
            (dx.m_hypot(dy) < 50.0 + 8.0 * (5.0 * dy.m_atan2(dx)).m_sin()).then_some(BLACK)
        });
        let o = SketchTraceOptions {
            preview_image: true,
            ..SketchTraceOptions::default()
        };
        let a = sk(&img, &o);
        assert_eq!(a, sk(&img, &o));
        let png = crate::json::base64_decode(a.preview_png.as_deref().unwrap()).unwrap();
        let back = raster::decode(&png).unwrap();
        assert_eq!((back.w, back.h), (160, 160));
        // the loops are drawn in the preview's line color
        assert!(back.px.contains(&[240, 40, 140, 255]));
    }

    #[test]
    fn budget_covers_a_busy_image_well_inside_its_limit() {
        // 576 blobs of every size with wavy edges, drawn without smoothing
        let n = 1200;
        let px = (0..n * n)
            .map(|i| {
                let (x, y) = ((i % n) as f64 + 0.5, (i / n) as f64 + 0.5);
                let (cx, cy) = ((x / 50.0).floor() * 50.0 + 25.0, (y / 50.0).floor() * 50.0 + 25.0);
                let (dx, dy) = (x - cx, y - cy);
                let r = 8.0 + ((cx * 7.0 + cy * 3.0) % 13.0);
                if dx.m_hypot(dy) < r + 2.0 * (4.0 * dy.m_atan2(dx)).m_sin() {
                    BLACK
                } else {
                    WHITE
                }
            })
            .collect();
        let img = Raster::new(n, n, px).unwrap();
        let mut budget = Budget(FIT_BUDGET);
        let traced = trace(&img, &TraceOptions::default()).unwrap();
        let o = SketchTraceOptions::default();
        for ring in traced
            .shapes
            .iter()
            .flat_map(|s| std::iter::once(&s.outer).chain(&s.holes))
        {
            fit_ring(ring, &o, 0.5, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], &[], &mut budget).unwrap();
        }
        let spent = FIT_BUDGET - budget.0;
        assert!(spent < FIT_BUDGET / 20, "{spent}");
        // and a budget too small for it stops with a reason
        let mut tiny = Budget(1000);
        let r = traced.shapes.iter().try_for_each(|s| {
            fit_ring(&s.outer, &o, 0.5, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], &[], &mut tiny).map(|_| ())
        });
        assert!(r.unwrap_err().to_string().contains("takes too long to trace"));
    }

    /// A grainy, busy image whose first fit crosses itself in places.
    fn grainy(w: usize, h: usize) -> Raster {
        let mut seed = 0x2545_f491_u32;
        let px = (0..w * h)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let (x, y) = ((i % w) as f64, (i / w) as f64);
                let wave = 60.0 * (x / 37.0).m_sin() * (y / 23.0).m_cos() + 40.0 * ((x + y) / 11.0).m_sin();
                let v = (128.0 + wave + f64::from(seed % 17) - 8.0).clamp(0.0, 255.0) as u8;
                [v, v, v, 255]
            })
            .collect();
        Raster::new(w, h, px).unwrap()
    }

    /// The traced rings of `img` with specks under `speck_px` dropped: how many, and their area and length in
    /// working px.
    fn traced_rings(img: &Raster, speck_px: f64) -> (usize, f64, f64) {
        let o = TraceOptions {
            speck_px,
            ..TraceOptions::default()
        };
        let t = trace(img, &o).unwrap();
        let rings: Vec<&Vec<V2>> = t
            .shapes
            .iter()
            .flat_map(|s| std::iter::once(&s.outer).chain(&s.holes))
            .collect();
        let length = rings
            .iter()
            .flat_map(|r| (0..r.len()).map(|i| sketch_fit::dist(r[i], r[(i + 1) % r.len()])))
            .sum();
        (rings.len(), t.shapes.iter().map(area).sum::<f64>().abs(), length)
    }

    /// Asserts that `r`, traced from `img` at `tol` working px with specks under `speck_px` dropped, kept every
    /// traced ring, and that its area is the traced area within `tol` along every edge.
    fn keeps_every_ring(img: &Raster, speck_px: f64, r: &SketchTrace, tol: f64, what: &str) {
        let (rings, area, length) = traced_rings(img, speck_px);
        assert!(
            r.check.ok,
            "{what}: {:?}",
            r.check.issues.iter().take(3).collect::<Vec<_>>()
        );
        assert_eq!(r.loops.len(), rings, "{what}");
        let k = r.px_to_mm[0];
        let got = r.check.area_mm2 / (k * k);
        assert!((got - area).abs() <= tol * length, "{what}: {got} against {area}");
    }

    /// A wavy blob with a hole of the same shape `wall` px inside its edge.
    fn rim(wall: f64) -> Raster {
        draw(160, 160, WHITE, |x, y| {
            let (dx, dy) = (x - 80.0, y - 80.0);
            let a = dy.m_atan2(dx);
            let edge = 6.0f64.mul_add((5.0 * a).m_sin(), 60.0) + 3.0 * (3.0 * a + 1.0).m_sin();
            let d = dx.m_hypot(dy);
            (d < edge && d > edge - wall).then_some(BLACK)
        })
    }

    #[test]
    fn a_thin_wall_between_an_outer_and_its_hole_never_crosses_and_keeps_both_loops() {
        // lines and arcs cut across the curves by up to the smoothing, through a wall thinner than that
        for wall in [0.8, 1.2, 2.0] {
            let img = rim(wall);
            for fit in [Fit::Lines, Fit::Arcs, Fit::Curves] {
                for smoothing in [0.5, 2.0, 3.0, 5.0] {
                    let o = SketchTraceOptions {
                        mm_per_px: Some(1.0),
                        speck_mm2: 0.0,
                        smoothing_mm: Some(smoothing),
                        fit,
                        ..SketchTraceOptions::default()
                    };
                    let r = sketch_trace(Cow::Borrowed(&img), &o).unwrap();
                    let what = format!("wall {wall}, {fit:?}, smoothing {smoothing}");
                    keeps_every_ring(&img, 0.0, &r, smoothing, &what);
                }
            }
        }
    }

    #[test]
    fn a_fit_that_crosses_is_fitted_again_until_the_sketch_checks_clean() {
        // a fixed pixel size, so specks of 0.5 mm2 are 200 px at every stage
        let o = SketchTraceOptions {
            mm_per_px: Some(0.05),
            ..SketchTraceOptions::default()
        };
        let img = grainy(1200, 900);
        let r = sketch_trace(Cow::Borrowed(&img), &o).unwrap();
        keeps_every_ring(&img, 200.0, &r, 0.5, "grainy");
        // the curves stay curves away from the crossings
        assert!(
            r.counts.splines + r.counts.arcs > r.counts.lines / 4,
            "{:?}",
            r.counts
        );
    }

    /// A square ring from `a` to `b` a point every px, turning `ccw` or not.
    fn square_ring(a: f64, b: f64, ccw: bool) -> Vec<V2> {
        let n = (b - a).round() as usize;
        let mut r = Vec::new();
        for i in 0..n {
            r.push([a + i as f64, a]);
        }
        for i in 0..n {
            r.push([b, a + i as f64]);
        }
        for i in 0..n {
            r.push([b - i as f64, b]);
        }
        for i in 0..n {
            r.push([a, b - i as f64]);
        }
        if !ccw {
            r.reverse();
        }
        r
    }

    /// A closed loop of lines through `pts`.
    fn lines(pts: &[V2]) -> Loop {
        let mut b = Builder::new(pts[0]);
        for &p in &pts[1..] {
            b.line(p);
        }
        b.finish(0.0).unwrap()
    }

    const PLACE: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    fn untangle(refits: u32, max_segments: usize) -> Untangle<'static> {
        static O: std::sync::LazyLock<SketchTraceOptions> =
            std::sync::LazyLock::new(SketchTraceOptions::default);
        Untangle {
            o: &O,
            tol: 0.5,
            place: PLACE,
            refits,
            max_segments,
        }
    }

    /// An outer square and its hole a px inside, the outer fitted as a diamond through the hole and the hole
    /// fitted as traced.
    fn crossed_pair() -> (Vec<Vec<V2>>, Vec<Option<Loop>>) {
        let (outer, hole) = (square_ring(0.0, 20.0, true), square_ring(1.0, 19.0, false));
        let diamond = lines(&[[10.0, -1.0], [21.0, 10.0], [10.0, 21.0], [-1.0, 10.0]]);
        let fitted = vec![Some(diamond), exact_ring(&hole, PLACE)];
        (vec![outer, hole], fitted)
    }

    #[test]
    fn both_loops_of_a_crossing_pair_are_fitted_again() {
        let (rings, mut fitted) = crossed_pair();
        let refs: Vec<&Vec<V2>> = rings.iter().collect();
        // the check names the hole, the later loop, but it is the outer that strays
        let before: Vec<Loop> = fitted.iter().flatten().cloned().collect();
        let first = sketch::check(&before);
        assert!(
            first
                .issues
                .iter()
                .all(|i| i.loop_index == 1 && i.other.map(|o| o.0) == Some(0)),
            "{:?}",
            first.issues
        );
        let rounds = untangle(REFITS, MAX_SEGMENTS)
            .run(&refs, &mut fitted, &mut Budget(FIT_BUDGET))
            .unwrap();
        assert_eq!(rounds, 1);
        let after: Vec<Loop> = fitted.iter().flatten().cloned().collect();
        assert_eq!(after.len(), 2);
        assert!(sketch::check(&after).ok);
        // the outer is fitted again, on its square
        for p in after[0].segments.iter().filter_map(|s| s.to) {
            let off = [p[0], 20.0 - p[0], p[1], 20.0 - p[1]].map(f64::abs);
            assert!(off.iter().copied().fold(f64::MAX, f64::min) <= 0.5, "{p:?}");
        }
    }

    #[test]
    fn a_crossing_left_at_the_last_round_is_kept_as_traced_or_refused_with_no_room() {
        let (rings, fitted) = crossed_pair();
        let refs: Vec<&Vec<V2>> = rings.iter().collect();
        let mut exact = fitted.clone();
        let rounds = untangle(1, MAX_SEGMENTS)
            .run(&refs, &mut exact, &mut Budget(FIT_BUDGET))
            .unwrap();
        assert_eq!(rounds, 1);
        let loops: Vec<Loop> = exact.into_iter().flatten().collect();
        assert_eq!(loops[0].segments.len(), rings[0].len());
        assert!(sketch::check(&loops).ok);
        // with no room for the traced points the trace is refused, never left crossing or short a loop
        let mut tight = fitted.clone();
        let err = untangle(1, 100)
            .run(&refs, &mut tight, &mut Budget(FIT_BUDGET))
            .unwrap_err();
        assert!(err.to_string().contains("too close together"), "{err}");
        // a ring with no fit is kept as traced
        let mut none = vec![None, fitted[1].clone()];
        untangle(REFITS, MAX_SEGMENTS)
            .run(&refs, &mut none, &mut Budget(FIT_BUDGET))
            .unwrap();
        assert_eq!(none[0].as_ref().map(|l| l.segments.len()), Some(rings[0].len()));
        // and one too small to draw is refused
        let speck = vec![[0.0, 0.0], [1e-5, 0.0], [0.0, 1e-5]];
        let err = untangle(REFITS, MAX_SEGMENTS)
            .run(&[&speck], &mut [None], &mut Budget(FIT_BUDGET))
            .unwrap_err();
        assert!(err.to_string().contains("too small to draw"), "{err}");
    }

    #[test]
    fn the_traced_points_of_a_concave_ring_with_sides_nearly_touching_check_clean() {
        // a square with a slot a twentieth of a px wide cut nearly through it, a point every px or so
        let corners: [V2; 8] = [
            [0.0, 0.0],
            [20.0, 0.0],
            [20.0, 20.0],
            [10.025, 20.0],
            [10.025, 1.0],
            [9.975, 1.0],
            [9.975, 20.0],
            [0.0, 20.0],
        ];
        let mut ring = Vec::new();
        for (k, &a) in corners.iter().enumerate() {
            let b = corners[(k + 1) % corners.len()];
            let n = sketch_fit::dist(a, b).ceil().max(1.0) as usize;
            ring.extend((0..n).map(|i| {
                let t = i as f64 / n as f64;
                [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
            }));
        }
        let exact = exact_ring(&ring, PLACE).unwrap();
        assert_eq!(exact.segments.len(), ring.len());
        let c = sketch::check(&[exact]);
        assert!(c.ok, "{:?}", c.issues);
    }

    #[test]
    fn a_crossing_that_takes_rounds_is_fitted_tighter_each_round_until_clean() {
        // lines 5 px off the edge of a rim 0.8 px wide
        let img = rim(0.8);
        let t = trace(&img, &TraceOptions::default()).unwrap();
        let rings: Vec<&Vec<V2>> = t
            .shapes
            .iter()
            .flat_map(|s| std::iter::once(&s.outer).chain(&s.holes))
            .collect();
        let o = SketchTraceOptions {
            fit: Fit::Lines,
            ..SketchTraceOptions::default()
        };
        let mut budget = Budget(FIT_BUDGET);
        let mut fitted: Vec<Option<Loop>> = rings
            .iter()
            .map(|r| fit_ring(r, &o, 5.0, PLACE, &[], &mut budget).unwrap().0)
            .collect();
        let fix = Untangle {
            o: &o,
            tol: 5.0,
            place: PLACE,
            refits: REFITS,
            max_segments: MAX_SEGMENTS,
        };
        let rounds = fix.run(&rings, &mut fitted, &mut budget).unwrap();
        assert!((2..REFITS).contains(&rounds), "{rounds}");
        let loops: Vec<Loop> = fitted.into_iter().flatten().collect();
        assert_eq!(loops.len(), 2);
        // fitted tighter, never kept as traced
        assert!(
            loops
                .iter()
                .zip(&rings)
                .all(|(l, r)| l.segments.len() < r.len() / 2)
        );
        assert!(sketch::check(&loops).ok);
    }

    #[test]
    fn traced_rings_that_still_cross_are_refused_rather_than_tried_forever() {
        // two squares that overlap, neither with a fit: kept as traced they cross, and there is nothing left to fit
        let (a, b) = (square_ring(0.0, 10.0, true), square_ring(5.0, 15.0, true));
        let err = untangle(REFITS, MAX_SEGMENTS)
            .run(&[&a, &b], &mut [None, None], &mut Budget(FIT_BUDGET))
            .unwrap_err();
        assert!(err.to_string().contains("too small to draw"), "{err}");
    }

    #[test]
    fn a_crossing_with_no_piece_to_pin_keeps_its_ring_as_traced_in_the_first_round() {
        // the outer fitted as a circle through its hole: a circle has no pieces, so there is nothing to fit tighter
        let (rings, mut fitted) = crossed_pair();
        fitted[0] = Some(sketch_fit::circle([10.0, 10.0], 10.0));
        let refs: Vec<&Vec<V2>> = rings.iter().collect();
        let rounds = untangle(REFITS, MAX_SEGMENTS)
            .run(&refs, &mut fitted, &mut Budget(FIT_BUDGET))
            .unwrap();
        assert_eq!(rounds, 1);
        let loops: Vec<Loop> = fitted.into_iter().flatten().collect();
        assert_eq!(loops[0].segments.len(), rings[0].len());
        assert!(sketch::check(&loops).ok);
    }

    #[test]
    fn pinned_points_are_kept_as_they_are() {
        let ring: Vec<V2> = (0..40)
            .map(|i| {
                let a = f64::from(i) * std::f64::consts::TAU / 40.0;
                [20.0 * a.m_cos(), 20.0 * a.m_sin()]
            })
            .collect();
        let place = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let o = SketchTraceOptions::default();
        let free = fit_ring(&ring, &o, 0.5, place, &[], &mut Budget(FIT_BUDGET))
            .unwrap()
            .0
            .unwrap();
        assert_eq!(free.kind.as_deref(), Some("circle"));
        let pins: Vec<usize> = (5..=10).collect();
        let held = fit_ring(&ring, &o, 0.5, place, &pins, &mut Budget(FIT_BUDGET))
            .unwrap()
            .0
            .unwrap();
        let ends: Vec<V2> = held.segments.iter().filter_map(|s| s.to).collect();
        for &i in &pins {
            assert!(
                ends.iter().any(|&p| sketch_fit::dist(p, ring[i]) < 1e-9),
                "point {i} not kept"
            );
        }
        // pinned neighbors are joined by lines
        assert!(held.segments.iter().filter(|s| s.kind == "line").count() >= 5);
        let exact = exact_ring(&ring, place).unwrap();
        assert_eq!(exact.segments.len(), 40);
        assert!(sketch::check(&[exact]).ok);
    }
}
