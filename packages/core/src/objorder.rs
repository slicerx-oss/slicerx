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
    let mut pairs: Vec<(i128, usize, usize)> = Vec::with_capacity(n * (n - 1) / 2);
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
    let cap = |i: usize| if i == anchor { 1 } else { 2 };
    let mut made = 0;
    for &(_, i, j) in &pairs {
        if made + 1 == n {
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
    // Walk the path from the object nearest the origin, then print it the other way round.
    let mut walk: Vec<usize> = Vec::with_capacity(n);
    let (mut prev, mut cur) = (usize::MAX, anchor);
    while walk.len() < n {
        walk.push(cur);
        let Some(&next) = links
            .get(cur)
            .and_then(|l| l.iter().find(|&&k| k != prev && k != usize::MAX))
        else {
            break;
        };
        (prev, cur) = (cur, next);
    }
    walk.reverse();
    walk
}

/// Whether the plate prints its objects in object list order on every layer (`print_order`).
pub(crate) fn list_order(cfg: &crate::config::PrintConfig) -> bool {
    matches!(cfg.raw.get("print_order"), Some(serde_json::Value::String(t)) if t == "as_obj_list")
}

#[cfg(test)]
mod tests {
    use super::order;

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
}
