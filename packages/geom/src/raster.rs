// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Raster images: PNG and JPEG decoded to one RGBA level, turned upright by their EXIF orientation, and box reduced
//! in linear light.
// pixel offsets are within each image's pixel count, made from its own width and height
#![allow(clippy::indexing_slicing)]

use crate::fm::Fm as _;

/// The largest side kept. A bigger PNG is reduced row by row while it decodes; a bigger JPEG is refused.
pub const MAX_SIDE: usize = 4096;
/// A PNG past this is refused before it decodes.
const MAX_PNG_SIDE: usize = 4 * MAX_SIDE;
/// The largest file read.
pub const MAX_BYTES: usize = 30 << 20;

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
            Self::TooLarge => "is too large to read",
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
        let light = Light::new();
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

/// sRGB to linear light and back, by tables made from the same f64 curve on every target.
struct Light {
    lin: [f32; 256],
    /// the linear value where each sRGB step rounds up to the next
    up: [f32; 255],
}

impl Light {
    fn new() -> Self {
        let curve = |c: f64| {
            // an f32 table, so no target reads the curve differently
            #[allow(clippy::cast_possible_truncation)]
            let v = if c <= 0.040_45 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).m_powf(2.4)
            } as f32;
            v
        };
        let mut lin = [0f32; 256];
        for (i, v) in lin.iter_mut().enumerate() {
            *v = curve(i as f64 / 255.0);
        }
        let mut up = [0f32; 255];
        for (i, v) in up.iter_mut().enumerate() {
            *v = curve((i as f64 + 0.5) / 255.0);
        }
        Self { lin, up }
    }

    fn srgb(&self, v: f32) -> u8 {
        u8::try_from(self.up.partition_point(|&t| t <= v)).unwrap_or(u8::MAX)
    }

    /// Averages `pixels` in linear light, colors weighted by their alpha.
    fn average(&self, pixels: &[[u8; 4]]) -> [u8; 4] {
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

/// Decodes a PNG or JPEG (by its first bytes), upright.
pub fn decode(bytes: &[u8]) -> std::result::Result<Raster, Unusable> {
    if bytes.len() > MAX_BYTES {
        return Err(Unusable::TooLarge);
    }
    let (r, exif) = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        decode_png(bytes)?
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        decode_jpeg(bytes)?
    } else {
        return Err(Unusable::NotImage);
    };
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

fn decode_png(bytes: &[u8]) -> std::result::Result<Decoded, Unusable> {
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
    let light = Light::new();
    let mut out: Vec<[u8; 4]> = Vec::with_capacity(ow * oh);
    if reader.info().interlaced {
        let size = reader.output_buffer_size().ok_or(Unusable::TooLarge)?;
        let mut buf = vec![0u8; size];
        let info = reader.next_frame(&mut buf).map_err(|_| Unusable::Damaged)?;
        let line = info.line_size;
        for y in 0..h {
            let row = buf.get(y * line..(y + 1) * line).ok_or(Unusable::Damaged)?;
            to_rgba(color, row, &mut out);
        }
    } else {
        // row by row, so the file's pixels are never all held at once; past the largest side k rows at a time,
        // each k x k block averaged in linear light
        let mut band: Vec<Vec<[u8; 4]>> = Vec::with_capacity(k);
        let mut block = Vec::with_capacity(k * k);
        let mut y = 0;
        while y < h {
            let row = reader
                .next_row()
                .map_err(|_| Unusable::Damaged)?
                .ok_or(Unusable::Damaged)?;
            y += 1;
            if k == 1 {
                to_rgba(color, row.data(), &mut out);
                continue;
            }
            let mut px = Vec::with_capacity(w);
            to_rgba(color, row.data(), &mut px);
            band.push(px);
            if band.len() == k || y == h {
                for ox in 0..ow {
                    block.clear();
                    for r in &band {
                        block.extend_from_slice(r.get(ox * k..((ox + 1) * k).min(w)).unwrap_or_default());
                    }
                    out.push(light.average(&block));
                }
                band.clear();
            }
        }
    }
    let exif = reader.info().exif_metadata.as_ref().map(|e| e.to_vec());
    let mut r = Raster::new(ow, oh, out)?;
    r.file_size = (w, h);
    Ok((r, exif))
}

fn decode_jpeg(bytes: &[u8]) -> std::result::Result<Decoded, Unusable> {
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
    Ok((Raster::new(w, h, px)?, dec.exif().cloned()))
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

    /// A PNG of `w` x `h` pixels of `channels` bytes each (1 gray, 3 RGB, 4 RGBA), rows from the top, with an
    /// optional eXIf chunk.
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

    /// A little endian TIFF block holding only an orientation.
    pub(crate) fn exif_orientation(o: u16) -> Vec<u8> {
        let mut t = b"II*\0".to_vec();
        t.extend_from_slice(&8u32.to_le_bytes());
        t.extend_from_slice(&1u16.to_le_bytes());
        t.extend_from_slice(&0x0112u16.to_le_bytes());
        t.extend_from_slice(&3u16.to_le_bytes());
        t.extend_from_slice(&1u32.to_le_bytes());
        t.extend_from_slice(&o.to_le_bytes());
        t.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        t
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
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&u16::try_from(tiff.len() + 8).unwrap().to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(tiff);
        out.extend_from_slice(&jpeg[2..]);
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
    fn every_orientation_puts_the_marked_corner_where_exif_says() {
        // 3 x 2 with the top left marked; where each orientation shows it
        let mut px = vec![[255u8, 255, 255, 255]; 6];
        px[0] = [0, 0, 0, 255];
        let src = Raster::new(3, 2, px).unwrap();
        let want = [
            (1, 0, 0),
            (2, 2, 0),
            (3, 2, 1),
            (4, 0, 1),
            (5, 0, 0),
            (6, 1, 0),
            (7, 1, 2),
            (8, 0, 2),
        ];
        for (o, x, y) in want {
            let r = upright(src.clone(), o);
            assert!(dark(&r, x, y), "orientation {o}");
            assert_eq!(r.w * r.h, 6);
            assert_eq!((r.w, r.h) == (2, 3), o >= 5, "orientation {o}");
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
}
