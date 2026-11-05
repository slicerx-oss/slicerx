// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Thumbnails for the G-code: the image encoders (PNG and QOI), the comment
//! block printers read them from, and a small renderer that draws the sliced
//! toolpaths from a fixed isometric view for hosts that have no image of their own.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::output::{Feature, SliceOutput};
use std::fmt::Write as _;

/// An RGBA image, 8 bits per channel, straight (not premultiplied) alpha.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Thumb {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Thumb {
    /// None when the byte count does not match the size or the size is empty or absurd.
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Option<Self> {
        let ok = width > 0
            && height > 0
            && width <= 4096
            && height <= 4096
            && rgba.len() == width as usize * height as usize * 4;
        ok.then_some(Self { width, height, rgba })
    }

    pub(crate) fn px(&self, x: u32, y: u32) -> [u8; 4] {
        let i = (y as usize * self.width as usize + x as usize) * 4;
        match self.rgba.get(i..i + 4) {
            Some(&[r, g, b, a]) => [r, g, b, a],
            _ => [0; 4],
        }
    }

    /// The image scaled to fit `w` by `h`, keeping its shape, centered on a transparent
    /// canvas of that size. Averages the source pixels each result pixel covers.
    #[must_use]
    pub fn fitted(&self, w: u32, h: u32) -> Thumb {
        if w == self.width && h == self.height {
            return self.clone();
        }
        let scale = (f64::from(w) / f64::from(self.width)).min(f64::from(h) / f64::from(self.height));
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "sizes are at most 4096"
        )]
        let (iw, ih) = (
            ((f64::from(self.width) * scale).round() as u32).clamp(1, w),
            ((f64::from(self.height) * scale).round() as u32).clamp(1, h),
        );
        let (ox, oy) = ((w - iw) / 2, (h - ih) / 2);
        let mut out = vec![0u8; w as usize * h as usize * 4];
        for y in 0..ih {
            for x in 0..iw {
                let x0 = u64::from(x) * u64::from(self.width) / u64::from(iw);
                let x1 = ((u64::from(x) + 1) * u64::from(self.width))
                    .div_ceil(u64::from(iw))
                    .max(x0 + 1);
                let y0 = u64::from(y) * u64::from(self.height) / u64::from(ih);
                let y1 = ((u64::from(y) + 1) * u64::from(self.height))
                    .div_ceil(u64::from(ih))
                    .max(y0 + 1);
                let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
                for sy in y0..y1.min(u64::from(self.height)) {
                    for sx in x0..x1.min(u64::from(self.width)) {
                        #[allow(clippy::cast_possible_truncation, reason = "below the image size")]
                        let p = self.px(sx as u32, sy as u32);
                        let al = u64::from(p[3]);
                        r += u64::from(p[0]) * al;
                        g += u64::from(p[1]) * al;
                        b += u64::from(p[2]) * al;
                        a += al;
                        n += 1;
                    }
                }
                let i = usize::try_from((u64::from(oy + y) * u64::from(w) + u64::from(ox + x)) * 4)
                    .unwrap_or(usize::MAX - 4);
                if a > 0
                    && n > 0
                    && let Some(dst) = out.get_mut(i..i + 4)
                {
                    let avg = |sum: u64, div: u64| u8::try_from(sum / div).unwrap_or(u8::MAX);
                    dst.copy_from_slice(&[avg(r, a), avg(g, a), avg(b, a), avg(a, n)]);
                }
            }
        }
        Thumb {
            width: w,
            height: h,
            rgba: out,
        }
    }
}

// ------------------------------------------------------------------- base64

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (u32::from(c.first().copied().unwrap_or(0)) << 16)
            | (u32::from(c.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(c.get(2).copied().unwrap_or(0));
        let at = |shift: u32| char::from(B64.get(((n >> shift) & 63) as usize).copied().unwrap_or(b'A'));
        s.push(at(18));
        s.push(at(12));
        s.push(if c.len() > 1 { at(6) } else { '=' });
        s.push(if c.len() > 2 { at(0) } else { '=' });
    }
    s
}

/// Decodes standard base64 (padding optional, whitespace skipped). None on any other character.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            #[allow(clippy::cast_possible_truncation, reason = "the low 8 bits")]
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// -------------------------------------------------------------------- codecs

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, t) in table.iter_mut().enumerate() {
        #[allow(clippy::cast_possible_truncation, reason = "i is below 256")]
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 == 1 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *t = c;
    }
    !data.iter().fold(!0u32, |c, &b| {
        table
            .get(((c ^ u32::from(b)) & 0xFF) as usize)
            .copied()
            .unwrap_or(0)
            ^ (c >> 8)
    })
}

/// CRC-32 of `data`, as PNG and the binary G-code blocks use it.
pub fn crc32_of(data: &[u8]) -> u32 {
    crc32(data)
}

/// PNG, 8-bit RGBA.
pub fn encode_png(t: &Thumb) -> Vec<u8> {
    let mut raw = Vec::with_capacity((t.width as usize * 4 + 1) * t.height as usize);
    for row in t.rgba.chunks(t.width as usize * 4) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let z = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut chunk = |kind: &[u8; 4], body: &[u8]| {
        out.extend_from_slice(&u32::try_from(body.len()).unwrap_or(0).to_be_bytes());
        let mut c = kind.to_vec();
        c.extend_from_slice(body);
        out.extend_from_slice(&c);
        out.extend_from_slice(&crc32(&c).to_be_bytes());
    };
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&t.width.to_be_bytes());
    ihdr.extend_from_slice(&t.height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

/// QOI, RGBA (the "Quite OK Image" format).
pub fn encode_qoi(t: &Thumb) -> Vec<u8> {
    let mut out = Vec::with_capacity(t.rgba.len() / 2 + 32);
    out.extend_from_slice(b"qoif");
    out.extend_from_slice(&t.width.to_be_bytes());
    out.extend_from_slice(&t.height.to_be_bytes());
    out.extend_from_slice(&[4, 0]);
    let mut index = [[0u8; 4]; 64];
    let mut prev = [0u8, 0, 0, 255];
    let mut run = 0u8;
    let n = t.rgba.len() / 4;
    for (i, &p) in t.rgba.as_chunks::<4>().0.iter().enumerate() {
        if p == prev {
            run += 1;
            if run == 62 || i + 1 == n {
                out.push(0xC0 | (run - 1));
                run = 0;
            }
            continue;
        }
        if run > 0 {
            out.push(0xC0 | (run - 1));
            run = 0;
        }
        let h =
            (usize::from(p[0]) * 3 + usize::from(p[1]) * 5 + usize::from(p[2]) * 7 + usize::from(p[3]) * 11)
                % 64;
        if index.get(h) == Some(&p) {
            #[allow(clippy::cast_possible_truncation, reason = "h is below 64")]
            out.push(h as u8);
        } else {
            if let Some(slot) = index.get_mut(h) {
                *slot = p;
            }
            if p[3] == prev[3] {
                let (dr, dg, db) = (
                    i16::from(p[0]) - i16::from(prev[0]),
                    i16::from(p[1]) - i16::from(prev[1]),
                    i16::from(p[2]) - i16::from(prev[2]),
                );
                let wrap = |d: i16| (d + 256 + 128) % 256 - 128;
                let (dr, dg, db) = (wrap(dr), wrap(dg), wrap(db));
                let (drg, dbg) = (dr - dg, db - dg);
                #[allow(
                    clippy::cast_sign_loss,
                    clippy::cast_possible_truncation,
                    reason = "ranges are checked first"
                )]
                if (-2..=1).contains(&dr) && (-2..=1).contains(&dg) && (-2..=1).contains(&db) {
                    out.push(0x40 | (((dr + 2) as u8) << 4) | (((dg + 2) as u8) << 2) | ((db + 2) as u8));
                } else if (-32..=31).contains(&dg) && (-8..=7).contains(&drg) && (-8..=7).contains(&dbg) {
                    out.push(0x80 | ((dg + 32) as u8));
                    out.push((((drg + 8) as u8) << 4) | ((dbg + 8) as u8));
                } else {
                    out.extend_from_slice(&[0xFE, p[0], p[1], p[2]]);
                }
            } else {
                out.extend_from_slice(&[0xFF, p[0], p[1], p[2], p[3]]);
            }
        }
        prev = p;
    }
    out.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 1]);
    out
}

/// Image formats a G-code thumbnail can use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpg,
    Qoi,
    /// `BigTreeTech` TFT firmware: rows of `RGB565` as hex in comments.
    BttTft,
    /// The COLPIC format Elegoo printers read: a square image drawn on this opaque background, as a palette
    /// of `RGB565` colors and runs of them, written as text at the very start of the file (see [`colpic_blocks`]).
    Colpic([u8; 3]),
}

/// The COLPIC background when the entry names none (`320x320/COLPIC/#30394F` names one): the color the
/// catalog's Elegoo profiles give.
pub const COLPIC_BACKGROUND: [u8; 3] = [0x30, 0x39, 0x4F];

impl Format {
    fn tag(self) -> &'static str {
        match self {
            Self::Png => "thumbnail",
            Self::Jpg => "thumbnail_JPG",
            Self::Qoi => "thumbnail_QOI",
            Self::BttTft => "bigtree thumbnail",
            Self::Colpic(_) => "gimage",
        }
    }

    /// The format as a `thumbnails` entry writes it, after the size: `PNG`, `COLPIC/#30394F`.
    pub fn text(self) -> String {
        match self {
            Self::Png => "PNG".to_owned(),
            Self::Jpg => "JPG".to_owned(),
            Self::Qoi => "QOI".to_owned(),
            Self::BttTft => "BTT_TFT".to_owned(),
            Self::Colpic([r, g, b]) => format!("COLPIC/#{r:02X}{g:02X}{b:02X}"),
        }
    }
}

/// One wanted thumbnail: `48x48/PNG`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Spec {
    pub width: u32,
    pub height: u32,
    pub format: Format,
}

/// The thumbnails a profile asks for (`thumbnails`, with `thumbnails_format` for entries without
/// one), and the entries this build cannot write, by their text.
pub fn specs(cfg: &PrintConfig) -> (Vec<Spec>, Vec<String>) {
    // Orca's presets keep the list as one comma separated string, which an import can also leave inside a
    // one-entry array (`["48x48/PNG,300x300/PNG"]`): every entry is split on commas.
    let entries: Vec<&str> = match cfg.raw.get("thumbnails") {
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(serde_json::Value::as_str).collect(),
        Some(serde_json::Value::String(s)) => vec![s.as_str()],
        _ => Vec::new(),
    };
    let list: Vec<String> = entries
        .iter()
        .flat_map(|s| s.split(','))
        .map(|x| x.trim().to_owned())
        .filter(|x| !x.is_empty())
        .collect();
    let default_format = match cfg.raw.get("thumbnails_format") {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => "PNG".to_owned(),
    };
    parse_specs(&list, &default_format)
}

/// [`specs`] from the text of the entries. A COLPIC entry must be square and may name its background
/// (`320x320/COLPIC/#30394F`); the file has room for two COLPIC images, so past two the smaller ones are skipped.
pub fn parse_specs(list: &[String], default_format: &str) -> (Vec<Spec>, Vec<String>) {
    let (mut ok, mut skipped): (Vec<(Spec, &String)>, Vec<String>) = (Vec::new(), Vec::new());
    for entry in list {
        let (size, format) = entry
            .split_once('/')
            .map_or((entry.as_str(), default_format), |(s, f)| (s, f));
        let Some((w, h)) = size.trim().split_once('x') else {
            skipped.push(entry.clone());
            continue;
        };
        let (Ok(width), Ok(height)) = (w.trim().parse::<u32>(), h.trim().parse::<u32>()) else {
            skipped.push(entry.clone());
            continue;
        };
        if !(1..=1024).contains(&width) || !(1..=1024).contains(&height) {
            skipped.push(entry.clone());
            continue;
        }
        let format = format.trim();
        let (name, background) = format
            .split_once('/')
            .map_or((format, None), |(n, c)| (n.trim(), Some(c.trim())));
        let format = match (name.to_ascii_uppercase().as_str(), background) {
            ("PNG", None) => Some(Format::Png),
            ("QOI", None) => Some(Format::Qoi),
            ("JPG" | "JPEG", None) => Some(Format::Jpg),
            ("BTT_TFT", None) => Some(Format::BttTft),
            ("COLPIC", None) if width == height => Some(Format::Colpic(COLPIC_BACKGROUND)),
            ("COLPIC", Some(c)) if width == height => {
                c.strip_prefix('#').and_then(hex_rgb).map(Format::Colpic)
            }
            _ => None,
        };
        match format {
            Some(format) => ok.push((
                Spec {
                    width,
                    height,
                    format,
                },
                entry,
            )),
            None => skipped.push(entry.clone()),
        }
    }
    let mut colpic: Vec<(usize, u32)> = ok
        .iter()
        .enumerate()
        .filter(|(_, (s, _))| matches!(s.format, Format::Colpic(_)))
        .map(|(i, (s, _))| (i, s.width))
        .collect();
    if colpic.len() > 2 {
        colpic.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let extra: Vec<usize> = colpic.iter().skip(2).map(|&(i, _)| i).collect();
        let mut i = 0;
        ok.retain(|(_, entry)| {
            let keep = !extra.contains(&i);
            if !keep {
                skipped.push((*entry).clone());
            }
            i += 1;
            keep
        });
    }
    (ok.into_iter().map(|(s, _)| s).collect(), skipped)
}

/// `RRGGBB` (more digits may follow) as RGB.
fn hex_rgb(hex: &str) -> Option<[u8; 3]> {
    Some([
        u8::from_str_radix(hex.get(0..2)?, 16).ok()?,
        u8::from_str_radix(hex.get(2..4)?, 16).ok()?,
        u8::from_str_radix(hex.get(4..6)?, 16).ok()?,
    ])
}

/// The G-code text for one thumbnail as Orca writes it (`GCodeThumbnails::export_thumbnails_to_file`): the image
/// as base64 in rows of 78 characters between `; THUMBNAIL_BLOCK_START` and `; THUMBNAIL_BLOCK_END`, each row
/// a comment, and `; thumbnail begin WxH SIZE` (SIZE the base64 length) before them; `BTT_TFT` is its own thing,
/// see [`btt_block`].
pub fn comment_block(spec: &Spec, image: &Thumb) -> String {
    let fitted = image.fitted(spec.width, spec.height);
    let bytes = match spec.format {
        Format::Png => encode_png(&fitted),
        Format::Qoi => encode_qoi(&fitted),
        Format::Jpg => crate::jpeg::encode(&fitted),
        Format::BttTft => return btt_block(&fitted),
        Format::Colpic(_) => return colpic_block(spec, image, "gimage"),
    };
    let b64 = base64_encode(&bytes);
    let tag = spec.format.tag();
    let mut s = String::with_capacity(b64.len() + b64.len() / 78 * 3 + 128);
    s.push_str("; THUMBNAIL_BLOCK_START\n");
    let _ = writeln!(
        s,
        "\n;\n; {tag} begin {}x{} {}",
        spec.width,
        spec.height,
        b64.len()
    );
    for row in b64.as_bytes().chunks(78) {
        let _ = writeln!(s, "; {}", String::from_utf8_lossy(row));
    }
    let _ = writeln!(s, "; {tag} end");
    s.push_str("; THUMBNAIL_BLOCK_END\n\n");
    s
}

/// `BigTreeTech`'s thumbnail: `;` and the width and height as four hex digits each, then one comment line per
/// pixel row of `RGB565` values as four hex digits (alpha folded in, three near black values set to black), each
/// line ending `\r\n` as the firmware requires.
fn btt_block(image: &Thumb) -> String {
    let mut s = format!(";{:04x}{:04x}\r\n", image.width, image.height);
    for row in image.rgba.chunks(image.width as usize * 4) {
        s.push(';');
        for px in row.as_chunks::<4>().0 {
            let a = u32::from(px[3]);
            let fold = |c: u8| (a * u32::from(c)) / 255;
            let (r, g, b) = (fold(px[0]), fold(px[1]), fold(px[2]));
            let v565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
            let v565 = if matches!(v565, 0x0020 | 0x0841 | 0x0861) {
                0
            } else {
                v565
            };
            let _ = write!(s, "{v565:04x}");
        }
        s.push_str("\r\n");
    }
    s
}

/// All requested blocks but COLPIC ones, which go at the start of the file ([`colpic_blocks`]), one after the
/// other; a `BTT_TFT` list ends with its own marker line.
pub fn comment_blocks(specs: &[Spec], image: &Thumb) -> String {
    let specs: Vec<&Spec> = specs
        .iter()
        .filter(|s| !matches!(s.format, Format::Colpic(_)))
        .collect();
    let mut s = String::new();
    for (i, sp) in specs.iter().enumerate() {
        s.push_str(&comment_block(sp, image));
        if sp.format == Format::BttTft && i + 1 == specs.len() {
            s.push_str("; bigtree thumbnail end\r\n\r\n");
        }
    }
    s
}

// ------------------------------------------------------------------- COLPIC

/// Most colors a COLPIC palette holds.
const COLPIC_COLORS: usize = 1024;
/// Characters of COLPIC text per line.
const COLPIC_CHUNK: usize = 1015;

/// The COLPIC images of `specs`, for the very start of the file: the largest as `gimage` (the large preview),
/// then the next as `simage` (the small one). Empty when `specs` has none.
pub fn colpic_blocks(specs: &[Spec], image: &Thumb) -> String {
    let mut colpic: Vec<&Spec> = specs
        .iter()
        .filter(|s| matches!(s.format, Format::Colpic(_)))
        .collect();
    colpic.sort_by_key(|s| std::cmp::Reverse(s.width));
    colpic
        .iter()
        .zip(["gimage", "simage"])
        .map(|(spec, tag)| colpic_block(spec, image, tag))
        .collect()
}

/// One COLPIC image: `image` fitted into the spec's square on its background, encoded and framed under `tag`.
fn colpic_block(spec: &Spec, image: &Thumb, tag: &str) -> String {
    let background = match spec.format {
        Format::Colpic(c) => c,
        _ => COLPIC_BACKGROUND,
    };
    let side = spec.width.max(spec.height);
    let fitted = on_background(&image.fitted(side, side), background);
    colpic_frame(tag, &colpic_text(&colpic_bytes(&fitted)))
}

/// `image` over an opaque `background`.
fn on_background(image: &Thumb, background: [u8; 3]) -> Thumb {
    let mut rgba = image.rgba.clone();
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = u32::from(px[3]);
        for (c, bg) in px.iter_mut().zip(background) {
            let v = (u32::from(*c) * a + u32::from(bg) * (255 - a) + 127) / 255;
            *c = u8::try_from(v).unwrap_or(u8::MAX);
        }
        px[3] = 255;
    }
    Thumb {
        width: image.width,
        height: image.height,
        rgba,
    }
}

/// 8-bit RGB as `RGB565`: each channel cut to its top bits, no rounding.
pub fn rgb565(r: u8, g: u8, b: u8) -> u16 {
    (u16::from(r >> 3) << 11) | (u16::from(g >> 2) << 5) | u16::from(b >> 3)
}

/// The COLPIC bytes of an opaque image (alpha is not read): a 32-byte header, the palette, the runs and 1 to 3
/// zero bytes. An image of more than 1024 colors is reduced to 1024 first ([`quantize`]).
pub fn colpic_bytes(image: &Thumb) -> Vec<u8> {
    let mut px: Vec<u16> = image
        .rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| rgb565(p[0], p[1], p[2]))
        .collect();
    quantize(&mut px, COLPIC_COLORS);
    // The palette: most used first, and among colors used as often, the one that first shows later first.
    let (mut count, mut first) = (vec![0u32; 1 << 16], vec![0usize; 1 << 16]);
    for (i, &c) in px.iter().enumerate() {
        if let (Some(n), Some(f)) = (count.get_mut(usize::from(c)), first.get_mut(usize::from(c))) {
            if *n == 0 {
                *f = i;
            }
            *n += 1;
        }
    }
    let at = |v: &[u32], c: u16| v.get(usize::from(c)).copied().unwrap_or(0);
    let mut palette: Vec<u16> = (0..=u16::MAX).filter(|&c| at(&count, c) > 0).collect();
    palette.sort_by(|&a, &b| {
        at(&count, b)
            .cmp(&at(&count, a))
            .then(first.get(usize::from(b)).cmp(&first.get(usize::from(a))))
    });
    let mut index = vec![0u16; 1 << 16];
    for (i, &c) in palette.iter().enumerate() {
        if let Some(slot) = index.get_mut(usize::from(c)) {
            *slot = u16::try_from(i).unwrap_or(u16::MAX);
        }
    }
    let indexes: Vec<u16> = px
        .iter()
        .map(|&c| index.get(usize::from(c)).copied().unwrap_or(0))
        .collect();
    let runs = colpic_runs(&indexes);
    let size = |n: usize| u32::try_from(n).unwrap_or(u32::MAX).to_le_bytes();
    let mut out = Vec::with_capacity(32 + palette.len() * 2 + runs.len() + 3);
    out.extend_from_slice(&[3, 0, 0, 0]);
    out.extend_from_slice(&image.width.to_le_bytes());
    out.extend_from_slice(&image.height.to_le_bytes());
    out.extend_from_slice(&[0x3C, 0xC3, 0xDD, 0x05]);
    out.extend_from_slice(&size(palette.len() * 2));
    out.extend_from_slice(&size(runs.len()));
    out.extend_from_slice(&[0; 8]);
    for c in &palette {
        out.extend_from_slice(&c.to_le_bytes());
    }
    out.extend_from_slice(&runs);
    let pad = 3 - out.len() % 3;
    out.resize(out.len() + pad, 0);
    out
}

/// Runs of equal palette indexes, at most 255 pixels each, across row ends: 1 to 6 pixels in one byte (count
/// times 32 plus the index's slot), 7 to 255 in two (slot, count), with a page select byte (`E0` plus index
/// over 32) before a run whose page is not the current one. The page starts at 0.
fn colpic_runs(indexes: &[u16]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut page = 0u8;
    let mut rest = indexes;
    while let Some(&p) = rest.first() {
        let n = rest.iter().take(255).take_while(|&&q| q == p).count();
        rest = rest.get(n..).unwrap_or_default();
        let (pg, slot) = (
            u8::try_from(p / 32).unwrap_or(31) & 31,
            u8::try_from(p % 32).unwrap_or(0),
        );
        if pg != page {
            out.push(0xE0 | pg);
            page = pg;
        }
        let n = u8::try_from(n).unwrap_or(u8::MAX);
        if n <= 6 {
            out.push((n << 5) | slot);
        } else {
            out.extend_from_slice(&[slot, n]);
        }
    }
    out
}

/// COLPIC text: every 3 bytes as four 6-bit values, most significant first, each written as the character
/// 48 above it, but `~` for 44 (a backslash otherwise).
fn colpic_text(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() / 3 * 4 + 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c.first().copied().unwrap_or(0)) << 16)
            | (u32::from(c.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(c.get(2).copied().unwrap_or(0));
        for shift in [18, 12, 6, 0] {
            let v = (n >> shift) & 63;
            s.push(if v == 44 {
                '~'
            } else {
                char::from_u32(48 + v).unwrap_or('0')
            });
        }
    }
    s
}

/// COLPIC text as G-code lines, each ended by a bare CR: chunks of 1015 characters behind `;tag:`, then a
/// line of zeros. The line counts come from the text length plus 10, as the printers' format has it: the
/// chunk at that count gets a second `;` in front, and the zeros line is 1022 less that length modulo 1015
/// characters long. A first line without that second `;` has no CR before it.
fn colpic_frame(tag: &str, text: &str) -> String {
    let s = text.len() + 10;
    let m = s / COLPIC_CHUNK;
    let zeros = 1022 - s % COLPIC_CHUNK;
    let mut out = String::with_capacity(text.len() + text.len() / COLPIC_CHUNK * 10 + zeros + 24);
    for (k, chunk) in text.as_bytes().chunks(COLPIC_CHUNK).enumerate() {
        if k == m {
            out.push_str("\r;");
        } else if k > 0 {
            out.push('\r');
        }
        out.push(';');
        out.push_str(tag);
        out.push(':');
        out.push_str(&String::from_utf8_lossy(chunk));
    }
    out.push_str("\r;");
    out.extend(std::iter::repeat_n('0', zeros));
    out.push('\r');
    out
}

/// Reduces `px` to at most `max` colors, the same way every time: median cut. The colors are split into
/// groups, each time the group whose widest channel spans most (the one with more pixels on a tie, then the
/// first) at the pixel-weighted median of that channel, until there are `max` groups; every color then takes
/// its group's pixel-weighted mean. Nothing changes when there are `max` colors or fewer.
fn quantize(px: &mut [u16], max: usize) {
    let mut count = vec![0u32; 1 << 16];
    for &c in px.iter() {
        if let Some(n) = count.get_mut(usize::from(c)) {
            *n += 1;
        }
    }
    let mut colors: Vec<(u16, u32)> = (0..=u16::MAX)
        .zip(count.iter().copied())
        .filter(|&(_, n)| n > 0)
        .collect();
    if colors.len() <= max {
        return;
    }
    // Each channel at 8 bits, so their spans compare.
    let channel = |c: u16, k: usize| match k {
        0 => (c >> 11) << 3,
        1 => ((c >> 5) & 63) << 2,
        _ => (c & 31) << 3,
    };
    // A group: its range of `colors`, the span of its widest channel, its pixels and that channel.
    let measure = |items: &[(u16, u32)], start: usize| {
        let (mut span, mut widest) = (0u16, 0usize);
        for k in 0..3 {
            let lo = items.iter().map(|&(c, _)| channel(c, k)).min().unwrap_or(0);
            let hi = items.iter().map(|&(c, _)| channel(c, k)).max().unwrap_or(0);
            if hi - lo > span {
                (span, widest) = (hi - lo, k);
            }
        }
        let pixels: u64 = items.iter().map(|&(_, n)| u64::from(n)).sum();
        (start..start + items.len(), span, pixels, widest)
    };
    let mut groups = vec![measure(&colors, 0)];
    while groups.len() < max {
        let mut best: Option<usize> = None;
        for (i, g) in groups.iter().enumerate() {
            if g.0.len() < 2 {
                continue;
            }
            if best
                .and_then(|b| groups.get(b))
                .is_none_or(|b| (g.1, g.2) > (b.1, b.2))
            {
                best = Some(i);
            }
        }
        let Some((range, _, pixels, k)) = best.and_then(|b| groups.get(b)).cloned() else {
            break;
        };
        let Some(items) = colors.get_mut(range.clone()) else {
            break;
        };
        items.sort_by_key(|&(c, _)| (channel(c, k), c));
        let mut acc = 0u64;
        let mut cut = items.len() - 1;
        for (i, &(_, n)) in items.iter().enumerate() {
            acc += u64::from(n);
            if acc * 2 >= pixels {
                cut = i + 1;
                break;
            }
        }
        let cut = cut.clamp(1, items.len() - 1);
        let (lo, hi) = items.split_at(cut);
        let (a, b) = (measure(lo, range.start), measure(hi, range.start + cut));
        if let Some(i) = best {
            if let Some(g) = groups.get_mut(i) {
                *g = a;
            }
            groups.insert(i + 1, b);
        }
    }
    let mut map = vec![0u16; 1 << 16];
    for (range, ..) in &groups {
        let Some(items) = colors.get(range.clone()) else {
            continue;
        };
        let total: u64 = items.iter().map(|&(_, n)| u64::from(n)).sum::<u64>().max(1);
        let mean = |f: &dyn Fn(u16) -> u16| {
            let sum: u64 = items.iter().map(|&(c, n)| u64::from(f(c)) * u64::from(n)).sum();
            u16::try_from((sum + total / 2) / total).unwrap_or(0)
        };
        let to = (mean(&|c| c >> 11) << 11) | (mean(&|c| (c >> 5) & 63) << 5) | mean(&|c| c & 31);
        for &(c, _) in items {
            if let Some(m) = map.get_mut(usize::from(c)) {
                *m = to;
            }
        }
    }
    for c in px.iter_mut() {
        *c = map.get(usize::from(*c)).copied().unwrap_or(*c);
    }
}

// ------------------------------------------------------------------ renderer

/// Draws the toolpaths of a plate, layer by layer from the bottom, from a fixed
/// isometric view onto a transparent canvas.
pub struct Renderer {
    size: u32,
    scale: f64,
    center: [f64; 2],
    offset: [f64; 2],
    top: f64,
    color: [u8; 3],
    buf: Vec<u8>,
    /// Cosine and sine of the yaw and of the tilt.
    yaw: (f64, f64),
    tilt: (f64, f64),
}

const YAW: f64 = std::f64::consts::FRAC_PI_4;
const TILT: f64 = 0.6;
/// The canvas is drawn this many times larger and averaged down.
const SUPERSAMPLE: u32 = 2;
/// Side of the square tiles whose painted pixels [`Painted`] counts.
const TILE: usize = 8;

/// The canvas pixels one [`Renderer::add`] has painted, with a count per tile, so a segment whose pixels are
/// all painted already is passed over without testing them.
struct Painted {
    size: usize,
    tiles_x: usize,
    done: Vec<bool>,
    count: Vec<u16>,
}

impl Painted {
    fn new(size: usize) -> Self {
        let tiles_x = size.div_ceil(TILE);
        Self {
            size,
            tiles_x,
            done: vec![false; size * size],
            count: vec![0; tiles_x * tiles_x],
        }
    }

    /// Pixels in tile column (or row) `t`: a whole tile but at the canvas edge.
    fn span(&self, t: usize) -> usize {
        TILE.min(self.size - t * TILE)
    }

    /// True when every pixel of the inclusive box is painted.
    fn covers(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> bool {
        (y0 / TILE..=y1 / TILE).all(|ty| {
            let rows = self.span(ty);
            (x0 / TILE..=x1 / TILE).all(|tx| {
                self.count
                    .get(ty * self.tiles_x + tx)
                    .is_some_and(|&c| usize::from(c) == rows * self.span(tx))
            })
        })
    }

    fn mark(&mut self, x: usize, y: usize) {
        if let Some(d) = self.done.get_mut(y * self.size + x) {
            *d = true;
        }
        if let Some(c) = self.count.get_mut(y / TILE * self.tiles_x + x / TILE) {
            *c += 1;
        }
    }
}

impl Renderer {
    /// `bounds` is `[min_x, min_y, max_x, max_y]` of the plate's footprint, mm.
    pub fn new(bounds: [f32; 4], top_z: f32, size: u32, color: [u8; 3]) -> Self {
        let size = size.clamp(16, 1024) * SUPERSAMPLE;
        let b = bounds.map(f64::from);
        let center = [f64::midpoint(b[0], b[2]), f64::midpoint(b[1], b[3])];
        let top = f64::from(top_z).max(0.1);
        let mut me = Self {
            size,
            scale: 1.0,
            center,
            offset: [0.0, 0.0],
            top,
            color,
            buf: vec![0; size as usize * size as usize * 4],
            yaw: (YAW.m_cos(), YAW.m_sin()),
            tilt: (TILT.m_cos(), TILT.m_sin()),
        };
        let corners = [(b[0], b[1]), (b[2], b[1]), (b[0], b[3]), (b[2], b[3])];
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for (x, y) in corners {
            for z in [0.0, top] {
                let p = me.project(x, y, z);
                lo = [lo[0].min(p[0]), lo[1].min(p[1])];
                hi = [hi[0].max(p[0]), hi[1].max(p[1])];
            }
        }
        let span = (hi[0] - lo[0]).max(hi[1] - lo[1]).max(1e-6);
        me.scale = f64::from(size) * 0.88 / span;
        me.offset = [
            f64::from(size) / 2.0 - f64::midpoint(lo[0], hi[0]) * me.scale,
            f64::from(size) / 2.0 - f64::midpoint(lo[1], hi[1]) * me.scale,
        ];
        me
    }

    /// Screen position in millimeters before scaling; y grows upward.
    fn project(&self, x: f64, y: f64, z: f64) -> [f64; 2] {
        let (dx, dy) = (x - self.center[0], y - self.center[1]);
        let (c, s) = self.yaw;
        let (xr, yr) = (dx * c - dy * s, dx * s + dy * c);
        [xr, z * self.tilt.0 + yr * self.tilt.1]
    }

    fn to_px(&self, x: f64, y: f64, z: f64) -> [f64; 2] {
        let p = self.project(x, y, z);
        [
            p[0] * self.scale + self.offset[0],
            f64::from(self.size) - (p[1] * self.scale + self.offset[1]),
        ]
    }

    /// Draws the layers of `out`. Call for layer ranges in ascending order.
    ///
    /// Each segment paints the pixels within its half width, over what was there, so a pixel ends up with the
    /// color of the last segment that reaches it. The segments are taken last to first and paint only pixels
    /// no later segment has painted, which gives the same image while the pixels of segments hidden under
    /// later ones are left untested.
    pub fn add(&mut self, out: &SliceOutput) {
        let mut painted = Painted::new(self.size as usize);
        let mut px: Vec<[f64; 2]> = Vec::new();
        for l in out.layers.iter().rev() {
            let z = f64::from(l.z);
            let depth = 0.45 + 0.55 * (z / self.top).clamp(0.0, 1.0);
            for p in l.paths.iter().rev() {
                let shade = match p.feature {
                    Feature::OuterWall | Feature::OverhangWall => 1.0,
                    Feature::TopSurface => 1.05,
                    Feature::Support | Feature::SupportInterface => 0.6,
                    Feature::Brim | Feature::Skirt => 0.5,
                    _ => 0.86,
                };
                let f = (depth * shade).clamp(0.0, 1.0);
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a channel value"
                )]
                let col = self
                    .color
                    .map(|c| (f64::from(c) * f).round().clamp(0.0, 255.0) as u8);
                let half = (f64::from(p.width_mm) * self.scale / 2.0).max(0.8);
                px.clear();
                px.extend(l.path_points(p).iter().map(|q| self.to_px(q.x_mm(), q.y_mm(), z)));
                // A path whose every pixel is painted already paints nothing.
                if let Some(b) = self.pixel_box(&px, half)
                    && painted.covers(b[0], b[1], b[2], b[3])
                {
                    continue;
                }
                for w in px.windows(2).rev() {
                    if let [a, b] = *w {
                        self.capsule(&mut painted, a, b, half, col);
                    }
                }
            }
        }
    }

    /// The canvas pixels within `half` of the points' bounds, as `[x0, y0, x1, y1]`; None off the canvas.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "clamped to the canvas"
    )]
    fn pixel_box(&self, pts: &[[f64; 2]], half: f64) -> Option<[usize; 4]> {
        let (lo, hi) = pts.iter().fold(([f64::MAX; 2], [f64::MIN; 2]), |(l, h), p| {
            ([l[0].min(p[0]), l[1].min(p[1])], [h[0].max(p[0]), h[1].max(p[1])])
        });
        let size = f64::from(self.size);
        let (x0, x1) = (
            (lo[0] - half).floor().max(0.0),
            (hi[0] + half).ceil().min(size - 1.0),
        );
        let (y0, y1) = (
            (lo[1] - half).floor().max(0.0),
            (hi[1] + half).ceil().min(size - 1.0),
        );
        (x0 <= x1 && y0 <= y1).then_some([x0 as usize, y0 as usize, x1 as usize, y1 as usize])
    }

    /// Paints the pixels within `half` of the segment `a b` that `painted` does not hold yet.
    fn capsule(&mut self, painted: &mut Painted, a: [f64; 2], b: [f64; 2], half: f64, col: [u8; 3]) {
        let size = f64::from(self.size);
        let (x0, x1) = (
            (a[0].min(b[0]) - half).floor().max(0.0),
            (a[0].max(b[0]) + half).ceil().min(size - 1.0),
        );
        let (y0, y1) = (
            (a[1].min(b[1]) - half).floor().max(0.0),
            (a[1].max(b[1]) + half).ceil().min(size - 1.0),
        );
        if x0 > x1 || y0 > y1 {
            return;
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "clamped to the canvas"
        )]
        let (x0, x1, y0, y1) = (x0 as u32, x1 as u32, y0 as u32, y1 as u32);
        if painted.covers(x0 as usize, y0 as usize, x1 as usize, y1 as usize) {
            return;
        }
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        let side = self.size as usize;
        for py in y0..=y1 {
            let Some((sx0, sx1)) = row_span(a, [dx, dy], len2, f64::from(py) + 0.5, half, (x0, x1)) else {
                continue;
            };
            for px in sx0..=sx1 {
                let k = py as usize * side + px as usize;
                if painted.done.get(k).is_none_or(|&d| d) {
                    continue;
                }
                let (cx, cy) = (f64::from(px) + 0.5, f64::from(py) + 0.5);
                let t = if len2 == 0.0 {
                    0.0
                } else {
                    (((cx - a[0]) * dx + (cy - a[1]) * dy) / len2).clamp(0.0, 1.0)
                };
                let d2 = (cx - (a[0] + t * dx)).m_powi(2) + (cy - (a[1] + t * dy)).m_powi(2);
                if d2 <= half * half {
                    if let Some(dst) = self.buf.get_mut(k * 4..k * 4 + 4) {
                        dst.copy_from_slice(&[col[0], col[1], col[2], 255]);
                    }
                    painted.mark(px as usize, py as usize);
                }
            }
        }
    }

    /// The finished image at the requested size (the canvas is averaged down).
    pub fn finish(self) -> Thumb {
        let big = Thumb {
            width: self.size,
            height: self.size,
            rgba: self.buf,
        };
        let side = self.size / SUPERSAMPLE;
        big.fitted(side, side)
    }
}

/// The columns of the pixel row whose center is at `cy` that can lie within `half` of the segment from `a` along `d`
/// (squared length `len2`): those whose centers fall inside the rectangle around the segment that reaches `half`
/// past its ends and `half` to each side, which holds every point within `half` of it, widened by a quarter pixel
/// so that rounding cannot leave out a pixel the exact test takes; within `xs`, and None when no column can.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "clamped to the canvas columns"
)]
fn row_span(a: [f64; 2], d: [f64; 2], len2: f64, cy: f64, half: f64, xs: (u32, u32)) -> Option<(u32, u32)> {
    let (mut lo, mut hi) = (f64::from(xs.0) + 0.5, f64::from(xs.1) + 0.5);
    if len2 > 0.0 {
        let len = len2.sqrt();
        let reach = half * len;
        let ry = cy - a[1];
        // Along the segment, `(cx - ax) dx + ry dy` lies in `[-reach, len2 + reach]`; across it, `(cx - ax) dy - ry
        // dx` lies in `[-reach, reach]`. A bound whose coefficient is under a thousandth of the length is left out
        // (the span only widens): the quarter pixel then still keeps a margin of more than 1e-4 pixels against it.
        for (coef, rest, min, max) in [
            (d[0], ry * d[1], -reach, len2 + reach),
            (d[1], -ry * d[0], -reach, reach),
        ] {
            if coef.abs() > 1e-3 * len {
                let (u, v) = ((min - rest) / coef, (max - rest) / coef);
                let (u, v) = if coef > 0.0 { (u, v) } else { (v, u) };
                lo = lo.max(a[0] + u);
                hi = hi.min(a[0] + v);
            }
        }
    }
    // Column `px` has its center at `px + 0.5`.
    let first = (lo - 0.75).ceil().max(f64::from(xs.0));
    let last = (hi - 0.25).floor().min(f64::from(xs.1));
    (first <= last).then_some((first as u32, last as u32))
}

/// The filament color of the first slot as RGB, from `filament_colour`, or a warm orange.
pub fn filament_color(cfg: &PrintConfig) -> [u8; 3] {
    let text = match cfg.raw.get("filament_colour") {
        Some(serde_json::Value::Array(a)) => a.first().and_then(|v| v.as_str()),
        Some(serde_json::Value::String(s)) => Some(s.as_str()),
        _ => None,
    };
    text.and_then(|t| t.strip_prefix('#'))
        .and_then(hex_rgb)
        .unwrap_or([0xF2, 0x8C, 0x38])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> Thumb {
        Thumb::new(
            w,
            h,
            px.iter().copied().cycle().take((w * h * 4) as usize).collect(),
        )
        .unwrap()
    }

    #[test]
    fn base64_round_trips() {
        for n in 0..20u8 {
            let data: Vec<u8> = (0..n).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(base64_decode(&base64_encode(&data)).unwrap(), data);
        }
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert!(base64_decode("a$b").is_none());
    }

    #[test]
    fn crc_matches_the_check_value() {
        assert_eq!(crc32_of(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn png_has_the_right_structure() {
        let png = encode_png(&solid(3, 2, [10, 20, 30, 255]));
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 3);
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        // The IDAT payload inflates back to filter byte plus pixels per row.
        let idat = png.windows(4).position(|w| w == b"IDAT").unwrap();
        let len = u32::from_be_bytes(png[idat - 4..idat].try_into().unwrap()) as usize;
        let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&png[idat + 4..idat + 4 + len]).unwrap();
        assert_eq!(raw.len(), (3 * 4 + 1) * 2);
        assert_eq!(&raw[..5], &[0, 10, 20, 30, 255]);
    }

    #[test]
    fn qoi_matches_a_reference_decode() {
        // Decode our own output with a straightforward decoder and compare.
        let mut px = Vec::new();
        for i in 0..64u32 {
            let v = u8::try_from(i * 4).unwrap();
            px.extend_from_slice(&[v, 255 - v, v / 2, if i % 9 == 0 { 128 } else { 255 }]);
        }
        px.extend(std::iter::repeat_n([7u8, 8, 9, 255], 96).flatten());
        let t = Thumb::new(16, 10, px).unwrap();
        let q = encode_qoi(&t);
        assert_eq!(&q[..4], b"qoif");
        assert_eq!(&q[q.len() - 8..], &[0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(decode_qoi(&q), t.rgba);
    }

    fn decode_qoi(q: &[u8]) -> Vec<u8> {
        let n = u32::from_be_bytes(q[4..8].try_into().unwrap()) as usize
            * u32::from_be_bytes(q[8..12].try_into().unwrap()) as usize;
        let (mut out, mut idx, mut px, mut i) = (Vec::new(), [[0u8; 4]; 64], [0u8, 0, 0, 255], 14);
        while out.len() < n * 4 {
            let b = q[i];
            i += 1;
            let mut run = 0;
            if b == 0xFE {
                px = [q[i], q[i + 1], q[i + 2], px[3]];
                i += 3;
            } else if b == 0xFF {
                px = [q[i], q[i + 1], q[i + 2], q[i + 3]];
                i += 4;
            } else {
                match b >> 6 {
                    0 => px = idx[b as usize],
                    1 => {
                        px[0] = px[0].wrapping_add(((b >> 4) & 3).wrapping_sub(2));
                        px[1] = px[1].wrapping_add(((b >> 2) & 3).wrapping_sub(2));
                        px[2] = px[2].wrapping_add((b & 3).wrapping_sub(2));
                    }
                    2 => {
                        let b2 = q[i];
                        i += 1;
                        let dg = (b & 63).wrapping_sub(32);
                        px[0] = px[0].wrapping_add(dg).wrapping_add((b2 >> 4).wrapping_sub(8));
                        px[1] = px[1].wrapping_add(dg);
                        px[2] = px[2].wrapping_add(dg).wrapping_add((b2 & 15).wrapping_sub(8));
                    }
                    _ => run = b & 63,
                }
            }
            let h = (px[0] as usize * 3 + px[1] as usize * 5 + px[2] as usize * 7 + px[3] as usize * 11) % 64;
            idx[h] = px;
            for _ in 0..=run {
                out.extend_from_slice(&px);
            }
        }
        out
    }

    #[test]
    fn fitting_keeps_the_shape_and_averages() {
        let t = solid(8, 4, [200, 100, 50, 255]);
        let f = t.fitted(4, 4);
        assert_eq!((f.width, f.height), (4, 4));
        // 4 wide by 2 tall image centered: rows 1 and 2 are opaque, rows 0 and 3 clear.
        assert_eq!(f.px(1, 0)[3], 0);
        assert_eq!(f.px(1, 1), [200, 100, 50, 255]);
        assert_eq!(f.px(1, 3)[3], 0);
    }

    #[test]
    fn specs_read_the_profile_and_skip_what_is_unsupported() {
        let mut cfg = PrintConfig::default();
        cfg.raw.insert(
            "thumbnails".into(),
            serde_json::json!(["48x48/PNG", "300x300/QOI", "32x32/COLPIC", "40x40", "bad"]),
        );
        cfg.raw
            .insert("thumbnails_format".into(), serde_json::json!("QOI"));
        let (ok, skipped) = specs(&cfg);
        assert_eq!(ok.len(), 4);
        assert_eq!(
            ok[2],
            Spec {
                width: 32,
                height: 32,
                format: Format::Colpic(COLPIC_BACKGROUND)
            }
        );
        assert_eq!(
            ok[3],
            Spec {
                width: 40,
                height: 40,
                format: Format::Qoi
            }
        );
        assert_eq!(skipped, ["bad"]);
        cfg.raw
            .insert("thumbnails".into(), serde_json::json!("16x16/PNG, 32x32/PNG"));
        assert_eq!(specs(&cfg).0.len(), 2);
        // Orca's Bambu and Creality presets, imported: one array entry holding the whole list.
        cfg.raw
            .insert("thumbnails".into(), serde_json::json!(["96x96/PNG, 300x300/PNG"]));
        let (ok, skipped) = specs(&cfg);
        assert_eq!((ok.len(), skipped.len()), (2, 0));
    }

    #[test]
    fn the_comment_block_has_prusa_and_orca_framing() {
        let s = comment_blocks(
            &[Spec {
                width: 16,
                height: 16,
                format: Format::Png,
            }],
            &solid(16, 16, [1, 2, 3, 255]),
        );
        assert!(s.starts_with("; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin 16x16 "));
        assert!(s.ends_with("; thumbnail end\n; THUMBNAIL_BLOCK_END\n\n"));
        let body: String = s
            .lines()
            .filter(|l| l.starts_with("; ") && !l.contains("thumbnail") && !l.contains("THUMBNAIL"))
            .map(|l| &l[2..])
            .collect();
        let declared: usize = s
            .lines()
            .nth(3)
            .unwrap()
            .rsplit(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(declared, body.len());
        assert_eq!(&base64_decode(&body).unwrap()[1..4], b"PNG");
        assert!(s.lines().all(|l| l.len() <= 80));
    }

    #[test]
    fn btt_tft_writes_rgb565_rows_with_crlf() {
        let img = Thumb::new(
            2,
            2,
            vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0],
        )
        .unwrap();
        let s = comment_blocks(
            &[Spec {
                width: 2,
                height: 2,
                format: Format::BttTft,
            }],
            &img,
        );
        assert_eq!(
            s,
            ";00020002\r\n;f800".to_owned() + "07e0\r\n;001f0000\r\n; bigtree thumbnail end\r\n\r\n"
        );
    }

    const RED: [u8; 3] = [255, 0, 0];
    const BLUE: [u8; 3] = [0, 0, 255];

    fn opaque(w: u32, h: u32, px: &[[u8; 3]]) -> Thumb {
        Thumb::new(w, h, px.iter().flat_map(|p| [p[0], p[1], p[2], 255]).collect()).unwrap()
    }

    fn hex_bytes(s: &str) -> Vec<u8> {
        s.split_whitespace()
            .map(|b| u8::from_str_radix(b, 16).unwrap())
            .collect()
    }

    #[test]
    fn rgb565_truncates_each_channel() {
        assert_eq!(rgb565(255, 0, 0), 0xF800);
        assert_eq!(rgb565(0, 0, 255), 0x001F);
        assert_eq!(rgb565(255, 255, 255), 0xFFFF);
        assert_eq!(rgb565(128, 128, 128), 0x8410);
    }

    #[test]
    fn colpic_solid_red_block() {
        let b = colpic_bytes(&opaque(2, 2, &[RED; 4]));
        assert_eq!(
            b,
            hex_bytes(
                "03 00 00 00 02 00 00 00 02 00 00 00 3C C3 DD 05
                 02 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00
                 00 F8 80 00"
            )
        );
        let t = colpic_text(&b);
        assert_eq!(t, "0`00008000020000?<?M1@8000010000000000000000n800");
        assert_eq!(
            colpic_frame("gimage", &t),
            format!("\r;;gimage:{t}\r;{}\r", "0".repeat(964))
        );
    }

    #[test]
    fn colpic_splits_a_long_run_at_255() {
        let b = colpic_bytes(&opaque(16, 16, &[[255; 3]; 256]));
        assert_eq!(
            b,
            hex_bytes(
                "03 00 00 00 10 00 00 00 10 00 00 00 3C C3 DD 05
                 02 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00
                 FF FF 00 FF 20 00 00"
            )
        );
        let t = colpic_text(&b);
        assert_eq!(t, "0`000100000@0000?<?M1@800003000000000000003oo`3o8000");
        assert_eq!(
            colpic_frame("gimage", &t),
            format!("\r;;gimage:{t}\r;{}\r", "0".repeat(960))
        );
    }

    #[test]
    fn colpic_orders_the_palette_by_use() {
        let b = colpic_bytes(&opaque(2, 2, &[RED, BLUE, RED, RED]));
        assert_eq!(
            b,
            hex_bytes(
                "03 00 00 00 02 00 00 00 02 00 00 00 3C C3 DD 05
                 04 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00
                 00 F8 1F 00 20 21 40 00 00 00"
            )
        );
        let t = colpic_text(&b);
        assert_eq!(t, "0`00008000020000?<?M1@@000030000000000000000n1l082500000");
        assert_eq!(
            colpic_frame("gimage", &t),
            format!("\r;;gimage:{t}\r;{}\r", "0".repeat(956))
        );
    }

    #[test]
    fn colpic_ties_put_the_later_color_first_and_runs_cross_rows() {
        let b = colpic_bytes(&opaque(2, 2, &[RED, BLUE, BLUE, RED]));
        assert_eq!(
            b,
            hex_bytes(
                "03 00 00 00 02 00 00 00 02 00 00 00 3C C3 DD 05
                 04 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00
                 1F 00 00 F8 21 40 21 00 00 00"
            )
        );
        assert_eq!(
            colpic_text(&b),
            "0`00008000020000?<?M1@@00003000000000000000O003h8D0Q0000"
        );
    }

    #[test]
    fn colpic_runs_select_pages_and_cap_at_255() {
        let mut idx = vec![37u16; 3];
        idx.extend([2u16; 10]);
        assert_eq!(colpic_runs(&idx), [0xE1, 0x65, 0xE0, 0x02, 0x0A]);
        assert_eq!(colpic_runs(&[0; 600]), [0x00, 0xFF, 0x00, 0xFF, 0x00, 0x5A]);
        assert_eq!(colpic_runs(&[0; 7]), [0x00, 0x07]);
        assert_eq!(colpic_runs(&[0; 6]), [0xC0]);
        assert_eq!(colpic_runs(&[0; 510]), [0x00, 0xFF, 0x00, 0xFF]);
    }

    #[test]
    fn colpic_text_writes_a_tilde_for_44() {
        // 0xB0 0xB0 0xB0 is 101100 001011 000010 110000: 44, 11, 2, 48.
        assert_eq!(colpic_text(&[0xB0, 0xB0, 0xB0]), "~;2`");
    }

    /// Text of length `n` from the whole alphabet, so chunk edges show.
    #[allow(clippy::cast_possible_truncation, reason = "below 64")]
    fn sample_text(n: usize) -> String {
        (0..n).map(|i| char::from(48 + (i % 64) as u8)).collect()
    }

    #[test]
    fn colpic_framing_follows_the_line_table() {
        let z = |n: usize| "0".repeat(n);
        let t = sample_text(56);
        assert_eq!(
            colpic_frame("gimage", &t),
            format!("\r;;gimage:{t}\r;{}\r", z(956))
        );
        let t = sample_text(1004);
        assert_eq!(colpic_frame("gimage", &t), format!("\r;;gimage:{t}\r;{}\r", z(8)));
        let t = sample_text(1008);
        assert_eq!(colpic_frame("gimage", &t), format!(";gimage:{t}\r;{}\r", z(1019)));
        let t = sample_text(2030);
        assert_eq!(
            colpic_frame("gimage", &t),
            format!(";gimage:{}\r;gimage:{}\r;{}\r", &t[..1015], &t[1015..], z(1012))
        );
        let t = sample_text(3000);
        let framed = colpic_frame("gimage", &t);
        assert_eq!(
            framed,
            format!(
                ";gimage:{}\r;gimage:{}\r;;gimage:{}\r;{}\r",
                &t[..1015],
                &t[1015..2030],
                &t[2030..],
                z(42)
            )
        );
        assert!(framed.split('\r').all(|l| l.len() <= 1024));
        assert_eq!(t.len() - 2030, 970);
        assert!(colpic_frame("simage", &sample_text(56)).starts_with("\r;;simage:"));
    }

    /// A COLPIC reader written from the format: framed lines to text, text to bytes, then the header,
    /// palette and runs. Returns the width, the height, the palette and every pixel as `RGB565`.
    #[allow(clippy::cast_possible_truncation, reason = "bytes of a 24-bit group")]
    fn read_colpic(framed: &str, tag: &str) -> (u32, u32, Vec<u16>, Vec<u16>) {
        let (one, two) = (format!(";{tag}:"), format!(";;{tag}:"));
        let mut text = String::new();
        let mut zeros = 0;
        for line in framed.split('\r') {
            assert!(line.len() <= 1024, "line of {}", line.len());
            if let Some(t) = line.strip_prefix(&two).or_else(|| line.strip_prefix(&one)) {
                text.push_str(t);
            } else if let Some(z) = line.strip_prefix(';') {
                assert!(z.bytes().all(|b| b == b'0'));
                zeros += 1;
            } else {
                assert!(line.is_empty(), "{line:.40}");
            }
        }
        assert_eq!(zeros, 1);
        let vals: Vec<u32> = text
            .bytes()
            .map(|c| if c == b'~' { 44 } else { u32::from(c - 48) })
            .collect();
        assert!(vals.iter().all(|&v| v < 64));
        assert!(!text.contains('\\'));
        assert_eq!(vals.len() % 4, 0);
        let mut bytes = Vec::new();
        for q in vals.chunks(4) {
            let n = (q[0] << 18) | (q[1] << 12) | (q[2] << 6) | q[3];
            bytes.extend([(n >> 16) as u8, (n >> 8) as u8, n as u8]);
        }
        let le = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        assert_eq!(&bytes[..4], &[3, 0, 0, 0]);
        assert_eq!(&bytes[12..16], &[0x3C, 0xC3, 0xDD, 0x05]);
        assert!(bytes[24..32].iter().all(|&b| b == 0));
        let (w, h, pal, run) = (le(4), le(8), le(16) as usize, le(20) as usize);
        let palette: Vec<u16> = bytes[32..32 + pal]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let end = 32 + pal + run;
        assert!((1..=3).contains(&(bytes.len() - end)));
        assert!(bytes[end..].iter().all(|&b| b == 0));
        let runs = &bytes[32 + pal..end];
        let (mut px, mut page, mut i) = (Vec::new(), 0usize, 0);
        while i < runs.len() {
            let b = runs[i];
            i += 1;
            if b >> 5 == 7 {
                page = usize::from(b & 31);
                continue;
            }
            let color = palette[page * 32 + usize::from(b & 31)];
            let n = if b >> 5 == 0 {
                i += 1;
                assert!(runs[i - 1] >= 7);
                runs[i - 1]
            } else {
                b >> 5
            };
            px.extend(std::iter::repeat_n(color, usize::from(n)));
        }
        assert_eq!(px.len(), w as usize * h as usize);
        (w, h, palette, px)
    }

    #[test]
    #[allow(clippy::cast_possible_truncation, reason = "small test values")]
    fn colpic_quantizes_a_busy_render_and_reads_back() {
        let mut px = Vec::new();
        for y in 0..200u32 {
            for x in 0..200u32 {
                px.push([
                    (x * 255 / 199) as u8,
                    (y * 255 / 199) as u8,
                    ((x + y) * 3 % 256) as u8,
                ]);
            }
        }
        let img = opaque(200, 200, &px);
        let want: Vec<u16> = px.iter().map(|p| rgb565(p[0], p[1], p[2])).collect();
        let distinct: std::collections::BTreeSet<u16> = want.iter().copied().collect();
        assert!(distinct.len() > 1024, "{}", distinct.len());
        let spec = Spec {
            width: 200,
            height: 200,
            format: Format::Colpic([0, 0, 0]),
        };
        let framed = colpic_blocks(&[spec], &img);
        assert_eq!(framed, colpic_blocks(&[spec], &img));
        let (w, h, palette, got) = read_colpic(&framed, "gimage");
        assert_eq!((w, h), (200, 200));
        assert!(palette.len() <= 1024 && palette.len() > 512, "{}", palette.len());
        let unique: std::collections::BTreeSet<u16> = palette.iter().copied().collect();
        assert_eq!(unique.len(), palette.len());
        // Most used first; among equal counts, the color seen later first.
        let count = |c: u16| got.iter().filter(|&&p| p == c).count();
        let first = |c: u16| got.iter().position(|&p| p == c).unwrap();
        for pair in palette.windows(2) {
            let (a, b) = (count(pair[0]), count(pair[1]));
            assert!(a > b || (a == b && first(pair[0]) > first(pair[1])));
        }
        // Each pixel keeps a color near its own, and one color always reads back as the same one.
        let parts = |c: u16| [i32::from(c >> 11), i32::from((c >> 5) & 63), i32::from(c & 31)];
        let mut seen = std::collections::BTreeMap::new();
        let (mut worst, mut total) = (0, 0);
        for (&a, &b) in want.iter().zip(&got) {
            assert_eq!(*seen.entry(a).or_insert(b), b);
            let d = parts(a)
                .iter()
                .zip(parts(b))
                .map(|(x, y)| (x - y).abs())
                .max()
                .unwrap();
            worst = worst.max(d);
            total += d;
        }
        assert!(worst <= 8, "{worst}");
        assert!(total < 2 * 40_000, "{total}");
    }

    #[test]
    fn colpic_blocks_go_large_then_small_on_the_background() {
        // A transparent image: every pixel takes the background.
        let clear = solid(8, 8, [200, 10, 10, 0]);
        let spec = |side: u32| Spec {
            width: side,
            height: side,
            format: Format::Colpic([0x30, 0x39, 0x4F]),
        };
        let s = colpic_blocks(&[spec(16), spec(64)], &clear);
        let (gi, si) = (s.find(";gimage:").unwrap(), s.find(";simage:").unwrap());
        assert!(gi < si);
        let cut = s[..si].trim_end_matches(';').trim_end_matches('\r').len();
        let (w, _, palette, _) = read_colpic(&s[..cut], "gimage");
        assert_eq!(
            (w, palette.as_slice()),
            (64, [rgb565(0x30, 0x39, 0x4F)].as_slice())
        );
        let (w, _, _, _) = read_colpic(&s[cut..], "simage");
        assert_eq!(w, 16);
        // Other formats leave COLPIC out of their blocks.
        assert_eq!(comment_blocks(&[spec(16)], &clear), "");
    }

    #[test]
    fn colpic_specs_take_a_background_and_stay_square() {
        let list = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let (ok, skipped) = parse_specs(
            &list(&[
                "320x320/COLPIC/#30394F",
                "160x160/colpic",
                "320x200/COLPIC",
                "100x100/COLPIC/#zz0000",
                "48x48/PNG/#30394F",
            ]),
            "PNG",
        );
        assert_eq!(
            ok,
            [
                Spec {
                    width: 320,
                    height: 320,
                    format: Format::Colpic([0x30, 0x39, 0x4F]),
                },
                Spec {
                    width: 160,
                    height: 160,
                    format: Format::Colpic(COLPIC_BACKGROUND),
                },
            ]
        );
        assert_eq!(
            skipped,
            ["320x200/COLPIC", "100x100/COLPIC/#zz0000", "48x48/PNG/#30394F"]
        );
        // Two tags, two images: a third COLPIC entry is left out, the smallest one.
        let (ok, skipped) = parse_specs(&list(&["96x96", "200x200", "160x160"]), "COLPIC");
        assert_eq!(ok.iter().map(|s| s.width).collect::<Vec<_>>(), [200, 160]);
        assert_eq!(skipped, ["96x96"]);
    }

    #[test]
    fn the_renderer_draws_something_inside_the_canvas() {
        use crate::geom::Point;
        use crate::output::{LayerPaths, PathInfo};
        let pts: Vec<Point> = [
            (100.0, 100.0),
            (120.0, 100.0),
            (120.0, 120.0),
            (100.0, 120.0),
            (100.0, 100.0),
        ]
        .iter()
        .map(|&(x, y)| Point::from_mm(x, y))
        .collect();
        let out = SliceOutput {
            layers: vec![LayerPaths {
                z: 0.2,
                height: 0.2,
                points: pts,
                paths: vec![PathInfo {
                    tower_wipe: false,
                    tower_hop: false,
                    slow_span: false,
                    start: 0,
                    end: 5,
                    tool: 1,
                    feature: Feature::OuterWall,
                    speed_mm_s: 50.0,
                    width_mm: 0.42,
                    flow: 1.0,
                    dz: 0.0,
                    overhang_fan: false,
                    owner: crate::preview::OBJECT_NONE,
                }],
                ..LayerPaths::default()
            }],
            ..SliceOutput::default()
        };
        let mut r = Renderer::new([100.0, 100.0, 120.0, 120.0], 5.0, 64, [255, 128, 0]);
        r.add(&out);
        let t = r.finish();
        assert_eq!((t.width, t.height), (64, 64));
        let drawn = t.rgba.as_chunks::<4>().0.iter().filter(|p| p[3] > 0).count();
        assert!(drawn > 100 && drawn < 64 * 64 / 2, "{drawn}");
        assert_eq!(t.px(0, 0)[3], 0);
    }

    /// Every segment in drawing order, each painting over what is there: what `add` is meant to give.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "clamped to the canvas"
    )]
    fn paint_in_order(r: &mut Renderer, out: &SliceOutput) {
        for l in &out.layers {
            let z = f64::from(l.z);
            let depth = 0.45 + 0.55 * (z / r.top).clamp(0.0, 1.0);
            for p in &l.paths {
                let shade = match p.feature {
                    Feature::OuterWall | Feature::OverhangWall => 1.0,
                    Feature::TopSurface => 1.05,
                    Feature::Support | Feature::SupportInterface => 0.6,
                    Feature::Brim | Feature::Skirt => 0.5,
                    _ => 0.86,
                };
                let f = (depth * shade).clamp(0.0, 1.0);
                let col = r
                    .color
                    .map(|c| (f64::from(c) * f).round().clamp(0.0, 255.0) as u8);
                let half = (f64::from(p.width_mm) * r.scale / 2.0).max(0.8);
                let pts: Vec<[f64; 2]> = l
                    .path_points(p)
                    .iter()
                    .map(|q| r.to_px(q.x_mm(), q.y_mm(), z))
                    .collect();
                for w in pts.windows(2) {
                    let (a, b) = (w[0], w[1]);
                    let size = f64::from(r.size);
                    let (x0, x1) = (
                        (a[0].min(b[0]) - half).floor().max(0.0),
                        (a[0].max(b[0]) + half).ceil().min(size - 1.0),
                    );
                    let (y0, y1) = (
                        (a[1].min(b[1]) - half).floor().max(0.0),
                        (a[1].max(b[1]) + half).ceil().min(size - 1.0),
                    );
                    if x0 > x1 || y0 > y1 {
                        continue;
                    }
                    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                    let len2 = dx * dx + dy * dy;
                    for py in y0 as u32..=y1 as u32 {
                        for px in x0 as u32..=x1 as u32 {
                            let (cx, cy) = (f64::from(px) + 0.5, f64::from(py) + 0.5);
                            let t = if len2 == 0.0 {
                                0.0
                            } else {
                                (((cx - a[0]) * dx + (cy - a[1]) * dy) / len2).clamp(0.0, 1.0)
                            };
                            let d2 = (cx - (a[0] + t * dx)).m_powi(2) + (cy - (a[1] + t * dy)).m_powi(2);
                            if d2 <= half * half {
                                let i = (py as usize * r.size as usize + px as usize) * 4;
                                r.buf[i..i + 4].copy_from_slice(&[col[0], col[1], col[2], 255]);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "small test values"
    )]
    fn painting_last_segment_first_gives_the_image_of_painting_in_order() {
        use crate::geom::Point;
        use crate::output::{LayerPaths, PathInfo};
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut unit = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let features = [
            Feature::OuterWall,
            Feature::InnerWall,
            Feature::SparseInfill,
            Feature::TopSurface,
            Feature::Support,
        ];
        // Two calls (two shards) of overlapping layers: loops, zigzags and single points.
        let outs: Vec<SliceOutput> = (0..2)
            .map(|s| SliceOutput {
                layers: (0..6)
                    .map(|k| {
                        let mut points = Vec::new();
                        let mut paths = Vec::new();
                        for j in 0..9 {
                            let start = points.len();
                            let n = 1 + (unit() * 14.0) as usize;
                            let (cx, cy) = (110.0 + unit() * 20.0, 110.0 + unit() * 20.0);
                            for _ in 0..n {
                                points
                                    .push(Point::from_mm(cx + unit() * 12.0 - 6.0, cy + unit() * 12.0 - 6.0));
                            }
                            paths.push(PathInfo {
                                tower_wipe: false,
                                tower_hop: false,
                                slow_span: false,
                                start: start as u32,
                                end: points.len() as u32,
                                tool: 1,
                                feature: features[j % features.len()],
                                speed_mm_s: 50.0,
                                width_mm: 0.3 + unit() as f32 * 0.4,
                                flow: 1.0,
                                dz: 0.0,
                                overhang_fan: false,
                                owner: crate::preview::OBJECT_NONE,
                            });
                        }
                        LayerPaths {
                            z: 0.2 * (s * 6 + k + 1) as f32,
                            height: 0.2,
                            points,
                            paths,
                            ..LayerPaths::default()
                        }
                    })
                    .collect(),
                ..SliceOutput::default()
            })
            .collect();
        for size in [16, 37, 64] {
            let mut fast = Renderer::new([100.0, 100.0, 140.0, 140.0], 2.4, size, [200, 120, 40]);
            let mut plain = Renderer::new([100.0, 100.0, 140.0, 140.0], 2.4, size, [200, 120, 40]);
            for out in &outs {
                fast.add(out);
                paint_in_order(&mut plain, out);
            }
            assert!(fast.buf == plain.buf, "size {size}");
            assert!(plain.buf.iter().any(|&v| v > 0));
        }
    }
}
