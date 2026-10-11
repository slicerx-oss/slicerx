// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The per-triangle paint text of Bambu and Orca 3MF files (`paint_color`, `paint_seam`, `paint_supports`,
//! `paint_fuzzy_skin`): a stream of 4-bit codes, written last code first. A code is a leaf (bits 0 and 1 are 0; the
//! state follows in bits 2 and 3, or in the next code plus 3 when bits 2 and 3 are both set) or a split (bits 0 and 1
//! count the split sides, 1 to 3; bits 2 and 3 name the special corner), followed by its children in order.
//!
//! The same reading as the slicer's (`sx_core::paint::decode`), here for the mesh tools: rendering painted models,
//! and painting by target. A test in `sx-core` checks both read the same texts alike.

use crate::vec3::V3;

/// A leaf of a painted triangle: its corners and its state (0 unpainted; for color, the 1-based filament).
pub type Leaf = ([V3; 3], u8);

/// Deepest nesting read, so a broken text cannot run away.
const MAX_DEPTH: u32 = 12;

fn mid(a: V3, b: V3) -> V3 {
    [
        f64::midpoint(a[0], b[0]),
        f64::midpoint(a[1], b[1]),
        f64::midpoint(a[2], b[2]),
    ]
}

struct Reader {
    stream: Vec<u8>,
    at: usize,
}

impl Reader {
    fn next(&mut self) -> Option<u8> {
        let v = *self.stream.get(self.at)?;
        self.at += 1;
        Some(v)
    }

    fn node(&mut self, v: [V3; 3], depth: u32, out: &mut Vec<Leaf>) -> Option<()> {
        let code = self.next()?;
        let splits = code & 3;
        let special = usize::from(code >> 2);
        if splits == 0 {
            let state = if special == 3 {
                self.next()?.checked_add(3)?
            } else {
                code >> 2
            };
            out.push((v, state));
            return Some(());
        }
        if depth >= MAX_DEPTH || special > 2 {
            return None;
        }
        let p = [
            *v.get(special)?,
            *v.get((special + 1) % 3)?,
            *v.get((special + 2) % 3)?,
        ];
        let (m_a, m_b, m_c) = (mid(p[0], p[1]), mid(p[2], p[0]), mid(p[1], p[2]));
        // Each child: its corners, then how far its own corner list is rotated.
        let kids: Vec<([V3; 3], usize)> = match splits {
            1 => vec![([p[0], m_c, p[2]], 1), ([p[0], p[1], m_c], 0)],
            2 => vec![
                ([m_b, p[1], p[2]], 1),
                ([m_a, p[1], m_b], 0),
                ([p[0], m_a, m_b], 0),
            ],
            _ => vec![
                ([m_a, m_c, m_b], 0),
                ([m_b, m_c, p[2]], 1),
                ([m_a, p[1], m_c], 0),
                ([p[0], m_a, m_b], 0),
            ],
        };
        for (mut corners, rot) in kids {
            corners.rotate_left(rot);
            self.node(corners, depth + 1, out)?;
        }
        Some(())
    }
}

/// Every leaf of triangle `tri` that `text` describes, unpainted ones included, so the leaves cover the triangle.
/// `None` for a text that does not parse.
#[must_use]
pub fn leaves(text: &str, tri: [V3; 3]) -> Option<Vec<Leaf>> {
    let stream: Vec<u8> = text
        .trim()
        .chars()
        .rev()
        .map(|c| c.to_digit(16).and_then(|d| u8::try_from(d).ok()))
        .collect::<Option<_>>()?;
    if stream.is_empty() {
        return None;
    }
    let mut r = Reader { stream, at: 0 };
    let mut out = Vec::new();
    r.node(tri, 0, &mut out)?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRI: [V3; 3] = [[0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [20.0, 20.0, 0.0]];

    fn area(v: &[V3; 3]) -> f64 {
        let [a, b, c] = *v;
        ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0
    }

    #[test]
    fn whole_triangles_and_the_extended_states() {
        assert_eq!(leaves("4", TRI).unwrap(), vec![(TRI, 1)]);
        assert_eq!(leaves("8", TRI).unwrap()[0].1, 2);
        assert_eq!(leaves("0C", TRI).unwrap()[0].1, 3);
        assert_eq!(leaves("1C", TRI).unwrap()[0].1, 4);
        assert_eq!(leaves("0", TRI).unwrap()[0].1, 0);
        assert!(leaves("zz", TRI).is_none());
        assert!(leaves("", TRI).is_none());
        // A split that runs out of codes.
        assert!(leaves("1", TRI).is_none());
    }

    #[test]
    fn the_leaves_of_a_split_cover_the_triangle() {
        for text in ["481", "485", "1C0C843", "88083"] {
            let l = leaves(text, TRI).unwrap();
            let total: f64 = l.iter().map(|(v, _)| area(v)).sum();
            assert!((total - 200.0).abs() < 1e-9, "{text}: {total}");
        }
        // Special corner 0 splits the side opposite it: the first child is the one by the far corner.
        let both = leaves("481", TRI).unwrap();
        let first = both.iter().find(|(_, s)| *s == 2).unwrap();
        assert!(
            first
                .0
                .iter()
                .any(|p| (p[0] - 20.0).abs() < 1e-12 && (p[1] - 10.0).abs() < 1e-12)
        );
    }
}
