// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Fuzzy skin: wall loops resampled at random spacing and nudged sideways by random amounts, for a
//! rough, grippy or decorative surface.
//!
//! Orca: `Feature/FuzzySkin/FuzzySkin.cpp` (`fuzzy_polyline`, `should_fuzzify`). Points go down each
//! loop at 3/4 of `fuzzy_skin_point_distance` plus up to half of it, and each moves along the loop's
//! normal by a random fraction of `fuzzy_skin_thickness`. Orca draws the randomness from the system's
//! random device, so no two runs agree; here it comes from a hash of the layer and the loop, so a
//! slice is repeatable and the same on every shard. The noise types are Orca's (`fuzzy_skin_noise_type`):
//! uniform ("classic"), Perlin, Billow, ridged multifractal and Voronoi from libnoise (src/noise), read
//! at the point's position and the slice height, and ripple, a sine along the loop. The modes
//! (`fuzzy_skin_mode`) change what the noise moves: the point sideways (displacement), the bead width
//! (extrusion) or both (combined); they act on variable-width walls only, as in Orca, where polygons
//! always take displacement.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::noise::Noise;
use crate::perimeters::Shapes;
use i_overlay::i_float::int::point::IntPoint;

/// What the noise moves on a variable-width wall (`fuzzy_skin_mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Displacement,
    Extrusion,
    Combined,
}

/// The ripple noise: a sine along the loop (`fuzzy_skin_ripples_per_layer`, `_ripple_offset`,
/// `_layers_between_ripple_offset`).
#[derive(Debug, Clone, Copy)]
struct Ripple {
    per_loop: f64,
    offset_percent: f64,
    layers_between: i64,
}

/// Where the noise value comes from.
#[derive(Debug, Clone, Copy)]
enum Source {
    Uniform,
    Noise(Noise),
    Ripple(Ripple),
}

/// A bead width never falls below this, in internal units (Orca's `min_extrusion_width`).
const MIN_WIDTH: f64 = 0.01;

/// Which loops get fuzz (`fuzzy_skin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Outer walls of outlines only.
    External,
    /// Outer walls of outlines and holes.
    All,
    /// Every wall of outlines and holes.
    AllWalls,
    /// Outer walls of holes only.
    Hole,
}

/// Fuzzy skin settings of a print, in internal units.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Fuzzy {
    kind: Kind,
    thickness: f64,
    distance: f64,
    first_layer: bool,
    source: Source,
    mode: Mode,
}

/// One new point of a fuzzed loop: where it lies on the original, the loop's unit normal there, the
/// noise value in internal units, and the index of the original point the segment ends at.
struct Sample {
    at: (f64, f64),
    normal: (f64, f64),
    r: f64,
    end: usize,
    ripple: bool,
}

impl Fuzzy {
    /// `None` when fuzzy skin is off.
    pub(crate) fn new(cfg: &PrintConfig) -> Option<Self> {
        let kind = match cfg.raw.get("fuzzy_skin") {
            Some(serde_json::Value::String(s)) => match s.as_str() {
                "external" | "contour" => Kind::External,
                "all" => Kind::All,
                "allwalls" => Kind::AllWalls,
                "hole" => Kind::Hole,
                // "none", "disabled_fuzzy" and anything unknown leave the walls smooth.
                _ => return None,
            },
            _ => return None,
        };
        Self::of_kind(cfg, kind)
    }

    /// The fuzz of a painted area: the outer walls of outlines and holes (`all`) with the print's other
    /// fuzzy skin settings, whatever `fuzzy_skin` says, except `disabled_fuzzy`, which keeps paint off too
    /// (Orca `PrintObjectRegions::FuzzySkinPaintedRegion` in PrintApply.cpp). `None` when off.
    pub(crate) fn painted(cfg: &PrintConfig) -> Option<Self> {
        if matches!(cfg.raw.get("fuzzy_skin"), Some(serde_json::Value::String(s)) if s == "disabled_fuzzy") {
            return None;
        }
        Self::of_kind(cfg, Kind::All)
    }

    fn of_kind(cfg: &PrintConfig, kind: Kind) -> Option<Self> {
        let thickness = cfg.raw_number("fuzzy_skin_thickness", 0.2) * SCALE;
        let distance = (cfg.raw_number("fuzzy_skin_point_distance", 0.3) * SCALE).max(1.0);
        let text = |key: &str| match cfg.raw.get(key) {
            Some(serde_json::Value::String(s)) => s.as_str(),
            _ => "",
        };
        let frequency = 1.0 / cfg.raw_number("fuzzy_skin_scale", 1.0).max(0.1);
        #[allow(clippy::cast_possible_truncation, reason = "an octave count of a few")]
        let octaves = (cfg.raw_number("fuzzy_skin_octaves", 4.0) as i32).clamp(1, 10);
        let persistence = cfg.raw_number("fuzzy_skin_persistence", 0.5);
        let source = match text("fuzzy_skin_noise_type") {
            "perlin" => Source::Noise(Noise::Perlin {
                frequency,
                octaves,
                persistence,
            }),
            "billow" => Source::Noise(Noise::Billow {
                frequency,
                octaves,
                persistence,
            }),
            "ridgedmulti" => Source::Noise(Noise::Ridged { frequency, octaves }),
            "voronoi" => Source::Noise(Noise::Voronoi { frequency }),
            "ripple" => Source::Ripple(Ripple {
                per_loop: cfg.raw_number("fuzzy_skin_ripples_per_layer", 15.0),
                offset_percent: cfg.raw_number("fuzzy_skin_ripple_offset", 50.0),
                #[allow(clippy::cast_possible_truncation, reason = "a layer count")]
                layers_between: cfg.raw_number("fuzzy_skin_layers_between_ripple_offset", 1.0) as i64,
            }),
            _ => Source::Uniform,
        };
        let mode = match text("fuzzy_skin_mode") {
            "extrusion" => Mode::Extrusion,
            "combined" => Mode::Combined,
            _ => Mode::Displacement,
        };
        (thickness > 0.0).then_some(Self {
            kind,
            thickness,
            distance,
            first_layer: crate::tower::flag(cfg, "fuzzy_skin_first_layer"),
            source,
            mode,
        })
    }

    /// Whether the wall `loop_idx` (0 is the outer one) of an outline or a hole gets fuzz on `layer`.
    pub(crate) fn applies(&self, layer: u32, loop_idx: u32, is_contour: bool) -> bool {
        if layer == 0 && !self.first_layer {
            return false;
        }
        let contours = (loop_idx == 0 && self.kind != Kind::Hole) || self.kind == Kind::AllWalls;
        let holes = matches!(self.kind, Kind::Hole | Kind::All | Kind::AllWalls)
            && (loop_idx == 0 || self.kind == Kind::AllWalls);
        if is_contour { contours } else { holes }
    }

    /// The new points of a closed ring: random spacing along each side (3/4 of the point distance plus up
    /// to half of it) with the noise at each, or evenly spaced for ripple. `seed` makes the random numbers
    /// repeatable; `z` is the slice height, mm.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "coordinates are i32 units and distances stay far below f64 precision"
    )]
    fn samples(&self, ring: &[IntPoint<i32>], seed: u64, z: f64, layer: u32) -> Vec<Sample> {
        let n = ring.len();
        if let Source::Ripple(r) = self.source {
            return self.ripple_samples(ring, r, layer);
        }
        let mut state = seed ^ 0x9e37_79b9_7f4a_7c15;
        let mut random = move || -> f64 {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut x = state;
            x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            x ^= x >> 31;
            (x >> 11) as f64 / (1u64 << 53) as f64
        };
        let min_dist = self.distance * 0.75;
        let range = self.distance * 0.5;
        let mut left = random() * (min_dist / 2.0);
        let mut out = Vec::with_capacity(n);
        let Some(&last) = ring.last() else {
            return out;
        };
        let mut p0 = last;
        for (idx, &p1) in ring.iter().enumerate() {
            let (dx, dy) = (
                f64::from(p1.x) - f64::from(p0.x),
                f64::from(p1.y) - f64::from(p0.y),
            );
            let size = dx.m_hypot(dy);
            let mut at = left;
            if size > 0.0 {
                while at < size {
                    let (ax, ay) = (f64::from(p0.x) + dx * at / size, f64::from(p0.y) + dy * at / size);
                    let value = match self.source {
                        Source::Noise(nz) => nz.value(ax / SCALE, ay / SCALE, z),
                        _ => random() * 2.0 - 1.0,
                    };
                    out.push(Sample {
                        at: (ax, ay),
                        // The direction rotated a quarter turn.
                        normal: (-dy / size, dx / size),
                        r: value * self.thickness,
                        end: idx,
                        ripple: false,
                    });
                    at += min_dist + random() * range;
                }
            }
            left = at - size;
            p0 = p1;
        }
        out
    }

    /// Orca `fuzzy_polyline_ripple`: points every point distance along the loop, each moved sideways by a
    /// sine of the arc length that peaks at the loop's leftmost crossing of y = 0, shifted by a share of a
    /// turn every `layers_between` layers.
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        reason = "coordinates are i32 units and distances stay far below f64 precision"
    )]
    fn ripple_samples(&self, ring: &[IntPoint<i32>], r: Ripple, layer: u32) -> Vec<Sample> {
        let n = ring.len();
        let (step, amplitude) = (self.distance / SCALE, self.thickness / SCALE);
        let pt = |i: usize| {
            ring.get(i % n)
                .map_or((0.0, 0.0), |p| (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE))
        };
        let perimeter: f64 = (0..n)
            .map(|i| (pt(i + 1).0 - pt(i).0).m_hypot(pt(i + 1).1 - pt(i).1))
            .sum();
        if r.per_loop <= 0.0 || step < 1e-6 || perimeter < 1e-6 || n < 3 {
            return Vec::new();
        }
        // The anchor: the leftmost crossing of y = 0, else the vertex nearest it.
        let mut anchor: Option<(f64, f64)> = None;
        for i in 0..n {
            let (a, b) = (pt(i), pt(i + 1));
            if (a.1 <= 0.0 && b.1 >= 0.0) || (a.1 >= 0.0 && b.1 <= 0.0) {
                let t = if (b.1 - a.1).abs() < 1e-9 {
                    0.0
                } else {
                    a.1 / (a.1 - b.1)
                };
                let x = a.0 + t.clamp(0.0, 1.0) * (b.0 - a.0);
                if anchor.is_none_or(|c| x < c.0) {
                    anchor = Some((x, 0.0));
                }
            }
        }
        let anchor = anchor.unwrap_or_else(|| {
            (0..n)
                .map(pt)
                .fold((f64::MAX, (0.0, 0.0)), |best, p| {
                    if p.1.abs() < best.0 { (p.1.abs(), p) } else { best }
                })
                .1
        });
        let (mut best, mut anchor_arc, mut accum) = (f64::MAX, 0.0, 0.0);
        for i in 0..n {
            let (a, b) = (pt(i), pt(i + 1));
            let (sx, sy) = (b.0 - a.0, b.1 - a.1);
            let len = sx.m_hypot(sy);
            if len > 1e-9 {
                let t = (((anchor.0 - a.0) * sx + (anchor.1 - a.1) * sy) / (len * len)).clamp(0.0, 1.0);
                let d = (a.0 + sx * t - anchor.0).m_powi(2) + (a.1 + sy * t - anchor.1).m_powi(2);
                if d < best {
                    best = d;
                    anchor_arc = accum + t * len;
                }
            }
            accum += len;
        }
        let tau = std::f64::consts::TAU;
        let shift = if r.offset_percent == 0.0 || r.layers_between <= 0 {
            0.0
        } else {
            let period = i64::from(layer) / r.layers_between.max(1);
            (period as f64 * (r.offset_percent / 100.0) * tau) % tau
        };
        let phase = |s: f64| r.per_loop * tau * (s - anchor_arc) / perimeter + tau + shift;
        let mut out = Vec::new();
        let mut accum = 0.0;
        for i in 0..n {
            let (a, b) = (pt(i), pt(i + 1));
            let (sx, sy) = (b.0 - a.0, b.1 - a.1);
            let len = sx.m_hypot(sy);
            if len < 1e-9 {
                continue;
            }
            let end = accum + len;
            let mut s = (accum / step).ceil() * step;
            while s < end {
                let t = (s - accum) / len;
                out.push(Sample {
                    at: ((a.0 + sx * t) * SCALE, (a.1 + sy * t) * SCALE),
                    normal: (-sy / len, sx / len),
                    r: phase(s).m_sin() * amplitude * SCALE,
                    end: (i + 1) % n,
                    ripple: true,
                });
                s += step;
            }
            accum = end;
        }
        out
    }

    /// The closed ring with fuzz, and for each new point the index of the original point nearest
    /// before it (so widths can follow). `seed` makes the random numbers repeatable.
    #[allow(clippy::cast_possible_truncation, reason = "coordinates are i32 units")]
    pub(crate) fn ring(
        &self,
        ring: &[IntPoint<i32>],
        seed: u64,
        z: f64,
        layer: u32,
    ) -> Vec<(IntPoint<i32>, usize)> {
        let n = ring.len();
        let out: Vec<(IntPoint<i32>, usize)> = self
            .samples(ring, seed, z, layer)
            .iter()
            .map(|s| {
                (
                    IntPoint::new(
                        (s.at.0 + s.normal.0 * s.r).round() as i32,
                        (s.at.1 + s.normal.1 * s.r).round() as i32,
                    ),
                    (s.end + n - 1) % n,
                )
            })
            .collect();
        if out.len() < 3 {
            return ring.iter().copied().zip(0..).collect();
        }
        out
    }

    /// A closed variable-width wall with fuzz: the points and a width for each. Displacement moves each
    /// point sideways and keeps the width of the junction the segment ends at; extrusion keeps the
    /// point and changes the width by the noise (never below almost nothing); combined does both, the
    /// point moving half the width change. Ripple always displaces.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "coordinates and widths are i32 units"
    )]
    pub(crate) fn wide(
        &self,
        ring: &[IntPoint<i32>],
        widths: &[i32],
        seed: u64,
        z: f64,
        layer: u32,
    ) -> (Vec<IntPoint<i32>>, Vec<i32>) {
        let (pts, ws, _) = self.wide_ends(ring, widths, seed, z, layer);
        (pts, ws)
    }

    /// The closed ring with fuzz only along the stretches inside `mask` (a painted area); elsewhere it keeps
    /// its points. Each fuzzed stretch starts and ends where the ring crosses the mask, unmoved, as Orca
    /// fuzzes the pieces of a loop inside a painted region (`apply_fuzzy_skin` with `split_line`). For
    /// each point, the index of the original point at or before it.
    pub(crate) fn ring_in(
        &self,
        ring: &[IntPoint<i32>],
        mask: &Shapes,
        seed: u64,
        z: f64,
        layer: u32,
    ) -> Vec<(IntPoint<i32>, usize)> {
        let cut = Cut::of(ring, None, mask);
        if !cut.inside.iter().any(|&i| i) {
            return ring.iter().copied().zip(0..).collect();
        }
        let n = cut.ring.len();
        // `ring` gives each point the index its edge starts at; the edge is named by the point it ends at.
        let samples: Vec<(IntPoint<i32>, i32, usize)> = self
            .ring(&cut.ring, seed, z, layer)
            .into_iter()
            .map(|(p, k)| (p, 0, (k + 1) % n))
            .collect();
        cut.join(&samples).into_iter().map(|(p, _, k)| (p, k)).collect()
    }

    /// [`Fuzzy::ring_in`] for a variable-width wall: the points and a width for each.
    pub(crate) fn wide_in(
        &self,
        ring: &[IntPoint<i32>],
        widths: &[i32],
        mask: &Shapes,
        seed: u64,
        z: f64,
        layer: u32,
    ) -> (Vec<IntPoint<i32>>, Vec<i32>) {
        let cut = Cut::of(ring, Some(widths), mask);
        if !cut.inside.iter().any(|&i| i) {
            return (ring.to_vec(), widths.to_vec());
        }
        let (pts, ws, ends) = self.wide_ends(&cut.ring, &cut.widths, seed, z, layer);
        let samples: Vec<(IntPoint<i32>, i32, usize)> = pts
            .into_iter()
            .zip(ws)
            .zip(ends)
            .map(|((p, w), e)| (p, w, e))
            .collect();
        cut.join(&samples).into_iter().map(|(p, w, _)| (p, w)).unzip()
    }

    /// [`Fuzzy::wide`] with the index of the point each new point's edge ends at.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "coordinates and widths are i32 units"
    )]
    fn wide_ends(
        &self,
        ring: &[IntPoint<i32>],
        widths: &[i32],
        seed: u64,
        z: f64,
        layer: u32,
    ) -> (Vec<IntPoint<i32>>, Vec<i32>, Vec<usize>) {
        let samples = self.samples(ring, seed, z, layer);
        if samples.len() < 3 {
            return (ring.to_vec(), widths.to_vec(), (0..ring.len()).collect());
        }
        let ends: Vec<usize> = samples.iter().map(|s| s.end % ring.len().max(1)).collect();
        let (mut pts, mut ws) = (
            Vec::with_capacity(samples.len()),
            Vec::with_capacity(samples.len()),
        );
        let n = ring.len();
        for s in &samples {
            // The width where the sample sits on its edge. Orca takes the edge's end width for every point along the
            // edge, which on a bead tapering into a junction gives long stretches the width of the narrow end.
            let w = {
                let b = s.end % n.max(1);
                let a = (b + n - 1) % n.max(1);
                let (wa, wb) = (
                    f64::from(widths.get(a).copied().unwrap_or(0)),
                    f64::from(widths.get(b).copied().unwrap_or(0)),
                );
                match (ring.get(a), ring.get(b)) {
                    (Some(pa), Some(pb)) => {
                        let (dx, dy) = (f64::from(pb.x - pa.x), f64::from(pb.y - pa.y));
                        let len2 = dx * dx + dy * dy;
                        let t = if len2 > 0.0 {
                            (((s.at.0 - f64::from(pa.x)) * dx + (s.at.1 - f64::from(pa.y)) * dy) / len2)
                                .clamp(0.0, 1.0)
                        } else {
                            1.0
                        };
                        wa + (wb - wa) * t
                    }
                    _ => wb,
                }
            };
            let (dx, dy, width) = match (self.mode, s.ripple) {
                (Mode::Extrusion, false) => (0.0, 0.0, (w + s.r + MIN_WIDTH).max(MIN_WIDTH)),
                (Mode::Combined, false) => {
                    let width = (w + s.r + MIN_WIDTH).max(MIN_WIDTH);
                    let m = (width - w) / 2.0;
                    (s.normal.0 * m, s.normal.1 * m, width)
                }
                _ => (s.normal.0 * s.r, s.normal.1 * s.r, w),
            };
            pts.push(IntPoint::new(
                (s.at.0 + dx).round() as i32,
                (s.at.1 + dy).round() as i32,
            ));
            ws.push(width.round() as i32);
        }
        (pts, ws, ends)
    }
}

/// A closed ring split where it crosses the boundary of a painted area, each edge marked inside or outside
/// by its middle. Edge `k` runs from point `k - 1` to point `k`, wrapping.
struct Cut {
    ring: Vec<IntPoint<i32>>,
    widths: Vec<i32>,
    /// For each point, the index of the original point at or before it.
    from: Vec<usize>,
    inside: Vec<bool>,
}

#[allow(
    clippy::indexing_slicing,
    clippy::needless_range_loop,
    reason = "indexes into the ring and its cut, each below its length, wrapping by the modulo"
)]
impl Cut {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "coordinates and widths are i32 units"
    )]
    fn of(ring: &[IntPoint<i32>], widths: Option<&[i32]>, mask: &Shapes) -> Self {
        let edges: Vec<(IntPoint<i32>, IntPoint<i32>)> = mask
            .iter()
            .flat_map(|sh| sh.iter())
            .flat_map(|r| (0..r.len()).map(move |i| (r[i], r[(i + 1) % r.len()])))
            .collect();
        let f = |p: IntPoint<i32>| (f64::from(p.x), f64::from(p.y));
        let n = ring.len();
        let mut out = Cut {
            ring: Vec::with_capacity(n),
            widths: Vec::with_capacity(n),
            from: Vec::with_capacity(n),
            inside: Vec::new(),
        };
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            let (wa, wb) = widths.map_or((0, 0), |w| {
                (
                    w.get(i).copied().unwrap_or(0),
                    w.get((i + 1) % n).copied().unwrap_or(0),
                )
            });
            out.ring.push(a);
            out.widths.push(wa);
            out.from.push(i);
            let ((ax, ay), (bx, by)) = (f(a), f(b));
            let (lo, hi) = ((ax.min(bx), ay.min(by)), (ax.max(bx), ay.max(by)));
            let mut ts: Vec<f64> = edges
                .iter()
                .filter_map(|&(c, d)| {
                    let ((cx, cy), (dx, dy)) = (f(c), f(d));
                    if cx.max(dx) < lo.0 || cx.min(dx) > hi.0 || cy.max(dy) < lo.1 || cy.min(dy) > hi.1 {
                        return None;
                    }
                    let (rx, ry, sx, sy) = (bx - ax, by - ay, dx - cx, dy - cy);
                    let den = rx * sy - ry * sx;
                    if den == 0.0 {
                        return None;
                    }
                    let t = ((cx - ax) * sy - (cy - ay) * sx) / den;
                    let u = ((cx - ax) * ry - (cy - ay) * rx) / den;
                    (t > 1e-6 && t < 1.0 - 1e-6 && (0.0..=1.0).contains(&u)).then_some(t)
                })
                .collect();
            ts.sort_by(f64::total_cmp);
            for t in ts {
                out.ring.push(IntPoint::new(
                    (ax + (bx - ax) * t).round() as i32,
                    (ay + (by - ay) * t).round() as i32,
                ));
                out.widths
                    .push((f64::from(wa) + f64::from(wb - wa) * t).round() as i32);
                out.from.push(i);
            }
        }
        let m = out.ring.len();
        out.inside = (0..m)
            .map(|k| {
                let (a, b) = (out.ring[(k + m - 1) % m], out.ring[k]);
                crate::support::point_in(mask, i32::midpoint(a.x, b.x), i32::midpoint(a.y, b.y))
            })
            .collect();
        out
    }

    /// The ring with the fuzzed points on every inside edge and the plain points elsewhere. `samples` are
    /// the fuzzed points of the whole ring, each with the edge it lies on, in ring order.
    fn join(&self, samples: &[(IntPoint<i32>, i32, usize)]) -> Vec<(IntPoint<i32>, i32, usize)> {
        let m = self.ring.len();
        let mut by_edge: Vec<Vec<(IntPoint<i32>, i32)>> = vec![Vec::new(); m];
        for &(p, w, e) in samples {
            if let Some(v) = by_edge.get_mut(e % m.max(1)) {
                v.push((p, w));
            }
        }
        let mut out = Vec::with_capacity(m + samples.len());
        for k in 0..m {
            let point = (self.ring[k], self.widths[k], self.from[k]);
            if !self.inside[k] {
                out.push(point);
                continue;
            }
            out.extend(by_edge[k].iter().map(|&(p, w)| (p, w, self.from[k])));
            // Where the ring leaves the area, the point stays where it is.
            if !self.inside[(k + 1) % m] {
                out.push(point);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(side: i32) -> Vec<IntPoint<i32>> {
        vec![
            IntPoint::new(0, 0),
            IntPoint::new(side, 0),
            IntPoint::new(side, side),
            IntPoint::new(0, side),
        ]
    }

    fn fuzzy(kind: Kind) -> Fuzzy {
        Fuzzy {
            kind,
            thickness: 3_000.0,
            distance: 8_000.0,
            first_layer: false,
            source: Source::Uniform,
            mode: Mode::Displacement,
        }
    }

    #[test]
    fn a_loop_gets_a_point_every_point_distance_within_the_thickness() {
        let f = fuzzy(Kind::External);
        let out = f.ring(&square(200_000), 7, 0.2, 1);
        // An 80 mm loop at 0.8 mm (units are tenths of a micrometer): around a hundred points.
        assert!((85..125).contains(&out.len()), "{}", out.len());
        // Every point is within the thickness of the square's outline.
        for (p, _) in &out {
            let d = [p.x.abs(), (p.x - 200_000).abs(), p.y.abs(), (p.y - 200_000).abs()]
                .into_iter()
                .min()
                .unwrap_or(0);
            assert!(d <= 3_001, "{p:?}");
        }
        assert_eq!(out, f.ring(&square(200_000), 7, 0.2, 1));
        assert_ne!(out, f.ring(&square(200_000), 8, 0.2, 1));
    }

    #[test]
    fn a_painted_area_roughens_only_the_stretch_inside_it() {
        let f = fuzzy(Kind::All);
        // The right half of the square, a little past its outline.
        let mask: Shapes = vec![vec![vec![
            IntPoint::new(100_000, -10_000),
            IntPoint::new(210_000, -10_000),
            IntPoint::new(210_000, 210_000),
            IntPoint::new(100_000, 210_000),
        ]]];
        let out = f.ring_in(&square(200_000), &mask, 7, 0.2, 1);
        let (left, right): (Vec<_>, Vec<_>) = out.iter().map(|(p, _)| *p).partition(|p| p.x < 100_000);
        // The left half keeps its two corners as they are; the right half gets fuzz.
        assert!(
            left.contains(&IntPoint::new(0, 0))
                && left.contains(&IntPoint::new(0, 200_000))
                && left.len() == 2,
            "{left:?}"
        );
        assert!(right.len() > 30, "{}", right.len());
        // Where the ring enters and leaves the area, the point is on the outline, unmoved.
        assert!(
            out.iter().any(|(p, _)| *p == IntPoint::new(100_000, 0))
                && out.iter().any(|(p, _)| *p == IntPoint::new(100_000, 200_000))
        );
        // No paint here: the ring as it was.
        let none: Shapes = vec![vec![vec![
            IntPoint::new(500_000, 0),
            IntPoint::new(600_000, 0),
            IntPoint::new(600_000, 100_000),
        ]]];
        assert_eq!(f.ring_in(&square(200_000), &none, 7, 0.2, 1).len(), 4);
        // The widths of a variable-width wall follow the same cut.
        let (pts, ws) = f.wide_in(&square(200_000), &[4_000; 4], &mask, 7, 0.2, 1);
        assert_eq!(pts.len(), ws.len());
        assert!(pts.len() > 30);
    }

    fn with(source: Source, mode: Mode) -> Fuzzy {
        Fuzzy {
            source,
            mode,
            ..fuzzy(Kind::External)
        }
    }

    #[test]
    fn ripple_is_a_sine_along_the_loop_that_every_layer_group_shifts() {
        let ripple = |offset: f64| {
            with(
                Source::Ripple(Ripple {
                    per_loop: 10.0,
                    offset_percent: offset,
                    layers_between: 2,
                }),
                Mode::Displacement,
            )
        };
        let sq = square(200_000);
        let a = ripple(50.0).ring(&sq, 1, 0.2, 2);
        // Points every 0.8 mm on an 80 mm loop, none off by more than the amplitude.
        assert!((98..=104).contains(&a.len()), "{}", a.len());
        // No randomness: the seed changes nothing.
        assert_eq!(a, ripple(50.0).ring(&sq, 99, 0.2, 2));
        // Layers 2 and 3 share a pattern, layer 4 is shifted by half a turn.
        assert_eq!(a, ripple(50.0).ring(&sq, 1, 0.2, 3));
        assert_ne!(a, ripple(50.0).ring(&sq, 1, 0.2, 4));
        assert_eq!(ripple(0.0).ring(&sq, 1, 0.2, 2), ripple(0.0).ring(&sq, 1, 0.2, 6));
    }

    #[test]
    fn the_modes_move_the_point_the_width_or_both() {
        let sq = square(200_000);
        let widths = vec![4_000; 4];
        let run = |mode| {
            let f = with(
                Source::Noise(Noise::Perlin {
                    frequency: 1.0,
                    octaves: 4,
                    persistence: 0.5,
                }),
                mode,
            );
            f.wide(&sq, &widths, 5, 0.3, 3)
        };
        let off_line = |p: &IntPoint<i32>| {
            [p.x.abs(), (p.x - 200_000).abs(), p.y.abs(), (p.y - 200_000).abs()]
                .into_iter()
                .min()
                .unwrap_or(0)
        };
        let (dp, dw) = run(Mode::Displacement);
        assert!(dw.iter().all(|w| *w == 4_000) && dp.iter().any(|p| off_line(p) > 100));
        let (ep, ew) = run(Mode::Extrusion);
        assert!(ep.iter().all(|p| off_line(p) <= 1), "extrusion keeps the line");
        assert!(ew.iter().any(|w| *w != 4_000) && ew.iter().all(|w| *w >= 1));
        let (cp, cw) = run(Mode::Combined);
        assert_eq!(cw, ew);
        // Combined: the point moves half the width change.
        assert!(cp.iter().zip(&cw).any(|(p, w)| off_line(p) > 10 && *w != 4_000));
    }

    #[test]
    fn the_kind_picks_the_loops() {
        let (ext, all, walls, holes) = (
            fuzzy(Kind::External),
            fuzzy(Kind::All),
            fuzzy(Kind::AllWalls),
            fuzzy(Kind::Hole),
        );
        // (layer 1) outer wall of an outline, of a hole, inner wall of an outline.
        assert!(ext.applies(1, 0, true) && !ext.applies(1, 0, false) && !ext.applies(1, 1, true));
        assert!(all.applies(1, 0, true) && all.applies(1, 0, false) && !all.applies(1, 1, true));
        assert!(walls.applies(1, 0, true) && walls.applies(1, 2, true) && walls.applies(1, 1, false));
        assert!(!holes.applies(1, 0, true) && holes.applies(1, 0, false));
        // The first layer stays smooth unless asked.
        assert!(!ext.applies(0, 0, true));
    }
}
