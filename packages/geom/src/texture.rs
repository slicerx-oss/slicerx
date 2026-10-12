// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Textures sampled for paint: a 3MF texture decoded (PNG or JPEG), read at texture coordinates with the file's
//! tile styles and filter, and each sample matched to a filament by color. A textured triangle becomes a cover: one
//! filament, no match, or a split into four in the order a painted triangle's text splits, so a cover turns into
//! paint text as it is.

use crate::error::{Error, Result};
use crate::fm::Fm;
use crate::format::{PartProps, Texture2d, TextureGroup, Textures};
use std::collections::{BTreeMap, HashMap};

/// The most pixels a texture may have: a 8192 x 8192 image, 256 MB as RGBA.
pub const MAX_PIXELS: u64 = 8192 * 8192;

/// How deep a triangle splits at most; a split level quarters it.
pub const MAX_DEPTH: u32 = 10;

/// A piece larger than this in texels always splits (while depth is left), so a small feature between its samples is
/// not missed; smaller pieces count as one color when their corners and middle agree.
const LARGE_TEXELS: f32 = 25.0;

/// Below this alpha a sample has no color.
const MIN_ALPHA: f32 = 0.5;

/// How close (`OKLab` distance) a sample must be to an explicit mapping's color for the mapping to apply.
pub const MAP_DISTANCE: f64 = 0.03;

/// A decoded texture, 8-bit RGBA, rows from the top.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    rgba: Vec<u8>,
}

impl Image {
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Result<Self> {
        let n = u64::from(width) * u64::from(height);
        if width == 0 || height == 0 || n > MAX_PIXELS {
            return Err(Error::invalid(
                "texture",
                format!("{width} x {height} is not a size this reads"),
            ));
        }
        if rgba.len() as u64 != n * 4 {
            return Err(Error::invalid("texture", "pixel data does not match the size"));
        }
        Ok(Self { width, height, rgba })
    }

    /// One pixel, 8-bit sRGB and alpha.
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let at = (y as usize * self.width as usize + x as usize) * 4;
        match self.rgba.get(at..at + 4) {
            Some(&[r, g, b, a]) => [r, g, b, a],
            _ => [0; 4],
        }
    }
}

/// A PNG or JPEG texture, told apart by its first bytes.
pub fn decode(bytes: &[u8]) -> Result<Image> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        decode_png(bytes)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        decode_jpeg(bytes)
    } else {
        Err(Error::invalid("texture", "not a PNG or JPEG image"))
    }
}

fn decode_png(bytes: &[u8]) -> Result<Image> {
    let bad = |e: png::DecodingError| Error::invalid("texture", format!("PNG: {e}"));
    let mut decoder = png::Decoder::new_with_limits(
        std::io::Cursor::new(bytes),
        png::Limits {
            bytes: usize::try_from(MAX_PIXELS * 4).unwrap_or(usize::MAX),
        },
    );
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(bad)?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| Error::invalid("texture", "PNG is too large"))?;
    let mut buf = vec![0; size];
    let info = reader.next_frame(&mut buf).map_err(bad)?;
    let (w, h) = (info.width, info.height);
    let n = w as usize * h as usize;
    let line = info.line_size;
    let rgba: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => (0..h as usize)
            .flat_map(|y| {
                buf.get(y * line..y * line + w as usize * 4)
                    .unwrap_or_default()
                    .iter()
                    .copied()
            })
            .collect(),
        png::ColorType::Rgb => (0..h as usize)
            .flat_map(|y| {
                buf.get(y * line..y * line + w as usize * 3)
                    .unwrap_or_default()
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .flat_map(|&[r, g, b]| [r, g, b, 255])
            })
            .collect(),
        png::ColorType::GrayscaleAlpha => (0..h as usize)
            .flat_map(|y| {
                buf.get(y * line..y * line + w as usize * 2)
                    .unwrap_or_default()
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .flat_map(|&[g, a]| [g, g, g, a])
            })
            .collect(),
        png::ColorType::Grayscale => (0..h as usize)
            .flat_map(|y| {
                buf.get(y * line..y * line + w as usize)
                    .unwrap_or_default()
                    .iter()
                    .flat_map(|&g| [g, g, g, 255])
            })
            .collect(),
        png::ColorType::Indexed => return Err(Error::invalid("texture", "PNG palette was not expanded")),
    };
    if rgba.len() != n * 4 {
        return Err(Error::invalid("texture", "PNG data is short"));
    }
    Image::new(w, h, rgba)
}

fn decode_jpeg(bytes: &[u8]) -> Result<Image> {
    use zune_jpeg::zune_core::bytestream::ZCursor;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let side = 8192;
    let options = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGBA)
        .set_max_width(side)
        .set_max_height(side);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let rgba = decoder
        .decode()
        .map_err(|e| Error::invalid("texture", format!("JPEG: {e:?}")))?;
    let (w, h) = decoder
        .dimensions()
        .ok_or_else(|| Error::invalid("texture", "JPEG has no size"))?;
    let w = u32::try_from(w).map_err(|_| Error::invalid("texture", "JPEG is too large"))?;
    let h = u32::try_from(h).map_err(|_| Error::invalid("texture", "JPEG is too large"))?;
    Image::new(w, h, rgba)
}

/// How a coordinate outside 0 to 1 reads (the 3MF `tilestyleu` and `tilestylev`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tile {
    #[default]
    Wrap,
    Mirror,
    Clamp,
    /// Outside 0 to 1 there is no color.
    None,
}

impl Tile {
    /// The file's value; one it does not name is `wrap`, the 3MF default.
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(str::trim) {
            Some("mirror") => Self::Mirror,
            Some("clamp") => Self::Clamp,
            Some("none") => Self::None,
            _ => Self::Wrap,
        }
    }

    /// The coordinate in 0 to 1, or none.
    fn coord(self, t: f32) -> Option<f32> {
        if !t.is_finite() {
            return None;
        }
        Some(match self {
            Self::Wrap => t - t.floor(),
            Self::Mirror => {
                let f = t.rem_euclid(2.0);
                if f > 1.0 { 2.0 - f } else { f }
            }
            Self::Clamp => t.clamp(0.0, 1.0),
            Self::None => {
                if !(0.0..=1.0).contains(&t) {
                    return None;
                }
                t
            }
        })
    }

    /// A texel index in `0..n` for one `i` past the edge, for blending neighbors.
    fn texel(self, i: i64, n: u32) -> u32 {
        let n = i64::from(n);
        let k = match self {
            Self::Wrap => i.rem_euclid(n),
            Self::Mirror => {
                let f = i.rem_euclid(2 * n);
                if f >= n { 2 * n - 1 - f } else { f }
            }
            Self::Clamp | Self::None => i.clamp(0, n - 1),
        };
        u32::try_from(k).unwrap_or(0)
    }
}

/// How a texture is read between texel centers (the 3MF `filter`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Filter {
    /// `auto` and `linear`: bilinear between the four nearest texels.
    #[default]
    Linear,
    Nearest,
}

impl Filter {
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(str::trim) {
            Some("nearest") => Self::Nearest,
            _ => Self::Linear,
        }
    }
}

/// sRGB 8-bit to linear, by table.
#[allow(clippy::cast_possible_truncation, reason = "values in 0 to 1 fit an f32")]
fn linear_table() -> [f32; 256] {
    let mut t = [0.0f32; 256];
    for (i, v) in t.iter_mut().enumerate() {
        let c = i as f64 / 255.0;
        *v = if c <= 0.040_45 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).m_powf(2.4)
        } as f32;
    }
    t
}

/// Linear to sRGB 8-bit.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to 0 to 255 first"
)]
fn to_srgb8(c: f32) -> u8 {
    let c = f64::from(c);
    let s = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.m_powf(1.0 / 2.4) - 0.055
    };
    (s.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// The texel a coordinate in 0 to `n` falls in.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to 0 to n - 1 first"
)]
fn texel_at(t: f32, n: u32) -> u32 {
    t.floor().clamp(0.0, n.saturating_sub(1) as f32) as u32
}

/// The whole part of a coordinate, for a texel index past an edge; coordinates stay within a few texels of 0 to n.
#[allow(clippy::cast_possible_truncation, reason = "a texel index, far below 2^31")]
fn floor_i64(t: f32) -> i64 {
    t.floor() as i64
}

/// A texture with its tile styles and filter.
pub struct Sampler<'a> {
    image: &'a Image,
    u: Tile,
    v: Tile,
    filter: Filter,
    lin: [f32; 256],
}

impl<'a> Sampler<'a> {
    fn lin(&self, c: u8) -> f32 {
        self.lin.get(usize::from(c)).copied().unwrap_or(0.0)
    }

    pub fn new(image: &'a Image, u: Tile, v: Tile, filter: Filter) -> Self {
        Self {
            image,
            u,
            v,
            filter,
            lin: linear_table(),
        }
    }

    /// As the file's texture says.
    pub fn of(image: &'a Image, t: &Texture2d) -> Self {
        Self::new(
            image,
            Tile::parse(t.tilestyle_u.as_deref()),
            Tile::parse(t.tilestyle_v.as_deref()),
            Filter::parse(t.filter.as_deref()),
        )
    }

    /// Linear RGB and alpha at `uv`, or none outside a `none` tile. `v` runs up the image, as 3MF has it.
    pub fn rgba(&self, uv: [f32; 2]) -> Option<[f32; 4]> {
        let u = self.u.coord(uv[0])?;
        let v = self.v.coord(uv[1])?;
        let (w, h) = (self.image.width, self.image.height);
        let x = u * w as f32;
        let y = (1.0 - v) * h as f32;
        let read = |px: u32, py: u32| {
            let p = self.image.pixel(px, py);
            [
                self.lin(p[0]),
                self.lin(p[1]),
                self.lin(p[2]),
                f32::from(p[3]) / 255.0,
            ]
        };
        match self.filter {
            Filter::Nearest => Some(read(texel_at(x, w), texel_at(y, h))),
            Filter::Linear => {
                let (px, py) = (x - 0.5, y - 0.5);
                let (fx, fy) = (px - px.floor(), py - py.floor());
                let (x0, y0) = (floor_i64(px), floor_i64(py));
                let tx = |i: i64| self.u.texel(i, w);
                let ty = |i: i64| self.v.texel(i, h);
                let c00 = read(tx(x0), ty(y0));
                let c10 = read(tx(x0 + 1), ty(y0));
                let c01 = read(tx(x0), ty(y0 + 1));
                let c11 = read(tx(x0 + 1), ty(y0 + 1));
                let mut out = [0.0f32; 4];
                for ((o, (a, b)), (c, d)) in out
                    .iter_mut()
                    .zip(c00.into_iter().zip(c10))
                    .zip(c01.into_iter().zip(c11))
                {
                    let top = a + (b - a) * fx;
                    let bottom = c + (d - c) * fx;
                    *o = top + (bottom - top) * fy;
                }
                Some(out)
            }
        }
    }
}

/// Linear RGB to `OKLab`.
pub fn oklab(c: [f32; 3]) -> [f64; 3] {
    let [r, g, b] = c.map(f64::from);
    let l = 0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b;
    let m = 0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b;
    let s = 0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b;
    let (l, m, s) = (l.m_cbrt(), m.m_cbrt(), s.m_cbrt());
    [
        0.210_454_255_3 * l + 0.793_617_785_0 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s,
    ]
}

fn srgb8_oklab(c: [u8; 3]) -> [f64; 3] {
    let t = linear_table();
    oklab(c.map(|v| t.get(usize::from(v)).copied().unwrap_or(0.0)))
}

fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    let (x, y, z) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    (x * x + y * y + z * z).sqrt()
}

/// What a sample with no filament close enough gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Unmatched {
    /// Nothing: the triangle stays as it is, or its piece stays unpainted.
    #[default]
    Leave,
    /// The nearest filament anyway.
    Nearest,
}

/// The filaments a texture is matched to.
#[derive(Debug, Clone)]
pub struct Palette {
    /// `OKLab` per slot, slot 1 first.
    slots: Vec<[f64; 3]>,
    /// Explicit colors and the slot each takes.
    map: Vec<([f64; 3], u8)>,
    max_distance: f64,
    unmatched: Unmatched,
}

impl Palette {
    /// `colors` per slot (slot 1 first), `map` colors that take a given slot, the farthest a sample may be from its
    /// filament (`OKLab`), and what a sample past it gets.
    pub fn new(
        colors: &[[u8; 3]],
        map: &[([u8; 3], u8)],
        max_distance: f64,
        unmatched: Unmatched,
    ) -> Result<Self> {
        if colors.is_empty() || colors.len() > 255 {
            return Err(Error::invalid("colors", "needs 1 to 255 filament colors"));
        }
        let slots = u8::try_from(colors.len()).unwrap_or(u8::MAX);
        if let Some((_, s)) = map.iter().find(|(_, s)| *s == 0 || *s > slots) {
            return Err(Error::invalid(
                "map",
                format!("slot {s} is not one of the {slots} colors"),
            ));
        }
        Ok(Self {
            slots: colors.iter().map(|&c| srgb8_oklab(c)).collect(),
            map: map.iter().map(|&(c, s)| (srgb8_oklab(c), s)).collect(),
            max_distance: max_distance.max(0.0),
            unmatched,
        })
    }

    /// The 1-based slot of a sample, or none: no color there, or no filament close enough.
    pub fn slot(&self, rgba: Option<[f32; 4]>) -> Option<u8> {
        let c = rgba.filter(|c| c[3] >= MIN_ALPHA)?;
        let lab = oklab([c[0], c[1], c[2]]);
        if let Some(&(_, s)) = self
            .map
            .iter()
            .filter(|(m, _)| distance(*m, lab) <= MAP_DISTANCE)
            .min_by(|a, b| distance(a.0, lab).total_cmp(&distance(b.0, lab)))
        {
            return Some(s);
        }
        let (i, d) = self
            .slots
            .iter()
            .map(|s| distance(*s, lab))
            .enumerate()
            .min_by(|a, b| a.1.total_cmp(&b.1))?;
        (d <= self.max_distance || self.unmatched == Unmatched::Nearest)
            .then(|| u8::try_from(i + 1).unwrap_or(0))
    }
}

/// What a texture paints on one triangle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cover {
    /// One filament, 1-based.
    Slot(u8),
    /// No filament matches here.
    Unmatched,
    /// Four pieces, in a painted triangle's text order for a split of all three sides from corner 0: the middle,
    /// then the pieces at corners 2, 1 and 0, each with its corners as that text turns them.
    Split(Box<[Cover; 4]>),
}

fn mid2(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    [f32::midpoint(a[0], b[0]), f32::midpoint(a[1], b[1])]
}

/// The four pieces of a triangle split on all three sides, as a painted triangle's text orders and turns them.
pub fn quarter<T: Copy>(p: [T; 3], mid: impl Fn(T, T) -> T) -> [[T; 3]; 4] {
    let (m_a, m_b, m_c) = (mid(p[0], p[1]), mid(p[2], p[0]), mid(p[1], p[2]));
    [
        [m_a, m_c, m_b],
        [m_c, p[2], m_b],
        [m_a, p[1], m_c],
        [p[0], m_a, m_b],
    ]
}

/// A triangle's area in texels.
fn texels(uv: &[[f32; 2]; 3], w: u32, h: u32) -> f32 {
    let (a, b, c) = (uv[0], uv[1], uv[2]);
    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() * w as f32 * h as f32
}

/// What the texture paints on a triangle with these texture coordinates, split down `depth` more levels where its
/// samples disagree. At the last level the middle sample decides.
pub fn cover(uv: [[f32; 2]; 3], sampler: &Sampler<'_>, palette: &Palette, depth: u32) -> Cover {
    let class = |p: [f32; 2]| palette.slot(sampler.rgba(p));
    let centroid = [
        (uv[0][0] + uv[1][0] + uv[2][0]) / 3.0,
        (uv[0][1] + uv[1][1] + uv[2][1]) / 3.0,
    ];
    let leaf = |c: Option<u8>| c.map_or(Cover::Unmatched, Cover::Slot);
    let middle = class(centroid);
    if depth == 0 {
        return leaf(middle);
    }
    let large = texels(&uv, sampler.image.width, sampler.image.height) > LARGE_TEXELS;
    if !large && uv.iter().all(|&p| class(p) == middle) {
        return leaf(middle);
    }
    let kids = quarter(uv, mid2).map(|k| cover(k, sampler, palette, depth - 1));
    if kids
        .iter()
        .all(|k| *k == kids[0] && !matches!(k, Cover::Split(_)))
    {
        return kids[0].clone();
    }
    Cover::Split(Box::new(kids))
}

/// What a texture paints on a part.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PartCover {
    /// The textured triangles, by triangle; triangles without a texture reference are not listed.
    pub triangles: Vec<(u32, Cover)>,
    /// Area per slot, mm2 (in the part's own coordinates).
    pub slot_area: BTreeMap<u8, f64>,
    /// Area no filament matched, mm2.
    pub unmatched_area: f64,
    /// The commonest colors no filament matched, `#rrggbb` with their area, largest first (at most 5).
    pub unmatched_colors: Vec<(String, f64)>,
    /// Triangles that split.
    pub split: usize,
}

/// The textures a part's references can use, decoded once: by texture id, in the part's model part.
pub type Images = HashMap<u32, Image>;

/// Decodes every texture of `model` that some group uses, from the archive.
pub fn images(textures: &Textures, model: &str, archive: &[u8]) -> Result<Images> {
    let mut out = Images::new();
    for t in textures.images.iter().filter(|t| t.model == model) {
        if textures
            .groups
            .iter()
            .any(|g| g.model == model && g.texture == t.id)
        {
            out.insert(t.id, decode(&t.read(archive)?)?);
        }
    }
    Ok(out)
}

fn tri_area(p: [[f32; 3]; 3]) -> f64 {
    let d = |a: [f32; 3], b: [f32; 3]| {
        [
            f64::from(b[0] - a[0]),
            f64::from(b[1] - a[1]),
            f64::from(b[2] - a[2]),
        ]
    };
    let (u, v) = (d(p[0], p[1]), d(p[0], p[2]));
    let c = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    0.5 * (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt()
}

/// What the textures paint on a part: each triangle whose reference names a texture group, covered down to `depth`
/// split levels (at most [`MAX_DEPTH`]).
pub fn cover_part(
    positions: &[[f32; 3]],
    triangles: &[[u32; 3]],
    props: &PartProps,
    textures: &Textures,
    images: &Images,
    palette: &Palette,
    depth: u32,
) -> PartCover {
    let depth = depth.min(MAX_DEPTH);
    let groups: HashMap<u32, (&TextureGroup, Sampler<'_>)> = textures
        .groups
        .iter()
        .filter(|g| g.model == props.model)
        .filter_map(|g| {
            let t = textures.image(&props.model, g.texture)?;
            Some((g.id, (g, Sampler::of(images.get(&g.texture)?, t))))
        })
        .collect();
    let mut out = PartCover::default();
    let mut unmatched: HashMap<[u8; 3], f64> = HashMap::new();
    for (k, tri) in triangles.iter().enumerate() {
        let Ok(k32) = u32::try_from(k) else { break };
        let Some((pid, p)) = props.of(k32) else { continue };
        let Some((group, sampler)) = groups.get(&pid) else {
            continue;
        };
        let Some(uv) = p
            .iter()
            .map(|&i| group.uvs.get(i as usize).copied())
            .collect::<Option<Vec<_>>>()
            .and_then(|v| <[[f32; 2]; 3]>::try_from(v).ok())
        else {
            continue;
        };
        let Some(xyz) = tri
            .iter()
            .map(|&i| positions.get(i as usize).copied())
            .collect::<Option<Vec<_>>>()
            .and_then(|v| <[[f32; 3]; 3]>::try_from(v).ok())
        else {
            continue;
        };
        let c = cover(uv, sampler, palette, depth);
        if matches!(c, Cover::Split(_)) {
            out.split += 1;
        }
        tally(&c, uv, tri_area(xyz), sampler, &mut out, &mut unmatched);
        out.triangles.push((k32, c));
    }
    let mut colors: Vec<([u8; 3], f64)> = unmatched.into_iter().collect();
    colors.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    out.unmatched_colors = colors
        .into_iter()
        .take(5)
        .map(|(c, a)| (format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]), a))
        .collect();
    out
}

/// Adds a cover's areas to the totals; an unmatched piece adds its middle color, rounded to 16 levels a channel.
fn tally(
    c: &Cover,
    uv: [[f32; 2]; 3],
    area: f64,
    sampler: &Sampler<'_>,
    out: &mut PartCover,
    unmatched: &mut HashMap<[u8; 3], f64>,
) {
    match c {
        Cover::Slot(s) => *out.slot_area.entry(*s).or_default() += area,
        Cover::Unmatched => {
            out.unmatched_area += area;
            let centroid = [
                (uv[0][0] + uv[1][0] + uv[2][0]) / 3.0,
                (uv[0][1] + uv[1][1] + uv[2][1]) / 3.0,
            ];
            if let Some(rgba) = sampler.rgba(centroid) {
                let q = |v: f32| (to_srgb8(v) / 16) * 16 + 8;
                *unmatched.entry([q(rgba[0]), q(rgba[1]), q(rgba[2])]).or_default() += area;
            }
        }
        Cover::Split(kids) => {
            for (kid, k) in kids.iter().zip(quarter(uv, mid2)) {
                tally(kid, k, area / 4.0, sampler, out, unmatched);
            }
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::float_cmp
)]
mod tests {
    use super::*;

    const YELLOW: [u8; 3] = [255, 220, 0];
    const BLUE: [u8; 3] = [0, 70, 200];

    /// A `size` square checker of yellow and blue, `cell` pixels a square, yellow at the top left.
    fn checker(size: u32, cell: u32) -> Image {
        let mut rgba = Vec::new();
        for y in 0..size {
            for x in 0..size {
                let c = if (x / cell + y / cell).is_multiple_of(2) {
                    YELLOW
                } else {
                    BLUE
                };
                rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        Image::new(size, size, rgba).unwrap()
    }

    fn palette() -> Palette {
        Palette::new(&[YELLOW, BLUE], &[], 0.15, Unmatched::Leave).unwrap()
    }

    fn near(a: [u8; 4], b: [u8; 3], tol: u8) -> bool {
        a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= tol)
    }

    #[test]
    fn png_and_jpeg_decode_to_rgba() {
        let png = include_bytes!("../tests/corpus/textured-cube.3mf");
        let p = crate::format::read_3mf(png).unwrap();
        let img = decode(&p.textures.images[0].read(png).unwrap()).unwrap();
        assert_eq!((img.width, img.height), (4, 4));
        assert_eq!(img.pixel(0, 0), [255, 220, 0, 255]);
        assert_eq!(img.pixel(3, 0), [0, 70, 200, 255]);
        let jpg = decode(include_bytes!("../tests/fixtures/texture-checker.jpg")).unwrap();
        assert_eq!((jpg.width, jpg.height), (16, 16));
        // lossy, so near: the middle of the top left and top right cells
        assert!(near(jpg.pixel(3, 3), YELLOW, 12), "{:?}", jpg.pixel(3, 3));
        assert!(near(jpg.pixel(12, 3), BLUE, 12), "{:?}", jpg.pixel(12, 3));
        assert!(decode(b"GIF89a").is_err());
        assert!(decode(b"\x89PNG\r\n\x1a\nbroken").is_err());
    }

    #[test]
    fn v_runs_up_the_image_and_tiles_wrap_mirror_clamp_or_end() {
        let img = checker(4, 2);
        let s = |u, v| Sampler::new(&img, u, v, Filter::Nearest);
        let slot = |s: &Sampler<'_>, uv| palette().slot(s.rgba(uv));
        let wrap = s(Tile::Wrap, Tile::Wrap);
        // near v = 1 is the top row: yellow at the left
        assert_eq!(slot(&wrap, [0.1, 0.9]), Some(1));
        assert_eq!(slot(&wrap, [0.1, 0.1]), Some(2));
        // u = 1.1 wraps to 0.1
        assert_eq!(slot(&wrap, [1.1, 0.9]), Some(1));
        // mirror: u = 1.1 reads 0.9, the blue top right
        assert_eq!(slot(&s(Tile::Mirror, Tile::Wrap), [1.1, 0.9]), Some(2));
        // clamp: u = 3 reads the right edge, blue at the top
        assert_eq!(slot(&s(Tile::Clamp, Tile::Clamp), [3.0, 0.9]), Some(2));
        // none: no color outside 0 to 1
        assert_eq!(slot(&s(Tile::None, Tile::None), [1.1, 0.9]), None);
        assert_eq!(Tile::parse(Some("mirror")), Tile::Mirror);
        assert_eq!(Tile::parse(Some("odd")), Tile::Wrap);
        assert_eq!(Filter::parse(Some("auto")), Filter::Linear);
    }

    #[test]
    fn linear_blends_between_texels_and_nearest_does_not() {
        let img = checker(2, 1);
        // the boundary between the yellow and blue top texels
        let at = [0.5, 0.75];
        let lin = Sampler::new(&img, Tile::Clamp, Tile::Clamp, Filter::Linear)
            .rgba(at)
            .unwrap();
        let nn = Sampler::new(&img, Tile::Clamp, Tile::Clamp, Filter::Nearest)
            .rgba(at)
            .unwrap();
        let t = linear_table();
        let y = [t[255], t[220], t[0]];
        let b = [t[0], t[70], t[200]];
        for k in 0..3 {
            assert!((lin[k] - f32::midpoint(y[k], b[k])).abs() < 1e-5, "{lin:?}");
        }
        assert!(nn[..3] == b || nn[..3] == y);
    }

    #[test]
    fn colors_match_the_nearest_filament_or_none() {
        let p = palette();
        let lin = |c: [u8; 3]| {
            let t = linear_table();
            Some([
                t[usize::from(c[0])],
                t[usize::from(c[1])],
                t[usize::from(c[2])],
                1.0,
            ])
        };
        assert_eq!(p.slot(lin([250, 210, 20])), Some(1));
        assert_eq!(p.slot(lin([10, 80, 190])), Some(2));
        // red is far from both: unmatched, or the nearest when asked
        assert_eq!(p.slot(lin([220, 0, 0])), None);
        let nearest = Palette::new(&[YELLOW, BLUE], &[], 0.15, Unmatched::Nearest).unwrap();
        assert!(nearest.slot(lin([220, 0, 0])).is_some());
        // an explicit mapping wins near its color
        let mapped = Palette::new(&[YELLOW, BLUE], &[([220, 0, 0], 2)], 0.15, Unmatched::Leave).unwrap();
        assert_eq!(mapped.slot(lin([222, 2, 1])), Some(2));
        // see-through has no color
        assert_eq!(p.slot(Some([1.0, 0.7, 0.0, 0.2])), None);
        assert!(Palette::new(&[YELLOW], &[([0, 0, 0], 3)], 0.15, Unmatched::Leave).is_err());
    }

    fn leaves(c: &Cover, uv: [[f32; 2]; 3], out: &mut Vec<(Cover, [[f32; 2]; 3])>) {
        match c {
            Cover::Split(kids) => {
                for (k, q) in kids.iter().zip(quarter(uv, mid2)) {
                    leaves(k, q, out);
                }
            }
            leaf => out.push((leaf.clone(), uv)),
        }
    }

    #[test]
    fn a_triangle_across_a_color_edge_splits_along_it() {
        let img = checker(2, 1);
        let s = Sampler::new(&img, Tile::Clamp, Tile::Clamp, Filter::Nearest);
        // inside the top yellow texel: one color
        assert_eq!(
            cover([[0.05, 0.55], [0.45, 0.55], [0.05, 0.95]], &s, &palette(), 6),
            Cover::Slot(1)
        );
        // across the top row's yellow and blue texels
        let uv = [[0.0, 0.5], [1.0, 0.5], [0.0, 1.0]];
        let c = cover(uv, &s, &palette(), 6);
        assert!(matches!(c, Cover::Split(_)));
        let mut out = Vec::new();
        leaves(&c, uv, &mut out);
        // each leaf's middle lies in the texel of its color
        for (leaf, q) in &out {
            let mid = (q[0][0] + q[1][0] + q[2][0]) / 3.0;
            match leaf {
                Cover::Slot(1) => assert!(mid < 0.5 + 0.02, "{q:?}"),
                Cover::Slot(2) => assert!(mid > 0.5 - 0.02, "{q:?}"),
                other => panic!("{other:?}"),
            }
        }
        // depth 0 takes the middle sample
        assert!(matches!(cover(uv, &s, &palette(), 0), Cover::Slot(_)));
    }

    #[test]
    fn a_small_feature_inside_a_large_triangle_is_found() {
        // a blue dot at the middle of a 64 px yellow image
        let mut rgba = Vec::new();
        for y in 0..64u32 {
            for x in 0..64u32 {
                let c = if (28..36).contains(&x) && (28..36).contains(&y) {
                    BLUE
                } else {
                    YELLOW
                };
                rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        let img = Image::new(64, 64, rgba).unwrap();
        let s = Sampler::new(&img, Tile::Clamp, Tile::Clamp, Filter::Nearest);
        // corners and middle are yellow; a large triangle splits until its pieces find the dot
        let uv = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]];
        let c = cover(uv, &s, &palette(), 6);
        let mut out = Vec::new();
        leaves(&c, uv, &mut out);
        assert!(out.iter().any(|(l, _)| *l == Cover::Slot(2)));
    }

    #[test]
    fn the_textured_cube_paints_its_checker_by_area() {
        let bytes = include_bytes!("../tests/corpus/textured-cube.3mf");
        let p = crate::format::read_3mf(bytes).unwrap();
        let part = &p.objects[0].parts[0];
        let imgs = images(&p.textures, &part.props.model, bytes).unwrap();
        let c = cover_part(
            &part.positions,
            &part.triangles,
            &part.props,
            &p.textures,
            &imgs,
            &palette(),
            6,
        );
        // every triangle names the texture group: the bottom pair through all of the checker, the rest at one point
        assert_eq!(c.triangles.len(), 12);
        let total: f64 = c.slot_area.values().sum::<f64>() + c.unmatched_area;
        assert!((total - 2400.0).abs() < 1e-6, "{total}");
        // the bottom face (400 mm2) is half yellow; every other face reads a blue texel
        let yellow = c.slot_area.get(&1).copied().unwrap_or(0.0);
        assert!((yellow - 200.0).abs() < 4.0, "{yellow}");
        assert!((c.slot_area[&2] - 2200.0).abs() < 4.0, "{:?}", c.slot_area);
        assert_eq!(c.split, 2);
        assert_eq!(c.unmatched_area, 0.0);
        // with no filament near enough nothing matches, and the colors seen are listed, rounded
        let red = Palette::new(&[[255, 0, 0]], &[], 0.01, Unmatched::Leave).unwrap();
        let none = cover_part(
            &part.positions,
            &part.triangles,
            &part.props,
            &p.textures,
            &imgs,
            &red,
            6,
        );
        assert!(none.slot_area.is_empty());
        assert!((none.unmatched_area - 2400.0).abs() < 1e-6);
        // nothing splits when every sample is unmatched, so each triangle counts by its middle: blue
        assert_eq!(none.unmatched_colors, [("#0848c8".to_owned(), 2400.0)]);
    }
}
