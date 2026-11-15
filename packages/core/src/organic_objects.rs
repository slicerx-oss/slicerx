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
//!   moved with it, so every copy prints the same paths on every layer.
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

/// The plate's organic plan from each object's own: on every layer, each object's areas moved to where it stands
/// and put together (each object's areas kept apart as [`Piece`]s for its paths), and the branches through each raft
/// layer likewise. `layers` is the number of support layers every plan has.
pub(crate) fn assemble(layers: usize, plans: &[Planned<'_>]) -> crate::organic::OrganicPlan {
    let mut out = crate::organic::OrganicPlan {
        layers: Vec::with_capacity(layers),
        raft: Vec::new(),
    };
    for l in 0..layers {
        let pieces: Vec<Piece> = plans
            .iter()
            .filter_map(|p| {
                let layer = p.plan.layers.get(l)?.organic.as_ref()?;
                Some(Piece {
                    object: p.object,
                    layer: Arc::clone(layer),
                    shift: p.shift,
                    bounds: p.bounds,
                })
            })
            .collect();
        if pieces.is_empty() {
            out.layers.push(SupportLayer::default());
            continue;
        }
        let each = |f: &dyn Fn(&SupportLayer) -> &Shapes| -> Shapes {
            let parts: Vec<Shapes> = plans
                .iter()
                .filter_map(|p| {
                    let sl = p.plan.layers.get(l)?;
                    sl.organic.as_ref()?;
                    let s = f(sl);
                    (!s.is_empty()).then(|| moved(s, p.shift))
                })
                .collect();
            union(&parts)
        };
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
        out.layers.push(SupportLayer {
            base: each(&|s| &s.base),
            interface: each(&|s| &s.interface),
            contact: each(&|s| &s.contact),
            hang: each(&|s| &s.hang),
            bottom: each(&|s| &s.bottom),
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
                    p.plan
                        .raft
                        .get(r)
                        .filter(|s| !s.is_empty())
                        .map(|s| moved(s, p.shift))
                })
                .collect();
            union(&parts)
        })
        .collect();
    out
}
