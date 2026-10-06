// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Raft layers under the part: a first layer wider than the part, base layers, interface layers and
//! a contact layer, with a gap to the part's first layer. Own implementation after the way Orca plans
//! them (`Slicing.cpp` `SlicingParameters::create_from_config`, `Support/SupportCommon.cpp`
//! `generate_raft_base` and `generate_support_toolpaths`, `Support/SupportParameters.hpp`).
//!
//! The raft is separate from the part: the part is sliced as always and every part layer moves up by
//! the raft's height and the gap; the raft layers are made here from the part's first layer.

use crate::config::PrintConfig;
use crate::fm::Fm as _;
use crate::geom::{Point, mm};
use crate::output::LayerPaths;
use crate::paths::ToolWork;
use crate::perimeters::{self, Shapes};
use i_overlay::i_float::int::point::IntPoint;

/// What a raft layer is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// The first layer: the widest, dense, inside one loop.
    First,
    /// Base layers between the first layer and the interface, at the support's line spacing.
    Base,
    /// Interface layers under the contact layer.
    Interface,
    /// The last layer, which the part's first layer rests on.
    Contact,
}

/// One raft layer.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Layer {
    pub kind: Kind,
    /// Top of the layer, mm.
    pub top: f64,
    pub height: f64,
    /// Counts the interface layers, which turn the lines by 90 degrees from one to the next.
    pub interface_id: usize,
}

/// The raft of one plate.
#[derive(Debug, Clone)]
pub(crate) struct Plan {
    pub layers: Vec<Layer>,
    /// How far the part's layers move up: the top of the contact layer plus the gap, mm.
    pub offset: f64,
    /// Layers of the first layer and the base, then the interface and the contact layer.
    base_count: usize,
    interface_count: usize,
    expansion: f64,
    first_expansion: f64,
    first_density: f64,
    /// What the part's first layer covers, which the raft grows from (set when the raft is placed).
    pub first_layer: Shapes,
    /// The contact area stretched to the support grid when the supports are not trees (set with
    /// `first_layer`): what the contact layer prints, and the cells the layers below grow from.
    stretched: Option<(Shapes, Shapes)>,
}

/// The raft layers asked for, 0 for none.
pub(crate) fn layers_asked(cfg: &PrintConfig) -> u32 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small layer count"
    )]
    {
        cfg.raw_number("raft_layers", 0.0).clamp(0.0, 1000.0).round() as u32
    }
}

/// The raft for these settings, or none.
pub(crate) fn plan(cfg: &PrintConfig) -> Option<Plan> {
    let n = layers_asked(cfg) as usize;
    if n == 0 {
        return None;
    }
    let lh = cfg.layer_height;
    let first = if cfg.initial_layer_print_height > 0.0 {
        cfg.initial_layer_print_height
    } else {
        lh
    };
    // The intermediate layers are as thick as the nozzle allows (three quarters of its diameter).
    let thick = lh.max(0.75 * cfg.nozzle_diameter);
    let interface_count = n.div_ceil(2);
    let base_count = n - interface_count;
    let mut layers: Vec<Layer> = Vec::new();
    #[allow(clippy::needless_late_init, reason = "set in each branch below")]
    let contact_top;
    if n == 1 {
        layers.push(Layer {
            kind: Kind::Contact,
            top: first,
            height: first,
            interface_id: 0,
        });
        contact_top = first;
    } else {
        layers.push(Layer {
            kind: Kind::First,
            top: first,
            height: first,
            interface_id: 0,
        });
        let mut top = first;
        for _ in 1..base_count {
            top += thick;
            layers.push(Layer {
                kind: Kind::Base,
                top,
                height: thick,
                interface_id: 0,
            });
        }
        for i in 0..interface_count.saturating_sub(1) {
            top += thick;
            layers.push(Layer {
                kind: Kind::Interface,
                top,
                height: thick,
                interface_id: i,
            });
        }
        top += thick;
        // Orca (SupportCommon.cpp generate_support_layers): a contacts-only layer takes the interface id of the
        // layer under it plus one, so it turns from that layer. Under it is the last interface layer
        // (`interface_count - 2`), or with none the first layer (id 0).
        layers.push(Layer {
            kind: Kind::Contact,
            top,
            height: thick,
            interface_id: interface_count.saturating_sub(1).max(1),
        });
        contact_top = top;
    }
    // The gap to the part: zero when the interface or the raft contact distance is zero, else the contact
    // distance in whole layers (unless the support layers have their own height).
    let contact_distance = cfg.raw_number("raft_contact_distance", 0.1).max(0.0);
    let independent = cfg.independent_support_layer_height();
    let gap = if contact_distance == 0.0 || cfg.support.top_z_distance == 0.0 {
        0.0
    } else if independent {
        contact_distance
    } else {
        (contact_distance / lh + 1e-4).round() * lh
    };
    Some(Plan {
        layers,
        offset: contact_top + gap,
        base_count,
        interface_count,
        expansion: cfg.raw_number("raft_expansion", 1.5).max(0.0),
        first_expansion: cfg.raw_number("raft_first_layer_expansion", 2.0).max(0.0),
        first_density: (cfg.raw_number("raft_first_layer_density", 90.0) / 100.0).clamp(0.01, 1.0),
        first_layer: Vec::new(),
        stretched: None,
    })
}

impl Plan {
    /// Number of raft layers.
    #[allow(clippy::cast_possible_truncation, reason = "a small layer count")]
    pub(crate) fn count(&self) -> u32 {
        self.layers.len() as u32
    }

    /// The area of a raft layer from the part's first layer: the first layer grown by `raft_expansion`
    /// is the contact layer, the interface and base layers are half a millimeter wider, and the first
    /// layer wider still by `raft_first_layer_expansion` less that half millimeter.
    pub(crate) fn area(&self, kind: Kind, first_layer: &Shapes) -> Shapes {
        self.area_with(kind, first_layer, &Vec::new())
    }

    /// [`Plan::area`] with the support columns that stand on the raft: the first and base layers cover them
    /// too (Orca's `generate_raft_base`: the base is the columns and the interface grown half a millimeter, the
    /// first layer that widened by `raft_first_layer_expansion` less the half millimeter).
    pub(crate) fn area_with(&self, kind: Kind, first_layer: &Shapes, columns: &Shapes) -> Shapes {
        if first_layer.is_empty() {
            return Vec::new();
        }
        let grow = |s: &Shapes, d: f64| {
            if d > 0.0 {
                perimeters::offset_square(s, mm(d))
            } else {
                s.clone()
            }
        };
        let (contact, cells) = if let Some((printed, cells)) = &self.stretched {
            (printed.clone(), cells.clone())
        } else {
            let c = grow(first_layer, self.expansion);
            (c.clone(), c)
        };
        if self.layers.len() == 1 {
            return contact;
        }
        // Orca's `generate_raft_base` grows the contact layer's cells half a millimeter for the layers below.
        let interface = grow(&cells, 0.5);
        let base = if columns.is_empty() {
            interface.clone()
        } else {
            perimeters::union_all(&[&interface, columns])
        };
        match kind {
            Kind::Contact => contact,
            Kind::Interface => interface,
            Kind::Base => base,
            Kind::First => grow(&base, (self.first_expansion - 0.5).max(0.0)),
        }
    }

    /// Stretches the contact area (the first layer grown by `raft_expansion`) to the support grid with
    /// `to_grid`, as Orca's `generate_top_contacts` does for the raft's contact layer (layer 0 of the
    /// object, `SupportGridPattern::extract_support` with `expansion_to_slice`). On parts wider than a few
    /// grid cells this makes the raft up to a cell wider than the expansion alone.
    pub(crate) fn stretch(&mut self, to_grid: impl Fn(&Shapes) -> Option<(Shapes, Shapes)>) {
        if self.first_layer.is_empty() {
            return;
        }
        let grown = if self.expansion > 0.0 {
            perimeters::offset_square(&self.first_layer, mm(self.expansion))
        } else {
            self.first_layer.clone()
        };
        self.stretched = to_grid(&grown).filter(|s| !s.0.is_empty() && !s.1.is_empty());
    }

    /// The angles of the lines, degrees: of the first layer, the base layers and the interface layers
    /// before the turn of 45 degrees either way (`SupportParameters`).
    fn angles(&self, support_angle: f64) -> (f64, f64, f64) {
        let (base, interface) = (support_angle, support_angle + 90.0);
        if self.base_count > 1 {
            let turn = if self.interface_count.is_multiple_of(2) {
                90.0
            } else {
                0.0
            };
            (interface, base, interface + turn)
        } else if self.base_count == 1 || self.interface_count > 1 {
            (base, base, interface + 90.0)
        } else {
            (90.0, base, 90.0)
        }
    }
}

/// The paths of raft layer `k` over `first_layer`, the part's first layer, as a layer of output.
/// `first_cfg` is `cfg` with the first layer's line widths. `center` anchors the line rows; `tool`
/// is the filament that prints supports.
#[allow(
    clippy::too_many_arguments,
    reason = "the plan, one layer's inputs and the outputs"
)]
pub(crate) fn layer_paths(
    plan: &Plan,
    k: usize,
    first_layer: &Shapes,
    cfg: &PrintConfig,
    first_cfg: &PrintConfig,
    center: [f64; 2],
    tool: u8,
    skirt: Vec<Vec<IntPoint<i32>>>,
    (trees, columns, pad): (&Shapes, &Shapes, Vec<Vec<Point>>),
) -> LayerPaths {
    let Some(layer) = plan.layers.get(k).copied() else {
        return LayerPaths::default();
    };
    #[allow(
        clippy::cast_possible_truncation,
        reason = "layer indexes and sizes are small"
    )]
    let mut out = LayerPaths {
        index: k as u32,
        local: k as u32,
        z: layer.top as f32,
        height: layer.height as f32,
        ..LayerPaths::default()
    };
    let mut area = plan.area_with(layer.kind, first_layer, columns);
    // Organic branches through the raft: on the first layer they join the flange, above it the raft prints
    // around them and they print as branch walls.
    if !trees.is_empty() {
        area = if layer.kind == Kind::First {
            perimeters::union_all(&[&area, trees])
        } else {
            perimeters::difference(&area, trees)
        };
    }
    let use_cfg = if layer.kind == Kind::First || plan.layers.len() == 1 {
        first_cfg
    } else {
        cfg
    };
    let w = use_cfg.support_width();
    // The spacing of beads of this layer's own height, and the constant one of the support's layers.
    let rounded = |h: f64| (w - h * (1.0 - std::f64::consts::FRAC_PI_4)).max(w * 0.5);
    let spacing = rounded(cfg.layer_height);
    let (first_angle, base_angle, interface_angle) = plan.angles(0.0);
    let turn = |id: usize| interface_angle + if id % 2 == 1 { -45.0 } else { 45.0 };
    let mut work = ToolWork {
        tool,
        ..ToolWork::default()
    };
    // The lines run out to the edge of the area (Orca extends them to it), so they are cut from the area
    // grown by the half width `support_lines` takes off again.
    let lines = |region: &Shapes, pitch: f64, angle: f64| {
        let wide = perimeters::offset(region, mm(w / 2.0));
        let rows = crate::patterns::support_lines(&wide, w, pitch, angle, false, 0.0, center);
        join_rows(rows, region, 2.5 * pitch)
    };
    match layer.kind {
        Kind::First => {
            // A dense flange inside one loop that follows the edge of the area.
            let flange_spacing = rounded(layer.height);
            let inner = perimeters::offset(&area, -mm(0.4 * flange_spacing));
            work.support = lines(&inner, flange_spacing / plan.first_density, first_angle);
            for sh in &area {
                for ring in sh {
                    let mut pts: Vec<Point> = ring.iter().map(|p| Point::new(p.x, p.y)).collect();
                    if let Some(f) = pts.first().copied() {
                        pts.push(f);
                    }
                    work.support.insert(0, pts);
                }
            }
        }
        Kind::Base => {
            work.support = lines(&area, cfg.support.base_spacing + spacing, base_angle);
        }
        Kind::Interface | Kind::Contact => {
            // The support columns pass through the raft's interface layers as base lines (Orca keeps them in
            // the interface layers' `contact_polygons`).
            if layer.kind == Kind::Interface && !columns.is_empty() {
                let cols = perimeters::difference(columns, &area);
                work.support = lines(&cols, cfg.support.base_spacing + spacing, base_angle);
            }
            // The interface is spaced by `support_interface_spacing` (a solid layer when it is zero).
            // A one-layer raft is only its contact layer, which Orca prints at raft_interface_angle too (90
            // degrees and the turn of 45 for interface 0: 135), not at the bare 90.
            let angle = turn(layer.interface_id);
            work.support_interface = lines(&area, cfg.support.interface_spacing + spacing, angle);
        }
    }
    if !trees.is_empty() && layer.kind != Kind::First {
        let w = use_cfg.support_width();
        work.support.extend(crate::treepaths::branch_walls(
            trees,
            w,
            rounded(cfg.layer_height),
            0.25 * 25.0 * std::f64::consts::PI,
        ));
    }
    work.support.extend(pad);
    work.skirt = skirt;
    // The raft's own first layer is the print's first layer, so the layer is planned as one with no raft under it.
    let mut planned = use_cfg.clone();
    planned.raw.insert("raft_layers".into(), serde_json::json!(0));
    #[allow(clippy::cast_possible_truncation, reason = "a raft has a handful of layers")]
    let layer_id = k as u32;
    crate::paths::plan_layer(
        &mut out,
        &[work],
        &planned,
        layer_id,
        (&[], layer.top, None),
        None,
        &[],
    );
    out
}

/// Rows that follow each other along an edge become one zigzag: a row joins the chain that ends nearest its
/// start, within `max_link` mm, when the way between lies inside the area.
fn join_rows(rows: Vec<Vec<Point>>, area: &Shapes, max_link: f64) -> Vec<Vec<Point>> {
    let support = crate::overhang::Support::new(area);
    // Each chain with where its last row began.
    let mut chains: Vec<(Vec<Point>, Point)> = Vec::new();
    for row in rows {
        let (Some(&first), Some(&row_end)) = (row.first(), row.last()) else {
            continue;
        };
        let mut best: Option<(usize, f64)> = None;
        for (k, (chain, start)) in chains.iter().enumerate() {
            let Some(&end) = chain.last() else { continue };
            let d = end.dist_mm(first);
            if d > max_link || best.is_some_and(|(_, bd)| d >= bd) {
                continue;
            }
            // The way between two rows follows the edge, so the point halfway lies on it: look a little
            // toward the middle of the two rows to see whether the area is there.
            let mid = Point::new(i32::midpoint(end.x, first.x), i32::midpoint(end.y, first.y));
            let across = Point::new(
                i32::midpoint(start.x, row_end.x),
                i32::midpoint(start.y, row_end.y),
            );
            let (dx, dy) = (f64::from(across.x - mid.x), f64::from(across.y - mid.y));
            let len = dx.m_hypot(dy).max(1.0);
            let nudge = 0.1 * crate::geom::SCALE;
            #[allow(clippy::cast_possible_truncation, reason = "a nudge of a tenth of a mm")]
            let probe = i_overlay::i_float::int::point::IntPoint::new(
                mid.x + (dx / len * nudge).round() as i32,
                mid.y + (dy / len * nudge).round() as i32,
            );
            if support.inside(probe) {
                best = Some((k, d));
            }
        }
        match best {
            Some((k, _)) => {
                if let Some((chain, start)) = chains.get_mut(k) {
                    chain.extend(row);
                    *start = first;
                }
            }
            None => chains.push((row, first)),
        }
    }
    chains.into_iter().map(|(c, _)| c).collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn cfg(layers: u32) -> PrintConfig {
        let mut c = PrintConfig::default();
        c.raw.insert("raft_layers".into(), serde_json::json!(layers));
        c.layer_height = 0.2;
        c.initial_layer_print_height = 0.2;
        c.nozzle_diameter = 0.4;
        c
    }

    #[test]
    fn the_raft_has_a_first_layer_base_interface_and_contact_layers() {
        assert!(plan(&cfg(0)).is_none());
        let p = plan(&cfg(5)).unwrap();
        let kinds: Vec<Kind> = p.layers.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            [
                Kind::First,
                Kind::Base,
                Kind::Interface,
                Kind::Interface,
                Kind::Contact
            ]
        );
        // Layers above the first are 0.3 mm thick on a 0.4 mm nozzle.
        assert!((p.layers[1].height - 0.3).abs() < 1e-9);
        assert!((p.layers[4].top - (0.2 + 4.0 * 0.3)).abs() < 1e-9);
        // The part rises by the raft and the contact distance: exactly with support on layers of its own
        // height (Orca's default), in whole layers without (0.1 mm becomes one layer).
        assert!((p.offset - (1.4 + 0.1)).abs() < 1e-9, "{}", p.offset);
        let mut synced = cfg(5);
        synced.raw.insert(
            "independent_support_layer_height".into(),
            serde_json::json!(false),
        );
        let q = plan(&synced).unwrap();
        assert!((q.offset - (1.4 + 0.2)).abs() < 1e-9, "{}", q.offset);
        assert_eq!(plan(&cfg(1)).unwrap().layers.len(), 1);
        assert_eq!(plan(&cfg(2)).unwrap().layers.len(), 2);
    }

    #[test]
    fn a_zero_contact_distance_leaves_no_gap() {
        let mut c = cfg(3);
        c.raw.insert("raft_contact_distance".into(), serde_json::json!(0));
        let p = plan(&c).unwrap();
        assert!((p.offset - p.layers.last().unwrap().top).abs() < 1e-9);
    }

    #[test]
    fn the_layers_widen_from_the_contact_layer_to_the_first_layer() {
        let p = plan(&cfg(4)).unwrap();
        let part: Shapes = vec![vec![vec![
            IntPoint::new(0, 0),
            IntPoint::new(mm(20.0), 0),
            IntPoint::new(mm(20.0), mm(20.0)),
            IntPoint::new(0, mm(20.0)),
        ]]];
        let width =
            |s: &Shapes| perimeters::bounds(s).map_or(0.0, |b| f64::from(b[2] - b[0]) / crate::geom::SCALE);
        let (c, i, f) = (
            width(&p.area(Kind::Contact, &part)),
            width(&p.area(Kind::Interface, &part)),
            width(&p.area(Kind::First, &part)),
        );
        assert!((c - 23.0).abs() < 0.1, "{c}");
        assert!((i - 24.0).abs() < 0.1, "{i}");
        assert!((f - 27.0).abs() < 0.1, "{f}");
    }

    #[test]
    fn interface_lines_turn_from_layer_to_layer() {
        let p = plan(&cfg(5)).unwrap();
        let (_, _, interface) = p.angles(0.0);
        // Three interface layers (two and the contact layer): odd, so no extra turn.
        assert!((interface - 90.0).abs() < 1e-9);
    }
}
