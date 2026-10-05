// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The support layers of organic trees, from the drawn branches and the placed roofs, as Orca's common support
//! code finishes them (Support/SupportCommon.cpp):
//!
//! - `generate_interface_layers`: the top contacts within `support_interface_top_layers` above a base layer and
//!   the bottom contacts within `support_interface_bottom_layers` below it are closed, smoothed outward and cut
//!   from the base as interface; roofs placed with the tips at the same height join them;
//! - `generate_raft_base` without a raft: the first base layer grows by `raft_first_layer_expansion` in steps
//!   that stay `support_object_first_layer_gap` clear of the part, and leaves the brim alone;
//! - `generate_support_layers`: the interface number of each layer, which turns the interface lines;
//! - everything clipped to the bed.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "layer arrays indexed by support layer, and plate units"
)]

use super::draw::{Drawn, Heights};
use super::geo::{self, Join};
use super::settings::Settings;
use super::smooth::smooth_outward;
use super::{OrganicIn, Placer};
use crate::perimeters::Shapes;

const EPS: f64 = 1e-4;

/// The areas one organic support layer prints, by kind.
#[derive(Debug, Default, Clone)]
pub(crate) struct OrganicLayer {
    /// The layer right under an overhang (or a tip roof): printed as interface.
    pub(crate) top_contact: Shapes,
    /// Interface under a top contact or over a bottom contact.
    pub(crate) interface: Shapes,
    /// The interface is a bottom interface (over a bottom contact only), printed at the bottom spacing.
    pub(crate) interface_bottom: bool,
    /// Base interface, printed with the support filament at interface density.
    pub(crate) base_interface: Shapes,
    /// The branches.
    pub(crate) base: Shapes,
    /// Where branches rest on the part.
    pub(crate) bottom_contact: Shapes,
    /// Orca's support layer `interface_id`, which turns the interface lines between layers.
    pub(crate) interface_id: usize,
    /// The overhangs the top contact holds up, which contact loops follow.
    pub(crate) hang: Shapes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    TopInterface,
    BottomInterface,
}

fn rings_union(r: &[geo::Ring]) -> Shapes {
    geo::merge_rings(r, i_overlay::core::fill_rule::FillRule::NonZero)
}

/// Orca's `closing` with square joins: grown by `d1`, shrunk by `d2`.
fn closing(s: &Shapes, d1: f64, d2: f64) -> Shapes {
    geo::offset(&geo::offset(s, d1, Join::Square), -d2, Join::Square)
}

/// From the drawn branches and the placed roofs to the organic layers of every support layer.
pub(crate) fn finish(
    inp: &OrganicIn<'_>,
    cfg: &Settings,
    h: &Heights,
    placer: &Placer,
    drawn: &Drawn,
    bed: &Shapes,
    overhangs: &[Shapes],
) -> Vec<Option<OrganicLayer>> {
    let p = &inp.params;
    let n = placer
        .top_contacts
        .len()
        .max(drawn.base.len())
        .max(drawn.bottom_contacts.len());
    let print_z = |l: usize| h.z(l as i64);
    let bottom_z = |l: usize| if l > 0 { h.z(l as i64 - 1) } else { 0.0 };
    let at = |v: &Vec<Option<Vec<geo::Ring>>>, l: usize| -> Shapes {
        v.get(l)
            .and_then(Option::as_ref)
            .map(|r| rings_union(r))
            .unwrap_or_default()
    };
    let mut top_contact: Vec<Shapes> = (0..n).map(|l| at(&placer.top_contacts, l)).collect();
    // Roofs placed with the tips, as interface layers of their own until a base layer takes them.
    let mut pre_iface: Vec<Shapes> = (0..n).map(|l| at(&placer.top_interfaces, l)).collect();
    let mut pre_base_iface: Vec<Shapes> = (0..n).map(|l| at(&placer.top_base_interfaces, l)).collect();
    let mut base: Vec<Shapes> = (0..n)
        .map(|l| drawn.base.get(l).cloned().unwrap_or_default())
        .collect();
    let bottom_contact: Vec<Shapes> = (0..n)
        .map(|l| drawn.bottom_contacts.get(l).cloned().unwrap_or_default())
        .collect();
    let mut iface: Vec<Option<(Shapes, Kind)>> = vec![None; n];
    let mut base_iface: Vec<Option<Shapes>> = vec![None; n];

    // `generate_interface_layers`.
    let inter: Vec<usize> = (0..n).filter(|&l| !base[l].is_empty()).collect();
    let tops: Vec<usize> = (0..n).filter(|&l| !top_contact[l].is_empty()).collect();
    let bottoms: Vec<usize> = (0..n).filter(|&l| !bottom_contact[l].is_empty()).collect();
    let num_top = p.num_top_interface_layers;
    let num_bottom = p.num_bottom_interface_layers;
    if !inter.is_empty() && num_top + num_bottom > 0 {
        let ni = inter.len();
        let num_top_only = num_top - p.num_top_base_interface_layers;
        let num_bottom_base = 0usize;
        let smoothing = geo::sc(p.interface_spacing) as f64 * 1.5;
        let closing_distance = smoothing;
        let r_top = geo::sc(p.interface_spacing) as f64 / p.top_interface_density;
        let r_bottom = geo::sc(p.interface_spacing) as f64 / p.bottom_interface_density;
        let regularize = |polys: Shapes, r: f64| -> Shapes {
            if polys.is_empty() {
                return polys;
            }
            smooth_outward(
                &closing(&polys, closing_distance + r, closing_distance),
                smoothing as i64,
            )
        };
        for k in 0..ni {
            let il = inter[k];
            let iz = print_z(il);
            let mut top_iface_proj: Vec<geo::Ring> = Vec::new();
            let mut top_base_proj: Vec<geo::Ring> = Vec::new();
            let mut bottom_iface_proj: Vec<geo::Ring> = Vec::new();
            let mut bottom_base_proj: Vec<geo::Ring> = Vec::new();
            if num_top > 0 {
                let top_z = print_z(inter[(ni - 1).min(k + num_top - 1)]);
                let top_iface_z = if p.num_top_base_interface_layers > 0 {
                    if num_top_only == 0 {
                        f64::MIN
                    } else {
                        print_z(inter[(ni - 1).min(k + num_top_only - 1)])
                    }
                } else {
                    f64::MAX
                };
                let first = tops.partition_point(|&t| print_z(t) < iz);
                for &t in &tops[first..] {
                    if bottom_z(t) - EPS > top_z {
                        break;
                    }
                    let dst = if bottom_z(t) - EPS > top_iface_z {
                        &mut top_base_proj
                    } else {
                        &mut top_iface_proj
                    };
                    dst.extend(geo::rings(&top_contact[t]).cloned());
                }
            }
            if num_bottom > 0 {
                let bz = bottom_z(inter[k.saturating_sub(num_bottom - 1)]);
                let bottom_iface_z = if num_bottom_base > 0 { f64::MAX } else { f64::MIN };
                let first = bottoms.partition_point(|&b| print_z(b) < bz - EPS);
                for &b in &bottoms[first..] {
                    if print_z(b) - EPS > bottom_z(il) {
                        break;
                    }
                    let dst = if print_z(b) - EPS > bottom_iface_z {
                        &mut bottom_iface_proj
                    } else {
                        &mut bottom_base_proj
                    };
                    dst.extend(geo::rings(&bottom_contact[b]).cloned());
                }
            }
            let insert = |bottom: Vec<geo::Ring>,
                          top: Vec<geo::Ring>,
                          pre: &mut Shapes,
                          subtract: Option<&Shapes>,
                          base_l: &mut Shapes|
             -> Option<Shapes> {
                let has_pre = !pre.is_empty();
                let bottom = regularize(rings_union(&bottom), r_bottom);
                let top = regularize(rings_union(&top), r_top);
                let mut b = geo::inter(&geo::union2(&bottom, &top), base_l);
                if has_pre {
                    b = geo::union2(pre, &b);
                    pre.clear();
                }
                if b.is_empty() {
                    return None;
                }
                *base_l = geo::diff(base_l, &b);
                if let Some(s) = subtract {
                    b = geo::diff(&b, s);
                }
                Some(b)
            };
            let mut base_l = std::mem::take(&mut base[il]);
            let had_pre_iface = !pre_iface[il].is_empty();
            let mut new_iface: Option<Shapes> = None;
            if !bottom_iface_proj.is_empty() || !top_iface_proj.is_empty() || had_pre_iface {
                let kind = if had_pre_iface || !top_iface_proj.is_empty() {
                    Kind::TopInterface
                } else {
                    Kind::BottomInterface
                };
                new_iface = insert(
                    bottom_iface_proj,
                    top_iface_proj,
                    &mut pre_iface[il],
                    None,
                    &mut base_l,
                );
                if let Some(s) = &new_iface {
                    iface[il] = Some((s.clone(), kind));
                }
            }
            if !bottom_base_proj.is_empty() || !top_base_proj.is_empty() || !pre_base_iface[il].is_empty() {
                base_iface[il] = insert(
                    bottom_base_proj,
                    top_base_proj,
                    &mut pre_base_iface[il],
                    new_iface.as_ref(),
                    &mut base_l,
                );
            }
            base[il] = base_l;
        }
    }
    // Roofs no base layer took stay interface layers of their own.
    for l in 0..n {
        if iface[l].is_none() && !pre_iface[l].is_empty() {
            iface[l] = Some((std::mem::take(&mut pre_iface[l]), Kind::TopInterface));
        }
        if base_iface[l].is_none() && !pre_base_iface[l].is_empty() {
            base_iface[l] = Some(std::mem::take(&mut pre_base_iface[l]));
        }
    }

    // `generate_raft_base` without a raft: the first base layer.
    if n > 0 && !base[0].is_empty() && inp.raft_tops.is_empty() {
        let mut interface_polygons: Vec<&Shapes> = Vec::new();
        if !top_contact[0].is_empty() && print_z(0) <= inp.first_layer_height + EPS {
            interface_polygons.push(&top_contact[0]);
        }
        if let Some((s, _)) = &iface[0] {
            interface_polygons.push(s);
        }
        if let Some(s) = &base_iface[0] {
            interface_polygons.push(s);
        }
        let interface_polygons = crate::perimeters::union_all(&interface_polygons);
        let trimming = geo::offset(
            &inp.tree.models[0],
            geo::sc(inp.gap_xy_first_layer) as f64,
            Join::Square,
        );
        let inflate = (geo::sc(inp.first_layer_expansion) as f64 - geo::sc(EPS) as f64).max(0.0);
        let mut raft = std::mem::take(&mut base[0]);
        if inflate > 1.0 {
            let nsteps = 5.max((inflate / geo::sc(inp.first_layer_width) as f64).ceil() as i64);
            let step = inflate / nsteps as f64;
            for _ in 0..nsteps {
                raft = geo::diff(&geo::offset(&raft, step, Join::Miter(3.0)), &trimming);
            }
        } else {
            raft = geo::diff(&raft, &trimming);
        }
        if !interface_polygons.is_empty() {
            raft = geo::diff(&raft, &interface_polygons);
        }
        base[0] = raft;
    }
    if let Some(brim) = &inp.brim
        && n > 0
        && !brim.is_empty()
        && inp.raft_tops.is_empty()
    {
        base[0] = geo::diff(&base[0], brim);
        top_contact[0] = geo::diff(&top_contact[0], brim);
        if let Some((s, _)) = &mut iface[0] {
            *s = geo::diff(s, brim);
        }
        if let Some(s) = &mut base_iface[0] {
            *s = geo::diff(s, brim);
        }
    }

    // `generate_support_layers` and the clip to the bed.
    let mut out: Vec<Option<OrganicLayer>> = vec![None; n];
    let mut layer_id_interface = 0usize;
    let mut prev_layer: Option<(usize, usize)> = None;
    for l in 0..n {
        let clip = |s: &Shapes| {
            if s.is_empty() {
                Vec::new()
            } else {
                geo::inter(s, bed)
            }
        };
        let (iface_s, kind) = iface[l].clone().unwrap_or((Vec::new(), Kind::TopInterface));
        let ol = OrganicLayer {
            top_contact: clip(&top_contact[l]),
            interface: clip(&iface_s),
            interface_bottom: kind == Kind::BottomInterface,
            base_interface: base_iface[l].as_ref().map(clip).unwrap_or_default(),
            base: clip(&base[l]),
            bottom_contact: clip(&bottom_contact[l]),
            interface_id: 0,
            hang: if top_contact[l].is_empty() {
                Vec::new()
            } else {
                overhangs
                    .get(l + cfg.z_distance_top_layers + 1)
                    .cloned()
                    .unwrap_or_default()
            },
        };
        // Emptiness is judged before the clip, as Orca merges the layers before it clips them.
        let has = |s: &Shapes| !s.is_empty();
        let empty = !has(&top_contact[l])
            && iface[l].as_ref().is_none_or(|(s, _)| s.is_empty())
            && base_iface[l].as_ref().is_none_or(Vec::is_empty)
            && !has(&base[l])
            && !has(&bottom_contact[l]);
        if empty {
            continue;
        }
        let num_interfaces = usize::from(has(&bottom_contact[l]))
            + usize::from(has(&top_contact[l]))
            + usize::from(iface[l].as_ref().is_some_and(|(s, _)| !s.is_empty()))
            + usize::from(base_iface[l].as_ref().is_some_and(|s| !s.is_empty()));
        let num_top_contacts = usize::from(has(&top_contact[l]));
        let contacts_only = num_top_contacts > 0 && num_top_contacts == num_interfaces;
        let mut this_id = layer_id_interface;
        if contacts_only {
            // The layer under the contact (its bottom), when it is a support layer, sets the direction.
            let target = bottom_z(l);
            if let Some((pl, pid)) = prev_layer
                && (print_z(pl) - target).abs() < EPS
            {
                this_id = pid + 1;
            }
        }
        let mut ol = ol;
        ol.interface_id = this_id;
        prev_layer = Some((l, this_id));
        if num_interfaces > 0 && !contacts_only {
            layer_id_interface += 1;
        }
        out[l] = Some(ol);
    }
    out
}
