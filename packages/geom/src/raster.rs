// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Raster images: PNG and JPEG decoded to one RGBA level, upright or as stored, box reduced in linear light. Trace
//! and texture paint both read images here.
// pixel offsets are within each image's pixel count, made from its own width and height
#![allow(clippy::indexing_slicing)]

use crate::fm::Fm as _;

/// The largest side kept; a bigger image is box reduced while it decodes.
pub const MAX_SIDE: usize = 4096;
/// A PNG past this is refused before it decodes.
const MAX_PNG_SIDE: usize = 4 * MAX_SIDE;
/// A JPEG past this is refused before it decodes.
// a JPEG decodes whole before it is reduced: 8192 px covers 24 and 48 MP photos
const MAX_JPEG_SIDE: usize = 2 * MAX_SIDE;
/// The most pixels a file may have.
const MAX_PIXELS: usize = 100_000_000;
/// The largest file read.
pub const MAX_BYTES: usize = 30 << 20;
/// The most a JPEG may ask the decoder to set aside: an 8192 px square baseline photo, or a progressive one of about
/// 30 megapixels at 4:4:4, whose coefficients are all kept until its last scan.
const MAX_DECODE_BYTES: usize = 256 << 20;

/// How a caller reads an image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Read {
    /// Turned the way EXIF says it is shown, or left as the file stores it.
    pub upright: bool,
    /// The longest side of a JPEG; one past [`MAX_SIDE`] decodes whole and is reduced.
    pub jpeg_side: usize,
    /// The most pixels a PNG may have.
    pub png_pixels: usize,
    /// How a reduced image rounds back to sRGB.
    pub round: Round,
}

/// Trace: upright, a JPEG up to 8192 px a side, a PNG up to 100 megapixels.
pub const TRACE: Read = Read {
    upright: true,
    jpeg_side: MAX_JPEG_SIDE,
    png_pixels: MAX_PIXELS,
    round: Round::Table,
};

/// Texture paint: as stored, since UVs are in the stored orientation, and a JPEG within [`MAX_SIDE`].
pub const TEXTURE: Read = Read {
    upright: false,
    jpeg_side: MAX_SIDE,
    png_pixels: usize::MAX,
    round: Round::Curve,
};

/// Pixels in sRGB with straight alpha, rows from the top.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raster {
    pub w: usize,
    pub h: usize,
    pub px: Vec<[u8; 4]>,
    /// The size as the file has it, upright.
    pub file_size: (usize, usize),
}

/// Why an image file could not be read.
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
    /// The reason in a few words: "is too large to read".
    #[must_use]
    pub fn why(self) -> &'static str {
        match self {
            Self::NotImage => "is not a PNG or JPEG image",
            Self::Damaged => "is damaged",
            Self::TooLarge => {
                "is too large to read; save it smaller or as a baseline JPEG (a JPEG reads up to 8192 px a side, or about 25 megapixels if progressive; a PNG up to 16384 px a side, or 4096 if interlaced)"
            }
            Self::Unsupported => "is a kind of JPEG that is not read",
        }
    }
}

impl Raster {
    /// A raster from its pixels.
    pub fn new(w: usize, h: usize, px: Vec<[u8; 4]>) -> std::result::Result<Self, Unusable> {
        if w == 0 || h == 0 || px.len() != w * h {
            return Err(Unusable::Damaged);
        }
        Ok(Self {
            w,
            h,
            px,
            file_size: (w, h),
        })
    }

    /// The raster box reduced by the smallest whole factor that brings its long side to `max_side` or under.
    #[must_use]
    pub fn reduced(&self, max_side: usize) -> Self {
        let k = self.w.max(self.h).div_ceil(max_side.max(1)).max(1);
        if k == 1 {
            return self.clone();
        }
        let light = Light::new(Round::Table);
        let (w, h) = (self.w.div_ceil(k), self.h.div_ceil(k));
        let mut px = Vec::with_capacity(w * h);
        let mut block = Vec::with_capacity(k * k);
        for y in 0..h {
            for x in 0..w {
                block.clear();
                for sy in y * k..((y + 1) * k).min(self.h) {
                    let row = sy * self.w;
                    block.extend_from_slice(&self.px[row + x * k..row + ((x + 1) * k).min(self.w)]);
                }
                px.push(light.average(&block));
            }
        }
        Self {
            w,
            h,
            px,
            file_size: self.file_size,
        }
    }
}

/// How an average in linear light is put back in sRGB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Round {
    /// By tables made from the same f64 curve on every target (trace).
    Table,
    /// By the curve itself, from steps read as f32 (texture paint, whose levels reduce the same way).
    Curve,
}

/// sRGB to linear light and back.
pub(crate) struct Light {
    lin: [f32; 256],
    /// the linear value where each sRGB step rounds up to the next
    up: [f32; 255],
    round: Round,
}

/// The sRGB curve from 0 to 1 into linear light.
fn curve(c: f64) -> f64 {
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).m_powf(2.4)
    }
}

impl Light {
    pub(crate) fn new(round: Round) -> Self {
        // an f32 table, so no target reads the curve differently
        #[allow(clippy::cast_possible_truncation)]
        let at = |c: f64| curve(c) as f32;
        let mut lin = [0f32; 256];
        for (i, v) in lin.iter_mut().enumerate() {
            *v = match round {
                Round::Table => at(i as f64 / 255.0),
                // the step read as f32 first, as texture levels always have
                Round::Curve => {
                    let c = i as f32 / 255.0;
                    if c <= 0.040_45 {
                        c / 12.92
                    } else {
                        at(f64::from(c))
                    }
                }
            };
        }
        let mut up = [0f32; 255];
        for (i, v) in up.iter_mut().enumerate() {
            *v = at((i as f64 + 0.5) / 255.0);
        }
        Self { lin, up, round }
    }

    fn srgb(&self, v: f32) -> u8 {
        if self.round == Round::Table {
            return u8::try_from(self.up.partition_point(|&t| t <= v)).unwrap_or(u8::MAX);
        }
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

    /// Averages `pixels` in linear light, colors weighted by their alpha.
    pub(crate) fn average(&self, pixels: &[[u8; 4]]) -> [u8; 4] {
        let (mut r, mut g, mut b, mut a) = (0f32, 0f32, 0f32, 0f32);
        for p in pixels {
            let w = f32::from(p[3]) / 255.0;
            r += self.lin[usize::from(p[0])] * w;
            g += self.lin[usize::from(p[1])] * w;
            b += self.lin[usize::from(p[2])] * w;
            a += w;
        }
        if a <= 0.0 {
            return [0, 0, 0, 0];
        }
        let n = pixels.len().max(1) as f32;
        // within 0 to 255 after the clamp
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let alpha = (a / n * 255.0).round().clamp(0.0, 255.0) as u8;
        [self.srgb(r / a), self.srgb(g / a), self.srgb(b / a), alpha]
    }
}

/// Decodes a PNG or JPEG (by its first bytes) for trace: upright, and at most [`MAX_BYTES`].
pub fn decode(bytes: &[u8]) -> std::result::Result<Raster, Unusable> {
    if bytes.len() > MAX_BYTES {
        return Err(Unusable::TooLarge);
    }
    read(bytes, TRACE)
}

/// Decodes a PNG or JPEG (by its first bytes) as `how` says.
pub fn read(bytes: &[u8], how: Read) -> std::result::Result<Raster, Unusable> {
    let (r, exif) = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        decode_png(bytes, how)?
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        decode_jpeg(bytes, how)?
    } else {
        return Err(Unusable::NotImage);
    };
    if !how.upright {
        return Ok(r);
    }
    Ok(upright(r, exif.as_deref().map_or(1, orientation)))
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

type Decoded = (Raster, Option<Vec<u8>>);

fn decode_png(bytes: &[u8], how: Read) -> std::result::Result<Decoded, Unusable> {
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
    if w > MAX_PNG_SIDE || h > MAX_PNG_SIDE || w * h > how.png_pixels {
        return Err(Unusable::TooLarge);
    }
    let (color, _) = reader.output_color_type();
    let k = w.max(h).div_ceil(MAX_SIDE).max(1);
    // an interlaced image cannot be reduced row by row
    if k > 1 && reader.info().interlaced {
        return Err(Unusable::TooLarge);
    }
    let (ow, oh) = (w.div_ceil(k), h.div_ceil(k));
    // reserved once the first rows have decoded, so a header alone commits no memory
    let mut out: Vec<[u8; 4]> = Vec::new();
    if reader.info().interlaced {
        let size = reader.output_buffer_size().ok_or(Unusable::TooLarge)?;
        let mut buf = vec![0u8; size];
        let info = reader.next_frame(&mut buf).map_err(|_| Unusable::Damaged)?;
        let line = info.line_size;
        out.reserve_exact(ow * oh);
        for y in 0..h {
            let row = buf.get(y * line..(y + 1) * line).ok_or(Unusable::Damaged)?;
            to_rgba(color, row, &mut out);
        }
    } else {
        // row by row, so the file's pixels are never all held at once
        let mut shrink = Shrink::new(k, w, how.round);
        for y in 0..h {
            let row = reader
                .next_row()
                .map_err(|_| Unusable::Damaged)?
                .ok_or(Unusable::Damaged)?;
            if y == 0 {
                out.reserve_exact(ow * oh);
            }
            if k == 1 {
                to_rgba(color, row.data(), &mut out);
                continue;
            }
            let mut px = Vec::with_capacity(w);
            to_rgba(color, row.data(), &mut px);
            shrink.row(px, y + 1 == h, &mut out);
        }
    }
    // reads on to the end, where an eXIf chunk may come after the pixels; a damaged tail costs only the orientation
    let _ = reader.finish();
    let exif = reader.info().exif_metadata.as_ref().map(|e| e.to_vec());
    let mut r = Raster::new(ow, oh, out)?;
    r.file_size = (w, h);
    Ok((r, exif))
}

/// A JPEG frame's kind, width and height.
type Frame = (u8, usize, usize);

/// A JPEG's frame kind and size from its frame header, before anything decodes.
fn jpeg_frame(bytes: &[u8]) -> Option<Frame> {
    let i = jpeg_sof(bytes)?;
    let h = u16::from_be_bytes([*bytes.get(i + 5)?, *bytes.get(i + 6)?]);
    let w = u16::from_be_bytes([*bytes.get(i + 7)?, *bytes.get(i + 8)?]);
    Some((*bytes.get(i + 1)?, usize::from(w), usize::from(h)))
}

/// Where a JPEG's frame header starts, at its marker.
fn jpeg_sof(bytes: &[u8]) -> Option<usize> {
    // every start of frame but huffman tables (c4), the reserved c8 and arithmetic conditioning (cc)
    jpeg_marker(bytes, |m| {
        (0xC0..=0xCF).contains(&m) && !matches!(m, 0xC4 | 0xC8 | 0xCC)
    })
}

/// How many components the first scan of a JPEG holds, from its scan header.
fn jpeg_first_scan(bytes: &[u8]) -> Option<usize> {
    let i = jpeg_marker(bytes, |m| m == 0xDA)?;
    bytes.get(i + 4).map(|&n| usize::from(n))
}

/// Where the first marker that `want` takes starts, walking the segments as the decoder does; none past the end or,
/// unless it is wanted, the first scan.
fn jpeg_marker(bytes: &[u8], want: impl Fn(u8) -> bool) -> Option<usize> {
    let mut i = 2;
    loop {
        // stray bytes before a marker are skipped, as the decoder skips them
        while *bytes.get(i)? != 0xFF {
            i += 1;
        }
        let m = *bytes.get(i + 1)?;
        match m {
            // fill bytes, and a stuffed zero; every other marker has a length, as the decoder reads it
            0xFF => i += 1,
            0x00 => i += 2,
            _ if want(m) => return Some(i),
            // the end, or the scan with what was wanted not seen
            0xD9 | 0xDA => return None,
            _ => {
                let len = usize::from(u16::from_be_bytes([*bytes.get(i + 2)?, *bytes.get(i + 3)?]));
                // a length counts its own two bytes
                if len < 2 {
                    return None;
                }
                i += 2 + len;
            }
        }
    }
}

/// Refuses a JPEG frame, as the decoder read it from the headers, that asks for more decoding memory than
/// [`MAX_DECODE_BYTES`], or for more blocks than the file's `bytes` could hold, before anything is set aside for it.
/// The sampling is not known here, so each component is counted at full size on blocks of up to 2 x 2. `kept` is a
/// frame whose every coefficient is kept until its last scan.
fn jpeg_budget(
    bytes: usize,
    w: usize,
    h: usize,
    components: usize,
    kept: bool,
) -> std::result::Result<(), Unusable> {
    // the first scan codes every block of the largest component in a bit at least
    if bytes < w.div_ceil(8) * h.div_ceil(8) / 8 {
        return Err(Unusable::Damaged);
    }
    // the RGB output, and for a frame kept to the end two bytes for each coefficient of every block
    let coefficients = if kept {
        components.max(1) * w.div_ceil(16) * 2 * h.div_ceil(16) * 2 * 64 * 2
    } else {
        0
    };
    if w * h * 3 + coefficients > MAX_DECODE_BYTES {
        return Err(Unusable::TooLarge);
    }
    Ok(())
}

/// k x k blocks of pixels averaged in linear light, k rows at a time.
struct Shrink {
    k: usize,
    w: usize,
    band: Vec<Vec<[u8; 4]>>,
    block: Vec<[u8; 4]>,
    light: Light,
}

impl Shrink {
    fn new(k: usize, w: usize, round: Round) -> Self {
        Self {
            k,
            w,
            band: Vec::with_capacity(k),
            block: Vec::with_capacity(k * k),
            light: Light::new(round),
        }
    }

    fn row(&mut self, px: Vec<[u8; 4]>, last: bool, out: &mut Vec<[u8; 4]>) {
        self.band.push(px);
        if self.band.len() < self.k && !last {
            return;
        }
        for ox in 0..self.w.div_ceil(self.k) {
            self.block.clear();
            for r in &self.band {
                let end = ((ox + 1) * self.k).min(self.w);
                self.block
                    .extend_from_slice(r.get(ox * self.k..end).unwrap_or_default());
            }
            out.push(self.light.average(&self.block));
        }
        self.band.clear();
    }
}

fn decode_jpeg(bytes: &[u8], how: Read) -> std::result::Result<Decoded, Unusable> {
    use zune_jpeg::zune_core::bytestream::ZCursor;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    // the decoder reports a size over its limits, or a kind it does not read, as a damaged file, so a frame header
    // found first says which; this only refuses sooner, and the budget below runs on the frame the decoder reads
    if let Some((kind, w, h)) = jpeg_frame(bytes) {
        // within these sides a JPEG is always under the pixel limit
        if w > how.jpeg_side || h > how.jpeg_side {
            return Err(Unusable::TooLarge);
        }
        // only baseline, extended huffman and progressive are read
        if kind > 0xC2 {
            return Err(Unusable::Unsupported);
        }
    }
    let options = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGB)
        .set_max_width(how.jpeg_side)
        .set_max_height(how.jpeg_side);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let refused = |e: zune_jpeg::errors::DecodeErrors| match e {
        zune_jpeg::errors::DecodeErrors::LargeDimensions(_) => Unusable::TooLarge,
        zune_jpeg::errors::DecodeErrors::Unsupported(_) => Unusable::Unsupported,
        _ => Unusable::Damaged,
    };
    // the headers alone, then the budget on the frame they hold, and only then the pixels
    dec.decode_headers().map_err(refused)?;
    let head = dec.info().ok_or(Unusable::Damaged)?;
    // the decoder keeps every coefficient of a progressive frame, and of a baseline one whose first scan holds fewer
    // components than the frame (each in a scan of its own); a scan the walk cannot find counts as one of those
    let components = usize::from(head.components);
    let kept = head.sof.is_progressive() || jpeg_first_scan(bytes).is_none_or(|n| n < components);
    jpeg_budget(
        bytes.len(),
        usize::from(head.width),
        usize::from(head.height),
        components,
        kept,
    )?;
    let rgb = dec.decode().map_err(refused)?;
    let info = dec.info().ok_or(Unusable::Damaged)?;
    let (w, h) = (usize::from(info.width), usize::from(info.height));
    if rgb.len() != w * h * 3 {
        return Err(Unusable::Damaged);
    }
    let exif = dec.exif().cloned();
    drop(dec);
    let k = w.max(h).div_ceil(MAX_SIDE).max(1);
    let mut px = Vec::with_capacity(w.div_ceil(k) * h.div_ceil(k));
    let mut shrink = Shrink::new(k, w, how.round);
    for (y, row) in rgb.chunks_exact(w * 3).enumerate() {
        let row = row.as_chunks::<3>().0.iter().map(|&[r, g, b]| [r, g, b, 255]);
        if k == 1 {
            px.extend(row);
        } else {
            shrink.row(row.collect(), y + 1 == h, &mut px);
        }
    }
    drop(rgb);
    let mut r = Raster::new(w.div_ceil(k), h.div_ceil(k), px)?;
    r.file_size = (w, h);
    Ok((r, exif))
}

/// The EXIF orientation (1 to 8) in a TIFF block, 1 when it has none.
#[must_use]
pub fn orientation(tiff: &[u8]) -> u8 {
    let le = match tiff.get(..4) {
        Some([b'I', b'I', 42, 0]) => true,
        Some([b'M', b'M', 0, 42]) => false,
        _ => return 1,
    };
    let u16_at = |i: usize| {
        tiff.get(i..i + 2).map(|b| {
            let b = [b[0], b[1]];
            if le {
                u16::from_le_bytes(b)
            } else {
                u16::from_be_bytes(b)
            }
        })
    };
    let u32_at = |i: usize| {
        tiff.get(i..i + 4).map(|b| {
            let b = [b[0], b[1], b[2], b[3]];
            if le {
                u32::from_le_bytes(b)
            } else {
                u32::from_be_bytes(b)
            }
        })
    };
    let Some(ifd) = u32_at(4).map(|o| o as usize) else {
        return 1;
    };
    let n = usize::from(u16_at(ifd).unwrap_or(0));
    for e in 0..n {
        let at = ifd + 2 + e * 12;
        // tag 0x0112 as a short
        if u16_at(at) == Some(0x0112) && u16_at(at + 2) == Some(3) {
            return match u16_at(at + 8) {
                Some(v @ 1..=8) => u8::try_from(v).unwrap_or(1),
                _ => 1,
            };
        }
    }
    1
}

/// `r` turned the way an EXIF `orientation` says it is shown.
#[must_use]
pub fn upright(r: Raster, orientation: u8) -> Raster {
    if !(2..=8).contains(&orientation) {
        return r;
    }
    let (sw, sh) = (r.w, r.h);
    let swap = orientation >= 5;
    let (w, h) = if swap { (sh, sw) } else { (sw, sh) };
    let mut px = Vec::with_capacity(w * h);
    for oy in 0..h {
        for ox in 0..w {
            let (sx, sy) = match orientation {
                2 => (sw - 1 - ox, oy),
                3 => (sw - 1 - ox, sh - 1 - oy),
                4 => (ox, sh - 1 - oy),
                5 => (oy, ox),
                6 => (oy, sh - 1 - ox),
                7 => (sw - 1 - oy, sh - 1 - ox),
                _ => (sw - 1 - oy, ox),
            };
            px.push(r.px[sy * sw + sx]);
        }
    }
    let file_size = if swap {
        (r.file_size.1, r.file_size.0)
    } else {
        r.file_size
    };
    Raster { w, h, px, file_size }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn crc32(data: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in data {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    (c >> 1) ^ 0xEDB8_8320
                } else {
                    c >> 1
                };
            }
        }
        !c
    }

    /// A PNG of `w` x `h` pixels, `channels` bytes each (1 gray, 3 RGB, 4 RGBA), with an optional eXIf chunk.
    pub(crate) fn png(w: usize, h: usize, channels: usize, data: &[u8], exif: Option<&[u8]>) -> Vec<u8> {
        let mut raw = Vec::with_capacity((w * channels + 1) * h);
        for y in 0..h {
            raw.push(0);
            raw.extend_from_slice(&data[y * w * channels..(y + 1) * w * channels]);
        }
        let mut out = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
        let mut chunk = |kind: &[u8; 4], data: &[u8]| {
            out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
            let mut body = kind.to_vec();
            body.extend_from_slice(data);
            out.extend_from_slice(&body);
            out.extend_from_slice(&crc32(&body).to_be_bytes());
        };
        let kind = match channels {
            1 => 0,
            3 => 2,
            _ => 6,
        };
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&u32::try_from(w).unwrap().to_be_bytes());
        ihdr.extend_from_slice(&u32::try_from(h).unwrap().to_be_bytes());
        ihdr.extend_from_slice(&[8, kind, 0, 0, 0]);
        chunk(b"IHDR", &ihdr);
        if let Some(e) = exif {
            chunk(b"eXIf", e);
        }
        chunk(b"IDAT", &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6));
        chunk(b"IEND", &[]);
        out
    }

    /// A little endian TIFF block: an image width, the orientation and a resolution unit.
    pub(crate) fn exif_orientation(o: u16) -> Vec<u8> {
        let mut t = b"II*\0".to_vec();
        t.extend_from_slice(&8u32.to_le_bytes());
        t.extend_from_slice(&3u16.to_le_bytes());
        for (tag, v) in [(0x0100u16, 48u16), (0x0112, o), (0x0128, 2)] {
            t.extend_from_slice(&tag.to_le_bytes());
            t.extend_from_slice(&3u16.to_le_bytes());
            t.extend_from_slice(&1u32.to_le_bytes());
            t.extend_from_slice(&v.to_le_bytes());
            t.extend_from_slice(&[0, 0]);
        }
        t.extend_from_slice(&[0, 0, 0, 0]);
        t
    }

    /// `png` with a chunk put just before its end.
    fn with_chunk_at_end(png: &[u8], kind: [u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = png[..png.len() - 12].to_vec();
        out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
        out.extend_from_slice(&png[png.len() - 12..]);
        out
    }

    /// The start of a JPEG whose frame header of kind `sof` says `w` x `h`, and nothing after it.
    fn jpeg_header(sof: u8, w: u16, h: u16) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8, 0xFF, sof, 0, 11, 8];
        j.extend_from_slice(&h.to_be_bytes());
        j.extend_from_slice(&w.to_be_bytes());
        j.extend_from_slice(&[1, 1, 0x11, 0]);
        j
    }

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/tests/fixtures/trace/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// The checked-in JPEG: 48 x 32, white with a black 16 px square 4 px in from the top left.
    fn fixture_jpeg() -> Vec<u8> {
        std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/trace/square.jpg"
        ))
        .unwrap()
    }

    /// `jpeg` with an APP1 EXIF segment holding `tiff` put right after its start marker.
    fn with_exif(jpeg: &[u8], tiff: &[u8]) -> Vec<u8> {
        with_exif_at(jpeg, tiff, 2)
    }

    /// `jpeg` with an APP1 EXIF segment holding `tiff` put `at` bytes in.
    fn with_exif_at(jpeg: &[u8], tiff: &[u8], at: usize) -> Vec<u8> {
        let mut out = jpeg[..at].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&u16::try_from(tiff.len() + 8).unwrap().to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(tiff);
        out.extend_from_slice(&jpeg[at..]);
        out
    }

    fn dark(r: &Raster, x: usize, y: usize) -> bool {
        r.px[y * r.w + x][0] < 128
    }

    #[test]
    fn png_gray_rgb_and_rgba_decode_and_other_bytes_are_refused() {
        let gray = decode(&png(2, 1, 1, &[0, 200], None)).unwrap();
        assert_eq!(gray.px, vec![[0, 0, 0, 255], [200, 200, 200, 255]]);
        let rgb = decode(&png(1, 2, 3, &[255, 0, 0, 0, 0, 255], None)).unwrap();
        assert_eq!((rgb.w, rgb.h), (1, 2));
        assert_eq!(rgb.px, vec![[255, 0, 0, 255], [0, 0, 255, 255]]);
        let rgba = decode(&png(1, 1, 4, &[1, 2, 3, 40], None)).unwrap();
        assert_eq!(rgba.px, vec![[1, 2, 3, 40]]);
        let good = png(2, 2, 3, &[0; 12], None);
        assert_eq!(decode(b"GIF89a").err(), Some(Unusable::NotImage));
        assert_eq!(decode(&[0xFF, 0xD8, 0, 0]).err(), Some(Unusable::Damaged));
        assert_eq!(decode(&good[..good.len() / 2]).err(), Some(Unusable::Damaged));
        let mut huge = good.clone();
        huge.resize(MAX_BYTES + 1, 0);
        assert_eq!(decode(&huge).err(), Some(Unusable::TooLarge));
    }

    #[test]
    fn a_png_over_the_largest_side_is_reduced_while_it_decodes_and_one_far_over_is_refused() {
        let (w, h) = (MAX_SIDE + 8, 4);
        let mut rgb = Vec::with_capacity(w * h * 3);
        for _ in 0..h {
            for x in 0..w {
                rgb.extend(if x < w / 2 { [255, 0, 0] } else { [0, 0, 255] });
            }
        }
        let r = decode(&png(w, h, 3, &rgb, None)).unwrap();
        assert_eq!((r.w, r.h), (w.div_ceil(2), 2));
        assert_eq!(r.file_size, (w, h));
        assert_eq!(r.px[0], [255, 0, 0, 255]);
        assert_eq!(r.px[r.w - 1], [0, 0, 255, 255]);
        let mut ihdr_only = png(1, 1, 3, &[0; 3], None);
        // the width field of IHDR, past the largest side a PNG may have
        ihdr_only[16..20].copy_from_slice(&u32::try_from(MAX_PNG_SIDE + 1).unwrap().to_be_bytes());
        let body_crc = crc32(&ihdr_only[12..29]);
        ihdr_only[29..33].copy_from_slice(&body_crc.to_be_bytes());
        assert_eq!(decode(&ihdr_only).err(), Some(Unusable::TooLarge));
    }

    #[test]
    fn the_jpeg_fixture_decodes_with_its_square_at_the_top_left() {
        let r = decode(&fixture_jpeg()).unwrap();
        assert_eq!((r.w, r.h), (48, 32));
        assert!(dark(&r, 10, 10) && !dark(&r, 40, 10) && !dark(&r, 10, 28));
    }

    #[test]
    fn a_jpeg_with_exif_orientation_6_is_turned_upright() {
        // 6: stored turned a quarter left, so it is shown turned a quarter right; the square lands top right
        let r = decode(&with_exif(&fixture_jpeg(), &exif_orientation(6))).unwrap();
        assert_eq!((r.w, r.h), (32, 48));
        assert_eq!(r.file_size, (32, 48));
        assert!(dark(&r, 21, 10), "top right");
        assert!(!dark(&r, 10, 10) && !dark(&r, 21, 40));
    }

    #[test]
    fn a_png_with_an_exif_chunk_is_turned_upright() {
        // 3 x 2, the top left pixel black: orientation 8 shows it at the bottom left
        let mut gray = vec![255u8; 6];
        gray[0] = 0;
        let r = decode(&png(3, 2, 1, &gray, Some(&exif_orientation(8)))).unwrap();
        assert_eq!((r.w, r.h), (2, 3));
        assert!(dark(&r, 0, 2));
        assert_eq!(r.px.iter().filter(|p| p[0] == 0).count(), 1);
    }

    #[test]
    fn every_orientation_shows_the_whole_image_as_exif_says() {
        // 3 x 2, pixels 0 1 2 over 3 4 5; each orientation as it is shown, rows from the top
        let src = Raster::new(3, 2, (0..6).map(|v| [v, 0, 0, 255]).collect()).unwrap();
        let want: [(u8, usize, [u8; 6]); 8] = [
            (1, 3, [0, 1, 2, 3, 4, 5]),
            (2, 3, [2, 1, 0, 5, 4, 3]),
            (3, 3, [5, 4, 3, 2, 1, 0]),
            (4, 3, [3, 4, 5, 0, 1, 2]),
            (5, 2, [0, 3, 1, 4, 2, 5]),
            (6, 2, [3, 0, 4, 1, 5, 2]),
            (7, 2, [5, 2, 4, 1, 3, 0]),
            (8, 2, [2, 5, 1, 4, 0, 3]),
        ];
        for (o, w, grid) in want {
            let r = upright(src.clone(), o);
            assert_eq!((r.w, r.h), (w, 6 / w), "orientation {o}");
            assert_eq!(
                r.px.iter().map(|p| p[0]).collect::<Vec<_>>(),
                grid,
                "orientation {o}"
            );
        }
        assert_eq!(orientation(&exif_orientation(6)), 6);
        assert_eq!(orientation(b"II*\0"), 1);
        assert_eq!(orientation(b"nothing"), 1);
        let mut be = b"MM\0*".to_vec();
        be.extend_from_slice(&8u32.to_be_bytes());
        be.extend_from_slice(&1u16.to_be_bytes());
        be.extend_from_slice(&[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 3, 0, 0]);
        assert_eq!(orientation(&be), 3);
    }

    #[test]
    fn a_png_with_its_exif_chunk_after_the_pixels_is_turned_upright() {
        let mut gray = vec![255u8; 6];
        gray[0] = 0;
        let file = with_chunk_at_end(&png(3, 2, 1, &gray, None), *b"eXIf", &exif_orientation(8));
        let r = decode(&file).unwrap();
        assert_eq!((r.w, r.h), (2, 3));
        assert!(dark(&r, 0, 2));
    }

    #[test]
    fn a_jpeg_too_large_is_refused_as_too_large_before_it_decodes() {
        assert_eq!(
            decode(&jpeg_header(0xC0, 8193, 10)).err(),
            Some(Unusable::TooLarge)
        );
        assert_eq!(
            decode(&jpeg_header(0xC2, 65535, 65535)).err(),
            Some(Unusable::TooLarge)
        );
        assert_eq!(
            decode(&jpeg_header(0xC0, 10, 8193)).err(),
            Some(Unusable::TooLarge)
        );
        // within the limit, a header alone is only damaged
        assert_eq!(
            decode(&jpeg_header(0xC0, 8192, 8192)).err(),
            Some(Unusable::Damaged)
        );
        // arithmetic coding is not read
        assert_eq!(
            decode(&jpeg_header(0xC9, 8, 8)).err(),
            Some(Unusable::Unsupported)
        );
        // a PNG with more pixels than the budget, though each side is within its limit
        let mut file = png(1, 1, 3, &[0; 3], None);
        file[16..20].copy_from_slice(&16_000u32.to_be_bytes());
        file[20..24].copy_from_slice(&16_000u32.to_be_bytes());
        let crc = crc32(&file[12..29]);
        file[29..33].copy_from_slice(&crc.to_be_bytes());
        assert_eq!(decode(&file).err(), Some(Unusable::TooLarge));
    }

    #[test]
    fn a_jpeg_over_the_largest_side_is_reduced_in_linear_light() {
        let r = decode(&fixture("wide.jpg")).unwrap();
        assert_eq!((r.w, r.h), (2052, 8));
        assert_eq!(r.file_size, (4104, 16));
        assert!(dark(&r, 10, 4) && !dark(&r, 2040, 4));
    }

    #[test]
    fn a_subsampled_jpeg_and_exif_after_the_first_segment_read_too() {
        let r = decode(&fixture("square-420.jpg")).unwrap();
        assert_eq!((r.w, r.h), (48, 32));
        assert!(dark(&r, 10, 10) && !dark(&r, 40, 10));
        // after the comment segment the encoder writes first
        let jpeg = fixture_jpeg();
        let at = 4 + usize::from(u16::from_be_bytes([jpeg[4], jpeg[5]]));
        let r = decode(&with_exif_at(&jpeg, &exif_orientation(6), at)).unwrap();
        assert_eq!((r.w, r.h), (32, 48));
        assert!(dark(&r, 21, 10));
    }

    #[test]
    fn reducing_averages_in_linear_light_and_keeps_alpha_weighted_colors() {
        // black and white average to the sRGB of half linear light, not 128
        let r = Raster::new(2, 1, vec![[0, 0, 0, 255], [255, 255, 255, 255]]).unwrap();
        let half = r.reduced(1);
        assert_eq!((half.w, half.h), (1, 1));
        assert_eq!(half.px[0], [188, 188, 188, 255]);
        // a clear pixel does not darken its opaque neighbor's color
        let r = Raster::new(2, 1, vec![[255, 0, 0, 255], [0, 0, 0, 0]]).unwrap();
        assert_eq!(r.reduced(1).px[0], [255, 0, 0, 128]);
        let big = Raster::new(5000, 1, vec![[9, 9, 9, 255]; 5000]).unwrap();
        let k = big.reduced(2048);
        assert_eq!((k.w, k.h), (1667, 1));
        assert_eq!(k.file_size, (5000, 1));
        assert_eq!(r.reduced(4096), r);
    }

    /// A JPEG start, then `parts` in order.
    fn jpeg(parts: &[&[u8]]) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8];
        for p in parts {
            j.extend_from_slice(p);
        }
        j
    }

    /// A segment of kind `m` holding `body`, with its length.
    fn segment(m: u8, body: &[u8]) -> Vec<u8> {
        let mut s = vec![0xFF, m];
        s.extend_from_slice(&u16::try_from(body.len() + 2).unwrap().to_be_bytes());
        s.extend_from_slice(body);
        s
    }

    /// A frame header of kind `m` for `w` x `h`, one component.
    fn sof(m: u8, w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![8];
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[1, 1, 0x11, 0]);
        segment(m, &b)
    }

    #[test]
    fn the_jpeg_frame_is_found_past_other_segments_and_odd_bytes() {
        let app0 = segment(0xE0, b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        let app1 = segment(0xE1, &exif_orientation(6));
        let com = segment(0xFE, b"made here");
        let dht = segment(0xC4, &[0x00; 17]);
        let dqt = segment(0xDB, &[0x00; 65]);
        let big = sof(0xC0, 16_000, 10);
        let cases: [(Vec<u8>, Option<Frame>); 13] = [
            (jpeg(&[&app0, &app1, &big]), Some((0xC0, 16_000, 10))),
            (jpeg(&[&com, &sof(0xC0, 9000, 10)]), Some((0xC0, 9000, 10))),
            (jpeg(&[&dqt, &dht, &sof(0xC2, 8193, 10)]), Some((0xC2, 8193, 10))),
            // fill bytes before a marker
            (jpeg(&[&[0xFF, 0xFF, 0xFF], &big]), Some((0xC0, 16_000, 10))),
            // stray bytes between segments, which the decoder skips too
            (
                jpeg(&[&app0, &[0x00, 0x11, 0x22], &big]),
                Some((0xC0, 16_000, 10)),
            ),
            // a stuffed zero carries no length, and a restart a length as the decoder reads it
            (
                jpeg(&[&[0xFF, 0x00, 0xFF, 0xD3, 0x00, 0x04, 0x01, 0x02], &big]),
                Some((0xC0, 16_000, 10)),
            ),
            // the first frame counts
            (jpeg(&[&sof(0xC0, 10, 10), &big]), Some((0xC0, 10, 10))),
            // lengths that cannot be
            (jpeg(&[&[0xFF, 0xE0, 0x00, 0x00], &big]), None),
            (jpeg(&[&[0xFF, 0xE0, 0x00, 0x01], &big]), None),
            (jpeg(&[&[0xFF, 0xE0, 0xFF, 0xFF, 1, 2, 3]]), None),
            // a frame header cut short
            (jpeg(&[&big[..7]]), None),
            // the end or the scan before any frame
            (jpeg(&[&[0xFF, 0xD9], &big]), None),
            (jpeg(&[&segment(0xDA, &[0; 8]), &big]), None),
        ];
        for (i, (bytes, want)) in cases.iter().enumerate() {
            assert_eq!(jpeg_frame(bytes), *want, "case {i}");
        }
        for (i, (bytes, want)) in cases.iter().enumerate().take(6) {
            let too_large = want.is_some_and(|(_, w, h)| w > MAX_JPEG_SIDE || h > MAX_JPEG_SIDE);
            assert_eq!(
                decode(bytes).err() == Some(Unusable::TooLarge),
                too_large,
                "case {i}"
            );
        }
        // none of the odd ones panics in the decoder either
        for (bytes, _) in &cases {
            let _ = decode(bytes);
        }
    }

    #[test]
    fn only_the_frame_kinds_the_decoder_reads_get_past_the_header() {
        for m in [0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF] {
            assert_eq!(
                decode(&jpeg(&[&sof(m, 8, 8)])).err(),
                Some(Unusable::Unsupported),
                "{m:X}"
            );
        }
        for m in [0xC0, 0xC1, 0xC2] {
            assert_eq!(
                decode(&jpeg(&[&sof(m, 8, 8)])).err(),
                Some(Unusable::Damaged),
                "{m:X}"
            );
        }
    }

    #[test]
    fn random_bytes_after_a_jpeg_start_never_panic() {
        let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let head = fixture_jpeg();
        for round in 0..3000 {
            let n = usize::try_from(next() % 96).unwrap();
            let mut bytes = if round % 2 == 0 {
                vec![0xFF, 0xD8]
            } else {
                // a real header with bytes overwritten here and there
                head[..head.len().min(160)].to_vec()
            };
            for _ in 0..n {
                let b = next().to_le_bytes()[0];
                // markers often, so the segment walk sees them
                bytes.push(if next() % 4 == 0 { 0xFF } else { b });
            }
            if round % 2 == 1 {
                let at = 2 + usize::try_from(next() % 150).unwrap();
                if let Some(b) = bytes.get_mut(at) {
                    *b = next().to_le_bytes()[0];
                }
            }
            let _ = jpeg_frame(&bytes);
            let _ = decode(&bytes);
        }
    }

    /// A whole JPEG of kind `m` (baseline or progressive) for `w` x `h` with `comps` components at 4:4:4, whose one
    /// scan is `fill` zero bytes: each block is a 0 bit for a DC of 0 (and a 0 bit for its end), so mid gray. A
    /// progressive scan reads its marker right after the last block, so its fill is exactly a bit a block.
    pub(crate) fn flat_jpeg(m: u8, w: u16, h: u16, comps: u8, fill: usize) -> Vec<u8> {
        let mut q = vec![0u8];
        q.extend_from_slice(&[1; 64]);
        let table = |class: u8| {
            let mut t = vec![class, 1];
            t.extend_from_slice(&[0; 15]);
            t.push(0);
            segment(0xC4, &t)
        };
        let mut f = vec![8];
        f.extend_from_slice(&h.to_be_bytes());
        f.extend_from_slice(&w.to_be_bytes());
        f.push(comps);
        let mut s = vec![comps];
        for c in 1..=comps {
            f.extend_from_slice(&[c, 0x11, 0]);
            s.extend_from_slice(&[c, 0x00]);
        }
        // a progressive frame's first scan is the DC alone
        s.extend_from_slice(if m == 0xC2 { &[0, 0, 0] } else { &[0, 63, 0] });
        let mut j = jpeg(&[
            &segment(0xDB, &q),
            &table(0x00),
            &table(0x10),
            &segment(m, &f),
            &segment(0xDA, &s),
        ]);
        j.resize(j.len() + fill, 0);
        j.extend_from_slice(&[0xFF, 0xD9]);
        j
    }

    #[test]
    fn a_jpeg_header_asking_for_more_memory_than_its_bytes_or_the_budget_allow_is_refused_before_it_decodes()
    {
        // a valid flat baseline square at the bytes it needs decodes to mid gray
        let r = decode(&flat_jpeg(0xC0, 4096, 4096, 1, 512 * 512 * 2 / 8)).unwrap();
        assert_eq!((r.w, r.h), (4096, 4096));
        assert_eq!(r.px[0], [128, 128, 128, 255]);
        // a progressive color photo of 12 megapixels is within the budget
        let r = decode(&flat_jpeg(0xC2, 4000, 3000, 3, (500 * 375 * 3usize).div_ceil(8))).unwrap();
        assert_eq!((r.w, r.h), (4000, 3000));
        // the largest square in a few bytes: too few for its blocks
        assert_eq!(
            decode(&flat_jpeg(0xC0, 8192, 8192, 1, 16)).err(),
            Some(Unusable::Damaged)
        );
        assert_eq!(
            decode(&flat_jpeg(0xC2, 8192, 8192, 3, 16)).err(),
            Some(Unusable::Damaged)
        );
        // with bytes for its first scan, a progressive square still keeps 400 MB of coefficients
        assert_eq!(
            decode(&flat_jpeg(0xC2, 8192, 8192, 3, 1024 * 1024 / 8 + 64)).err(),
            Some(Unusable::TooLarge)
        );
        // a frame header cut short in its components is damaged
        let mut cut = jpeg(&[&sof(0xC0, 64, 64)]);
        cut.truncate(cut.len() - 2);
        cut[5] = 11;
        assert_eq!(decode(&cut).err(), Some(Unusable::Damaged));
    }

    /// A PNG of `w` x `h` of `depth` bit samples in color `kind` (0 gray, 2 RGB, 3 palette, 4 gray and alpha, 6
    /// RGBA), Adam7 interlaced or not, with `extra` chunks before the pixels; `data` is the rows packed, top first.
    fn png_of(
        w: usize,
        h: usize,
        depth: u8,
        kind: u8,
        interlace: bool,
        data: &[u8],
        extra: &[([u8; 4], &[u8])],
    ) -> Vec<u8> {
        let channels = match kind {
            2 => 3,
            4 => 2,
            6 => 4,
            _ => 1,
        };
        let bpp = channels * usize::from(depth) / 8;
        let mut raw = Vec::new();
        let passes: &[(usize, usize, usize, usize)] = if interlace {
            &[
                (0, 0, 8, 8),
                (4, 0, 8, 8),
                (0, 4, 4, 8),
                (2, 0, 4, 4),
                (0, 2, 2, 4),
                (1, 0, 2, 2),
                (0, 1, 1, 2),
            ]
        } else {
            &[(0, 0, 1, 1)]
        };
        for &(x0, y0, dx, dy) in passes {
            if x0 >= w || y0 >= h {
                continue;
            }
            for y in (y0..h).step_by(dy) {
                raw.push(0);
                for x in (x0..w).step_by(dx) {
                    let at = (y * w + x) * bpp;
                    raw.extend_from_slice(&data[at..at + bpp]);
                }
            }
        }
        let mut out = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
        let mut chunk = |kind: &[u8; 4], data: &[u8]| {
            out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
            let mut body = kind.to_vec();
            body.extend_from_slice(data);
            out.extend_from_slice(&body);
            out.extend_from_slice(&crc32(&body).to_be_bytes());
        };
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&u32::try_from(w).unwrap().to_be_bytes());
        ihdr.extend_from_slice(&u32::try_from(h).unwrap().to_be_bytes());
        ihdr.extend_from_slice(&[depth, kind, 0, 0, u8::from(interlace)]);
        chunk(b"IHDR", &ihdr);
        for (k, d) in extra {
            chunk(k, d);
        }
        chunk(b"IDAT", &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6));
        chunk(b"IEND", &[]);
        out
    }

    #[test]
    fn a_large_frame_hidden_from_a_marker_walk_is_still_held_to_the_budget() {
        // the decoder reads a length after every marker but fill bytes and a stuffed zero, so these segments hide
        // what they hold: a scan start, or a small decoy frame ahead of the real one
        let real = flat_jpeg(0xC2, 8192, 8192, 3, 1024 * 1024 / 8 + 64);
        let decoy = sof(0xC0, 8, 8);
        let mut hides_decoy = vec![0xFF, 0xD0];
        hides_decoy.extend_from_slice(&u16::try_from(decoy.len() + 2).unwrap().to_be_bytes());
        hides_decoy.extend_from_slice(&decoy);
        for (what, wrapper) in [
            (
                "FF 01 over a scan start",
                vec![0xFF, 0x01, 0x00, 0x06, 0xFF, 0xDA, 0x00, 0x00],
            ),
            ("FF D0 over a small frame", hides_decoy),
        ] {
            let mut file = real[..2].to_vec();
            file.extend_from_slice(&wrapper);
            file.extend_from_slice(&real[2..]);
            assert_eq!(decode(&file).err(), Some(Unusable::TooLarge), "{what}");
        }
        // the same wrappers around a small image leave it readable
        let small = flat_jpeg(0xC0, 64, 64, 1, 64 * 2 / 8);
        let mut file = small[..2].to_vec();
        file.extend_from_slice(&[0xFF, 0x01, 0x00, 0x06, 0xFF, 0xDA, 0x00, 0x00]);
        file.extend_from_slice(&small[2..]);
        assert_eq!(decode(&file).map(|r| (r.w, r.h)), Ok((64, 64)));
    }

    /// A baseline JPEG of `w` x `h` with `comps` components at 4:4:4, each in a scan of its own, so the decoder keeps
    /// every coefficient until the last scan; each scan is a bit a block for a DC of 0 and a bit for its end.
    fn one_scan_each_jpeg(w: u16, h: u16, comps: u8) -> Vec<u8> {
        let mut q = vec![0u8];
        q.extend_from_slice(&[1; 64]);
        let table = |class: u8| {
            let mut t = vec![class, 1];
            t.extend_from_slice(&[0; 15]);
            t.push(0);
            segment(0xC4, &t)
        };
        let mut f = vec![8];
        f.extend_from_slice(&h.to_be_bytes());
        f.extend_from_slice(&w.to_be_bytes());
        f.push(comps);
        for c in 1..=comps {
            f.extend_from_slice(&[c, 0x11, 0]);
        }
        let mut j = jpeg(&[&segment(0xDB, &q), &table(0x00), &table(0x10), &segment(0xC0, &f)]);
        let blocks = usize::from(w).div_ceil(8) * usize::from(h).div_ceil(8);
        for c in 1..=comps {
            j.extend_from_slice(&segment(0xDA, &[1, c, 0x00, 0, 63, 0]));
            j.resize(j.len() + (blocks * 2).div_ceil(8), 0);
        }
        j.extend_from_slice(&[0xFF, 0xD9]);
        j
    }

    #[test]
    fn a_baseline_jpeg_whose_scans_hold_one_component_each_is_held_to_the_budget() {
        // the decoder keeps every coefficient of such a frame, as for a progressive one: 600 MB at 8192 px
        assert_eq!(
            decode(&one_scan_each_jpeg(8192, 8192, 3)).err(),
            Some(Unusable::TooLarge)
        );
        // at 4096 px it fits and reads
        let r = decode(&one_scan_each_jpeg(4096, 4096, 3)).unwrap();
        assert_eq!((r.w, r.h, r.px[0]), (4096, 4096, [128, 128, 128, 255]));
        // a 48 megapixel photo with its components in one scan keeps no coefficients and reads
        let r = decode(&flat_jpeg(0xC0, 8000, 6000, 3, 1000 * 750 * 3 * 2 / 8)).unwrap();
        assert_eq!(r.file_size, (8000, 6000));
        // what is too large says how to make it readable
        assert!(Unusable::TooLarge.why().contains("save it smaller"));
    }

    #[test]
    fn interlaced_16_bit_palette_and_gray_alpha_pngs_decode_to_their_pixels() {
        // gray and alpha
        let r = decode(&png_of(2, 1, 8, 4, false, &[10, 20, 200, 255], &[])).unwrap();
        assert_eq!(r.px, vec![[10, 10, 10, 20], [200, 200, 200, 255]]);
        // 16 bit RGBA keeps the high byte of each sample
        let r = decode(&png_of(
            1,
            1,
            16,
            6,
            false,
            &[0x12, 0x34, 0xAB, 0xCD, 0xFF, 0xFF, 0x80, 0x00],
            &[],
        ))
        .unwrap();
        assert_eq!(r.px, vec![[0x12, 0xAB, 0xFF, 0x80]]);
        // 16 bit gray
        let r = decode(&png_of(2, 1, 16, 0, false, &[0, 0, 0xFF, 0xFF], &[])).unwrap();
        assert_eq!(r.px, vec![[0, 0, 0, 255], [255, 255, 255, 255]]);
        // a palette with alpha for its first entry only
        let plte: &[u8] = &[255, 0, 0, 0, 0, 255];
        let r = decode(&png_of(
            2,
            1,
            8,
            3,
            false,
            &[0, 1],
            &[(*b"PLTE", plte), (*b"tRNS", &[128])],
        ))
        .unwrap();
        assert_eq!(r.px, vec![[255, 0, 0, 128], [0, 0, 255, 255]]);
        // a palette with no alpha
        let r = decode(&png_of(2, 1, 8, 3, false, &[1, 0], &[(*b"PLTE", plte)])).unwrap();
        assert_eq!(r.px, vec![[0, 0, 255, 255], [255, 0, 0, 255]]);
        // Adam7 gives the same pixels as the plain file, at every size round the pass grid
        for (w, h) in [(1, 1), (3, 2), (9, 9), (13, 5)] {
            let rgb: Vec<u8> = (0..w * h * 3)
                .map(|i| u8::try_from(i * 7 % 251).unwrap())
                .collect();
            let plain = decode(&png_of(w, h, 8, 2, false, &rgb, &[])).unwrap();
            let laced = decode(&png_of(w, h, 8, 2, true, &rgb, &[])).unwrap();
            assert_eq!(laced, plain, "{w} x {h}");
            assert_eq!(
                read(&png_of(w, h, 8, 2, true, &rgb, &[]), TEXTURE),
                Ok(plain),
                "{w} x {h} as stored"
            );
            let rgba: Vec<u8> = (0..w * h * 8)
                .map(|i| u8::try_from(i * 13 % 253).unwrap())
                .collect();
            let plain = decode(&png_of(w, h, 16, 6, false, &rgba, &[])).unwrap();
            let laced = decode(&png_of(w, h, 16, 6, true, &rgba, &[])).unwrap();
            assert_eq!(laced, plain, "16 bit {w} x {h}");
        }
        // an interlaced image cannot be reduced while it decodes, so one over the largest side is refused
        let wide = vec![9u8; (MAX_SIDE + 1) * 3];
        assert_eq!(
            decode(&png_of(MAX_SIDE + 1, 1, 8, 2, true, &wide, &[])).err(),
            Some(Unusable::TooLarge)
        );
        let r = decode(&png_of(MAX_SIDE, 1, 8, 2, true, &wide[..MAX_SIDE * 3], &[])).unwrap();
        assert_eq!((r.w, r.h, r.px[MAX_SIDE - 1]), (MAX_SIDE, 1, [9, 9, 9, 255]));
    }

    /// Asserts that `bytes` decodes to a whole raster or is refused, and never panics, read either way.
    fn decodes_or_refuses(bytes: &[u8], what: &str) {
        for how in [TRACE, TEXTURE] {
            if let Ok(r) = read(bytes, how) {
                assert!(r.w > 0 && r.h > 0 && r.px.len() == r.w * r.h, "{what}");
            }
        }
    }

    #[test]
    fn damaged_and_hostile_pngs_never_panic() {
        let rgb: Vec<u8> = (0..12 * 10 * 3).map(|i| u8::try_from(i % 256).unwrap()).collect();
        let plte: Vec<u8> = (0..12).collect();
        for good in [
            png_of(12, 10, 8, 2, false, &rgb, &[]),
            png_of(12, 10, 8, 2, true, &rgb, &[]),
            png_of(
                4,
                2,
                8,
                3,
                false,
                &[0, 1, 2, 3, 3, 2, 1, 0],
                &[(*b"PLTE", &plte), (*b"tRNS", &[0, 9])],
            ),
        ] {
            assert!(decode(&good).is_ok());
            // cut at every length, and each byte turned over
            for n in 0..good.len() {
                decodes_or_refuses(&good[..n], &format!("cut at {n}"));
                let mut bad = good.clone();
                bad[n] ^= 0xFF;
                decodes_or_refuses(&bad, &format!("byte {n} turned"));
            }
        }
        let gray = vec![7u8; 16 * 16];
        let cases: Vec<(&str, Vec<u8>)> = vec![
            // pixels that inflate far past the rows the header declares
            ("bomb", {
                let mut f = png_of(16, 16, 8, 0, false, &gray, &[]);
                let big = miniz_oxide::deflate::compress_to_vec_zlib(&vec![0u8; 8 << 20], 9);
                let mut body = b"IDAT".to_vec();
                body.extend_from_slice(&big);
                f.truncate(33);
                f.extend_from_slice(&u32::try_from(big.len()).unwrap().to_be_bytes());
                f.extend_from_slice(&body);
                f.extend_from_slice(&crc32(&body).to_be_bytes());
                f.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
                f
            }),
            ("empty IDAT", {
                let mut f = png_of(16, 16, 8, 0, false, &gray, &[]);
                f.truncate(33);
                let body = b"IDAT".to_vec();
                f.extend_from_slice(&[0, 0, 0, 0]);
                f.extend_from_slice(&body);
                f.extend_from_slice(&crc32(&body).to_be_bytes());
                f.extend_from_slice(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]);
                f
            }),
            (
                "a palette of 300 entries",
                png_of(2, 1, 8, 3, false, &[0, 1], &[(*b"PLTE", &[5; 900])]),
            ),
            (
                "alpha for more entries than the palette",
                png_of(
                    2,
                    1,
                    8,
                    3,
                    false,
                    &[0, 1],
                    &[(*b"PLTE", &[5; 6]), (*b"tRNS", &[1; 9])],
                ),
            ),
            (
                "an index past the palette",
                png_of(2, 1, 8, 3, false, &[0, 7], &[(*b"PLTE", &[5; 6])]),
            ),
            ("no palette", png_of(2, 1, 8, 3, false, &[0, 1], &[])),
            ("a bad checksum", {
                let mut f = png_of(16, 16, 8, 0, false, &gray, &[]);
                let n = f.len();
                f[n - 13] ^= 0xFF;
                f
            }),
        ];
        for (what, bytes) in &cases {
            decodes_or_refuses(bytes, what);
        }
        // the bomb gives the declared rows and no more
        if let Ok(r) = decode(&cases[0].1) {
            assert_eq!((r.w, r.h), (16, 16));
        }
    }

    #[test]
    fn a_texture_reads_pngs_as_trace_does_and_keeps_the_stored_orientation() {
        let plte: &[u8] = &[255, 0, 0, 0, 0, 255];
        for file in [
            png_of(2, 1, 8, 4, false, &[10, 20, 200, 255], &[]),
            png_of(2, 1, 16, 0, false, &[0, 0, 0xFF, 0xFF], &[]),
            png_of(
                2,
                1,
                8,
                3,
                false,
                &[0, 1],
                &[(*b"PLTE", plte), (*b"tRNS", &[128])],
            ),
            png_of(13, 5, 8, 2, true, &[77; 13 * 5 * 3], &[]),
        ] {
            assert_eq!(read(&file, TEXTURE), decode(&file));
        }
        // UVs are in the stored orientation, so EXIF does not turn a texture
        let r = read(&with_exif(&fixture_jpeg(), &exif_orientation(6)), TEXTURE).unwrap();
        assert_eq!((r.w, r.h, r.file_size), (48, 32, (48, 32)));
        assert!(dark(&r, 10, 10) && !dark(&r, 40, 10));
        let mut gray = vec![255u8; 6];
        gray[0] = 0;
        let r = read(&png(3, 2, 1, &gray, Some(&exif_orientation(8))), TEXTURE).unwrap();
        assert_eq!((r.w, r.h), (3, 2));
        assert!(dark(&r, 0, 0));
    }

    #[test]
    fn a_texture_jpeg_is_held_to_its_side_and_the_decode_budget() {
        assert_eq!(
            read(&jpeg_header(0xC0, 4097, 10), TEXTURE).err(),
            Some(Unusable::TooLarge)
        );
        assert_eq!(
            read(&jpeg_header(0xC9, 8, 8), TEXTURE).err(),
            Some(Unusable::Unsupported)
        );
        // a progressive 4096 px square in a few bytes would set aside about 150 MB
        assert_eq!(
            read(&flat_jpeg(0xC2, 4096, 4096, 3, 16), TEXTURE).err(),
            Some(Unusable::Damaged)
        );
        let r = read(
            &flat_jpeg(0xC2, 4000, 3000, 3, (500 * 375 * 3usize).div_ceil(8)),
            TEXTURE,
        )
        .unwrap();
        assert_eq!((r.w, r.h, r.px[0]), (4000, 3000, [128, 128, 128, 255]));
    }
}
