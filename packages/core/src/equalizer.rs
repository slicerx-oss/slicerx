// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Extrusion rate smoothing (`max_volumetric_extrusion_rate_slope`): the volumetric flow may change by at
//! most the given mm3/s per second, so a fast path next to a slow one ramps its speed instead of jumping.
//! Our own implementation of the method of Orca's `PressureEqualizer` (GCode/PressureEqualizer.cpp, the
//! Pressure Equalizer of PrusaSlicer): per layer, runs of extrusion joined over travels of 3 mm or less are
//! limited in a window of 128 lines, backward (the end of a line may not be faster than the next line's
//! start allows) and then forward, per extrusion role; a line whose rate changed is cut into pieces of
//! `max_volumetric_extrusion_rate_slope_segment_length` with the feed rate of each piece, as an
//! accelerate, steady, decelerate profile where the line is long enough.
//!
//! Differences from Orca, on purpose: each layer is smoothed on its own (Orca also looks across the layer
//! change, which would tie the layers of separate shards together); the last line of a run is included in
//! the backward limit (Orca's loop stops one line short, so the line a run ends on never slows the line
//! before it); and a line after a smoothed one gets its own feed rate back (Orca leaves it at the feed rate
//! of the last piece).

// The lines of one layer are indexed within bounds the loops check, and the piece counts are small
// positive whole numbers kept in floating point.
#![allow(
    clippy::indexing_slicing,
    clippy::float_cmp,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::needless_range_loop,
    clippy::manual_midpoint,
    reason = "see the note above"
)]

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::output::Feature;
use std::fmt::Write as _;

/// Gap between two extrusions, mm of travel, up to which they count as one run.
const MAX_GAP_MM: f64 = 3.0;
/// Lines back from the newest one a limit reaches.
const LOOK_BACK: usize = 128;
/// Rate changes smaller than this (mm3/min) are not worth cutting a line for.
const TRIVIAL_DELTA: f64 = 10.0;
/// Ramps shorter than this (mm) are left out.
const RAMP_MIN_MM: f64 = 0.05;
/// Roles: 0 for no extrusion role, then each feature by its index plus one.
const ROLES: usize = crate::output::Feature::ALL.len() + 1;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Other,
    Extrude,
    Move,
}

struct Ln<'a> {
    raw: &'a str,
    kind: Kind,
    /// X, Y, Z, E (accumulated) and F (mm/min) before and after the line.
    start: [f64; 5],
    end: [f64; 5],
    has: [bool; 3],
    /// E of the line in units of 1e-5 mm, as written.
    e_units: i64,
    rate: f64,
    /// `dist_xyz()`, worked out once when the line is read.
    len: f64,
    rate_start: f64,
    rate_end: f64,
    slope_pos: f64,
    slope_neg: f64,
    role: usize,
    adjustable: bool,
    modified: bool,
    /// A move line that sets no feed rate of its own.
    bare_move: bool,
}

impl Ln<'_> {
    fn extruding(&self) -> bool {
        self.kind == Kind::Extrude
    }
    fn dist_xy(&self) -> f64 {
        (self.end[0] - self.start[0]).m_hypot(self.end[1] - self.start[1])
    }
    fn dist_xyz(&self) -> f64 {
        self.dist_xy().m_hypot(self.end[2] - self.start[2])
    }
    fn feed(&self) -> f64 {
        self.end[4]
    }
}

/// The settings, or `None` when smoothing is off.
pub(crate) struct Params {
    /// mm3/min per minute.
    slope: f64,
    segment: f64,
    external_only: bool,
    /// Filament cross sections per tool, mm2.
    areas: Vec<f64>,
}

impl Params {
    pub(crate) fn of(cfg: &PrintConfig, tools: u8) -> Option<Self> {
        let slope = cfg.raw_number("max_volumetric_extrusion_rate_slope", 0.0);
        if slope <= 0.0 {
            return None;
        }
        let area = |s: u8| {
            let d = cfg.filament_diameter_for(s);
            0.25 * std::f64::consts::PI * d * d
        };
        Some(Self {
            slope: slope * 3600.0,
            segment: cfg
                .raw_number("max_volumetric_extrusion_rate_slope_segment_length", 3.0)
                .clamp(0.5, 5.0),
            external_only: crate::firmware::truthy(cfg, "extrusion_rate_smoothing_external_perimeter_only"),
            areas: (1..=tools.max(1)).map(area).collect(),
        })
    }

    fn slope_of(&self, role: usize) -> f64 {
        if role == Feature::Ironing as usize + 1 {
            0.0
        } else {
            self.slope
        }
    }
}

fn role_of(label: &str) -> usize {
    (0..18u8)
        .filter_map(|i| feature_by_index(i).map(|f| (i, f)))
        .find(|(_, f)| f.gcode_label() == label)
        .map_or(0, |(i, _)| usize::from(i) + 1)
}

fn feature_by_index(i: u8) -> Option<Feature> {
    use Feature as F;
    Some(match i {
        0 => F::OuterWall,
        1 => F::InnerWall,
        2 => F::OverhangWall,
        3 => F::TopSurface,
        4 => F::BottomSurface,
        5 => F::InternalSolid,
        6 => F::SparseInfill,
        7 => F::Bridge,
        8 => F::Support,
        9 => F::SupportInterface,
        10 => F::Brim,
        11 => F::Ironing,
        12 => F::GapFill,
        13 => F::PrimeTower,
        14 => F::Custom,
        15 => F::Skirt,
        16 => F::InternalBridge,
        17 => F::FloatingShell,
        _ => return None,
    })
}

fn word(line: &str, axis: char) -> Option<f64> {
    line.split(';')
        .next()?
        .split_whitespace()
        .skip(1)
        .find_map(|w| w.strip_prefix(axis))
        .and_then(|v| v.parse().ok())
}

fn e_units(v: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation, reason = "extrusion per line is small")]
    {
        (v * 1e5).round() as i64
    }
}

fn parse<'a>(chunk: &'a str, p: &Params) -> Vec<Ln<'a>> {
    let mut pos = [0.0f64; 5];
    let mut role = 0usize;
    let mut tool = 0usize;
    let mut out = Vec::new();
    for raw in chunk.split('\n') {
        let mut ln = Ln {
            raw,
            kind: Kind::Other,
            start: pos,
            end: pos,
            has: [false; 3],
            e_units: 0,
            rate: 0.0,
            len: 0.0,
            rate_start: 0.0,
            rate_end: 0.0,
            slope_pos: 0.0,
            slope_neg: 0.0,
            role,
            adjustable: false,
            modified: false,
            bare_move: false,
        };
        if let Some(label) = raw.strip_prefix(";TYPE:") {
            role = role_of(label.trim());
            ln.role = role;
        } else if raw.starts_with("G0 ") || raw.starts_with("G1 ") {
            let mut new = pos;
            for (i, axis) in ['X', 'Y', 'Z'].into_iter().enumerate() {
                if let Some(v) = word(raw, axis) {
                    new[i] = v;
                    ln.has[i] = true;
                }
            }
            let e = word(raw, 'E');
            if let Some(v) = e {
                new[3] += v;
                ln.e_units = e_units(v);
            }
            match word(raw, 'F') {
                Some(f) => new[4] = f,
                None => ln.bare_move = true,
            }
            let moved_xy = new[0] != pos[0] || new[1] != pos[1];
            let de = new[3] - pos[3];
            if de > 0.0 && moved_xy {
                ln.kind = Kind::Extrude;
                let d = [new[0] - pos[0], new[1] - pos[1], new[2] - pos[2]];
                let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
                let area = p.areas.get(tool).or(p.areas.last()).copied().unwrap_or(2.405);
                ln.rate = area * new[4] * de / len;
                ln.rate_start = ln.rate;
                ln.rate_end = ln.rate;
                ln.adjustable = role != 0
                    && role != Feature::PrimeTower as usize + 1
                    && role != Feature::Custom as usize + 1;
            } else if de == 0.0 && (moved_xy || new[2] != pos[2]) {
                ln.kind = Kind::Move;
            }
            ln.end = new;
            pos = new;
        } else if raw.starts_with("G2 ") || raw.starts_with("G3 ") {
            // Arcs are passed through; their end point still moves the tracked position.
            for (i, axis) in ['X', 'Y', 'Z'].into_iter().enumerate() {
                if let Some(v) = word(raw, axis) {
                    pos[i] = v;
                }
            }
            if let Some(f) = word(raw, 'F') {
                pos[4] = f;
            }
        } else if raw.starts_with("G92") {
            if let Some(v) = word(raw, 'E') {
                pos[3] = v;
            }
        } else if let Some(t) = raw.strip_prefix('T').and_then(|t| t.trim().parse::<usize>().ok()) {
            tool = t;
        }
        ln.len = ln.dist_xyz();
        out.push(ln);
    }
    out
}

/// The extrusion rate at the start or end of the line `l` that a neighbor at `rate` allows over its length.
fn reach(rate: f64, l: &Ln<'_>, slope: f64) -> f64 {
    (rate * rate + 2.0 * l.rate * l.len * slope / l.feed()).sqrt()
}

/// The slope of each role, and the roles a limit applies to (bit `r` for role `r`: not role 0, slope not 0).
struct Slopes {
    of: [f64; ROLES],
    live: u32,
}

const _: () = assert!(ROLES <= 32, "roles fit a u32 mask");

impl Slopes {
    fn of(p: &Params) -> Self {
        let mut s = Self {
            of: [0.0; ROLES],
            live: 0,
        };
        for r in 1..ROLES {
            s.of[r] = p.slope_of(r);
            if s.of[r] != 0.0 {
                s.live |= 1 << r;
            }
        }
        s
    }
}

fn frozen(l: &Ln<'_>, p: &Params) -> bool {
    !l.adjustable
        || l.role == Feature::Bridge as usize + 1
        || l.role == Feature::Ironing as usize + 1
        || (p.external_only
            && l.role != Feature::OuterWall as usize + 1
            && l.role != Feature::OverhangWall as usize + 1)
}

/// Orca's `adjust_volumetric_rate` over the lines `first..=last`. Each pass visits only the roles whose
/// slot is set and whose slope is not 0, in ascending order as a loop over every role would. A slot is
/// written only when it is visited, so the mask taken at the start of a pass holds for the whole pass.
fn adjust(lines: &mut [Ln<'_>], first: usize, last: usize, s: &Slopes, p: &Params) {
    if last < first + 2 || !lines[last].extruding() {
        return;
    }
    let ironing = Feature::Ironing as usize + 1;
    let mut i = last;
    let mut per_role = [f64::MAX; ROLES];
    per_role[lines[i].role] = lines[i].rate_start;
    let mut mask = s.live & (1 << lines[i].role);
    while i != first {
        let mut prev = i - 1;
        while !lines[prev].extruding() && prev != first {
            prev -= 1;
        }
        if !lines[prev].extruding() {
            break;
        }
        if lines[i].role == ironing {
            i = prev;
            continue;
        }
        let rate_succ = lines[i].rate_start;
        i = prev;
        let fixed = frozen(&lines[i], p);
        let l = &mut lines[i];
        let mut bits = mask;
        while bits != 0 {
            let r = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            let slope = s.of[r];
            let slot = &mut per_role[r];
            if *slot == f64::MAX {
                continue;
            }
            let mut rate_end = *slot;
            if r == l.role && rate_succ < rate_end {
                rate_end = rate_succ;
            }
            if fixed {
                rate_end = l.rate_end;
            } else if l.rate_end > rate_end {
                l.rate_end = rate_end;
                l.slope_neg = slope;
                l.modified = true;
            } else if r == l.role {
                rate_end = l.rate_end;
            }
            if l.adjustable {
                let start = reach(rate_end, l, slope);
                if start < l.rate_start {
                    l.rate_start = start;
                    l.slope_neg = slope;
                    l.modified = true;
                }
            }
            if l.role != ironing {
                *slot = l.rate_start;
            }
        }
    }
    let mut per_role = [f64::MAX; ROLES];
    per_role[lines[i].role] = lines[i].rate_end;
    mask = s.live & (1 << lines[i].role);
    while i != last {
        let mut next = i + 1;
        while !lines[next].extruding() && next != last {
            next += 1;
        }
        if !lines[next].extruding() {
            break;
        }
        if lines[i].role == ironing {
            i = next;
            continue;
        }
        let rate_prec = lines[i].rate_end;
        i = next;
        let fixed = frozen(&lines[i], p);
        let l = &mut lines[i];
        let mut bits = mask;
        while bits != 0 {
            let r = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            let slope = s.of[r];
            let slot = &mut per_role[r];
            if *slot == f64::MAX {
                continue;
            }
            let mut rate_start = *slot;
            if fixed {
                rate_start = l.rate_start;
            } else if r == l.role && rate_prec < rate_start {
                rate_start = rate_prec;
            }
            if l.rate_start > rate_start {
                l.rate_start = rate_start;
                l.slope_pos = slope;
                l.modified = true;
            } else if r == l.role {
                rate_start = l.rate_start;
            }
            if l.adjustable {
                let end = reach(rate_start, l, slope);
                if end < l.rate_end {
                    l.rate_end = end;
                    l.slope_pos = slope;
                    l.modified = true;
                }
            }
            if l.role != ironing {
                *slot = l.rate_end;
            }
        }
    }
}

/// Runs of extrusion joined over small gaps, each limited in windows of [`LOOK_BACK`] lines.
fn smooth(lines: &mut [Ln<'_>], p: &Params) {
    let s = Slopes::of(p);
    let n = lines.len();
    let mut end = 0usize;
    while end < n {
        let Some(begin) = (end..n).find(|&k| lines[k].extruding()) else {
            break;
        };
        end = begin;
        loop {
            let after = (end..n).find(|&k| !lines[k].extruding()).unwrap_or(n);
            end = after.saturating_sub(1).max(begin);
            // Carry the run on over travels of at most MAX_GAP_MM.
            let mut gap = 0.0;
            let mut cont = None;
            for k in end + 1..n {
                if lines[k].extruding() {
                    cont = Some(k);
                    break;
                }
                gap += lines[k].dist_xy();
                if gap > MAX_GAP_MM {
                    break;
                }
            }
            match cont {
                Some(k) => end = k,
                None => break,
            }
        }
        for k in begin..=end {
            adjust(lines, begin.max(k.saturating_sub(LOOK_BACK)), k, &s, p);
        }
        end += 1;
    }
}

/// Writes pieces of a smoothed line.
struct Out {
    text: String,
    feed: f64,
}

impl Out {
    fn feed_line(&mut self, f: f64) {
        if (f - self.feed).abs() > 1e-9 {
            let _ = writeln!(self.text, "G1 F{}", fmt(f, 3));
            self.feed = f;
        }
    }

    /// One piece from fraction `t0` to `t1` of `l` at feed rate `f` (mm/min), as Orca quantizes it.
    fn piece(&mut self, l: &Ln<'_>, t0: f64, t1: f64, f: f64) {
        let f = (f.max(60.0) / 60.0).round() * 60.0;
        self.feed_line(f);
        let at = |i: usize, t: f64| l.start[i] + (l.end[i] - l.start[i]) * t;
        #[allow(clippy::cast_possible_truncation, reason = "extrusion per line is small")]
        let e = |t: f64| (l.e_units as f64 * t).round() as i64;
        let _ = write!(self.text, "G1 X{} Y{}", fmt(at(0, t1), 3), fmt(at(1, t1), 3));
        if l.has[2] {
            let _ = write!(self.text, " Z{}", fmt(at(2, t1), 3));
        }
        let de = e(t1) - e(t0);
        #[allow(clippy::cast_precision_loss, reason = "extrusion per line is small")]
        let _ = writeln!(self.text, " E{}", fmt(de as f64 / 1e5, 5));
    }
}

/// A number with at most `decimals` decimals, trailing zeros and a leading zero left off as our writer does.
fn fmt(v: f64, decimals: usize) -> String {
    let s = format!("{v:.decimals$}");
    let s = if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s
    };
    let s = if s == "-0" { "0".to_owned() } else { s };
    if let Some(r) = s.strip_prefix("0.") {
        format!(".{r}")
    } else if let Some(r) = s.strip_prefix("-0.") {
        format!("-.{r}")
    } else {
        s
    }
}

/// Orca's `output_gcode_line` for a modified line.
fn write_line(out: &mut Out, l: &mut Ln<'_>, seg: f64) {
    let len = l.len;
    let n = (len / seg).ceil().max(1.0);
    let rate_delta = (l.rate_end - l.rate_start)
        .abs()
        .max((l.rate - l.rate_start).abs())
        .max((l.rate - l.rate_end).abs())
        .round();
    let feed = l.feed();
    if n <= 1.0 || rate_delta < TRIVIAL_DELTA {
        let avg = (0.5 * (l.rate_start + l.rate_end) / l.rate).max(0.05);
        out.piece(l, 0.0, 1.0, feed * avg);
        return;
    }
    let f_start = l.rate_start * feed / l.rate;
    let f_end = l.rate_end * feed / l.rate;
    // Accelerate, run steady, decelerate, when the line is faster than both its ends.
    if l.rate > l.rate_start && l.rate > l.rate_end {
        let total_e = len * l.rate / feed;
        let max_sloped = total_e - total_e * seg / len;
        let (e2, e02, e12) = (
            l.rate * l.rate,
            l.rate_start * l.rate_start,
            l.rate_end * l.rate_end,
        );
        let (sp, sn) = (l.slope_pos.max(1e-9), l.slope_neg.max(1e-9));
        let sloped = (e2 - e02) / 2.0 / sp + (e2 - e12) / 2.0 / sn;
        let mut peak = l.rate;
        let mut ok = true;
        if sloped > max_sloped {
            peak = ((2.0 * max_sloped * sp * sn + sn * e02 + sp * e12) / (sp + sn)).sqrt();
            ok = peak > l.rate_start && peak > l.rate_end;
        }
        if ok && (peak - l.rate_start).abs().min((peak - l.rate_end).abs()).round() >= TRIVIAL_DELTA {
            let f_peak = feed * peak / l.rate;
            let l_acc = (peak - l.rate_start) / sp * (f_peak + f_start) / 2.0;
            let l_dec = (peak - l.rate_end) / sn * (f_peak + f_end) / 2.0;
            if l_acc < RAMP_MIN_MM && l_dec < RAMP_MIN_MM {
                out.piece(l, 0.0, 1.0, f_peak);
                return;
            }
            let t_acc = (l_acc / len).min(1.0);
            let t_dec = ((len - l_dec) / len).max(t_acc);
            let na = (l_acc / seg).ceil().max(1.0);
            let mut t0 = 0.0;
            for i in 1..=na as usize {
                let k = i as f64;
                let t1 = t_acc * k / na;
                out.piece(l, t0, t1, f_start + (f_peak - f_start) * (k - 0.5) / na);
                t0 = t1;
            }
            out.piece(l, t0, t_dec, f_peak);
            t0 = t_dec;
            let nd = (l_dec / seg).ceil().max(1.0);
            for i in 1..=nd as usize {
                let k = i as f64;
                let t1 = t_dec + (1.0 - t_dec) * k / nd;
                out.piece(l, t0, t1, f_peak + (f_end - f_peak) * (k - 0.5) / nd);
                t0 = t1;
            }
            return;
        }
    }
    // One slope over the line, with a steady part at the fast end when the slope finishes early.
    let accelerating = l.rate_start < l.rate_end;
    let f_avg = 0.5 * (f_start + f_end);
    let slope = if accelerating { l.slope_pos } else { l.slope_neg }.max(1e-9);
    let t_total = len / f_avg;
    let t_ramp = (l.rate_start - l.rate_end).abs() / slope;
    let (mut l_acc, mut l_steady, mut n) = (len, 0.0, n);
    if t_ramp < t_total {
        l_acc = t_ramp * f_avg;
        l_steady = len - l_acc;
        if l_steady < 0.5 * seg {
            l_acc = len;
            l_steady = 0.0;
        } else {
            n = (l_acc / seg).ceil().max(1.0);
        }
    }
    // A ramp shorter than RAMP_MIN_MM is not worth a line of its own (Orca still writes it): the line runs at
    // its steady feed rate.
    if l_steady > 0.0 && l_acc < RAMP_MIN_MM {
        out.piece(l, 0.0, 1.0, if accelerating { f_end } else { f_start });
        return;
    }
    // The ramp covers [r0, r1] of the line; a steady part comes before it (decelerating) or after.
    let (r0, r1) = if l_steady > 0.0 && !accelerating {
        (l_steady / len, 1.0)
    } else {
        (0.0, l_acc / len)
    };
    let mut t0 = 0.0;
    if l_steady > 0.0 && !accelerating {
        out.piece(l, 0.0, r0, f_start);
        t0 = r0;
    }
    for i in 1..n as usize {
        let k = i as f64;
        let t1 = r0 + (r1 - r0) * k / n;
        out.piece(l, t0, t1, f_start + (f_end - f_start) * (k - 0.5) / n);
        t0 = t1;
    }
    if l_steady > 0.0 && accelerating {
        out.piece(l, t0, r1, f_end);
        t0 = r1;
        out.piece(l, t0, 1.0, f_end);
    } else {
        out.piece(l, t0, 1.0, f_end);
    }
}

/// Smooths the extrusion rate of one layer chunk (relative extrusion distances, as the writer makes it).
pub(crate) fn apply(chunk: &[u8], p: &Params) -> Vec<u8> {
    apply_by(chunk, p, smooth)
}

fn apply_by(chunk: &[u8], p: &Params, run: impl Fn(&mut [Ln<'_>], &Params)) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(chunk) else {
        return chunk.to_vec();
    };
    let mut lines = parse(text, p);
    run(&mut lines, p);
    if !lines.iter().any(|l| l.modified) {
        return chunk.to_vec();
    }
    let mut out = Out {
        text: String::with_capacity(text.len() + text.len() / 4),
        feed: -1.0,
    };
    let last = lines.len().saturating_sub(1);
    // Set after a smoothed line: the next move without a feed rate of its own gets its feed rate back.
    let mut restore = false;
    for (k, l) in lines.iter_mut().enumerate() {
        if l.modified && l.rate > 0.0 && l.feed() > 0.0 {
            write_line(&mut out, l, p.segment);
            out.text.pop();
            if k < last {
                out.text.push('\n');
            }
            restore = true;
            continue;
        }
        if restore && l.bare_move && l.feed() > 0.0 {
            out.feed_line(l.end[4]);
            restore = false;
        }
        if let Some(f) = word(l.raw, 'F').filter(|_| l.raw.starts_with('G')) {
            out.feed = f;
        }
        out.text.push_str(l.raw);
        if k < last {
            out.text.push('\n');
        }
    }
    out.text.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `reach` with the length worked out on every call, as before the cached length.
    fn reach_ref(rate: f64, l: &Ln<'_>, slope: f64) -> f64 {
        (rate * rate + 2.0 * l.rate * l.dist_xyz() * slope / l.feed()).sqrt()
    }

    /// The loop over every role as it was before the role mask, kept as the oracle for `adjust`.
    fn adjust_ref(lines: &mut [Ln<'_>], first: usize, last: usize, p: &Params) {
        if last < first + 2 || !lines[last].extruding() {
            return;
        }
        let ironing = Feature::Ironing as usize + 1;
        let mut i = last;
        let mut per_role = [f64::MAX; ROLES];
        per_role[lines[i].role] = lines[i].rate_start;
        while i != first {
            let mut prev = i - 1;
            while !lines[prev].extruding() && prev != first {
                prev -= 1;
            }
            if !lines[prev].extruding() {
                break;
            }
            if lines[i].role == ironing {
                i = prev;
                continue;
            }
            let rate_succ = lines[i].rate_start;
            i = prev;
            let fixed = frozen(&lines[i], p);
            let l = &mut lines[i];
            for (r, slot) in per_role.iter_mut().enumerate().skip(1) {
                let slope = p.slope_of(r);
                if slope == 0.0 || *slot == f64::MAX {
                    continue;
                }
                let mut rate_end = *slot;
                if r == l.role && rate_succ < rate_end {
                    rate_end = rate_succ;
                }
                if fixed {
                    rate_end = l.rate_end;
                } else if l.rate_end > rate_end {
                    l.rate_end = rate_end;
                    l.slope_neg = slope;
                    l.modified = true;
                } else if r == l.role {
                    rate_end = l.rate_end;
                }
                if l.adjustable {
                    let start = reach_ref(rate_end, l, slope);
                    if start < l.rate_start {
                        l.rate_start = start;
                        l.slope_neg = slope;
                        l.modified = true;
                    }
                }
                if l.role != ironing {
                    *slot = l.rate_start;
                }
            }
        }
        let mut per_role = [f64::MAX; ROLES];
        per_role[lines[i].role] = lines[i].rate_end;
        while i != last {
            let mut next = i + 1;
            while !lines[next].extruding() && next != last {
                next += 1;
            }
            if !lines[next].extruding() {
                break;
            }
            if lines[i].role == ironing {
                i = next;
                continue;
            }
            let rate_prec = lines[i].rate_end;
            i = next;
            let fixed = frozen(&lines[i], p);
            let l = &mut lines[i];
            for (r, slot) in per_role.iter_mut().enumerate().skip(1) {
                let slope = p.slope_of(r);
                if slope == 0.0 || *slot == f64::MAX {
                    continue;
                }
                let mut rate_start = *slot;
                if fixed {
                    rate_start = l.rate_start;
                } else if r == l.role && rate_prec < rate_start {
                    rate_start = rate_prec;
                }
                if l.rate_start > rate_start {
                    l.rate_start = rate_start;
                    l.slope_pos = slope;
                    l.modified = true;
                } else if r == l.role {
                    rate_start = l.rate_start;
                }
                if l.adjustable {
                    let end = reach_ref(rate_start, l, slope);
                    if end < l.rate_end {
                        l.rate_end = end;
                        l.slope_pos = slope;
                        l.modified = true;
                    }
                }
                if l.role != ironing {
                    *slot = l.rate_end;
                }
            }
        }
    }

    /// `smooth` over `adjust_ref`.
    fn smooth_ref(lines: &mut [Ln<'_>], p: &Params) {
        let n = lines.len();
        let mut end = 0usize;
        while end < n {
            let Some(begin) = (end..n).find(|&k| lines[k].extruding()) else {
                break;
            };
            end = begin;
            loop {
                let after = (end..n).find(|&k| !lines[k].extruding()).unwrap_or(n);
                end = after.saturating_sub(1).max(begin);
                // Carry the run on over travels of at most MAX_GAP_MM.
                let mut gap = 0.0;
                let mut cont = None;
                for k in end + 1..n {
                    if lines[k].extruding() {
                        cont = Some(k);
                        break;
                    }
                    gap += lines[k].dist_xy();
                    if gap > MAX_GAP_MM {
                        break;
                    }
                }
                match cont {
                    Some(k) => end = k,
                    None => break,
                }
            }
            for k in begin..=end {
                adjust_ref(lines, begin.max(k.saturating_sub(LOOK_BACK)), k, p);
            }
            end += 1;
        }
    }

    /// Small xorshift generator, so the random chunks are the same on every run.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.unit()
        }
    }

    /// A random layer chunk: mixed roles (ironing, bridges, prime tower, unknown labels), feed changes, short
    /// and long travels, retractions, `G92`, tool changes, arcs, Z moves and runs longer than the window.
    fn fuzz_chunk(rng: &mut Rng, n: usize) -> String {
        let mut labels: Vec<&str> = Feature::ALL.iter().map(|f| f.gcode_label()).collect();
        labels.extend(["Ironing", "Ironing", "Outer wall", "Sparse infill", "Unknown"]);
        let (mut x, mut y, mut z) = (rng.range(20.0, 230.0), rng.range(20.0, 230.0), 0.2);
        let mut g = format!(";LAYER_CHANGE\n;Z:{z}\nG1 Z{z} F600\n");
        let step = |rng: &mut Rng, x: &mut f64, y: &mut f64, len: f64| {
            let a = rng.range(0.0, std::f64::consts::TAU);
            *x = (*x + len * a.m_cos()).clamp(1.0, 255.0);
            *y = (*y + len * a.m_sin()).clamp(1.0, 255.0);
        };
        for _ in 0..n {
            let pick = rng.below(100);
            match pick {
                0..=6 => {
                    let l = labels[rng.below(labels.len() as u64) as usize];
                    let _ = writeln!(g, ";TYPE:{l}");
                }
                7..=13 => {
                    let _ = writeln!(g, "G1 F{}", fmt(rng.range(300.0, 18000.0), 3));
                }
                14..=64 | 90..=91 => {
                    let len = match rng.below(10) {
                        0 => rng.range(0.001, 0.05),
                        1..=6 => rng.range(0.05, 4.0),
                        _ => rng.range(4.0, 40.0),
                    };
                    step(rng, &mut x, &mut y, len);
                    let _ = write!(g, "G1 X{} Y{}", fmt(x, 3), fmt(y, 3));
                    if rng.below(20) == 0 {
                        z += rng.range(-0.05, 0.05);
                        let _ = write!(g, " Z{}", fmt(z, 3));
                    }
                    let _ = write!(g, " E{}", fmt(len * rng.range(0.005, 0.12), 5));
                    if rng.below(4) == 0 {
                        let _ = write!(g, " F{}", fmt(rng.range(300.0, 18000.0), 3));
                    }
                    if pick >= 90 {
                        g.push_str(" ; note");
                    }
                    g.push('\n');
                }
                65..=74 => {
                    let d = rng.range(0.1, 2.5);
                    step(rng, &mut x, &mut y, d);
                    let f = if rng.below(2) == 0 { " F12000" } else { "" };
                    let _ = writeln!(g, "G0 X{} Y{}{f}", fmt(x, 3), fmt(y, 3));
                }
                75..=78 => {
                    let d = rng.range(3.0, 60.0);
                    step(rng, &mut x, &mut y, d);
                    let _ = writeln!(g, "G1 X{} Y{} F12000", fmt(x, 3), fmt(y, 3));
                }
                79..=80 => g.push_str("G1 E-.8 F1800\n"),
                81 => g.push_str("G1 E.8 F1800\n"),
                82 => g.push_str("G92 E0\n"),
                83 => {
                    let _ = writeln!(g, "T{}", rng.below(3));
                }
                84 => {
                    let d = rng.range(1.0, 6.0);
                    step(rng, &mut x, &mut y, d);
                    let _ = writeln!(g, "G2 X{} Y{} I1 J1 E.2", fmt(x, 3), fmt(y, 3));
                }
                85 => {
                    let _ = writeln!(g, "G1 X{} Y{} E.1", fmt(x, 3), fmt(y, 3));
                }
                86 => {
                    z += 0.4;
                    let _ = writeln!(g, "G1 Z{} F600", fmt(z, 3));
                    z -= 0.4;
                    let _ = writeln!(g, "G1 Z{}", fmt(z, 3));
                }
                87 => g.push_str("M204 S5000\n"),
                88 => g.push_str("; a comment\n"),
                _ => {
                    let d = rng.range(0.2, 8.0);
                    step(rng, &mut x, &mut y, d);
                    let _ = writeln!(g, "G1 X{} Y{}", fmt(x, 3), fmt(y, 3));
                }
            }
        }
        g
    }

    /// Smooths `chunk` with `smooth` and with the oracle and checks every line's limits bit for bit and the
    /// written chunk byte for byte. Returns the count of lines the limits changed.
    fn same_as_oracle(chunk: &str, p: &Params) -> usize {
        let mut a = parse(chunk, p);
        smooth(&mut a, p);
        let mut b = parse(chunk, p);
        smooth_ref(&mut b, p);
        assert_eq!(a.len(), b.len());
        for (k, (x, y)) in a.iter().zip(&b).enumerate() {
            let bits = |l: &Ln<'_>| {
                (
                    l.rate_start.to_bits(),
                    l.rate_end.to_bits(),
                    l.slope_pos.to_bits(),
                    l.slope_neg.to_bits(),
                    l.modified,
                    l.len.to_bits(),
                )
            };
            assert_eq!(bits(x), bits(y), "line {k}: {}", x.raw);
            assert_eq!(x.len.to_bits(), x.dist_xyz().to_bits(), "line {k}: {}", x.raw);
        }
        let ours = apply(chunk.as_bytes(), p);
        let oracle = apply_by(chunk.as_bytes(), p, smooth_ref);
        assert!(ours == oracle, "chunk output differs:\n{chunk}");
        a.iter().filter(|l| l.modified).count()
    }

    fn param_set() -> Vec<Params> {
        let mut out = Vec::new();
        for slope in [0.5, 3.0, 20.0, 300.0, 1000.0] {
            for external_only in [false, true] {
                out.push(Params {
                    slope: slope * 3600.0,
                    segment: 3.0,
                    external_only,
                    areas: vec![2.405, 3.0],
                });
            }
        }
        out
    }

    #[test]
    fn role_mask_matches_the_full_role_loop_on_random_chunks() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let params = param_set();
        let (mut chunks, mut modified) = (0usize, 0usize);
        for round in 0..400 {
            let n = if round % 8 == 0 {
                400 + rng.below(500) as usize
            } else {
                10 + rng.below(160) as usize
            };
            let chunk = fuzz_chunk(&mut rng, n);
            for p in &params {
                modified += same_as_oracle(&chunk, p);
                chunks += 1;
            }
        }
        // The chunks exercise the limits, not only the pass-through.
        assert!(modified > 10_000, "{modified} lines changed over {chunks} chunks");
        // The fixed chunks too.
        for p in &params {
            same_as_oracle(&chunk(), p);
        }
    }

    /// Real chunks: the layers of the G-code files named in `SX_EQ_ORACLE_GCODE` (separated by `:`), written
    /// with smoothing off, checked against the oracle at every slope of [`param_set`]. The tags a Bambu Lab
    /// printer gets in the finished file are turned back into the ones the smoothing reads. Run with
    /// `--release --ignored`.
    #[test]
    #[ignore = "reads G-code files named in SX_EQ_ORACLE_GCODE"]
    fn role_mask_matches_the_full_role_loop_on_gcode_files() {
        use rayon::prelude::*;
        let paths = std::env::var("SX_EQ_ORACLE_GCODE").expect("SX_EQ_ORACLE_GCODE");
        let params = param_set();
        for path in paths.split(':').filter(|s| !s.is_empty()) {
            let text = std::fs::read_to_string(path).expect("read G-code");
            let mut chunks: Vec<String> = Vec::new();
            for line in text.split_inclusive('\n') {
                let line = if line.starts_with("; CHANGE_LAYER") {
                    ";LAYER_CHANGE\n".to_owned()
                } else if let Some(t) = line.strip_prefix("; FEATURE: ") {
                    format!(";TYPE:{t}")
                } else {
                    line.to_owned()
                };
                if line.starts_with(";LAYER_CHANGE") || chunks.is_empty() {
                    chunks.push(String::new());
                }
                if let Some(c) = chunks.last_mut() {
                    c.push_str(&line);
                }
            }
            let modified: usize = chunks
                .par_iter()
                .map(|c| params.iter().map(|p| same_as_oracle(c, p)).sum::<usize>())
                .sum();
            let lines: usize = chunks.iter().map(|c| c.lines().count()).sum();
            println!(
                "{path}: {} chunks, {lines} lines, {modified} line limits changed over {} slopes",
                chunks.len(),
                params.len()
            );
            assert!(chunks.len() > 1, "no layer tags in {path}");
        }
    }

    fn params(slope: f64) -> Params {
        Params {
            slope: slope * 3600.0,
            segment: 3.0,
            external_only: false,
            areas: vec![2.405],
        }
    }

    /// A slow outer wall straight into a fast sparse infill line and back: 20 mm/s, 200 mm/s, 20 mm/s.
    fn chunk() -> String {
        let e = |len: f64| len * 0.42 * 0.2 / 2.405;
        format!(
            ";LAYER_CHANGE\nG0 X0 Y0 F12000\n;TYPE:Outer wall\nG1 F1200\nG1 X20 Y0 E{:.5}\n;TYPE:Sparse infill\nG1 F12000\nG1 X80 Y0 E{:.5}\n;TYPE:Outer wall\nG1 F1200\nG1 X100 Y0 E{:.5}\nG0 X0 Y50 F12000\n",
            e(20.0),
            e(60.0),
            e(20.0)
        )
    }

    fn moves(g: &str) -> Vec<(f64, f64, f64)> {
        let (mut f, mut x, mut out) = (0.0, 0.0, Vec::new());
        for l in g.lines() {
            if let Some(v) = word(l, 'F') {
                f = v;
            }
            if l.starts_with("G1 X") {
                let nx = word(l, 'X').unwrap();
                out.push((nx - x, word(l, 'E').unwrap(), f));
                x = nx;
            } else if let Some(v) = word(l, 'X') {
                x = v;
            }
        }
        out
    }

    #[test]
    fn a_jump_in_flow_becomes_a_ramp_within_the_slope() {
        let src = chunk();
        let p = params(20.0);
        let out = String::from_utf8(apply(src.as_bytes(), &p)).unwrap();
        let m = moves(&out);
        // The extrusion is the same in total and the moves still end where they did.
        let total: f64 = m.iter().map(|v| v.1).sum();
        let want: f64 = moves(&src).iter().map(|v| v.1).sum();
        assert!((total - want).abs() < 2e-5, "{total} {want}");
        assert!(out.contains("G1 X100 Y0 E") && out.ends_with("G0 X0 Y50 F12000\n"));
        // The fast line is cut into pieces whose feed rate climbs and falls in steps.
        assert!(m.len() > 6, "{out}");
        let feeds: Vec<f64> = m.iter().map(|v| v.2).collect();
        let peak = feeds.iter().copied().fold(0.0, f64::max);
        assert!(peak > 1200.0 && peak <= 12000.0, "{feeds:?}");
        // Neighboring pieces change their volumetric rate no faster than the slope allows (mm3/s per s),
        // within one piece's quantization.
        for w in m.windows(2) {
            let rate = |v: &(f64, f64, f64)| 2.405 * v.2 / 60.0 * v.1 / v.0;
            let dt = w[0].0 / (w[0].2 / 60.0);
            let dr = (rate(&w[1]) - rate(&w[0])).abs();
            assert!(dr <= 20.0 * dt * 1.5 + 0.5, "{dr} over {dt} s: {out}");
        }
        // The walls keep their 20 mm/s.
        assert_eq!(feeds.first().copied(), Some(1200.0));
    }

    #[test]
    fn off_or_flat_flow_leaves_the_chunk_alone() {
        // A slope so steep that every ramp is shorter than RAMP_MIN_MM changes no line's shape.
        let src = chunk();
        let out = String::from_utf8(apply(src.as_bytes(), &params(1e6))).unwrap();
        assert_eq!(moves(&out).len(), moves(&src).len(), "{out}");
        let flat = ";TYPE:Sparse infill\nG1 F6000\nG1 X10 Y0 E.5\nG1 X20 Y0 E.5\n";
        assert_eq!(apply(flat.as_bytes(), &params(5.0)), flat.as_bytes());
    }
}
