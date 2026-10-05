// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Toolpaths of organic tree supports, as Orca's `generate_support_toolpaths` prints them
//! (Support/SupportCommon.cpp) with the sheath organic trees always have:
//!
//! - the interface joins the top contact of its layer; bottom contacts join the base when there are no top or
//!   no bottom interface layers, or the top contact, and are otherwise not printed themselves (the interface
//!   above them is);
//! - top contacts and interfaces are filled with the contact filler at the interface density (a bottom
//!   interface at the bottom one), its lines turning 45 degrees each way between interface layers;
//! - base interfaces with rectilinear lines at the interface density;
//! - the first base layer is a flange: one loop and rectilinear lines across the support angle at
//!   `raft_first_layer_density`;
//! - other base layers are hollow branches with the default or hollow base pattern (one wall, two on wide
//!   islands), else a loop and the base filler inside.

#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "plate units"
)]

use super::layers::OrganicLayer;
use crate::config::InterfacePattern;
use crate::geom::{Point, SCALE};
use crate::perimeters::{self, Shapes};

type Path = Vec<Point>;

/// The contact filler (Orca's `contact_fill_pattern`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContactFill {
    SupportBase,
    Rectilinear,
    Concentric,
    Grid,
}

/// What the organic toolpaths read.
#[derive(Debug, Clone)]
pub(crate) struct PathsIn {
    /// Support and interface line width and flow spacing at the layer height, mm.
    pub(crate) width: f64,
    pub(crate) spacing: f64,
    pub(crate) interface_width: f64,
    pub(crate) interface_spacing: f64,
    /// The first layer's support line width and spacing, mm, and `raft_first_layer_density` as a share.
    pub(crate) first_width: f64,
    pub(crate) first_spacing: f64,
    pub(crate) first_density: f64,
    pub(crate) support_density: f64,
    pub(crate) top_interface_density: f64,
    pub(crate) bottom_interface_density: f64,
    /// The base filler is plain rectilinear (else the support base filler).
    pub(crate) base_rectilinear: bool,
    pub(crate) contact_fill: ContactFill,
    /// `support_angle`, degrees.
    pub(crate) angle: f64,
    pub(crate) interface_pattern: InterfacePattern,
    pub(crate) top_layers: u32,
    pub(crate) bottom_layers: u32,
    /// The support base pattern is default or hollow: branches print as walls only.
    pub(crate) hollow: bool,
    /// Islands wider than this get a second wall, mm2 (Orca's `tree_branch_diameter_double_wall_area_scaled`).
    pub(crate) double_wall_mm2: f64,
    pub(crate) center: [f64; 2],
    pub(crate) anchor_max: f64,
}

fn rect(area: &Shapes, spacing: f64, density: f64, angle: f64, p: &PathsIn) -> Vec<Path> {
    if area.is_empty() || density <= 0.0 {
        return Vec::new();
    }
    crate::patterns::support_lines(
        area,
        spacing,
        spacing / density,
        angle,
        false,
        p.anchor_max,
        p.center,
    )
}

fn base_fill(
    area: &Shapes,
    spacing: f64,
    density: f64,
    angle: f64,
    rectilinear: bool,
    p: &PathsIn,
) -> Vec<Path> {
    if area.is_empty() || density <= 0.0 {
        return Vec::new();
    }
    if rectilinear {
        rect(area, spacing, density, angle, p)
    } else {
        crate::supportfill::support_base(area, spacing, density, angle, p.center)
    }
}

/// `fill_expolygons_with_sheath_generate_paths` with a sheath: a loop half a line in, and the filler inside it.
fn with_sheath(
    area: &Shapes,
    width: f64,
    spacing: f64,
    density: f64,
    angle: f64,
    rectilinear: bool,
    p: &PathsIn,
) -> Vec<Path> {
    let shrunk = perimeters::offset(area, -((0.5 * width) * SCALE).round() as i32);
    let mut out = crate::treepaths::draw_perimeters(&shrunk, spacing * SCALE * 0.15);
    let inner = perimeters::offset(&shrunk, -((0.4 * spacing) * SCALE).round() as i32);
    out.extend(base_fill(&inner, spacing, density, angle, rectilinear, p));
    out
}

fn contact_fill(area: &Shapes, density: f64, angle: f64, layer: u32, z: f64, p: &PathsIn) -> Vec<Path> {
    if area.is_empty() || density <= 0.0 {
        return Vec::new();
    }
    let s = p.interface_spacing;
    match p.contact_fill {
        ContactFill::Concentric => {
            crate::surface::fill(area, crate::surface::Curve::Concentric, s / density, 0.0)
        }
        ContactFill::Grid => crate::patterns::sparse(&crate::patterns::SparseIn {
            pattern: crate::config::InfillPattern::Grid,
            region: area,
            w_mm: p.interface_width,
            spacing_mm: s,
            density,
            z_mm: z,
            layer,
            connect_mm: p.anchor_max,
            anchor_mm: 0.0,
            object: [p.center[0], p.center[1], p.center[0], p.center[1]],
            angle_deg: angle,
            lateral_angles: [-45.0, 45.0],
            overhang_angle_deg: 60.0,
            fixed_angle: false,
            gyroid_layer_height: None,
        }),
        ContactFill::Rectilinear => rect(area, s, density, angle, p),
        ContactFill::SupportBase => crate::supportfill::support_base(area, s, density, angle, p.center),
    }
}

/// The support and interface paths of one organic layer. `layer` is the support layer's index (0 is the
/// first layer) and `z` its top, mm.
/// The interface angle of an organic layer, degrees (Orca's `support_interface_angle`).
pub(crate) fn interface_angle(ol: &OrganicLayer, p: &PathsIn) -> f64 {
    let turning = if ol.interface_id % 2 == 1 { -45.0 } else { 45.0 };
    match p.interface_pattern {
        InterfacePattern::Rectilinear => p.angle + 90.0,
        _ => turning,
    }
}

pub(crate) fn layer_paths(ol: &OrganicLayer, layer: u32, z: f64, p: &PathsIn) -> (Vec<Path>, Vec<Path>) {
    let iface_angle = interface_angle(ol, p);
    let mut top = ol.top_contact.clone();
    let mut iface = ol.interface.clone();
    let mut base = ol.base.clone();
    let mut bottom = ol.bottom_contact.clone();
    let mut iface_bottom = ol.interface_bottom;
    if p.top_layers == 0 {
        if !base.is_empty() && !top.is_empty() {
            base = perimeters::union_all(&[&base, &top]);
            top.clear();
        } else if base.is_empty() {
            base = std::mem::take(&mut top);
        }
    } else if !top.is_empty() && !iface.is_empty() {
        top = perimeters::union_all(&[&top, &iface]);
        iface.clear();
        iface_bottom = false;
    }
    if p.top_layers == 0 || p.bottom_layers == 0 {
        if !base.is_empty() && !bottom.is_empty() {
            base = perimeters::union_all(&[&base, &bottom]);
            bottom.clear();
        } else if base.is_empty() && !bottom.is_empty() {
            base = std::mem::take(&mut bottom);
        }
    } else if !bottom.is_empty() && !top.is_empty() {
        top = perimeters::union_all(&[&top, &bottom]);
        bottom.clear();
    }
    let mut support: Vec<Path> = Vec::new();
    let mut interface: Vec<Path> = Vec::new();
    // Top contact and interface; with no top interface layers they print as base.
    for (area, is_bottom) in [(&top, false), (&iface, iface_bottom)] {
        if area.is_empty() {
            continue;
        }
        if p.top_layers == 0 {
            support.extend(base_fill(
                area,
                p.spacing,
                p.support_density,
                p.angle,
                p.base_rectilinear,
                p,
            ));
        } else {
            let density = if is_bottom {
                p.bottom_interface_density
            } else {
                p.top_interface_density
            };
            interface.extend(contact_fill(area, density, iface_angle, layer, z, p));
        }
    }
    if !ol.base_interface.is_empty() {
        support.extend(rect(
            &ol.base_interface,
            p.interface_spacing,
            p.top_interface_density,
            iface_angle,
            p,
        ));
    }
    if !base.is_empty() {
        if layer == 0 {
            support.extend(with_sheath(
                &base,
                p.first_width,
                p.first_spacing,
                p.first_density,
                p.angle + 90.0,
                true,
                p,
            ));
        } else if p.hollow {
            let double = if z > 100.0 { 0.1 } else { p.double_wall_mm2 };
            support.extend(crate::treepaths::branch_walls(&base, p.width, p.spacing, double));
        } else {
            support.extend(with_sheath(
                &base,
                p.width,
                p.spacing,
                p.support_density,
                p.angle,
                p.base_rectilinear,
                p,
            ));
        }
    }
    (support, interface)
}
