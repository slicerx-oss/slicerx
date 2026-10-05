// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Regions that cannot print without support, found from the mesh so the check costs little when support is
//! off (Orca checks the same two cases by running its tree support detection: `PrintObject::is_support_necessary`
//! with sharp tails and cantilevers longer than 6 mm):
//!
//! - a floating region: a lowest point or lowest flat face of a part (no neighbor lower on the mesh) above the
//!   first layer with nothing of any part under it;
//! - a long overhang: a patch of nearly flat downward faces whose farthest point lies more than 6 mm from the
//!   material of the layer under it;
//! - a long bridge: such a patch whose every strand lands on material at both ends, reported when its longest
//!   strand is longer than `max_bridge_length` (Orca's `PrintObject::remove_bridges_from_contacts` leaves a
//!   bridge unsupported only up to that length; anything shorter is a bridge, not an overhang).
//!
//! Each finding carries its layers, where it is and how far it reaches.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::indexing_slicing,
    clippy::float_cmp,
    clippy::manual_midpoint,
    reason = "mesh vertex indices and layer indices, plate coordinates in mm; welded vertices on one plane share their exact height"
)]

use crate::fm::Fm as _;
use crate::perimeters::Shapes;

/// How far an overhang may reach past what holds it before it is reported, mm (Orca's threshold).
const CANTILEVER_MM: f64 = 6.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Floating,
    Overhang,
    Bridge,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Finding {
    pub(crate) kind: Kind,
    /// First and last layer it spans.
    pub(crate) layers: (u32, u32),
    /// Where it is, mm.
    pub(crate) at: [f64; 2],
    /// How far an overhang reaches past what holds it, or a bridge's longest strand, mm (0 for a floating region).
    pub(crate) reach: f64,
    /// The height it starts at, mm.
    pub(crate) z: f64,
}

/// What the finder reads about the layers.
pub(crate) struct Layers<'a> {
    /// Layer tops, mm, ascending.
    pub(crate) tops: &'a [f64],
    /// The outline of every part on a layer.
    pub(crate) slice: &'a (dyn Fn(usize) -> Shapes + Sync),
    /// Overhangs flatter than this angle from horizontal need support, degrees.
    pub(crate) threshold_deg: f64,
    /// Bridges up to this long need no support (`max_bridge_length`), mm.
    pub(crate) max_bridge_mm: f64,
}

/// What a patch of flat downward faces is over the layer under it.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Patch {
    /// Every strand across it lands on `under` at both ends: the longest strand and its middle, mm.
    Bridge { span: f64, at: [f64; 2] },
    /// Some strand hangs free at an end, or nothing of it is unsupported.
    Other,
}

/// How far a strand reaches into what holds it before it counts as landed, mm.
const LAND_MM: f64 = 0.5;

/// How far the layer under a patch is grown before the patch counts as unheld, mm.
const HELD_MM: f64 = 0.2;

/// The patch (triangles, mm) over `under`: the part `under` does not hold (grown by a little, as Orca grows
/// the lower layer by half a line), crossed in the bridging direction (`bridging::direction`) by strands at
/// most half a millimeter apart. Slivers under a square millimeter and strands under half a millimeter are
/// left out.
fn classify(tris: &[[[f64; 3]; 3]], under: &Shapes) -> Patch {
    use crate::geom::{SCALE, mm};
    use i_overlay::i_float::int::point::IntPoint;
    let ring = |t: &[[f64; 3]; 3]| -> Vec<IntPoint<i32>> {
        let mut r: Vec<IntPoint<i32>> = t.iter().map(|p| IntPoint::new(mm(p[0]), mm(p[1]))).collect();
        let area = (i64::from(r[1].x) - i64::from(r[0].x)) * (i64::from(r[2].y) - i64::from(r[0].y))
            - (i64::from(r[2].x) - i64::from(r[0].x)) * (i64::from(r[1].y) - i64::from(r[0].y));
        if area < 0 {
            r.swap(1, 2);
        }
        r
    };
    let flat: Shapes = tris.iter().map(|t| vec![ring(t)]).collect();
    let region = crate::perimeters::union_all(&[&flat]);
    let held = crate::perimeters::offset(under, mm(HELD_MM));
    let free: Shapes = crate::perimeters::difference(&region, &held)
        .into_iter()
        .filter(|sh| {
            let a: f64 = sh
                .iter()
                .map(|r| {
                    let n = r.len();
                    (0..n)
                        .map(|i| {
                            let (p, q) = (r[i], r[(i + 1) % n]);
                            f64::from(p.x) * f64::from(q.y) - f64::from(q.x) * f64::from(p.y)
                        })
                        .sum::<f64>()
                        / 2.0
                })
                .sum::<f64>()
                .abs();
            a / (SCALE * SCALE) >= 1.0
        })
        .collect();
    if free.is_empty() {
        return Patch::Other;
    }
    let angle = crate::bridging::direction(&free, &held);
    let (d, n) = ([angle.m_cos(), angle.m_sin()], [-angle.m_sin(), angle.m_cos()]);
    let edges: Vec<([f64; 2], [f64; 2])> = free
        .iter()
        .flat_map(|sh| sh.iter())
        .flat_map(|r| {
            let k = r.len();
            (0..k).map(move |i| (r[i], r[(i + 1) % k]))
        })
        .map(|(p, q)| {
            let uv = |p: IntPoint<i32>| {
                let (x, y) = (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE);
                [x * d[0] + y * d[1], x * n[0] + y * n[1]]
            };
            (uv(p), uv(q))
        })
        .collect();
    let (vlo, vhi) = edges.iter().fold((f64::MAX, f64::MIN), |(lo, hi), (a, b)| {
        (lo.min(a[1]).min(b[1]), hi.max(a[1]).max(b[1]))
    });
    let step = ((vhi - vlo) / 64.0).max(0.5);
    let landed = |u: f64, v: f64| {
        let (x, y) = (u * d[0] + v * n[0], u * d[1] + v * n[1]);
        crate::support::point_in(under, mm(x), mm(y))
    };
    let mut best: Option<(f64, [f64; 2])> = None;
    let mut v = vlo + step / 2.0;
    while v < vhi {
        let mut us: Vec<f64> = edges
            .iter()
            .filter(|(a, b)| (a[1] <= v) != (b[1] <= v))
            .map(|(a, b)| a[0] + (v - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
            .collect();
        us.sort_by(f64::total_cmp);
        for &[u0, u1] in us.as_chunks::<2>().0 {
            if u1 - u0 < 0.5 {
                continue;
            }
            if !(landed(u0 - LAND_MM, v) && landed(u1 + LAND_MM, v)) {
                return Patch::Other;
            }
            // The strand spans from what holds it to what holds it: the grown margin back on both ends.
            let span = u1 - u0 + 2.0 * HELD_MM;
            if best.is_none_or(|(s, _)| span > s) {
                let u = (u0 + u1) / 2.0;
                best = Some((span, [u * d[0] + v * n[0], u * d[1] + v * n[1]]));
            }
        }
        v += step;
    }
    best.map_or(Patch::Other, |(span, at)| Patch::Bridge { span, at })
}

/// The layer whose top is at or above `z`: the last layer something ending at `z` prints on.
fn layer_at(tops: &[f64], z: f64) -> usize {
    tops.partition_point(|&t| t < z - 1e-6)
        .min(tops.len().saturating_sub(1))
}

/// The first layer above `z`: the first layer something starting at `z` prints on.
fn layer_above(tops: &[f64], z: f64) -> usize {
    tops.partition_point(|&t| t <= z + 1e-6)
        .min(tops.len().saturating_sub(1))
}

/// Distance in mm from `p` to the area `s` (0 inside).
fn distance_to(s: &Shapes, p: [f64; 2]) -> f64 {
    let q = (crate::geom::mm(p[0]), crate::geom::mm(p[1]));
    if crate::support::point_in(s, q.0, q.1) {
        return 0.0;
    }
    let mut best = f64::MAX;
    for r in s.iter().flat_map(|sh| sh.iter()) {
        let n = r.len();
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            let a = [
                f64::from(a.x) / crate::geom::SCALE,
                f64::from(a.y) / crate::geom::SCALE,
            ];
            let b = [
                f64::from(b.x) / crate::geom::SCALE,
                f64::from(b.y) / crate::geom::SCALE,
            ];
            let v = [b[0] - a[0], b[1] - a[1]];
            let l2 = v[0] * v[0] + v[1] * v[1];
            let t = if l2 > 0.0 {
                (((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let d = (a[0] + v[0] * t - p[0]).m_hypot(a[1] + v[1] * t - p[1]);
            best = best.min(d);
        }
    }
    best
}

/// The parallel finder (native builds): parts, plateaus and patches in parallel, each layer's outline cut once.
#[cfg(feature = "parallel")]
mod parallel {
    use super::{CANTILEVER_MM, Finding, Kind, Layers, Patch, classify, distance_to, layer_above, layer_at};
    use crate::contours::PreparedPart;
    use crate::fm::Fm as _;
    use crate::perimeters::Shapes;
    use std::borrow::Cow;
    use std::sync::OnceLock;

    /// Neighbors of every vertex of a part, each list ascending without repeats: vertex `v`'s are
    /// `list[start[v]..start[v + 1]]`.
    struct Neighbors {
        start: Vec<u32>,
        list: Vec<u32>,
    }

    impl Neighbors {
        fn of(part: &PreparedPart) -> Self {
            let n = part.verts.len();
            let mut start = vec![0u32; n + 1];
            for t in &part.tris {
                for k in 0..3 {
                    start[t[k] as usize + 1] += 2;
                }
            }
            let mut acc = 0;
            for s in &mut start {
                acc += *s;
                *s = acc;
            }
            let mut fill = start.clone();
            let mut raw = vec![0u32; start[n] as usize];
            for t in &part.tris {
                for k in 0..3 {
                    let (a, b) = (t[k], t[(k + 1) % 3]);
                    raw[fill[a as usize] as usize] = b;
                    fill[a as usize] += 1;
                    raw[fill[b as usize] as usize] = a;
                    fill[b as usize] += 1;
                }
            }
            // Sort and drop repeats in place, packing the lists to the front (a list never moves past its own start).
            drop(fill);
            let (mut kept, mut a) = (0usize, 0usize);
            for v in 0..n {
                let b = start[v + 1] as usize;
                raw[a..b].sort_unstable();
                start[v] = kept as u32;
                let mut last = None;
                for i in a..b {
                    let w = raw[i];
                    if last != Some(w) {
                        raw[kept] = w;
                        kept += 1;
                        last = Some(w);
                    }
                }
                a = b;
            }
            start[n] = kept as u32;
            raw.truncate(kept);
            raw.shrink_to_fit();
            Self { start, list: raw }
        }

        fn of_vertex(&self, v: usize) -> &[u32] {
            &self.list[self.start[v] as usize..self.start[v + 1] as usize]
        }
    }

    /// The highest vertex of the connected shell holding vertex `start`.
    fn shell_top(part: &PreparedPart, nb: &Neighbors, start: u32) -> f64 {
        let mut seen = vec![false; part.verts.len()];
        let mut stack = vec![start];
        let mut top = f64::MIN;
        while let Some(v) = stack.pop() {
            if std::mem::replace(&mut seen[v as usize], true) {
                continue;
            }
            top = top.max(part.verts[v as usize][2]);
            stack.extend(
                nb.of_vertex(v as usize)
                    .iter()
                    .copied()
                    .filter(|&w| !seen[w as usize]),
            );
        }
        top
    }

    /// Every floating region and long overhang of `parts`.
    pub(crate) fn find(parts: &[PreparedPart], layers: &Layers<'_>) -> Vec<Finding> {
        let tops = layers.tops;
        if tops.len() < 2 {
            return Vec::new();
        }
        // Each layer's outline is cut once, by whichever part asks for it first.
        let slices: Vec<OnceLock<Shapes>> = (0..tops.len()).map(|_| OnceLock::new()).collect();
        crate::par::map(parts, |part| find_in(part, layers, &slices))
            .into_iter()
            .flatten()
            .collect()
    }

    /// The outline of layer `l`, cut once into `slices`.
    fn cut<'s>(slices: &'s [OnceLock<Shapes>], layers: &Layers<'_>, l: usize) -> Cow<'s, Shapes> {
        use crate::par::Init as _;
        match slices.get(l) {
            Some(s) => Cow::Borrowed(s.once(|| (layers.slice)(l))),
            None => Cow::Owned((layers.slice)(l)),
        }
    }

    /// [`find`] for one part.
    fn find_in(part: &PreparedPart, layers: &Layers<'_>, slices: &[OnceLock<Shapes>]) -> Vec<Finding> {
        let below = |l: usize| cut(slices, layers, l);
        let tops = layers.tops;
        let first_top = tops[0];
        let mut out: Vec<Finding> = Vec::new();
        let flat = layers.threshold_deg.clamp(1.0, 89.0).to_radians().m_cos();
        let nb = Neighbors::of(part);
        // Floating regions: plateaus of equal height with no lower neighbor, found in vertex order, then checked
        // against the layer under them in parallel.
        let mut done = vec![false; part.verts.len()];
        let mut plateaus: Vec<(Vec<u32>, usize)> = Vec::new();
        for v0 in 0..part.verts.len() {
            if done[v0] || nb.of_vertex(v0).is_empty() {
                continue;
            }
            let z = part.verts[v0][2];
            let mut plateau = vec![v0 as u32];
            let mut lowest = true;
            let mut k = 0;
            done[v0] = true;
            while k < plateau.len() {
                let v = plateau[k] as usize;
                k += 1;
                for &w in nb.of_vertex(v) {
                    let wz = part.verts[w as usize][2];
                    if wz < z {
                        lowest = false;
                    } else if wz == z && !done[w as usize] {
                        done[w as usize] = true;
                        plateau.push(w);
                    }
                }
            }
            if !lowest || z <= first_top + 1e-6 {
                continue;
            }
            let l = layer_above(tops, z);
            if l == 0 {
                continue;
            }
            plateaus.push((plateau, l));
        }
        let floating: Vec<Option<Finding>> = crate::par::map(&plateaus, |(plateau, l)| {
            let l = *l;
            let z = part.verts[plateau[0] as usize][2];
            let under = below(l - 1);
            // Something within half a millimeter under any of its points holds it.
            let held = plateau.iter().any(|&v| {
                let p = part.verts[v as usize];
                distance_to(&under, [p[0], p[1]]) < 0.5
            });
            if held {
                return None;
            }
            let n = plateau.len() as f64;
            let at = plateau.iter().fold([0.0, 0.0], |a, &v| {
                [
                    a[0] + part.verts[v as usize][0] / n,
                    a[1] + part.verts[v as usize][1] / n,
                ]
            });
            let top = layer_at(tops, shell_top(part, &nb, plateau[0])).max(l);
            Some(Finding {
                kind: Kind::Floating,
                layers: (l as u32, top as u32),
                at,
                reach: 0.0,
                z,
            })
        });
        let mut floating_vertex = vec![false; part.verts.len()];
        for ((plateau, _), f) in plateaus.iter().zip(floating) {
            if let Some(f) = f {
                for &v in plateau {
                    floating_vertex[v as usize] = true;
                }
                out.push(f);
            }
        }
        drop((nb, plateaus, done));
        // Long overhangs: patches of downward faces flatter than the threshold.
        let down: Vec<bool> = part
            .tris
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| part.verts[i as usize]);
                let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let nx = u[1] * w[2] - u[2] * w[1];
                let ny = u[2] * w[0] - u[0] * w[2];
                let nz = u[0] * w[1] - u[1] * w[0];
                let len = (nx * nx + ny * ny + nz * nz).sqrt();
                len > 0.0 && -nz / len > flat
            })
            .collect();
        // Faces sharing an edge belong to one patch: the downward faces by edge, each edge's faces ascending.
        let mut edge_faces: Vec<(u64, u32)> = Vec::new();
        for (fi, t) in part.tris.iter().enumerate().filter(|(fi, _)| down[*fi]) {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                edge_faces.push(((u64::from(a.min(b)) << 32) | u64::from(a.max(b)), fi as u32));
            }
        }
        crate::par::sort(&mut edge_faces);
        let faces_of = |a: u32, b: u32| {
            let key = (u64::from(a.min(b)) << 32) | u64::from(a.max(b));
            let lo = edge_faces.partition_point(|e| e.0 < key);
            let hi = lo + edge_faces[lo..].partition_point(|e| e.0 == key);
            &edge_faces[lo..hi]
        };
        let mut seen = vec![false; part.tris.len()];
        let mut patches: Vec<(Vec<usize>, Vec<u32>)> = Vec::new();
        for f0 in 0..part.tris.len() {
            if !down[f0] || seen[f0] {
                continue;
            }
            let mut patch = vec![f0];
            seen[f0] = true;
            let mut k = 0;
            while k < patch.len() {
                let t = part.tris[patch[k]];
                k += 1;
                for e in 0..3 {
                    let (a, b) = (t[e], t[(e + 1) % 3]);
                    for &(_, g) in faces_of(a, b) {
                        let g = g as usize;
                        if !seen[g] {
                            seen[g] = true;
                            patch.push(g);
                        }
                    }
                }
            }
            let mut verts: Vec<u32> = patch.iter().flat_map(|&f| part.tris[f]).collect();
            verts.sort_unstable();
            verts.dedup();
            patches.push((patch, verts));
        }
        drop((edge_faces, seen, down));
        let overhangs: Vec<Option<Finding>> = crate::par::map(&patches, |(patch, verts)| {
            let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
            let (mut zlo, mut zhi) = (f64::MAX, f64::MIN);
            for &v in verts {
                let p = part.verts[v as usize];
                lo = [lo[0].min(p[0]), lo[1].min(p[1])];
                hi = [hi[0].max(p[0]), hi[1].max(p[1])];
                zlo = zlo.min(p[2]);
                zhi = zhi.max(p[2]);
            }
            // The underside of a floating region is reported as that region.
            if zlo <= first_top + 1e-6
                || (hi[0] - lo[0]).m_hypot(hi[1] - lo[1]) <= CANTILEVER_MM
                || verts.iter().any(|&v| floating_vertex[v as usize])
            {
                return None;
            }
            // A bridge is fine up to the longest one left without support; past it, it is reported as a bridge.
            let first = layer_above(tops, zlo);
            if first > 0 {
                let tris: Vec<[[f64; 3]; 3]> = patch
                    .iter()
                    .map(|&f| part.tris[f].map(|i| part.verts[i as usize]))
                    .collect();
                if let Patch::Bridge { span, at } = classify(&tris, &below(first - 1)) {
                    return (span > layers.max_bridge_mm).then(|| Finding {
                        kind: Kind::Bridge,
                        layers: (first as u32, layer_at(tops, zhi).max(first) as u32),
                        at,
                        reach: span,
                        z: zlo,
                    });
                }
            }
            // How far each point lies from the material of the layer under it; edge midpoints too, so a long
            // edge between two held corners still counts.
            let mut probes: Vec<[f64; 3]> = verts.iter().map(|&v| part.verts[v as usize]).collect();
            for &f in patch {
                let t = part.tris[f].map(|i| part.verts[i as usize]);
                for e in 0..3 {
                    let (a, b) = (t[e], t[(e + 1) % 3]);
                    probes.push([(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0]);
                }
            }
            let mut best = (0.0_f64, [0.0, 0.0]);
            for p in &probes {
                let l = layer_above(tops, p[2]);
                if l == 0 {
                    continue;
                }
                let d = distance_to(&below(l - 1), [p[0], p[1]]);
                if d > best.0 {
                    best = (d, [p[0], p[1]]);
                }
            }
            (best.0 > CANTILEVER_MM).then(|| Finding {
                kind: Kind::Overhang,
                layers: (
                    layer_above(tops, zlo) as u32,
                    layer_at(tops, zhi).max(layer_above(tops, zlo)) as u32,
                ),
                at: best.1,
                reach: best.0,
                z: zlo,
            })
        });
        out.extend(overhangs.into_iter().flatten());
        out
    }
}

#[cfg(feature = "parallel")]
pub(crate) use parallel::find;

/// The finder in one pass (WASM, which has no threads), the same findings in the same order.
#[cfg(not(feature = "parallel"))]
mod serial {
    use super::{CANTILEVER_MM, Finding, Kind, Layers, Patch, classify, distance_to, layer_above, layer_at};
    use crate::contours::PreparedPart;
    use crate::fm::Fm as _;
    use crate::perimeters::Shapes;
    use std::collections::HashMap;

    /// Neighbors of every vertex of a part.
    fn neighbors(part: &PreparedPart) -> Vec<Vec<u32>> {
        let mut n: Vec<Vec<u32>> = vec![Vec::new(); part.verts.len()];
        for t in &part.tris {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                n[a as usize].push(b);
                n[b as usize].push(a);
            }
        }
        for v in &mut n {
            v.sort_unstable();
            v.dedup();
        }
        n
    }

    /// The highest vertex of the connected shell holding vertex `start`.
    fn shell_top(part: &PreparedPart, nb: &[Vec<u32>], start: u32) -> f64 {
        let mut seen = vec![false; part.verts.len()];
        let mut stack = vec![start];
        let mut top = f64::MIN;
        while let Some(v) = stack.pop() {
            if std::mem::replace(&mut seen[v as usize], true) {
                continue;
            }
            top = top.max(part.verts[v as usize][2]);
            stack.extend(nb[v as usize].iter().copied().filter(|&w| !seen[w as usize]));
        }
        top
    }

    /// Every floating region and long overhang of `parts`.
    pub(crate) fn find(parts: &[PreparedPart], layers: &Layers<'_>) -> Vec<Finding> {
        let tops = layers.tops;
        if tops.len() < 2 {
            return Vec::new();
        }
        let first_top = tops[0];
        let mut slices: HashMap<usize, Shapes> = HashMap::new();
        let mut below = |l: usize| -> Shapes { slices.entry(l).or_insert_with(|| (layers.slice)(l)).clone() };
        let mut out: Vec<Finding> = Vec::new();
        let flat = layers.threshold_deg.clamp(1.0, 89.0).to_radians().m_cos();
        for part in parts {
            let nb = neighbors(part);
            // Floating regions: plateaus of equal height with no lower neighbor.
            let mut done = vec![false; part.verts.len()];
            let mut floating_vertex = vec![false; part.verts.len()];
            for v0 in 0..part.verts.len() {
                if done[v0] || nb[v0].is_empty() {
                    continue;
                }
                let z = part.verts[v0][2];
                let mut plateau = vec![v0 as u32];
                let mut lowest = true;
                let mut k = 0;
                done[v0] = true;
                while k < plateau.len() {
                    let v = plateau[k] as usize;
                    k += 1;
                    for &w in &nb[v] {
                        let wz = part.verts[w as usize][2];
                        if wz < z {
                            lowest = false;
                        } else if wz == z && !done[w as usize] {
                            done[w as usize] = true;
                            plateau.push(w);
                        }
                    }
                }
                if !lowest || z <= first_top + 1e-6 {
                    continue;
                }
                let l = layer_above(tops, z);
                if l == 0 {
                    continue;
                }
                let under = below(l - 1);
                // Something within half a millimeter under any of its points holds it.
                let held = plateau.iter().any(|&v| {
                    let p = part.verts[v as usize];
                    distance_to(&under, [p[0], p[1]]) < 0.5
                });
                if held {
                    continue;
                }
                let n = plateau.len() as f64;
                let at = plateau.iter().fold([0.0, 0.0], |a, &v| {
                    [
                        a[0] + part.verts[v as usize][0] / n,
                        a[1] + part.verts[v as usize][1] / n,
                    ]
                });
                let top = layer_at(tops, shell_top(part, &nb, plateau[0])).max(l);
                for &v in &plateau {
                    floating_vertex[v as usize] = true;
                }
                out.push(Finding {
                    kind: Kind::Floating,
                    layers: (l as u32, top as u32),
                    at,
                    reach: 0.0,
                    z,
                });
            }
            // Long overhangs: patches of downward faces flatter than the threshold.
            let down: Vec<bool> = part
                .tris
                .iter()
                .map(|t| {
                    let [a, b, c] = t.map(|i| part.verts[i as usize]);
                    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                    let nx = u[1] * w[2] - u[2] * w[1];
                    let ny = u[2] * w[0] - u[0] * w[2];
                    let nz = u[0] * w[1] - u[1] * w[0];
                    let len = (nx * nx + ny * ny + nz * nz).sqrt();
                    len > 0.0 && -nz / len > flat
                })
                .collect();
            // Faces sharing an edge belong to one patch.
            let mut edge_faces: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
            for (fi, t) in part.tris.iter().enumerate().filter(|(fi, _)| down[*fi]) {
                for k in 0..3 {
                    let (a, b) = (t[k], t[(k + 1) % 3]);
                    edge_faces.entry((a.min(b), a.max(b))).or_default().push(fi);
                }
            }
            let mut seen = vec![false; part.tris.len()];
            for f0 in 0..part.tris.len() {
                if !down[f0] || seen[f0] {
                    continue;
                }
                let mut patch = vec![f0];
                seen[f0] = true;
                let mut k = 0;
                while k < patch.len() {
                    let t = part.tris[patch[k]];
                    k += 1;
                    for e in 0..3 {
                        let (a, b) = (t[e], t[(e + 1) % 3]);
                        for &g in edge_faces
                            .get(&(a.min(b), a.max(b)))
                            .map_or(&[][..], Vec::as_slice)
                        {
                            if !seen[g] {
                                seen[g] = true;
                                patch.push(g);
                            }
                        }
                    }
                }
                let mut verts: Vec<u32> = patch.iter().flat_map(|&f| part.tris[f]).collect();
                verts.sort_unstable();
                verts.dedup();
                let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
                let (mut zlo, mut zhi) = (f64::MAX, f64::MIN);
                for &v in &verts {
                    let p = part.verts[v as usize];
                    lo = [lo[0].min(p[0]), lo[1].min(p[1])];
                    hi = [hi[0].max(p[0]), hi[1].max(p[1])];
                    zlo = zlo.min(p[2]);
                    zhi = zhi.max(p[2]);
                }
                // The underside of a floating region is reported as that region.
                if zlo <= first_top + 1e-6
                    || (hi[0] - lo[0]).m_hypot(hi[1] - lo[1]) <= CANTILEVER_MM
                    || verts.iter().any(|&v| floating_vertex[v as usize])
                {
                    continue;
                }
                // A bridge is fine up to the longest one left without support; past it, it is reported as a bridge.
                let first = layer_above(tops, zlo);
                if first > 0 {
                    let tris: Vec<[[f64; 3]; 3]> = patch
                        .iter()
                        .map(|&f| part.tris[f].map(|i| part.verts[i as usize]))
                        .collect();
                    if let Patch::Bridge { span, at } = classify(&tris, &below(first - 1)) {
                        if span > layers.max_bridge_mm {
                            out.push(Finding {
                                kind: Kind::Bridge,
                                layers: (first as u32, layer_at(tops, zhi).max(first) as u32),
                                at,
                                reach: span,
                                z: zlo,
                            });
                        }
                        continue;
                    }
                }
                // How far each point lies from the material of the layer under it; edge midpoints too, so a long
                // edge between two held corners still counts.
                let mut probes: Vec<[f64; 3]> = verts.iter().map(|&v| part.verts[v as usize]).collect();
                for &f in &patch {
                    let t = part.tris[f].map(|i| part.verts[i as usize]);
                    for e in 0..3 {
                        let (a, b) = (t[e], t[(e + 1) % 3]);
                        probes.push([(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0]);
                    }
                }
                let mut best = (0.0_f64, [0.0, 0.0]);
                for p in &probes {
                    let l = layer_above(tops, p[2]);
                    if l == 0 {
                        continue;
                    }
                    let d = distance_to(&below(l - 1), [p[0], p[1]]);
                    if d > best.0 {
                        best = (d, [p[0], p[1]]);
                    }
                }
                if best.0 > CANTILEVER_MM {
                    out.push(Finding {
                        kind: Kind::Overhang,
                        layers: (
                            layer_above(tops, zlo) as u32,
                            layer_at(tops, zhi).max(layer_above(tops, zlo)) as u32,
                        ),
                        at: best.1,
                        reach: best.0,
                        z: zlo,
                    });
                }
            }
        }
        out
    }
}

#[cfg(not(feature = "parallel"))]
pub(crate) use serial::find;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contours::PreparedPart;

    fn cuboid(x: [f64; 2], y: [f64; 2], z: [f64; 2]) -> Part {
        let v: Vec<[f64; 3]> = (0..8)
            .map(|i| [x[i & 1], y[(i >> 1) & 1], z[(i >> 2) & 1]])
            .collect();
        let t = vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ];
        (v, t)
    }

    type Part = (Vec<[f64; 3]>, Vec<[u32; 3]>);

    fn run(parts: &[Part], max_z: f64) -> Vec<Finding> {
        let plan = crate::layers::LayerPlan::new(max_z, 0.2, 0.2);
        let prepared: Vec<PreparedPart> = parts
            .iter()
            .map(|(v, t)| PreparedPart::new(1, v.clone(), t.clone(), &plan))
            .collect();
        let tops: Vec<f64> = (0..plan.count()).map(|l| plan.top(l)).collect();
        let slice = |l: usize| -> Shapes {
            let z = plan.slice_z.get(l).copied().unwrap_or(0.0);
            let mut loops = Vec::new();
            for p in &prepared {
                p.slice(l, z, &mut loops);
            }
            crate::perimeters::shapes_from_loops(&loops)
        };
        find(
            &prepared,
            &Layers {
                tops: &tops,
                slice: &slice,
                threshold_deg: 30.0,
                max_bridge_mm: 10.0,
            },
        )
    }

    #[test]
    fn a_box_on_the_bed_is_fine_and_one_in_the_air_floats() {
        let ground = cuboid([0.0, 10.0], [0.0, 10.0], [0.0, 5.0]);
        assert!(run(std::slice::from_ref(&ground), 5.0).is_empty());
        let air = cuboid([20.0, 25.0], [0.0, 5.0], [3.0, 6.0]);
        let found = run(&[ground, air], 6.0);
        assert_eq!(found.len(), 1, "{found:?}");
        let f = found[0];
        assert_eq!(f.kind, Kind::Floating);
        assert!(
            (f.at[0] - 22.5).abs() < 0.1 && (f.at[1] - 2.5).abs() < 0.1,
            "{f:?}"
        );
        assert_eq!(f.layers.0, 15);
    }

    #[test]
    fn a_box_resting_on_another_is_held_but_a_long_shelf_is_reported() {
        let base = cuboid([0.0, 10.0], [0.0, 10.0], [0.0, 5.0]);
        let top = cuboid([2.0, 8.0], [2.0, 8.0], [5.0, 8.0]);
        assert!(run(&[base.clone(), top], 8.0).is_empty());
        let shelf = cuboid([0.0, 30.0], [0.0, 10.0], [5.0, 6.0]);
        let found = run(&[base, shelf], 6.0);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].kind, Kind::Overhang);
        assert!(found[0].reach > 15.0, "{:?}", found[0]);
    }

    /// Two posts and a slab across them, the slab `gap` mm long between the posts.
    fn arch(gap: f64) -> Vec<Part> {
        vec![
            cuboid([0.0, 10.0], [0.0, 10.0], [0.0, 5.0]),
            cuboid([10.0 + gap, 20.0 + gap], [0.0, 10.0], [0.0, 5.0]),
            cuboid([0.0, 20.0 + gap], [0.0, 10.0], [5.0, 7.0]),
        ]
    }

    #[test]
    fn a_short_bridge_is_fine_and_a_long_one_is_reported_as_a_bridge() {
        assert!(run(&arch(8.0), 7.0).is_empty(), "{:?}", run(&arch(8.0), 7.0));
        let found = run(&arch(40.0), 7.0);
        assert_eq!(found.len(), 1, "{found:?}");
        let f = found[0];
        assert_eq!(f.kind, Kind::Bridge);
        assert!((f.reach - 40.0).abs() < 1.0, "{f:?}");
        assert!((f.at[0] - 30.0).abs() < 1.0, "{f:?}");
        assert_eq!(f.layers.0, 25);
    }

    #[test]
    fn a_bridge_with_a_free_end_is_an_overhang() {
        // The slab runs past the second post by 12 mm: those strands land on one side only.
        let mut parts = arch(20.0);
        parts[2] = cuboid([0.0, 52.0], [0.0, 10.0], [5.0, 7.0]);
        let found = run(&parts, 7.0);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].kind, Kind::Overhang);
    }
}
