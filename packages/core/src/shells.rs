// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ensure vertical shell thickness (`ensure_vertical_shell_thickness` = `ensure_all`): under a top
//! surface and over a bottom surface, the solid infill reaches as far sideways as the surface itself
//! does within the shell layers, so a sloped wall keeps its full shell thickness instead of the thinner
//! one the inner outlines of the layers above and below would leave.
//!
//! The solid area of a layer is the union of the top surfaces of the layers above (within the top
//! shell) and the bottom surfaces of the layers below (within the bottom shell), the infill area the
//! usual coverage rule already makes solid, cleaned up: pieces thinner than a line are dropped, and
//! gaps narrower than 1.2 lines are closed, since neither can be filled as sparse or solid infill.

use crate::config::PrintConfig;
use crate::geom::mm;
use crate::par::Init as _;
use crate::perimeters::{self, Shapes};

/// Per-layer results the shell rules would otherwise recompute for every neighbor: each layer is a
/// neighbor of up to `top + bottom` others, and the values depend on that layer alone.
type Memo<K, V> = crate::par::Memo<K, V>;
type Shared<T> = std::sync::Arc<T>;
type Steps = Vec<Option<Shapes>>;
/// The walls of a layer's whole outline and its infill area.
pub(crate) type Walls = (Vec<perimeters::IslandWalls>, Shapes);
type WalkKey = ((i64, i64, i64), u64);
/// Layer, top and bottom shell layers, then the bits of the solid spacing, wall offset and opening.
type AroundKey = (i64, i64, i64, u64, u64, u64);

#[derive(Default)]
pub(crate) struct Cache {
    walks: Memo<WalkKey, Shared<Steps>>,
    bridged: Memo<(i64, u64), Shared<Vec<crate::bridging::Bridged>>>,
    cands: Memo<(i64, u64), Shared<Vec<Shapes>>>,
    facts: Memo<(i64, u64), Option<Shared<crate::bridging::Facts>>>,
    free: Memo<(i64, i64, i32), Shared<Shapes>>,
    cut: Memo<(i64, i64), Shared<Shapes>>,
    grown: Memo<(i64, i64, i32, i32), Option<Shared<Shapes>>>,
    inset: Memo<(i64, i32), Shared<Shapes>>,
    inner: Memo<(i64, u64), Option<Shared<Walls>>>,
    around: Memo<AroundKey, Shared<Around>>,
    regions: Memo<(i64, u64), Shared<Vec<Option<crate::session::RegionPrep>>>>,
}

impl Clone for Cache {
    /// A copy starts empty: the entries belong to the session they were worked out for.
    fn clone(&self) -> Self {
        Self::default()
    }
}

impl std::fmt::Debug for Cache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cache")
    }
}

impl Cache {
    /// The part of layer `m`'s outline that layer `m + toward` does not cover, opened by `opening` mm.
    pub(crate) fn free(&self, m: i64, toward: i64, opening: f64, work: impl FnOnce() -> Shapes) -> Shapes {
        let key = (m, toward, mm(opening));
        (*self.free.get_or(key, || std::sync::Arc::new(work()))).clone()
    }

    /// The part of layer `m`'s outline that layer `m + toward` does not cover, before the opening. A region of
    /// the layer is uncovered where it meets this, so the layer's regions cut the neighbor once between them.
    pub(crate) fn cut(&self, m: i64, toward: i64, work: impl FnOnce() -> Shapes) -> Shared<Shapes> {
        self.cut.get_or((m, toward), || std::sync::Arc::new(work()))
    }

    /// [`Self::free`] grown by `grow` internal units, `None` where nothing is free.
    fn grown(
        &self,
        m: i64,
        toward: i64,
        opening: f64,
        grow: i32,
        work: impl FnOnce() -> Option<Shapes>,
    ) -> Option<Shared<Shapes>> {
        let key = (m, toward, mm(opening), grow);
        self.grown.get_or(key, || work().map(std::sync::Arc::new))
    }

    /// Layer `m`'s outline moved by `delta` internal units.
    fn inset(&self, m: i64, delta: i32, work: impl FnOnce() -> Shapes) -> Shapes {
        let key = (m, delta);
        (*self.inset.get_or(key, || std::sync::Arc::new(work()))).clone()
    }

    /// What the shell rule reads from the layers around layer `key.0` (see `Around`).
    fn around(&self, key: AroundKey, work: impl FnOnce() -> Around) -> Shared<Around> {
        self.around.get_or(key, || std::sync::Arc::new(work()))
    }

    /// The horizontal shell walk from a surface layer (see `horizontal_area`).
    fn walk(&self, key: (i64, i64, i64), tag: u64, work: impl FnOnce() -> Steps) -> Shared<Steps> {
        let key = (key, tag);
        self.walks.get_or(key, || std::sync::Arc::new(work()))
    }

    /// The bridging areas of layer `m`.
    pub(crate) fn bridged(
        &self,
        m: i64,
        tag: u64,
        work: impl FnOnce() -> Vec<crate::bridging::Bridged>,
    ) -> std::sync::Arc<Vec<crate::bridging::Bridged>> {
        let key = (m, tag);
        self.bridged.get_or(key, || std::sync::Arc::new(work()))
    }

    /// The bridge candidates of layer `m`.
    pub(crate) fn cands(
        &self,
        m: i64,
        tag: u64,
        work: impl FnOnce() -> Vec<Shapes>,
    ) -> std::sync::Arc<Vec<Shapes>> {
        let key = (m, tag);
        self.cands.get_or(key, || std::sync::Arc::new(work()))
    }

    /// The walls, infill area and surface classes of the regions of layer `m` (a layer of several regions), for the
    /// settings fingerprinted by `tag`.
    pub(crate) fn regions(
        &self,
        m: i64,
        tag: u64,
        work: impl FnOnce() -> Vec<Option<crate::session::RegionPrep>>,
    ) -> Shared<Vec<Option<crate::session::RegionPrep>>> {
        self.regions.get_or((m, tag), || std::sync::Arc::new(work()))
    }

    /// The bridging facts of layer `m` for the settings fingerprinted by `tag`.
    pub(crate) fn facts(
        &self,
        m: i64,
        tag: u64,
        work: impl FnOnce() -> Option<crate::bridging::Facts>,
    ) -> Option<std::sync::Arc<crate::bridging::Facts>> {
        let key = (m, tag);
        self.facts.get_or(key, || work().map(std::sync::Arc::new))
    }

    /// The infill area of layer `m`, from the walls `work` gives for the settings fingerprinted by `tag`.
    pub(crate) fn inner(&self, m: i64, tag: u64, work: impl FnOnce() -> Option<Walls>) -> Option<Shapes> {
        self.walls(m, tag, work).map(|a| a.1.clone())
    }

    /// The walls of layer `m`'s whole outline and its infill area, worked out by `work` for the settings
    /// fingerprinted by `tag`. The layer itself reads them too when its region is the whole outline.
    pub(crate) fn walls(
        &self,
        m: i64,
        tag: u64,
        work: impl FnOnce() -> Option<Walls>,
    ) -> Option<Shared<Walls>> {
        let key = (m, tag);
        self.inner.get_or(key, || work().map(std::sync::Arc::new))
    }
}

/// Everything the rule reads about one region of one layer.
pub(crate) struct Input<'a> {
    pub(crate) cache: Option<&'a Cache>,
    /// The region's infill area (inside the walls).
    pub(crate) inner: &'a Shapes,
    /// The outline of any layer by index, `None` past the ends of the plate.
    pub(crate) slice: &'a dyn Fn(i64) -> Option<Shapes>,
    pub(crate) layer: i64,
    pub(crate) top_layers: i64,
    pub(crate) bottom_layers: i64,
    /// Solid infill line spacing, mm.
    pub(crate) spacing: f64,
    /// Distance from the outline to the infill area, mm.
    pub(crate) wall_offset: f64,
    /// Surfaces are opened by this, mm: slivers thinner than twice it are not surfaces (a tenth of
    /// the outer wall width).
    pub(crate) opening: f64,
}

/// What the shell rule reads from the layers around one layer. It does not depend on the region, so a
/// layer with several regions (filaments, modifiers) works it out once.
pub(crate) struct Around {
    /// The neighbors' surfaces within the shell layers, grown a little and merged.
    shell: Shapes,
    /// This layer's infill outline less what the neighbors' infill outlines leave open, before it is cut
    /// to a region: the coverage rule's solid area. None where a neighbor is past the plate's end.
    classic: Option<Shapes>,
    /// The outline the layers below and above share, read only for small pieces.
    object: std::sync::OnceLock<Shapes>,
}

fn around(i: &Input<'_>) -> Around {
    let tiny = mm(0.05 * i.spacing);
    let empty: Shapes = Vec::new();
    let mut shell: Shapes = Vec::new();
    let inset = -mm(i.wall_offset);
    // The infill area of this layer and its neighbors are all worked out the same way, so the two
    // cancel where the outlines agree.
    let inset_of = |m: i64, s: &Shapes| -> Shapes {
        match i.cache {
            Some(c) => c.inset(m, inset, || perimeters::offset(s, inset)),
            None => perimeters::offset(s, inset),
        }
    };
    let free_of = |m: i64, toward: i64, here: &Shapes, other: &Shapes| -> Shapes {
        match i.cache {
            Some(c) => c.free(m, toward, i.opening, || {
                opened(
                    &c.cut(m, toward, || perimeters::difference(here, other)),
                    i.opening,
                )
            }),
            None => opened(&perimeters::difference(here, other), i.opening),
        }
    };
    let mine = (i.slice)(i.layer).map(|s| inset_of(i.layer, &s));
    let mut holes: Option<Shapes> = mine.clone();
    let mut consider = |m: i64, toward: i64| -> bool {
        // A layer past the plate's end shows the whole layer beside it as a surface.
        let Some(here) = (i.slice)(m) else {
            holes = None;
            return false;
        };
        // The grown surface of layer `m` is the same for every layer whose shell reaches it.
        let grow = || -> Option<Shapes> {
            let other = (i.slice)(m + toward);
            let surface = free_of(m, toward, &here, other.as_ref().unwrap_or(&empty));
            (!surface.is_empty()).then(|| perimeters::offset(&surface, tiny))
        };
        let grown = match i.cache {
            Some(c) => c.grown(m, toward, i.opening, tiny, grow),
            None => grow().map(std::sync::Arc::new),
        };
        if let Some(grown) = grown {
            shell = perimeters::union_all(&[&shell, &grown]);
        }
        if let Some(h) = holes.take() {
            holes = Some(perimeters::intersection(&h, &inset_of(m, &here)));
        }
        true
    };
    // The surface layer is one of the shell layers, so the shell reaches `layers - 1` layers away.
    for k in 1..i.top_layers {
        if !consider(i.layer + k, 1) {
            break;
        }
    }
    for k in 1..i.bottom_layers {
        if !consider(i.layer - k, -1) {
            break;
        }
    }
    // One shell layer asks for no neighbor, so the layer's own surface is anchored under (or over) the
    // walls of the layer beside it by one wall spacing.
    for (layers, toward) in [(i.top_layers, 1), (i.bottom_layers, -1)] {
        if layers > 1 {
            continue;
        }
        let Some(beside) = (i.slice)(i.layer + toward) else {
            continue;
        };
        let Some(here) = (i.slice)(i.layer) else { continue };
        let surface = free_of(i.layer, toward, &here, &beside);
        if !surface.is_empty() {
            let anchor = perimeters::intersection(&perimeters::offset(&surface, mm(i.spacing)), &beside);
            shell = perimeters::union_all(&[&shell, &anchor]);
        }
    }
    // Where a neighbor layer is missing (the plate's end) the holes are gone and everything is solid.
    let classic = match (&holes, &mine) {
        (Some(h), Some(m)) => Some(perimeters::difference(m, h)),
        _ => None,
    };
    Around {
        shell,
        classic,
        object: std::sync::OnceLock::new(),
    }
}

/// The infill area that must be solid beyond what the coverage rule already makes solid, and that
/// rule's own area, cleaned up together. Empty when the region needs nothing.
pub(crate) fn solid_area(i: &Input<'_>) -> Shapes {
    if i.inner.is_empty() {
        return Vec::new();
    }
    let around = match i.cache {
        Some(c) => {
            let key = (
                i.layer,
                i.top_layers,
                i.bottom_layers,
                i.spacing.to_bits(),
                i.wall_offset.to_bits(),
                i.opening.to_bits(),
            );
            c.around(key, || around(i))
        }
        None => std::sync::Arc::new(around(i)),
    };
    let under_shell = perimeters::intersection(&around.shell, i.inner);
    let classic = match &around.classic {
        Some(d) => perimeters::intersection(d, i.inner),
        None => i.inner.clone(),
    };
    let total = perimeters::union_all(&[&under_shell, &classic]);
    if total.is_empty() {
        return total;
    }
    let s = 1.05 * i.spacing;
    let open = mm(0.5 * 0.65 * s);
    let close = mm(0.5 * 1.2 * s);
    let overlap = mm(0.2 * s);
    let opened = perimeters::offset(&total, -open);
    let closed = perimeters::offset(&opened, open + close);
    let regular = perimeters::offset(&closed, -(close - overlap));
    // Small drops on smooth parts of the model are dropped, unless they fill a whole internal piece.
    let object = || {
        around.object.once(|| {
            let below = (i.slice)(i.layer - 1).unwrap_or_default();
            let above = (i.slice)(i.layer + 1).unwrap_or_default();
            perimeters::intersection(&below, &above)
        })
    };
    // The infill pieces' bounds, when no two of them meet: then a piece the grown drop does not reach
    // comes out of the difference below as itself, so only the pieces it reaches need working out.
    let inner_bounds: Option<Vec<Option<[i32; 4]>>> = {
        let b: Vec<Option<[i32; 4]>> = i
            .inner
            .iter()
            .map(|s| perimeters::bounds(std::slice::from_ref(s)))
            .collect();
        let apart = b
            .iter()
            .enumerate()
            .all(|(k, x)| x.is_some() && b.iter().skip(k + 1).all(|y| !perimeters::overlaps(*x, *y)));
        apart.then_some(b)
    };
    let keep: Shapes = regular
        .into_iter()
        .filter(|piece| {
            let one: Shapes = vec![piece.clone()];
            let area = area_mm2(&one);
            // Whether the piece lies inside the shared outline: only the outline's pieces near it can say.
            let inside_object = || {
                let near = perimeters::bounds(&one);
                let object: Shapes = object()
                    .iter()
                    .filter(|o| perimeters::overlaps(near, perimeters::bounds(std::slice::from_ref(*o))))
                    .cloned()
                    .collect();
                perimeters::difference(&one, &object).is_empty()
            };
            let small = area < s * 1.5 || (area < s * 8.0 && inside_object());
            if !small {
                return true;
            }
            let grown = perimeters::offset(&one, mm(s));
            match &inner_bounds {
                Some(b) => {
                    let reach = perimeters::bounds(&grown);
                    let near: Shapes = i
                        .inner
                        .iter()
                        .zip(b)
                        .filter(|(_, x)| perimeters::overlaps(reach, **x))
                        .map(|(s, _)| s.clone())
                        .collect();
                    // The count drops only when the grown drop swallows a whole piece, which a piece larger than
                    // the drop (with room for rounding) cannot be.
                    let most = area_mm2(&grown) * 1.01 + 0.01;
                    near.iter().any(|p| area_mm2(std::slice::from_ref(p)) <= most)
                        && perimeters::difference(&near, &grown).len() < near.len()
                }
                None => perimeters::difference(i.inner, &grown).len() < i.inner.len(),
            }
        })
        .collect();
    perimeters::intersection(i.inner, &keep)
}

/// `shapes` opened by `r` mm: what is thinner than `2 r` goes.
pub(crate) fn opened(shapes: &Shapes, r: f64) -> Shapes {
    if shapes.is_empty() || r <= 0.0 {
        return shapes.clone();
    }
    perimeters::offset(&eroded(shapes, mm(r)), mm(r))
}

/// `opened` after the rings lose points within 0.2 micron of the chord between their neighbors. Clipping
/// leaves zero-width spurs of such points, and offsetting them is quadratic in the crossings they make
/// (a 700-point piece took 0.3 s to open, 80 points 0.5 ms).
fn opened_clean(shapes: &Shapes, r: f64) -> Shapes {
    opened(&cleaned(shapes), r)
}

/// `shapes` without the zero-width spurs described at `opened_clean`.
fn cleaned(shapes: &Shapes) -> Shapes {
    shapes
        .iter()
        .map(|s| {
            s.iter()
                .map(|ring| perimeters::simplify_ring(ring, 2))
                .filter(|ring| ring.len() >= 3)
                .collect::<Vec<_>>()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// `shapes` shrunk by `r` internal units. Thin rings would turn inside out under a plain negative
/// offset, so it is worked as the shapes less the growth of their surroundings.
fn eroded(shapes: &Shapes, r: i32) -> Shapes {
    use i_overlay::i_float::int::point::IntPoint;
    let (mut lo, mut hi) = (
        IntPoint::new(i32::MAX, i32::MAX),
        IntPoint::new(i32::MIN, i32::MIN),
    );
    for p in shapes
        .iter()
        .flat_map(|sh| sh.iter())
        .flat_map(|ring| ring.iter())
    {
        lo = IntPoint::new(lo.x.min(p.x), lo.y.min(p.y));
        hi = IntPoint::new(hi.x.max(p.x), hi.y.max(p.y));
    }
    let pad = r.saturating_mul(3).max(1);
    let (x0, y0, x1, y1) = (lo.x - pad, lo.y - pad, hi.x + pad, hi.y + pad);
    let frame: Shapes = vec![vec![vec![
        IntPoint::new(x0, y0),
        IntPoint::new(x1, y0),
        IntPoint::new(x1, y1),
        IntPoint::new(x0, y1),
    ]]];
    let outside = perimeters::difference(&frame, shapes);
    perimeters::difference(shapes, &perimeters::offset(&outside, r))
}

pub(crate) fn area_mm2(shapes: &[Vec<Vec<i_overlay::i_float::int::point::IntPoint<i32>>>]) -> f64 {
    shapes
        .iter()
        .flat_map(|s| s.iter().enumerate())
        .map(|(k, r)| {
            let a = r2(r) / 2.0 / crate::geom::SCALE / crate::geom::SCALE;
            if k == 0 { a.abs() } else { -a.abs() }
        })
        .sum()
}

#[allow(clippy::cast_precision_loss, reason = "areas stay far below 2^52")]
fn r2(ring: &[i_overlay::i_float::int::point::IntPoint<i32>]) -> f64 {
    crate::geom::area2_int(ring) as f64
}

/// The other `ensure_vertical_shell_thickness` values, which Orca handles in `discover_horizontal_shells`:
/// a top or bottom surface turns the internal area under (over) it solid for the shell layers, and
/// the mode decides how eagerly that goes on past a layer where the surface finds nothing internal
/// and how narrow solid pieces are treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    None,
    CriticalOnly,
    Moderate,
}

/// The mode the profile asks for; `None` for `ensure_all` and when the setting is absent.
pub(crate) fn mode_of(cfg: &PrintConfig) -> Option<Mode> {
    match cfg.raw.get("ensure_vertical_shell_thickness") {
        Some(serde_json::Value::String(s)) => match s.as_str() {
            "none" => Some(Mode::None),
            "ensure_critical_only" => Some(Mode::CriticalOnly),
            "ensure_moderate" => Some(Mode::Moderate),
            _ => None,
        },
        _ => None,
    }
}

/// Everything the horizontal shell rule reads about one layer.
pub(crate) struct HInput<'a> {
    pub(crate) cache: Option<&'a Cache>,
    /// Fingerprint of the settings the `inner` areas were worked out with.
    pub(crate) tag: u64,
    /// The outline of any layer by index, `None` past the ends of the plate.
    pub(crate) slice: &'a dyn Fn(i64) -> Option<Shapes>,
    /// The infill area (inside the walls) of any layer by index.
    pub(crate) inner: &'a dyn Fn(i64) -> Option<Shapes>,
    pub(crate) layer: i64,
    pub(crate) top_layers: i64,
    pub(crate) bottom_layers: i64,
    pub(crate) mode: Mode,
    /// Sparse infill density is zero: everything under a surface is solid, and narrow pieces go.
    pub(crate) no_sparse: bool,
    /// Outer wall and solid infill bead widths, mm.
    pub(crate) wall_width: f64,
    pub(crate) solid_width: f64,
    /// Surfaces are opened by this, mm.
    pub(crate) opening: f64,
}

/// The solid area the top and bottom surfaces of the neighboring layers leave on this layer, as
/// `PrintObject::discover_horizontal_shells` works it out: each surface layer's footprint walks
/// toward this layer, cut by each layer's internal area on the way.
pub(crate) fn horizontal_area(i: &HInput<'_>) -> Shapes {
    let mut out: Vec<Shapes> = Vec::new();
    for (is_top, layers) in [(true, i.top_layers), (false, i.bottom_layers)] {
        // A top surface's shell reaches down, a bottom surface's up.
        let toward: i64 = if is_top { -1 } else { 1 };
        for d in 1..layers.max(1) {
            let src = i.layer - toward * d;
            // The walk from a surface layer is the same for every layer it reaches, so it is worked
            // out once, for the longest reach, and each layer reads its own step.
            let key = (src, toward, layers);
            let steps = match i.cache {
                Some(c) => c.walk(key, i.tag, || walk(i, src, toward, layers)),
                None => std::sync::Arc::new(walk(i, src, toward, layers)),
            };
            if let Some(Some(new)) = usize::try_from(d - 1).ok().and_then(|k| steps.get(k)) {
                out.push(new.clone());
            }
        }
    }
    let refs: Vec<&Shapes> = out.iter().collect();
    if refs.is_empty() {
        Vec::new()
    } else {
        perimeters::union_all(&refs)
    }
}

/// The solid area a surface at layer `src` leaves on each layer from `src + toward` to `layers - 1`
/// layers on (`None` where the walk has stopped).
fn walk(i: &HInput<'_>, src: i64, toward: i64, layers: i64) -> Vec<Option<Shapes>> {
    let steps = usize::try_from((layers - 1).max(0)).unwrap_or(0);
    let mut result: Vec<Option<Shapes>> = vec![None; steps];
    let Some(here) = (i.slice)(src) else { return result };
    let beside = (i.slice)(src - toward);
    let surface = opened(
        &perimeters::difference(&here, beside.as_ref().unwrap_or(&Vec::new())),
        i.opening,
    );
    if surface.is_empty() {
        return result;
    }
    let mut solid = surface;
    for step in 1..=i64::try_from(steps).unwrap_or(0) {
        let n = src + toward * step;
        let Some(internal) = (i.inner)(n) else { break };
        let mut new = perimeters::intersection(&solid, &internal);
        if new.is_empty() {
            if i.no_sparse || i.mode != Mode::Moderate {
                break;
            }
            if let Some(slot) = usize::try_from(step - 1).ok().and_then(|k| result.get_mut(k)) {
                *slot = Some(new);
            }
            continue;
        }
        let factor = if i.no_sparse {
            1.0
        } else {
            match i.mode {
                Mode::None => 0.5,
                Mode::CriticalOnly => 0.2,
                Mode::Moderate => 0.0,
            }
        };
        if factor > 0.0 {
            let gone = perimeters::difference(&new, &opened_clean(&new, factor * i.wall_width));
            if !gone.is_empty() {
                new = perimeters::difference(&new, &gone);
                solid.clone_from(&new);
            }
        }
        // Pieces narrower than a few beads grow, within the internal area, so a solid
        // region is at least that wide.
        let margin = if i.mode == Mode::None { 1.0 } else { 3.0 } * i.solid_width;
        let narrow = perimeters::difference(&new, &opened_clean(&new, margin));
        if !narrow.is_empty() {
            let grown =
                perimeters::intersection(&perimeters::offset(&cleaned(&narrow), mm(margin)), &internal);
            new = perimeters::union_all(&[&new, &grown]);
        }
        if let Some(slot) = usize::try_from(step - 1).ok().and_then(|k| result.get_mut(k)) {
            *slot = Some(new);
        }
    }
    result
}
