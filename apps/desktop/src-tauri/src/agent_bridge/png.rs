// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A small PNG writer for screenshots that arrive as raw pixels (WebKitGTK hands back a cairo surface). The image
//! data is stored, not compressed: a screenshot is read once by an agent, and this keeps the app free of an image
//! library. Windows and macOS get PNG bytes from the web view itself, so there only the size reader is used.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// One row-major RGBA8 image as PNG bytes.
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let row = width as usize * 4;
    if width == 0 || height == 0 || rgba.len() != row * height as usize {
        return Err(format!(
            "{width}x{height} does not match {} bytes of pixels",
            rgba.len()
        ));
    }
    // Each scanline starts with filter type 0 (none).
    let mut raw = Vec::with_capacity((row + 1) * height as usize);
    for line in rgba.chunks_exact(row) {
        raw.push(0);
        raw.extend_from_slice(line);
    }
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    // 8 bits per channel, color type 6 (RGBA), deflate, adaptive filtering, no interlace.
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// cairo's ARGB32 (premultiplied, native endian, `stride` bytes per row) as straight RGBA8.
pub fn rgba_from_cairo_argb32(
    width: u32,
    height: u32,
    stride: usize,
    data: &[u8],
) -> Result<Vec<u8>, String> {
    let w = width as usize;
    if stride < w * 4 || data.len() < stride * height as usize {
        return Err("the surface is smaller than its size says".to_owned());
    }
    let mut out = Vec::with_capacity(w * 4 * height as usize);
    for y in 0..height as usize {
        let (row, _) = data[y * stride..y * stride + w * 4].as_chunks::<4>();
        for px in row {
            let argb = u32::from_ne_bytes(*px);
            let a = (argb >> 24) as u8;
            let un = |c: u32| -> u8 {
                if a == 0 {
                    0
                } else {
                    ((c & 0xff) * 255 / u32::from(a)).min(255) as u8
                }
            };
            out.extend_from_slice(&[un(argb >> 16), un(argb >> 8), un(argb), a]);
        }
    }
    Ok(out)
}

/// The size written in a PNG's header, for the tool's answer.
pub fn size_of(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() < 24 || !png.starts_with(b"\x89PNG\r\n\x1a\n") || &png[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    Some((w, h))
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

/// A zlib stream of stored deflate blocks (at most 65535 bytes each).
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 65_535 * 5 + 16);
    out.extend_from_slice(&[0x78, 0x01]);
    let mut blocks = data.chunks(65_535).peekable();
    if blocks.peek().is_none() {
        out.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    while let Some(block) = blocks.next() {
        let last = u8::from(blocks.peek().is_none());
        let len = block.len() as u16;
        out.push(last);
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(block);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &x in chunk {
            a += u32::from(x);
            b += a;
        }
        a %= 65_521;
        b %= 65_521;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums_match_known_values() {
        assert_eq!(crc32(b"IEND"), 0xae42_6082);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
    }

    #[test]
    fn writes_a_png_with_its_size_and_chunks() {
        let px = [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40];
        let png = encode_rgba(2, 2, &px).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(size_of(&png), Some((2, 2)));
        assert!(png.ends_with(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]));
        // The stored data comes back out of the IDAT chunk: zlib header, one final stored block, the rows, adler32.
        let idat = png.windows(4).position(|w| w == b"IDAT").unwrap();
        let len = u32::from_be_bytes(png[idat - 4..idat].try_into().unwrap()) as usize;
        let z = &png[idat + 4..idat + 4 + len];
        assert_eq!(&z[..3], &[0x78, 0x01, 1]);
        let rows = &z[7..z.len() - 4];
        assert_eq!(
            rows,
            &[0, 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 255, 0, 10, 20, 30, 40]
        );
        assert_eq!(
            u32::from_be_bytes(z[z.len() - 4..].try_into().unwrap()),
            adler32(rows)
        );
    }

    #[test]
    fn large_images_split_into_stored_blocks() {
        let (w, h) = (300u32, 120u32);
        let px = vec![7u8; (w * h * 4) as usize];
        let png = encode_rgba(w, h, &px).unwrap();
        assert_eq!(size_of(&png), Some((w, h)));
        assert!(png.len() > px.len());
    }

    #[test]
    fn refuses_pixels_that_do_not_fit_the_size() {
        assert!(encode_rgba(2, 2, &[0; 15]).is_err());
        assert!(encode_rgba(0, 2, &[]).is_err());
        assert_eq!(size_of(b"not a png at all, really not"), None);
    }

    #[test]
    fn cairo_pixels_lose_their_premultiplication() {
        let px = |a: u32, r: u32, g: u32, b: u32| ((a << 24) | (r << 16) | (g << 8) | b).to_ne_bytes();
        let mut data = Vec::new();
        data.extend_from_slice(&px(255, 10, 20, 30));
        data.extend_from_slice(&px(128, 64, 0, 128));
        data.extend_from_slice(&px(0, 0, 0, 0));
        data.extend_from_slice(&[9, 9, 9, 9]);
        let rgba = rgba_from_cairo_argb32(3, 1, 16, &data).unwrap();
        assert_eq!(rgba, vec![10, 20, 30, 255, 127, 0, 255, 128, 0, 0, 0, 0]);
        assert!(rgba_from_cairo_argb32(3, 2, 16, &data).is_err());
    }
}
