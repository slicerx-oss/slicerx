// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Binary G-code (`.bgcode`), the file format Prusa printers read: the finished
//! ASCII file becomes a header, metadata blocks, thumbnail blocks and G-code blocks
//! packed with `MeatPack` and compressed with heatshrink (window 12, lookahead 4).
//! Written from the public format description; comments are dropped from the G-code
//! blocks and the numbers they carried go to the metadata blocks.
//!
//! Layout: `GCDE`, version 1, checksum type 1 (CRC-32); then blocks, each with a
//! header (type, compression, sizes), parameters, data and the CRC-32 of the three.

use crate::config::PrintConfig;
use crate::thumbnail::{base64_decode, crc32_of};
use std::fmt::Write as _;

const MAGIC: &[u8; 4] = b"GCDE";
const VERSION: u32 = 1;
/// The block types, in the order they appear in a file.
const FILE_METADATA: u16 = 0;
const GCODE: u16 = 1;
const SLICER_METADATA: u16 = 2;
const PRINTER_METADATA: u16 = 3;
const PRINT_METADATA: u16 = 4;
const THUMBNAIL: u16 = 5;
const NO_COMPRESSION: u16 = 0;
const HEATSHRINK_12_4: u16 = 3;
const ENCODING_INI: u16 = 0;
const ENCODING_MEATPACK: u16 = 1;
/// Uncompressed bytes of G-code text in one block.
const GCODE_BLOCK_BYTES: usize = 65_535;

// ---------------------------------------------------------------- heatshrink

struct Bits {
    out: Vec<u8>,
    cur: u8,
    n: u8,
}

impl Bits {
    fn new() -> Self {
        Self {
            out: Vec::new(),
            cur: 0,
            n: 0,
        }
    }

    /// Writes the low `count` bits of `v`, most significant first.
    fn put(&mut self, v: u32, count: u32) {
        for i in (0..count).rev() {
            self.cur = (self.cur << 1) | u8::from((v >> i) & 1 == 1);
            self.n += 1;
            if self.n == 8 {
                self.out.push(self.cur);
                self.cur = 0;
                self.n = 0;
            }
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.n > 0 {
            self.cur <<= 8 - self.n;
            self.out.push(self.cur);
        }
        self.out
    }
}

/// Heatshrink stream: a `1` bit and the byte for a literal, a `0` bit, the
/// distance minus 1 (`window` bits) and the length minus 1 (`lookahead` bits) for a copy.
pub fn heatshrink_encode(data: &[u8], window: u32, lookahead: u32) -> Vec<u8> {
    let max_dist = 1usize << window;
    let max_len = 1usize << lookahead;
    let mut bits = Bits::new();
    // Chains of earlier positions by the three bytes that start there.
    let mut head: std::collections::HashMap<[u8; 3], Vec<usize>> = std::collections::HashMap::new();
    let mut i = 0;
    while i < data.len() {
        let mut best = (0usize, 0usize);
        if let Some(key) = data.get(i..i + 3).and_then(|k| <[u8; 3]>::try_from(k).ok())
            && let Some(cands) = head.get(&key)
        {
            for &c in cands.iter().rev().take(24) {
                let dist = i - c;
                if dist > max_dist {
                    break;
                }
                let len = data
                    .get(c..)
                    .unwrap_or_default()
                    .iter()
                    .zip(data.get(i..).unwrap_or_default())
                    .take(max_len)
                    .take_while(|(a, b)| a == b)
                    .count();
                if len > best.1 {
                    best = (dist, len);
                    if len == max_len {
                        break;
                    }
                }
            }
        }
        let step = if best.1 >= 3 {
            bits.put(0, 1);
            #[allow(
                clippy::cast_possible_truncation,
                reason = "bounded by the window and lookahead"
            )]
            {
                bits.put((best.0 - 1) as u32, window);
                bits.put((best.1 - 1) as u32, lookahead);
            }
            best.1
        } else {
            bits.put(1, 1);
            bits.put(u32::from(data.get(i).copied().unwrap_or(0)), 8);
            1
        };
        for j in i..i + step {
            if let Some(key) = data.get(j..j + 3).and_then(|k| <[u8; 3]>::try_from(k).ok()) {
                head.entry(key).or_default().push(j);
            }
        }
        i += step;
    }
    bits.finish()
}

// ------------------------------------------------------------------ meatpack

fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'.' => 10,
        b' ' => 11,
        b'\n' => 12,
        b'G' => 13,
        b'X' => 14,
        _ => 15,
    }
}

/// `MeatPack`: two of the fifteen common characters per byte (the first in the
/// low nibble), `0xFF` and two raw bytes when neither packs, `0xF` in a nibble
/// and the raw byte after it when one does not. Starts with the enable command.
pub fn meatpack_encode(text: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, 0xFF, 0xFB];
    let mut chars = text.to_vec();
    // Characters go in pairs.
    if chars.len() % 2 == 1 {
        chars.push(b' ');
    }
    for &[a, b] in chars.as_chunks::<2>().0 {
        let (na, nb) = (nibble(a), nibble(b));
        match (na == 15, nb == 15) {
            (false, false) => out.push((nb << 4) | na),
            (true, true) => out.extend_from_slice(&[0xFF, a, b]),
            (true, false) => out.extend_from_slice(&[(nb << 4) | 0xF, a]),
            (false, true) => out.extend_from_slice(&[0xF0 | na, b]),
        }
    }
    out
}

// -------------------------------------------------------------------- blocks

fn block(kind: u16, compression: u16, params: &[u8], data: &[u8], stored: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(stored.len() + params.len() + 16);
    b.extend_from_slice(&kind.to_le_bytes());
    b.extend_from_slice(&compression.to_le_bytes());
    b.extend_from_slice(&u32::try_from(data.len()).unwrap_or(0).to_le_bytes());
    if compression != NO_COMPRESSION {
        b.extend_from_slice(&u32::try_from(stored.len()).unwrap_or(0).to_le_bytes());
    }
    b.extend_from_slice(params);
    b.extend_from_slice(stored);
    let crc = crc32_of(&b);
    b.extend_from_slice(&crc.to_le_bytes());
    b
}

fn metadata_block(kind: u16, pairs: &[(String, String)]) -> Vec<u8> {
    let mut text = String::new();
    for (k, v) in pairs {
        let _ = writeln!(text, "{k}={v}");
    }
    block(
        kind,
        NO_COMPRESSION,
        &ENCODING_INI.to_le_bytes(),
        text.as_bytes(),
        text.as_bytes(),
    )
}

fn value_of(cfg: &PrintConfig, key: &str) -> Option<String> {
    Some(match cfg.raw.get(key)? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(a) => a
            .iter()
            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
            .collect::<Vec<_>>()
            .join(","),
        v => v.to_string(),
    })
}

/// Converts finished ASCII G-code (with statistics footer and thumbnail comment blocks)
/// to binary G-code. Comments and blank lines are dropped from the moves.
pub fn encode(ascii: &str, cfg: &PrintConfig) -> Vec<u8> {
    // Thumbnails: `; thumbnail[_QOI|_JPG] begin WxH N` ... `; thumbnail... end`.
    let mut thumbs: Vec<(u16, u16, u16, Vec<u8>)> = Vec::new();
    let mut stats: Vec<(String, String)> = Vec::new();
    let mut code = String::with_capacity(ascii.len());
    let mut lines = ascii.lines();
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix("; thumbnail") {
            let (tag, dims) = rest.split_once(" begin ").unwrap_or((rest, ""));
            let format = match tag {
                "" => Some(0u16),
                "_JPG" => Some(1),
                "_QOI" => Some(2),
                _ => None,
            };
            let size = dims.split_whitespace().next().and_then(|d| d.split_once('x'));
            let mut b64 = String::new();
            for l in lines.by_ref() {
                if l.contains(" end") && l.starts_with("; thumbnail") {
                    break;
                }
                b64.push_str(l.trim_start_matches("; "));
            }
            if let (Some(f), Some((w, h)), Some(bytes)) = (format, size, base64_decode(&b64))
                && let (Ok(w), Ok(h)) = (w.parse::<u16>(), h.parse::<u16>())
            {
                thumbs.push((f, w, h, bytes));
            }
            continue;
        }
        let trimmed = line.trim();
        if let Some(c) = trimmed.strip_prefix(';') {
            if let Some((k, v)) = c.trim().split_once(" = ")
                && (k.starts_with("filament used")
                    || k.starts_with("total filament")
                    || k.starts_with("estimated")
                    || k == "total layers count")
            {
                stats.push((k.to_owned(), v.trim().to_owned()));
            }
            continue;
        }
        let code_part = trimmed.split(';').next().unwrap_or("").trim_end();
        if !code_part.is_empty() {
            code.push_str(code_part);
            code.push('\n');
        }
    }

    let mut out = Vec::with_capacity(code.len() / 3 + 4096);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend(metadata_block(
        FILE_METADATA,
        &[(
            "Producer".to_owned(),
            format!("SlicerX {}", env!("CARGO_PKG_VERSION")),
        )],
    ));
    let mut printer: Vec<(String, String)> = Vec::new();
    for (out_key, key) in [
        ("printer_model", "printer_model"),
        ("filament_type", "filament_type"),
        ("nozzle_diameter", "nozzle_diameter"),
        ("bed_temperature", "hot_plate_temp"),
        ("brim_width", "brim_width"),
        ("fill_density", "sparse_infill_density"),
        ("layer_height", "layer_height"),
        ("temperature", "nozzle_temperature"),
        ("ironing", "ironing_type"),
        ("support_material", "enable_support"),
        ("extruder_colour", "filament_colour"),
    ] {
        if let Some(v) = value_of(cfg, key) {
            printer.push((out_key.to_owned(), v));
        }
    }
    printer.extend(stats.iter().cloned());
    out.extend(metadata_block(PRINTER_METADATA, &printer));
    for (format, w, h, bytes) in &thumbs {
        let mut params = Vec::with_capacity(6);
        params.extend_from_slice(&format.to_le_bytes());
        params.extend_from_slice(&w.to_le_bytes());
        params.extend_from_slice(&h.to_le_bytes());
        out.extend(block(THUMBNAIL, NO_COMPRESSION, &params, bytes, bytes));
    }
    out.extend(metadata_block(PRINT_METADATA, &stats));
    let slicer: Vec<(String, String)> = cfg
        .raw
        .iter()
        .filter_map(|(k, _)| value_of(cfg, k).map(|v| (k.clone(), v.replace('\n', "\\n"))))
        .collect();
    out.extend(metadata_block(SLICER_METADATA, &slicer));
    // G-code blocks split on line ends.
    let mut rest = code.as_str();
    while !rest.is_empty() {
        let mut cut = rest.len().min(GCODE_BLOCK_BYTES);
        if cut < rest.len() {
            cut = rest.get(..cut).and_then(|s| s.rfind('\n')).map_or(cut, |p| p + 1);
        }
        let (chunk, tail) = rest.split_at(cut);
        rest = tail;
        let packed = meatpack_encode(chunk.as_bytes());
        let stored = heatshrink_encode(&packed, 12, 4);
        let mut params = Vec::with_capacity(2);
        params.extend_from_slice(&ENCODING_MEATPACK.to_le_bytes());
        // The header's uncompressed size is the size of the packed data the compression starts from.
        out.extend(block(GCODE, HEATSHRINK_12_4, &params, &packed, &stored));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn heatshrink_decode(data: &[u8], window: u32, lookahead: u32) -> Vec<u8> {
        let (mut out, mut pos) = (Vec::new(), 0usize);
        let take = |n: u32, pos: &mut usize| -> Option<u32> {
            let mut v = 0u32;
            for _ in 0..n {
                let byte = *data.get(*pos / 8)?;
                v = (v << 1) | u32::from((byte >> (7 - *pos % 8)) & 1);
                *pos += 1;
            }
            Some(v)
        };
        while let Some(tag) = take(1, &mut pos) {
            if tag == 1 {
                match take(8, &mut pos) {
                    Some(b) => out.push(u8::try_from(b).unwrap_or(0)),
                    None => break,
                }
            } else {
                let (Some(d), Some(c)) = (take(window, &mut pos), take(lookahead, &mut pos)) else {
                    break;
                };
                let (dist, len) = (d as usize + 1, c as usize + 1);
                for _ in 0..len {
                    let b = out[out.len() - dist];
                    out.push(b);
                }
            }
        }
        out
    }

    pub fn meatpack_decode(data: &[u8]) -> Vec<u8> {
        const CHARS: &[u8; 15] = b"0123456789. \nGX";
        let (mut out, mut i) = (Vec::new(), 0);
        while i < data.len() {
            let b = data[i];
            i += 1;
            if b == 0xFF && data.get(i) == Some(&0xFF) {
                i += 2; // command
                continue;
            }
            let (lo, hi) = (b & 0xF, b >> 4);
            let mut next = || {
                let c = data[i];
                i += 1;
                c
            };
            match (lo == 15, hi == 15) {
                (true, true) => {
                    let (a, c) = (next(), next());
                    out.extend_from_slice(&[a, c]);
                }
                (true, false) => {
                    let a = next();
                    out.extend_from_slice(&[a, CHARS[hi as usize]]);
                }
                (false, true) => {
                    let c = next();
                    out.extend_from_slice(&[CHARS[lo as usize], c]);
                }
                (false, false) => out.extend_from_slice(&[CHARS[lo as usize], CHARS[hi as usize]]),
            }
        }
        out
    }

    #[test]
    fn heatshrink_round_trips() {
        let text: Vec<u8> = "G1 X10.5 Y20.25 E0.0123\n".repeat(400).into_bytes();
        let z = heatshrink_encode(&text, 12, 4);
        assert!(z.len() < text.len() / 4, "{} of {}", z.len(), text.len());
        assert_eq!(heatshrink_decode(&z, 12, 4), text);
        let noise: Vec<u8> = (0..5000u32)
            .map(|i| u8::try_from((i.wrapping_mul(2_654_435_761) >> 13) & 0xFF).unwrap_or(0))
            .collect();
        assert_eq!(heatshrink_decode(&heatshrink_encode(&noise, 11, 4), 11, 4), noise);
        assert_eq!(heatshrink_decode(&heatshrink_encode(b"", 12, 4), 12, 4), b"");
    }

    #[test]
    fn meatpack_round_trips_with_every_pairing() {
        let text = b"G1 X10.5 Y20 E.5 F1800\nM104 S200 ; heat\nG92 E0\nxyz\n";
        let packed = meatpack_encode(text);
        assert_eq!(&packed[..3], &[0xFF, 0xFF, 0xFB]);
        assert!(packed.len() < text.len());
        let mut want = text.to_vec();
        if want.len() % 2 == 1 {
            want.push(b' ');
        }
        assert_eq!(meatpack_decode(&packed), want);
    }

    fn blocks(file: &[u8]) -> Vec<(u16, u16, Vec<u8>, Vec<u8>)> {
        assert_eq!(&file[..4], b"GCDE");
        assert_eq!(u32::from_le_bytes(file[4..8].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(file[8..10].try_into().unwrap()), 1);
        let (mut i, mut out) = (10, Vec::new());
        while i < file.len() {
            let start = i;
            let kind = u16::from_le_bytes(file[i..i + 2].try_into().unwrap());
            let comp = u16::from_le_bytes(file[i + 2..i + 4].try_into().unwrap());
            let raw = u32::from_le_bytes(file[i + 4..i + 8].try_into().unwrap()) as usize;
            i += 8;
            let stored = if comp != 0 {
                i += 4;
                u32::from_le_bytes(file[i - 4..i].try_into().unwrap()) as usize
            } else {
                raw
            };
            let plen = if kind == THUMBNAIL { 6 } else { 2 };
            let params = file[i..i + plen].to_vec();
            i += plen;
            let data = file[i..i + stored].to_vec();
            i += stored;
            let crc = u32::from_le_bytes(file[i..i + 4].try_into().unwrap());
            assert_eq!(crc, crc32_of(&file[start..i]), "block crc");
            i += 4;
            let data = if comp == 3 {
                heatshrink_decode(&data, 12, 4)
            } else {
                data
            };
            assert_eq!(data.len(), raw);
            out.push((kind, comp, params, data));
        }
        out
    }

    #[test]
    fn a_file_has_the_blocks_in_order_and_the_moves_round_trip() {
        let mut cfg = PrintConfig::default();
        cfg.raw.insert("printer_model".into(), serde_json::json!("MK4S"));
        cfg.raw.insert("layer_height".into(), serde_json::json!("0.2"));
        let png = crate::thumbnail::encode_png(&crate::thumbnail::Thumb::new(2, 2, vec![255; 16]).unwrap());
        let b64 = crate::thumbnail::base64_encode(&png);
        let ascii = format!(
            "; generated\n; THUMBNAIL_BLOCK_START\n; thumbnail begin 2x2 {}\n; {b64}\n; thumbnail end\n; THUMBNAIL_BLOCK_END\nM104 S200 ; heat\n\nG1 X1.5 Y2 E.5\nG1 X3 Y4 E.5\n; filament used [mm] = 12.50\n; estimated printing time (normal mode) = 1m 2s\n",
            b64.len()
        );
        let file = encode(&ascii, &cfg);
        let bl = blocks(&file);
        let kinds: Vec<u16> = bl.iter().map(|b| b.0).collect();
        assert_eq!(
            kinds,
            [
                FILE_METADATA,
                PRINTER_METADATA,
                THUMBNAIL,
                PRINT_METADATA,
                SLICER_METADATA,
                GCODE
            ]
        );
        let text = |i: usize| String::from_utf8(bl[i].3.clone()).unwrap();
        assert!(text(0).starts_with("Producer=SlicerX"));
        assert!(text(1).contains("printer_model=MK4S\n") && text(1).contains("filament used [mm]=12.50\n"));
        assert_eq!(bl[2].2, [0, 0, 2, 0, 2, 0]);
        assert_eq!(bl[2].3, png);
        assert!(text(3).contains("estimated printing time (normal mode)=1m 2s"));
        let code = String::from_utf8(meatpack_decode(&bl[5].3)).unwrap();
        assert_eq!(code.trim_end(), "M104 S200\nG1 X1.5 Y2 E.5\nG1 X3 Y4 E.5");
    }

    #[test]
    fn long_files_split_into_blocks_at_line_ends() {
        let ascii = "G1 X10.123 Y20.456 E0.01234\n".repeat(9000);
        let bl = blocks(&encode(&ascii, &PrintConfig::default()));
        let gcode: Vec<_> = bl.iter().filter(|b| b.0 == GCODE).collect();
        assert!(gcode.len() >= 2);
        let joined: Vec<u8> = gcode.iter().flat_map(|b| meatpack_decode(&b.3)).collect();
        let text = String::from_utf8(joined).unwrap();
        assert_eq!(text.lines().count(), 9000);
        assert!(
            text.lines()
                .all(|l| l.trim_end() == "G1 X10.123 Y20.456 E0.01234")
        );
    }
}
