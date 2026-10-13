// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! text from outline fonts (TrueType and OpenType, quadratic or cubic curves) as filled polygons, ready to extrude

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::poly2d::{self, Polygon};
use crate::vec3::V2;
use read_fonts::model::pen::{ControlBoundsPen, OutlinePen};
use read_fonts::ps::cff::CffFontRef;
use read_fonts::tables::cmap::{Cmap, CmapSubtable, PlatformId};
use read_fonts::tables::glyf::{Anchor, Glyf, Glyph};
use read_fonts::tables::gpos::{Gpos, PairPos, PositionSubtables};
use read_fonts::tables::kern::{Kern, SubtableKind};
use read_fonts::tables::loca::Loca;
use read_fonts::tables::{hhea::Hhea, hmtx::Hmtx, os2::Os2, os2::SelectionFlags};
use read_fonts::types::{GlyphId, Tag};
use read_fonts::{FontRef, ReadError, TableProvider};
use serde::{Deserialize, Serialize};

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

impl OutlinePen for Flatten {
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

    #[allow(clippy::many_single_char_names, reason = "the pen's own names")]
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

/// the tables text needs, read once per call
struct Face<'a> {
    hhea: Hhea<'a>,
    os2: Option<Os2<'a>>,
    cmap: Option<Cmap<'a>>,
    hmtx: Option<Hmtx<'a>>,
    gpos: Option<Gpos<'a>>,
    kern: Option<Kern<'a>>,
    glyf: Option<(Loca<'a>, Glyf<'a>)>,
    cff: Option<CffFontRef<'a>>,
    units_per_em: u16,
}

/// an affine map as the font gives it: x' = a x + c y + e, y' = b x + d y + f
#[derive(Clone, Copy)]
struct Affine([f32; 6]);

#[allow(clippy::many_single_char_names, reason = "the matrix's own names")]
impl Affine {
    const ID: Self = Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    fn apply(self, x: f32, y: f32) -> (f32, f32) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }

    /// this map after `inner`
    fn then(self, inner: Self) -> Self {
        let ([a, b, c, d, e, f], [a2, b2, c2, d2, e2, f2]) = (self.0, inner.0);
        Self([
            a * a2 + c * b2,
            b * a2 + d * b2,
            a * c2 + c * d2,
            b * c2 + d * d2,
            a * e2 + c * f2 + e,
            b * e2 + d * f2 + f,
        ])
    }
}

/// one glyf contour to the pen: on-curve points join by lines, an off-curve point is a quadratic control, and two
/// off-curve points in a row have an implied on-curve point halfway between them
struct Contour<'p, P> {
    pen: &'p mut P,
    ts: Affine,
    first_on: Option<(f32, f32)>,
    first_off: Option<(f32, f32)>,
    last_off: Option<(f32, f32)>,
}

fn mid(a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
    (a.0 + (b.0 - a.0) * 0.5, a.1 + (b.1 - a.1) * 0.5)
}

impl<P: OutlinePen> Contour<'_, P> {
    fn start(&mut self, p: (f32, f32)) {
        self.first_on = Some(p);
        let (x, y) = self.ts.apply(p.0, p.1);
        self.pen.move_to(x, y);
    }

    fn line(&mut self, p: (f32, f32)) {
        let (x, y) = self.ts.apply(p.0, p.1);
        self.pen.line_to(x, y);
    }

    fn quad(&mut self, c: (f32, f32), p: (f32, f32)) {
        let ((cx, cy), (x, y)) = (self.ts.apply(c.0, c.1), self.ts.apply(p.0, p.1));
        self.pen.quad_to(cx, cy, x, y);
    }

    fn point(&mut self, p: (f32, f32), on: bool) {
        if self.first_on.is_none() {
            match (on, self.first_off) {
                (true, _) => self.start(p),
                (false, Some(off)) => {
                    self.last_off = Some(p);
                    self.start(mid(off, p));
                }
                (false, None) => self.first_off = Some(p),
            }
            return;
        }
        match (self.last_off, on) {
            (Some(off), true) => {
                self.last_off = None;
                self.quad(off, p);
            }
            (Some(off), false) => {
                self.last_off = Some(p);
                self.quad(off, mid(off, p));
            }
            (None, true) => self.line(p),
            (None, false) => self.last_off = Some(p),
        }
    }

    fn close(&mut self) {
        if let (Some(a), Some(b)) = (self.first_off, self.last_off) {
            self.last_off = None;
            self.quad(b, mid(b, a));
        }
        match (self.first_on, self.first_off.or(self.last_off)) {
            (Some(p), Some(off)) => self.quad(off, p),
            (Some(p), None) => self.line(p),
            _ => {}
        }
        (self.first_on, self.first_off, self.last_off) = (None, None, None);
        self.pen.close();
    }
}

/// composite glyphs nest at most this deep
const MAX_DEPTH: u8 = 32;

impl<'a> Face<'a> {
    fn parse(data: &'a [u8]) -> std::result::Result<Self, ReadError> {
        let font = FontRef::from_index(data, 0)?;
        let units_per_em = font.head()?.units_per_em();
        let hhea = font.hhea()?;
        font.maxp()?;
        Ok(Self {
            os2: font.os2().ok(),
            cmap: font.cmap().ok(),
            hmtx: font.hmtx().ok(),
            gpos: font.gpos().ok(),
            kern: font.kern().ok(),
            glyf: font.loca(None).ok().zip(font.glyf().ok()),
            cff: font
                .data_for_tag(Tag::new(b"CFF "))
                .or_else(|| font.data_for_tag(Tag::new(b"CFF2")))
                .and_then(|d| CffFontRef::new(d.as_bytes(), 0, Some(i32::from(units_per_em))).ok()),
            hhea,
            units_per_em,
        })
    }

    /// the first unicode subtable that maps the character
    fn glyph(&self, ch: char) -> Option<GlyphId> {
        let cmap = self.cmap.as_ref()?;
        cmap.encoding_records().iter().find_map(|r| {
            let sub = r.subtable(cmap.offset_data()).ok()?;
            let unicode = match r.platform_id() {
                PlatformId::Unicode => true,
                PlatformId::Windows => {
                    r.encoding_id() == 1
                        || (r.encoding_id() == 10
                            && matches!(sub, CmapSubtable::Format12(_) | CmapSubtable::Format13(_)))
                }
                _ => false,
            };
            if unicode { sub.map_codepoint(ch) } else { None }
        })
    }

    fn advance(&self, g: GlyphId) -> u16 {
        self.hmtx.as_ref().and_then(|h| h.advance(g)).unwrap_or(0)
    }

    fn typo(&self) -> Option<&Os2<'a>> {
        self.os2
            .as_ref()
            .filter(|o| o.fs_selection().contains(SelectionFlags::USE_TYPO_METRICS))
    }

    // hhea first, then the OS/2 typographic and windows values when hhea has none
    #[allow(clippy::cast_possible_wrap, reason = "read as the font's signed field")]
    fn ascender(&self) -> i16 {
        if let Some(o) = self.typo() {
            return o.s_typo_ascender();
        }
        match (self.hhea.ascender().to_i16(), &self.os2) {
            (0, Some(o)) if o.s_typo_ascender() == 0 => o.us_win_ascent() as i16,
            (0, Some(o)) => o.s_typo_ascender(),
            (v, _) => v,
        }
    }

    #[allow(clippy::cast_possible_wrap, reason = "read as the font's signed field")]
    fn descender(&self) -> i16 {
        if let Some(o) = self.typo() {
            return o.s_typo_descender();
        }
        match (self.hhea.descender().to_i16(), &self.os2) {
            (0, Some(o)) if o.s_typo_descender() == 0 => (o.us_win_descent() as i16).wrapping_neg(),
            (0, Some(o)) => o.s_typo_descender(),
            (v, _) => v,
        }
    }

    fn line_gap(&self) -> i16 {
        if let Some(o) = self.typo() {
            return o.s_typo_line_gap();
        }
        let hhea = &self.hhea;
        match &self.os2 {
            Some(o) if hhea.ascender().to_i16() == 0 || hhea.descender().to_i16() == 0 => {
                if o.s_typo_ascender() != 0 || o.s_typo_descender() != 0 {
                    o.s_typo_line_gap()
                } else {
                    0
                }
            }
            _ => hhea.line_gap().to_i16(),
        }
    }

    fn top_of(&self, g: GlyphId) -> Option<f64> {
        if let Some((loca, glyf)) = &self.glyf {
            return Some(f64::from(loca.get_glyf(g, glyf).ok()??.y_max()));
        }
        let mut pen = ControlBoundsPen::new();
        self.draw_cff(g, &mut pen);
        Some(f64::from(pen.bounding_box()?.y_max))
    }

    fn draw(&self, g: GlyphId, pen: &mut Flatten) {
        if self.glyf.is_some() {
            let _ = self.draw_glyf(g, Affine::ID, 0, pen);
        } else {
            self.draw_cff(g, pen);
        }
    }

    fn draw_cff(&self, g: GlyphId, pen: &mut impl OutlinePen) {
        if let Some(cff) = &self.cff
            && let Some(sub) = cff.subfont_index(g).and_then(|i| cff.subfont(i, &[]).ok())
        {
            let _ = cff.draw(&sub, g, &[], None, pen);
        }
    }

    fn draw_glyf(&self, g: GlyphId, ts: Affine, depth: u8, pen: &mut Flatten) -> Option<()> {
        if depth >= MAX_DEPTH {
            return None;
        }
        let (loca, glyf) = self.glyf.as_ref()?;
        match loca.get_glyf(g, glyf).ok()? {
            None => {}
            Some(Glyph::Simple(simple)) => {
                let ends = simple.end_pts_of_contours();
                // a lone point is no outline
                if ends.last()?.get() == 0 {
                    return Some(());
                }
                let mut ends = ends.iter().map(|e| usize::from(e.get())).peekable();
                let mut c = Contour {
                    pen,
                    ts,
                    first_on: None,
                    first_off: None,
                    last_off: None,
                };
                for (i, p) in simple.points().enumerate() {
                    c.point((f32::from(p.x), f32::from(p.y)), p.on_curve);
                    if ends.next_if_eq(&i).is_some() {
                        c.close();
                    }
                    if ends.peek().is_none() {
                        break;
                    }
                }
            }
            Some(Glyph::Composite(comp)) => {
                for part in comp.components() {
                    let t = part.transform;
                    let (e, f) = match part.anchor {
                        Anchor::Offset { x, y } => (f32::from(x), f32::from(y)),
                        Anchor::Point { .. } => (0.0, 0.0),
                    };
                    let inner = Affine([t.xx.to_f32(), t.yx.to_f32(), t.xy.to_f32(), t.yy.to_f32(), e, f]);
                    self.draw_glyf(part.glyph.into(), ts.then(inner), depth + 1, pen)?;
                }
            }
        }
        Some(())
    }
}

/// the first pair adjustment a subtable has for the pair, if it covers it
fn pair_advance(sub: &PairPos<'_>, left: GlyphId, right: GlyphId) -> Option<i16> {
    match sub {
        PairPos::Format1(t) => {
            let i = t.coverage().ok()?.get(left)?;
            let set = t.pair_sets().get(usize::from(i)).ok()?;
            set.pair_value_records()
                .iter()
                .filter_map(std::result::Result::ok)
                .find(|r| GlyphId::from(r.second_glyph()) == right)
                .map(|r| r.value_record1().x_advance().unwrap_or(0))
        }
        PairPos::Format2(t) => {
            t.coverage().ok()?.get(left)?;
            let c1 = t.class_def1().ok()?.get(left);
            let c2 = t.class_def2().ok()?.get(right);
            let row = t.class1_records().get(usize::from(c1)).ok()?;
            let cell = row.class2_records().get(usize::from(c2)).ok()?;
            Some(cell.value_record1().x_advance().unwrap_or(0))
        }
    }
}

fn kerning(face: &Face<'_>, left: GlyphId, right: GlyphId) -> i32 {
    if let Some(gpos) = &face.gpos
        && let (Ok(features), Ok(lookups)) = (gpos.feature_list(), gpos.lookup_list())
    {
        for rec in features.feature_records() {
            if rec.feature_tag() != Tag::new(b"kern") {
                continue;
            }
            let Ok(feature) = rec.feature(features.offset_data()) else {
                continue;
            };
            let mut total = 0i32;
            let mut found = false;
            for li in feature.lookup_list_indices() {
                let Ok(lookup) = lookups.lookups().get(usize::from(li.get())) else {
                    continue;
                };
                let Ok(PositionSubtables::Pair(subs)) = lookup.subtables() else {
                    continue;
                };
                for sub in subs.iter().filter_map(std::result::Result::ok) {
                    if let Some(v) = pair_advance(&sub, left, right) {
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
    if let Some(kern) = &face.kern {
        for st in kern.subtables().filter_map(std::result::Result::ok) {
            if !st.is_horizontal() || st.is_variable() {
                continue;
            }
            let v = match st.kind() {
                Ok(SubtableKind::Format0(t)) => t.kerning(left, right),
                Ok(SubtableKind::Format2(t)) => t.kerning(left, right),
                Ok(SubtableKind::Format3(t)) => t.kerning(left, right),
                _ => None,
            };
            if let Some(v) = v {
                return v;
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
    let face = Face::parse(font.unwrap_or(BUILTIN_SANS))
        .map_err(|e| Error::invalid("font", format!("not a TrueType or OpenType font ({e})")))?;
    let cap = face
        .os2
        .as_ref()
        .and_then(Os2::s_cap_height)
        .filter(|&h| h > 0)
        .map(f64::from)
        .or_else(|| face.glyph('H').and_then(|g| face.top_of(g)))
        .unwrap_or_else(|| f64::from(face.units_per_em) * 0.7);
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
            let Some(g) = face.glyph(ch) else {
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
            face.draw(g, &mut fl);
            fl.end();
            x += f64::from(face.advance(g)) * scale;
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

    // the outlines ttf-parser 0.25.1 gave for the built-in font, kerned and accented
    #[test]
    fn same_outlines_as_before() {
        let ring = |r: &[V2]| {
            (0..r.len())
                .map(|i| {
                    let (a, b) = (r[i], r[(i + 1) % r.len()]);
                    a[0] * b[1] - b[0] * a[1]
                })
                .sum::<f64>()
                .abs()
                / 2.0
        };
        for (text, verts, area) in [
            ("SlicerX", 355, 168.886_523_843),
            ("AV Wa To Ty", 230, 259.193_631_993),
            ("\u{c6}\u{d8}\u{c5} \u{e9}\u{f1}\u{fc} @&%", 902, 382.917_227_290),
        ] {
            let s = text_shape(text, None, &TextOptions::default()).unwrap();
            let n: usize = s
                .polygons
                .iter()
                .map(|p| p.outer.len() + p.holes.iter().map(Vec::len).sum::<usize>())
                .sum();
            let a: f64 = s
                .polygons
                .iter()
                .map(|p| ring(&p.outer) - p.holes.iter().map(|h| ring(h)).sum::<f64>())
                .sum();
            assert_eq!(n, verts, "{text}");
            assert!((a - area).abs() < 1e-8, "{text}: {a}");
        }
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
