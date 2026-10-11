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

/// A paint text as a tree: a leaf with its state, or a split of 1 to 3 sides about a special corner with its children
/// (2, 3 or 4) in the stream's order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Leaf(u8),
    Split {
        splits: u8,
        special: u8,
        kids: Vec<Node>,
    },
}

/// The corners of a split's children, in the stream's order (the layout `leaves` reads).
fn kids_of(v: [V3; 3], splits: u8, special: u8) -> Option<Vec<[V3; 3]>> {
    let s = usize::from(special);
    let p = [*v.get(s)?, *v.get((s + 1) % 3)?, *v.get((s + 2) % 3)?];
    let (m_a, m_b, m_c) = (mid(p[0], p[1]), mid(p[2], p[0]), mid(p[1], p[2]));
    let kids: Vec<([V3; 3], usize)> = match splits {
        1 => vec![([p[0], m_c, p[2]], 1), ([p[0], p[1], m_c], 0)],
        2 => vec![
            ([m_b, p[1], p[2]], 1),
            ([m_a, p[1], m_b], 0),
            ([p[0], m_a, m_b], 0),
        ],
        3 => vec![
            ([m_a, m_c, m_b], 0),
            ([m_b, m_c, p[2]], 1),
            ([m_a, p[1], m_c], 0),
            ([p[0], m_a, m_b], 0),
        ],
        _ => return None,
    };
    Some(
        kids.into_iter()
            .map(|(mut c, rot)| {
                c.rotate_left(rot);
                c
            })
            .collect(),
    )
}

fn parse_node(r: &mut Reader, depth: u32) -> Option<Node> {
    let code = r.next()?;
    let splits = code & 3;
    let special = code >> 2;
    if splits == 0 {
        let state = if special == 3 {
            r.next()?.checked_add(3)?
        } else {
            special
        };
        return Some(Node::Leaf(state));
    }
    if depth >= MAX_DEPTH || special > 2 {
        return None;
    }
    let n = usize::from(splits) + 1;
    let kids = (0..n)
        .map(|_| parse_node(r, depth + 1))
        .collect::<Option<Vec<_>>>()?;
    Some(Node::Split {
        splits,
        special,
        kids,
    })
}

/// The tree of a paint text; `None` for one that does not read.
#[must_use]
pub fn parse(text: &str) -> Option<Node> {
    let stream: Vec<u8> = text
        .trim()
        .chars()
        .rev()
        .map(|c| c.to_digit(16).and_then(|d| u8::try_from(d).ok()))
        .collect::<Option<_>>()?;
    let mut r = Reader { stream, at: 0 };
    parse_node(&mut r, 0)
}

fn encode_node(n: &Node, out: &mut Vec<u8>) {
    match n {
        Node::Leaf(s) if *s >= 3 => {
            out.push(0b1100);
            out.push((s - 3).min(15));
        }
        Node::Leaf(s) => out.push(s << 2),
        Node::Split {
            splits,
            special,
            kids,
        } => {
            out.push(splits | (special << 2));
            for k in kids {
                encode_node(k, out);
            }
        }
    }
}

/// The paint text of a tree (upper-case hex, written last code first): what `parse` reads back.
#[must_use]
pub fn encode(n: &Node) -> String {
    let mut stream = Vec::new();
    encode_node(n, &mut stream);
    stream
        .iter()
        .rev()
        .map(|d| {
            char::from_digit(u32::from(*d), 16)
                .unwrap_or('0')
                .to_ascii_uppercase()
        })
        .collect()
}

/// The tree with splits whose children are all one state made leaves.
#[must_use]
pub fn simplify(n: Node) -> Node {
    match n {
        Node::Leaf(_) => n,
        Node::Split {
            splits,
            special,
            kids,
        } => {
            let kids: Vec<Node> = kids.into_iter().map(simplify).collect();
            match kids.first() {
                Some(Node::Leaf(s)) if kids.iter().all(|k| *k == Node::Leaf(*s)) => Node::Leaf(*s),
                _ => Node::Split {
                    splits,
                    special,
                    kids,
                },
            }
        }
    }
}

/// How much of a piece a region holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cover {
    All,
    Part,
    None,
}

/// The tree with the pieces `region` covers set to `state`. A leaf partly covered is split in four, down to
/// `max_depth` levels from the triangle, where its center decides.
#[must_use]
pub fn paint_region(
    n: &Node,
    v: [V3; 3],
    region: &dyn Fn(&[V3; 3]) -> Cover,
    state: u8,
    depth: u32,
    max_depth: u32,
) -> Node {
    match region(&v) {
        Cover::All => return Node::Leaf(state),
        Cover::None => return n.clone(),
        Cover::Part => {}
    }
    match n {
        Node::Split {
            splits,
            special,
            kids,
        } => {
            let corners = kids_of(v, *splits, *special).unwrap_or_default();
            let kids = kids
                .iter()
                .zip(corners)
                .map(|(k, c)| paint_region(k, c, region, state, depth + 1, max_depth))
                .collect();
            Node::Split {
                splits: *splits,
                special: *special,
                kids,
            }
        }
        Node::Leaf(s) => {
            if depth >= max_depth.min(MAX_DEPTH - 1) {
                let c = [
                    (v[0][0] + v[1][0] + v[2][0]) / 3.0,
                    (v[0][1] + v[1][1] + v[2][1]) / 3.0,
                    (v[0][2] + v[1][2] + v[2][2]) / 3.0,
                ];
                return if region(&[c, c, c]) == Cover::None {
                    Node::Leaf(*s)
                } else {
                    Node::Leaf(state)
                };
            }
            let corners = kids_of(v, 3, 0).unwrap_or_default();
            let kids = corners
                .into_iter()
                .map(|c| paint_region(&Node::Leaf(*s), c, region, state, depth + 1, max_depth))
                .collect();
            Node::Split {
                splits: 3,
                special: 0,
                kids,
            }
        }
    }
}

/// The tree with every piece of state `from` set to `to`.
#[must_use]
pub fn replace(n: &Node, from: u8, to: u8) -> Node {
    match n {
        Node::Leaf(s) if *s == from => Node::Leaf(to),
        Node::Leaf(_) => n.clone(),
        Node::Split {
            splits,
            special,
            kids,
        } => Node::Split {
            splits: *splits,
            special: *special,
            kids: kids.iter().map(|k| replace(k, from, to)).collect(),
        },
    }
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
    fn a_tree_encodes_back_to_its_text() {
        for text in [
            "4", "8", "0C", "1C", "2C", "481", "485", "489", "1C0C843", "88083", "0C01", "8048C4C3",
            "4444443",
        ] {
            let t = parse(text).unwrap();
            // A text with codes past its tree (8048C4C3 and 4444443 have some) reads the same without them.
            if !["8048C4C3", "4444443"].contains(&text) {
                assert_eq!(encode(&t), text, "{text}");
            }
            let e = encode(&t);
            assert_eq!(encode(&parse(&e).unwrap()), e, "{text}");
            let a = leaves(text, TRI).unwrap();
            let b = leaves(&encode(&t), TRI).unwrap();
            assert_eq!(a, b, "{text}");
        }
        assert!(parse("zz").is_none() && parse("1").is_none());
        assert_eq!(simplify(parse("4444443").unwrap()), Node::Leaf(1));
    }

    #[test]
    fn a_band_splits_a_triangle_at_its_edge() {
        // A vertical triangle 0 to 20 mm tall: paint state 2 below 5 mm.
        let tri: [V3; 3] = [[0.0, 0.0, 0.0], [20.0, 0.0, 0.0], [0.0, 0.0, 20.0]];
        let band = |v: &[V3; 3]| {
            let (lo, hi) = (
                v.iter().map(|p| p[2]).fold(f64::MAX, f64::min),
                v.iter().map(|p| p[2]).fold(f64::MIN, f64::max),
            );
            if hi <= 5.0 {
                Cover::All
            } else if lo >= 5.0 {
                Cover::None
            } else {
                Cover::Part
            }
        };
        let t = simplify(paint_region(&Node::Leaf(0), tri, &band, 2, 0, 6));
        let text = encode(&t);
        let area3 = |v: &[V3; 3]| crate::vec3::len(crate::vec3::tri_normal(v[0], v[1], v[2])) / 2.0;
        let painted: f64 = leaves(&text, tri)
            .unwrap()
            .iter()
            .filter(|(_, s)| *s == 2)
            .map(|(v, _)| area3(v))
            .sum();
        // The exact band is the triangle below z = 5: 200 - (15 * 15) / 2 = 87.5 mm2; six levels come within a few.
        assert!((painted - 87.5).abs() < 4.0, "{painted} {text}");
        assert!(
            leaves(&text, tri)
                .unwrap()
                .iter()
                .all(|(v, s)| *s != 2 || v.iter().all(|p| p[2] <= 5.0 + 20.0 / 64.0))
        );
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
