// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Texture images: PNG and JPEG decoded to RGBA, reduced to at most `MAX_SIDE` a side, with box-filtered levels for
//! sampling a patch of the surface at its own size, and the lookup itself (wrap, mirror, clamp or none). A lookup
//! takes the nearest texel of its level: blending neighbor texels would make in-between colors at every color edge,
//! and those map to a third filament.
// texel offsets are within each level's pixel count, made from its own width and height
#![allow(clippy::indexing_slicing)]

use crate::error::{Error, Result};
use crate::fm::Fm as _;

/// The largest side kept. A bigger PNG is reduced row by row while it decodes; a bigger JPEG is refused.
pub const MAX_SIDE: usize = 4096;
/// A PNG past this is refused before it decodes.
const MAX_PNG_SIDE: usize = 4 * MAX_SIDE;

/// How a coordinate outside 0 to 1 reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Wrap {
    #[default]
    Repeat,
    Mirror,
    Clamp,
    /// Outside 0 to 1 there is no texture.
    None,
}

impl Wrap {
    /// A 3MF `tilestyleu` or `tilestylev` value.
    #[must_use]
    pub fn of_3mf(v: Option<&str>) -> Self {
        match v.map(str::trim) {
            Some("mirror") => Self::Mirror,
            Some("clamp") => Self::Clamp,
            Some("none") => Self::None,
            _ => Self::Repeat,
        }
    }

    fn apply(self, t: f64) -> Option<f64> {
        if !t.is_finite() {
            return None;
        }
        Some(match self {
            Self::Repeat => t - t.floor(),
            Self::Mirror => {
                let m = t.rem_euclid(2.0);
                if m > 1.0 { 2.0 - m } else { m }
            }
            Self::Clamp => t.clamp(0.0, 1.0),
            Self::None => {
                if !(-1e-9..=1.0 + 1e-9).contains(&t) {
                    return None;
                }
                t.clamp(0.0, 1.0)
            }
        })
    }
}

struct Level {
    w: usize,
    h: usize,
    /// sRGB with straight alpha, rows from the top
    px: Vec<[u8; 4]>,
}

/// A decoded texture and its reduced levels.
pub struct Image {
    levels: Vec<Level>,
    /// The size as the file has it.
    pub file_size: (usize, usize),
}

fn srgb_to_linear() -> [f32; 256] {
    let mut t = [0f32; 256];
    for (i, v) in t.iter_mut().enumerate() {
        let c = i as f32 / 255.0;
        // an f32 table made from the same f64 curve on every target
        #[allow(clippy::cast_possible_truncation)]
        let lin = if c <= 0.040_45 {
            c / 12.92
        } else {
            ((f64::from(c) + 0.055) / 1.055).m_powf(2.4) as f32
        };
        *v = lin;
    }
    t
}

fn linear_to_srgb(v: f32) -> u8 {
    let v = f64::from(v.clamp(0.0, 1.0));
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.m_powf(1.0 / 2.4) - 0.055
    };
    // within 0 to 255 after the clamp
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let out = (s * 255.0).round().clamp(0.0, 255.0) as u8;
    out
}

/// Averages `pixels` (sRGB, straight alpha) in linear light, colors weighted by their alpha.
fn average(pixels: &[[u8; 4]], lut: &[f32; 256]) -> [u8; 4] {
    let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
    for p in pixels {
        let w = f32::from(p[3]) / 255.0;
        r += lut[usize::from(p[0])] * w;
        g += lut[usize::from(p[1])] * w;
        b += lut[usize::from(p[2])] * w;
        a += w;
    }
    if a <= 0.0 {
        return [0, 0, 0, 0];
    }
    let n = pixels.len().max(1) as f32;
    // within 0 to 255 after the clamp
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let alpha = (a / n * 255.0).round().clamp(0.0, 255.0) as u8;
    [
        linear_to_srgb(r / a),
        linear_to_srgb(g / a),
        linear_to_srgb(b / a),
        alpha,
    ]
}

fn half(l: &Level, lut: &[f32; 256]) -> Level {
    let (w, h) = (l.w.div_ceil(2).max(1), l.h.div_ceil(2).max(1));
    let mut px = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let mut four = [[0u8; 4]; 4];
            let mut n = 0;
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (sx, sy) = (2 * x + dx, 2 * y + dy);
                if sx < l.w
                    && sy < l.h
                    && let Some(p) = l.px.get(sy * l.w + sx)
                    && let Some(slot) = four.get_mut(n)
                {
                    *slot = *p;
                    n += 1;
                }
            }
            px.push(average(four.get(..n).unwrap_or_default(), lut));
        }
    }
    Level { w, h, px }
}

impl Image {
    /// An image from its pixels (sRGB, straight alpha, rows from the top), already within `MAX_SIDE`.
    pub fn from_rgba(w: usize, h: usize, px: Vec<[u8; 4]>) -> Result<Self> {
        if w == 0 || h == 0 || px.len() != w * h {
            return Err(Error::invalid("texture", "an image with no pixels"));
        }
        let lut = srgb_to_linear();
        let mut levels = vec![Level { w, h, px }];
        while let Some(last) = levels.last() {
            if last.w == 1 && last.h == 1 {
                break;
            }
            let next = half(last, &lut);
            levels.push(next);
        }
        Ok(Self {
            levels,
            file_size: (w, h),
        })
    }

    /// The image's size as kept (after any reduction).
    #[must_use]
    pub fn size(&self) -> (usize, usize) {
        self.levels.first().map_or((0, 0), |l| (l.w, l.h))
    }

    /// The color at `uv` (v up, as OBJ and 3MF have it), for a patch about `texels` texels across at full size: the
    /// nearest texel of the level whose texels are about that size. `None` outside a texture that does not wrap, or
    /// where it is less than half opaque.
    #[must_use]
    pub fn sample(&self, uv: [f64; 2], texels: f64, wrap: (Wrap, Wrap)) -> Option<[u8; 3]> {
        let u = wrap.0.apply(uv[0])?;
        let v = wrap.1.apply(uv[1])?;
        // the level whose texels are about `texels` full-size texels across: the largest k with 2^k <= texels
        let mut level = 0;
        while level + 1 < self.levels.len() && f64::from(1u32 << (level + 1).min(31)) <= texels {
            level += 1;
        }
        let l = self.levels.get(level)?;
        // the texel under the point; u = 1 is the last column, not the next one over
        let cell = |t: f64, n: usize| -> usize {
            // a 0 to 1 coordinate times a side under 2^14
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let i = (t * n as f64).floor().max(0.0) as usize;
            i.min(n.saturating_sub(1))
        };
        let (x, y) = (cell(u, l.w), cell(1.0 - v, l.h));
        let p = l.px.get(y * l.w + x).copied()?;
        (p[3] >= 128).then_some([p[0], p[1], p[2]])
    }
}

/// Why an image file could not be used as a texture, for the note that says it is left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unusable {
    /// Neither a PNG nor a JPEG.
    NotImage,
    Damaged,
    TooLarge,
    /// A JPEG of a kind (arithmetic coded, lossless) the decoder does not read.
    Unsupported,
}

impl Unusable {
    /// The note for a texture left out: "The texture a.png is damaged, so it is left out."
    #[must_use]
    pub fn note(self, file: &str) -> String {
        let what = match self {
            Self::NotImage => "is not a PNG or JPEG image",
            Self::Damaged => "is damaged",
            Self::TooLarge => "is too large to read",
            Self::Unsupported => "is a kind of JPEG that is not read",
        };
        format!("The texture {file} {what}, so it is left out.")
    }
}

/// Decodes a PNG or JPEG (by its first bytes).
pub fn decode(bytes: &[u8]) -> std::result::Result<Image, Unusable> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        decode_png(bytes)
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        decode_jpeg(bytes)
    } else {
        Err(Unusable::NotImage)
    }
}

fn to_rgba(color: png::ColorType, row: &[u8], out: &mut Vec<[u8; 4]>) {
    match color {
        png::ColorType::Rgba => out.extend(row.as_chunks::<4>().0.iter().copied()),
        png::ColorType::Rgb => out.extend(row.as_chunks::<3>().0.iter().map(|&[r, g, b]| [r, g, b, 255])),
        png::ColorType::GrayscaleAlpha => {
            out.extend(row.as_chunks::<2>().0.iter().map(|&[v, a]| [v, v, v, a]));
        }
        // indexed comes expanded to rgb or rgba by normalize_to_color8
        png::ColorType::Grayscale | png::ColorType::Indexed => {
            out.extend(row.iter().map(|&v| [v, v, v, 255]));
        }
    }
}

fn decode_png(bytes: &[u8]) -> std::result::Result<Image, Unusable> {
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = dec.read_info().map_err(|_| Unusable::Damaged)?;
    let (w, h) = {
        let info = reader.info();
        (info.width as usize, info.height as usize)
    };
    if w == 0 || h == 0 {
        return Err(Unusable::Damaged);
    }
    if w > MAX_PNG_SIDE || h > MAX_PNG_SIDE {
        return Err(Unusable::TooLarge);
    }
    let (color, _) = reader.output_color_type();
    let k = w.max(h).div_ceil(MAX_SIDE).max(1);
    // an interlaced image cannot be reduced row by row
    if k > 1 && reader.info().interlaced {
        return Err(Unusable::TooLarge);
    }
    let (ow, oh) = (w.div_ceil(k), h.div_ceil(k));
    let lut = srgb_to_linear();
    let mut out: Vec<[u8; 4]> = Vec::with_capacity(ow * oh);
    if k == 1 {
        let size = reader.output_buffer_size().ok_or(Unusable::TooLarge)?;
        let mut buf = vec![0u8; size];
        let info = reader.next_frame(&mut buf).map_err(|_| Unusable::Damaged)?;
        let line = info.line_size;
        for y in 0..h {
            let row = buf.get(y * line..(y + 1) * line).ok_or(Unusable::Damaged)?;
            to_rgba(color, row, &mut out);
        }
    } else {
        // k rows at a time, each k x k block averaged in linear light
        let mut band: Vec<Vec<[u8; 4]>> = Vec::with_capacity(k);
        let mut y = 0;
        while y < h {
            let row = reader
                .next_row()
                .map_err(|_| Unusable::Damaged)?
                .ok_or(Unusable::Damaged)?;
            let mut px = Vec::with_capacity(w);
            to_rgba(color, row.data(), &mut px);
            band.push(px);
            y += 1;
            if band.len() == k || y == h {
                for ox in 0..ow {
                    let mut block = Vec::with_capacity(k * k);
                    for r in &band {
                        block.extend(r.get(ox * k..((ox + 1) * k).min(w)).unwrap_or_default());
                    }
                    out.push(average(&block, &lut));
                }
                band.clear();
            }
        }
    }
    let mut img = Image::from_rgba(ow, oh, out).map_err(|_| Unusable::Damaged)?;
    img.file_size = (w, h);
    Ok(img)
}

fn decode_jpeg(bytes: &[u8]) -> std::result::Result<Image, Unusable> {
    use zune_jpeg::zune_core::bytestream::ZCursor;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let options = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGB)
        .set_max_width(MAX_SIDE)
        .set_max_height(MAX_SIDE);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let rgb = dec.decode().map_err(|e| match e {
        zune_jpeg::errors::DecodeErrors::LargeDimensions(_) => Unusable::TooLarge,
        zune_jpeg::errors::DecodeErrors::Unsupported(_) => Unusable::Unsupported,
        _ => Unusable::Damaged,
    })?;
    let info = dec.info().ok_or(Unusable::Damaged)?;
    let (w, h) = (usize::from(info.width), usize::from(info.height));
    if rgb.len() != w * h * 3 {
        return Err(Unusable::Damaged);
    }
    let px = rgb
        .as_chunks::<3>()
        .0
        .iter()
        .map(|&[r, g, b]| [r, g, b, 255])
        .collect();
    Image::from_rgba(w, h, px).map_err(|_| Unusable::Damaged)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2 x 2: red, green on top; blue, white below.
    fn quad() -> Image {
        Image::from_rgba(
            2,
            2,
            vec![
                [255, 0, 0, 255],
                [0, 255, 0, 255],
                [0, 0, 255, 255],
                [255, 255, 255, 255],
            ],
        )
        .unwrap()
    }

    #[test]
    fn v_points_up_so_row_0_is_the_top_of_the_texture() {
        let img = quad();
        let n = (Wrap::Repeat, Wrap::Repeat);
        assert_eq!(img.sample([0.25, 0.75], 0.0, n), Some([255, 0, 0]));
        assert_eq!(img.sample([0.75, 0.75], 0.0, n), Some([0, 255, 0]));
        assert_eq!(img.sample([0.25, 0.25], 0.0, n), Some([0, 0, 255]));
        assert_eq!(img.sample([0.75, 0.25], 0.0, n), Some([255, 255, 255]));
    }

    #[test]
    fn wrap_mirror_clamp_and_none_read_outside_0_to_1_as_they_should() {
        let img = quad();
        let at = |u: f64, w: Wrap| img.sample([u, 0.75], 0.0, (w, Wrap::Repeat));
        assert_eq!(at(1.25, Wrap::Repeat), Some([255, 0, 0]));
        assert_eq!(at(1.25, Wrap::Mirror), Some([0, 255, 0]));
        assert_eq!(at(1.75, Wrap::Mirror), Some([255, 0, 0]));
        assert_eq!(at(1.25, Wrap::Clamp), Some([0, 255, 0]));
        assert_eq!(at(-3.0, Wrap::Clamp), Some([255, 0, 0]));
        assert_eq!(at(1.25, Wrap::None), None);
        assert_eq!(at(0.25, Wrap::None), Some([255, 0, 0]));
    }

    #[test]
    fn a_magnified_texture_keeps_its_texel_edges() {
        let img = Image::from_rgba(2, 1, vec![[0, 0, 0, 255], [255, 255, 255, 255]]).unwrap();
        let c = (Wrap::Clamp, Wrap::Clamp);
        assert_eq!(img.sample([0.49, 0.5], 0.0, c), Some([0, 0, 0]));
        assert_eq!(img.sample([0.51, 0.5], 0.0, c), Some([255, 255, 255]));
        assert_eq!(img.sample([1.0, 0.5], 0.0, c), Some([255, 255, 255]));
    }

    #[test]
    fn a_patch_many_texels_across_sees_their_average() {
        let mut px = Vec::new();
        for y in 0..64 {
            for x in 0..64 {
                px.push(if (x + y) % 2 == 0 {
                    [255, 0, 0, 255]
                } else {
                    [0, 0, 255, 255]
                });
            }
        }
        let img = Image::from_rgba(64, 64, px).unwrap();
        let c = img
            .sample([0.5, 0.5], 32.0, (Wrap::Repeat, Wrap::Repeat))
            .unwrap();
        assert!(c[0] > 150 && c[2] > 150 && c[1] < 10, "{c:?}");
    }

    #[test]
    fn texels_under_half_alpha_are_no_texture() {
        let img = Image::from_rgba(1, 1, vec![[255, 0, 0, 100]]).unwrap();
        assert_eq!(img.sample([0.5, 0.5], 0.0, (Wrap::Repeat, Wrap::Repeat)), None);
    }

    #[test]
    fn png_and_jpeg_decode_and_other_bytes_are_refused() {
        let png = crate::texture::tests::png_rgb(2, 2, &[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
        let img = decode(&png).unwrap();
        assert_eq!(img.size(), (2, 2));
        assert_eq!(
            img.sample([0.25, 0.75], 0.0, (Wrap::Repeat, Wrap::Repeat)),
            Some([255, 0, 0])
        );
        assert_eq!(decode(b"GIF89a").err(), Some(Unusable::NotImage));
        assert_eq!(decode(&[0xFF, 0xD8, 0, 0]).err(), Some(Unusable::Damaged));
        assert_eq!(decode(&png[..png.len() / 2]).err(), Some(Unusable::Damaged));
    }

    #[test]
    fn a_texture_left_out_is_said_in_a_sentence() {
        assert_eq!(
            Unusable::NotImage.note("a.png"),
            "The texture a.png is not a PNG or JPEG image, so it is left out."
        );
        assert_eq!(
            Unusable::Damaged.note("maps/b.jpg"),
            "The texture maps/b.jpg is damaged, so it is left out."
        );
    }

    #[test]
    fn a_png_over_the_largest_side_is_reduced_while_it_decodes() {
        let (w, h) = (MAX_SIDE + 8, 4);
        let mut rgb = Vec::with_capacity(w * h * 3);
        for _ in 0..h {
            for x in 0..w {
                rgb.extend(if x < w / 2 { [255, 0, 0] } else { [0, 0, 255] });
            }
        }
        let img = decode(&crate::texture::tests::png_rgb(w, h, &rgb)).unwrap();
        assert_eq!(img.size(), (w.div_ceil(2), 2));
        assert_eq!(img.file_size, (w, h));
        let n = (Wrap::Clamp, Wrap::Clamp);
        assert_eq!(img.sample([0.1, 0.5], 0.0, n), Some([255, 0, 0]));
        assert_eq!(img.sample([0.9, 0.5], 0.0, n), Some([0, 0, 255]));
    }
}
