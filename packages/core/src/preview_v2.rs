// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! SXPV v2: the v1 preview (`preview.rs`) in about a fifth of the bytes, written layer by layer so a reader can draw
//! the first layers before the rest arrives. It expands back into the exact v1 bytes, so every reader keeps working
//! on the v1 layout. The format is in `docs/architecture.md` ("SXPV v2"); `packages/contracts/src/preview.ts` has the
//! TypeScript reader.
//!
//! Each layer's segments are cut into runs: consecutive segments that join end to start and share every field but
//! their end point (width, height, feature, tool, speed, flow, z, fan, temperature, object, no flags after the
//! first). A run stores its fields once and each end point as a zigzag varint delta on the engine's 0.1 micrometer
//! grid. A position that would not come back as the same f32 is stored raw, so the round trip is exact.

use crate::error::{Error, Result};
use crate::preview::{
    EXTRA_BYTES, HEADER_BYTES, MAGIC, OBJECT_BYTES, PreviewInfo, SEGMENT_BYTES, TRAVEL_BYTES, read_info,
};

pub const VERSION: u16 = 2;
/// The flags a v2 buffer may carry: the v1 blocks it expands into.
const KNOWN_FLAGS: u16 = crate::preview::FLAG_TRAVELS
    | crate::preview::FLAG_EXTRAS
    | crate::preview::FLAG_OBJECTS
    | crate::preview::FLAG_LAYER_LINES;

/// Positions are integers of this many per millimeter (the engine's own grid, `geom::SCALE`).
const GRID: f64 = 10_000.0;

/// The streams of one layer block, in the order their lengths and bytes are written.
const RUNS: usize = 0;
const CTRL: usize = 1;
const ATTR: usize = 2;
const ZS: usize = 3;
const START: usize = 4;
const VERT: usize = 5;
const RAW: usize = 6;
const FAN: usize = 7;
const TEMP: usize = 8;
const FLAGS: usize = 9;
const LINE: usize = 10;
const LINES: usize = 11;
const OBJ: usize = 12;
const TRAV: usize = 13;
const TRAV_RAW: usize = 14;
const TRAV_FLAGS: usize = 15;
const DICT: usize = 16;
const STREAMS: usize = 17;

/// Run control bits.
const CONTINUES: u8 = 1;
const RAW_POSITIONS: u8 = 2;
const LISTED_LINES: u8 = 4;

/// The bytes of a segment record a run shares: width, height, feature, tool, speed and flow.
const ATTR_BYTES: usize = 12;

fn bad(reason: &str) -> Error {
    Error::mesh("preview", format!("bad SXPV v2 buffer: {reason}"))
}

/// The version field of an SXPV buffer, or `None` when it is not one.
pub fn version(b: &[u8]) -> Option<u16> {
    let magic = u32::from_le_bytes(b.get(0..4)?.try_into().ok()?);
    (magic == MAGIC).then_some(u16::from_le_bytes(b.get(4..6)?.try_into().ok()?))
}

// ---- writing

fn uv(b: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        #[allow(clippy::cast_possible_truncation, reason = "the low seven bits")]
        b.push((v as u8) | 0x80);
        v >>= 7;
    }
    #[allow(clippy::cast_possible_truncation, reason = "below 0x80")]
    b.push(v as u8);
}

fn sv(b: &mut Vec<u8>, v: i64) {
    #[allow(clippy::cast_sign_loss, reason = "zigzag")]
    uv(b, ((v << 1) ^ (v >> 63)) as u64);
}

/// A coordinate on the grid, rounded half up as the TypeScript reader rounds (`Math.floor(x * GRID + 0.5)`).
#[allow(
    clippy::cast_possible_truncation,
    reason = "preview coordinates are far inside i64"
)]
fn grid(x: f32) -> i64 {
    (f64::from(x) * GRID + 0.5).floor() as i64
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a grid value back to its f32"
)]
fn mm(q: i64) -> f32 {
    (q as f64 / GRID) as f32
}

/// The grid value of `x` when it comes back as the same f32.
fn exact(x: f32) -> Option<i64> {
    let q = grid(x);
    (mm(q).to_bits() == x.to_bits()).then_some(q)
}

fn f32_at(b: &[u8], at: usize) -> f32 {
    b.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map_or(0.0, f32::from_le_bytes)
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    b.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map_or(0, u32::from_le_bytes)
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    b.get(at..at + 2)
        .and_then(|s| s.try_into().ok())
        .map_or(0, u16::from_le_bytes)
}

/// A v1 buffer and where its blocks are.
struct V1<'a> {
    b: &'a [u8],
    i: PreviewInfo,
}

impl V1<'_> {
    fn seg(&self, k: usize) -> &[u8] {
        let at = self.i.segments_at + k * SEGMENT_BYTES;
        self.b.get(at..at + SEGMENT_BYTES).unwrap_or(&[0; SEGMENT_BYTES])
    }
    /// Fan, flags, temperature and line of segment `k` (zero without extras).
    fn extra(&self, k: usize) -> (u8, u8, u16, u32) {
        self.i.extras_at.map_or((0, 0, 0, 0), |e| {
            let at = e + k * EXTRA_BYTES;
            let get = |o: usize| self.b.get(at + o).copied().unwrap_or(0);
            (get(0), get(1), u16_at(self.b, at + 2), u32_at(self.b, at + 4))
        })
    }
    fn object(&self, k: usize) -> u16 {
        self.i
            .objects_at
            .map_or(0, |o| u16_at(self.b, o + k * OBJECT_BYTES))
    }
    fn layer_start(&self, k: usize) -> usize {
        u32_at(self.b, self.i.layer_start + k * 4) as usize
    }
    fn travel_start(&self, k: usize) -> usize {
        if self.i.has_travels {
            u32_at(self.b, self.i.travel_start + k * 4) as usize
        } else {
            0
        }
    }
}

/// Encodes a v1 buffer as v2. A v2 buffer comes back as it is.
pub fn encode(v1: &[u8]) -> Result<Vec<u8>> {
    if version(v1) == Some(VERSION) {
        return Ok(v1.to_vec());
    }
    let i = read_info(v1)?;
    check_tables(v1, &i)?;
    let v = V1 { b: v1, i };
    let n = u32::try_from(i.layers).map_err(|_| bad("too many layers"))?;
    let blocks = crate::par::map_range(0..n, |k| layer_block(&v, k as usize));
    let mut o =
        Vec::with_capacity(i.segments_at + (i.layers + 1) * 4 + blocks.iter().map(Vec::len).sum::<usize>());
    o.extend_from_slice(v1.get(..i.segments_at).ok_or_else(|| bad("truncated tables"))?);
    if let Some(d) = o.get_mut(4..6) {
        d.copy_from_slice(&VERSION.to_le_bytes());
    }
    let mut at = 0u32;
    for b in &blocks {
        o.extend_from_slice(&at.to_le_bytes());
        at = at
            .checked_add(u32::try_from(b.len()).map_err(|_| bad("layer too large"))?)
            .ok_or_else(|| bad("preview too large"))?;
    }
    o.extend_from_slice(&at.to_le_bytes());
    for b in blocks {
        o.extend_from_slice(&b);
    }
    Ok(o)
}

fn layer_block(v: &V1, k: usize) -> Vec<u8> {
    let mut s: [Vec<u8>; STREAMS] = Default::default();
    let mut dict: Vec<[u8; ATTR_BYTES]> = Vec::new();
    let (first, end) = (v.layer_start(k), v.layer_start(k + 1));
    let mut cur = (0i64, 0i64);
    let mut z_bits = i64::from(f32_at(v.b, v.i.layer_z + k * 4).to_bits());
    let (mut temp_prev, mut obj_prev, mut line_next) = (0i64, 0i64, 0i64);
    let mut i = first;
    while i < end {
        let s0 = v.seg(i);
        let attrs: [u8; ATTR_BYTES] = s0.get(20..32).and_then(|a| a.try_into().ok()).unwrap_or_default();
        let z = f32_at(s0, 16).to_bits();
        let (fan, flags, temp, line) = v.extra(i);
        let obj = v.object(i);
        let mut j = i + 1;
        while j < end {
            let (s1, p) = (v.seg(j), v.seg(j - 1));
            let (f1, fl1, t1, _) = v.extra(j);
            if s1.get(20..32) != Some(&attrs[..])
                || f32_at(s1, 16).to_bits() != z
                || s1.get(0..8) != p.get(8..16)
                || (f1, fl1, t1) != (fan, 0, temp)
                || v.object(j) != obj
            {
                break;
            }
            j += 1;
        }
        let n = j - i;
        uv(&mut s[RUNS], n as u64);
        let id = dict.iter().position(|d| *d == attrs).unwrap_or_else(|| {
            dict.push(attrs);
            s[DICT].extend_from_slice(&attrs);
            dict.len() - 1
        });
        uv(&mut s[ATTR], id as u64);
        sv(&mut s[ZS], i64::from(z) - z_bits);
        z_bits = i64::from(z);
        let start = (exact(f32_at(s0, 0)), exact(f32_at(s0, 4)));
        let ends: Vec<(Option<i64>, Option<i64>)> = (i..j)
            .map(|t| (exact(f32_at(v.seg(t), 8)), exact(f32_at(v.seg(t), 12))))
            .collect();
        let mut ctrl = 0u8;
        match start {
            (Some(x), Some(y)) if ends.iter().all(|e| e.0.is_some() && e.1.is_some()) => {
                if (x, y) == cur {
                    ctrl |= CONTINUES;
                } else {
                    sv(&mut s[START], x - cur.0);
                    sv(&mut s[START], y - cur.1);
                }
                cur = (x, y);
                for (ex, ey) in ends.iter().filter_map(|e| Some((e.0?, e.1?))) {
                    sv(&mut s[VERT], ex - cur.0);
                    sv(&mut s[VERT], ey - cur.1);
                    cur = (ex, ey);
                }
            }
            _ => {
                ctrl |= RAW_POSITIONS;
                s[RAW].extend_from_slice(s0.get(0..8).unwrap_or(&[0; 8]));
                for t in i..j {
                    s[RAW].extend_from_slice(v.seg(t).get(8..16).unwrap_or(&[0; 8]));
                }
                let last = v.seg(j - 1);
                cur = (grid(f32_at(last, 8)), grid(f32_at(last, 12)));
            }
        }
        if v.i.extras_at.is_some() {
            let listed = (i + 1..j).any(|t| v.extra(t).3 != v.extra(t - 1).3.wrapping_add(1));
            if listed {
                ctrl |= LISTED_LINES;
            }
            s[FAN].push(fan);
            s[FLAGS].push(flags);
            sv(&mut s[TEMP], i64::from(temp) - temp_prev);
            temp_prev = i64::from(temp);
            sv(&mut s[LINE], i64::from(line) - line_next);
            let mut last = i64::from(line);
            for t in i + 1..j {
                let l = if listed { i64::from(v.extra(t).3) } else { last + 1 };
                if listed {
                    sv(&mut s[LINES], l - (last + 1));
                }
                last = l;
            }
            line_next = last + 1;
        }
        if v.i.objects_at.is_some() {
            sv(&mut s[OBJ], i64::from(obj) - obj_prev);
            obj_prev = i64::from(obj);
        }
        s[CTRL].push(ctrl);
        i = j;
    }
    if v.i.has_travels {
        let (ta, tz) = (v.travel_start(k), v.travel_start(k + 1));
        let mut tc = (0i64, 0i64);
        let (mut raw, mut raw_count, mut raw_prev) = (Vec::new(), 0u64, ta);
        for t in ta..tz {
            let at = v.i.travels_at + t * TRAVEL_BYTES;
            let r = v.b.get(at..at + TRAVEL_BYTES).unwrap_or(&[0; TRAVEL_BYTES]);
            let q = [0, 4, 8, 12].map(|o| exact(f32_at(r, o)));
            if let [Some(x0), Some(y0), Some(x1), Some(y1)] = q {
                sv(&mut s[TRAV], x0 - tc.0);
                sv(&mut s[TRAV], y0 - tc.1);
                sv(&mut s[TRAV], x1 - x0);
                sv(&mut s[TRAV], y1 - y0);
                tc = (x1, y1);
            } else {
                uv(&mut raw, (t - raw_prev) as u64);
                raw.extend_from_slice(r);
                raw_prev = t;
                raw_count += 1;
            }
            if let Some(e) = v.i.extras_at {
                s[TRAV_FLAGS].push(v.b.get(e + v.i.segments * EXTRA_BYTES + t).copied().unwrap_or(0));
            }
        }
        uv(&mut s[TRAV_RAW], raw_count);
        s[TRAV_RAW].extend_from_slice(&raw);
    }
    let mut o = Vec::with_capacity(s.iter().map(Vec::len).sum::<usize>() + STREAMS * 3);
    for x in &s {
        uv(&mut o, x.len() as u64);
    }
    for x in s {
        o.extend_from_slice(&x);
    }
    o
}

// ---- reading

/// One stream of a layer block.
struct Rd<'a> {
    b: &'a [u8],
    p: usize,
}

impl Rd<'_> {
    fn u(&mut self) -> Result<u64> {
        let mut v = 0u64;
        // At most 8 bytes, as the TypeScript reader reads them.
        for shift in (0..56).step_by(7) {
            let x = *self.b.get(self.p).ok_or_else(|| bad("a stream ends early"))?;
            self.p += 1;
            v |= u64::from(x & 0x7f) << shift;
            if x < 0x80 {
                // The TypeScript reader works in doubles: keep every value exact there.
                return if v < (1 << 53) {
                    Ok(v)
                } else {
                    Err(bad("a varint is too large"))
                };
            }
        }
        Err(bad("a varint is too long"))
    }
    fn s(&mut self) -> Result<i64> {
        let v = self.u()?;
        #[allow(clippy::cast_possible_wrap, reason = "below 2^53")]
        let h = (v >> 1) as i64;
        Ok(if v & 1 == 1 { -h - 1 } else { h })
    }
    fn byte(&mut self) -> Result<u8> {
        let x = *self.b.get(self.p).ok_or_else(|| bad("a stream ends early"))?;
        self.p += 1;
        Ok(x)
    }
    fn take(&mut self, n: usize) -> Result<&[u8]> {
        let r = self
            .b
            .get(self.p..self.p + n)
            .ok_or_else(|| bad("a stream ends early"))?;
        self.p += n;
        Ok(r)
    }
    fn done(&self) -> bool {
        self.p == self.b.len()
    }
}

/// The layer and travel tables of a v1 or v2 buffer: each starts at 0, never goes down and ends at its count.
fn check_tables(b: &[u8], i: &PreviewInfo) -> Result<()> {
    let table = |at: usize, total: usize| -> Result<()> {
        let mut prev = 0u32;
        for k in 0..=i.layers {
            let v = u32_at(b, at + k * 4);
            if (k == 0 && v != 0) || v < prev || (k == i.layers && v as usize != total) {
                return Err(bad("a layer table is out of order"));
            }
            prev = v;
        }
        Ok(())
    };
    table(i.layer_start, i.segments)?;
    if i.has_travels {
        table(i.travel_start, i.travels)?;
    }
    Ok(())
}

/// Expands a v2 buffer into the v1 buffer it was written from, byte for byte. Refuses a buffer that is not
/// v2 or is damaged anywhere, never panics.
pub fn decode(b: &[u8]) -> Result<Vec<u8>> {
    if version(b) != Some(VERSION) {
        return Err(bad("not an SXPV v2 buffer"));
    }
    let flags = u16_at(b, 6);
    if flags & !KNOWN_FLAGS != 0 {
        return Err(bad("unknown flags"));
    }
    if b.len() < HEADER_BYTES {
        return Err(bad("truncated header"));
    }
    let count = |at: usize| u32_at(b, at) as usize;
    let (segs, layers, travels) = (count(8), count(12), count(16));
    let has_travels = flags & crate::preview::FLAG_TRAVELS != 0;
    let has_extras = has_travels && flags & crate::preview::FLAG_EXTRAS != 0;
    let has_objects = flags & crate::preview::FLAG_OBJECTS != 0;
    let tables = layers
        .checked_add(1)
        .and_then(|l1| l1.checked_mul(4 + if has_travels { 4 } else { 0 }))
        .and_then(|t| t.checked_add(layers.checked_mul(8)?))
        .and_then(|t| t.checked_add(HEADER_BYTES))
        .ok_or_else(|| bad("counts too large"))?;
    let index_at = tables;
    let blocks_at = (layers + 1)
        .checked_mul(4)
        .and_then(|x| x.checked_add(index_at))
        .ok_or_else(|| bad("counts too large"))?;
    if blocks_at > b.len() {
        return Err(bad("truncated tables"));
    }
    // Every segment and travel takes at least a byte in its block, so counts past the length are damage.
    if segs > b.len() || travels > b.len() {
        return Err(bad("counts past the buffer"));
    }
    let mut size = tables + segs * SEGMENT_BYTES + if has_travels { travels * TRAVEL_BYTES } else { 0 };
    let extras_at = has_extras.then_some(size);
    if has_extras {
        size = (size + segs * EXTRA_BYTES + travels).next_multiple_of(4);
    }
    let objects_at = has_objects.then_some(size);
    if has_objects {
        size = (size + segs * OBJECT_BYTES).next_multiple_of(4);
    }
    let mut out = vec![0u8; size];
    out.get_mut(..tables)
        .ok_or_else(|| bad("truncated tables"))?
        .copy_from_slice(b.get(..tables).ok_or_else(|| bad("truncated tables"))?);
    if let Some(d) = out.get_mut(4..6) {
        d.copy_from_slice(&crate::preview::VERSION.to_le_bytes());
    }
    let info = read_info(&out)?;
    check_tables(&out, &info)?;
    let blocks = b.get(blocks_at..).unwrap_or(&[]);
    for k in 0..=layers {
        let at = u32_at(b, index_at + k * 4) as usize;
        let prev = if k == 0 {
            0
        } else {
            u32_at(b, index_at + (k - 1) * 4) as usize
        };
        if (k == 0 && at != 0) || at < prev || (k == layers && at != blocks.len()) {
            return Err(bad("the layer index is out of order"));
        }
    }
    let mut w = Out {
        o: &mut out,
        i: info,
        extras_at,
        objects_at,
    };
    for k in 0..layers {
        let (a, z) = (
            u32_at(b, index_at + k * 4) as usize,
            u32_at(b, index_at + (k + 1) * 4) as usize,
        );
        decode_layer(
            &mut w,
            blocks
                .get(a..z)
                .ok_or_else(|| bad("a layer block is out of range"))?,
            k,
        )?;
    }
    Ok(out)
}

/// The v1 buffer being filled.
struct Out<'a> {
    o: &'a mut Vec<u8>,
    i: PreviewInfo,
    extras_at: Option<usize>,
    objects_at: Option<usize>,
}

impl Out<'_> {
    fn put(&mut self, at: usize, bytes: &[u8]) -> Result<()> {
        self.o
            .get_mut(at..at + bytes.len())
            .ok_or_else(|| bad("a record is out of range"))?
            .copy_from_slice(bytes);
        Ok(())
    }
}

fn streams(block: &[u8]) -> Result<Vec<Rd<'_>>> {
    let mut head = Rd { b: block, p: 0 };
    let mut lens = [0usize; STREAMS];
    for l in &mut lens {
        *l = usize::try_from(head.u()?).map_err(|_| bad("a stream is too long"))?;
    }
    let mut at = head.p;
    let mut out = Vec::with_capacity(STREAMS);
    for l in lens {
        let end = at.checked_add(l).ok_or_else(|| bad("a stream is too long"))?;
        out.push(Rd {
            b: block
                .get(at..end)
                .ok_or_else(|| bad("a stream runs past its layer"))?,
            p: 0,
        });
        at = end;
    }
    if at != block.len() {
        return Err(bad("a layer block has bytes after its streams"));
    }
    Ok(out)
}

#[allow(clippy::too_many_lines, reason = "one layer's streams, read in step")]
fn decode_layer(w: &mut Out, block: &[u8], k: usize) -> Result<()> {
    let mut s = streams(block)?;
    let dict: Vec<[u8; ATTR_BYTES]> = {
        let (entries, rest) = s.get(DICT).map_or(&[][..], |r| r.b).as_chunks::<ATTR_BYTES>();
        if !rest.is_empty() {
            return Err(bad("a dictionary entry is cut off"));
        }
        entries.to_vec()
    };
    let info = w.i;
    let first = u32_at(w.o, info.layer_start + k * 4) as usize;
    let end = u32_at(w.o, info.layer_start + (k + 1) * 4) as usize;
    let mut cur = (0i64, 0i64);
    let mut z_bits = i64::from(f32_at(w.o, info.layer_z + k * 4).to_bits());
    let (mut temp, mut obj, mut line_next) = (0i64, 0i64, 0i64);
    let mut i = first;
    macro_rules! st {
        ($id:expr) => {
            s.get_mut($id).ok_or_else(|| bad("missing stream"))?
        };
    }
    while i < end {
        let n = usize::try_from(st!(RUNS).u()?).map_err(|_| bad("a run is too long"))?;
        if n == 0 || n > end - i {
            return Err(bad("a run does not fit its layer"));
        }
        let ctrl = st!(CTRL).byte()?;
        if ctrl & !(CONTINUES | RAW_POSITIONS | LISTED_LINES) != 0 {
            return Err(bad("unknown run bits"));
        }
        let id = usize::try_from(st!(ATTR).u()?).map_err(|_| bad("a dictionary index is too large"))?;
        let attrs = *dict
            .get(id)
            .ok_or_else(|| bad("a dictionary index is out of range"))?;
        z_bits = z_bits
            .checked_add(st!(ZS).s()?)
            .filter(|z| (0..=i64::from(u32::MAX)).contains(z))
            .ok_or_else(|| bad("a z is out of range"))?;
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "checked to fit u32"
        )]
        let z = (z_bits as u32).to_le_bytes();
        let mut rec = [0u8; SEGMENT_BYTES];
        if let Some(d) = rec.get_mut(16..20) {
            d.copy_from_slice(&z);
        }
        if let Some(d) = rec.get_mut(20..32) {
            d.copy_from_slice(&attrs);
        }
        if ctrl & RAW_POSITIONS != 0 {
            let raw = st!(RAW);
            let mut prev: [u8; 8] = raw.take(8)?.try_into().map_err(|_| bad("raw"))?;
            for t in i..i + n {
                let next: [u8; 8] = raw.take(8)?.try_into().map_err(|_| bad("raw"))?;
                if let Some(d) = rec.get_mut(0..8) {
                    d.copy_from_slice(&prev);
                }
                if let Some(d) = rec.get_mut(8..16) {
                    d.copy_from_slice(&next);
                }
                w.put(info.segments_at + t * SEGMENT_BYTES, &rec)?;
                prev = next;
            }
            cur = (grid(f32_at(&prev, 0)), grid(f32_at(&prev, 4)));
        } else {
            if ctrl & CONTINUES == 0 {
                let st = st!(START);
                cur = (
                    cur.0
                        .checked_add(st.s()?)
                        .ok_or_else(|| bad("a position overflows"))?,
                    cur.1
                        .checked_add(st.s()?)
                        .ok_or_else(|| bad("a position overflows"))?,
                );
            }
            let vert = st!(VERT);
            for t in i..i + n {
                let next = (
                    cur.0
                        .checked_add(vert.s()?)
                        .ok_or_else(|| bad("a position overflows"))?,
                    cur.1
                        .checked_add(vert.s()?)
                        .ok_or_else(|| bad("a position overflows"))?,
                );
                for (o, q) in [(0, cur.0), (4, cur.1), (8, next.0), (12, next.1)] {
                    if let Some(d) = rec.get_mut(o..o + 4) {
                        d.copy_from_slice(&mm(q).to_le_bytes());
                    }
                }
                w.put(info.segments_at + t * SEGMENT_BYTES, &rec)?;
                cur = next;
            }
        }
        if let Some(e) = w.extras_at {
            let fan = st!(FAN).byte()?;
            let flags = st!(FLAGS).byte()?;
            temp = temp
                .checked_add(st!(TEMP).s()?)
                .ok_or_else(|| bad("a temperature overflows"))?;
            let t16 = u16::try_from(temp).map_err(|_| bad("a temperature is out of range"))?;
            let mut line = line_next
                .checked_add(st!(LINE).s()?)
                .ok_or_else(|| bad("a line overflows"))?;
            for t in i..i + n {
                if t > i {
                    line = if ctrl & LISTED_LINES != 0 {
                        line.checked_add(1 + st!(LINES).s()?)
                            .ok_or_else(|| bad("a line overflows"))?
                    } else {
                        line + 1
                    };
                }
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "lines are u32 and wrap as written"
                )]
                let l32 = line as u32;
                let [t0, t1] = t16.to_le_bytes();
                let [l0, l1, l2, l3] = l32.to_le_bytes();
                w.put(
                    e + t * EXTRA_BYTES,
                    &[fan, if t == i { flags } else { 0 }, t0, t1, l0, l1, l2, l3],
                )?;
            }
            line_next = line + 1;
        }
        if let Some(o) = w.objects_at {
            obj = obj
                .checked_add(st!(OBJ).s()?)
                .ok_or_else(|| bad("an object overflows"))?;
            let o16 = u16::try_from(obj)
                .map_err(|_| bad("an object index is out of range"))?
                .to_le_bytes();
            for t in i..i + n {
                w.put(o + t * OBJECT_BYTES, &o16)?;
            }
        }
        i += n;
    }
    if info.has_travels {
        let ta = u32_at(w.o, info.travel_start + k * 4) as usize;
        let tz = u32_at(w.o, info.travel_start + (k + 1) * 4) as usize;
        let mut raw_left = st!(TRAV_RAW).u()?;
        if raw_left > (tz - ta) as u64 {
            return Err(bad("more raw travels than travels"));
        }
        let mut next_raw = if raw_left > 0 {
            Some(ta + gap(st!(TRAV_RAW).u()?)?)
        } else {
            None
        };
        let mut tc = (0i64, 0i64);
        for t in ta..tz {
            let at = info.travels_at + t * TRAVEL_BYTES;
            if next_raw == Some(t) {
                let rec: [u8; TRAVEL_BYTES] = st!(TRAV_RAW)
                    .take(TRAVEL_BYTES)?
                    .try_into()
                    .map_err(|_| bad("raw"))?;
                w.put(at, &rec)?;
                raw_left -= 1;
                next_raw = if raw_left > 0 {
                    let g = gap(st!(TRAV_RAW).u()?)?;
                    if g == 0 {
                        return Err(bad("raw travels out of order"));
                    }
                    Some(t + g)
                } else {
                    None
                };
            } else {
                let tr = st!(TRAV);
                let x0 =
                    tc.0.checked_add(tr.s()?)
                        .ok_or_else(|| bad("a travel overflows"))?;
                let y0 =
                    tc.1.checked_add(tr.s()?)
                        .ok_or_else(|| bad("a travel overflows"))?;
                let x1 = x0.checked_add(tr.s()?).ok_or_else(|| bad("a travel overflows"))?;
                let y1 = y0.checked_add(tr.s()?).ok_or_else(|| bad("a travel overflows"))?;
                let mut rec = [0u8; TRAVEL_BYTES];
                for (o, q) in [(0, x0), (4, y0), (8, x1), (12, y1)] {
                    if let Some(d) = rec.get_mut(o..o + 4) {
                        d.copy_from_slice(&mm(q).to_le_bytes());
                    }
                }
                w.put(at, &rec)?;
                tc = (x1, y1);
            }
            if let Some(e) = w.extras_at {
                let f = st!(TRAV_FLAGS).byte()?;
                w.put(e + info.segments * EXTRA_BYTES + t, &[f])?;
            }
        }
        if next_raw.is_some() {
            return Err(bad("a raw travel is past its layer"));
        }
    }
    // The dictionary is read by index, not in order.
    if let Some(d) = s.get_mut(DICT) {
        d.p = d.b.len();
    }
    if !s.iter().all(Rd::done) {
        return Err(bad("a layer block has unread bytes"));
    }
    Ok(())
}

fn gap(v: u64) -> Result<usize> {
    usize::try_from(v).map_err(|_| bad("a travel index is too large"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_round_trips() {
        for v in [0i64, 1, -1, 63, -64, 1 << 40, -(1 << 40)] {
            let mut b = Vec::new();
            sv(&mut b, v);
            assert_eq!(Rd { b: &b, p: 0 }.s().unwrap(), v);
        }
    }

    #[test]
    #[allow(clippy::cast_possible_truncation, reason = "grid values to their f32")]
    fn grid_values_round_trip_as_written() {
        for v in [0i32, 1, -1, 12_345, -987_654, 2_500_000] {
            let x = (f64::from(v) / GRID) as f32;
            assert_eq!(exact(x), Some(i64::from(v)));
        }
    }
}
