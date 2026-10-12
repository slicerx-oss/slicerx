// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! From branch slices to support layers (spec 7.6 and 7.7): branch feet and bottom contacts, roofs
//! recovered at branch tops, then per layer the union of everything, cleaned up and split by kind.

use super::draw::{Branch, Slices};
use super::node::Node;
use super::ops;
use super::params::Params;
use super::volumes::Volumes;
use crate::perimeters::Shapes;

/// One layer of organic support, by kind.
#[derive(Debug, Clone, Default)]
pub(crate) struct Layer {
    /// Right under an overhang.
    pub(crate) top_contact: Shapes,
    /// Dense layers under the top contact.
    pub(crate) interface: Shapes,
    /// Interface layers past the top interface count.
    pub(crate) base_interface: Shapes,
    /// The branches.
    pub(crate) base: Shapes,
    /// Where a branch stands on the model.
    pub(crate) bottom_contact: Shapes,
    /// The overhangs the top contact holds up.
    pub(crate) hang: Shapes,
}

/// What one branch adds to the layers.
#[derive(Default)]
pub(crate) struct BranchOut {
    pub(crate) base: Vec<(usize, Shapes)>,
    pub(crate) bottom: Vec<(usize, Shapes)>,
    pub(crate) roofs: Vec<(usize, u32, Shapes)>,
}

#[allow(clippy::too_many_lines, reason = "the cases of a branch foot")]
pub(crate) fn finish_branch(
    p: &Params,
    v: &Volumes<'_>,
    layers: &[Vec<Node>],
    b: &Branch,
    s: Slices,
) -> BranchOut {
    let mut out = BranchOut::default();
    let n_floor = p.s.bottom_layers;
    let first_slice = s.areas.first().cloned().unwrap_or_default();
    let start = s.start;
    let root = b
        .nodes
        .first()
        .and_then(|&(l, k)| layers.get(l).and_then(|v| v.get(k)));
    if b.has_root
        && let Some(rn) = root
    {
        if rn.flat {
            if n_floor > 0 {
                let mut c = if p.z_bot >= 1 && start > 0 {
                    first_slice.clone()
                } else {
                    ops::inter(&first_slice, &v.placeable(0.0, start))
                };
                if c.is_empty() && start > 0 {
                    c.clone_from(&first_slice);
                }
                if !c.is_empty() {
                    out.bottom.push((start, c));
                }
            }
        } else if start > 0 {
            // A branch hanging over a slope or over air: extend it down until the model cuts it off.
            let r_bottom = p.drawn_radius(f64::from(rn.d), rn.e, rn.f);
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a layer count"
            )]
            let reach = (5.0 * r_bottom / p.h).ceil().max(0.0) as usize;
            let stop_at = if rn.very_lost {
                0
            } else {
                start.saturating_sub(reach)
            };
            let min_area = (0.2 * std::f64::consts::PI * r_bottom * r_bottom)
                .max(0.5 * std::f64::consts::PI * p.r_branch * p.r_branch);
            let mut cur = ops::diff(&first_slice, &v.collision(0.0, start, false));
            let mut extra: Vec<(usize, Shapes)> = Vec::new();
            let mut l = start;
            while l > stop_at {
                l -= 1;
                cur = ops::diff(&cur, &v.collision(0.0, l, false));
                if ops::area(&cur) < min_area {
                    break;
                }
                extra.push((l, cur.clone()));
            }
            if n_floor > 0 {
                let pick = |a: &Shapes, at: usize| {
                    if p.z_bot >= 1 {
                        ops::inter(a, v.bed())
                    } else {
                        ops::inter(a, &v.placeable(0.0, at))
                    }
                };
                let mut c = match extra.last() {
                    Some((at, a)) => (*at, pick(a, start)),
                    None => (start, pick(&first_slice, start)),
                };
                if c.1.is_empty() && c.0 > 0 {
                    c.1.clone_from(&first_slice);
                }
                if !c.1.is_empty() {
                    out.bottom.push(c);
                }
            }
            out.base.extend(extra);
        }
    }
    // Branch tops that should have been roofs become roofs again.
    let n_roof = p.s.top_layers;
    if n_roof > 0 {
        for &(l, k) in b.nodes.iter().rev() {
            let Some(n) = layers.get(l).and_then(|v| v.get(k)) else {
                break;
            };
            let Some(rc) = n.recovery.filter(|r| r.count > 0) else {
                break;
            };
            if rc.depth <= n_roof
                && let Some(a) = l.checked_sub(start).and_then(|i| s.areas.get(i))
                && !a.is_empty()
            {
                out.roofs.push((l, rc.depth, a.clone()));
            }
        }
    }
    for (i, a) in s.areas.into_iter().enumerate() {
        if !a.is_empty() {
            out.base.push((start + i, a));
        }
    }
    out
}

/// Provisional (spec 7.7): concave notches narrower than a support line are closed with a round grow by
/// half a line and back, standing in for cutting corners sharper than 135 degrees.
fn close_notches(s: &Shapes, w: f64) -> Shapes {
    if s.is_empty() {
        return Vec::new();
    }
    ops::grow_round(&ops::grow_round(s, w / 2.0), -w / 2.0)
}

/// Builds every support layer from the branch outputs and tip roofs (spec 7.7).
pub(crate) fn layers(
    p: &Params,
    v: &Volumes<'_>,
    count: usize,
    outs: Vec<BranchOut>,
    tip_roofs: Vec<(usize, u32, Shapes)>,
    overhangs: &[Shapes],
) -> Vec<Layer> {
    let mut base: Vec<Vec<Shapes>> = vec![Vec::new(); count];
    let mut bottom: Vec<Vec<Shapes>> = vec![Vec::new(); count];
    let mut roof: Vec<Vec<(u32, Shapes)>> = vec![Vec::new(); count];
    for o in outs {
        for (l, a) in o.base {
            if let Some(v) = base.get_mut(l) {
                v.push(a);
            }
        }
        for (l, a) in o.bottom {
            if let Some(v) = bottom.get_mut(l) {
                v.push(a);
            }
        }
        for (l, d, a) in o.roofs {
            if let Some(v) = roof.get_mut(l) {
                v.push((d, a));
            }
        }
    }
    for (l, d, a) in tip_roofs {
        if let Some(v) = roof.get_mut(l) {
            v.push((d, a));
        }
    }
    let n_roof = p.s.top_layers;
    // Top interface layers past the contact; past those come base interface layers (none by default).
    let interface_depths = n_roof.saturating_sub(1);
    let idx: Vec<usize> = (0..count).collect();
    let tol = p.s.resolution.min(0.03);
    let w = p.w;
    let mut out: Vec<Layer> = crate::par::map(&idx, |&l| {
        let empty = Vec::new();
        let refs: Vec<&Shapes> = base.get(l).unwrap_or(&empty).iter().collect();
        let b = ops::simplify(&close_notches(&ops::union_many(&refs), w), tol);
        let rs = roof.get(l).map_or(&[][..], Vec::as_slice);
        let pick = |f: &dyn Fn(u32) -> bool| {
            let parts: Vec<&Shapes> = rs.iter().filter(|(d, _)| f(*d)).map(|(_, a)| a).collect();
            ops::union_many(&parts)
        };
        let contact = pick(&|d| d == 0);
        let interface = ops::diff(&pick(&|d| d >= 1 && d <= interface_depths), &contact);
        let base_interface = ops::diff(
            &pick(&|d| d > interface_depths),
            &ops::union(&contact, &interface),
        );
        let brefs: Vec<&Shapes> = bottom.get(l).unwrap_or(&empty).iter().collect();
        let bottom_contact = ops::diff(&ops::union_many(&brefs), &contact);
        let roofs_all = ops::union_many(&[&contact, &interface, &base_interface]);
        let base = ops::diff(&ops::diff(&b, &roofs_all), &bottom_contact);
        let hang = if contact.is_empty() {
            Vec::new()
        } else {
            overhangs.get(l + p.z_top + 1).cloned().unwrap_or_default()
        };
        Layer {
            top_contact: contact,
            interface,
            base_interface,
            base,
            bottom_contact,
            hang,
        }
    });
    // Bottom interface layers above each bottom contact take the branch area there.
    let floors = p.s.bottom_layers as usize;
    if floors > 1 {
        for l in 0..count {
            let Some(bc) = out
                .get(l)
                .map(|x| x.bottom_contact.clone())
                .filter(|b| !b.is_empty())
            else {
                continue;
            };
            for j in 1..floors {
                if let Some(up) = out.get_mut(l + j) {
                    let add = ops::inter(&bc, &up.base);
                    if !add.is_empty() {
                        up.base = ops::diff(&up.base, &add);
                        up.interface = ops::union(&up.interface, &add);
                    }
                }
            }
        }
    }
    // Without a raft the first support layer is widened for adhesion, kept clear of the model.
    let grow0 = p.s.first_layer_expansion;
    if p.s.raft_layers == 0
        && grow0 > 0.0
        && let Some(first) = out.first_mut()
        && !first.base.is_empty()
    {
        let wide = ops::grow_round(&first.base, grow0);
        let others = ops::union_many(&[
            &first.top_contact,
            &first.interface,
            &first.base_interface,
            &first.bottom_contact,
        ]);
        let clear = ops::union(&v.collision(0.0, 0, true), &others);
        first.base = ops::union(&first.base, &ops::diff(&wide, &clear));
    }
    // Everything stays on the bed.
    let bed = v.bed();
    for x in &mut out {
        for s in [
            &mut x.top_contact,
            &mut x.interface,
            &mut x.base_interface,
            &mut x.base,
            &mut x.bottom_contact,
        ] {
            if !s.is_empty() {
                *s = ops::inter(s, bed);
            }
        }
    }
    out
}
