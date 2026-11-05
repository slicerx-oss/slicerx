// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The per-triangle paint text of 3MF files (`paint_color`, `paint_seam`, `paint_supports`, `paint_fuzzy_skin`): a
//! stream of 4-bit codes, written last code first. A code is a leaf (bits 0 and 1 are 0; the state sits in bits 2 and
//! 3, or, when both are set, in the codes after it) or a split (bits 0 and 1 count the split sides, 1 to 3; bits 2 and
//! 3 name the special corner), followed by its children in order.
//!
//! After a leaf code C the state is written one of two ways ([`Scheme`]). The `paint_*` attributes use a run: 3 plus
//! each code, where every F adds 15 and the first code below F ends it, so 3 to 17 take one code and 18 to 32 two (18
//! is `C F 0`, text `0FC`). The `slic3rpe:*` attributes and the facets JSON use an escape: one code for 3 to 16, or E
//! and then an 8-bit value, low code first, for 17 and up (17 is `C E 0 0`). States 0 to 16 read the same either way.
//!
//! Each text reads on its own: one that runs out, or holds anything but `0` to `9` and `A` to `F`, does not read.
//! Codes past a whole tree are ignored ([`left_over`] counts them). A state above [`MAX_STATE`] reads as unpainted. Files saved before 18 took two codes wrote it
//! as a whole text of `FC`, which still reads as 18.
//!
//! The same reading as the slicer's (`sx_core::paint::decode`), here for the mesh tools: rendering painted models,
//! and painting by target. A test in `sx-core` checks both read the same texts alike.

use crate::vec3::V3;

/// A leaf of a painted triangle: its corners and its state (0 unpainted; for color, the 1-based filament).
pub type Leaf = ([V3; 3], u8);

/// Deepest nesting read, so a broken text cannot run away.
pub const MAX_DEPTH: u32 = 12;

/// The highest state a paint text names (for color, filament 32). A higher one reads as unpainted.
pub const MAX_STATE: u8 = 32;

/// How a text writes the states after a leaf code C.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    /// The `paint_*` attributes: F codes adding 15 each, ended by a code below F.
    Run,
    /// The `slic3rpe:*` attributes and the facets JSON: one code for 3 to 16, or E and then an 8-bit value (low code
    /// first) for 17 and up.
    Escape,
}

/// The codes of a text in stream order (the text is written backwards); `None` for anything but upper-case hex.
fn codes(text: &str) -> Option<Vec<u8>> {
    text.trim()
        .bytes()
        .rev()
        .map(|c| match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        })
        .collect()
}

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
    scheme: Scheme,
}

impl Reader {
    /// A reader of `text`, `None` when it is empty or not upper-case hex.
    fn of(text: &str, scheme: Scheme) -> Option<Self> {
        let stream = codes(text)?;
        if stream.is_empty() {
            return None;
        }
        Some(Self {
            stream,
            at: 0,
            scheme,
        })
    }

    fn next(&mut self) -> Option<u8> {
        let v = *self.stream.get(self.at)?;
        self.at += 1;
        Some(v)
    }

    /// The codes not read yet: past a whole tree, they are ignored.
    fn rest(&self) -> usize {
        self.stream.len() - self.at
    }

    /// The state of a leaf whose code is C, from the codes after it; one above [`MAX_STATE`] is 0.
    fn extended(&mut self) -> Option<u8> {
        let mut state: u32 = 3;
        match self.scheme {
            Scheme::Run => loop {
                let c = self.next()?;
                state += u32::from(c);
                if c < 15 {
                    break;
                }
            },
            Scheme::Escape => {
                let c = self.next()?;
                if c == 14 {
                    let lo = self.next()?;
                    let hi = self.next()?;
                    state = 17 + u32::from(lo) + 16 * u32::from(hi);
                } else {
                    state += u32::from(c);
                }
            }
        }
        Some(u8::try_from(state).ok().filter(|s| *s <= MAX_STATE).unwrap_or(0))
    }

    fn node(&mut self, v: [V3; 3], depth: u32, out: &mut Vec<Leaf>) -> Option<()> {
        let code = self.next()?;
        let splits = code & 3;
        let special = usize::from(code >> 2);
        if splits == 0 {
            let state = if special == 3 { self.extended()? } else { code >> 2 };
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

/// Every leaf of triangle `tri` that a `paint_*` text describes, unpainted ones included, so the leaves cover the
/// triangle. `None` for a text that does not read.
#[must_use]
pub fn leaves(text: &str, tri: [V3; 3]) -> Option<Vec<Leaf>> {
    if is_legacy(text) {
        return Some(vec![(tri, LEGACY_STATE)]);
    }
    let mut r = Reader::of(text, Scheme::Run)?;
    let mut out = Vec::new();
    r.node(tri, 0, &mut out)?;
    Some(out)
}

/// How many codes a `paint_*` text has past its whole tree, which reading ignores; `None` for one that does not read.
#[must_use]
pub fn left_over(text: &str) -> Option<usize> {
    if is_legacy(text) {
        return Some(0);
    }
    let mut r = Reader::of(text, Scheme::Run)?;
    parse_node(&mut r, 0)?;
    Some(r.rest())
}

/// The state a whole text of `FC` stands for: files saved before 18 took two codes wrote it so.
const LEGACY_STATE: u8 = 18;

/// A whole text of exactly `FC`, which reads as 18 for those files.
fn is_legacy(text: &str) -> bool {
    text.trim() == "FC"
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

/// The corners of a split's children, in the stream's order (the layout `leaves` reads), for building a tree: `splits`
/// 1 to 3 sides about the `special` corner (3 and 0 split in four).
#[must_use]
pub fn split_corners(v: [V3; 3], splits: u8, special: u8) -> Option<Vec<[V3; 3]>> {
    kids_of(v, splits, special)
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
        let state = if special == 3 { r.extended()? } else { special };
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

/// The tree of a `paint_*` text; `None` for one that does not read.
#[must_use]
pub fn parse(text: &str) -> Option<Node> {
    if is_legacy(text) {
        return Some(Node::Leaf(LEGACY_STATE));
    }
    parse_with(text, Scheme::Run)
}

/// The tree of a text written in `scheme`; `None` for one that does not read.
#[must_use]
pub fn parse_with(text: &str, scheme: Scheme) -> Option<Node> {
    let mut r = Reader::of(text, scheme)?;
    parse_node(&mut r, 0)
}

fn encode_node(n: &Node, scheme: Scheme, out: &mut Vec<u8>) {
    match n {
        Node::Leaf(s) if *s >= 3 => {
            out.push(0b1100);
            match scheme {
                Scheme::Run => {
                    let mut m = s - 3;
                    while m >= 15 {
                        out.push(15);
                        m -= 15;
                    }
                    out.push(m);
                }
                Scheme::Escape if *s >= 17 => {
                    let v = s - 17;
                    out.extend([14, v & 15, v >> 4]);
                }
                Scheme::Escape => out.push(s - 3),
            }
        }
        Node::Leaf(s) => out.push(s << 2),
        Node::Split {
            splits,
            special,
            kids,
        } => {
            out.push(splits | (special << 2));
            for k in kids {
                encode_node(k, scheme, out);
            }
        }
    }
}

/// The `paint_*` text of a tree (upper-case hex, written last code first): what `parse` reads back.
#[must_use]
pub fn encode(n: &Node) -> String {
    encode_with(n, Scheme::Run)
}

/// A text written in the escape scheme as a `paint_*` text; `None` for one that does not read or is all unpainted.
#[must_use]
pub fn escape_to_run(text: &str) -> Option<String> {
    match parse_with(text, Scheme::Escape)? {
        Node::Leaf(0) => None,
        n => Some(encode(&n)),
    }
}

/// The text of a tree written in `scheme`: what `parse_with` reads back.
#[must_use]
pub fn encode_with(n: &Node, scheme: Scheme) -> String {
    let mut stream = Vec::new();
    encode_node(n, scheme, &mut stream);
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
            "4", "8", "0C", "1C", "2C", "481", "485", "489", "1C0C843", "88083", "0C01", "44443", "8048C4C3",
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
        assert_eq!(simplify(parse("44443").unwrap()), Node::Leaf(1));
    }

    /// A split in the order the format lists children (child 0 first); the tree holds them in stream order.
    fn split(splits: u8, special: u8, kids: Vec<Node>) -> Node {
        Node::Split {
            splits,
            special,
            kids: kids.into_iter().rev().collect(),
        }
    }

    #[test]
    fn filament_18_takes_two_codes_after_the_leaf() {
        // 17 is one code after C; 18 starts the run, F then 0.
        assert_eq!(encode(&Node::Leaf(16)), "DC");
        assert_eq!(encode(&Node::Leaf(17)), "EC");
        assert_eq!(encode(&Node::Leaf(18)), "0FC");
        assert_eq!(parse("0FC"), Some(Node::Leaf(18)));
        assert_eq!(leaves("0FC", TRI).unwrap(), vec![(TRI, 18)]);
        // A tree with 17 and 18 side by side reads back whole.
        let t5 = split(1, 0, vec![Node::Leaf(17), Node::Leaf(18)]);
        assert_eq!(encode(&t5), "EC0FC1");
        assert_eq!(parse("EC0FC1"), Some(t5));
    }

    #[test]
    fn a_text_saved_with_18_as_fc_still_reads_18() {
        assert_eq!(parse("FC"), Some(Node::Leaf(18)));
        assert_eq!(leaves("FC", TRI).unwrap(), vec![(TRI, 18)]);
        assert_eq!(encode(&parse("FC").unwrap()), "0FC");
    }

    /// Single leaves: state, its `paint_*` text, its escape text.
    const LEAVES: &[(u8, &str, &str)] = &[
        (1, "4", "4"),
        (2, "8", "8"),
        (3, "0C", "0C"),
        (4, "1C", "1C"),
        (15, "CC", "CC"),
        (16, "DC", "DC"),
        (17, "EC", "00EC"),
        (18, "0FC", "01EC"),
        (19, "1FC", "02EC"),
        (20, "2FC", "03EC"),
        (31, "DFC", "0EEC"),
        (32, "EFC", "0FEC"),
    ];

    #[test]
    fn every_filament_to_32_writes_and_reads_in_both_schemes() {
        for &(s, run, esc) in LEAVES {
            assert_eq!(encode(&Node::Leaf(s)), run, "{s}");
            assert_eq!(parse(run), Some(Node::Leaf(s)), "{run}");
            assert_eq!(leaves(run, TRI), Some(vec![(TRI, s)]), "{run}");
            assert_eq!(encode_with(&Node::Leaf(s), Scheme::Escape), esc, "{s}");
            assert_eq!(parse_with(esc, Scheme::Escape), Some(Node::Leaf(s)), "{esc}");
            assert_eq!(escape_to_run(esc).as_deref(), Some(run), "{esc}");
        }
        // The escape scheme reads C F as 18.
        assert_eq!(parse_with("FC", Scheme::Escape), Some(Node::Leaf(18)));
    }

    #[test]
    fn a_state_past_32_reads_as_unpainted() {
        // 33 in each scheme, and 255.
        assert_eq!(parse("0FFC"), Some(Node::Leaf(0)));
        assert_eq!(leaves("0FFC", TRI), Some(vec![(TRI, 0)]));
        assert_eq!(parse_with("10EC", Scheme::Escape), Some(Node::Leaf(0)));
        assert_eq!(parse_with("EEEC", Scheme::Escape), Some(Node::Leaf(0)));
        assert_eq!(escape_to_run("10EC"), None);
        // Inside a tree the other leaves keep their states.
        assert_eq!(
            parse("0FFC41"),
            Some(Node::Split {
                splits: 1,
                special: 0,
                kids: vec![Node::Leaf(1), Node::Leaf(0)]
            })
        );
    }

    #[test]
    fn trees_write_and_read_in_both_schemes() {
        let l = Node::Leaf;
        let trees = [
            (split(1, 0, vec![l(1), l(2)]), "481", "481"),
            (split(1, 2, vec![l(0), l(19)]), "01FC9", "002EC9"),
            (
                split(3, 0, vec![l(5), l(0), l(32), l(1)]),
                "2C0EFC43",
                "2C00FEC43",
            ),
            (
                split(2, 1, vec![split(1, 0, vec![l(18), l(3)]), l(0), l(31)]),
                "0FC0C10DFC6",
                "01EC0C100EEC6",
            ),
            (split(1, 0, vec![l(17), l(18)]), "EC0FC1", "00EC01EC1"),
        ];
        for (tree, run, esc) in trees {
            assert_eq!(encode(&tree), run);
            assert_eq!(parse(run).as_ref(), Some(&tree), "{run}");
            assert_eq!(encode_with(&tree, Scheme::Escape), esc);
            assert_eq!(parse_with(esc, Scheme::Escape).as_ref(), Some(&tree), "{esc}");
            assert_eq!(escape_to_run(esc).as_deref(), Some(run), "{esc}");
        }
    }

    #[test]
    fn each_scheme_reads_the_other_as_written_or_not_at_all() {
        let state = |t: &str, s: Scheme| match parse_with(t, s) {
            Some(Node::Leaf(v)) => Some(v),
            _ => None,
        };
        // Run texts: 19 and 32 read as 18 in the escape scheme, which stops after C F; 17 runs out there.
        assert_eq!(state("1FC", Scheme::Run), Some(19));
        assert_eq!(state("1FC", Scheme::Escape), Some(18));
        assert_eq!(state("EFC", Scheme::Run), Some(32));
        assert_eq!(state("EFC", Scheme::Escape), Some(18));
        assert_eq!(state("EC", Scheme::Run), Some(17));
        assert_eq!(state("EC", Scheme::Escape), None);
        // Escape texts: 19 and 32 read as 17 in the run scheme, which stops after C E.
        assert_eq!(state("02EC", Scheme::Escape), Some(19));
        assert_eq!(state("02EC", Scheme::Run), Some(17));
        assert_eq!(state("0FEC", Scheme::Escape), Some(32));
        assert_eq!(state("0FEC", Scheme::Run), Some(17));
        // FC: 18 in the escape scheme, and as a whole paint_* text.
        assert_eq!(state("FC", Scheme::Escape), Some(18));
        assert_eq!(parse("FC"), Some(Node::Leaf(18)));
    }

    #[test]
    fn a_text_that_runs_out_or_is_lower_case_does_not_read() {
        for text in ["0fc", "dc", "0fC", "c", "C", "FFC", "1", "FC1", "zz", ""] {
            assert_eq!(parse(text), None, "{text}");
            assert_eq!(leaves(text, TRI), None, "{text}");
        }
        assert_eq!(parse_with("00ec", Scheme::Escape), None);
        assert_eq!(escape_to_run("00ec"), None);
        assert_eq!(parse_with("0EC", Scheme::Escape), None);
        // Spaces around a text are not part of it.
        assert_eq!(parse(" 0FC\n"), Some(Node::Leaf(18)));
    }

    #[test]
    fn codes_past_a_whole_tree_are_ignored_and_counted() {
        assert_eq!(parse("48"), Some(Node::Leaf(2)));
        assert_eq!(leaves("48", TRI), Some(vec![(TRI, 2)]));
        assert_eq!(left_over("48"), Some(1));
        assert_eq!(left_over("4444443"), Some(2));
        assert_eq!(left_over("8048C4C3"), Some(1));
        assert_eq!(left_over("0FC"), Some(0));
        assert_eq!(left_over("FC"), Some(0));
        assert_eq!(left_over("0fc"), None);
        assert_eq!(escape_to_run("402EC").as_deref(), Some("1FC"));
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
