// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Organic tree supports, as Orca builds them with `TreeSupport3D` (`Support/TreeSupport3D.cpp`,
//! `Support/TreeModelVolumes.cpp`), the tree supports of Thomas Rahm that `PrusaSlicer`'s organic style also uses:
//!
//! 1. overhangs from the same detection as the slim, strong and hybrid trees (`treeclassic`);
//! 2. the model volumes branches must avoid ([`volumes`]);
//! 3. tips under every overhang, and roofs under wide ones ([`tips`]);
//! 4. influence areas grown down layer by layer and merged, then a point per branch and layer ([`pathing`]);
//! 5. smoothed branches drawn as tube meshes and sliced per layer ([`draw`]);
//! 6. interface layers projected from the contacts, the first layer widened, and the layers merged by height
//!    ([`layers`]), then toolpaths ([`paths`]).
//!
//! Orca 2.4.2 and `PrusaSlicer` 2.8 share this code; Orca's copy has its later fixes (roofs recovered from the
//! branch slices, flat feet on the bed, smoothing that never moves a point past what the branch may lean, and
//! bottom contacts kept when the bottom gap is not zero), so Orca's is followed.

#![allow(
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    reason = "layer arrays indexed by support layer, and plate units in i64"
)]

pub(crate) mod draw;
pub(crate) mod elements;
pub(crate) mod geo;
pub(crate) mod layers;
pub(crate) mod pathing;
pub(crate) mod paths;
pub(crate) mod settings;
pub(crate) mod smooth;
pub(crate) mod tips;
pub(crate) mod volumes;

#[cfg(test)]
mod tests;

use crate::perimeters::Shapes;
use std::sync::Arc;

pub(crate) use layers::OrganicLayer;

/// The support parameters tip placement and toolpaths read (Orca's `SupportParameters`).
#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools, reason = "one field per support parameter")]
pub(crate) struct Params {
    pub(crate) num_top_interface_layers: usize,
    pub(crate) num_top_base_interface_layers: usize,
    pub(crate) num_bottom_interface_layers: usize,
    pub(crate) has_top_contacts: bool,
    pub(crate) zero_gap_interface_top: bool,
    pub(crate) num_raft_layers: usize,
    /// `support_angle`, degrees.
    pub(crate) base_angle: f64,
    /// Support and interface flow spacing at the layer height, mm.
    pub(crate) support_spacing: f64,
    pub(crate) interface_spacing: f64,
    pub(crate) support_width: f64,
    pub(crate) interface_width: f64,
    pub(crate) top_interface_density: f64,
    pub(crate) bottom_interface_density: f64,
    pub(crate) support_density: f64,
    /// The base and interface fillers are plain rectilinear (else the support base filler).
    pub(crate) base_rectilinear: bool,
    pub(crate) interface_rectilinear: bool,
}

impl Params {
    /// Orca's tip circle (`make_circle(0.01 mm, 25 nm)`) scaled to `radius` by a whole factor.
    pub(crate) fn base_circle(radius: i64) -> Vec<(f64, f64)> {
        let base = geo::sc(0.01);
        let error = 25.0 * crate::geom::SCALE / 1e6;
        let k = (radius / base.max(1)) as f64;
        geo::circle(base as f64, error)
            .into_iter()
            .map(|(x, y)| (x * k, y * k))
            .collect()
    }
}

/// The roofs and contacts placed while the trees are planned (Orca's `InterfacePlacer`), per layer.
#[derive(Debug, Default)]
pub(crate) struct Placer {
    pub(crate) top_contacts: Vec<Option<Vec<geo::Ring>>>,
    pub(crate) top_interfaces: Vec<Option<Vec<geo::Ring>>>,
    pub(crate) top_base_interfaces: Vec<Option<Vec<geo::Ring>>>,
    num_top_interface_layers: usize,
    num_top_base_interface_layers: usize,
}

impl Placer {
    fn new(layers: usize, p: &Params) -> Self {
        Self {
            top_contacts: vec![None; layers],
            top_interfaces: vec![None; layers],
            top_base_interfaces: vec![None; layers],
            num_top_interface_layers: p.num_top_interface_layers,
            num_top_base_interface_layers: p.num_top_base_interface_layers,
        }
    }

    /// `add_roof_unguarded`: the contact layer for depth 0, an interface layer below it, base interfaces
    /// further down when the interface uses another filament.
    pub(crate) fn add_roof(&mut self, rings: Vec<geo::Ring>, layer: i64, dtt_roof: usize) {
        let mut threshold = self.num_top_interface_layers - self.num_top_base_interface_layers;
        if threshold > 0 && self.num_top_base_interface_layers > 0 {
            threshold -= 1;
        }
        let list = if dtt_roof == 0 {
            &mut self.top_contacts
        } else if dtt_roof <= threshold {
            &mut self.top_interfaces
        } else {
            &mut self.top_base_interfaces
        };
        if layer < 0 {
            return;
        }
        if let Some(slot) = list.get_mut(layer as usize) {
            slot.get_or_insert_with(Vec::new).extend(rings);
        }
    }
}

/// What the organic planner reads.
pub(crate) struct OrganicIn<'a> {
    /// The inputs of the overhang detection shared with the slim, strong and hybrid trees.
    pub(crate) tree: crate::treeclassic::TreeIn<'a>,
    pub(crate) raw: settings::Raw,
    pub(crate) params: Params,
    /// The first layer's print height, mm.
    pub(crate) first_layer_height: f64,
    /// `raft_first_layer_expansion` and the first layer line width, mm.
    pub(crate) first_layer_expansion: f64,
    pub(crate) first_layer_width: f64,
    /// `support_object_first_layer_gap`, mm.
    pub(crate) gap_xy_first_layer: f64,
    /// The area the brim covers on the first layer, which the first support layer stays out of.
    pub(crate) brim: Option<Shapes>,
    /// Centers of the vertical facets painted as support enforcers, mm (plate coordinates).
    pub(crate) vertical_points: Vec<[f64; 3]>,
    /// The tops of the raft layers under the object (none without a raft), mm.
    pub(crate) raft_tops: Vec<f64>,
    /// The raft's contact layer and how far the raft grows past the object, which tips standing on it end on.
    pub(crate) raft_contact: Shapes,
    pub(crate) raft_expansion: f64,
}

/// Organic support for the object layers, and the branches that pass through each raft layer.
#[derive(Debug, Default)]
pub(crate) struct OrganicPlan {
    pub(crate) layers: Vec<crate::support::SupportLayer>,
    pub(crate) raft: Vec<Shapes>,
}

/// Organic tree supports for every object layer: the support areas and the organic layer they print.
pub(crate) fn plan(inp: &OrganicIn<'_>) -> OrganicPlan {
    let n = inp.tree.models.len();
    let num_raft = inp.raft_tops.len();
    let empty = OrganicPlan {
        layers: vec![crate::support::SupportLayer::default(); n],
        raft: Vec::new(),
    };
    if n == 0 {
        return empty;
    }
    let cfg = settings::Settings::new(&inp.raw);
    // Overhangs: the classic detection, sharp tails grown 0.2 mm.
    let detected = crate::treeclassic::overhang_areas(&inp.tree);
    let overhangs: Vec<Shapes> = detected
        .into_iter()
        .map(|(parts, tails)| {
            if tails.is_empty() {
                parts
            } else {
                geo::union2(
                    &parts,
                    &geo::offset(&tails, geo::sc(0.2) as f64, geo::Join::Miter(3.0)),
                )
            }
        })
        .collect();
    // Painted vertical walls get a small overhang at their facets' centers (Orca's `m_vertical_enforcer_points`),
    // on the first layer whose top reaches the point.
    let mut overhangs = overhangs;
    let circle = geo::circle(geo::sc(0.5) as f64, 25.0 * crate::geom::SCALE / 1e6);
    for p in &inp.vertical_points {
        let l = inp.tree.tops.partition_point(|&t| t < p[2]);
        if l > 0 && l < overhangs.len() {
            let ring = geo::ring_at(&circle, (geo::sc(p[0]), geo::sc(p[1])));
            overhangs[l] = geo::union2(&overhangs[l], &vec![vec![ring]]);
        }
    }
    let bed = inp.tree.bed;
    let bed_area: Shapes = vec![vec![vec![
        geo::ip((geo::sc(bed[0]), geo::sc(bed[1]))),
        geo::ip((geo::sc(bed[2]), geo::sc(bed[1]))),
        geo::ip((geo::sc(bed[2]), geo::sc(bed[3]))),
        geo::ip((geo::sc(bed[0]), geo::sc(bed[3]))),
    ]]];
    // Over a raft the support layers start with the raft layers, where nothing of the object is.
    let shift = |v: &[Shapes]| -> Vec<Shapes> {
        let mut out = vec![Vec::new(); num_raft];
        out.extend(v.iter().cloned());
        out
    };
    let overhangs = if num_raft > 0 {
        shift(&overhangs)
    } else {
        overhangs
    };
    let (models, blockers) = if num_raft > 0 {
        (shift(inp.tree.models), shift(inp.tree.block))
    } else {
        (inp.tree.models.to_vec(), inp.tree.block.to_vec())
    };
    let mut volumes = volumes::Volumes::new(&cfg, &models, &blockers, bed_area.clone());
    // `precalculate`: the highest layer support is needed on.
    let mut max_support_layer = 0i64;
    for (l, o) in overhangs.iter().enumerate().skip(num_raft.max(1)) {
        if !o.is_empty() {
            max_support_layer = l as i64;
        }
    }
    let max_layer = (max_support_layer - cfg.z_distance_top_layers as i64).max(0);
    if max_layer <= 0 {
        return empty;
    }
    volumes.precalculate(&cfg, max_layer);
    let num_support_layers = max_layer as usize;
    let mut move_bounds: Vec<Vec<elements::Element>> = vec![Vec::new(); num_support_layers];
    let mut placer = Placer::new(num_support_layers, &inp.params);
    let mut params = inp.params.clone();
    params.num_raft_layers = num_raft;
    tips::generate_initial_areas(&volumes, &cfg, &params, &overhangs, &mut move_bounds, &mut placer);
    if num_raft > 0 {
        finalize_raft_contact(inp, num_raft, &mut move_bounds, &mut placer);
    }
    pathing::create_layer_pathing(&volumes, &cfg, &mut move_bounds);
    pathing::create_nodes_from_area(&volumes, &cfg, &mut move_bounds);
    let heights = draw::Heights {
        raft: inp.raft_tops.clone(),
        first: inp.first_layer_height,
        layer: inp.raw.layer_height,
    };
    let drawn = draw::draw_branches(
        &mut volumes,
        &cfg,
        &params,
        &heights,
        &mut move_bounds,
        &mut placer,
    );
    let organic = layers::finish(inp, &cfg, &heights, &placer, &drawn, &bed_area, &overhangs);
    let mut out = empty;
    for (l, ol) in organic.into_iter().enumerate() {
        if l < num_raft {
            // Branches through the raft print as branches; the raft prints around them.
            if out.raft.len() < num_raft {
                out.raft.resize(num_raft, Vec::new());
            }
            if let Some(ol) = ol {
                out.raft[l] = crate::perimeters::union_all(&[
                    &ol.base,
                    &ol.base_interface,
                    &ol.interface,
                    &ol.top_contact,
                ]);
            }
            continue;
        }
        let Some(slot) = out.layers.get_mut(l - num_raft) else {
            break;
        };
        let Some(ol) = ol else { continue };
        let base = geo::union2(&ol.base, &ol.base_interface);
        let interface = geo::union2(&ol.top_contact, &ol.interface);
        *slot = crate::support::SupportLayer {
            base,
            interface,
            contact: ol.top_contact.clone(),
            hang: ol.hang.clone(),
            bottom: if ol.interface_bottom {
                ol.interface.clone()
            } else {
                Vec::new()
            },
            organic: Some(Arc::new(ol)),
            ..crate::support::SupportLayer::default()
        };
    }
    out
}

/// `finalize_raft_contact`: no tips under the raft contact, and none on the raft contact layer where they stand
/// inside the raft near its edge (within twice the raft expansion), since the raft holds those up.
fn finalize_raft_contact(
    inp: &OrganicIn<'_>,
    num_raft: usize,
    move_bounds: &mut [Vec<elements::Element>],
    placer: &mut Placer,
) {
    let first_tree_layer = num_raft - 1;
    for i in 0..first_tree_layer.min(move_bounds.len()) {
        move_bounds[i].clear();
        if let Some(t) = placer.top_contacts.get_mut(i) {
            *t = None;
        }
    }
    if inp.raft_expansion > 0.0 && !inp.raft_contact.is_empty() {
        let threshold = 2.0 * geo::sc(inp.raft_expansion) as f64;
        let edges = geo::to_polylines(&inp.raft_contact);
        if let Some(layer) = move_bounds.get_mut(first_tree_layer) {
            layer.retain(|el| {
                let Some(p) = el.state.result_on_layer else {
                    return true;
                };
                if !geo::contains(&inp.raft_contact, p) {
                    return true;
                }
                let d2 = edges
                    .iter()
                    .flat_map(|l| l.windows(2))
                    .map(|w| geo::seg_dist2(p, w[0], w[1]))
                    .fold(f64::MAX, f64::min);
                d2 >= threshold * threshold
            });
        }
    }
}
