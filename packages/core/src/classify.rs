// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What each part of a layer's infill area is: top surface, bottom surface, internal solid shell or
//! sparse infill. Orca's order is `PrintObject::detect_surfaces_type` (top and bottom as the layer's
//! outline less its neighbor's), `discover_vertical_shells` or `discover_horizontal_shells` (the solid
//! shells under and over them, see `shells.rs`), then `LayerRegion::process_external_surfaces`
//! (the surfaces grow into the shell and sparse areas beside them, and small sparse pockets turn
//! solid). The areas are polygons, so the fills that follow work on the real surface shape.

use crate::config::PrintConfig;
use crate::geom::mm;
use crate::perimeters::{self, Shapes};

/// Everything the classification reads about one region of one layer.
pub(crate) struct In<'a> {
    pub(crate) cfg: &'a PrintConfig,
    pub(crate) layer: u32,
    pub(crate) count: u32,
    /// The region's outline and its infill area (inside the walls).
    pub(crate) region: &'a Shapes,
    pub(crate) inner: &'a Shapes,
    /// The outline of any layer by index, `None` past the ends of the plate.
    pub(crate) slice: &'a dyn Fn(i64) -> Option<Shapes>,
    /// The infill area of any layer by index.
    pub(crate) inner_of: &'a dyn Fn(i64) -> Option<Shapes>,
    pub(crate) top_layers: u32,
    pub(crate) bottom_layers: u32,
    pub(crate) wall_loops: u32,
    /// Per-layer results shared between the layers around, when the neighbors do not depend on this layer.
    pub(crate) cache: Option<&'a crate::shells::Cache>,
    /// Fingerprint of the settings the neighbors' infill areas come from.
    pub(crate) tag: u64,
    /// With `interface_shells`, `slice` gives the region's own filament; this is everything on the layer
    /// below, so a bottom resting on another filament prints as a bottom surface, not a bridge.
    pub(crate) whole_lower: Option<Shapes>,
}

/// The four kinds of infill area, disjoint and inside the infill area.
#[derive(Debug, Default, Clone)]
pub(crate) struct Classes {
    pub(crate) top: Shapes,
    pub(crate) bottom: Shapes,
    pub(crate) shell: Shapes,
    pub(crate) sparse: Shapes,
    /// Bottom surfaces over air above the first layer, grown into the areas beside them, with their strand direction.
    pub(crate) bridges: Vec<crate::bridging::Bridged>,
}

fn sub(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        a.clone()
    } else {
        perimeters::difference(a, b)
    }
}

fn union(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() {
        b.clone()
    } else if b.is_empty() {
        a.clone()
    } else {
        perimeters::union_all(&[a, b])
    }
}

fn meet(a: &Shapes, b: &Shapes) -> Shapes {
    if a.is_empty() || b.is_empty() {
        Vec::new()
    } else {
        perimeters::intersection(a, b)
    }
}

/// `a` meeting `b`, reading only the pieces of `a` whose bounds reach `b`'s.
fn meet_near(a: &Shapes, b: &Shapes) -> Shapes {
    let reach = perimeters::bounds(b);
    let near: Shapes = a
        .iter()
        .filter(|s| perimeters::overlaps(perimeters::bounds(std::slice::from_ref(*s)), reach))
        .cloned()
        .collect();
    meet(&near, b)
}

/// `src` grown by `d` mm into the pieces of `zone` it touches (Orca's wave propagation, here the
/// offset cut by the zone), as the part of the zone the surface now covers.
fn grown_into(src: &Shapes, zone: &Shapes, d: f64, tiny: f64) -> Shapes {
    if src.is_empty() || zone.is_empty() || d <= 0.0 {
        return Vec::new();
    }
    let seed = perimeters::offset_round(src, mm(tiny));
    let reach = perimeters::offset_round(src, mm(d));
    // A piece is touched when some seed shape meets it; shapes whose bounds miss the piece cannot.
    let seed_bounds: Vec<Option<[i32; 4]>> = seed
        .iter()
        .map(|s| perimeters::bounds(std::slice::from_ref(s)))
        .collect();
    let touched: Shapes = zone
        .iter()
        .filter(|piece| {
            let b = perimeters::bounds(std::slice::from_ref(*piece));
            let near: Shapes = seed
                .iter()
                .zip(&seed_bounds)
                .filter(|(_, sb)| perimeters::overlaps(b, **sb))
                .map(|(s, _)| s.clone())
                .collect();
            !meet(&near, &vec![(*piece).clone()]).is_empty()
        })
        .cloned()
        .collect();
    meet(&reach, &touched)
}

/// The classification of one region of one layer.
pub(crate) fn classify(i: &In<'_>) -> Classes {
    let cfg = i.cfg;
    let inner = i.inner;
    if inner.is_empty() {
        return Classes::default();
    }
    let layer = i64::from(i.layer);
    let w_ext = cfg.outer_wall_width();
    let w_in = cfg.inner_wall_width();
    let sp_ext = cfg.spacing_for(w_ext);
    let sp_in = cfg.spacing_for(w_in);
    let w_solid = cfg.solid_infill_width();
    let sp_solid = cfg.spacing_for(w_solid);
    let opening = 0.1 * w_ext;

    // detect_surfaces_type: what the neighbor does not cover.
    let upper = if i.layer + 1 < i.count {
        (i.slice)(layer + 1)
    } else {
        None
    };
    let lower = if i.layer > 0 { (i.slice)(layer - 1) } else { None };
    // A region that is the layer's whole outline has the same free surfaces the shell rule works out for
    // the layers around, so they are shared.
    let here = i
        .cache
        .filter(|_| i.top_layers > 0 || i.bottom_layers > 0)
        .and_then(|c| (i.slice)(layer).map(|h| (c, h)));
    let empty = Vec::new();
    let free = |toward: i64, other: Option<&Shapes>| -> Shapes {
        let other = other.unwrap_or(&empty);
        let work = || crate::shells::opened(&sub(i.region, other), opening);
        match &here {
            Some((c, h)) if h == i.region => c.free(layer, toward, opening, work),
            // A region of a layer of several is uncovered where it meets the layer's own uncovered part, which
            // is mostly small or empty, so the region does not cut the whole neighbor again.
            Some((c, h)) => {
                let cut = c.cut(layer, toward, || perimeters::difference(h, other));
                crate::shells::opened(&meet_near(i.region, &cut), opening)
            }
            None => work(),
        }
    };
    let mut top = if i.top_layers == 0 {
        Vec::new()
    } else if i.layer + 1 >= i.count {
        inner.clone()
    } else {
        meet(inner, &free(1, upper.as_ref()))
    };
    let bottom = if i.bottom_layers == 0 {
        Vec::new()
    } else if i.layer == 0 {
        inner.clone()
    } else {
        meet(inner, &free(-1, lower.as_ref()))
    };
    top = sub(&top, &bottom);

    // discover_vertical_shells or discover_horizontal_shells.
    let solid = if i.top_layers == 0 && i.bottom_layers == 0 {
        Vec::new()
    } else {
        match crate::shells::mode_of(cfg) {
            None => crate::shells::solid_area(&crate::shells::Input {
                cache: i.cache,
                inner,
                slice: i.slice,
                layer,
                top_layers: i64::from(i.top_layers),
                bottom_layers: i64::from(i.bottom_layers),
                spacing: sp_solid,
                wall_offset: f64::midpoint(w_ext, sp_ext) + f64::from(i.wall_loops.saturating_sub(1)) * sp_in,
                opening,
            }),
            Some(mode) => crate::shells::horizontal_area(&crate::shells::HInput {
                cache: i.cache,
                tag: i.tag,
                slice: i.slice,
                inner: i.inner_of,
                layer,
                top_layers: i64::from(i.top_layers),
                bottom_layers: i64::from(i.bottom_layers),
                mode,
                no_sparse: cfg.sparse_infill_density <= 0.0,
                wall_width: w_ext,
                solid_width: w_solid,
                opening,
            }),
        }
    };
    let surfaces = union(&top, &bottom);
    let mut shell = sub(&meet(inner, &solid), &surfaces);
    // prepare_fill_surfaces: sparse infill at 100 percent is internal solid infill.
    if cfg.sparse_infill_density >= 100.0 - 1e-6 {
        shell = sub(inner, &surfaces);
    }
    let mut sparse = sub(&sub(inner, &surfaces), &shell);

    // process_external_surfaces: bottoms, then tops, grow into the shell and sparse areas.
    let shell_width = if i.wall_loops > 0 {
        0.5 * w_ext + sp_ext + f64::from(i.wall_loops - 1) * sp_in
    } else {
        0.001
    };
    let into_shell = shell_width * std::f64::consts::SQRT_2;
    let into_sparse = if i.wall_loops > 0 { sp_in } else { 0.001 };
    let closing = 0.55 * 0.65 * 1.05 * sp_solid;
    let tiny = |full: f64| (0.25 * full).min(0.05);
    // Bottom surfaces over air (the layer above the first): bridges, which grow first.
    let mut bridges: Vec<crate::bridging::Bridged> = Vec::new();
    let mut bottom = bottom;
    // Orca's `detect_surfaces_type` with `interface_shells`: bottoms that rest on another filament are plain bottoms.
    let mut resting = Vec::new();
    if i.layer > 0
        && let Some(below) = &i.whole_lower
        && !bottom.is_empty()
    {
        resting = meet(&bottom, below);
        bottom = sub(&bottom, below);
    }
    if i.layer > 0 && !bottom.is_empty() {
        let e = crate::bridging::external(&bottom, &shell, &sparse, &top, into_shell, into_sparse, closing);
        shell = e.shell;
        sparse = e.sparse;
        top = e.top;
        bridges = e.bridges;
    }
    if i.layer > 0 {
        bottom = resting;
    }
    let expand = |src: &Shapes, shell: &mut Shapes, sparse: &mut Shapes| -> Shapes {
        if src.is_empty() {
            return Vec::new();
        }
        let a = grown_into(src, shell, into_shell, tiny(into_shell));
        let b = grown_into(src, sparse, into_sparse, tiny(into_sparse));
        let merged = union(&union(src, &a), &b);
        let merged = perimeters::offset(&perimeters::offset(&merged, mm(closing)), -mm(closing));
        // The closed surface stays inside the infill area.
        let merged = meet(&merged, inner);
        *shell = sub(shell, &merged);
        *sparse = sub(sparse, &merged);
        merged
    };
    let bottom = expand(&bottom, &mut shell, &mut sparse);
    let top = expand(&top, &mut shell, &mut sparse);
    let top = sub(&top, &bottom);

    // Sparse pockets smaller than `minimum_sparse_infill_area` are printed solid.
    if cfg.sparse_infill_density > 0.0 && !sparse.is_empty() {
        let min_area = crate::motion::raw_f(cfg, "minimum_sparse_infill_area").unwrap_or(15.0);
        let (small, big): (Shapes, Shapes) = sparse
            .into_iter()
            .partition(|s| crate::shells::area_mm2(std::slice::from_ref(s)) <= min_area);
        shell = union(&shell, &small);
        sparse = big;
    }
    Classes {
        top,
        bottom,
        shell,
        sparse,
        bridges,
    }
}
