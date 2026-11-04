// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The order the objects of a plate printed layer by layer print in on one layer. It depends only on where the
//! objects stand: each object is one fixed point (the center of its footprint's box, as placed on the bed), so the
//! same objects print in the same order on every layer, whatever the object list, the names, the objects' own
//! settings or where the nozzle is.
//!
//! The order is a path through the objects' centers made of the shortest links. Every pair of objects is taken in
//! rising distance between their centers, and the pair is linked when neither already has two links (the object
//! nearest the bed's origin, its front left corner: not one) and they are not already joined through other links.
//! The links make one path with the object nearest the origin at one end. The layer prints it from the other end,
//! so it ends at the object nearest the origin.
//!
//! Ties: centers are compared in internal units, so only exactly equal distances tie. Two pairs equally far apart
//! are taken in the order of their objects' numbers (the lower number of each pair first, then the higher), and of
//! two objects equally near the origin the one with the lower number ends the path. The numbers are the objects'
//! places in the slice `centers` the caller gives, which is plate order.
//!
//! A layer with several filaments prints as runs of one filament each, and each run orders only its own objects
//! (`run_by`): the objects that print with that filament on the layer, so every run ends at its own object nearest the
//! origin. An object that prints with several filaments is in each of their runs.
//!
//! A Prusa project orders its objects by another rule (`object_order_rule` `chain`, which the project read
//! sets): the same chain of shortest links, built with no object held to one link, printed from one of its ends
//! (`chain`). On the first layer every object's brim prints before the objects, each object's loops together, in the
//! objects' order, except on a plate of two objects, where the brims and the objects each have a rule of their own
//! (`pair_brims`, `pair_objects`). Under this rule each object stands at the lowest point of its first layer outline,
//! the rightmost of equally low ones (`SliceSession::order_center`). The parts that are the current rule rather than a settled one say so ("Current
//! rule"), so they are easy to find and change.

use crate::geom::SCALE;

/// A center in internal units, so distances compare exactly.
fn grid(c: [f64; 2]) -> [i64; 2] {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "bed coordinates in internal units fit"
    )]
    c.map(|v| (v * SCALE).round() as i64)
}

fn dist2(a: [i64; 2], b: [i64; 2]) -> i128 {
    let (dx, dy) = (i128::from(a[0] - b[0]), i128::from(a[1] - b[1]));
    dx * dx + dy * dy
}

/// The root of `i`'s group, halving the path on the way.
fn root(parent: &mut [usize], mut i: usize) -> usize {
    while let Some(&p) = parent.get(i) {
        if p == i {
            break;
        }
        let up = parent.get(p).copied().unwrap_or(p);
        if let Some(slot) = parent.get_mut(i) {
            *slot = up;
        }
        i = up;
    }
    i
}

/// The print order of the objects whose centers (mm, bed coordinates) are `centers`: indexes into `centers`, first
/// printed first. One object, or none, prints as it is.
pub(crate) fn order(centers: &[[f64; 2]]) -> Vec<usize> {
    let n = centers.len();
    if n < 3 {
        // Two objects: the one nearer the origin prints last.
        let pts: Vec<[i64; 2]> = centers.iter().copied().map(grid).collect();
        return match pts.as_slice() {
            [a, b] if dist2(*b, [0, 0]) < dist2(*a, [0, 0]) => vec![0, 1],
            [_, _] => vec![1, 0],
            _ => (0..n).collect(),
        };
    }
    let pts: Vec<[i64; 2]> = centers.iter().copied().map(grid).collect();
    let anchor = (0..n)
        .min_by_key(|&i| (pts.get(i).map_or(i128::MAX, |p| dist2(*p, [0, 0])), i))
        .unwrap_or(0);
    let links = links_of(&pts, &|i| if i == anchor { 1 } else { 2 });
    // Walk the path from the object nearest the origin, then print it the other way round.
    let mut path = walk(&links, anchor);
    path.reverse();
    path
}

/// How a plate's objects are put in order on a layer (`object_order_rule`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Rule {
    /// The path ends at the object nearest the bed's origin (`origin_last`, also when the key is unset).
    OriginLast,
    /// A chain of the nearest objects with no object held to one link, printed from the end `chain` picks, and the
    /// brims print first in the same order (`chain`, a Prusa project's).
    Chain,
}

/// The plate's object order rule (`object_order_rule`).
pub(crate) fn rule(cfg: &crate::config::PrintConfig) -> Rule {
    match cfg.raw.get("object_order_rule") {
        Some(serde_json::Value::String(r)) if r == "chain" => Rule::Chain,
        _ => Rule::OriginLast,
    }
}

/// The print order of the objects whose centers are `centers` by `rule`: indexes into `centers` (plate order),
/// first printed first.
pub(crate) fn order_by(rule: Rule, centers: &[[f64; 2]]) -> Vec<usize> {
    match (rule, centers) {
        (Rule::OriginLast, _) => order(centers),
        (Rule::Chain, [a, b]) => pair_objects(*a, *b),
        (Rule::Chain, _) => chain(centers),
    }
}

/// The order the brims of the objects whose centers are `centers` print in on the first layer, by `rule`, as
/// indexes into `centers`. With three or more objects it is the objects' order.
pub(crate) fn brim_order(rule: Rule, centers: &[[f64; 2]]) -> Vec<usize> {
    match (rule, centers) {
        (Rule::Chain, [a, b]) => pair_brims(*a, *b),
        _ => order_by(rule, centers),
    }
}

/// The print order of one filament's run on a layer: of the layer's objects, whose centers are `centers` (in plate
/// order), the ones `with` passes (those that print with that filament there), in the order of those objects alone.
/// Indexes into `centers`, first printed first, by `rule`.
pub(crate) fn run_by(rule: Rule, centers: &[[f64; 2]], with: impl Fn(usize) -> bool) -> Vec<usize> {
    let picked: Vec<usize> = (0..centers.len()).filter(|&i| with(i)).collect();
    let own: Vec<[f64; 2]> = picked.iter().filter_map(|&i| centers.get(i).copied()).collect();
    order_by(rule, &own)
        .into_iter()
        .filter_map(|k| picked.get(k).copied())
        .collect()
}

/// A center at twice the internal resolution, so the middle of a box in internal units is exact and distances
/// compare at full precision: two distances tie only when they are exactly equal.
fn fine(c: [f64; 2]) -> [i64; 2] {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "bed coordinates in internal units fit"
    )]
    c.map(|v| (v * SCALE * 2.0).round() as i64)
}

/// Two objects' brims: the one with the larger y first, then (y exactly equal) the one with the larger x. The
/// objects' numbers play no part.
fn pair_brims(a: [f64; 2], b: [f64; 2]) -> Vec<usize> {
    let (a, b) = (fine(a), fine(b));
    if (b[1], b[0]) > (a[1], a[0]) {
        vec![1, 0]
    } else {
        vec![0, 1]
    }
}

/// Two objects: the first in plate order prints first when their y differs; with y exactly equal, the one with the
/// larger x does.
fn pair_objects(a: [f64; 2], b: [f64; 2]) -> Vec<usize> {
    let (a, b) = (fine(a), fine(b));
    if a[1] == b[1] && b[0] > a[0] {
        vec![1, 0]
    } else {
        vec![0, 1]
    }
}

/// The links of a path over `pts`: every pair is taken in rising distance, two pairs equally far apart in the order
/// of their numbers (the lower number of each pair first, then the higher), and linked when both have fewer links
/// than `cap` allows and they are not already joined through other links. Each object's links, `usize::MAX` for
/// none.
fn links_of(pts: &[[i64; 2]], cap: &dyn Fn(usize) -> u8) -> Vec<[usize; 2]> {
    let n = pts.len();
    let mut pairs: Vec<(i128, usize, usize)> = Vec::with_capacity(n * n.saturating_sub(1) / 2);
    for (i, a) in pts.iter().enumerate() {
        for (j, b) in pts.iter().enumerate().skip(i + 1) {
            pairs.push((dist2(*a, *b), i, j));
        }
    }
    // Every key differs (the pair's numbers), so the order is fixed.
    pairs.sort_unstable();
    let mut parent: Vec<usize> = (0..n).collect();
    let mut links: Vec<[usize; 2]> = vec![[usize::MAX; 2]; n];
    let mut degree: Vec<u8> = vec![0; n];
    let mut made = 0;
    for &(_, i, j) in &pairs {
        if made + 1 >= n {
            break;
        }
        let (di, dj) = (
            degree.get(i).copied().unwrap_or(2),
            degree.get(j).copied().unwrap_or(2),
        );
        if di >= cap(i) || dj >= cap(j) {
            continue;
        }
        let (ri, rj) = (root(&mut parent, i), root(&mut parent, j));
        if ri == rj {
            continue;
        }
        if let Some(slot) = parent.get_mut(ri) {
            *slot = rj;
        }
        for (a, b, d) in [(i, j, di), (j, i, dj)] {
            if let Some(l) = links.get_mut(a).and_then(|l| l.get_mut(usize::from(d))) {
                *l = b;
            }
            if let Some(d) = degree.get_mut(a) {
                *d += 1;
            }
        }
        made += 1;
    }
    links
}

/// The path `links` make, walked from `from`.
fn walk(links: &[[usize; 2]], from: usize) -> Vec<usize> {
    let n = links.len();
    let mut out: Vec<usize> = Vec::with_capacity(n);
    let (mut prev, mut cur) = (usize::MAX, from);
    while out.len() < n {
        out.push(cur);
        let Some(&next) = links
            .get(cur)
            .and_then(|l| l.iter().find(|&&k| k != prev && k != usize::MAX))
        else {
            break;
        };
        (prev, cur) = (cur, next);
    }
    out
}

/// The `Chain` order of three or more objects, from each object's point (`SliceSession::order_center`):
/// one open chain through every object, at most two links an object and no loop, printed from one of its ends.
///
/// Every object records the nearest object it can still link to (one in another part of the chain with a free
/// side) and how far it is. The object with the shortest record goes next (equal records: the one recorded first).
/// When its recorded object can still take the link, the two link, and the object records again if it has a free
/// side left; the other object keeps its record. When the recorded object can no longer take it, the object records
/// again, or drops out when nothing is left. So each link is the shortest one still open, the same chain the closest
/// pairs make taken shortest first.
///
/// Printing starts at the end whose last record is the shorter. That record is kept as it was when the end last
/// recorded, even when the object it named has since taken its two links. Two exactly equal end records start at
/// the end with the larger y, then the larger x, as two objects' brims do. Current rule: on three or more objects
/// with equal end records, and on lines of equal gaps, where records tie on the way and equal records go in the
/// order they were made (so the object numbers decide), no rule found so far picks the start every time.
fn chain(centers: &[[f64; 2]]) -> Vec<usize> {
    let n = centers.len();
    let pts: Vec<[i64; 2]> = centers.iter().copied().map(fine).collect();
    let at = |k: usize| pts.get(k).copied().unwrap_or([0, 0]);
    let mut parent: Vec<usize> = (0..n).collect();
    let mut links: Vec<[usize; 2]> = vec![[usize::MAX; 2]; n];
    let mut degree: Vec<u8> = vec![0; n];
    // Each object's record: (distance, when it was made, object), or None once it drops out; and the last distance.
    let mut record: Vec<Option<(i128, usize, usize)>> = vec![None; n];
    let mut last: Vec<i128> = vec![i128::MAX; n];
    let mut made = 0usize;
    let mut clock = 0usize;
    let nearest = |i: usize, parent: &mut [usize], degree: &[u8]| -> Option<(i128, usize)> {
        let ri = root(parent, i);
        (0..n)
            .filter(|&j| j != i && degree.get(j).is_some_and(|&d| d < 2) && root(parent, j) != ri)
            .map(|j| (dist2(at(i), at(j)), j))
            .min()
    };
    for i in 0..n {
        if let Some((d, j)) = nearest(i, &mut parent, &degree) {
            if let (Some(r), Some(l)) = (record.get_mut(i), last.get_mut(i)) {
                (*r, *l) = (Some((d, clock, j)), d);
            }
            clock += 1;
        }
    }
    while made + 1 < n {
        let Some((i, (_, _, j))) = record
            .iter()
            .enumerate()
            .filter_map(|(i, r)| r.map(|r| (i, r)))
            .min_by_key(|&(i, r)| (r.0, r.1, i))
        else {
            break;
        };
        let free = |k: usize, degree: &[u8]| degree.get(k).is_some_and(|&d| d < 2);
        if !free(i, &degree) {
            if let Some(r) = record.get_mut(i) {
                *r = None;
            }
            continue;
        }
        let (ri, rj) = (root(&mut parent, i), root(&mut parent, j));
        if free(j, &degree) && ri != rj {
            if let Some(slot) = parent.get_mut(ri) {
                *slot = rj;
            }
            for (a, b) in [(i, j), (j, i)] {
                let d = degree.get(a).copied().unwrap_or(2);
                if let Some(l) = links.get_mut(a).and_then(|l| l.get_mut(usize::from(d))) {
                    *l = b;
                }
                if let Some(d) = degree.get_mut(a) {
                    *d += 1;
                }
            }
            made += 1;
            if !free(i, &degree) {
                if let Some(r) = record.get_mut(i) {
                    *r = None;
                }
                continue;
            }
        }
        let again = nearest(i, &mut parent, &degree).map(|(d, k)| {
            clock += 1;
            (d, clock, k)
        });
        if let (Some(again), Some(l)) = (again, last.get_mut(i)) {
            *l = again.0;
        }
        if let Some(r) = record.get_mut(i) {
            *r = again;
        }
    }
    let Some(end) = (0..n).find(|&i| degree.get(i).is_some_and(|&d| d < 2)) else {
        return (0..n).collect();
    };
    let mut path = walk(&links, end);
    let (first, tail) = (
        path.first().copied().unwrap_or(0),
        path.last().copied().unwrap_or(0),
    );
    let (a, b) = (
        last.get(first).copied().unwrap_or(i128::MAX),
        last.get(tail).copied().unwrap_or(i128::MAX),
    );
    let (pa, pb) = (at(first), at(tail));
    if b < a || (b == a && (pb[1], pb[0]) > (pa[1], pa[0])) {
        path.reverse();
    }
    path
}

/// Whether the plate prints its objects in object list order on every layer (`print_order`).
pub(crate) fn list_order(cfg: &crate::config::PrintConfig) -> bool {
    matches!(cfg.raw.get("print_order"), Some(serde_json::Value::String(t)) if t == "as_obj_list")
}

#[cfg(test)]
mod tests {
    use super::{Rule, brim_order, order, order_by, run_by};

    fn named(centers: &[(char, [f64; 2])]) -> String {
        let pts: Vec<[f64; 2]> = centers.iter().map(|c| c.1).collect();
        order(&pts)
            .into_iter()
            .filter_map(|i| centers.get(i).map(|c| c.0))
            .collect()
    }

    #[test]
    fn seven_scattered_objects_end_nearest_the_origin() {
        let pts = [
            ('A', [173.31, 198.40]),
            ('B', [131.58, 111.87]),
            ('C', [135.17, 160.00]),
            ('D', [188.67, 59.14]),
            ('E', [91.39, 173.82]),
            ('F', [69.38, 219.90]),
            ('G', [171.52, 158.98]),
        ];
        assert_eq!(named(&pts), "FECGADB");
        // The list order does not matter.
        let mut back = pts;
        back.reverse();
        assert_eq!(named(&back), "FECGADB");
    }

    #[test]
    fn the_order_follows_the_objects_that_print_on_the_layer() {
        let a1 = [
            ('A', [38.4, 153.6]),
            ('B', [89.6, 51.2]),
            ('D', [179.2, 115.2]),
            ('E', [217.6, 38.4]),
        ];
        assert_eq!(named(&a1), "AEDB");
        let mk4 = [
            ('A', [37.5, 126.0]),
            ('B', [87.5, 42.0]),
            ('D', [175.0, 94.5]),
            ('E', [212.5, 31.5]),
        ];
        assert_eq!(named(&mk4), "EDAB");
    }

    #[test]
    fn few_objects() {
        assert!(order(&[]).is_empty());
        assert_eq!(order(&[[50.0, 50.0]]), [0]);
        assert_eq!(order(&[[10.0, 10.0], [50.0, 50.0]]), [1, 0]);
        assert_eq!(order(&[[50.0, 50.0], [10.0, 10.0]]), [0, 1]);
    }

    #[test]
    fn ties_go_by_object_number() {
        // Four in a line 40 mm apart along both axes: the three links between neighbors tie, and so do the two
        // links that skip one. B is nearest the origin and links once; A-B wins its tie, then C-D, then A-C.
        let pts = [
            ('A', [60.0, 180.0]),
            ('B', [100.0, 140.0]),
            ('C', [140.0, 100.0]),
            ('D', [180.0, 60.0]),
        ];
        assert_eq!(named(&pts), "DCAB");
        // Two objects equally near the origin: the lower number ends the path.
        assert_eq!(order(&[[30.0, 40.0], [40.0, 30.0]]), [1, 0]);
    }

    /// The run of the objects whose filaments (in `fil`, one digit each) hold `tool`, of all the objects on a layer.
    fn run_of(centers: &[(char, [f64; 2])], fil: &[&str], tool: char) -> String {
        let pts: Vec<[f64; 2]> = centers.iter().map(|c| c.1).collect();
        run_by(Rule::OriginLast, &pts, |i| {
            fil.get(i).is_some_and(|f| f.contains(tool))
        })
        .into_iter()
        .filter_map(|i| centers.get(i).map(|c| c.0))
        .collect()
    }

    #[test]
    fn each_filament_run_orders_its_own_objects() {
        // Five objects, A and B on filament 2, C, D and E on filament 1. The layer's order is E D C A B, but the
        // filament 1 run ends at its own object nearest the origin, D.
        let s5 = [
            ('A', [38.4, 153.6]),
            ('B', [89.6, 51.2]),
            ('C', [140.8, 217.6]),
            ('D', [179.2, 115.2]),
            ('E', [217.6, 38.4]),
        ];
        let fil = ["2", "2", "1", "1", "1"];
        assert_eq!(named(&s5), "EDCAB");
        assert_eq!(run_of(&s5, &fil, '1'), "CED");
        assert_eq!(run_of(&s5, &fil, '2'), "AB");
        // A of two filaments is in both runs.
        let both = ["12", "2", "1", "1", "1"];
        assert_eq!(run_of(&s5, &both, '1'), "EDCA");
        assert_eq!(run_of(&s5, &both, '2'), "AB");
        // Seven objects, C to G on filament 1 and A and B on filament 2.
        let bl1 = [
            ('A', [173.31, 198.40]),
            ('B', [131.58, 111.87]),
            ('C', [135.17, 160.00]),
            ('D', [188.67, 59.14]),
            ('E', [91.39, 173.82]),
            ('F', [69.38, 219.90]),
            ('G', [171.52, 158.98]),
        ];
        let fil = ["2", "2", "1", "1", "1", "1", "1"];
        assert_eq!(named(&bl1), "FECGADB");
        assert_eq!(run_of(&bl1, &fil, '1'), "FDGCE");
        assert_eq!(run_of(&bl1, &fil, '2'), "AB");
        // Another seven, A and C on filament 2: of two objects the one nearer the origin prints last.
        let bl2 = [
            ('A', [176.38, 47.10]),
            ('B', [116.48, 98.82]),
            ('C', [184.32, 90.88]),
            ('D', [224.77, 77.31]),
            ('E', [177.92, 214.53]),
            ('F', [37.89, 48.64]),
            ('G', [180.22, 151.04]),
        ];
        let fil = ["2", "1", "2", "1", "1", "1", "1"];
        assert_eq!(run_of(&bl2, &fil, '1'), "DEGBF");
        assert_eq!(run_of(&bl2, &fil, '2'), "CA");
        // No object of the filament: an empty run.
        assert_eq!(run_of(&bl2, &fil, '3'), "");
    }

    /// Object numbers (from 1, plate order) of `order`, joined by `>`, first printed first.
    fn ids(order: &[usize]) -> String {
        order
            .iter()
            .map(|i| (i + 1).to_string())
            .collect::<Vec<_>>()
            .join(">")
    }

    /// The `Chain` brim order and object order of objects at `centers` (plate order).
    fn chain_of(centers: &[[f64; 2]]) -> (String, String) {
        (
            ids(&brim_order(Rule::Chain, centers)),
            ids(&order_by(Rule::Chain, centers)),
        )
    }

    #[test]
    fn a_chain_takes_the_closest_pairs_with_two_links_each_and_no_loop() {
        // A row: 180-210 (30 mm) first, then 40-180; 40-210 would close a loop.
        assert_eq!(
            chain_of(&[[40.0, 105.0], [180.0, 105.0], [210.0, 105.0]]),
            ("1>2>3".into(), "1>2>3".into())
        );
        assert_eq!(
            chain_of(&[[40.0, 105.0], [70.0, 105.0], [210.0, 105.0]]),
            ("3>2>1".into(), "3>2>1".into())
        );
        // An L: 1-2 (130), then 1-3 (170); 2-3 (213) would close a loop.
        assert_eq!(
            chain_of(&[[40.0, 40.0], [40.0, 170.0], [210.0, 40.0]]),
            ("3>1>2".into(), "3>1>2".into())
        );
        // Five scattered objects: the center object takes two links, and the plate's object list order plays no part.
        let five = [
            [60.0, 160.0],
            [200.0, 40.0],
            [130.0, 110.0],
            [30.0, 50.0],
            [220.0, 170.0],
        ];
        assert_eq!(chain_of(&five), ("5>2>3>1>4".into(), "5>2>3>1>4".into()));
        let mut back = five;
        back.reverse();
        assert_eq!(chain_of(&back), ("1>4>3>5>2".into(), "1>4>3>5>2".into()));
        // The origin plays no part either: the same plate moved across the bed keeps its order.
        let moved: Vec<[f64; 2]> = five.iter().map(|c| [c[0] + 7.5, c[1] - 12.25]).collect();
        assert_eq!(chain_of(&moved).1, "5>2>3>1>4");
    }

    #[test]
    fn a_chain_starts_at_the_end_whose_last_record_is_shorter_at_full_precision() {
        // Two pairs, 18 and 21 mm, joined last. The object at 40 last records 60 mm (to the one at 100), the one at 121
        // 63 mm (to the one at 58, recorded before 58 linked on), so the chain starts at 40, the end of the shorter
        // end link. The ids play no part.
        let pairs = [[40.0, 100.0], [58.0, 100.0], [100.0, 100.0], [121.0, 100.0]];
        assert_eq!(chain_of(&pairs), ("1>2>3>4".into(), "1>2>3>4".into()));
        let mut back = pairs;
        back.reverse();
        assert_eq!(chain_of(&back).0, "4>3>2>1");
        // A gap 0.03 mm longer than the other decides the start.
        assert_eq!(
            chain_of(&[[39.97, 105.0], [85.0, 105.0], [130.0, 105.0]]).0,
            "1>2>3"
        );
        assert_eq!(
            chain_of(&[[40.03, 105.0], [85.0, 105.0], [130.0, 105.0]]).0,
            "3>2>1"
        );
        assert_eq!(
            chain_of(&[[40.0, 105.0], [85.0, 105.0], [130.03, 105.0]]).0,
            "3>2>1"
        );
        assert_eq!(
            chain_of(&[[40.0, 105.0], [85.0, 105.0], [129.97, 105.0]]).0,
            "1>2>3"
        );
        // Along a column and a diagonal too.
        assert_eq!(
            chain_of(&[[125.0, 29.97], [125.0, 75.0], [125.0, 120.0]]).0,
            "1>2>3"
        );
        assert_eq!(
            chain_of(&[[40.0, 170.0], [80.0, 138.0], [120.023, 105.981]]).0,
            "3>2>1"
        );
        // Seven objects where the last link joins two chains of several objects.
        let seven = [
            [143.0, 74.0],
            [122.0, 41.0],
            [204.0, 175.0],
            [129.0, 128.0],
            [186.0, 53.0],
            [72.0, 58.0],
            [161.0, 157.0],
        ];
        assert_eq!(chain_of(&seven), ("5>1>2>6>4>7>3".into(), "5>1>2>6>4>7>3".into()));
    }

    #[test]
    fn two_objects_print_brims_by_y_then_x_and_objects_by_number_unless_y_is_equal() {
        // Brims: the larger y first, whatever the numbers. Objects: object 1 first when y differs.
        assert_eq!(
            chain_of(&[[88.0, 144.0], [144.0, 124.0]]),
            ("1>2".into(), "1>2".into())
        );
        assert_eq!(
            chain_of(&[[144.0, 124.0], [88.0, 144.0]]),
            ("2>1".into(), "1>2".into())
        );
        assert_eq!(
            chain_of(&[[116.0, 103.0], [179.0, 98.0]]),
            ("1>2".into(), "1>2".into())
        );
        assert_eq!(
            chain_of(&[[179.0, 98.0], [116.0, 103.0]]),
            ("2>1".into(), "1>2".into())
        );
        // y 1 mm apart is not a tie.
        assert_eq!(
            chain_of(&[[40.0, 105.0], [200.0, 106.0]]),
            ("2>1".into(), "1>2".into())
        );
        assert_eq!(
            chain_of(&[[125.0, 40.0], [126.0, 170.0]]),
            ("2>1".into(), "1>2".into())
        );
        // y equal: the larger x first, for the brims and the objects.
        assert_eq!(
            chain_of(&[[40.0, 105.0], [125.0, 105.0]]),
            ("2>1".into(), "2>1".into())
        );
        assert_eq!(
            chain_of(&[[125.0, 105.0], [40.0, 105.0]]),
            ("1>2".into(), "1>2".into())
        );
        // x equal: brims the larger y first, objects object 1 first.
        assert_eq!(
            chain_of(&[[125.0, 40.0], [125.0, 170.0]]),
            ("2>1".into(), "1>2".into())
        );
        assert_eq!(
            chain_of(&[[125.0, 170.0], [125.0, 40.0]]),
            ("1>2".into(), "1>2".into())
        );
    }

    #[test]
    fn equal_end_records_start_at_the_larger_y_then_the_larger_x() {
        // Two pairs 20 mm apart joined by a 40 mm link: both ends last record the far object of the other pair, 60 mm
        // away, and the end links are equal too. A row starts at the larger x, a column at the larger y, whatever the
        // numbers.
        let row = [[40.0, 100.0], [60.0, 100.0], [100.0, 100.0], [120.0, 100.0]];
        assert_eq!(chain_of(&row).0, "4>3>2>1");
        let mut back = row;
        back.reverse();
        assert_eq!(chain_of(&back).0, "1>2>3>4");
        assert_eq!(
            chain_of(&[[100.0, 40.0], [100.0, 60.0], [100.0, 100.0], [100.0, 120.0]]).0,
            "4>3>2>1"
        );
    }

    #[test]
    fn equal_gaps_follow_the_order_the_records_are_made_in() {
        // Lines of equal gaps (current rule): records of equal distance are taken in the order they were made, so
        // the object numbers decide. Every link of the line is taken, and the line moved by a fraction of a
        // millimeter keeps its order.
        assert_eq!(
            chain_of(&[[125.0, 30.0], [125.0, 75.0], [125.0, 120.0]]).0,
            "3>2>1"
        );
        assert_eq!(
            chain_of(&[[125.0, 120.0], [125.0, 75.0], [125.0, 30.0]]).0,
            "3>2>1"
        );
        assert_eq!(
            chain_of(&[[40.0, 105.0], [85.0, 105.0], [130.0, 105.0]]).0,
            "3>2>1"
        );
        assert_eq!(
            chain_of(&[[40.37, 105.123], [85.37, 105.123], [130.37, 105.123]]).0,
            "3>2>1"
        );
    }

    #[test]
    fn the_origin_rule_is_unchanged_by_the_chain_rule() {
        let pts = [
            [173.31, 198.40],
            [131.58, 111.87],
            [135.17, 160.00],
            [188.67, 59.14],
        ];
        assert_eq!(order_by(Rule::OriginLast, &pts), order(&pts));
        assert_eq!(brim_order(Rule::OriginLast, &pts), order(&pts));
        assert_eq!(order_by(Rule::OriginLast, &pts[..2]), order(&pts[..2]));
        assert_eq!(run_by(Rule::OriginLast, &pts, |_| true), order(&pts));
        let with = |i: usize| i != 1;
        // A run under the chain rule orders its own objects alone.
        assert_eq!(
            ids(&run_by(
                Rule::Chain,
                &[[40.0, 105.0], [500.0, 0.0], [125.0, 105.0]],
                with
            )),
            "3>1"
        );
    }
}
