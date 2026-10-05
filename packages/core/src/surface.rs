// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Fill patterns for top and bottom surfaces that are not straight lines: the Hilbert curve,
//! Archimedean chords, the octagram spiral, and concentric loops (also the spiral inset, which
//! fills the same way here).
//!
//! The three curves are generated on a grid of cells one line spacing wide and clipped to the
//! surface: the Hilbert curve from the lower left corner of the surface's bounding box, the two
//! spirals around its center. Clipping cuts the curve into pieces, which are then chained nearest
//! end first. Concentric loops are the surface shrunk by half a spacing, then by one spacing
//! again and again, outermost first.

use crate::fm::Fm as _;
use crate::geom::Point;
use crate::perimeters::{self, Shapes};

type Pt = [f64; 2];

/// The patterns this module draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Curve {
    Hilbert,
    Archimedean,
    Octagram,
    Concentric,
}

/// The pattern named by a profile value, when it is one of ours.
pub(crate) fn curve(name: &str) -> Option<Curve> {
    match name {
        "hilbertcurve" => Some(Curve::Hilbert),
        "archimedeanchords" => Some(Curve::Archimedean),
        "octagramspiral" => Some(Curve::Octagram),
        "concentric" | "spiralinset" => Some(Curve::Concentric),
        _ => None,
    }
}

fn rings(shapes: &Shapes) -> Vec<Vec<Pt>> {
    shapes
        .iter()
        .flat_map(|s| s.iter())
        .map(|c| {
            c.iter()
                .map(|p| {
                    [
                        f64::from(p.x) / crate::geom::SCALE,
                        f64::from(p.y) / crate::geom::SCALE,
                    ]
                })
                .collect()
        })
        .collect()
}

fn inside(rs: &[Vec<Pt>], p: Pt) -> bool {
    let mut odd = false;
    for r in rs {
        let n = r.len();
        for i in 0..n {
            let (Some(a), Some(b)) = (r.get(i), r.get((i + 1) % n)) else {
                continue;
            };
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                odd = !odd;
            }
        }
    }
    odd
}

/// The pieces of a polyline that lie inside the rings.
fn clip(path: &[Pt], rs: &[Vec<Pt>]) -> Vec<Vec<Pt>> {
    let mut out: Vec<Vec<Pt>> = Vec::new();
    let mut cur: Vec<Pt> = Vec::new();
    for w in path.windows(2) {
        let (Some(&a), Some(&b)) = (w.first(), w.get(1)) else {
            continue;
        };
        let mut ts = vec![0.0, 1.0];
        for r in rs {
            let n = r.len();
            for i in 0..n {
                let (Some(&p), Some(&q)) = (r.get(i), r.get((i + 1) % n)) else {
                    continue;
                };
                let (d1x, d1y, d2x, d2y) = (b[0] - a[0], b[1] - a[1], q[0] - p[0], q[1] - p[1]);
                let den = d1x * d2y - d1y * d2x;
                if den.abs() < 1e-12 {
                    continue;
                }
                let t = ((p[0] - a[0]) * d2y - (p[1] - a[1]) * d2x) / den;
                let u = ((p[0] - a[0]) * d1y - (p[1] - a[1]) * d1x) / den;
                if t > 0.0 && t < 1.0 && (0.0..=1.0).contains(&u) {
                    ts.push(t);
                }
            }
        }
        crate::sorting::sort_by(&mut ts, |x, y| {
            x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal)
        });
        for k in ts.windows(2) {
            let (Some(&t0), Some(&t1)) = (k.first(), k.get(1)) else {
                continue;
            };
            if t1 - t0 < 1e-9 {
                continue;
            }
            let at = |t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            let mid = at(f64::midpoint(t0, t1));
            if inside(rs, mid) {
                if cur.is_empty() {
                    cur.push(at(t0));
                }
                cur.push(at(t1));
            } else if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Orders pieces so each starts where the last ended, nearest end first, flipping as needed.
fn chain(mut pieces: Vec<Vec<Pt>>) -> Vec<Vec<Pt>> {
    let mut out = Vec::with_capacity(pieces.len());
    let mut at: Option<Pt> = None;
    while !pieces.is_empty() {
        let from = at.unwrap_or_else(|| {
            pieces
                .first()
                .and_then(|p| p.first().copied())
                .unwrap_or([0.0, 0.0])
        });
        let d = |p: Pt| (p[0] - from[0]).m_hypot(p[1] - from[1]);
        let Some((i, flip)) = pieces
            .iter()
            .enumerate()
            .flat_map(|(i, p)| {
                [
                    (i, false, p.first().map_or(f64::MAX, |&q| d(q))),
                    (i, true, p.last().map_or(f64::MAX, |&q| d(q))),
                ]
            })
            .min_by(|x, y| x.2.partial_cmp(&y.2).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, f, _)| (i, f))
        else {
            break;
        };
        let mut p = pieces.swap_remove(i);
        if flip {
            p.reverse();
        }
        at = p.last().copied();
        out.push(p);
    }
    out
}

fn archimedean(rmax: f64, spacing: f64) -> Vec<Pt> {
    // r = a + b*theta in cell units, one turn per cell.
    let (a, b) = (1.0, 1.0 / (2.0 * std::f64::consts::PI));
    // Orca's `resolution` setting (0.0125 mm) in units of the line distance.
    let resolution = 0.0125 / spacing;
    let mut pts = vec![[0.0, 0.0], [spacing, 0.0]];
    let (mut theta, mut r) = (0.0f64, 1.0f64);
    while r * spacing < rmax {
        theta += 2.0 * (1.0 - (resolution / r).min(1.0)).m_acos();
        r = a + b * theta;
        pts.push([r * theta.m_cos() * spacing, r * theta.m_sin() * spacing]);
    }
    pts
}

fn octagram(rmax: f64, spacing: f64) -> Vec<Pt> {
    let inc = std::f64::consts::SQRT_2;
    let mut pts = vec![[0.0, 0.0]];
    let mut r = 0.0;
    while r * spacing < rmax {
        r += inc;
        let rx = r / std::f64::consts::SQRT_2;
        let r2 = r + rx;
        for p in [
            [r, 0.0],
            [r2, rx],
            [rx, rx],
            [rx, r2],
            [0.0, r],
            [-rx, r2],
            [-rx, rx],
            [-r2, rx],
            [-r, 0.0],
            [-r2, -rx],
            [-rx, -rx],
            [-rx, -r2],
            [0.0, -r],
            [rx, -r2],
            [rx, -rx],
            [r2 + inc, -rx],
        ] {
            pts.push([p[0] * spacing, p[1] * spacing]);
        }
    }
    pts
}

/// The Hilbert curve over a square of `cells` by `cells`, starting at the origin, as cell corners.
fn hilbert(cells: usize, spacing: f64) -> Vec<Pt> {
    let mut size = 2usize;
    while size < cells {
        size <<= 1;
    }
    let (mut x, mut y);
    let mut pts = Vec::with_capacity(size * size);
    for d in 0..size * size {
        // Standard index to coordinate walk.
        x = 0usize;
        y = 0usize;
        let mut t = d;
        let mut s = 1usize;
        while s < size {
            let rx = 1 & (t / 2);
            let ry = 1 & (t ^ rx);
            if ry == 0 {
                if rx == 1 {
                    x = s - 1 - x;
                    y = s - 1 - y;
                }
                std::mem::swap(&mut x, &mut y);
            }
            x += s * rx;
            y += s * ry;
            t /= 4;
            s <<= 1;
        }
        #[allow(clippy::cast_precision_loss, reason = "grid indices are small")]
        pts.push([x as f64 * spacing, y as f64 * spacing]);
    }
    pts
}

/// Fills `region` with `pattern` at `spacing` mm. Returns polylines in mm, in print order.
///
/// The curves are drawn in a frame turned by `frame_deg` (Orca's `FillPlanePath::_fill_surface_single`
/// rotates the surface by the layer's fill angle, draws, and turns the result back), so a Hilbert curve
/// runs along the diagonals like the straight lines of the same layer. Concentric loops ignore it.
pub(crate) fn fill(region: &Shapes, pattern: Curve, spacing: f64, frame_deg: f64) -> Vec<Vec<Point>> {
    fill_plane(region, pattern, spacing, spacing, frame_deg, None)
}

/// [`fill`] with the distance between the curve's lines apart from the line spacing, and, for sparse infill,
/// the curve anchored to the box `object` (`[min_x, min_y, max_x, max_y]`, mm) of all the objects so every layer
/// shares it, with the region used as given (the caller has pulled it in).
pub(crate) fn fill_plane(
    region: &Shapes,
    pattern: Curve,
    spacing: f64,
    distance: f64,
    frame_deg: f64,
    object: Option<[f64; 4]>,
) -> Vec<Vec<Point>> {
    if region.is_empty() || spacing <= 0.0 {
        return Vec::new();
    }
    let pieces: Vec<Vec<Pt>> = if pattern == Curve::Concentric {
        let mut loops = Vec::new();
        let mut cur = perimeters::offset(region, -crate::geom::mm(spacing / 2.0));
        let mut last_area = f64::MAX;
        while !cur.is_empty() && loops.len() < 400 {
            let before = loops.len();
            let mut step_area = 0.0;
            for mut r in rings(&cur) {
                let n = r.len();
                let area: f64 = (0..n)
                    .map(|i| match (r.get(i), r.get((i + 1) % n)) {
                        (Some(a), Some(b)) => a[0] * b[1] - b[0] * a[1],
                        _ => 0.0,
                    })
                    .sum::<f64>()
                    .abs()
                    / 2.0;
                if area < spacing * spacing {
                    continue;
                }
                step_area += area;
                if let Some(&f) = r.first() {
                    r.push(f);
                }
                loops.push(r);
            }
            // An offset that no longer shrinks the region has run out of room.
            if loops.len() == before || step_area >= last_area {
                break;
            }
            last_area = step_area;
            cur = perimeters::offset(&cur, -crate::geom::mm(spacing));
        }
        loops
    } else {
        let th = frame_deg.to_radians();
        let turn = |p: Pt, a: f64| -> Pt {
            let (sn, cs) = a.m_sin_cos();
            [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs]
        };
        let turned = |rs: Vec<Vec<Pt>>| -> Vec<Vec<Pt>> {
            rs.into_iter()
                .map(|r| r.into_iter().map(|p| turn(p, th)).collect())
                .collect()
        };
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        // The box the curve is anchored to: the region's own, or the turned box of all the objects.
        let anchor: Vec<Pt> = match object {
            Some(b) => vec![
                turn([b[0], b[1]], th),
                turn([b[2], b[1]], th),
                turn([b[2], b[3]], th),
                turn([b[0], b[3]], th),
            ],
            None => turned(rings(region)).into_iter().flatten().collect(),
        };
        for p in &anchor {
            lo = [lo[0].min(p[0]), lo[1].min(p[1])];
            hi = [hi[0].max(p[0]), hi[1].max(p[1])];
        }
        if lo[0] > hi[0] {
            return Vec::new();
        }
        let rs = if object.is_some() {
            turned(rings(region))
        } else {
            turned(rings(&shrunk(region, spacing)))
        };
        let rs = if rs.is_empty() { turned(rings(region)) } else { rs };
        let spacing = distance;
        let center = [f64::midpoint(lo[0], hi[0]), f64::midpoint(lo[1], hi[1])];
        let reach = (hi[0] - lo[0]).m_hypot(hi[1] - lo[1]);
        let path: Vec<Pt> = match pattern {
            Curve::Hilbert => {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a cell count"
                )]
                let cells = (((hi[0] - lo[0]).max(hi[1] - lo[1])) / spacing).ceil() as usize + 1;
                hilbert(cells, spacing)
                    .into_iter()
                    .map(|p| [p[0] + lo[0], p[1] + lo[1]])
                    .collect()
            }
            Curve::Archimedean => archimedean(reach, spacing)
                .into_iter()
                .map(|p| [p[0] + center[0], p[1] + center[1]])
                .collect(),
            _ => octagram(reach * 1.5, spacing)
                .into_iter()
                .map(|p| [p[0] + center[0], p[1] + center[1]])
                .collect(),
        };
        chain(clip(&path, &rs).into_iter().filter(|p| p.len() > 1).collect())
            .into_iter()
            .map(|pl| pl.into_iter().map(|p| turn(p, -th)).collect())
            .collect()
    };
    pieces
        .into_iter()
        .map(|p| p.into_iter().map(|q| Point::from_mm(q[0], q[1])).collect())
        .collect()
}

/// The region pulled in by half a spacing, so lines stay off the walls.
fn shrunk(region: &Shapes, spacing: f64) -> Shapes {
    perimeters::offset(region, -crate::geom::mm(spacing / 2.0))
}

/// True when 0-based layer `layer` matches an `extra_solid_infills` pattern (Orca's
/// `check_layer_id_pattern`, layers counted from 1): "5" or "5#2" is every fifth layer and the one after it,
/// "1,7,9" lists layers, and "5,9#2" lists layers with a count each. Anything unreadable matches nothing.
pub(crate) fn layer_id_matches(pattern: &str, layer: u32) -> bool {
    let p: String = pattern.chars().filter(|c| !c.is_whitespace()).collect();
    let p = p.trim_matches(|c| c == '"' || c == '\'');
    if p.is_empty() {
        return false;
    }
    let id = i64::from(layer) + 1;
    let parse = |t: &str| t.parse::<i64>().ok();
    // A token "n" or "n#k": n and the count k (1 when absent).
    let token = |t: &str| -> Option<(i64, i64)> {
        match t.split_once('#') {
            None => Some((parse(t)?, 1)),
            Some((n, k)) => Some((parse(n)?, if k.is_empty() { 1 } else { parse(k)? })),
        }
    };
    if p.contains(',') {
        return p
            .split(',')
            .filter(|t| !t.is_empty())
            .any(|t| match (t.contains('#'), token(t)) {
                (false, Some((n, _))) => n == id,
                (true, Some((n, k))) => n > 0 && k > 0 && id >= n && id < n + k,
                _ => false,
            });
    }
    match token(p) {
        Some((n, k)) if n > 0 && k > 0 => id >= n && id % n < k,
        _ => false,
    }
}

#[cfg(test)]
#[allow(clippy::cast_possible_truncation)]
mod tests {
    use super::*;
    use i_overlay::i_float::int::point::IntPoint;

    fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> Shapes {
        vec![vec![
            [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
                .iter()
                .map(|&(x, y)| IntPoint::new(crate::geom::mm(x), crate::geom::mm(y)))
                .collect(),
        ]]
    }

    fn length(pl: &[Vec<Point>]) -> f64 {
        pl.iter()
            .flat_map(|p| p.windows(2).map(|w| w[0].dist_mm(w[1])))
            .sum()
    }

    #[test]
    fn every_curve_covers_a_square_at_about_one_line_per_spacing() {
        let region = square(0.0, 0.0, 20.0, 20.0);
        for c in [
            Curve::Hilbert,
            Curve::Archimedean,
            Curve::Octagram,
            Curve::Concentric,
        ] {
            let lines = fill(&region, c, 0.5, 0.0);
            // Area over spacing is the length of a full fill: 20 * 20 / 0.5 = 800 mm.
            let l = length(&lines);
            assert!(l > 560.0 && l < 1000.0, "{c:?}: {l} mm");
            assert!(
                lines
                    .iter()
                    .flatten()
                    .all(|p| (-0.01..=20.01).contains(&p.x_mm()) && (-0.01..=20.01).contains(&p.y_mm())),
                "{c:?} stays inside"
            );
        }
    }

    #[test]
    fn pieces_are_chained_nearest_first() {
        let lines = fill(&square(0.0, 0.0, 20.0, 20.0), Curve::Hilbert, 0.5, 0.0);
        let gaps: Vec<f64> = lines
            .windows(2)
            .map(|w| w[0].last().unwrap().dist_mm(*w[1].first().unwrap()))
            .collect();
        let long = gaps.iter().filter(|g| **g > 3.0).count();
        assert!(
            long * 10 <= gaps.len().max(10),
            "{long} long hops of {}",
            gaps.len()
        );
    }

    #[test]
    fn names_map_to_curves() {
        assert_eq!(curve("hilbertcurve"), Some(Curve::Hilbert));
        assert_eq!(curve("spiralinset"), Some(Curve::Concentric));
        assert_eq!(curve("monotonic"), None);
    }

    #[test]
    fn the_hilbert_walk_visits_every_cell_once_in_steps_of_one() {
        let pts = hilbert(8, 1.0);
        assert_eq!(pts.len(), 64);
        assert!(
            pts.windows(2)
                .all(|w| ((w[0][0] - w[1][0]).abs() + (w[0][1] - w[1][1]).abs() - 1.0).abs() < 1e-9)
        );
        let mut cells: Vec<(i64, i64)> = pts
            .iter()
            .map(|p| (p[0].round() as i64, p[1].round() as i64))
            .collect();
        cells.sort_unstable();
        cells.dedup();
        assert_eq!(cells.len(), 64);
    }

    #[test]
    fn extra_solid_layer_patterns_read_like_orca() {
        let on = |p: &str| {
            (0..20)
                .filter(|&l| super::layer_id_matches(p, l))
                .map(|l| l + 1)
                .collect::<Vec<u32>>()
        };
        assert_eq!(on("5"), vec![5, 10, 15, 20]);
        assert_eq!(on("5#2"), vec![5, 6, 10, 11, 15, 16, 20]);
        assert_eq!(on("1,7,9"), vec![1, 7, 9]);
        assert_eq!(on("5,9#2,18"), vec![5, 9, 10, 18]);
        assert_eq!(on(" \"3\" "), vec![3, 6, 9, 12, 15, 18]);
        assert!(on("").is_empty() && on("x").is_empty() && on("0").is_empty());
    }
}
