// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A small baseline JPEG encoder for camera stills decoded from H.264 (Bambu Lab X1 and H2 cameras
//! send only video). Written from the JPEG standard (ITU-T T.81): YCbCr 4:4:4, the example
//! quantization and Huffman tables of Annex K, a separable floating point DCT, one scan.
use std::f32::consts::PI;

/// Annex K.1, luminance.
const LUMA_Q: [u16; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17,
    22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78,
    87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
/// Annex K.1, chrominance.
const CHROMA_Q: [u16; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];
/// Position in the 8x8 block (row major) of each coefficient in zigzag order.
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7,
    14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39,
    46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// Annex K.3: code lengths (counts per length 1..16) and values.
const DC_LUMA_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS: [u8; 16] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22,
    0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33,
    0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34,
    0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76,
    0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
    0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5,
    0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1,
    0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AC_CHROMA_BITS: [u8; 16] = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13,
    0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62,
    0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29,
    0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54,
    0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
    0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
    0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
    0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/// Code and length for each symbol of a table (Annex C).
struct Huff {
    code: [u16; 256],
    len: [u8; 256],
}

impl Huff {
    // Symbols are bytes, so indexing the 256 entry arrays cannot go out of range.
    #[allow(clippy::indexing_slicing)]
    fn new(bits: &[u8; 16], vals: &[u8]) -> Self {
        let mut h = Self {
            code: [0; 256],
            len: [0; 256],
        };
        let mut code: u16 = 0;
        let mut k = 0;
        for (i, &n) in bits.iter().enumerate() {
            for _ in 0..n {
                if let Some(&v) = vals.get(k) {
                    h.code[usize::from(v)] = code;
                    h.len[usize::from(v)] = u8::try_from(i + 1).unwrap_or(16);
                }
                code = code.wrapping_add(1);
                k += 1;
            }
            code = code.wrapping_shl(1);
        }
        h
    }
}

struct Bits {
    out: Vec<u8>,
    acc: u32,
    n: u32,
}

impl Bits {
    fn put(&mut self, code: u32, len: u32) {
        if len == 0 {
            return;
        }
        self.acc = (self.acc << len) | (code & ((1 << len) - 1));
        self.n += len;
        while self.n >= 8 {
            let byte = u8::try_from((self.acc >> (self.n - 8)) & 0xff).unwrap_or(0);
            self.out.push(byte);
            // Byte stuffing: a 0xFF in the data is followed by 0x00.
            if byte == 0xff {
                self.out.push(0);
            }
            self.n -= 8;
        }
        self.acc &= (1 << self.n) - 1;
    }

    fn flush(&mut self) {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.put((1 << pad) - 1, pad);
        }
    }
}

/// The magnitude category of a coefficient and its bits (F.1.2.1).
fn category(v: i32) -> (u32, u32) {
    let a = v.unsigned_abs();
    let size = 32 - a.leading_zeros();
    let bits = if v < 0 {
        (v - 1).cast_unsigned()
    } else {
        v.cast_unsigned()
    };
    (size, bits & ((1 << size) - 1))
}

fn scaled(table: &[u16; 64], quality: u8) -> [u16; 64] {
    let q = u32::from(quality.clamp(1, 100));
    let scale = if q < 50 { 5000 / q } else { 200 - q * 2 };
    let mut out = [1_u16; 64];
    for (o, &t) in out.iter_mut().zip(table) {
        *o = u16::try_from(((u32::from(t) * scale + 50) / 100).clamp(1, 255)).unwrap_or(255);
    }
    out
}

/// Encodes `rgb` (`width` x `height`, 3 bytes a pixel) as a baseline JPEG.
// Pixel and block loops index fixed arrays and `rgb`, whose length is checked on entry; short
// names follow the standard's notation (u, v, x, y, c, q).
#[allow(
    clippy::indexing_slicing,
    clippy::many_single_char_names,
    clippy::too_many_lines
)]
pub(crate) fn encode_rgb(rgb: &[u8], width: usize, height: usize, quality: u8) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width > 65_535 || height > 65_535 || rgb.len() < width * height * 3 {
        return None;
    }
    let lq = scaled(&LUMA_Q, quality);
    let cq = scaled(&CHROMA_Q, quality);
    let mut out = Vec::with_capacity(width * height / 4 + 1024);
    out.extend_from_slice(&[0xFF, 0xD8]);
    // JFIF APP0.
    out.extend_from_slice(&[
        0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ]);
    for (id, table) in [(0_u8, &lq), (1, &cq)] {
        out.extend_from_slice(&[0xFF, 0xDB, 0, 67, id]);
        for &z in &ZIGZAG {
            out.push(u8::try_from(table[z]).unwrap_or(255));
        }
    }
    let (w, h) = (u16::try_from(width).ok()?, u16::try_from(height).ok()?);
    out.extend_from_slice(&[0xFF, 0xC0, 0, 17, 8]);
    out.extend_from_slice(&h.to_be_bytes());
    out.extend_from_slice(&w.to_be_bytes());
    out.extend_from_slice(&[3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
    for (class_id, bits, vals) in [
        (0x00_u8, &DC_LUMA_BITS, &DC_VALS[..]),
        (0x10, &AC_LUMA_BITS, &AC_LUMA_VALS[..]),
        (0x01, &DC_CHROMA_BITS, &DC_VALS[..]),
        (0x11, &AC_CHROMA_BITS, &AC_CHROMA_VALS[..]),
    ] {
        let len = u16::try_from(3 + 16 + vals.len()).ok()?;
        out.extend_from_slice(&[0xFF, 0xC4]);
        out.extend_from_slice(&len.to_be_bytes());
        out.push(class_id);
        out.extend_from_slice(bits);
        out.extend_from_slice(vals);
    }
    out.extend_from_slice(&[0xFF, 0xDA, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

    let huffs = [
        (
            Huff::new(&DC_LUMA_BITS, &DC_VALS),
            Huff::new(&AC_LUMA_BITS, &AC_LUMA_VALS),
        ),
        (
            Huff::new(&DC_CHROMA_BITS, &DC_VALS),
            Huff::new(&AC_CHROMA_BITS, &AC_CHROMA_VALS),
        ),
    ];
    // cos((2x + 1) u pi / 16), with the 1 / sqrt(2) factor for u = 0.
    let mut cos = [[0_f32; 8]; 8];
    for (x, row) in cos.iter_mut().enumerate() {
        for (u, c) in row.iter_mut().enumerate() {
            #[allow(clippy::cast_precision_loss)] // Indices below 16.
            let v = (((2 * x + 1) * u) as f32 * PI / 16.0).cos();
            *c = if u == 0 { v / 2_f32.sqrt() } else { v };
        }
    }
    let mut bits = Bits { out, acc: 0, n: 0 };
    let mut prev_dc = [0_i32; 3];
    let mut block = [[0_f32; 64]; 3];
    for by in (0..height).step_by(8) {
        for bx in (0..width).step_by(8) {
            for y in 0..8 {
                for x in 0..8 {
                    // Edge blocks repeat the last row and column.
                    let px = (bx + x).min(width - 1);
                    let py = (by + y).min(height - 1);
                    let i = (py * width + px) * 3;
                    let (r, g, b) = (f32::from(rgb[i]), f32::from(rgb[i + 1]), f32::from(rgb[i + 2]));
                    let k = y * 8 + x;
                    block[0][k] = 0.299 * r + 0.587 * g + 0.114 * b - 128.0;
                    block[1][k] = -0.168_736 * r - 0.331_264 * g + 0.5 * b;
                    block[2][k] = 0.5 * r - 0.418_688 * g - 0.081_312 * b;
                }
            }
            for c in 0..3 {
                let q = if c == 0 { &lq } else { &cq };
                let (dc, ac) = if c == 0 { &huffs[0] } else { &huffs[1] };
                let mut coef = [0_i32; 64];
                for v in 0..8 {
                    for u in 0..8 {
                        let mut s = 0.0;
                        for y in 0..8 {
                            for x in 0..8 {
                                s += block[c][y * 8 + x] * cos[x][u] * cos[y][v];
                            }
                        }
                        #[allow(clippy::cast_possible_truncation)] // Bounded by the DCT range.
                        let quant = (s / 4.0 / f32::from(q[v * 8 + u])).round() as i32;
                        coef[v * 8 + u] = quant;
                    }
                }
                let d = coef[0] - prev_dc[c];
                prev_dc[c] = coef[0];
                let (size, b) = category(d);
                let sym = usize::try_from(size).unwrap_or(0);
                bits.put(u32::from(dc.code[sym]), u32::from(dc.len[sym]));
                bits.put(b, size);
                let mut run = 0;
                for &z in ZIGZAG.iter().skip(1) {
                    let v = coef[z];
                    if v == 0 {
                        run += 1;
                        continue;
                    }
                    while run > 15 {
                        bits.put(u32::from(ac.code[0xF0]), u32::from(ac.len[0xF0]));
                        run -= 16;
                    }
                    let (size, b) = category(v);
                    let sym = usize::try_from((run << 4) | size).unwrap_or(0);
                    bits.put(u32::from(ac.code[sym]), u32::from(ac.len[sym]));
                    bits.put(b, size);
                    run = 0;
                }
                if run > 0 {
                    bits.put(u32::from(ac.code[0]), u32::from(ac.len[0]));
                }
            }
        }
    }
    bits.flush();
    let mut out = bits.out;
    out.extend_from_slice(&[0xFF, 0xD9]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_baseline_jpeg() {
        let (w, h) = (37, 21);
        let mut rgb = vec![0_u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                rgb[i] = u8::try_from(x * 6).unwrap();
                rgb[i + 1] = u8::try_from(y * 11).unwrap();
                rgb[i + 2] = 128;
            }
        }
        let j = encode_rgb(&rgb, w, h, 80).unwrap();
        assert_eq!(&j[..3], &[0xFF, 0xD8, 0xFF]);
        assert_eq!(&j[j.len() - 2..], &[0xFF, 0xD9]);
        // SOF0 carries the size.
        let sof = j.windows(2).position(|p| p == [0xFF, 0xC0]).unwrap();
        assert_eq!(u16::from_be_bytes([j[sof + 5], j[sof + 6]]), 21);
        assert_eq!(u16::from_be_bytes([j[sof + 7], j[sof + 8]]), 37);
        assert!(encode_rgb(&rgb, 0, 1, 80).is_none());
        assert_eq!(category(-3), (2, 0));
        assert_eq!(category(5), (3, 5));
    }
}
