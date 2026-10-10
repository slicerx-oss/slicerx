// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Stage 8: SXPV preview buffers. The format is specified in
//! `packages/contracts/src/preview.ts`, which also has the reader.

use crate::error::{Error, Result};
use crate::gcode::bead_area;
use crate::geom::Point;
use crate::output::{Feature, SliceOutput};

pub const MAGIC: u32 = 0x5650_5853;
pub const VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 32;
pub const SEGMENT_BYTES: usize = 32;
pub const TRAVEL_BYTES: usize = 16;
pub const FLAG_TRAVELS: u16 = 1;
/// Per-segment extras (fan, temperature, line, retraction, lift, seam) follow the travels.
pub const FLAG_EXTRAS: u16 = 2;
pub const EXTRA_BYTES: usize = 8;
/// Per-segment object index (u16, the index in the request's objects) after the extras, padded to
/// four bytes. Written when the plate has two or more objects.
pub const FLAG_OBJECTS: u16 = 4;
/// With the extras: their G-code lines count from the segment's layer's `;LAYER_CHANGE` line
/// (`0xFFFFFFFF`: unknown), as a shard sliced on its own writes them. A stitch makes them absolute
/// with the finished file's layer lines and clears the flag.
pub const FLAG_LAYER_LINES: u16 = 8;
pub const OBJECT_BYTES: usize = 2;
/// The object index of the skirt, a brim shared by several objects, the prime tower and custom G-code.
pub const OBJECT_NONE: u16 = 0xFFFF;

#[allow(
    clippy::cast_possible_truncation,
    reason = "preview coordinates are f32 by format"
)]
fn mm(v: i32) -> f32 {
    (f64::from(v) / crate::geom::SCALE) as f32
}

/// Encodes stages 6 and 7 of `out` as one SXPV buffer, with travels.
pub fn preview_buffers(out: &SliceOutput) -> Vec<u8> {
    let n = out.layers.len();
    let segs: usize = out
        .layers
        .iter()
        .flat_map(|l| l.paths.iter())
        .map(|p| (p.end - p.start).saturating_sub(1) as usize)
        .sum();
    let travels: usize = out.layers.iter().map(|l| l.paths.len().saturating_sub(1)).sum();
    let size =
        HEADER_BYTES + (n + 1) * 4 + n * 8 + (n + 1) * 4 + segs * SEGMENT_BYTES + travels * TRAVEL_BYTES;
    // Room for the object block and the extras the G-code adds later (`with_extras`), so the buffer is never
    // moved while both copies would be held.
    let objects_size = if out.objects.len() > 1 {
        segs * OBJECT_BYTES + 3
    } else {
        0
    };
    let mut b = Vec::with_capacity(size + objects_size + segs * EXTRA_BYTES + travels + 3);
    let u32le =
        |b: &mut Vec<u8>, v: usize| b.extend_from_slice(&u32::try_from(v).unwrap_or(u32::MAX).to_le_bytes());
    b.extend_from_slice(&MAGIC.to_le_bytes());
    b.extend_from_slice(&VERSION.to_le_bytes());
    b.extend_from_slice(&FLAG_TRAVELS.to_le_bytes());
    u32le(&mut b, segs);
    u32le(&mut b, n);
    u32le(&mut b, travels);
    u32le(&mut b, usize::from(out.tool_count.max(1)));
    b.extend_from_slice(&out.layer_height.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes());
    let mut acc = 0usize;
    for l in &out.layers {
        u32le(&mut b, acc);
        acc += l
            .paths
            .iter()
            .map(|p| (p.end - p.start).saturating_sub(1) as usize)
            .sum::<usize>();
    }
    u32le(&mut b, acc);
    for l in &out.layers {
        b.extend_from_slice(&l.z.to_le_bytes());
    }
    for l in &out.layers {
        b.extend_from_slice(&l.time_s.to_le_bytes());
    }
    let mut acc = 0usize;
    for l in &out.layers {
        u32le(&mut b, acc);
        acc += l.paths.len().saturating_sub(1);
    }
    u32le(&mut b, acc);
    // Each segment's object: its path's owner (`owners.rs`), when the plate has more than one.
    let finder = (out.objects.len() > 1).then_some(());
    // Segment records are formatted per layer in parallel, each into its own place in the buffer, so the
    // records are never held twice.
    let head = b.len();
    b.resize(head + segs * SEGMENT_BYTES, 0);
    let mut objects = vec![0u8; if finder.is_some() { segs * OBJECT_BYTES } else { 0 }];
    let mut jobs = Vec::with_capacity(n);
    {
        let (mut rest, mut orest) = (b.get_mut(head..).unwrap_or_default(), objects.as_mut_slice());
        for l in &out.layers {
            let k: usize = l
                .paths
                .iter()
                .map(|p| (p.end - p.start).saturating_sub(1) as usize)
                .sum();
            let (dst, r) = rest.split_at_mut((k * SEGMENT_BYTES).min(rest.len()));
            let ok = if finder.is_some() { k * OBJECT_BYTES } else { 0 };
            let (odst, or) = orest.split_at_mut(ok.min(orest.len()));
            (rest, orest) = (r, or);
            jobs.push((l, dst, odst));
        }
    }
    crate::par::map_owned(jobs, |(l, dst, odst)| {
        let mut b = Vec::with_capacity(dst.len());
        let mut objects = Vec::with_capacity(odst.len());
        let h = f64::from(l.height);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "micrometers of a layer fit in u16"
        )]
        let h_um = (h * 1000.0).round().clamp(0.0, 65535.0) as u16;
        for p in &l.paths {
            let pts = l.path_points(p);
            if finder.is_some() {
                let k = if matches!(p.feature, Feature::Skirt | Feature::PrimeTower | Feature::Custom) {
                    OBJECT_NONE
                } else {
                    p.owner
                }
                .to_le_bytes();
                for _ in 1..pts.len() {
                    objects.extend_from_slice(&k);
                }
            }
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "format fields are u16 and f32"
            )]
            let (w_um, speed, flow) = (
                (f64::from(p.width_mm) * 1000.0).round().clamp(0.0, 65535.0) as u16,
                (f64::from(p.speed_mm_s) * 10.0).round().clamp(0.0, 65535.0) as u16,
                (bead_area(f64::from(p.width_mm), h) * f64::from(p.speed_mm_s) * f64::from(p.flow)) as f32,
            );
            for (i, w) in pts.windows(2).enumerate() {
                let [a, c] = w else { continue };
                // A spiral layer climbs: the segment sits at the height of its end.
                let z = l.zs.get(p.start as usize + i + 1).copied().unwrap_or(l.z + p.dz);
                seg(
                    &mut b,
                    *a,
                    *c,
                    z,
                    w_um,
                    h_um,
                    p.feature as u8,
                    p.tool.max(1) - 1,
                    speed,
                    flow,
                );
            }
        }
        for (d, s) in [(dst, b), (odst, objects)] {
            if let Some(d) = d.get_mut(..s.len()) {
                d.copy_from_slice(&s);
            }
        }
    });
    for l in &out.layers {
        for pair in l.paths.windows(2) {
            let [p, q] = pair else { continue };
            let from = l.path_points(p).last().copied().unwrap_or_default();
            let to = l.path_points(q).first().copied().unwrap_or_default();
            for v in [mm(from.x), mm(from.y), mm(to.x), mm(to.y)] {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    if finder.is_some() {
        set_flag(&mut b, FLAG_OBJECTS);
        b.extend_from_slice(&objects);
        pad4(&mut b);
    }
    b
}

fn set_flag(b: &mut [u8], flag: u16) {
    let flags = u16::from_le_bytes([b.get(6).copied().unwrap_or(0), b.get(7).copied().unwrap_or(0)]) | flag;
    if let Some(dst) = b.get_mut(6..8) {
        dst.copy_from_slice(&flags.to_le_bytes());
    }
}

fn pad4(b: &mut Vec<u8>) {
    while !b.len().is_multiple_of(4) {
        b.push(0);
    }
}

#[allow(clippy::too_many_arguments, reason = "one record's fields")]
fn seg(
    b: &mut Vec<u8>,
    a: Point,
    c: Point,
    z: f32,
    w: u16,
    h: u16,
    feature: u8,
    tool: u8,
    speed: u16,
    flow: f32,
) {
    for v in [mm(a.x), mm(a.y), mm(c.x), mm(c.y), z] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&w.to_le_bytes());
    b.extend_from_slice(&h.to_le_bytes());
    b.push(feature);
    b.push(tool);
    b.extend_from_slice(&speed.to_le_bytes());
    b.extend_from_slice(&flow.to_le_bytes());
}

/// Appends extras to a finished buffer: one 8-byte record per segment (fan, flags, nozzle
/// temperature, G-code line), then one flag byte per travel, padded to four bytes. A buffer whose
/// segment or travel count differs from the tables is returned as it is.
pub fn with_extras(mut b: Vec<u8>, segs: &[crate::extras::SegExtra], travels: &[u8]) -> Vec<u8> {
    let Ok(info) = read_info(&b) else { return b };
    if info.segments != segs.len()
        || info.travels != travels.len()
        || !info.has_travels
        || info.extras_at.is_some()
    {
        return b;
    }
    // The object block stays last.
    let objects = info.objects_at.map(|at| b.split_off(at));
    set_flag(&mut b, FLAG_EXTRAS);
    b.reserve(segs.len() * EXTRA_BYTES + travels.len() + 3 + objects.as_ref().map_or(0, Vec::len));
    for s in segs {
        b.push(s.fan);
        b.push(s.flags);
        b.extend_from_slice(&s.temp_c.to_le_bytes());
        b.extend_from_slice(&s.line.to_le_bytes());
    }
    b.extend_from_slice(travels);
    pad4(&mut b);
    if let Some(o) = objects {
        b.extend_from_slice(&o);
    }
    b
}

/// [`with_extras`] with the lines of each layer counted from its `;LAYER_CHANGE` line ([`FLAG_LAYER_LINES`]).
pub fn with_layer_extras(b: Vec<u8>, layers: &[(u32, crate::extras::LayerExtras)]) -> Vec<u8> {
    let (segs, travels) = crate::extras::relative(layers);
    let mut b = with_extras(b, &segs, &travels);
    if read_info(&b).is_ok_and(|i| i.extras_at.is_some()) {
        set_flag(&mut b, FLAG_LAYER_LINES);
    }
    b
}

/// Header fields and table offsets of an SXPV buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewInfo {
    pub segments: usize,
    pub layers: usize,
    pub travels: usize,
    pub tools: u32,
    pub has_travels: bool,
    pub layer_start: usize,
    pub layer_z: usize,
    pub layer_time: usize,
    pub travel_start: usize,
    pub segments_at: usize,
    pub travels_at: usize,
    /// Where the extras start, when the buffer has them.
    pub extras_at: Option<usize>,
    /// Where the per-segment object indices start, when the buffer has them.
    pub objects_at: Option<usize>,
    /// The extras' lines count from their layer's `;LAYER_CHANGE` ([`FLAG_LAYER_LINES`]).
    pub layer_lines: bool,
}

fn rd32(b: &[u8], at: usize) -> Result<u32> {
    b.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or_else(|| Error::mesh("preview", "truncated SXPV buffer"))
}

/// Parses and bounds-checks an SXPV header.
pub fn read_info(b: &[u8]) -> Result<PreviewInfo> {
    if rd32(b, 0)? != MAGIC {
        return Err(Error::mesh("preview", "not an SXPV buffer"));
    }
    let flags = rd32(b, 4)? >> 16;
    let segments = rd32(b, 8)? as usize;
    let layers = rd32(b, 12)? as usize;
    let travels = rd32(b, 16)? as usize;
    let tools = rd32(b, 20)?;
    let has_travels = flags & u32::from(FLAG_TRAVELS) != 0;
    let layer_start = HEADER_BYTES;
    let layer_z = layer_start + (layers + 1) * 4;
    let layer_time = layer_z + layers * 4;
    let travel_start = layer_time + layers * 4;
    let segments_at = travel_start + if has_travels { (layers + 1) * 4 } else { 0 };
    let travels_at = segments_at + segments * SEGMENT_BYTES;
    let mut end = travels_at + if has_travels { travels * TRAVEL_BYTES } else { 0 };
    let extras_at = (flags & u32::from(FLAG_EXTRAS) != 0 && has_travels).then_some(end);
    if extras_at.is_some() {
        end = (end + segments * EXTRA_BYTES + travels).next_multiple_of(4);
    }
    let objects_at = (flags & u32::from(FLAG_OBJECTS) != 0).then_some(end);
    if objects_at.is_some() {
        end = (end + segments * OBJECT_BYTES).next_multiple_of(4);
    }
    if end > b.len() {
        return Err(Error::mesh("preview", "truncated SXPV buffer"));
    }
    Ok(PreviewInfo {
        segments,
        layers,
        travels,
        tools,
        has_travels,
        layer_start,
        layer_z,
        layer_time,
        travel_start,
        segments_at,
        travels_at,
        extras_at,
        objects_at,
        layer_lines: extras_at.is_some() && flags & u32::from(FLAG_LAYER_LINES) != 0,
    })
}

/// Writes `times` (seconds per layer) into the preview's layer time table, in place. Returns false and leaves the
/// buffer alone when it is not a preview or has a different number of layers.
pub fn set_layer_times(b: &mut [u8], times: &[f32]) -> bool {
    let Ok(info) = read_info(b) else { return false };
    if info.layers != times.len() {
        return false;
    }
    for (k, t) in times.iter().enumerate() {
        let at = info.layer_time + k * 4;
        let Some(dst) = b.get_mut(at..at + 4) else {
            return false;
        };
        dst.copy_from_slice(&t.to_le_bytes());
    }
    true
}

/// Joins SXPV chunks of consecutive layer ranges (in order) into the buffer a
/// single run over the whole range would produce.
pub fn stitch(chunks: &[&[u8]]) -> Result<Vec<u8>> {
    stitch_lines(chunks, &[], &[])
}

/// [`stitch`] that keeps the extras when every chunk has them. `layer_lines` are the 1-based lines of the
/// finished file's layer markers (`extras::layer_lines`), one per layer that has G-code (the
/// last ones of the preview after a resume): extras counted per layer become absolute lines, or 0
/// (unknown) without them, so a stitched buffer never has [`FLAG_LAYER_LINES`]. `progress_lines` are the
/// finished file's progress lines (`extras::progress_lines`), which the count from a marker skips.
pub fn stitch_lines(chunks: &[&[u8]], layer_lines: &[u32], progress_lines: &[u32]) -> Result<Vec<u8>> {
    let infos: Vec<PreviewInfo> = chunks.iter().map(|c| read_info(c)).collect::<Result<_>>()?;
    let (Some(first), Some(first_info)) = (chunks.first(), infos.first()) else {
        return Ok(Vec::new());
    };
    let segs: usize = infos.iter().map(|i| i.segments).sum();
    let layers: usize = infos.iter().map(|i| i.layers).sum();
    let travels: usize = infos.iter().map(|i| i.travels).sum();
    let has_travels = infos.iter().all(|i| i.has_travels);
    let has_objects = infos.iter().all(|i| i.objects_at.is_some());
    let has_extras = has_travels && infos.iter().all(|i| i.extras_at.is_some());
    let tools = infos.iter().map(|i| i.tools).max().unwrap_or(1);
    let mut b = Vec::new();
    let u32le =
        |b: &mut Vec<u8>, v: usize| b.extend_from_slice(&u32::try_from(v).unwrap_or(u32::MAX).to_le_bytes());
    b.extend_from_slice(&MAGIC.to_le_bytes());
    b.extend_from_slice(&VERSION.to_le_bytes());
    let flags = (if has_travels { FLAG_TRAVELS } else { 0 })
        | (if has_objects { FLAG_OBJECTS } else { 0 })
        | (if has_extras { FLAG_EXTRAS } else { 0 });
    b.extend_from_slice(&flags.to_le_bytes());
    u32le(&mut b, segs);
    u32le(&mut b, layers);
    u32le(&mut b, if has_travels { travels } else { 0 });
    b.extend_from_slice(&tools.to_le_bytes());
    b.extend_from_slice(first.get(24..32).unwrap_or(&[0; 8]));
    let _ = first_info;
    let mut base = 0usize;
    for (c, i) in chunks.iter().zip(&infos) {
        for l in 0..i.layers {
            u32le(&mut b, base + rd32(c, i.layer_start + l * 4)? as usize);
        }
        base += i.segments;
    }
    u32le(&mut b, base);
    for (c, i) in chunks.iter().zip(&infos) {
        b.extend_from_slice(c.get(i.layer_z..i.layer_time).unwrap_or(&[]));
    }
    for (c, i) in chunks.iter().zip(&infos) {
        b.extend_from_slice(c.get(i.layer_time..i.travel_start).unwrap_or(&[]));
    }
    if has_travels {
        let mut base = 0usize;
        for (c, i) in chunks.iter().zip(&infos) {
            for l in 0..i.layers {
                u32le(&mut b, base + rd32(c, i.travel_start + l * 4)? as usize);
            }
            base += i.travels;
        }
        u32le(&mut b, base);
    }
    for (c, i) in chunks.iter().zip(&infos) {
        b.extend_from_slice(c.get(i.segments_at..i.travels_at).unwrap_or(&[]));
    }
    if has_travels {
        for (c, i) in chunks.iter().zip(&infos) {
            b.extend_from_slice(
                c.get(i.travels_at..i.travels_at + i.travels * TRAVEL_BYTES)
                    .unwrap_or(&[]),
            );
        }
    }
    if has_extras {
        // Layers before the first marker have no G-code (a resume).
        let skip = layers.saturating_sub(layer_lines.len());
        let mut layer0 = 0usize;
        for (c, i) in chunks.iter().zip(&infos) {
            let at = i.extras_at.unwrap_or(0);
            let block = c.get(at..at + i.segments * EXTRA_BYTES).unwrap_or(&[]);
            if i.layer_lines {
                let mut l = 0usize;
                let (records, _) = block.as_chunks::<EXTRA_BYTES>();
                for (k, rec) in records.iter().enumerate() {
                    while l + 1 < i.layers && rd32(c, i.layer_start + (l + 1) * 4)? as usize <= k {
                        l += 1;
                    }
                    let [f0, f1, f2, f3, r0, r1, r2, r3] = *rec;
                    let rel = u32::from_le_bytes([r0, r1, r2, r3]);
                    let line = match (layer0 + l).checked_sub(skip).and_then(|j| layer_lines.get(j)) {
                        Some(&base) if rel != crate::extras::LINE_UNKNOWN => {
                            crate::extras::file_line(base, rel, progress_lines)
                        }
                        _ => 0,
                    };
                    b.extend_from_slice(&[f0, f1, f2, f3]);
                    b.extend_from_slice(&line.to_le_bytes());
                }
            } else {
                b.extend_from_slice(block);
            }
            layer0 += i.layers;
        }
        for (c, i) in chunks.iter().zip(&infos) {
            let at = i.extras_at.unwrap_or(0) + i.segments * EXTRA_BYTES;
            b.extend_from_slice(c.get(at..at + i.travels).unwrap_or(&[]));
        }
        pad4(&mut b);
    }
    if has_objects {
        for (c, i) in chunks.iter().zip(&infos) {
            let at = i.objects_at.unwrap_or(0);
            b.extend_from_slice(c.get(at..at + i.segments * OBJECT_BYTES).unwrap_or(&[]));
        }
        pad4(&mut b);
    }
    Ok(b)
}
