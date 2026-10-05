// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Baseline JPEG for the G-code thumbnails.
// Blocks are 8 by 8 and every index below is bounded by that or by the image size, and the
// float to integer steps are quantization of small values.
#![allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss
)]

use crate::fm::Fm as _;
use crate::thumbnail::Thumb;

/// The standard luminance quantization table at roughly quality 90, in zigzag order.
const JPEG_QUANT: [u8; 64] = [
    3, 2, 2, 3, 2, 2, 3, 3, 3, 3, 4, 3, 3, 4, 5, 8, 5, 5, 4, 4, 5, 10, 7, 7, 6, 8, 12, 10, 12, 12, 11, 10,
    11, 11, 13, 14, 18, 16, 13, 14, 17, 14, 11, 11, 16, 22, 16, 17, 19, 20, 21, 21, 21, 12, 15, 23, 24, 22,
    20, 24, 18, 20, 21, 20,
];
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7,
    14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39,
    46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const DC_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22,
    0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33,
    0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34,
    0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55,
    0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76,
    0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96,
    0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5,
    0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4,
    0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1,
    0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA,
];

/// Huffman codes (value to code and length) from the bit-length counts and values of a JPEG table.
fn huffman(bits: &[u8; 16], vals: &[u8]) -> [(u16, u8); 256] {
    let mut table = [(0u16, 0u8); 256];
    let (mut code, mut k) = (0u16, 0usize);
    for (len, &n) in bits.iter().enumerate() {
        for _ in 0..n {
            if let Some(&v) = vals.get(k)
                && let Some(slot) = table.get_mut(usize::from(v))
            {
                *slot = (code, u8::try_from(len + 1).unwrap_or(16));
            }
            code += 1;
            k += 1;
        }
        code <<= 1;
    }
    table
}

struct BitSink {
    out: Vec<u8>,
    acc: u32,
    n: u32,
}

impl BitSink {
    fn put(&mut self, code: u32, len: u32) {
        self.acc = (self.acc << len) | (code & ((1 << len) - 1));
        self.n += len;
        while self.n >= 8 {
            let byte = u8::try_from((self.acc >> (self.n - 8)) & 0xFF).unwrap_or(0);
            self.out.push(byte);
            if byte == 0xFF {
                self.out.push(0);
            }
            self.n -= 8;
        }
        self.acc &= (1 << self.n) - 1;
    }

    fn finish(mut self) -> Vec<u8> {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.put((1 << pad) - 1, pad);
        }
        self.out
    }
}

/// Bit count and the bits of a coefficient as JPEG writes it (negative values as one's complement).
fn category(v: i32) -> (u32, u32) {
    let a = v.unsigned_abs();
    let n = 32 - a.leading_zeros();
    let bits = if v < 0 {
        (v - 1) as u32 & ((1u32 << n) - 1)
    } else {
        a
    };
    (n, bits)
}

/// Baseline JPEG, three components of 8-bit YCbCr at full resolution. Transparent pixels
/// are composited on white. All components share the luminance tables, which any decoder reads.
pub fn encode(t: &Thumb) -> Vec<u8> {
    let (w, h) = (t.width as usize, t.height as usize);
    let dc = huffman(&DC_BITS, &DC_VALS);
    let ac = huffman(&AC_BITS, &AC_VALS);
    let mut out = vec![0xFF, 0xD8];
    let mut seg = |marker: u8, body: &[u8]| {
        out.extend_from_slice(&[0xFF, marker]);
        out.extend_from_slice(&u16::try_from(body.len() + 2).unwrap_or(0).to_be_bytes());
        out.extend_from_slice(body);
    };
    let mut dqt = vec![0u8];
    dqt.extend_from_slice(&JPEG_QUANT);
    seg(0xDB, &dqt);
    let mut sof = vec![8u8];
    sof.extend_from_slice(&u16::try_from(h).unwrap_or(0).to_be_bytes());
    sof.extend_from_slice(&u16::try_from(w).unwrap_or(0).to_be_bytes());
    sof.extend_from_slice(&[3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
    seg(0xC0, &sof);
    let mut dht = vec![0x00];
    dht.extend_from_slice(&DC_BITS);
    dht.extend_from_slice(&DC_VALS);
    seg(0xC4, &dht);
    let mut dht = vec![0x10];
    dht.extend_from_slice(&AC_BITS);
    dht.extend_from_slice(&AC_VALS);
    seg(0xC4, &dht);
    seg(0xDA, &[3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]);
    // Planes of level-shifted samples.
    let mut planes = vec![vec![0f32; w * h]; 3];
    for y in 0..h {
        for x in 0..w {
            let p = t.px(u32::try_from(x).unwrap_or(0), u32::try_from(y).unwrap_or(0));
            let a = f32::from(p[3]) / 255.0;
            let mix = |c: u8| f32::from(c) * a + 255.0 * (1.0 - a);
            let (r, g, b) = (mix(p[0]), mix(p[1]), mix(p[2]));
            let i = y * w + x;
            let yy = 0.299 * r + 0.587 * g + 0.114 * b;
            let cb = -0.168_736 * r - 0.331_264 * g + 0.5 * b + 128.0;
            let cr = 0.5 * r - 0.418_688 * g - 0.081_312 * b + 128.0;
            for (plane, v) in planes.iter_mut().zip([yy, cb, cr]) {
                if let Some(s) = plane.get_mut(i) {
                    *s = v - 128.0;
                }
            }
        }
    }
    let cos: Vec<f32> = (0..64)
        .map(|i| {
            let (x, u) = (i / 8, i % 8);
            let c = if u == 0 {
                std::f32::consts::FRAC_1_SQRT_2
            } else {
                1.0
            };
            0.5 * c * ((2.0 * x as f32 + 1.0) * u as f32 * std::f32::consts::PI / 16.0).m_cos()
        })
        .collect();
    let mut sink = BitSink {
        out: Vec::new(),
        acc: 0,
        n: 0,
    };
    let mut last_dc = [0i32; 3];
    for by in (0..h).step_by(8) {
        for bx in (0..w).step_by(8) {
            for (ci, plane) in planes.iter().enumerate() {
                let mut block = [0f32; 64];
                for (i, b) in block.iter_mut().enumerate() {
                    let (y, x) = (by + i / 8, bx + i % 8);
                    // Edge pixels repeat.
                    *b = plane.get(y.min(h - 1) * w + x.min(w - 1)).copied().unwrap_or(0.0);
                }
                let mut coef = [0i32; 64];
                for v in 0..8 {
                    for u in 0..8 {
                        let mut sum = 0f32;
                        for y in 0..8 {
                            for x in 0..8 {
                                sum += block[y * 8 + x] * cos[x * 8 + u] * cos[y * 8 + v];
                            }
                        }
                        let q =
                            f32::from(JPEG_QUANT[ZIGZAG.iter().position(|&z| z == v * 8 + u).unwrap_or(0)]);
                        coef[v * 8 + u] = (sum / q).round() as i32;
                    }
                }
                let zz: Vec<i32> = ZIGZAG.iter().map(|&z| coef[z]).collect();
                let diff = zz[0] - last_dc[ci];
                last_dc[ci] = zz[0];
                let (n, bits) = category(diff);
                let (code, len) = dc[n as usize];
                sink.put(u32::from(code), u32::from(len));
                if n > 0 {
                    sink.put(bits, n);
                }
                let mut run = 0u32;
                for &c in zz.iter().skip(1) {
                    if c == 0 {
                        run += 1;
                        continue;
                    }
                    while run > 15 {
                        let (code, len) = ac[0xF0];
                        sink.put(u32::from(code), u32::from(len));
                        run -= 16;
                    }
                    let (n, bits) = category(c);
                    let (code, len) = ac[usize::try_from((run << 4) | n).unwrap_or(0)];
                    sink.put(u32::from(code), u32::from(len));
                    sink.put(bits, n);
                    run = 0;
                }
                if run > 0 {
                    let (code, len) = ac[0x00];
                    sink.put(u32::from(code), u32::from(len));
                }
            }
        }
    }
    out.extend(sink.finish());
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> Thumb {
        let mut px = Vec::new();
        for y in 0..h {
            for x in 0..w {
                px.extend_from_slice(&[
                    u8::try_from(x * 255 / w).unwrap_or(0),
                    u8::try_from(y * 255 / h).unwrap_or(0),
                    128,
                    if x < 3 { 0 } else { 255 },
                ]);
            }
        }
        Thumb::new(w, h, px).unwrap()
    }

    #[test]
    fn jpeg_is_well_formed() {
        let j = encode(&gradient(37, 21));
        assert_eq!(&j[..2], &[0xFF, 0xD8]);
        assert_eq!(&j[j.len() - 2..], &[0xFF, 0xD9]);
        // Inside the scan every 0xFF is followed by 0x00.
        let sos = j.windows(2).position(|w| w == [0xFF, 0xDA]).unwrap() + 12;
        let scan = &j[sos..j.len() - 2];
        assert!(scan.windows(2).all(|w| w[0] != 0xFF || w[1] == 0));
        if let Ok(dir) = std::env::var("SX_DUMP") {
            std::fs::write(format!("{dir}/gradient.jpg"), &j).unwrap();
        }
    }
}
