// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Painting a mesh by targets a person can name, and reading paint back. One paint layer at a time (color, seam,
//! support or fuzzy skin), its paint as the per-triangle texts of a 3MF: a target picks surface, `select` gives the
//! texts of the triangles it changes, and `regions` reads paint back as connected regions per state with their areas.
//!
//! Targets: the whole part; faces facing a direction (the bottom, the top, a vector), with the connected regions
//! they make and a pick among them; a height band, split exactly at its edges; region growing from a point on the
//! surface (across edges under an angle, or over one state like a bucket); and one state for another.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rustc_hash::FxHashMap;

use crate::fm::Fm as _;
use crate::mesh::{Aabb, TriMesh};
use crate::paint_tree::{self, Cover, Node};
use crate::vec3::{self, V3};
use crate::{Error, Result};

/// The default depth a height band splits triangles to: a 20 mm triangle's band edge lands within 0.3 mm.
pub const DEFAULT_DEPTH: u32 = 6;

/// Which of the regions a direction target makes it paints.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pick {
    All,
    Largest,
    /// The region nearest this point.
    Nearest(V3),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    /// Every triangle.
    Part,
    /// Triangles whose normal is within `angle_deg` of `dir`.
    Direction { dir: V3, angle_deg: f64, pick: Pick },
    /// The surface between two heights (mm), split at them.
    Height { lo: f64, hi: f64 },
    /// From the triangle nearest `point`: across edges that bend less than `angle_deg` (`bucket` false), or over the
    /// triangles of the seed's state (`bucket` true).
    Seed { point: V3, angle_deg: f64, bucket: bool },
    /// Every piece of state `from`.
    Replace { from: u8 },
}

impl Target {
    /// A named direction: bottom, top, front, back, left or right.
    pub fn named_direction(name: &str) -> Option<V3> {
        Some(match name {
            "bottom" => [0.0, 0.0, -1.0],
            "top" => [0.0, 0.0, 1.0],
            "front" => [0.0, -1.0, 0.0],
            "back" => [0.0, 1.0, 0.0],
            "left" => [-1.0, 0.0, 0.0],
            "right" => [1.0, 0.0, 0.0],
            _ => return None,
        })
    }
}

/// Connected triangles with their area and bounds.
#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub triangles: Vec<u32>,
    pub area_mm2: f64,
    pub bounds: Aabb,
}

/// What a target changes.
#[derive(Debug, Clone, PartialEq)]
pub struct Selection {
    /// The new text of each triangle the target changes ("" when it is left unpainted).
    pub changed: BTreeMap<u32, String>,
    /// The regions the target picked, largest first.
    pub regions: Vec<Region>,
    /// Their area, mm2.
    pub area_mm2: f64,
}

/// The paint of one state read back.
#[derive(Debug, Clone, PartialEq)]
pub struct StateRegions {
    pub state: u8,
    pub area_mm2: f64,
    /// Triangles that hold some of the state.
    pub triangles: usize,
    /// Connected regions, largest first.
    pub regions: Vec<Region>,
}

fn tri_area(v: &[V3; 3]) -> f64 {
    vec3::len(vec3::tri_normal(v[0], v[1], v[2])) * 0.5
}

fn corners(m: &TriMesh, t: u32) -> Option<[V3; 3]> {
    let tri = m.triangles.get(t as usize)?;
    Some([
        *m.positions.get(tri[0] as usize)?,
        *m.positions.get(tri[1] as usize)?,
        *m.positions.get(tri[2] as usize)?,
    ])
}

fn grow(b: &mut Option<Aabb>, p: V3) {
    match b {
        Some(bb) => {
            for ((lo, hi), v) in bb.min.iter_mut().zip(bb.max.iter_mut()).zip(p) {
                *lo = lo.min(v);
                *hi = hi.max(v);
            }
        }
        None => *b = Some(Aabb { min: p, max: p }),
    }
}

/// Triangles that share an edge, with vertices welded by position so a mesh read from STL connects.
struct Adjacency {
    near: Vec<Vec<u32>>,
}

impl Adjacency {
    fn of(m: &TriMesh) -> Self {
        #[allow(clippy::cast_possible_truncation, reason = "positions in nm fit i64")]
        let key = |p: V3| p.map(|c| (c * 1e6).round() as i64);
        let mut welded: FxHashMap<[i64; 3], u32> = FxHashMap::default();
        let ids: Vec<u32> = m
            .positions
            .iter()
            .map(|&p| {
                let next = u32::try_from(welded.len()).unwrap_or(u32::MAX);
                *welded.entry(key(p)).or_insert(next)
            })
            .collect();
        let mut edges: FxHashMap<(u32, u32), Vec<u32>> = FxHashMap::default();
        for (i, t) in m.triangles.iter().enumerate() {
            let Ok(i) = u32::try_from(i) else { continue };
            let v = t.map(|k| ids.get(k as usize).copied().unwrap_or(u32::MAX));
            for (a, b) in [(v[0], v[1]), (v[1], v[2]), (v[2], v[0])] {
                edges.entry((a.min(b), a.max(b))).or_default().push(i);
            }
        }
        let mut near = vec![Vec::new(); m.triangles.len()];
        for list in edges.values() {
            for &a in list {
                for &b in list {
                    if a != b
                        && let Some(n) = near.get_mut(a as usize)
                    {
                        n.push(b);
                    }
                }
            }
        }
        for n in &mut near {
            n.sort_unstable();
            n.dedup();
        }
        Self { near }
    }

    /// The connected groups of `set` (triangles joined through others of `set`), each sorted, in order of their
    /// smallest triangle.
    fn groups(&self, set: &BTreeSet<u32>) -> Vec<Vec<u32>> {
        let mut seen: BTreeSet<u32> = BTreeSet::new();
        let mut out = Vec::new();
        for &start in set {
            if !seen.insert(start) {
                continue;
            }
            let mut group = vec![start];
            let mut queue = VecDeque::from([start]);
            while let Some(t) = queue.pop_front() {
                for &n in self.near.get(t as usize).into_iter().flatten() {
                    if set.contains(&n) && seen.insert(n) {
                        group.push(n);
                        queue.push_back(n);
                    }
                }
            }
            group.sort_unstable();
            out.push(group);
        }
        out
    }
}

/// The closest point of triangle `v` to `p` (Ericson, Real-Time Collision Detection, 5.1.5).
fn closest_on_triangle(p: V3, v: &[V3; 3]) -> V3 {
    let [a, b, c] = *v;
    let (ab, ac, ap) = (vec3::sub(b, a), vec3::sub(c, a), vec3::sub(p, a));
    let (d1, d2) = (vec3::dot(ab, ap), vec3::dot(ac, ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }
    let bp = vec3::sub(p, b);
    let (d3, d4) = (vec3::dot(ab, bp), vec3::dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }
    let along = |o: V3, d: V3, t: f64| [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return along(a, ab, d1 / (d1 - d3));
    }
    let cp = vec3::sub(p, c);
    let (d5, d6) = (vec3::dot(ab, cp), vec3::dot(ac, cp));
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return along(a, ac, d2 / (d2 - d6));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        return along(b, vec3::sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    }
    let denom = 1.0 / (va + vb + vc);
    let (v2, w) = (vb * denom, vc * denom);
    [
        a[0] + ab[0] * v2 + ac[0] * w,
        a[1] + ab[1] * v2 + ac[1] * w,
        a[2] + ab[2] * v2 + ac[2] * w,
    ]
}

fn nearest_triangle(m: &TriMesh, p: V3) -> Option<u32> {
    (0..m.triangles.len())
        .filter_map(|i| {
            let i = u32::try_from(i).ok()?;
            let v = corners(m, i)?;
            Some((vec3::len(vec3::sub(closest_on_triangle(p, &v), p)), i))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
        .map(|(_, i)| i)
}

/// The paint tree of a triangle: its text's, or unpainted.
fn tree_of(texts: &BTreeMap<u32, String>, t: u32) -> Node {
    texts
        .get(&t)
        .and_then(|s| paint_tree::parse(s))
        .unwrap_or(Node::Leaf(0))
}

/// The state a whole triangle has, `None` when it is split into several.
fn uniform(texts: &BTreeMap<u32, String>, t: u32) -> Option<u8> {
    match paint_tree::simplify(tree_of(texts, t)) {
        Node::Leaf(s) => Some(s),
        Node::Split { .. } => None,
    }
}

fn text_of(n: Node) -> String {
    match paint_tree::simplify(n) {
        Node::Leaf(0) => String::new(),
        n => paint_tree::encode(&n),
    }
}

fn region_of(m: &TriMesh, tris: Vec<u32>, area: impl Fn(u32) -> f64) -> Region {
    let mut b = None;
    let mut total = 0.0;
    for &t in &tris {
        total += area(t);
        for p in corners(m, t).into_iter().flatten() {
            grow(&mut b, p);
        }
    }
    Region {
        triangles: tris,
        area_mm2: total,
        bounds: b.unwrap_or(Aabb {
            min: [0.0; 3],
            max: [0.0; 3],
        }),
    }
}

fn by_size(mut r: Vec<Region>) -> Vec<Region> {
    r.sort_by(|a, b| {
        b.area_mm2
            .total_cmp(&a.area_mm2)
            .then(a.triangles.first().cmp(&b.triangles.first()))
    });
    r
}
/// The unit normal of triangle `t`, none for a triangle that is missing.
fn normal_of(m: &TriMesh, t: u32) -> Option<V3> {
    m.triangles.get(t as usize).map(|&tri| m.normal(tri))
}

/// The whole triangles a part, direction or seed target picks, and the regions they make.
fn pick_whole(
    m: &TriMesh,
    texts: &BTreeMap<u32, String>,
    target: &Target,
    count: u32,
) -> Result<(BTreeSet<u32>, Vec<Region>)> {
    let whole_area = |t: u32| corners(m, t).map_or(0.0, |v| tri_area(&v));
    let adj = Adjacency::of(m);
    let grouped = |set: &BTreeSet<u32>| {
        by_size(
            adj.groups(set)
                .into_iter()
                .map(|g| region_of(m, g, whole_area))
                .collect(),
        )
    };
    match target {
        Target::Direction { dir, angle_deg, pick } => {
            let d = vec3::normalize(*dir).ok_or_else(|| Error::invalid("direction", "needs a length"))?;
            let cos = angle_deg.clamp(0.0, 180.0).to_radians().m_cos();
            let set: BTreeSet<u32> = (0..count)
                .filter(|&t| normal_of(m, t).is_some_and(|n| vec3::dot(n, d) >= cos - 1e-12))
                .collect();
            let regions = grouped(&set);
            let chosen: Vec<Region> = match pick {
                Pick::All => regions,
                Pick::Largest => regions.into_iter().take(1).collect(),
                Pick::Nearest(p) => {
                    let dist = |r: &Region| {
                        r.triangles
                            .iter()
                            .filter_map(|&t| corners(m, t))
                            .map(|v| vec3::len(vec3::sub(closest_on_triangle(*p, &v), *p)))
                            .fold(f64::INFINITY, f64::min)
                    };
                    regions
                        .into_iter()
                        .map(|r| (dist(&r), r))
                        .min_by(|a, b| a.0.total_cmp(&b.0))
                        .map(|(_, r)| r)
                        .into_iter()
                        .collect()
                }
            };
            Ok((
                chosen.iter().flat_map(|r| r.triangles.iter().copied()).collect(),
                chosen,
            ))
        }
        Target::Seed {
            point,
            angle_deg,
            bucket,
        } => {
            let seed = nearest_triangle(m, *point)
                .ok_or_else(|| Error::invalid("seed", "the mesh has no triangles"))?;
            let cos = angle_deg.clamp(0.0, 180.0).to_radians().m_cos();
            let want = uniform(texts, seed);
            let mut set = BTreeSet::from([seed]);
            let mut queue = VecDeque::from([seed]);
            while let Some(t) = queue.pop_front() {
                let n_t = normal_of(m, t).unwrap_or([0.0; 3]);
                for &n in adj.near.get(t as usize).into_iter().flatten() {
                    if set.contains(&n) {
                        continue;
                    }
                    let ok = if *bucket {
                        want.is_some() && uniform(texts, n) == want
                    } else {
                        normal_of(m, n).is_some_and(|nn| vec3::dot(nn, n_t) >= cos - 1e-12)
                    };
                    if ok {
                        set.insert(n);
                        queue.push_back(n);
                    }
                }
            }
            let regions = grouped(&set);
            Ok((set, regions))
        }
        _ => {
            let set: BTreeSet<u32> = (0..count).collect();
            let regions = grouped(&set);
            Ok((set, regions))
        }
    }
}

/// A height band: each triangle it reaches painted `state` where the band covers it, split at the band's edges.
fn select_height(
    m: &TriMesh,
    texts: &BTreeMap<u32, String>,
    lo: f64,
    hi: f64,
    state: u8,
    max_depth: u32,
    count: u32,
) -> Selection {
    let (lo, hi) = (lo.min(hi), lo.max(hi));
    let band = move |v: &[V3; 3]| {
        let (zl, zh) = (
            v.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min),
            v.iter().map(|p| p[2]).fold(f64::NEG_INFINITY, f64::max),
        );
        if zl >= lo && zh <= hi {
            Cover::All
        } else if zh < lo || zl > hi {
            Cover::None
        } else {
            Cover::Part
        }
    };
    let mut changed = BTreeMap::new();
    let mut touched = BTreeSet::new();
    let mut area = 0.0;
    for t in 0..count {
        let Some(v) = corners(m, t) else { continue };
        if band(&v) == Cover::None {
            continue;
        }
        let before = tree_of(texts, t);
        let text = text_of(paint_tree::paint_region(&before, v, &band, state, 0, max_depth));
        // The area the band covers on this triangle, as painted.
        let probe = paint_tree::paint_region(&Node::Leaf(0), v, &band, 1, 0, max_depth);
        area += paint_tree::leaves(&paint_tree::encode(&probe), v)
            .unwrap_or_default()
            .iter()
            .filter(|(_, s)| *s == 1)
            .map(|(lv, _)| tri_area(lv))
            .sum::<f64>();
        touched.insert(t);
        if text != texts.get(&t).cloned().unwrap_or_default() {
            changed.insert(t, text);
        }
    }
    let whole_area = |t: u32| corners(m, t).map_or(0.0, |v| tri_area(&v));
    let adj = Adjacency::of(m);
    let regions = by_size(
        adj.groups(&touched)
            .into_iter()
            .map(|g| region_of(m, g, whole_area))
            .collect(),
    );
    Selection {
        changed,
        regions,
        area_mm2: area,
    }
}

/// Every piece of state `from` set to `to`.
fn select_replace(m: &TriMesh, texts: &BTreeMap<u32, String>, from: u8, to: u8) -> Selection {
    let mut changed = BTreeMap::new();
    let mut set = BTreeSet::new();
    let mut area = 0.0;
    for (&t, text) in texts {
        let (Some(tree), Some(v)) = (paint_tree::parse(text), corners(m, t)) else {
            continue;
        };
        let had: f64 = paint_tree::leaves(text, v)
            .unwrap_or_default()
            .iter()
            .filter(|(_, s)| *s == from)
            .map(|(lv, _)| tri_area(lv))
            .sum();
        if had <= 0.0 {
            continue;
        }
        area += had;
        set.insert(t);
        let next = text_of(paint_tree::replace(&tree, from, to));
        if next != *text {
            changed.insert(t, next);
        }
    }
    let whole_area = |t: u32| corners(m, t).map_or(0.0, |v| tri_area(&v));
    let adj = Adjacency::of(m);
    let regions = by_size(
        adj.groups(&set)
            .into_iter()
            .map(|g| region_of(m, g, whole_area))
            .collect(),
    );
    Selection {
        changed,
        regions,
        area_mm2: area,
    }
}

/// What `target` paints `state` (0 clears) on mesh `m`, whose layer holds `texts`: the new texts of the triangles it
/// changes, and the regions it picked. Height bands split triangles down to `max_depth` levels.
pub fn select(
    m: &TriMesh,
    texts: &BTreeMap<u32, String>,
    target: &Target,
    state: u8,
    max_depth: u32,
) -> Result<Selection> {
    let count = u32::try_from(m.triangles.len()).map_err(|_| Error::invalid("mesh", "too many triangles"))?;
    match target {
        Target::Height { lo, hi } => return Ok(select_height(m, texts, *lo, *hi, state, max_depth, count)),
        Target::Replace { from } => return Ok(select_replace(m, texts, *from, state)),
        Target::Part | Target::Direction { .. } | Target::Seed { .. } => {}
    }
    let (picked, regions) = pick_whole(m, texts, target, count)?;
    let new_text = text_of(Node::Leaf(state));
    let changed = picked
        .iter()
        .filter(|t| texts.get(t).cloned().unwrap_or_default() != new_text)
        .map(|&t| (t, new_text.clone()))
        .collect();
    let area_mm2 = regions.iter().map(|r| r.area_mm2).sum();
    Ok(Selection {
        changed,
        regions,
        area_mm2,
    })
}

/// The layer's paint read back: per painted state, its area, the triangles holding it and its connected regions.
/// Texts that do not read are counted as `bad`.
pub fn regions(m: &TriMesh, texts: &BTreeMap<u32, String>) -> (Vec<StateRegions>, usize) {
    let mut area: BTreeMap<u8, BTreeMap<u32, f64>> = BTreeMap::new();
    let mut bad = 0;
    for (&t, text) in texts {
        let Some(v) = corners(m, t) else {
            bad += 1;
            continue;
        };
        let Some(leaves) = paint_tree::leaves(text, v) else {
            bad += 1;
            continue;
        };
        for (lv, s) in leaves {
            if s > 0 {
                *area.entry(s).or_default().entry(t).or_default() += tri_area(&lv);
            }
        }
    }
    let adj = Adjacency::of(m);
    let out = area
        .into_iter()
        .map(|(state, by_tri)| {
            let set: BTreeSet<u32> = by_tri.keys().copied().collect();
            let regions = by_size(
                adj.groups(&set)
                    .into_iter()
                    .map(|g| region_of(m, g, |t| by_tri.get(&t).copied().unwrap_or(0.0)))
                    .collect(),
            );
            StateRegions {
                state,
                area_mm2: by_tri.values().sum(),
                triangles: set.len(),
                regions,
            }
        })
        .collect();
    (out, bad)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 20 mm cube with welded corners: triangles 0 and 1 the bottom, 2 and 3 the top, then the sides.
    fn cube() -> TriMesh {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [20.0, 20.0, 0.0],
            [0.0, 20.0, 0.0],
            [0.0, 0.0, 20.0],
            [20.0, 0.0, 20.0],
            [20.0, 20.0, 20.0],
            [0.0, 20.0, 20.0],
        ];
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        TriMesh::new(positions, triangles)
    }

    fn none() -> BTreeMap<u32, String> {
        BTreeMap::new()
    }

    #[test]
    fn the_bottom_by_direction_and_a_read_back_of_it() {
        let m = cube();
        let dir = Target::named_direction("bottom").unwrap();
        let sel = select(
            &m,
            &none(),
            &Target::Direction {
                dir,
                angle_deg: 30.0,
                pick: Pick::All,
            },
            2,
            DEFAULT_DEPTH,
        )
        .unwrap();
        assert_eq!(
            sel.changed,
            BTreeMap::from([(0, "8".to_owned()), (1, "8".to_owned())])
        );
        assert_eq!(sel.regions.len(), 1);
        assert!((sel.area_mm2 - 400.0).abs() < 1e-9);
        let (back, bad) = regions(&m, &sel.changed);
        assert_eq!(bad, 0);
        assert_eq!(back.len(), 1);
        assert_eq!(
            (back[0].state, back[0].triangles, back[0].regions.len()),
            (2, 2, 1)
        );
        assert!((back[0].area_mm2 - 400.0).abs() < 1e-9);
        assert!((back[0].regions[0].bounds.max[2]).abs() < 1e-9);
    }

    #[test]
    fn sides_by_direction_make_one_region_each_and_a_pick_takes_one() {
        let m = cube();
        // Every side face (normals level): four regions of 400 mm2.
        let level = Target::Direction {
            dir: [1.0, 0.0, 0.0],
            angle_deg: 90.0,
            pick: Pick::All,
        };
        let sel = select(&m, &none(), &level, 3, DEFAULT_DEPTH).unwrap();
        // Within 90 degrees of +x: the +x side, and the four faces at 90 degrees (top, bottom, front, back).
        assert_eq!(
            sel.regions.len(),
            1,
            "they all share edges: {:?}",
            sel.regions.len()
        );
        let near = Target::Direction {
            dir: [1.0, 0.0, 0.0],
            angle_deg: 10.0,
            pick: Pick::Nearest([25.0, 10.0, 10.0]),
        };
        let sel = select(&m, &none(), &near, 3, DEFAULT_DEPTH).unwrap();
        assert_eq!(sel.changed.keys().copied().collect::<Vec<_>>(), vec![6, 7]);
    }

    #[test]
    fn a_height_band_splits_the_sides_exactly() {
        let m = cube();
        let sel = select(
            &m,
            &none(),
            &Target::Height { lo: -1.0, hi: 5.0 },
            2,
            DEFAULT_DEPTH,
        )
        .unwrap();
        // The bottom whole, and the band 5 mm up each of the four sides: 400 + 4 * 100 = 800 mm2. Six levels of
        // splitting put the band edge on a 20 mm side within 20/64 mm, so the painted area comes close.
        assert!((sel.area_mm2 - 800.0).abs() < 40.0, "{}", sel.area_mm2);
        let (back, _) = regions(&m, &sel.changed);
        let painted = back.iter().find(|r| r.state == 2).unwrap();
        // What reads back is what the selection said it paints.
        assert!(
            (painted.area_mm2 - sel.area_mm2).abs() < 1e-6,
            "{} {}",
            painted.area_mm2,
            sel.area_mm2
        );
        assert_eq!(painted.regions.len(), 1);
        // Every piece painted lies below the band's top, give or take one level's size.
        for (&t, text) in &sel.changed {
            let v = corners(&m, t).unwrap();
            for (lv, s) in paint_tree::leaves(text, v).unwrap() {
                if s == 2 {
                    assert!(lv.iter().all(|p| p[2] <= 5.0 + 20.0 / 32.0), "{t} {lv:?}");
                }
            }
        }
    }

    #[test]
    fn a_seed_grows_over_flat_faces_and_a_bucket_over_one_state() {
        let m = cube();
        // From a point on the top: smart fill stops at the 90 degree edges.
        let sel = select(
            &m,
            &none(),
            &Target::Seed {
                point: [5.0, 5.0, 21.0],
                angle_deg: 30.0,
                bucket: false,
            },
            2,
            DEFAULT_DEPTH,
        )
        .unwrap();
        assert_eq!(sel.changed.keys().copied().collect::<Vec<_>>(), vec![2, 3]);
        // With the top painted 2, a bucket from the bottom fills every triangle still unpainted.
        let painted = sel.changed;
        let b = select(
            &m,
            &painted,
            &Target::Seed {
                point: [5.0, 5.0, -1.0],
                angle_deg: 0.0,
                bucket: true,
            },
            3,
            DEFAULT_DEPTH,
        )
        .unwrap();
        assert_eq!(b.changed.len(), 10);
        assert!(!b.changed.contains_key(&2) && !b.changed.contains_key(&3));
    }

    #[test]
    fn replace_clear_and_bad_texts() {
        let m = cube();
        let texts = BTreeMap::from([(2, "8".to_owned()), (3, "8".to_owned()), (4, "4".to_owned())]);
        let r = select(&m, &texts, &Target::Replace { from: 2 }, 3, DEFAULT_DEPTH).unwrap();
        assert_eq!(
            r.changed,
            BTreeMap::from([(2, "0C".to_owned()), (3, "0C".to_owned())])
        );
        assert!((r.area_mm2 - 400.0).abs() < 1e-9);
        // Clearing the part leaves empty texts where there was paint, and nothing where there was none.
        let c = select(&m, &texts, &Target::Part, 0, DEFAULT_DEPTH).unwrap();
        assert_eq!(c.changed.len(), 3);
        assert!(c.changed.values().all(String::is_empty));
        let (_, bad) = regions(&m, &BTreeMap::from([(0, "zz".to_owned()), (99, "8".to_owned())]));
        assert_eq!(bad, 2);
    }
}
