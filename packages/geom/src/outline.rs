// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! text from outline fonts (TrueType and OpenType, quadratic or cubic curves) as filled polygons, ready to extrude

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::poly2d::{self, Polygon};
use crate::vec3::V2;
use serde::{Deserialize, Serialize};
use ttf_parser::{Face, GlyphId, OutlineBuilder};

pub static BUILTIN_SANS: &[u8] = include_bytes!("../fonts/HankenGrotesk-SemiBold-latin.ttf");

pub const MAX_CHARS: usize = 400;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextOptions {
    pub size_mm: f64,
    /// extra space between letters in mm (negative tightens)
    pub letter_spacing_mm: f64,
    pub line_spacing: f64,
    pub align: Align,
    pub tolerance_mm: f64,
    pub kerning: bool,
}

impl Default for TextOptions {
    fn default() -> Self {
        Self {
            size_mm: 10.0,
            letter_spacing_mm: 0.0,
            line_spacing: 1.0,
            align: Align::Center,
            tolerance_mm: 0.01,
            kerning: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextShape {
    pub polygons: Vec<Polygon>,
    pub min: V2,
    pub max: V2,
    pub missing: Vec<char>,
}

struct Flatten {
    scale: f64,
    tol: f64,
    origin: V2,
    cur: V2,
    start: V2,
    ring: Vec<V2>,
    rings: Vec<Vec<V2>>,
}

impl Flatten {
    fn pt(&self, x: f32, y: f32) -> V2 {
        [
            self.origin[0] + f64::from(x) * self.scale,
            self.origin[1] + f64::from(y) * self.scale,
        ]
    }

    fn push(&mut self, p: V2) {
        if self.ring.last() != Some(&p) {
            self.ring.push(p);
        }
        self.cur = p;
    }

    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "clamped")]
    fn segments(&self, deviation: f64) -> usize {
        // a curve bulging `deviation` from its chord, split in n, errs by
        // about deviation / n^2
        (deviation / self.tol).sqrt().ceil().clamp(1.0, 64.0) as usize
    }

    fn end(&mut self) {
        if self.ring.len() > 1 && self.ring.first() == self.ring.last() {
            self.ring.pop();
        }
        if self.ring.len() >= 3 {
            self.rings.push(std::mem::take(&mut self.ring));
        } else {
            self.ring.clear();
        }
    }
}

fn len2(a: V2) -> f64 {
    a[0].m_hypot(a[1])
}

impl OutlineBuilder for Flatten {
    fn move_to(&mut self, x: f32, y: f32) {
        self.end();
        let p = self.pt(x, y);
        self.start = p;
        self.push(p);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let p = self.pt(x, y);
        self.push(p);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (p0, p1, p2) = (self.cur, self.pt(x1, y1), self.pt(x, y));
        let dd = len2([p0[0] - 2.0 * p1[0] + p2[0], p0[1] - 2.0 * p1[1] + p2[1]]) / 4.0;
        let n = self.segments(dd);
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            self.push([
                u * u * p0[0] + 2.0 * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2.0 * u * t * p1[1] + t * t * p2[1],
            ]);
        }
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (p0, p1, p2, p3) = (self.cur, self.pt(x1, y1), self.pt(x2, y2), self.pt(x, y));
        let d1 = len2([p0[0] - 2.0 * p1[0] + p2[0], p0[1] - 2.0 * p1[1] + p2[1]]);
        let d2 = len2([p1[0] - 2.0 * p2[0] + p3[0], p1[1] - 2.0 * p2[1] + p3[1]]);
        let n = self.segments(0.75 * d1.max(d2));
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            self.push([
                a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
            ]);
        }
    }

    fn close(&mut self) {
        let s = self.start;
        self.push(s);
        self.end();
    }
}

fn kerning(face: &Face<'_>, left: GlyphId, right: GlyphId) -> i32 {
    use ttf_parser::gpos::{PairAdjustment, PositioningSubtable};
    if let Some(gpos) = face.tables().gpos {
        let mut total = 0i32;
        let mut found = false;
        for feature in gpos.features {
            if feature.tag != ttf_parser::Tag::from_bytes(b"kern") {
                continue;
            }
            for li in feature.lookup_indices {
                let Some(lookup) = gpos.lookups.get(li) else {
                    continue;
                };
                for sub in lookup.subtables.into_iter::<PositioningSubtable<'_>>() {
                    let PositioningSubtable::Pair(pair) = sub else {
                        continue;
                    };
                    let value = match pair {
                        PairAdjustment::Format1 { coverage, sets } => coverage
                            .get(left)
                            .and_then(|i| sets.get(i))
                            .and_then(|set| set.get(right))
                            .map(|(a, _)| a.x_advance),
                        PairAdjustment::Format2 {
                            coverage,
                            classes,
                            matrix,
                        } => coverage
                            .contains(left)
                            .then(|| matrix.get((classes.0.get(left), classes.1.get(right))))
                            .flatten()
                            .map(|(a, _)| a.x_advance),
                    };
                    if let Some(v) = value {
                        total += i32::from(v);
                        found = true;
                        break;
                    }
                }
            }
            if found {
                return total;
            }
        }
    }
    if let Some(kern) = face.tables().kern {
        for st in kern.subtables {
            if st.horizontal
                && !st.variable
                && let Some(v) = st.glyphs_kerning(left, right)
            {
                return i32::from(v);
            }
        }
    }
    0
}

#[allow(clippy::too_many_lines, reason = "one pass over lines and glyphs")]
pub fn text_shape(text: &str, font: Option<&[u8]>, opts: &TextOptions) -> Result<TextShape> {
    if text.chars().count() > MAX_CHARS {
        return Err(Error::invalid("text", format!("at most {MAX_CHARS} characters")));
    }
    if !(opts.size_mm.is_finite() && opts.size_mm > 0.0 && opts.size_mm <= 2000.0) {
        return Err(Error::invalid("sizeMm", "between 0 and 2000 mm"));
    }
    if !(opts.line_spacing.is_finite() && opts.line_spacing > 0.0) {
        return Err(Error::invalid("lineSpacing", "must be above 0"));
    }
    if !opts.letter_spacing_mm.is_finite() {
        return Err(Error::invalid("letterSpacingMm", "must be finite"));
    }
    let face = Face::parse(font.unwrap_or(BUILTIN_SANS), 0)
        .map_err(|e| Error::invalid("font", format!("not a TrueType or OpenType font ({e})")))?;
    let cap = face
        .capital_height()
        .filter(|&h| h > 0)
        .map(f64::from)
        .or_else(|| {
            face.glyph_index('H')
                .and_then(|g| face.glyph_bounding_box(g))
                .map(|b| f64::from(b.y_max))
        })
        .unwrap_or_else(|| f64::from(face.units_per_em()) * 0.7);
    let scale = opts.size_mm / cap;
    let line_h = f64::from(face.ascender()) - f64::from(face.descender()) + f64::from(face.line_gap());
    let pitch = line_h * scale * opts.line_spacing;
    let tol = if opts.tolerance_mm.is_finite() && opts.tolerance_mm > 0.0 {
        opts.tolerance_mm
    } else {
        0.01
    };

    let mut missing = Vec::new();
    let mut lines = Vec::new();
    for (row, line) in text.split('\n').enumerate() {
        let mut fl = Flatten {
            scale,
            tol,
            origin: [0.0, -(row as f64) * pitch],
            cur: [0.0; 2],
            start: [0.0; 2],
            ring: Vec::new(),
            rings: Vec::new(),
        };
        let mut x = 0.0;
        let mut prev = None;
        let mut first = true;
        for ch in line.chars().filter(|c| !c.is_control()) {
            let Some(g) = face.glyph_index(ch) else {
                if !missing.contains(&ch) {
                    missing.push(ch);
                }
                prev = None;
                continue;
            };
            if opts.kerning
                && let Some(p) = prev
            {
                x += f64::from(kerning(&face, p, g)) * scale;
            }
            if !first {
                x += opts.letter_spacing_mm;
            }
            first = false;
            fl.origin[0] = x;
            let _ = face.outline_glyph(g, &mut fl);
            fl.end();
            x += f64::from(face.glyph_hor_advance(g).unwrap_or(0)) * scale;
            prev = Some(g);
        }
        lines.push((fl.rings, x));
    }

    let widest = lines.iter().map(|l| l.1).fold(0.0, f64::max);
    let mut rings = Vec::new();
    for (mut rs, w) in lines {
        let dx = match opts.align {
            Align::Left => 0.0,
            Align::Center => (widest - w) / 2.0,
            Align::Right => widest - w,
        };
        for p in rs.iter_mut().flatten() {
            p[0] += dx;
        }
        rings.extend(rs);
    }
    let min_area = (tol * tol).min(1e-6);
    let mut polygons = poly2d::fill_nonzero(rings, min_area);
    if polygons.is_empty() {
        return Err(Error::invalid("text", "no visible characters"));
    }
    let (lo, hi) = bounds(&polygons);
    let dx = match opts.align {
        Align::Left => -lo[0],
        Align::Center => -(lo[0] + hi[0]) / 2.0,
        Align::Right => -hi[0],
    };
    let dy = -(lo[1] + hi[1]) / 2.0;
    for v in polygons
        .iter_mut()
        .flat_map(|p| p.outer.iter_mut().chain(p.holes.iter_mut().flatten()))
    {
        *v = [v[0] + dx, v[1] + dy];
    }
    Ok(TextShape {
        polygons,
        min: [lo[0] + dx, lo[1] + dy],
        max: [hi[0] + dx, hi[1] + dy],
        missing,
    })
}

fn bounds(polys: &[Polygon]) -> (V2, V2) {
    polys.iter().flat_map(|p| p.outer.iter()).fold(
        ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]),
        |(lo, hi), v| {
            (
                [lo[0].min(v[0]), lo[1].min(v[1])],
                [hi[0].max(v[0]), hi[1].max(v[1])],
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build;
    use crate::vec3::Frame;

    #[test]
    fn capital_height_and_holes() {
        let s = text_shape("HO", None, &TextOptions::default()).unwrap();
        let h = s.max[1] - s.min[1];
        assert!((10.0..10.6).contains(&h), "{h}");
        assert!((s.min[0] + s.max[0]).abs() < 1e-9);
        assert_eq!(s.polygons.iter().map(|p| p.holes.len()).sum::<usize>(), 1);
        let m = build::extrude(&s.polygons, &Frame::WORLD, 0.0, 2.0).unwrap();
        assert!(m.edge_report().is_watertight());
        assert!(m.volume() > 0.0);
    }

    #[test]
    fn kerning_tightens_pairs() {
        let opts = TextOptions::default();
        let kerned = text_shape("AV", None, &opts).unwrap();
        let plain = text_shape(
            "AV",
            None,
            &TextOptions {
                kerning: false,
                ..opts
            },
        )
        .unwrap();
        let w = |s: &TextShape| s.max[0] - s.min[0];
        assert!(w(&kerned) < w(&plain) - 0.1, "{} vs {}", w(&kerned), w(&plain));
    }

    #[test]
    fn lines_alignment_and_missing() {
        let opts = TextOptions {
            align: Align::Left,
            ..TextOptions::default()
        };
        let s = text_shape("Wide line\nab\u{4e2d}", None, &opts).unwrap();
        assert!(s.min[0].abs() < 1e-9);
        assert_eq!(s.missing, vec!['\u{4e2d}']);
        assert!(s.max[1] - s.min[1] > 20.0);
        assert!(text_shape("   ", None, &opts).is_err());
        assert!(text_shape("A", Some(b"not a font"), &opts).is_err());
        assert!(text_shape("A", None, &TextOptions { size_mm: 0.0, ..opts }).is_err());
    }
}
