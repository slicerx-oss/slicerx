// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! PNG checking and writing. A thumbnail is kept only when it decodes: every
//! chunk checksum matches, the image data inflates to exactly the size the
//! header implies, and every scanline has a valid filter byte. What is kept is
//! rebuilt from the critical chunks, so ancillary chunks and trailing bytes
//! never reach the library.

use crc32fast::Hasher;

const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_CHUNKS: usize = 1024;

/// Adam7 passes as `(x0, y0, dx, dy)`.
const PASSES: [(u32, u32, u32, u32); 7] = [
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
];

/// A PNG that passed [`check`], reduced to what a decoder needs.
#[derive(Debug, Clone)]
pub struct Png {
    pub width: u32,
    pub height: u32,
    color_type: u8,
    bit_depth: u8,
    interlaced: bool,
    palette: Option<Vec<u8>>,
    transparency: Option<Vec<u8>>,
    idat: Vec<u8>,
}

fn crc(kind: &[u8], data: &[u8]) -> u32 {
    let mut h = Hasher::new();
    h.update(kind);
    h.update(data);
    h.finalize()
}

fn be32(b: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(..4)?.try_into().ok()?))
}

const fn channels(color_type: u8) -> Option<u64> {
    match color_type {
        0 | 3 => Some(1),
        4 => Some(2),
        2 => Some(3),
        6 => Some(4),
        _ => None,
    }
}

const fn depth_ok(color_type: u8, depth: u8) -> bool {
    match color_type {
        0 => matches!(depth, 1 | 2 | 4 | 8 | 16),
        3 => matches!(depth, 1 | 2 | 4 | 8),
        2 | 4 | 6 => matches!(depth, 8 | 16),
        _ => false,
    }
}

/// `(rows, row bytes)` for each stored image: one, or seven for Adam7.
fn layout(w: u32, h: u32, bpp: u64, interlaced: bool) -> Vec<(u64, u64)> {
    let row = |pw: u64| (pw * bpp).div_ceil(8);
    if !interlaced {
        return vec![(u64::from(h), row(u64::from(w)))];
    }
    let mut out = Vec::new();
    for (x0, y0, dx, dy) in PASSES {
        if w > x0 && h > y0 {
            let pw = u64::from((w - x0).div_ceil(dx));
            let ph = u64::from((h - y0).div_ceil(dy));
            out.push((ph, row(pw)));
        }
    }
    out
}

/// Fully decodes `bytes` and returns the image, or says what is wrong.
#[allow(clippy::too_many_lines, reason = "one pass over the chunk stream")]
pub fn check(bytes: &[u8], max_side: u32) -> Result<Png, String> {
    let bad = |s: &str| s.to_owned();
    if !bytes.starts_with(SIGNATURE) {
        return Err(bad("not a PNG"));
    }
    let mut at = SIGNATURE.len();
    let mut chunks = 0usize;
    let mut header: Option<(u32, u32, u8, u8, bool)> = None;
    let mut palette = None;
    let mut transparency = None;
    let mut idat = Vec::new();
    let mut idat_done = false;
    let mut ended = false;
    while !ended {
        chunks += 1;
        if chunks > MAX_CHUNKS {
            return Err(bad("too many chunks"));
        }
        let len = be32(bytes.get(at..).unwrap_or(&[])).ok_or_else(|| bad("truncated"))? as usize;
        if len > i32::MAX as usize {
            return Err(bad("chunk too long"));
        }
        let kind: [u8; 4] = bytes
            .get(at + 4..at + 8)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| bad("truncated"))?;
        let data = bytes.get(at + 8..at + 8 + len).ok_or_else(|| bad("truncated"))?;
        let stored = bytes
            .get(at + 8 + len..)
            .and_then(be32)
            .ok_or_else(|| bad("truncated"))?;
        if stored != crc(&kind, data) {
            return Err(bad("chunk checksum mismatch"));
        }
        at += 12 + len;
        if chunks == 1 && &kind != b"IHDR" {
            return Err(bad("the first chunk is not IHDR"));
        }
        match &kind {
            b"IHDR" => {
                if chunks != 1 || data.len() != 13 {
                    return Err(bad("bad IHDR"));
                }
                let w = be32(data).unwrap_or(0);
                let h = be32(data.get(4..).unwrap_or(&[])).unwrap_or(0);
                let (depth, ct, comp, filt, inter) = (
                    data.get(8).copied().unwrap_or(0),
                    data.get(9).copied().unwrap_or(9),
                    data.get(10).copied().unwrap_or(1),
                    data.get(11).copied().unwrap_or(1),
                    data.get(12).copied().unwrap_or(2),
                );
                if w == 0 || h == 0 || w > max_side || h > max_side {
                    return Err(bad("image size is zero or over the limit"));
                }
                if comp != 0 || filt != 0 || inter > 1 || !depth_ok(ct, depth) {
                    return Err(bad("unsupported header"));
                }
                header = Some((w, h, ct, depth, inter == 1));
            }
            b"PLTE" => {
                if idat_done || !idat.is_empty() || palette.is_some() {
                    return Err(bad("misplaced PLTE"));
                }
                if data.is_empty() || data.len() % 3 != 0 || data.len() > 768 {
                    return Err(bad("bad PLTE"));
                }
                palette = Some(data.to_vec());
            }
            b"tRNS" => {
                if !idat.is_empty() || data.len() > 768 {
                    return Err(bad("misplaced tRNS"));
                }
                transparency = Some(data.to_vec());
            }
            b"IDAT" => {
                if idat_done {
                    return Err(bad("IDAT chunks are not contiguous"));
                }
                idat.extend_from_slice(data);
                if idat.len() > 64 * 1024 * 1024 {
                    return Err(bad("image data too long"));
                }
            }
            b"IEND" => {
                if !data.is_empty() {
                    return Err(bad("bad IEND"));
                }
                ended = true;
            }
            other => {
                if !idat.is_empty() {
                    idat_done = true;
                }
                // Bit 5 of the first letter clear means critical.
                if other.first().is_some_and(|b| b & 0x20 == 0) {
                    return Err(bad("unknown critical chunk"));
                }
            }
        }
        if &kind != b"IDAT" && !idat.is_empty() {
            idat_done = true;
        }
    }
    if at != bytes.len() {
        return Err(bad("data after IEND"));
    }
    let (width, height, color_type, bit_depth, interlaced) = header.ok_or_else(|| bad("no IHDR"))?;
    if idat.is_empty() {
        return Err(bad("no image data"));
    }
    match (color_type, palette.is_some()) {
        (3, false) => return Err(bad("indexed image without a palette")),
        (0 | 4, true) => return Err(bad("palette on a grayscale image")),
        _ => {}
    }
    let bpp = channels(color_type).ok_or_else(|| bad("bad color type"))? * u64::from(bit_depth);
    let segments = layout(width, height, bpp, interlaced);
    let expected: u64 = segments.iter().map(|(rows, row)| rows * (1 + row)).sum();
    let limit = usize::try_from(expected).map_err(|_| bad("image too large"))?;
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&idat, limit)
        .map_err(|_| bad("image data does not inflate to the expected size"))?;
    if raw.len() != limit {
        return Err(bad("image data is shorter than the header implies"));
    }
    let mut pos = 0usize;
    for (rows, row) in segments {
        for _ in 0..rows {
            if raw.get(pos).is_none_or(|f| *f > 4) {
                return Err(bad("bad scanline filter"));
            }
            pos += 1 + usize::try_from(row).map_err(|_| bad("image too large"))?;
        }
    }
    Ok(Png {
        width,
        height,
        color_type,
        bit_depth,
        interlaced,
        palette,
        transparency,
        idat,
    })
}

fn chunk(out: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(&kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc(&kind, data).to_be_bytes());
}

impl Png {
    /// The image as a minimal PNG: critical chunks and transparency only.
    pub fn rebuild(&self) -> Vec<u8> {
        let mut out = SIGNATURE.to_vec();
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&self.width.to_be_bytes());
        ihdr.extend_from_slice(&self.height.to_be_bytes());
        ihdr.extend_from_slice(&[self.bit_depth, self.color_type, 0, 0, u8::from(self.interlaced)]);
        chunk(&mut out, *b"IHDR", &ihdr);
        if let Some(p) = &self.palette {
            chunk(&mut out, *b"PLTE", p);
        }
        if let Some(t) = &self.transparency {
            chunk(&mut out, *b"tRNS", t);
        }
        chunk(&mut out, *b"IDAT", &self.idat);
        chunk(&mut out, *b"IEND", &[]);
        out
    }
}

/// Encodes 8-bit RGBA pixels, row by row with no filter.
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let row = width as usize * 4;
    let mut raw = Vec::with_capacity((row + 1) * height as usize);
    for line in rgba.chunks(row) {
        raw.push(0);
        raw.extend_from_slice(line);
    }
    let idat = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
    let png = Png {
        width,
        height,
        color_type: 6,
        bit_depth: 8,
        interlaced: false,
        palette: None,
        transparency: None,
        idat,
    };
    png.rebuild()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let rgba: Vec<u8> = (0..8 * 8 * 4)
            .map(|i| u8::try_from(i % 251).unwrap_or(0))
            .collect();
        encode_rgba(8, 8, &rgba)
    }

    #[test]
    fn round_trips_and_rebuilds_identically() {
        let png = sample();
        let checked = check(&png, 64).unwrap();
        assert_eq!((checked.width, checked.height), (8, 8));
        assert_eq!(checked.rebuild(), png);
    }

    #[test]
    fn rejects_damage() {
        let png = sample();
        assert!(check(&png[..png.len() - 5], 64).is_err(), "truncated");
        let mut flipped = png.clone();
        flipped[40] ^= 0xff;
        assert!(check(&flipped, 64).is_err(), "checksum");
        let mut trailing = png.clone();
        trailing.extend_from_slice(b"MZ....");
        assert!(check(&trailing, 64).is_err(), "trailing data");
        assert!(check(&png, 4).is_err(), "over the side limit");
        assert!(check(b"not a png", 64).is_err());
        assert!(check(&[], 64).is_err());
    }

    #[test]
    fn ancillary_chunks_are_dropped() {
        let png = sample();
        // Insert a tEXt chunk after IHDR.
        let mut with_text = png[..33].to_vec();
        chunk(&mut with_text, *b"tEXt", b"Comment\0payload hidden here");
        with_text.extend_from_slice(&png[33..]);
        let rebuilt = check(&with_text, 64).unwrap().rebuild();
        assert_eq!(rebuilt, png);
    }

    #[test]
    fn a_short_image_stream_is_refused() {
        // A header that promises 8x8 pixels over data for one row.
        let png = sample();
        let mut h = png[..33].to_vec();
        let idat = miniz_oxide::deflate::compress_to_vec_zlib(&[0u8; 33], 6);
        chunk(&mut h, *b"IDAT", &idat);
        chunk(&mut h, *b"IEND", &[]);
        assert!(check(&h, 64).is_err());
    }
}
