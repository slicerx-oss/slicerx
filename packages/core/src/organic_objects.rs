// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Organic tree support planned object by object (`organic_per_object`, off by default).
//!
//! On a plate sliced as one session, organic trees are otherwise planned for the whole plate at once, so a branch
//! under one object can merge with a branch under its neighbor, and two copies of one part get different trees.
//! With the switch on:
//!
//! - each object is planned on its own: its branches see only that object's own layers and the bed border, and
//!   merge only with branches of the same object;
//! - objects that are the same after placement (the same mesh, paint, settings and turn, only moved across the bed:
//!   [`copies`]) are planned once, and every other copy gets that support moved by the distance between them;
//! - each object's support paths are made in its own frame (patterns anchored on the middle of its own box) and
//!   moved with it, so every copy prints the same paths on every layer;
//! - once every object's support is moved to where it stands, the support that would reach into another object is
//!   cut back to `support_object_xy_distance` from that object's outline, layer by layer, so a copy with a neighbor
//!   in reach can print less support than the other copies.
//!
//! The plan of one object is the same plan a plate of that object alone gets.

use crate::geom::Point;
use crate::organic::OrganicLayer;
use crate::perimeters::{self, Shapes};
use crate::plate::PlateObject;
use crate::support::SupportLayer;
use i_overlay::i_float::int::point::IntPoint;
use std::sync::Arc;

/// The setting that turns per-object planning on.
pub(crate) const KEY: &str = "organic_per_object";

/// How far a vertex, paint corner or volume of a copy may lie from where the first object's moved there would be,
/// mm. Parts are placed in single precision; a micron is well past that rounding and well under anything a slice
/// resolves (the same bound the copies of a plate printed by layer use).
const ROUNDING_MM: f64 = 1e-3;

/// With the switch on and the tree wall count left automatic (0), a hollow branch whose cut, shrunk by half a line,
/// is larger than this prints a second wall, mm2; smaller ones print one. Measured on plates of eight copies at
/// 0.12 mm layers with 2 mm branches: trunk cuts 6.3 to 7.2 mm across print one wall, 7.7 mm and wider print two,
/// which puts the line near a 6.9 mm circle. With the switch off the line stays at a 5 mm circle.
pub(crate) const DOUBLE_WALL_MM2: f64 = 37.0;

/// The area above which a hollow branch prints a second wall, mm2, for a tree wall count of 0 (automatic).
pub(crate) fn auto_double_wall_mm2(cfg: &crate::config::PrintConfig) -> f64 {
    if selected(cfg) {
        DOUBLE_WALL_MM2
    } else {
        0.25 * std::f64::consts::PI * 25.0
    }
}

/// With the switch on, the anchor a hollow branch loop starts with runs up to this many line spacings along the
/// wall inside it, so the loop's ends sit about 1.2 mm apart. Measured on the same plates, layers 80 to 200: each
/// branch loop's last move ends 1.09 to 1.43 mm from where it started (median 1.22 to 1.26 mm), and no move runs on
/// past a closed loop. With the switch off the anchor runs up to 6 spacings, about 2 mm.
pub(crate) const WALL_ANCHOR_SPACINGS: f64 = 3.0;

/// How many line spacings the anchor of a hollow branch loop runs inside it.
pub(crate) fn wall_anchor_spacings(cfg: &crate::config::PrintConfig) -> f64 {
    if selected(cfg) { WALL_ANCHOR_SPACINGS } else { 6.0 }
}

/// True when the settings ask for organic trees planned object by object.
pub(crate) fn selected(cfg: &crate::config::PrintConfig) -> bool {
    crate::firmware::truthy(cfg, KEY)
}

/// One object's organic support on a support layer: its areas in the frame they were planned in, where the object
/// stands from there, and the planned object's box, whose middle its support lines are anchored on.
#[derive(Debug, Clone)]
pub(crate) struct Piece {
    /// The object's index on the plate.
    pub(crate) object: u16,
    /// The areas, as planned (for a copy: as planned for the object it copies).
    pub(crate) layer: Arc<OrganicLayer>,
    /// How far the object stands from where its support was planned, internal units.
    pub(crate) shift: [i32; 2],
    /// The planned object's box, mm, in the planned frame: its support lines are anchored on its middle.
    pub(crate) bounds: [f64; 4],
}

/// One object's plan, as [`assemble`] reads it.
pub(crate) struct Planned<'a> {
    pub(crate) object: u16,
    pub(crate) plan: &'a crate::organic::OrganicPlan,
    pub(crate) shift: [i32; 2],
    pub(crate) bounds: [f64; 4],
}

/// Per plate object, the object whose support it reuses (itself for the first of its kind) and how far it stands
/// from that one, internal units: the objects that are the same after placement share one plan.
pub(crate) fn copies(objects: &[PlateObject]) -> Vec<(usize, [i32; 2])> {
    let mut out: Vec<(usize, [i32; 2])> = Vec::with_capacity(objects.len());
    for (i, o) in objects.iter().enumerate() {
        let of = (0..i).find_map(|k| {
            let first = objects.get(k)?;
            if out.get(k).is_none_or(|c| c.0 != k) {
                return None;
            }
            same_after_placement(first, o).map(|d| (k, d.map(crate::support::units)))
        });
        out.push(of.unwrap_or((i, [0, 0])));
    }
    out
}

/// How far `b` stands from `a` across the bed, mm, when it is `a` moved there with nothing else changed: the same
/// turn and scale, filaments and settings by height, parts of the same triangles whose every point (and every painted
/// corner, volume and brim ear) stands at the same move from `a`'s, and the same settings, part settings and
/// volumes. Two build items of one object and two objects of one mesh both count.
fn same_after_placement(a: &PlateObject, b: &PlateObject) -> Option<[f64; 2]> {
    let (ta, tb) = (&a.transform, &b.transform);
    let (ma, mb) = (&a.mesh, &b.mesh);
    if ta.get(..12) != tb.get(..12)
        || ta.get(14..) != tb.get(14..)
        || a.slot_overrides != b.slot_overrides
        || a.settings != b.settings
        || a.part_settings != b.part_settings
        || a.brim_points != b.brim_points
        || ma.settings != mb.settings
        || ma.part_settings != mb.part_settings
        || ma.height_ranges != mb.height_ranges
        || ma.layer_heights != mb.layer_heights
        || ma.parts.len() != mb.parts.len()
    {
        return None;
    }
    // The move, from the first point of the parts on the plate: across the bed only.
    let first = |o: &PlateObject| {
        let p = o.mesh.parts.iter().find_map(|p| p.positions.first().copied())?;
        Some(o.apply(p))
    };
    let (pa, pb) = (first(a)?, first(b)?);
    let off = [pb[0] - pa[0], pb[1] - pa[1]];
    if (pb[2] - pa[2]).abs() > ROUNDING_MM {
        return None;
    }
    let at = |p: [f64; 3], q: [f64; 3]| {
        (q[0] - p[0] - off[0]).abs() <= ROUNDING_MM
            && (q[1] - p[1] - off[1]).abs() <= ROUNDING_MM
            && (q[2] - p[2]).abs() <= ROUNDING_MM
    };
    let near = |p: &[f32; 3], q: &[f32; 3]| at(a.apply(*p), b.apply(*q));
    let points =
        |u: &[[f32; 3]], v: &[[f32; 3]]| u.len() == v.len() && u.iter().zip(v).all(|(p, q)| near(p, q));
    let facets = |u: &[crate::paint::PaintFacet], v: &[crate::paint::PaintFacet]| {
        u.len() == v.len()
            && u.iter()
                .zip(v)
                .all(|(f, g)| f.state == g.state && f.v.iter().zip(&g.v).all(|(p, q)| near(p, q)))
    };
    let parts = ma.parts.iter().zip(&mb.parts).all(|(p, q)| {
        p.name == q.name
            && p.slot == q.slot
            && p.triangles == q.triangles
            && points(&p.positions, &q.positions)
            && facets(&p.paint, &q.paint)
            && facets(&p.support_paint, &q.support_paint)
            && facets(&p.seam_paint, &q.seam_paint)
            && facets(&p.fuzzy_paint, &q.fuzzy_paint)
    });
    let volumes = ma.volumes.len() == mb.volumes.len()
        && ma.volumes.iter().zip(&mb.volumes).all(|(u, v)| {
            u.role == v.role
                && u.settings == v.settings
                && u.part.triangles == v.part.triangles
                && points(&u.part.positions, &v.part.positions)
        });
    let ears = ma.brim_points.len() == mb.brim_points.len()
        && ma.brim_points.iter().zip(&mb.brim_points).all(|(p, q)| {
            near(&[p[0], p[1], p[2]], &[q[0], q[1], q[2]])
                && (f64::from(p[3]) - f64::from(q[3])).abs() <= ROUNDING_MM
        });
    // The plate's own volumes, each under its own transform when it has one, else the object's.
    let plate_volumes = a.volumes.len() == b.volumes.len()
        && a.volumes.iter().zip(&b.volumes).all(|(u, v)| {
            let (su, sv) = (u.transform.unwrap_or(*ta), v.transform.unwrap_or(*tb));
            u.name == v.name
                && u.role == v.role
                && u.settings == v.settings
                && su.get(..12) == sv.get(..12)
                && u.mesh.parts.len() == v.mesh.parts.len()
                && u.mesh.parts.iter().zip(&v.mesh.parts).all(|(p, q)| {
                    p.triangles == q.triangles
                        && p.positions.len() == q.positions.len()
                        && p.positions.iter().zip(&q.positions).all(|(x, y)| {
                            at(PlateObject::apply_with(&su, *x), PlateObject::apply_with(&sv, *y))
                        })
                })
        });
    (parts && volumes && ears && plate_volumes).then_some(off)
}

/// The islands of every layer of `layers`, each given to the object whose footprint holds it (`brim::owner`): per
/// object of `hulls`, its own layers.
pub(crate) fn split(layers: &[Shapes], hulls: &[&[[f64; 2]]]) -> Vec<Vec<Shapes>> {
    let mut out: Vec<Vec<Shapes>> = vec![vec![Shapes::new(); layers.len()]; hulls.len()];
    for (l, layer) in layers.iter().enumerate() {
        for island in layer {
            let k = crate::brim::owner(island, hulls);
            if let Some(slot) = out.get_mut(k).and_then(|o| o.get_mut(l)) {
                slot.push(island.clone());
            }
        }
    }
    out
}

/// The object of `hulls` whose footprint holds the point `p` (mm), as [`split`] gives islands.
pub(crate) fn owner_of(p: [f64; 2], hulls: &[&[[f64; 2]]]) -> usize {
    let at = IntPoint::new(crate::support::units(p[0]), crate::support::units(p[1]));
    crate::brim::owner(&[vec![at]], hulls)
}

/// `s` moved by `d`, internal units.
pub(crate) fn moved(s: &Shapes, d: [i32; 2]) -> Shapes {
    if d == [0, 0] {
        return s.clone();
    }
    s.iter()
        .map(|shape| {
            shape
                .iter()
                .map(|ring| {
                    ring.iter()
                        .map(|p| IntPoint::new(p.x + d[0], p.y + d[1]))
                        .collect()
                })
                .collect()
        })
        .collect()
}

/// Paths moved by `d`, internal units.
pub(crate) fn move_paths(paths: &mut [Vec<Point>], d: [i32; 2]) {
    if d == [0, 0] {
        return;
    }
    for p in paths.iter_mut().flatten() {
        p.x += d[0];
        p.y += d[1];
    }
}

fn union(parts: &[Shapes]) -> Shapes {
    match parts {
        [] => Shapes::new(),
        [one] => one.clone(),
        _ => perimeters::union_all(&parts.iter().collect::<Vec<_>>()),
    }
}

/// The bed `bed` (`[min x, min y, max x, max y]`, internal units) moved by `-d`: where the bed is in the frame a
/// copy's support was planned in.
fn bed_in_frame(bed: [i32; 4], d: [i32; 2]) -> Shapes {
    let [x0, y0, x1, y1] = [bed[0] - d[0], bed[1] - d[1], bed[2] - d[0], bed[3] - d[1]];
    vec![vec![vec![
        IntPoint::new(x0, y0),
        IntPoint::new(x1, y0),
        IntPoint::new(x1, y1),
        IntPoint::new(x0, y1),
    ]]]
}

/// Whether `parts` moved by `d` reach past the bed `bed` (internal units).
fn past_bed(parts: &[&Shapes], d: [i32; 2], bed: [i32; 4]) -> bool {
    parts
        .iter()
        .filter_map(|s| perimeters::bounds(s))
        .any(|b| b[0] + d[0] < bed[0] || b[1] + d[1] < bed[1] || b[2] + d[0] > bed[2] || b[3] + d[1] > bed[3])
}

/// `s` cut to `keep`.
fn cut(s: &Shapes, keep: &Shapes) -> Shapes {
    perimeters::intersection(s, keep)
}

/// Every object's outline on each object layer, plate frame (`outlines[object][layer]`), and how far another
/// object's support keeps from it (`support_object_xy_distance`, mm).
pub(crate) struct Outlines<'a> {
    pub(crate) layers: &'a [Vec<Shapes>],
    pub(crate) gap: f64,
}

/// What an object's support keeps out of on each layer: the other objects' outlines grown by the gap. Each
/// object's grown outline is made once per layer, and only when some support reaches it.
struct Neighbors<'a> {
    outlines: &'a [Vec<Shapes>],
    gap: i32,
    /// Per object, per layer, the box of its outline.
    boxes: Vec<Vec<Option<[i32; 4]>>>,
    /// The layer `grown` holds, and per object its outline on it grown by the gap, once made.
    layer: usize,
    grown: Vec<Option<Shapes>>,
}

impl<'a> Neighbors<'a> {
    fn new(o: &Outlines<'a>) -> Self {
        Self {
            outlines: o.layers,
            gap: crate::support::units(o.gap).max(0),
            boxes: o
                .layers
                .iter()
                .map(|layers| layers.iter().map(|s| perimeters::bounds(s)).collect())
                .collect(),
            layer: usize::MAX,
            grown: Vec::new(),
        }
    }

    /// On layer `l`, the area of the other objects that `p`'s support (its printed areas `printed`, planned frame)
    /// reaches into, grown by the gap and in `p`'s planned frame; None when its support reaches none of them.
    fn keep_out(&mut self, l: usize, p: &Planned<'_>, printed: &[&Shapes]) -> Option<Shapes> {
        let d = p.shift;
        let reach = printed
            .iter()
            .filter_map(|s| perimeters::bounds(s))
            .reduce(|a, b| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])])
            .map(|b| [b[0] + d[0], b[1] + d[1], b[2] + d[0], b[3] + d[1]])?;
        let g = self.gap.saturating_add(1);
        let near: Vec<usize> = self
            .boxes
            .iter()
            .enumerate()
            .filter(|&(k, layers)| {
                k != usize::from(p.object)
                    && layers.get(l).copied().flatten().is_some_and(|b| {
                        reach[0] <= b[2] + g
                            && b[0] - g <= reach[2]
                            && reach[1] <= b[3] + g
                            && b[1] - g <= reach[3]
                    })
            })
            .map(|(k, _)| k)
            .collect();
        if near.is_empty() {
            return None;
        }
        if self.layer != l {
            self.layer = l;
            self.grown = vec![None; self.outlines.len()];
        }
        let mut parts: Vec<Shapes> = Vec::with_capacity(near.len());
        for k in near {
            let (Some(slot), Some(outline)) =
                (self.grown.get_mut(k), self.outlines.get(k).and_then(|o| o.get(l)))
            else {
                continue;
            };
            parts.push(
                slot.get_or_insert_with(|| perimeters::offset_round(outline, self.gap))
                    .clone(),
            );
        }
        let all = union(&parts);
        (!all.is_empty()).then(|| moved(&all, [-d[0], -d[1]]))
    }
}

/// The plate's organic plan from each object's own: on every layer, each object's areas moved to where it stands
/// and put together (each object's areas kept apart as [`Piece`]s for its paths), and the branches through each raft
/// layer likewise. `layers` is the number of support layers every plan has.
///
/// A copy's support was planned where the object it copies stands, against the bed border there. Where the copy's
/// support, moved to it, would reach past the bed (`bed`, mm), it is cut to the bed on its own, in its planned
/// frame, so its paths stay on the plate.
///
/// Each object was planned without the others, so its support can reach into a neighbor. On every layer, where an
/// object's support, moved to where the object stands, comes within the gap of another object's outline on that
/// layer (`outlines`), it is cut back to the gap, in its planned frame. A copy is cut by its own neighbors, so
/// copies with a neighbor in reach can differ from the others; a copy with none keeps the shared areas.
pub(crate) fn assemble(
    layers: usize,
    plans: &[Planned<'_>],
    bed: [f64; 4],
    outlines: &Outlines<'_>,
) -> crate::organic::OrganicPlan {
    let bed = bed.map(crate::support::units);
    let mut near = Neighbors::new(outlines);
    let mut out = crate::organic::OrganicPlan {
        layers: Vec::with_capacity(layers),
        raft: Vec::new(),
    };
    for l in 0..layers {
        let mut pieces: Vec<Piece> = Vec::new();
        // The layer's areas by kind, each object's moved to where it stands: base, interface, contact, hang, bottom.
        let mut kinds: [Vec<Shapes>; 5] = Default::default();
        for p in plans {
            let Some(sl) = p.plan.layers.get(l) else { continue };
            let Some(planned) = sl.organic.as_ref() else {
                continue;
            };
            let fields = [&sl.base, &sl.interface, &sl.contact, &sl.hang, &sl.bottom];
            let printed = [
                &planned.top_contact,
                &planned.interface,
                &planned.base_interface,
                &planned.base,
                &planned.bottom_contact,
            ];
            let keep =
                (p.shift != [0, 0] && past_bed(&printed, p.shift, bed)).then(|| bed_in_frame(bed, p.shift));
            let keep_out = near.keep_out(l, p, &printed);
            let (layer, own): (Arc<OrganicLayer>, [Shapes; 5]) = if keep.is_some() || keep_out.is_some() {
                let clip = |s: &Shapes| {
                    let s = keep
                        .as_ref()
                        .map_or_else(|| s.clone(), |k| perimeters::intersection(s, k));
                    match &keep_out {
                        Some(k) => perimeters::difference(&s, k),
                        None => s,
                    }
                };
                let o = planned.as_ref();
                let clipped = OrganicLayer {
                    top_contact: clip(&o.top_contact),
                    interface: clip(&o.interface),
                    interface_bottom: o.interface_bottom,
                    base_interface: clip(&o.base_interface),
                    base: clip(&o.base),
                    bottom_contact: clip(&o.bottom_contact),
                    interface_id: o.interface_id,
                    hang: clip(&o.hang),
                };
                (Arc::new(clipped), fields.map(clip))
            } else {
                (Arc::clone(planned), fields.map(Clone::clone))
            };
            for (dst, s) in kinds.iter_mut().zip(own) {
                if !s.is_empty() {
                    dst.push(moved(&s, p.shift));
                }
            }
            pieces.push(Piece {
                object: p.object,
                layer,
                shift: p.shift,
                bounds: p.bounds,
            });
        }
        if pieces.is_empty() {
            out.layers.push(SupportLayer::default());
            continue;
        }
        let kind = |f: &dyn Fn(&OrganicLayer) -> &Shapes| -> Shapes {
            let parts: Vec<Shapes> = pieces
                .iter()
                .filter_map(|p| {
                    let s = f(&p.layer);
                    (!s.is_empty()).then(|| moved(s, p.shift))
                })
                .collect();
            union(&parts)
        };
        let first = pieces.first().map(|p| Arc::clone(&p.layer));
        let whole = OrganicLayer {
            top_contact: kind(&|o| &o.top_contact),
            interface: kind(&|o| &o.interface),
            interface_bottom: first.as_ref().is_some_and(|o| o.interface_bottom),
            base_interface: kind(&|o| &o.base_interface),
            base: kind(&|o| &o.base),
            bottom_contact: kind(&|o| &o.bottom_contact),
            interface_id: first.as_ref().map_or(0, |o| o.interface_id),
            hang: kind(&|o| &o.hang),
        };
        let [base, interface, contact, hang, bottom] = kinds.map(|parts| union(&parts));
        out.layers.push(SupportLayer {
            base,
            interface,
            contact,
            hang,
            bottom,
            organic: Some(Arc::new(whole)),
            objects: pieces,
            ..SupportLayer::default()
        });
    }
    let raft_layers = plans.iter().map(|p| p.plan.raft.len()).max().unwrap_or(0);
    out.raft = (0..raft_layers)
        .map(|r| {
            let parts: Vec<Shapes> = plans
                .iter()
                .filter_map(|p| {
                    let s = p.plan.raft.get(r).filter(|s| !s.is_empty())?;
                    let s = if p.shift != [0, 0] && past_bed(&[s], p.shift, bed) {
                        cut(s, &bed_in_frame(bed, p.shift))
                    } else {
                        s.clone()
                    };
                    (!s.is_empty()).then(|| moved(&s, p.shift))
                })
                .collect();
            union(&parts)
        })
        .collect();
    out
}

/// Per island of `islands` (a layer's organic support, all objects together), the plate object whose planned
/// support it is: the one of `pieces` whose areas, moved to where it stands, meet the island, or
/// `preview::OBJECT_NONE` when none or several do. Empty without pieces.
pub(crate) fn island_owners(islands: &Shapes, pieces: &[Piece]) -> Vec<u16> {
    if pieces.is_empty() {
        return Vec::new();
    }
    let own: Vec<(u16, Shapes, Option<[i32; 4]>)> = pieces
        .iter()
        .map(|p| {
            let o = &p.layer;
            let all = perimeters::union_all(&[
                &o.top_contact,
                &o.interface,
                &o.base_interface,
                &o.base,
                &o.bottom_contact,
            ]);
            let at = moved(&all, p.shift);
            let b = perimeters::bounds(&at);
            (p.object, at, b)
        })
        .collect();
    let meet = |a: [i32; 4], b: [i32; 4]| a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    islands
        .iter()
        .map(|island| {
            let Some(b) = perimeters::bounds(std::slice::from_ref(island)) else {
                return crate::preview::OBJECT_NONE;
            };
            let near: Vec<&(u16, Shapes, Option<[i32; 4]>)> = own
                .iter()
                .filter(|(_, _, ob)| ob.is_some_and(|ob| meet(b, ob)))
                .collect();
            let hit: Vec<u16> = if let [one] = near.as_slice() {
                vec![one.0]
            } else {
                let shape = vec![island.clone()];
                near.iter()
                    .filter(|(_, s, _)| !perimeters::intersection(&shape, s).is_empty())
                    .map(|(o, ..)| *o)
                    .collect()
            };
            match hit.as_slice() {
                [one] => *one,
                _ => crate::preview::OBJECT_NONE,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fm::Fm as _;

    /// A circle of diameter `d` mm, 128 corners, in plate units.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "points of a circle a few mm across, well inside i32 plate units"
    )]
    fn circle(d: f64) -> Shapes {
        let s = crate::geom::SCALE;
        let ring: Vec<IntPoint<i32>> = (0..128)
            .map(|k| {
                let a = std::f64::consts::TAU * f64::from(k) / 128.0;
                IntPoint::new(
                    (100.0 * s + 0.5 * d * s * a.m_cos()) as i32,
                    (100.0 * s + 0.5 * d * s * a.m_sin()) as i32,
                )
            })
            .collect();
        vec![vec![ring]]
    }

    /// Closed loops a branch prints: paths that end near where they start, less the anchor tail.
    fn walls(d: f64, double_mm2: f64) -> usize {
        crate::treepaths::branch_walls(&circle(d), 0.42, 0.42, double_mm2).len()
    }

    #[test]
    fn a_trunk_up_to_about_seven_mm_prints_one_wall_with_the_switch_on() {
        // 6.3 to 7.2 mm cuts printed one wall where measured.
        for d in [6.3, 6.8, 7.2] {
            assert_eq!(walls(d, DOUBLE_WALL_MM2), 1, "{d} mm with the switch on");
            assert_eq!(
                walls(d, 0.25 * std::f64::consts::PI * 25.0),
                2,
                "{d} mm with the switch off"
            );
        }
    }

    #[test]
    fn a_wider_trunk_still_prints_two_walls() {
        for d in [7.7, 9.0] {
            assert_eq!(walls(d, DOUBLE_WALL_MM2), 2, "{d} mm");
        }
    }

    /// How far apart the two ends of the one loop of a branch `d` mm across are, mm.
    fn loop_ends_apart(d: f64, anchor_spacings: f64) -> f64 {
        let paths = crate::treepaths::branch_walls_with_anchor(
            &circle(d),
            0.42,
            0.42,
            DOUBLE_WALL_MM2,
            anchor_spacings,
        );
        let [one] = paths.as_slice() else {
            panic!("one loop for {d} mm, got {}", paths.len());
        };
        let (a, b) = (one[0], one[one.len() - 1]);
        f64::from(b.x - a.x).m_hypot(f64::from(b.y - a.y)) / crate::geom::SCALE
    }

    #[test]
    fn a_branch_loop_ends_about_a_mm_and_a_quarter_from_its_start_with_the_switch_on() {
        // The anchor runs 3 line spacings (1.26 mm) along the wall a line inside, so on a round branch its end
        // sits 0.9 to 1.3 mm from where the loop closes, against 1.09 to 1.43 mm measured on whole plates (where
        // branches are seldom round); with the longer anchor the ends sit about 2 mm apart.
        for d in [3.0, 4.5, 6.0] {
            let on = loop_ends_apart(d, WALL_ANCHOR_SPACINGS);
            assert!(
                (0.85..=1.45).contains(&on),
                "{d} mm branch: ends {on:.3} mm apart"
            );
            let off = loop_ends_apart(d, 6.0);
            assert!(
                off > 1.6,
                "{d} mm branch with the longer anchor: ends {off:.3} mm apart"
            );
        }
    }

    #[test]
    fn the_wall_line_follows_the_switch() {
        let off = crate::config::PrintConfig::from_value(&serde_json::json!({})).unwrap();
        let on = crate::config::PrintConfig::from_value(&serde_json::json!({ "organic_per_object": true }))
            .unwrap();
        assert!((auto_double_wall_mm2(&off) - 0.25 * std::f64::consts::PI * 25.0).abs() < 1e-9);
        assert!((auto_double_wall_mm2(&on) - DOUBLE_WALL_MM2).abs() < 1e-9);
        assert!((wall_anchor_spacings(&off) - 6.0).abs() < 1e-9);
        assert!((wall_anchor_spacings(&on) - WALL_ANCHOR_SPACINGS).abs() < 1e-9);
    }
}
