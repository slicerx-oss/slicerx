// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Tracing an image: a value per pixel that is above zero inside, specks and pinholes cleaned away, and closed rings
//! along the zero line by marching squares with sub-pixel edges.
//!
//! inside regions are 8-connected and outside ones 4-connected, in the cleanup and in the ambiguous cells alike, so
//! every ring is closed and simple and bounds exactly one region. rings are in working px with y up, the image
//! spanning 0 to w and 0 to h: outer rings counterclockwise, holes clockwise.
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
use crate::poly2d::signed_area;
use crate::raster::{self, Raster};
use crate::vec3::V2;
use rustc_hash::FxHashMap;
use std::borrow::Cow;

/// The working size's long side unless set.
pub const DEFAULT_SIDE: usize = 2048;
/// More rings than this are refused.
pub const MAX_LOOPS: usize = 2000;
/// Colors picked at once.
pub const MAX_COLORS: usize = 8;
/// keeps a crossing off the pixel centers, so two rings never share a point
const EPS: f32 = 1e-4;

/// What counts as inside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
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
    if o.max_side_px == 0 || o.max_side_px > raster::MAX_SIDE {
        return Err(Error::invalid_arg(format!(
            "the working size is 1 to {} px",
            raster::MAX_SIDE
        )));
    }
    if !(o.speck_px >= 0.0 && o.speck_px.is_finite()) {
        return Err(Error::invalid_arg("the speck size is 0 or more"));
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
    // an owned image is let go before the labels are made, so the two are never held at once
    drop(work);
    let dropped = despeckle(&mut f, o.speck_px);
    if !f.v.iter().any(|&v| v > 0.0) {
        return Err(Error::invalid(
            "image",
            "nothing is inside; change what to trace or the threshold",
        ));
    }
    let shapes = contours(&f)?;
    Ok(Traced {
        shapes,
        image_px,
        working_px,
        dropped,
        mode,
        threshold,
    })
}

/// sRGB luminance, 0 to 255.
fn luma(p: [u8; 4]) -> f32 {
    0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])
}

/// The threshold that best splits a histogram into two groups (largest between-group variance); the middle of a run
/// of equal best splits. None for a histogram with one value.
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
        if !(o.color_tolerance >= 0.0 && o.color_tolerance.is_finite()) {
            return Err(Error::invalid_arg("the color tolerance is 0 or more"));
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
                    (tol - d) / 100.0
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

/// Labels the 8-connected inside regions, or the 4-connected outside ones, from 1 in scan order (0 for the other
/// side). Returns each region's pixel count and whether it touches the image edge.
fn label(f: &Field, inside: bool, labels: &mut Vec<u32>) -> Vec<(usize, bool)> {
    let (w, h) = (f.w, f.h);
    labels.clear();
    labels.resize(w * h, 0);
    let mut regions = Vec::new();
    let mut stack = Vec::new();
    let is = |i: usize| (f.v[i] > 0.0) == inside;
    for start in 0..w * h {
        if labels[start] != 0 || !is(start) {
            continue;
        }
        let id = u32::try_from(regions.len() + 1).unwrap_or(u32::MAX);
        let (mut count, mut edge) = (0usize, false);
        labels[start] = id;
        stack.push(start);
        while let Some(i) = stack.pop() {
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
                    stack.push(j);
                }
            }
        }
        regions.push((count, edge));
    }
    regions
}

/// Drops inside regions of fewer than `min_px` pixels, then fills holes of fewer.
pub fn despeckle(f: &mut Field, min_px: f64) -> Dropped {
    let mut out = Dropped::default();
    if min_px <= 1.0 {
        return out;
    }
    let small = |n: usize| (n as f64) < min_px;
    let mut labels = Vec::new();
    let regions = label(f, true, &mut labels);
    out.specks = regions.iter().filter(|r| small(r.0)).count();
    if out.specks > 0 {
        for (v, &l) in f.v.iter_mut().zip(&labels) {
            if l != 0 && small(regions[l as usize - 1].0) {
                *v = -*v;
            }
        }
    }
    let regions = label(f, false, &mut labels);
    let hole = |r: &(usize, bool)| !r.1 && small(r.0);
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

/// The rings along the zero line of `f`, grouped into shapes in scan order of their regions.
pub fn contours(f: &Field) -> Result<Vec<Shape>> {
    let (w, h) = (f.w as i64, f.h as i64);
    // the image sits in a ring of outside pixels, so every contour closes
    let at = |x: i64, y: i64| -> f32 {
        if x >= 0 && y >= 0 && x < w && y < h {
            f.v[(y * w + x) as usize]
        } else {
            -1.0
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
    let mut labels = Vec::new();
    let regions = label(f, true, &mut labels);
    let region_of = |id: u64| {
        let ((ax, ay), (bx, by)) = corners(id);
        let (x, y) = if at(ax, ay) > 0.0 { (ax, ay) } else { (bx, by) };
        labels[(y * w + x) as usize] as usize - 1
    };
    let mut shapes = vec![Shape::default(); regions.len()];
    let mut rings = 0usize;
    for s in starts {
        if !next.contains_key(&s) {
            continue;
        }
        rings += 1;
        if rings > MAX_LOOPS {
            return Err(Error::invalid(
                "image",
                format!("more than {MAX_LOOPS} loops; raise Remove specks or Smoothing"),
            ));
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

    /// A 200 px image with a black square from 50 to 150, 25 black 2 x 2 specks outside it and 25 white 2 x 2
    /// pinholes inside it, placed from a seed.
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
        assert!(msg(trace(&dots, &opts())).contains("raise Remove specks"));
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
}
