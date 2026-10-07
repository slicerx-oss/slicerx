// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A plate prepared for slicing: parts welded, moved to plate coordinates and
//! bucketed by layer. One session serves any number of layer ranges, which is
//! how WASM workers and the desktop host avoid redoing mesh work.

use crate::config::{InfillPattern, PrintConfig, RANGE_KEYS, READ_KEYS, SupportStyle};
use crate::contours::PreparedPart;
use crate::error::{Error, Result};
use crate::fm::Fm as _;
use crate::geom::SCALE;
use crate::geom::{Polygon, mm};
use crate::infill::{self, Dir, Family, Spans};
use crate::layers::LayerPlan;
use crate::output::{LayerPaths, SliceOutput, SliceWarning, Stage, StageMicros, WarningCode};
use crate::par::Init as _;
use crate::paths::{self, ToolWork};
use crate::perimeters::{self, Shapes};
use crate::plate::Plate;
use crate::platform::Timer;
use crate::{Progress, par};
use i_overlay::i_float::int::point::IntPoint;
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering};

/// Slot, welded plate-space vertices and triangles of one part.
/// A part with settings of its own: its welded mesh and the settings.
type PartRegion = (Vec<[f64; 3]>, Vec<[u32; 3]>, serde_json::Value);

type RawPart = (u8, Vec<[f64; 3]>, Vec<[u32; 3]>, crate::paint::Facets);

/// A layer's sparse infill for the bridge facts: segments for a pattern on scanlines, else the paths it prints.
type SparseLines = (Vec<[IntPoint<i32>; 2]>, Vec<Vec<crate::geom::Point>>);

/// A fingerprint of the settings a per-layer result was worked out with, for `shells::Cache` keys. The
/// line widths are part of it: the first layer's settings (`PrintConfig::for_first_layer`) change them
/// without touching the profile values, and walls worked out at the first layer's width must not stand in
/// for a neighbor's walls at the normal width, or the other way round.
fn settings_tag(cfg: &PrintConfig) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(&cfg.raw).unwrap_or_default().hash(&mut h);
    cfg.layer_height.to_bits().hash(&mut h);
    cfg.line_width.to_bits().hash(&mut h);
    let fw = &cfg.feature_widths;
    for w in [
        fw.outer_wall,
        fw.inner_wall,
        fw.sparse_infill,
        fw.internal_solid_infill,
        fw.top_surface,
        fw.support,
        fw.initial_layer,
    ] {
        w.map(f64::to_bits).hash(&mut h);
    }
    h.finish()
}

/// What the layers of one slice read of each of the slice's configs, worked out once per config instead of in
/// every layer: its settings tag (which writes out every profile value) and its filament views
/// (`PrintConfig::for_filament`, a copy of the whole config when the filament has settings of its own).
struct Tags<'c> {
    configs: Vec<(&'c PrintConfig, u64)>,
    /// Per entry of `configs` and 1-based slot, filled the first time a layer asks.
    filaments: Vec<Vec<std::sync::OnceLock<std::borrow::Cow<'c, PrintConfig>>>>,
}

impl<'c> Tags<'c> {
    fn of_all(configs: impl IntoIterator<Item = &'c PrintConfig>, slots: u8) -> Self {
        let configs: Vec<(&'c PrintConfig, u64)> =
            configs.into_iter().map(|c| (c, settings_tag(c))).collect();
        let filaments = configs
            .iter()
            .map(|_| (0..slots.max(1)).map(|_| std::sync::OnceLock::new()).collect())
            .collect();
        Self { configs, filaments }
    }

    fn index(&self, cfg: &PrintConfig) -> Option<usize> {
        self.configs.iter().position(|(c, _)| std::ptr::eq(*c, cfg))
    }

    /// `settings_tag(cfg)`, looked up when `cfg` is one of the slice's configs.
    fn of(&self, cfg: &PrintConfig) -> u64 {
        self.index(cfg)
            .and_then(|i| self.configs.get(i))
            .map_or_else(|| settings_tag(cfg), |(_, t)| *t)
    }

    /// `cfg.for_filament(slot)`, kept when `cfg` is one of the slice's configs.
    fn filament<'a>(&'a self, cfg: &'a PrintConfig, slot: u8) -> std::borrow::Cow<'a, PrintConfig> {
        let found = self.index(cfg).and_then(|i| {
            let (c, _) = self.configs.get(i)?;
            Some((*c, self.filaments.get(i)?.get(usize::from(slot.max(1) - 1))?))
        });
        if let Some((c, cell)) = found {
            std::borrow::Cow::Borrowed(&**cell.once(|| c.for_filament(slot)))
        } else {
            cfg.for_filament(slot)
        }
    }
}

/// The first layer's area and outline, kept with the fingerprint of the settings it was worked out with.
#[derive(Default)]
struct FirstInfoMemo(std::sync::Mutex<Option<(u64, crate::output::FirstLayerInfo)>>);

impl Clone for FirstInfoMemo {
    /// A copy starts empty, like `shells::Cache`.
    fn clone(&self) -> Self {
        Self::default()
    }
}

impl std::fmt::Debug for FirstInfoMemo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FirstInfoMemo")
    }
}

/// Parts of a plate ready to cut, plus the layer plan.
#[derive(Debug, Clone)]
pub struct SliceSession {
    /// Per-layer results that the layers around one layer share (`shells::Cache`).
    cache: crate::shells::Cache,
    /// `first_layer_info` by settings fingerprint: every layer range asks for it.
    first_info: FirstInfoMemo,
    parts: Vec<PreparedPart>,
    /// Filament slots in priority order (ascending; a higher slot wins where parts overlap).
    slots: Vec<u8>,
    plan: LayerPlan,
    tool_count: u8,
    warnings: Vec<SliceWarning>,
    prep_micros: u64,
    bounds: [f64; 4],
    /// Cuts and support regions of the objects, sliced like parts.
    volumes: Vec<(crate::plate::VolumeRole, PreparedPart)>,
    /// The setting overrides of each volume (modifiers); `Null` for the rest.
    volume_settings: Vec<serde_json::Value>,
    /// Painted support pieces in plate coordinates: state 1 asks for support, 2 keeps it out.
    painted_supports: Vec<([[f64; 3]; 3], u8)>,
    /// Painted seam pieces in plate coordinates.
    seam_faces: Vec<crate::seam::SeamFace>,
    /// Painted fuzzy skin pieces in plate coordinates, by the index of the part they are on (state 1 is painted).
    fuzzy_paint: Vec<(usize, crate::paint::Facets)>,
    /// The objects printed after this one when the plate prints by object; each is a session of
    /// its own, so it has its own layers, supports and first layer.
    followers: Vec<SliceSession>,
    /// Per object of the sequence (this one first): its own setting overrides, when they differ.
    object_settings: Vec<serde_json::Value>,
    /// Objects print layer by layer (each layer holds every object's paths) instead of one after
    /// the other.
    interleave: bool,
    /// Settings objects that height ranges apply, merged in order; layer `l`
    /// uses `overrides[layer_cfg[l] - 1]`, or the base config when 0.
    overrides: Vec<serde_json::Value>,
    objects: Vec<crate::output::ObjectFootprint>,
    /// Each plate object's height, mm, in the order of `objects`.
    object_heights: Vec<f64>,
    layer_cfg: Vec<u16>,
    /// The support settings the session was built with, and the support
    /// area of every layer, planned on first use (it needs the whole plate).
    support_cfg: crate::config::SupportConfig,
    support_width: f64,
    /// The last layer that has a tool change; the prime tower stands up to it.
    tower_top: Option<u32>,
    /// The filaments each layer prints, in print order.
    tool_order: Vec<Vec<u8>>,
    /// Front left corner of the prime tower once it is clear of the objects.
    tower_origin: Option<[f64; 2]>,
    /// The prime tower's depth in purge rows: what its deepest layer needs.
    tower_rows: f64,
    /// Where the tower stands, how wide and turned how far, and why (`tower::place`).
    tower_shape: Option<crate::tower::Placement>,
    /// What variable layer heights cost in tool changes and purge against fixed layers.
    vary_cost: Option<crate::output::VaryLayerCost>,
    /// XY size and elephant foot compensation of the slices, when the settings ask for any.
    comp: Option<crate::compensate::Comp>,
    /// Spiral vase mode: the number of solid base layers; the layers above are the spiral.
    vase: Option<u32>,
    /// `interlocking_beam` settings, when the beams are on.
    interlock_params: Option<crate::interlock::Params>,
    interlock: std::sync::OnceLock<Option<crate::interlock::Layers>>,
    /// `make_overhang_printable`: the area each layer gains from the cone under the layers above it.
    conical: std::sync::OnceLock<Option<Vec<Shapes>>>,
    conical_params: Option<(f64, f64)>,
    /// `hole_to_polyhole`: per layer, the circular holes found and the polygons that replace them.
    polyholes: std::sync::OnceLock<Option<Vec<Vec<HoleSwap>>>>,
    /// Painted brim ears on the bed: x, y, z in plate coordinates, and the head radius, mm.
    brim_ears: Vec<[f64; 4]>,
    /// Draft shield: the convex hull of the whole part, which the skirt follows on every layer.
    draft_hull: Option<Vec<IntPoint<i32>>>,
    /// `skirt_type` per object: the hull of each group of objects whose skirts would touch; empty otherwise.
    skirt_groups: Vec<Vec<IntPoint<i32>>>,
    /// `print_order` as object list: the hull of each object in the plate's list order, which the islands
    /// of a layer follow; empty for the default order.
    object_hulls: Vec<Vec<IntPoint<i32>>>,
    /// The raft under the part: its layers come before the part's, which sit on top of it.
    raft: Option<crate::raft::Plan>,
    support: std::sync::OnceLock<Vec<crate::support::SupportLayer>>,
    /// Set while the support plan is worked out beside the layers (`slice_object_range_now`), when nothing
    /// else may ask for it.
    support_pending: Pending,
    /// Organic trees over a raft: the branches passing through each raft layer.
    organic_raft: std::sync::OnceLock<Vec<Shapes>>,
    /// The print layers when they are not the object's own: support on layers of its own height
    /// merged with the object's by height. Empty when every print layer is an object layer.
    print: Vec<crate::layers::PrintLayer>,
    /// Print layer of each object layer, when `print` is set.
    object_print: Vec<u32>,
    /// The support layers of their own height (`independent_support_layer_height`).
    stack: Vec<crate::support::StackLayer>,
    /// Objects printed layer by layer with settings of their own: each print layer of the plate, its
    /// top and the print layer of each object of the sequence printed in it (Orca pairs them by
    /// height). Empty when every object has the same layers.
    interleaved: Vec<(f64, Vec<Option<u32>>)>,
    /// With features on filaments of their own: the filaments each object layer prints, from a
    /// slice of the whole plate at build time (Orca's `ToolOrdering::collect_extruders`). Empty
    /// otherwise.
    used_tools: Vec<Vec<u8>>,
    /// The support filaments each object layer adds to the tool order (`support_filament`,
    /// `support_interface_filament`).
    support_tools: Vec<Vec<u8>>,
    /// The print layers already stand on the raft (planned with it), so placing the raft does not
    /// lift them again.
    print_lifted: bool,
    /// The stack holds every support layer (support on layers of its own); otherwise it only adds
    /// layers the object's support does not have (the base layer under an object on a raft).
    independent: bool,
    /// The seam of every wall ring of the object, planned on first use (`seamplan.rs`).
    seams: std::sync::OnceLock<Option<crate::seamplan::Plan>>,
    /// Every layer's regions as the whole-object plans (seams, curls, supports, lightning) read them, kept
    /// until the slice takes them, so the layers are cut once (`Self::whole_regions`).
    whole: WholeRegions,
    /// How far the outer wall of every layer curls up (`slowdown_for_curled_perimeters`), planned on first use.
    curls: std::sync::OnceLock<Option<Vec<std::sync::Arc<crate::quality::Curled>>>>,
    /// The lightning infill lines of every layer (mm), planned on first use for the whole plate.
    lightning: std::sync::OnceLock<Vec<Vec<Vec<[f64; 2]>>>>,
    /// The turn of the objects about Z, degrees (`align_infill_direction_to_model`); 0 when the objects of the
    /// session differ, which the plate avoids by giving each its own session.
    model_rotation: f64,
    /// The support columns that stand on the raft (Orca's `columns_base` in `generate_raft_base`): the raft's
    /// layers print under them too.
    raft_columns: Shapes,
    /// The infill combination groups (`infill_combination`), planned on first use.
    combine: std::sync::OnceLock<Combine>,
    /// The lightning lines of the tree support bases on every support layer (mm), planned on first use.
    tree_lightning: std::sync::OnceLock<Vec<Vec<Vec<[f64; 2]>>>>,
    /// The octree of adaptive cubic or support cubic infill, built on first use.
    octree: std::sync::OnceLock<Option<crate::adaptive::Octree>>,
    /// Copies of one object sliced once: per plate object in plate order, the object of the sequence sliced
    /// for it and where its copy moves to. Empty when every object is sliced on its own.
    instances: Vec<Instance>,
    /// With copies: the whole plate as one session, sliced instead when the copies' first layers meet.
    whole_plate: Option<std::sync::Arc<WholePlate>>,
    /// The filament map on a printer with two extruders fed by their own AMS (`nozzles.rs`); the session's
    /// settings carry it as `filament_map`.
    nozzle_map: Option<crate::nozzles::Map>,
    /// heimdall's model of a by-object plate: its objects as obstacles and the machine among them (`collide`).
    collide: Option<std::sync::Arc<crate::collide::Model>>,
    /// The report's facts on a plate without a model (printed by layer): its objects and keep-out zones.
    collide_meta: Option<std::sync::Arc<crate::collide::Meta>>,
    /// The tower's rows before the saves of a type 2 tower (`tower::plan_rows_unsaved`), which the saves are
    /// measured on.
    tower_rows0: f64,
}

/// One plate object printed as a copy of an object of the sequence.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Instance {
    /// The object of the sequence whose paths it prints.
    pub(crate) sub: usize,
    /// How far the copy moves, internal units.
    pub(crate) shift: [i32; 2],
}

/// The plate a session of copies was built from, to slice it whole when the copies cannot be placed apart.
#[derive(Debug)]
pub(crate) struct WholePlate {
    plate: Plate,
    config: PrintConfig,
    tops: Option<Vec<f64>>,
    session: std::sync::OnceLock<Option<SliceSession>>,
}

/// Settings that apply to the layers whose cutting plane lies in `z_from_mm..z_to_mm`.
#[derive(Debug, Clone)]
pub struct HeightRange {
    pub z_from_mm: f64,
    pub z_to_mm: f64,
    /// A config object with Orca keys; only [`RANGE_KEYS`] may change by height.
    pub settings: serde_json::Value,
    /// Ids of the objects the range applies to; empty for every object on the plate.
    pub objects: Vec<String>,
}

/// Range keys the G-code writer applies to a whole layer. When objects print layer by layer, a
/// range of one object sets these for the layer, so every object on it prints with them.
/// Farthest a placed model may reach from the bed's origin, mm. Outlines are `i32` at 1e-4 mm, about
/// 214 m, and brims, skirts and offsets need room past the part.
const MAX_REACH_MM: f64 = 100_000.0;

/// Refuses a plate whose placed models have a point that is not a number (a damaged file) or that lies
/// past [`MAX_REACH_MM`] (most often a file in the wrong units), which the scaled outlines cannot hold.
fn check_extent(plate: &Plate) -> Result<()> {
    for o in &plate.objects {
        let name = if o.mesh.name.is_empty() {
            &o.name
        } else {
            &o.mesh.name
        };
        for &p in o.mesh.parts.iter().flat_map(|part| &part.positions) {
            let w = o.apply(p);
            if w.iter().any(|c| !c.is_finite()) {
                return Err(Error::mesh(
                    name,
                    "has a point that is not a number; the file may be damaged",
                ));
            }
            if let Some(far) = w.iter().map(|c| c.abs()).find(|c| *c > MAX_REACH_MM) {
                // A damaged file can put a point at 1e30 mm; past a kilometer the number says nothing more.
                let how_far = if far < 1.0e6 {
                    format!("{:.0} m", far / 1000.0)
                } else {
                    "more than a kilometer".to_owned()
                };
                return Err(Error::mesh(
                    name,
                    format!("reaches {how_far} from the bed; check the file's units and where it is placed"),
                ));
            }
        }
    }
    Ok(())
}

/// Refuses a model that cannot print where it stands before anything is sliced: wider or deeper than the bed,
/// taller than the printer builds, or wholly off the bed. Each of these would slice in full and only then be
/// refused by the toolpath check, which took minutes for a model in the wrong units. A model partly over an edge
/// is left to that check, which knows whether its toolpaths leave the bed.
fn check_fits(extents: &[(&str, [f64; 4], f64)], config: &PrintConfig) -> Result<()> {
    const TOL: f64 = 0.05;
    let bed = config.bed_rect();
    let (bw, bd, bh) = (bed[2] - bed[0], bed[3] - bed[1], config.printable_height);
    for &(name, b, top) in extents {
        let (w, d) = (b[2] - b[0], b[3] - b[1]);
        // The scale a file in other units would have needed: tenths, inches, thousandths.
        let hint = [
            (10.0, "a tenth"),
            (25.4, "1/25.4 (inches)"),
            (1000.0, "a thousandth"),
        ]
        .iter()
        .find(|(f, _)| w / f <= bw && d / f <= bd && top / f <= bh)
        .map_or(String::new(), |(_, what)| {
            format!("; at {what} of its size it would fit, so check the file's units or the object's scale")
        });
        // The same error and words as the toolpath check that would have refused it later.
        if w > bw + TOL || d > bd + TOL {
            return Err(Error::Blocked(format!(
                "{name} is {w:.0} x {d:.0} mm, larger than the {bw:.0} x {bd:.0} mm printable area{hint}"
            )));
        }
        if top > bh + TOL {
            return Err(Error::Blocked(format!(
                "{name} is {top:.0} mm tall, above the {bh:.0} mm printable height{hint}"
            )));
        }
        if b[2] < bed[0] - TOL || b[0] > bed[2] + TOL || b[3] < bed[1] - TOL || b[1] > bed[3] + TOL {
            return Err(Error::Blocked(format!(
                "{name} lies wholly outside the printable area; move it onto the bed"
            )));
        }
    }
    Ok(())
}

const LAYER_WIDE_KEYS: [&str; 7] = [
    "nozzle_temperature",
    "enable_pressure_advance",
    "pressure_advance",
    "retraction_length",
    "retraction_speed",
    "retraction_minimum_travel",
    "travel_speed",
];

/// The ranges that apply to object `id`: the plate's, its own and, when objects print layer by layer,
/// the layer wide keys of the other objects' ranges. Order is kept, so a later range still wins.
fn object_ranges(ranges: &[HeightRange], id: &str, interleaved: bool) -> Vec<HeightRange> {
    ranges
        .iter()
        .filter_map(|r| {
            if r.objects.is_empty() || r.objects.iter().any(|o| o == id) {
                return Some(r.clone());
            }
            if !interleaved {
                return None;
            }
            let serde_json::Value::Object(m) = &r.settings else {
                return None;
            };
            let wide: serde_json::Map<String, serde_json::Value> = m
                .iter()
                .filter(|(k, _)| LAYER_WIDE_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            (!wide.is_empty()).then(|| HeightRange {
                z_from_mm: r.z_from_mm,
                z_to_mm: r.z_to_mm,
                settings: serde_json::Value::Object(wide),
                objects: Vec::new(),
            })
        })
        .collect()
}

/// Objects that print layer by layer share the nozzle, so ranges of different objects that set one
/// layer wide key to different values over the same heights cannot both hold: the later one wins
/// for every object there. Named so the person can print by object instead.
fn layer_wide_conflicts(ranges: &[HeightRange]) -> Vec<SliceWarning> {
    let mut out = Vec::new();
    for (i, a) in ranges.iter().enumerate() {
        for b in ranges.iter().skip(i + 1) {
            if a.objects.is_empty() || b.objects.is_empty() || a.objects == b.objects {
                continue;
            }
            let (lo, hi) = (a.z_from_mm.max(b.z_from_mm), a.z_to_mm.min(b.z_to_mm));
            if lo >= hi {
                continue;
            }
            for k in LAYER_WIDE_KEYS {
                if let (Some(x), Some(y)) = (a.settings.get(k), b.settings.get(k))
                    && x != y
                {
                    out.push(SliceWarning {
                        code: WarningCode::UnsupportedSetting,
                        message: format!(
                            "{k} of {} and {} differ between {lo} and {hi} mm; objects printed layer by layer share it, so {} is used for both (print by object to give each its own)",
                            a.objects.join(", "),
                            b.objects.join(", "),
                            y
                        ),
                        layer: None,
                    });
                }
            }
        }
    }
    out
}

/// Inputs of the support planners, one entry per object layer.
struct SupportInput {
    models: Vec<Shapes>,
    thickness: Vec<f64>,
    force: Vec<Shapes>,
    block: Vec<Shapes>,
    center: [f64; 2],
}

/// Cross section of a bead `width` wide and `a` high against one `b` high (rounded sides,
/// `w - h (1 - pi / 4)` by `h`).
#[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
pub(crate) fn bead_ratio(width: f64, a: f64, b: f64) -> f32 {
    let area = |h: f64| (width - h * (1.0 - std::f64::consts::FRAC_PI_4)).max(width * 0.5) * h;
    if b <= 0.0 || (a - b).abs() < 1e-9 {
        return 0.0;
    }
    (area(a) / area(b)) as f32
}

/// The paths of one support layer.
#[derive(Debug, Default)]
struct SupportPaths {
    support: Vec<Vec<crate::geom::Point>>,
    interface: Vec<Vec<crate::geom::Point>>,
    /// Ironing over the top contact (`support_ironing`).
    ironing: Vec<Vec<crate::geom::Point>>,
}

/// One loop around the top contact `contact`, kept to the stretch under the overhangs `hang`, with notches
/// around small hexagons placed every three of their radii along it (Orca's `LoopInterfaceProcessor`,
/// one contact loop). Returns the loop pieces and the area the interface fill keeps out of.
fn contact_loops(contact: &Shapes, hang: &Shapes, w: f64) -> (Vec<Vec<crate::geom::Point>>, Shapes) {
    let r = 1.5 * w;
    let hex = |c: [f64; 2]| -> Vec<IntPoint<i32>> {
        (0..6)
            .map(|i| {
                let a = f64::from(i) * std::f64::consts::PI / 3.0;
                IntPoint::new(mm(c[0] + r * a.m_cos()), mm(c[1] + r * a.m_sin()))
            })
            .collect()
    };
    let near = perimeters::offset(hang, mm(0.5 * w));
    let centerline = perimeters::offset(contact, -mm(0.5 * w));
    let mut outlines: Shapes = Vec::new();
    let mut circles: Shapes = Vec::new();
    for shape in &centerline {
        let mut centers: Vec<[f64; 2]> = Vec::new();
        for ring in shape {
            let pts: Vec<[f64; 2]> = ring
                .iter()
                .map(|p| [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE])
                .collect();
            // Only the outlines that pass under the overhang.
            let mut closed = ring.clone();
            if let Some(f) = closed.first().copied() {
                closed.push(f);
            }
            if crate::support::clip_inside(&closed, &near).is_empty() {
                continue;
            }
            // Walk the outline, placing a center wherever it is three radii from every center so far.
            let count = pts.len();
            for e in 0..count {
                let (Some(a), Some(b)) = (pts.get(e), pts.get((e + 1) % count)) else {
                    continue;
                };
                let len = (b[0] - a[0]).m_hypot(b[1] - a[1]);
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a few samples"
                )]
                let n = ((len / (0.05 * r)).ceil() as usize).max(1);
                for k in 0..n {
                    #[allow(clippy::cast_precision_loss, reason = "a few samples")]
                    let t = k as f64 / n as f64;
                    let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                    if centers
                        .iter()
                        .all(|c| (c[0] - p[0]).m_hypot(c[1] - p[1]) >= 3.0 * r - 1e-6)
                    {
                        centers.push(p);
                    }
                }
            }
            outlines.push(vec![ring.clone()]);
        }
        circles.extend(centers.into_iter().map(|c| vec![hex(c)]));
    }
    if outlines.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let notched = perimeters::difference(&outlines, &circles);
    // The loop lines: the notched outlines, kept within the support margin of the overhangs.
    let margin = perimeters::offset(hang, mm(1.5));
    let mut lines: Vec<Vec<crate::geom::Point>> = Vec::new();
    for ring in notched.iter().flat_map(|sh| sh.iter()) {
        let mut closed: Vec<IntPoint<i32>> = ring.clone();
        if let Some(f) = closed.first().copied() {
            closed.push(f);
        }
        for piece in crate::support::clip_inside(&closed, &margin) {
            if piece.len() >= 2 {
                lines.push(
                    piece
                        .into_iter()
                        .map(|p| crate::geom::Point::new(p.x, p.y))
                        .collect(),
                );
            }
        }
    }
    let keep_out = crate::support::stroke(&lines, 1.1 * r);
    (lines, keep_out)
}

/// Stage 2 result for one layer.
#[derive(Debug, Default)]
struct LayerRegions {
    /// `(slot, shapes)` in priority order, disjoint.
    regions: Vec<(u8, Shapes)>,
    /// Per region: 0 for the layer's settings, `k` for the `k`th modifier volume's.
    region_cfg: Vec<u16>,
    open_chains: usize,
    /// The first layer's outline before size compensation, for the brim.
    raw: Option<Shapes>,
    /// On the elephant foot layers, the outline before the foot compensation (Orca's `lslices` there): what
    /// the layers next to it see.
    lslices: Option<Shapes>,
    /// The union of `regions`, worked out on first use: every region of this layer and its neighbors reads it.
    union: std::sync::OnceLock<Shapes>,
}

/// The overhangs an auto lift spirals over (orca's `detect_overhangs_for_lift`, read by
/// `GCode::needs_retraction`): per layer, what hangs more than 30 percent of a line past the layer below, opened
/// by a tenth of a line; this layer's and those of the layers up to 0.4 mm below it.
fn lift_overhangs<'a>(
    plan: &crate::layers::LayerPlan,
    cfg: &PrintConfig,
    layer: u32,
    get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
) -> Option<Box<Shapes>> {
    let lw = cfg.line_width * crate::geom::SCALE;
    #[allow(clippy::cast_possible_truncation, reason = "a line width in internal units")]
    let (grow, open) = ((0.3 * lw).round() as i32, (0.1 * lw).round() as i32);
    let top = plan.top(layer);
    let mut sets: Vec<Shapes> = Vec::new();
    let mut l = layer;
    while l >= 1 && plan.top(l) >= top - 0.4 - 1e-6 {
        if let (Some(here), Some(below)) = (get(l), get(l - 1)) {
            let held = crate::perimeters::offset(&lower_shapes(below), grow);
            let hang = crate::perimeters::difference(&lower_shapes(here), &held);
            let hang = crate::perimeters::offset(&crate::perimeters::offset(&hang, -open), open);
            if !hang.is_empty() {
                sets.push(hang);
            }
        }
        l -= 1;
    }
    let refs: Vec<&Shapes> = sets.iter().collect();
    (!refs.is_empty()).then(|| Box::new(crate::perimeters::union_all(&refs)))
}

/// What a neighbor layer sees of this one: the outline before the elephant foot compensation on the foot
/// layers, else everything it covers.
fn lower_shapes(r: &LayerRegions) -> Shapes {
    r.lslices.clone().unwrap_or_else(|| slice_shapes(r))
}

/// Everything a layer covers: the union of its regions.
fn slice_shapes(r: &LayerRegions) -> Shapes {
    r.union
        .once(|| {
            let sets: Vec<&Shapes> = r.regions.iter().map(|(_, s)| s).collect();
            crate::perimeters::union_all(&sets)
        })
        .clone()
}

impl LayerRegions {
    fn slots(&self) -> impl DoubleEndedIterator<Item = u8> + '_ {
        self.regions
            .iter()
            .filter(|(_, s)| !s.is_empty())
            .map(|(slot, _)| *slot)
    }
}

#[derive(Default)]
struct Micros {
    contours: AtomicU64,
    perimeters: AtomicU64,
    surfaces: AtomicU64,
    infill: AtomicU64,
    paths: AtomicU64,
}

impl Micros {
    fn add(counter: &AtomicU64, t: &Timer) {
        counter.fetch_add(t.micros(), Ordering::Relaxed);
    }
}

#[allow(clippy::cast_possible_truncation, reason = "bead widths are small")]
fn mm_f32(v: f64) -> f32 {
    v as f32
}

/// What decides whether two regions share their walls: the loop count and the line width.
fn wall_key(cfg: &PrintConfig) -> (u32, i64) {
    #[allow(clippy::cast_possible_truncation, reason = "a width in microns")]
    (cfg.wall_loops, (cfg.line_width * 1000.0).round() as i64)
}

/// The first part of a layer's paths ([`SliceSession::layer_start`]), which [`SliceSession::layer_finish`]
/// completes. `rest` is None for a layer with nothing to print.
struct LayerStart {
    out: LayerPaths,
    rest: Option<StartRest>,
}

/// What the second part of a layer's paths reads from the first.
struct StartRest {
    works: Vec<ToolWork>,
    dir: Dir,
    top_n: u32,
    solid_areas: Vec<Shapes>,
}

/// What one region's own settings decide about a layer: widths, shell layers and the neighbor coverage.
struct Shell {
    w: i32,
    overlap: i32,
    top_n: u32,
    bot_n: u32,
    on_lines: bool,
}

/// The walls, infill area and surface classes of one region of a layer: the start of the region's work in
/// `layer_paths_with`.
#[derive(Debug, Clone)]
pub(crate) struct RegionPrep {
    islands: Vec<perimeters::IslandWalls>,
    inner: Shapes,
    cls: crate::classify::Classes,
    /// The classes came from the layer's bridge facts (the region is the whole outline, classified alike).
    known: bool,
}

/// A hole as sliced and the polygon that replaces it (`hole_to_polyhole`).
type HoleSwap = (Vec<IntPoint<i32>>, Vec<IntPoint<i32>>);

/// Every layer's regions with the families they were cut with; a copy of a session starts without them.
#[derive(Debug, Default)]
struct WholeRegions(std::sync::Mutex<Option<(Families, std::sync::Arc<Vec<LayerRegions>>)>>);

/// Set while a plan is worked out beside other work; a copy starts clear.
#[derive(Debug, Default)]
struct Pending(std::sync::atomic::AtomicBool);

impl Clone for Pending {
    fn clone(&self) -> Self {
        Self::default()
    }
}

impl Clone for WholeRegions {
    fn clone(&self) -> Self {
        Self::default()
    }
}

/// Scanline families for one layer.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Families {
    sparse_spacing: i64,
    solid_spacing: i64,
    /// Layers of top and bottom shell, for painted regions under a surface.
    top_shell: usize,
    bottom_shell: usize,
    /// Contour resolution in internal units (finer with arc fitting).
    resolution: i64,
    /// `slicing_mode`: how the cut loops become areas.
    slicing: perimeters::Slicing,
    /// `slice_closing_radius` in internal units.
    closing: i32,
    /// `mmu_segmented_region_max_width` and `mmu_segmented_region_interlocking_depth` in internal units
    /// (0 when off or when beam interlocking is on).
    paint_band: (i32, i32),
}

impl Families {
    fn new(cfg: &PrintConfig) -> Self {
        let w = cfg.spacing_for(cfg.sparse_infill_width());
        let density = cfg.sparse_infill_density / 100.0;
        let factor = if cfg.sparse_infill_pattern == InfillPattern::Grid {
            2.0
        } else {
            1.0
        };
        let sparse_mm = if density > 0.0 {
            (w / density * factor).min(1000.0)
        } else {
            1000.0
        };
        let (top, bottom) = cfg.shell_layers(cfg.layer_height.max(0.01));
        Self {
            sparse_spacing: paths::t_units(sparse_mm),
            solid_spacing: paths::t_units(cfg.spacing_for(cfg.solid_infill_width())),
            top_shell: top as usize,
            bottom_shell: bottom as usize,
            // Extrusion rate smoothing turns arc fitting off, so walls keep the plain resolution then.
            // Orca (`PerimeterGenerator`, `surface_simplify_resolution`): the profile's `resolution`, a fifth of it
            // with arc fitting. A fixed 0.0125 mm dropped every other vertex of a 128-sided circle of 10 mm radius
            // (0.012 mm off the chord), and the coarser corners cost speed at every junction.
            resolution: {
                #[allow(clippy::cast_possible_truncation, reason = "a resolution in internal units")]
                let r = (cfg.raw_number("resolution", 0.012).max(0.0) * crate::geom::SCALE).round() as i64;
                if crate::firmware::truthy(cfg, "enable_arc_fitting")
                    && cfg.raw_number("max_volumetric_extrusion_rate_slope", 0.0) <= 0.0
                {
                    r / 5
                } else {
                    r
                }
            },
            closing: mm(cfg.raw_number("slice_closing_radius", 0.049).max(0.0)),
            paint_band: if crate::firmware::truthy(cfg, "interlocking_beam") {
                (0, 0)
            } else {
                (
                    mm(cfg.raw_number("mmu_segmented_region_max_width", 0.0).max(0.0)),
                    mm(cfg
                        .raw_number("mmu_segmented_region_interlocking_depth", 0.0)
                        .max(0.0)),
                )
            },
            slicing: match cfg.raw.get("slicing_mode") {
                Some(serde_json::Value::String(t)) if t == "even_odd" => perimeters::Slicing::EvenOdd,
                Some(serde_json::Value::String(t)) if t == "close_holes" => perimeters::Slicing::CloseHoles,
                _ => perimeters::Slicing::Regular,
            },
        }
    }

    fn sparse(self, dir: Dir) -> Family {
        Family {
            dir,
            spacing: self.sparse_spacing,
        }
    }

    fn solid(self, dir: Dir) -> Family {
        Family {
            dir,
            spacing: self.solid_spacing,
        }
    }
}

impl SliceSession {
    /// Welds and places every part, plans layers and buckets triangles.
    pub fn new(plate: &Plate, config: &PrintConfig) -> Result<Self> {
        Self::with_layer_tops(plate, config, None)
    }

    /// [`SliceSession::new`] with explicit layer tops in mm (sleipnir):
    /// the first entry is the first layer's top, entries strictly ascend, and
    /// they reach the top of the plate. `None` uses `layer_height`.
    pub fn with_layer_tops(plate: &Plate, config: &PrintConfig, tops: Option<&[f64]>) -> Result<Self> {
        Self::with_options(plate, config, tops, &[])
    }

    /// [`SliceSession::with_layer_tops`] plus per-height setting overrides.
    /// Ranges are applied in order, so a later range wins where they overlap.
    pub fn with_options(
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        ranges: &[HeightRange],
    ) -> Result<Self> {
        par::slice(|| Self::build(plate, config, tops, ranges))
    }

    /// [`Self::with_options`]: the filament map first (on a printer with two extruders fed by their own
    /// AMS), then the plate sliced with the settings that carry it.
    fn build(
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        ranges: &[HeightRange],
    ) -> Result<Self> {
        check_extent(plate)?;
        let map = if crate::nozzles::shared(config) {
            let usage = crate::nozzles::Usage::of_plate(plate, config);
            let tools = usage.layers.iter().flatten().copied().max().unwrap_or(1);
            crate::nozzles::Map::resolve(config, tools, &usage)
        } else {
            None
        };
        let Some(map) = map else {
            return Self::build_plate(plate, config, tops, ranges);
        };
        let mut session = Self::build_plate(plate, &map.apply(config), tops, ranges)?;
        for f in &mut session.followers {
            f.nozzle_map = Some(map.clone());
        }
        session.nozzle_map = Some(map);
        Ok(session)
    }

    /// The filament map the session prints with, when the printer has one.
    pub fn filament_map(&self) -> Option<&crate::nozzles::Map> {
        self.nozzle_map.as_ref()
    }

    /// Which of a layer's `works` prints the skirt `loops`: the first, unless the filament map puts it on an extruder
    /// that does not reach the whole skirt (`extruder_printable_area`), then the first that does.
    fn skirt_tool_at(&self, cfg: &PrintConfig, works: &[ToolWork], loops: &[Vec<IntPoint<i32>>]) -> usize {
        let Some(map) = self.nozzle_map.as_ref() else {
            return 0;
        };
        let pts = loops.iter().flatten();
        let Some(b) = pts.fold(None::<[f64; 4]>, |acc, p| {
            let (x, y) = (f64::from(p.x) / SCALE, f64::from(p.y) / SCALE);
            Some(acc.map_or([x, y, x, y], |a| {
                [a[0].min(x), a[1].min(y), a[2].max(x), a[3].max(y)]
            }))
        }) else {
            return 0;
        };
        let boxes = crate::nozzles::reach_boxes(cfg, crate::nozzles::extruders(cfg));
        let reaches = |w: &ToolWork| match boxes.get(map.extruder_of(w.tool)).copied().flatten() {
            Some(r) => b[0] >= r[0] && b[1] >= r[1] && b[2] <= r[2] && b[3] <= r[3],
            None => true,
        };
        works.iter().position(reaches).unwrap_or(0)
    }

    /// `config` with the session's filament map in it, when it has one.
    pub fn mapped_config<'a>(&self, config: &'a PrintConfig) -> std::borrow::Cow<'a, PrintConfig> {
        match &self.nozzle_map {
            Some(m) => std::borrow::Cow::Owned(m.apply(config)),
            None => std::borrow::Cow::Borrowed(config),
        }
    }

    /// The plate sliced with `config` ([`Self::build`]).
    fn build_plate(
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        ranges: &[HeightRange],
    ) -> Result<Self> {
        // Filament shrinkage compensation scales every object (about its own center, from the bed).
        let shrunk: Plate;
        let plate = match crate::compensate::shrinkage(plate, config) {
            Some(f) => {
                shrunk = crate::compensate::scale_plate(plate, f);
                &shrunk
            }
            None => plate,
        };
        let printable: Vec<&crate::plate::PlateObject> = plate
            .objects
            .iter()
            .filter(|o| o.mesh.parts.iter().any(|p| !p.triangles.is_empty()))
            .collect();
        // A vase layer prints only its largest outline, so a second object printed layer by layer would lose its
        // walls. Orca refuses the plate too (`Print::validate`).
        if crate::spiral::enabled(config) && printable.len() > 1 && !config.print_by_object() {
            return Err(Error::Config {
                key: "spiral_mode",
                reason: "spiral vase prints one object at a time; print by object, or keep one object on the plate"
                    .to_owned(),
            });
        }
        for (i, r) in ranges.iter().enumerate() {
            if let Some(id) = r
                .objects
                .iter()
                .find(|id| !plate.objects.iter().any(|o| o.id == **id))
            {
                return Err(Error::Config {
                    key: "options.heightRanges",
                    reason: format!("range {i} names object {id}, which is not on the plate"),
                });
            }
        }
        let scoped = ranges.iter().any(|r| !r.objects.is_empty());
        // `align_infill_direction_to_model` with objects turned differently: each gets a session of its own.
        let turned = crate::firmware::truthy(config, "align_infill_direction_to_model")
            && printable
                .windows(2)
                .any(|w| matches!(w, [a, b] if (z_turn(a) - z_turn(b)).abs() > 1e-6));
        let differing = printable.iter().any(|o| !o.settings.is_null()) || scoped || turned;
        // Copies of one object on a layer-by-layer plate: each object is sliced once and printed at its copies.
        let copies = if config.print_by_object() || differing || !ranges.is_empty() || printable.len() < 2 {
            None
        } else {
            copies_of(&printable, config)
        };
        if copies.is_none() && (!(config.print_by_object() || differing) || printable.len() < 2) {
            let own = match (scoped, printable.first()) {
                (true, Some(o)) => object_ranges(ranges, &o.id, false),
                _ => ranges.to_vec(),
            };
            return Self::build_one(plate, config, tops, &own, false);
        }
        config.check()?;
        let interleaved = !config.print_by_object();
        // With copies only the first of each is sliced.
        let sliced: Vec<&crate::plate::PlateObject> = match &copies {
            Some(placed) => printable
                .iter()
                .enumerate()
                .filter(|(i, _)| placed.get(*i).is_some_and(|c| c.0 == *i))
                .map(|(_, o)| *o)
                .collect(),
            None => printable.clone(),
        };
        let mut subs: Vec<Self> = Vec::with_capacity(sliced.len());
        for obj in &sliced {
            let own_cfg = object_config(config, &obj.settings)?;
            let sub = Plate {
                bed: plate.bed,
                objects: vec![(*obj).clone()],
            };
            // Explicit layer tops end at the object's own top.
            let top = obj
                .mesh
                .parts
                .iter()
                .flat_map(|p| p.positions.iter())
                .map(|&v| obj.apply(v)[2])
                .fold(f64::MIN, f64::max);
            let own: Option<Vec<f64>> = tops.map(|t| {
                let n = t.iter().position(|&z| z >= top - 1e-6).map_or(t.len(), |i| i + 1);
                t.iter().take(n).copied().collect()
            });
            let own_ranges = if scoped {
                object_ranges(ranges, &obj.id, interleaved)
            } else {
                ranges.to_vec()
            };
            subs.push(Self::build_one(
                &sub,
                &own_cfg,
                own.as_deref(),
                &own_ranges,
                interleaved,
            )?);
        }
        if interleaved && let Some(s) = subs.first_mut() {
            for w in layer_wide_conflicts(ranges) {
                s.push_warning(w);
            }
        }
        // Copies need the plate's single filament and nothing that spans the plate (tower, raft, vase); a
        // plate that has any of those is sliced whole.
        if copies.is_some()
            && subs
                .iter()
                .any(|s| s.tool_count > 1 || s.tower_top.is_some() || s.vase.is_some() || s.raft.is_some())
        {
            return Self::build_one(plate, config, tops, ranges, false);
        }
        let own_bounds: Vec<[f64; 4]> = subs.iter().map(|s| s.bounds).collect();
        let mut first = subs.remove(0);
        for f in &subs {
            first.bounds = [
                first.bounds[0].min(f.bounds[0]),
                first.bounds[1].min(f.bounds[1]),
                first.bounds[2].max(f.bounds[2]),
                first.bounds[3].max(f.bounds[3]),
            ];
            first.tool_count = first.tool_count.max(f.tool_count);
            for w in f.warnings.clone() {
                first.push_warning(w);
            }
        }
        first.objects = crate::firmware::footprints(plate);
        // Orca refuses a by-object plate whose objects stand closer than the clearance radius or taller than the
        // gantry; here it slices, and the collision check (`collide`) reports every move that would meet a part.
        first.object_settings = sliced.iter().map(|o| o.settings.clone()).collect();
        first.interleave = !config.print_by_object();
        if first.interleave {
            // Layers of the objects must line up, so they need the same layer plan.
            let (h0, i0) = (first.plan.height, first.plan.first_height);
            for (o, f) in sliced.iter().skip(1).zip(&subs) {
                if (f.plan.height - h0).abs() > 1e-9
                    || (f.plan.first_height - i0).abs() > 1e-9
                    || f.plan.custom != first.plan.custom
                {
                    return Err(Error::Config {
                        key: "plate.objects.settings",
                        reason: format!(
                            "{} uses different layer heights; print by object to mix layer heights",
                            o.name
                        ),
                    });
                }
            }
        }
        first.followers = subs;
        if let Some(placed) = copies {
            first.place_copies(plate, config, tops, &placed, &own_bounds);
        }
        if first.interleave {
            first.plan_interleaved();
        }
        Ok(first)
    }

    /// Where the copies of the sliced objects go (`placed`: per plate object, the plate object it copies and
    /// how far it moves, mm), and the plate's bounds with every copy in place.
    fn place_copies(
        &mut self,
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        placed: &[(usize, [f64; 2])],
        own_bounds: &[[f64; 4]],
    ) {
        let originals: Vec<usize> = (0..placed.len())
            .filter(|&i| placed.get(i).is_some_and(|c| c.0 == i))
            .collect();
        let mut bounds = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for &(of, off) in placed {
            let sub = originals.iter().position(|&o| o == of).unwrap_or(0);
            if let Some(b) = own_bounds.get(sub) {
                bounds = [
                    bounds[0].min(b[0] + off[0]),
                    bounds[1].min(b[1] + off[1]),
                    bounds[2].max(b[2] + off[0]),
                    bounds[3].max(b[3] + off[1]),
                ];
            }
            self.instances.push(Instance {
                sub,
                shift: [mm(off[0]), mm(off[1])],
            });
        }
        self.bounds = bounds;
        let bed = config.bed_rect();
        if bounds[0] < bed[0] || bounds[1] < bed[1] || bounds[2] > bed[2] || bounds[3] > bed[3] {
            self.push_warning(SliceWarning {
                code: WarningCode::OutsideBed,
                message: "Part of the plate is outside the printable area".to_owned(),
                layer: None,
            });
        }
        self.whole_plate = Some(std::sync::Arc::new(WholePlate {
            plate: plate.clone(),
            config: config.clone(),
            tops: tops.map(<[f64]>::to_vec),
            session: std::sync::OnceLock::new(),
        }));
    }

    /// The session's warnings so far.
    pub(crate) fn warnings(&self) -> &[SliceWarning] {
        &self.warnings
    }

    /// The plate objects as copies of the objects of the sequence; empty when each is sliced on its own.
    pub(crate) fn instances(&self) -> &[Instance] {
        &self.instances
    }

    /// The whole plate as one session, for a plate of copies whose first layers meet; None otherwise.
    pub(crate) fn whole_plate(&self) -> Option<&SliceSession> {
        let w = self.whole_plate.as_ref()?;
        w.session
            .once(|| Self::build_one(&w.plate, &w.config, w.tops.as_deref(), &[], false).ok())
            .as_ref()
    }

    fn build_one(
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        ranges: &[HeightRange],
        interleaved: bool,
    ) -> Result<Self> {
        config.check()?;
        let timer = Timer::start();
        let mut raw: Vec<RawPart> = Vec::new();
        // Parts with settings of their own: their welded mesh and the settings.
        let mut part_regions: Vec<PartRegion> = Vec::new();
        let mut painted_supports: Vec<([[f64; 3]; 3], u8)> = Vec::new();
        let mut seam_faces: Vec<crate::seam::SeamFace> = Vec::new();
        let mut fuzzy_paint: Vec<(usize, crate::paint::Facets)> = Vec::new();
        let mut max_z = f64::MIN;
        let mut min_z = f64::MAX;
        let mut xy = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        // Each object's height, for the automatic brim (sized per object, as Orca sizes it).
        let mut object_heights: Vec<f64> = Vec::with_capacity(plate.objects.len());
        // Each object's footprint and top, to refuse one that cannot fit before anything is sliced.
        let mut extents: Vec<(&str, [f64; 4], f64)> = Vec::with_capacity(plate.objects.len());
        for obj in &plate.objects {
            let (mut lo, mut hi) = (f64::MAX, f64::MIN);
            let mut oxy = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
            for part in &obj.mesh.parts {
                if part.triangles.is_empty() {
                    continue;
                }
                let slot = obj.slot_for(&part.name, part.slot);
                let (verts, tris) = weld(&part.positions, &part.triangles, |p| obj.apply(p));
                for v in &verts {
                    lo = lo.min(v[2]);
                    hi = hi.max(v[2]);
                    oxy = [
                        oxy[0].min(v[0]),
                        oxy[1].min(v[1]),
                        oxy[2].max(v[0]),
                        oxy[3].max(v[1]),
                    ];
                }
                if let Some((_, s)) = obj.part_settings.iter().find(|(n, _)| *n == part.name)
                    && s.as_object().is_some_and(|m| !m.is_empty())
                {
                    part_regions.push((verts.clone(), tris.clone(), s.clone()));
                }
                for v in &verts {
                    max_z = max_z.max(v[2]);
                    min_z = min_z.min(v[2]);
                    xy = [xy[0].min(v[0]), xy[1].min(v[1]), xy[2].max(v[0]), xy[3].max(v[1])];
                }
                let paint: crate::paint::Facets = part
                    .paint
                    .iter()
                    .map(|f| (f.v.map(|p| obj.apply(p)), f.state))
                    .collect();
                painted_supports.extend(
                    part.support_paint
                        .iter()
                        .map(|f| (f.v.map(|p| obj.apply(p)), f.state)),
                );
                seam_faces.extend(part.seam_paint.iter().map(|f| crate::seam::SeamFace {
                    tri: f.v.map(|p| obj.apply(p)),
                    enforcer: f.state == 1,
                }));
                if !part.fuzzy_paint.is_empty() {
                    fuzzy_paint.push((
                        raw.len(),
                        part.fuzzy_paint
                            .iter()
                            .map(|f| (f.v.map(|p| obj.apply(p)), f.state))
                            .collect(),
                    ));
                }
                raw.push((slot, verts, tris, paint));
            }
            object_heights.push(if hi >= lo { hi - lo.max(0.0) } else { 0.0 });
            if hi >= lo {
                let name = if obj.mesh.name.is_empty() {
                    &obj.name
                } else {
                    &obj.mesh.name
                };
                extents.push((name.as_str(), oxy, hi));
            }
        }
        if raw.is_empty() || max_z <= 0.0 {
            return Err(Error::EmptyPlate);
        }
        check_fits(&extents, config)?;
        let mut warnings = Vec::new();
        let bed = config.bed_rect();
        if xy[0] < bed[0]
            || xy[1] < bed[1]
            || xy[2] > bed[2]
            || xy[3] > bed[3]
            || max_z > config.printable_height
        {
            warnings.push(SliceWarning {
                code: WarningCode::OutsideBed,
                message: "Part of the plate is outside the printable area".to_owned(),
                layer: None,
            });
        }
        if min_z < -0.001 {
            warnings.push(SliceWarning {
                code: WarningCode::OutsideBed,
                message: "Part of the plate is below the bed; it is cut off at z = 0".to_owned(),
                layer: None,
            });
        }
        if config.enable_support
            && config.support.manual
            && !painted_supports.iter().any(|(_, s)| *s == 1)
            && !plate
                .objects
                .iter()
                .flat_map(|o| &o.volumes)
                .any(|v| v.role == crate::plate::VolumeRole::SupportEnforcer)
        {
            warnings.push(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: "Manual supports print only where enforcers ask, and the plate has none, so none are printed"
                    .to_owned(),
                layer: None,
            });
        }
        if let Some(p) = &config.sparse_infill_pattern_fallback {
            warnings.push(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: format!("Infill pattern {p} is not available yet; using rectilinear"),
                layer: None,
            });
        }
        let plan = if let Some(t) = tops {
            LayerPlan::from_tops(max_z, t, 0.04, 0.8)?
        } else {
            // Over a raft the part's first layer is an ordinary layer, not the thicker first layer of a print.
            let mut plan = LayerPlan::new(
                max_z,
                if crate::raft::layers_asked(config) > 0 {
                    config.layer_height
                } else {
                    config.initial_layer_print_height
                },
                config.layer_height,
            );
            if crate::tower::flag(config, "precise_z_height") {
                let min_h = config.raw_number("min_layer_height", 0.07);
                let min_h = if min_h == 0.0 { 0.07 } else { min_h.max(0.01) };
                let max_raw = config.raw_number("max_layer_height", 0.0);
                let max_h = if max_raw > 0.0 {
                    max_raw
                } else {
                    0.75 * config.nozzle_diameter
                }
                .max(min_h);
                plan.align_height(max_z, min_h, max_h);
            }
            plan
        };
        // sleipnir keeps fixed layers where colors change, and reports what variable layers still
        // cost against fixed ones.
        let (plan, vary_cost) = keep_color_bands(config, plan, &raw, max_z)?;
        // No layer's cutting plane meets a model thinner than half the first layer: nothing would print
        // (Orca: "The print is empty").
        if plan.slice_z.is_empty() {
            return Err(Error::EmptyPlate);
        }
        let parts: Vec<PreparedPart> = par::map_owned(raw, |(slot, v, t, paint)| {
            PreparedPart::new(slot, v, t, &plan).with_paint(paint)
        });
        let mut volumes = Vec::new();
        let mut volume_settings: Vec<serde_json::Value> = Vec::new();
        for obj in &plate.objects {
            for vol in &obj.volumes {
                let tr = vol.transform.as_ref().unwrap_or(&obj.transform);
                for part in vol.mesh.parts.iter().filter(|p| !p.triangles.is_empty()) {
                    let (v, t) = weld(&part.positions, &part.triangles, |p| {
                        crate::plate::PlateObject::apply_with(tr, p)
                    });
                    volumes.push((vol.role, PreparedPart::new(1, v, t, &plan)));
                    volume_settings.push(vol.settings.clone());
                }
            }
        }
        // A part with its own settings prints its area like a modifier shaped as the part.
        for (v, t, settings) in part_regions {
            volumes.push((
                crate::plate::VolumeRole::Modifier,
                PreparedPart::new(1, v, t, &plan),
            ));
            volume_settings.push(settings);
        }
        let mut slots: Vec<u8> = parts
            .iter()
            .flat_map(|p| std::iter::once(p.slot).chain(p.paint.iter().map(|f| f.1)))
            .collect();
        slots.sort_unstable();
        slots.dedup();
        // A vase layer is one outline in one filament; Orca refuses an object of several (`Print::validate`).
        if crate::spiral::enabled(config) && slots.len() > 1 {
            return Err(Error::Config {
                key: "spiral_mode",
                reason: "spiral vase prints one filament; remove the painted colors or the second filament, or turn off spiral vase"
                    .to_owned(),
            });
        }
        let tool_count = slots.last().copied().unwrap_or(1);
        let (top_shell, bottom_shell) = config.shell_layers(config.layer_height.max(0.01));
        let (tool_order, any_top, within_top) = plan_tools(
            &parts,
            &plan,
            &slots,
            (top_shell as usize, bottom_shell as usize),
            &[],
            false,
            &[],
            &crate::toolorder::Choice::of(config, tool_count),
        );
        // A tower is only worth its filament where a layer changes tools inside itself. Changes
        // between layers purge into infill and support instead (`prime_tower_always` keeps the
        // tower for them too, as Orca does).
        let tower_top = if crate::tower::flag(config, "prime_tower_always") {
            any_top
        } else {
            within_top
        };
        let tower_shape = match tower_top {
            Some(t) => crate::tower::place(
                config,
                tool_count,
                &|w| {
                    crate::tower::plan_rows(
                        config,
                        w,
                        tool_count,
                        &tool_order,
                        &|l| plan.thickness(u32::try_from(l).unwrap_or(0)),
                        t as usize,
                    )
                },
                crate::tower::rib_size(
                    config,
                    tool_count,
                    &tool_order,
                    &|l| plan.thickness(u32::try_from(l).unwrap_or(0)),
                    t as usize,
                ),
                &crate::firmware::footprints(plate),
                &plate
                    .objects
                    .iter()
                    .map(|o| {
                        object_config(config, &o.settings)
                            .map_or_else(|_| crate::tower::room(config), |c| crate::tower::room(&c))
                    })
                    .collect::<Vec<f64>>(),
                plan.top(plan.count().saturating_sub(1)),
            )?,
            None => None,
        };
        let tower_rows = tower_shape.map_or(1.0, |p| p.rows);
        let tower_origin = tower_shape.map(|p| p.origin);
        let (overrides, layer_cfg) = resolve_ranges(&plan, config, ranges, &mut warnings)?;
        // Painted ears the model carries, moved to plate coordinates; only those on the bed count.
        let brim_ears: Vec<[f64; 4]> = plate
            .objects
            .iter()
            .flat_map(|o| {
                o.brim_points.iter().filter_map(|b| {
                    let w = o.apply([b[0], b[1], b[2]]);
                    (w[2] <= 1e-4).then(|| [w[0], w[1], w[2], f64::from(b[3])])
                })
            })
            .collect();
        let mut session = Self {
            cache: crate::shells::Cache::default(),
            first_info: FirstInfoMemo::default(),
            parts,
            slots,
            plan,
            tool_count,
            warnings,
            prep_micros: timer.micros(),
            bounds: xy,
            volumes,
            volume_settings,
            painted_supports,
            seam_faces,
            fuzzy_paint,
            followers: Vec::new(),
            object_settings: Vec::new(),
            interleave: false,
            overrides,
            objects: crate::firmware::footprints(plate),
            object_heights,
            layer_cfg,
            support_cfg: config.support.clone(),
            support_width: config.support_width(),
            tower_top,
            tool_order,
            tower_origin,
            tower_rows,
            tower_shape,
            vary_cost,
            comp: crate::compensate::Comp::new(config),
            vase: None,
            interlock_params: crate::interlock::params(config),
            interlock: std::sync::OnceLock::new(),
            conical: std::sync::OnceLock::new(),
            conical_params: conical_params(config),
            polyholes: std::sync::OnceLock::new(),
            brim_ears,
            draft_hull: None,
            skirt_groups: Vec::new(),
            object_hulls: Vec::new(),
            raft: crate::raft::plan(config),
            support: std::sync::OnceLock::new(),
            support_pending: Pending::default(),
            organic_raft: std::sync::OnceLock::new(),
            print: Vec::new(),
            object_print: Vec::new(),
            stack: Vec::new(),
            interleaved: Vec::new(),
            used_tools: Vec::new(),
            support_tools: Vec::new(),
            print_lifted: false,
            independent: false,
            seams: std::sync::OnceLock::new(),
            whole: WholeRegions::default(),
            curls: std::sync::OnceLock::new(),
            lightning: std::sync::OnceLock::new(),
            tree_lightning: std::sync::OnceLock::new(),
            combine: std::sync::OnceLock::new(),
            raft_columns: Vec::new(),
            model_rotation: {
                let turns: Vec<f64> = plate
                    .objects
                    .iter()
                    .filter(|o| o.mesh.parts.iter().any(|p| !p.triangles.is_empty()))
                    .map(z_turn)
                    .collect();
                match turns.split_first() {
                    Some((&a, rest)) if rest.iter().all(|&b| (a - b).abs() < 1e-6) => a,
                    _ => 0.0,
                }
            },
            octree: std::sync::OnceLock::new(),
            instances: Vec::new(),
            whole_plate: None,
            nozzle_map: None,
            collide: None,
            collide_meta: None,
            tower_rows0: 1.0,
        };
        if crate::spiral::enabled(config) {
            let plan = &session.plan;
            session.vase = Some(crate::spiral::base_layers(config, plan.count(), |i| plan.top(i)));
        }
        session.tower_rows0 = session.unsaved_rows(config);
        session.keep_tower_for_purges(config, any_top)?;
        session.plan_support_tools(config)?;
        session.plan_feature_tools(config)?;
        session.plan_painted_tools(config);
        session.replan_tools(config)?;
        session.draft_hull = session.draft_shield_hull(config);
        session.skirt_groups = session.skirt_groups(config);
        if matches!(config.raw.get("print_order"), Some(serde_json::Value::String(t)) if t == "as_obj_list")
            && !interleaved
        {
            session.object_hulls = session
                .objects
                .iter()
                .map(|o| o.hull.iter().map(|p| IntPoint::new(mm(p[0]), mm(p[1]))).collect())
                .collect();
        }
        session.plan_print(config);
        if !interleaved {
            session.plan_raft(config);
        }
        Ok(session)
    }

    /// With `draft_shield` enabled, the skirt follows the convex hull of the whole part on every layer.
    fn draft_shield_hull(&self, config: &PrintConfig) -> Option<Vec<IntPoint<i32>>> {
        let on =
            matches!(config.raw.get("draft_shield"), Some(serde_json::Value::String(t)) if t == "enabled");
        if !on {
            return None;
        }
        let mut pts: Vec<IntPoint<i32>> = self
            .parts
            .iter()
            .flat_map(|p| p.verts.iter())
            .map(|v| IntPoint::new(mm(v[0]), mm(v[1])))
            .collect();
        // The brim counts as occupied too: the skirt keeps its distance from the part and its brim.
        if config.brim_width > 0.0 {
            let first = self.layer_regions(0, Families::new(config), &Micros::default());
            let all: Vec<&Shapes> = first.regions.iter().map(|(_, s)| s).collect();
            let brim = perimeters::offset_round(&perimeters::union_all(&all), mm(config.brim_width));
            pts.extend(
                brim.iter()
                    .filter_map(|s| s.first())
                    .flat_map(|r| r.iter().copied()),
            );
        }
        let hull = convex_hull(pts);
        (hull.len() >= 3).then_some(hull)
    }

    /// `skirt_type` `perobject`: objects whose skirts would reach each other share one; the rest get a skirt
    /// of their own. Orca (`Print::_make_skirt`): each object's occupied outline (here its footprint hull and
    /// its brim) grown by `skirt_distance` plus the loops' width; groups whose grown hulls touch merge, until
    /// none do. Returns the hull of each group, or nothing when there is one group or fewer.
    fn skirt_groups(&self, config: &PrintConfig) -> Vec<Vec<IntPoint<i32>>> {
        let per_object =
            matches!(config.raw.get("skirt_type"), Some(serde_json::Value::String(t)) if t == "perobject");
        if !per_object || config.skirt_loops == 0 || self.objects.len() < 2 || self.draft_hull.is_some() {
            return Vec::new();
        }
        let brim = mm(config.brim_width.max(0.0));
        let mut groups: Vec<Vec<IntPoint<i32>>> = self
            .objects
            .iter()
            .filter(|o| o.hull.len() >= 3)
            .map(|o| {
                let ring: Vec<IntPoint<i32>> =
                    o.hull.iter().map(|p| IntPoint::new(mm(p[0]), mm(p[1]))).collect();
                if brim > 0 {
                    let shapes: Shapes = vec![vec![ring]];
                    let grown = perimeters::offset_round(&shapes, brim);
                    convex_hull(
                        grown
                            .into_iter()
                            .filter_map(|s| s.into_iter().next())
                            .flatten()
                            .collect(),
                    )
                } else {
                    ring
                }
            })
            .collect();
        let reach = mm(config.skirt_distance + f64::from(config.skirt_loops) * skirt_spacing_mm(config));
        loop {
            let pair = groups.iter().enumerate().find_map(|(i, g)| {
                groups
                    .iter()
                    .enumerate()
                    .skip(i + 1)
                    .find_map(|(j, h)| (hull_gap(g, h) < 2.0 * f64::from(reach)).then_some((i, j)))
            });
            let Some((i, j)) = pair else { break };
            let other = groups.remove(j);
            if let Some(g) = groups.get_mut(i) {
                *g = convex_hull(g.iter().chain(other.iter()).copied().collect());
            }
        }
        if groups.len() < 2 { Vec::new() } else { groups }
    }

    /// Changes between layers skip the tower when the new filament's infill can take the flush. Where
    /// that estimate falls short, the tower must reach that layer so no change purges less than the
    /// flush matrix asks (a printer without a chute has nowhere else to put it).
    fn keep_tower_for_purges(&mut self, config: &PrintConfig, any_top: Option<u32>) -> Result<(), Error> {
        let Some(last) = any_top.filter(|_| self.tool_count > 1) else {
            return Ok(());
        };
        if crate::tower::flag(config, "prime_tower_always") || Some(last) <= self.tower_top {
            return Ok(());
        }
        let fam = Families::new(config);
        let micros = Micros::default();
        let mut top = self.tower_top;
        for l in self.tower_top.map_or(0, |t| t + 1)..=last {
            let ended = l
                .checked_sub(1)
                .and_then(|p| self.tool_order.get(p as usize))
                .and_then(|o| o.last())
                .copied();
            let started = self.tool_order.get(l as usize).and_then(|o| o.first()).copied();
            let (Some(from), Some(to)) = (ended, started) else {
                continue;
            };
            if from == to {
                continue;
            }
            let need = crate::tower::change_purge(config, self.tool_count, from, to).wipe;
            if need <= 0.5 {
                continue;
            }
            let regions = self.layer_regions(l, fam, &micros);
            let shapes: Vec<&Shapes> = regions
                .regions
                .iter()
                .filter(|r| r.0 == to)
                .map(|r| &r.1)
                .collect();
            // The infill area is what the walls leave; its extrusion is about density times area times height.
            let walls = mm(f64::from(config.wall_loops) * config.line_width);
            let inner = shapes_area(&perimeters::offset(&perimeters::union_all(&shapes), -walls));
            let h = self.plan.thickness(l);
            let to_mm2 = 1.0 / (crate::geom::SCALE * crate::geom::SCALE);
            let mut room = 0.0;
            if crate::tower::flag_or(config, "flush_into_infill", true)
                || crate::tower::flag(config, "flush_into_objects")
            {
                room += inner * to_mm2 * h * config.sparse_infill_density / 100.0;
            }
            if crate::tower::flag(config, "flush_into_objects") {
                room += inner * to_mm2 * h;
            }
            // The room is an estimate: it has to beat the flush by a quarter, or the tower stays.
            if need * 1.25 > room + 0.5 {
                top = Some(l);
            }
        }
        if top != self.tower_top {
            self.tower_top = top;
            self.place_tower(config)?;
        }
        Ok(())
    }

    /// Mesh edges without a matching reverse edge, over all parts. Counted
    /// on request, since it costs a sort of every edge; slicing reports
    /// contours that fail to close on its own.
    pub fn open_edges(&self) -> usize {
        self.sequence()
            .flat_map(|s| s.parts.iter())
            .map(PreparedPart::open_edges)
            .sum()
    }

    /// Adds a warning that comes back with every slice output.
    pub fn push_warning(&mut self, w: SliceWarning) {
        if !self.warnings.contains(&w) {
            self.warnings.push(w);
        }
    }

    /// Layers in the plate.
    pub fn layer_count(&self) -> u32 {
        if !self.interleaved.is_empty() {
            return u32::try_from(self.interleaved.len()).unwrap_or(u32::MAX);
        }
        if self.interleave {
            return self.sequence().map(Self::plan_count).max().unwrap_or(0);
        }
        self.sequence().map(Self::plan_count).sum::<u32>()
    }

    /// Top of every layer, mm.
    #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
    pub fn layer_tops(&self) -> Vec<f32> {
        let own = |s: &Self| {
            (0..s.plan_count())
                .map(|i| s.print_top(i) as f32)
                .collect::<Vec<f32>>()
        };
        if !self.interleaved.is_empty() {
            return self.interleaved.iter().map(|l| l.0 as f32).collect();
        }
        if self.interleave {
            return self.sequence().map(own).max_by_key(Vec::len).unwrap_or_default();
        }
        let mut all = own(self);
        for f in &self.followers {
            all.extend(own(f));
        }
        all
    }

    /// Highest filament slot on the plate.
    pub fn tool_count(&self) -> u8 {
        self.tool_count
    }

    /// Runs stages 2 to 6 for `layers`. `config` must use the layer heights the
    /// session was built with.
    pub fn slice_range_with(
        &self,
        config: &PrintConfig,
        layers: Range<u32>,
        progress: &dyn Progress,
    ) -> Result<SliceOutput> {
        let mapped = self.mapped_config(config);
        let config = mapped.as_ref();
        let mut out = if self.followers.is_empty() && self.instances.is_empty() {
            self.slice_object_range(config, layers, progress)?
        } else {
            crate::sequence::slice_range(self, config, layers, progress)?
        };
        crate::gcode::settle_cooling(&mut out, config);
        out.filament_map.clone_from(&self.nozzle_map);
        Ok(out)
    }

    /// The objects of the plate in print order: this one, then its followers.
    pub(crate) fn sequence(&self) -> impl Iterator<Item = &Self> {
        std::iter::once(self).chain(self.followers.iter())
    }

    #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
    pub(crate) fn plate_bounds(&self) -> [f32; 4] {
        self.bounds.map(|v| v as f32)
    }

    /// The first layer's area (slices, brim, prime tower) and outlines, worked out once per settings.
    /// The shared per-layer memo, when neighbors do not depend on the layer asking (not in spiral mode).
    fn cache_for_walls(&self) -> Option<&crate::shells::Cache> {
        self.vase.is_none().then_some(&self.cache)
    }

    pub(crate) fn first_layer_info(&self, config: &PrintConfig) -> crate::output::FirstLayerInfo {
        let tag = settings_tag(config);
        let locked = || {
            self.first_info
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        };
        if let Some((t, info)) = locked().as_ref()
            && *t == tag
        {
            return info.clone();
        }
        let info = self.first_layer_info_uncached(config);
        *locked() = Some((tag, info.clone()));
        info
    }

    #[allow(
        clippy::cast_possible_truncation,
        reason = "areas and outlines are single precision"
    )]
    fn first_layer_info_uncached(&self, config: &PrintConfig) -> crate::output::FirstLayerInfo {
        let fam = Families::new(&config.for_first_layer());
        let micros = Micros::default();
        let here = self.layer_regions(0, fam, &micros);
        let all: Vec<&Shapes> = here.regions.iter().map(|(_, s)| s).collect();
        let union = perimeters::union_all(&all);
        let unit = crate::geom::SCALE * crate::geom::SCALE;
        // Only a print lower than 0.3 mm reads the area (`hold_chamber_temp_for_flat_print`), and the brim's
        // share takes a large offset, so taller prints leave it out.
        let flat = self.plate_top() < 0.31;
        let mut area = if flat { shapes_area(&union) / unit } else { 0.0 };
        let kind = crate::brim::Kind::of(config);
        if flat && kind != crate::brim::Kind::Off && config.brim_width > 0.0 {
            let grown = perimeters::offset_round(&union, mm(config.brim_width));
            area += (shapes_area(&grown) / unit - area).max(0.0);
        }
        if flat && self.tower_top.is_some() {
            let w = config.raw_number("prime_tower_width", 35.0).max(5.0);
            area += w * w;
        }
        let rings = union
            .iter()
            .flat_map(|s| s.iter())
            .map(|r| {
                r.iter()
                    .map(|p| {
                        [
                            (f64::from(p.x) / crate::geom::SCALE) as f32,
                            (f64::from(p.y) / crate::geom::SCALE) as f32,
                        ]
                    })
                    .collect()
            })
            .collect();
        // what orca's skirt hull starts from (`Print::_make_skirt`): the outlines before the elephant foot
        // compensation of the layers the skirt reaches, all of them under a draft shield
        let shield = config.skirt_loops > 0
            && matches!(config.raw.get("draft_shield"), Some(serde_json::Value::String(t)) if t == "enabled");
        let mut pts: Vec<IntPoint<i32>> = Vec::new();
        if shield {
            pts.extend(
                self.parts
                    .iter()
                    .flat_map(|p| p.verts.iter())
                    .map(|v| IntPoint::new(mm(v[0]), mm(v[1]))),
            );
        } else {
            for l in 0..config.skirt_height.clamp(1, self.plan.count().max(1)) {
                let other;
                let lr = if l == 0 {
                    &here
                } else {
                    other = self.layer_regions(l, Families::new(config), &micros);
                    &other
                };
                let outline = match (&lr.lslices, &lr.raw) {
                    (Some(s), _) | (None, Some(s)) => s.clone(),
                    _ => perimeters::union_all(&lr.regions.iter().map(|(_, s)| s).collect::<Vec<_>>()),
                };
                pts.extend(
                    outline
                        .iter()
                        .filter_map(|s| s.first())
                        .flat_map(|r| r.iter().copied()),
                );
            }
        }
        let skirt_outline = convex_hull(pts)
            .iter()
            .map(|p| {
                [
                    f64::from(p.x) / crate::geom::SCALE,
                    f64::from(p.y) / crate::geom::SCALE,
                ]
            })
            .collect();
        crate::output::FirstLayerInfo {
            area_mm2: area as f32,
            rings,
            skirt_outline,
        }
    }

    pub(crate) fn footprints(&self) -> &[crate::output::ObjectFootprint] {
        &self.objects
    }

    pub(crate) fn is_interleaved(&self) -> bool {
        self.interleave
    }

    /// Gives a by-object plate its collision model (`api::build_session` makes it).
    pub(crate) fn set_collide(&mut self, model: std::sync::Arc<crate::collide::Model>) {
        self.collide = Some(model);
    }

    /// Gives a plate printed by layer the report's facts, for its crossing paths and keep-out zones.
    pub(crate) fn set_collide_meta(&mut self, meta: crate::collide::Meta) {
        self.collide_meta = Some(std::sync::Arc::new(meta));
    }

    pub(crate) fn collide(&self) -> Option<&crate::collide::Model> {
        self.collide.as_deref()
    }

    /// What the collision report needs besides the hits, on a by-object plate.
    pub fn collide_meta(&self) -> Option<&crate::collide::Meta> {
        self.collide
            .as_deref()
            .map(|m| &m.meta)
            .or(self.collide_meta.as_deref())
    }

    /// The objects of this by-object plate could print layer by layer instead: one layer plan, no spiral vase.
    pub(crate) fn could_print_by_layer(&self, config: &PrintConfig) -> bool {
        let (h, f, c) = (self.plan.height, self.plan.first_height, &self.plan.custom);
        !crate::spiral::enabled(config)
            && self.followers.iter().all(|s| {
                (s.plan.height - h).abs() <= 1e-9
                    && (s.plan.first_height - f).abs() <= 1e-9
                    && s.plan.custom == *c
            })
    }

    /// The settings of the `k`th object of the sequence: the plate's plus its own overrides.
    pub(crate) fn object_config(&self, k: usize, config: &PrintConfig) -> Result<PrintConfig> {
        match self.object_settings.get(k) {
            Some(v) => object_config(config, v),
            None => Ok(config.clone()),
        }
    }

    /// True when the `k`th object of the sequence carries settings of its own.
    pub(crate) fn has_object_settings(&self, k: usize) -> bool {
        self.object_settings.get(k).is_some_and(|v| !v.is_null())
    }

    /// The height range settings this object's last layer prints with, when a range covers it.
    pub(crate) fn last_layer_override(&self) -> Option<&serde_json::Value> {
        let last = self.plan.count().checked_sub(1)?;
        let i = usize::from(*self.layer_cfg.get(last as usize)?).checked_sub(1)?;
        self.overrides.get(i)
    }

    /// Supports printed with a filament of their own (`support_filament`, `support_interface_filament`;
    /// 0 is whichever filament is active, as in Orca): those filaments join the tool order of the
    /// layers that have support, and the prime tower is planned again for them.
    fn plan_support_tools(&mut self, config: &PrintConfig) -> Result<()> {
        let (base, iface) = (
            support_slot(config, "support_filament"),
            support_slot(config, "support_interface_filament"),
        );
        if !config.enable_support
            || (base == 0 && iface == 0)
            || (config.support.manual && !self.has_enforcers())
        {
            return Ok(());
        }
        let n = self.plan.count();
        let layers = self.support_layers(config);
        let extra: Vec<Vec<u8>> = (0..n as usize)
            .map(|l| {
                let Some(sl) = layers.get(l) else {
                    return Vec::new();
                };
                let mut v = Vec::new();
                // The interface prints with the base filament when it has none of its own.
                let base_here = !sl.base.is_empty() || (iface == 0 && !sl.interface.is_empty());
                if base > 0 && base_here {
                    v.push(base);
                }
                if iface > 0 && !sl.interface.is_empty() {
                    v.push(iface);
                }
                v
            })
            .collect();
        for t in [base, iface] {
            if t > 0 && !self.slots.contains(&t) {
                self.slots.push(t);
            }
        }
        self.slots.sort_unstable();
        self.tool_count = self.tool_count.max(base).max(iface);
        self.support_tools = extra;
        self.replan_tools(config)
    }

    /// Plans the tool order again: from what each layer really prints when that is known
    /// (`used_tools`), else from the parts and the support filaments, with the first layer in
    /// Orca's order (`ToolOrdering::generate_first_layer_tool_order`: the outer wall filaments,
    /// the one whose smallest island is largest first).
    fn replan_tools(&mut self, config: &PrintConfig) -> Result<()> {
        if self.slots.len() < 2 && self.used_tools.iter().all(|u| u.len() < 2) && self.tool_count < 2 {
            return Ok(());
        }
        let first = self.first_layer_order(config);
        let (top_shell, bottom_shell) = config.shell_layers(config.layer_height.max(0.01));
        let exact = !self.used_tools.is_empty();
        let extra = if exact {
            &self.used_tools
        } else {
            &self.support_tools
        };
        let (order, any_top, within_top) = plan_tools(
            &self.parts,
            &self.plan,
            &self.slots,
            (top_shell as usize, bottom_shell as usize),
            extra,
            exact,
            &first,
            &crate::toolorder::Choice::of(config, self.tool_count),
        );
        self.tool_order = order;
        self.tower_top = if crate::tower::flag(config, "prime_tower_always") {
            any_top
        } else {
            within_top
        };
        self.place_tower(config)?;
        self.keep_tower_for_purges(config, any_top)
    }

    /// The prime tower as placed (shape and corner), for settings `cfg`.
    fn tower(&self, cfg: &PrintConfig) -> Option<crate::tower::Tower> {
        let height = self.tower_top.map_or(0.0, |t| self.plan.top(t));
        match &self.tower_shape {
            Some(p) => p.tower(cfg, self.tool_count),
            None => crate::tower::Tower::new(cfg, self.tool_count, self.tower_rows),
        }
        .map(|t| t.ribbed(cfg, height, self.plan.top(0)))
    }

    /// Sizes the prime tower for its deepest layer and places it clear of the objects.
    fn place_tower(&mut self, config: &PrintConfig) -> Result<()> {
        let Some(top) = self.tower_top else {
            return Ok(());
        };
        // What each object's first layer lays down past its hull, with its own settings.
        let rooms: Vec<f64> = (0..self.objects.len())
            .map(|k| {
                self.object_config(k, config)
                    .map_or_else(|_| crate::tower::room(config), |c| crate::tower::room(&c))
            })
            .collect();
        let plan = &self.plan;
        let (tools, order) = (self.tool_count, &self.tool_order);
        self.tower_shape = crate::tower::place(
            config,
            tools,
            &|w| {
                crate::tower::plan_rows(
                    config,
                    w,
                    tools,
                    order,
                    &|l| plan.thickness(u32::try_from(l).unwrap_or(0)),
                    top as usize,
                )
            },
            crate::tower::rib_size(
                config,
                tools,
                order,
                &|l| plan.thickness(u32::try_from(l).unwrap_or(0)),
                top as usize,
            ),
            &self.objects,
            &rooms,
            plan.top(plan.count().saturating_sub(1)),
        )?;
        self.tower_rows = self.tower_shape.map_or(1.0, |p| p.rows);
        self.tower_origin = self.tower_shape.map(|p| p.origin);
        self.tower_rows0 = self.unsaved_rows(config);
        Ok(())
    }

    /// The tower's rows before the saves of a type 2 tower, at its placed width.
    fn unsaved_rows(&self, config: &PrintConfig) -> f64 {
        let (Some(top), Some(shape)) = (self.tower_top, self.tower_shape) else {
            return self.tower_rows;
        };
        if !crate::tower::saves_on_last_wipe(config) {
            return self.tower_rows;
        }
        let plan = &self.plan;
        crate::tower::plan_rows_unsaved(
            config,
            shape.width,
            self.tool_count,
            &self.tool_order,
            &|l| plan.thickness(u32::try_from(l).unwrap_or(0)),
            top as usize,
        )
    }

    /// The first layer's outer wall filaments in Orca's order: by the area of their smallest island
    /// (one that survives an inset of a fifth of the first layer's line width), largest first, ties
    /// by filament.
    fn first_layer_order(&self, config: &PrintConfig) -> Vec<u8> {
        if self.plan.count() == 0 {
            return Vec::new();
        }
        let first_cfg = config.for_first_layer();
        let regions = self.layer_regions(0, Families::new(&first_cfg), &Micros::default());
        let inset = mm(0.2 * first_cfg.line_width);
        let mut smallest: Vec<(u8, f64)> = Vec::new();
        for (ri, (slot, shapes)) in regions.regions.iter().enumerate() {
            let own;
            let cfg = match regions.region_cfg.get(ri).copied().unwrap_or(0) {
                0 => config,
                k => match self.modifier_settings().get(usize::from(k) - 1) {
                    Some(v) => {
                        own = object_config(config, v).unwrap_or_else(|_| config.clone());
                        &own
                    }
                    None => config,
                },
            };
            let tool = feature_tools(cfg, *slot).outer;
            for island in shapes {
                if perimeters::offset(&vec![island.clone()], -inset).is_empty() {
                    continue;
                }
                let area = island
                    .first()
                    .map_or(0.0, |r| shapes_area(&vec![vec![r.clone()]]));
                match smallest.iter_mut().find(|(t, _)| *t == tool) {
                    Some(e) => e.1 = e.1.min(area),
                    None => smallest.push((tool, area)),
                }
            }
        }
        crate::sorting::sort_by_key(&mut smallest, |a| a.0);
        let mut order: Vec<(u8, f64)> = Vec::new();
        for e in smallest {
            let at = order.iter().position(|o| o.1 < e.1).unwrap_or(order.len());
            order.insert(at, e);
        }
        order.into_iter().map(|e| e.0).collect()
    }

    /// The filament object layer `l` ends on: the last of its planned tools that it really prints
    /// (its regions, or its support). None when it prints nothing.
    fn object_end<'a>(
        &self,
        cfg: &PrintConfig,
        l: u32,
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
    ) -> Option<u8> {
        let used = get(l)?;
        let order = self.tool_order.get(l as usize)?;
        let (base, iface) = (
            support_slot(cfg, "support_filament"),
            support_slot(cfg, "support_interface_filament"),
        );
        let support = (base > 0 || iface > 0)
            && cfg.enable_support
            && self
                .support_at(cfg, l)
                .is_some_and(|(sl, ..)| !sl.base.is_empty() || !sl.interface.is_empty());
        if let Some(u) = self.used_tools.get(l as usize) {
            return order.iter().rev().copied().find(|t| u.contains(t));
        }
        order
            .iter()
            .rev()
            .copied()
            .find(|t| used.slots().any(|s| s == *t) || (support && (*t == base || *t == iface)))
    }

    /// The filament print layer `p` ends on, looking further down past layers that print nothing
    /// (at most six), 0 before the first change.
    fn print_end<'a>(
        &self,
        cfg: &PrintConfig,
        p: u32,
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
    ) -> u8 {
        let mut p = Some(p);
        for _ in 0..6 {
            let Some(at) = p else { break };
            let found = match self.print.get(at as usize) {
                None => self.object_end(cfg, at, get),
                Some(pl) => match pl.object {
                    Some(l) => self.object_end(cfg, l, get),
                    None => pl
                        .support
                        .and_then(|s| self.stack.get(s as usize))
                        .and_then(|st| {
                            let (b, i) = support_tools(cfg, self.print_start(cfg, at, get));
                            if !st.layer.interface.is_empty() {
                                Some(i)
                            } else if st.layer.base.is_empty() {
                                None
                            } else {
                                Some(b)
                            }
                        }),
                },
            };
            if let Some(t) = found {
                return t;
            }
            p = at.checked_sub(1);
        }
        0
    }

    /// With a filament map, the filament each nozzle holds when print layer `p` starts, from the planned
    /// orders of the layers below (`LayerPaths::held_before`).
    fn held_before(&self, p: u32) -> Vec<u8> {
        let Some(map) = &self.nozzle_map else {
            return Vec::new();
        };
        let nozzles = map.nozzle.iter().map(|&n| usize::from(n) + 1).max().unwrap_or(1);
        let mut held = vec![0u8; nozzles];
        for &t in self.tool_order.iter().take(p as usize).flatten() {
            if let Some(h) = held.get_mut(map.nozzle_of(t)) {
                *h = t;
            }
        }
        held
    }

    /// The tool changes the plan makes below print layer `p` (`LayerPaths::changes_before`).
    fn changes_before(&self, p: u32) -> u32 {
        let mut order = self.tool_order.iter().take(p as usize).flatten();
        let Some(&first) = order.next() else { return 0 };
        order
            .fold((first, 0u32), |(at, n), &t| (t, n + u32::from(t != at)))
            .1
    }

    /// The tools the plan prints with below print layer `p` (`LayerPaths::tools_before`).
    fn tools_before(&self, p: u32) -> u64 {
        self.tool_order
            .iter()
            .take(p as usize)
            .flatten()
            .fold(0, |m, &t| m | 1u64 << u32::from(t.max(1) - 1).min(63))
    }

    /// The filament print layer `p` starts on: the one the print layer under it ended on.
    fn print_start<'a>(
        &self,
        cfg: &PrintConfig,
        p: u32,
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
    ) -> u8 {
        p.checked_sub(1).map_or(0, |b| self.print_end(cfg, b, get))
    }

    /// Features on filaments of their own (`*_filament_id`): the plate is sliced once here to learn
    /// which filaments each layer really prints (a layer's top and bottom surfaces and its infill
    /// depend on the layers around it), and the tool order is planned from that, as Orca plans it
    /// from the layer's extrusions.
    fn plan_feature_tools(&mut self, config: &PrintConfig) -> Result<()> {
        let base = serde_json::Value::Object(config.raw.clone().into_iter().collect());
        let mut values: Vec<&serde_json::Value> = vec![&base];
        values.extend(self.overrides.iter());
        values.extend(self.volume_settings.iter());
        if !uses_feature_tools(&values) {
            return Ok(());
        }
        let n = self.plan.count();
        let out = self.slice_object_range(config, 0..n, &crate::NoProgress)?;
        let used: Vec<Vec<u8>> = out
            .layers
            .iter()
            .map(|l| {
                let mut v: Vec<u8> = l
                    .paths
                    .iter()
                    .filter(|p| p.feature != crate::output::Feature::PrimeTower)
                    .map(|p| p.tool)
                    .collect();
                v.sort_unstable();
                v.dedup();
                v
            })
            .collect();
        for &t in used.iter().flatten() {
            if !self.slots.contains(&t) {
                self.slots.push(t);
            }
            self.tool_count = self.tool_count.max(t);
        }
        self.slots.sort_unstable();
        self.used_tools = used;
        Ok(())
    }

    /// Several filaments: the regions of every layer are cut here to learn which filaments each layer really
    /// prints, as Orca's tool ordering reads the sliced layers (`ToolOrdering`, after the painted
    /// segmentation). From the parts alone, a part claims its filament on every layer between its lowest and
    /// highest point and a painted triangle its color on every layer it spans, so layers looked like they
    /// change filament when they do not, and the prime tower was sized for purges that never happen. The
    /// slice takes the cut regions over (`whole_regions`, `take_whole`).
    fn plan_painted_tools(&mut self, config: &PrintConfig) {
        if !self.used_tools.is_empty() || self.slots.len() < 2 {
            return;
        }
        let regions = self.whole_regions(Families::new(config), &Micros::default());
        let used: Vec<Vec<u8>> = regions
            .iter()
            .enumerate()
            .map(|(l, r)| {
                let mut v: Vec<u8> = r
                    .regions
                    .iter()
                    .filter(|(_, s)| !s.is_empty())
                    .map(|(t, _)| *t)
                    .collect();
                if let Some(s) = self.support_tools.get(l) {
                    v.extend(s.iter().copied());
                }
                v.sort_unstable();
                v.dedup();
                v
            })
            .collect();
        drop(regions);
        self.used_tools = used;
    }

    /// Merges the print layers of the objects printed layer by layer, by height, when some object
    /// has layers the others do not (support on layers of its own height).
    fn plan_interleaved(&mut self) {
        if self.sequence().all(|s| s.print.is_empty()) {
            return;
        }
        let objects = self.sequence().count();
        let mut all: Vec<(f64, usize, u32)> = self
            .sequence()
            .enumerate()
            .flat_map(|(k, s)| (0..s.plan_count()).map(move |i| (s.print_top(i), k, i)))
            .collect();
        crate::sorting::sort_by(&mut all, |a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut merged: Vec<(f64, Vec<Option<u32>>)> = Vec::new();
        let mut i = 0;
        while let Some(&(z0, _, _)) = all.get(i) {
            let mut of = vec![None; objects];
            let mut last = z0;
            while let Some(&(z, k, l)) = all.get(i).filter(|e| e.0 <= z0 + 1e-4) {
                if let Some(slot) = of.get_mut(k).filter(|s| s.is_none()) {
                    *slot = Some(l);
                    last = z;
                    i += 1;
                } else {
                    break;
                }
            }
            merged.push((f64::midpoint(z0, last), of));
        }
        self.interleaved = merged;
    }

    /// The layers of the plate printed layer by layer: each print layer's top and the print layer of
    /// each object in it. Empty when the objects share their layers.
    pub(crate) fn interleaved_layers(&self) -> &[(f64, Vec<Option<u32>>)] {
        &self.interleaved
    }

    /// Print layers of this object: its own layers plus the support layers between them.
    pub(crate) fn plan_count(&self) -> u32 {
        if self.print.is_empty() {
            self.plan.count()
        } else {
            u32::try_from(self.print.len()).unwrap_or(u32::MAX)
        }
    }

    /// Top of print layer `p`, mm.
    fn print_top(&self, p: u32) -> f64 {
        if self.print.is_empty() {
            self.plan.top(p)
        } else {
            self.print.get(p as usize).map_or(0.0, |l| l.top)
        }
    }

    pub(crate) fn plate_top(&self) -> f64 {
        self.print_top(self.plan_count().saturating_sub(1))
    }

    /// Puts the raft under the part: the raft's layers come first among the print layers and the part's
    /// layers move up by the raft's height and the gap to it (Orca's `SlicingParameters` with a raft).
    fn plan_raft(&mut self, config: &PrintConfig) {
        let Some(mut raft) = self.raft.take() else { return };
        let n = self.plan.count();
        let old: Vec<crate::layers::PrintLayer> = if self.print.is_empty() {
            (0..n)
                .map(|l| crate::layers::PrintLayer {
                    top: self.plan.top(l),
                    height: self.plan.thickness(l),
                    object: Some(l),
                    support: None,
                    raft: None,
                })
                .collect()
        } else {
            std::mem::take(&mut self.print)
        };
        // The raft grows from what the part's first layer covers.
        let first = self.layer_regions(0, Families::new(&config.for_first_layer()), &Micros::default());
        raft.first_layer = slice_shapes(&first);
        // Normal supports stretch the raft's contact area to their grid; tree supports plan their own raft.
        if !config.support.tree {
            let center = [
                f64::midpoint(self.bounds[0], self.bounds[2]),
                f64::midpoint(self.bounds[1], self.bounds[3]),
            ];
            let (support, w, lh) = (
                config.support_config(),
                mm(config.support_width()),
                config.layer_height,
            );
            raft.stretch(|a| crate::support::to_grid(a, &support, w, lh, center));
        }
        let mut print: Vec<crate::layers::PrintLayer> = raft
            .layers
            .iter()
            .enumerate()
            .map(|(k, l)| crate::layers::PrintLayer {
                top: l.top,
                height: l.height,
                object: None,
                support: None,
                raft: Some(u32::try_from(k).unwrap_or(u32::MAX)),
            })
            .collect();
        let lift = if self.print_lifted { 0.0 } else { raft.offset };
        print.extend(old.into_iter().map(|mut l| {
            l.top += lift;
            l
        }));
        self.object_print = vec![0; n as usize];
        for (p, l) in print.iter().enumerate() {
            if let Some(slot) = l.object.and_then(|o| self.object_print.get_mut(o as usize)) {
                *slot = u32::try_from(p).unwrap_or(u32::MAX);
            }
        }
        self.print = print;
        self.raft = Some(raft);
    }

    /// Print layers under the part that are the raft's.
    fn raft_layers(&self) -> u32 {
        self.raft.as_ref().map_or(0, crate::raft::Plan::count)
    }

    /// Plans support on layers of its own height when the settings ask for it
    /// (`independent_support_layer_height`, Orca's default) and merges those layers with the
    /// object's. Organic trees and spiral vases keep support on the object's layers (Orca turns
    /// support off in vase mode).
    fn plan_print(&mut self, config: &PrintConfig) {
        let s = &config.support;
        let tree = s.style.is_tree() || s.tree;
        // Organic trees stay on the object's layers in Orca (TreeSupport3D has no stack of its own).
        let organic = Self::is_organic(config);
        // Slim, strong and hybrid trees are planned on the object's layers (src/treeclassic.rs).
        let classic = s.style.is_classic_tree();
        if !(config.enable_support
            && (!s.manual || self.has_enforcers())
            && !organic
            && !(classic && (self.raft.is_some() || !config.independent_support_layer_height()))
            && (config.independent_support_layer_height() || (self.raft.is_some() && !tree))
            && self.vase.is_none())
        {
            return;
        }
        let independent = config.independent_support_layer_height();
        let n = self.plan.count();
        let input = self.support_input(config);
        // Over a raft the object's layers are lifted by the raft and its gap, and support stands on
        // the raft (Orca's `SlicingParameters` with a raft).
        let raft = self.raft.as_ref().map(|r| {
            let last = r.layers.last();
            let interface_top = if r.layers.len() > 1 {
                r.layers.get(r.layers.len() - 2).map_or(0.0, |l| l.top)
            } else {
                0.0
            };
            (
                r.offset,
                crate::support::RaftHeights {
                    interface_top,
                    contact_top: last.map_or(0.0, |l| l.top),
                    contact_h: last.map_or(0.0, |l| l.height),
                    layers: r.layers.len(),
                },
            )
        });
        let lift = raft.map_or(0.0, |r| r.0);
        let tops: Vec<f64> = (0..n).map(|l| self.plan.top(l) + lift).collect();
        let min_h = (0..n)
            .map(|l| self.plan.thickness(l))
            .fold(config.raw_number("min_layer_height", 0.07).max(0.01), f64::min);
        let max_raw = config.raw_number("max_layer_height", 0.0);
        let max_h = if max_raw > 0.0 {
            max_raw
        } else {
            0.75 * config.nozzle_diameter
        }
        .max(config.raw_number("min_layer_height", 0.07).max(0.01));
        let heights = crate::support::StackHeights {
            first: if raft.is_some() {
                self.raft
                    .as_ref()
                    .and_then(|r| r.layers.first())
                    .map_or(config.layer_height, |l| l.height)
            } else {
                self.plan.thickness(0)
            },
            min_h,
            max_h,
            bottom_contact_h: config.layer_height,
            raft: raft.map(|r| r.1),
        };
        let stack = if !independent {
            // Support on the object's layers over a raft: Orca adds one base layer under the object,
            // from the raft's interface layers up to the object's bottom.
            let (lift_z, r) = raft.map_or((0.0, None), |r| (r.0, Some(r.1)));
            let below = r.map_or(0.0, |r| r.interface_top);
            let synced = self.support_layers(config);
            let first = synced
                .first()
                .map(|l| perimeters::union_all(&[&l.base, &l.interface]))
                .unwrap_or_default();
            let area = crate::support::clear_of_part(
                &first,
                lift_z,
                below,
                &input.models,
                &tops,
                &input.thickness,
                &config.support_config(),
            );
            let area = crate::support::open(&area, mm(config.support_width()));
            if r.is_some() {
                // The columns are the first support layer's base (Orca's `columns_base`), not its contact.
                let base = synced.first().map(|l| l.base.clone()).unwrap_or_default();
                let cols = crate::support::clear_of_part(
                    &base,
                    lift_z,
                    below,
                    &input.models,
                    &tops,
                    &input.thickness,
                    &config.support_config(),
                );
                self.raft_columns = crate::support::open(&cols, mm(config.support_width()));
            }
            // A raft of one layer is only its contact layer, which the object rests on directly.
            if area.is_empty() || r.is_none_or(|r| r.layers < 2) {
                Vec::new()
            } else {
                vec![crate::support::StackLayer {
                    top: lift_z,
                    height: lift_z - below,
                    layer: crate::support::SupportLayer {
                        base: area,
                        ..crate::support::SupportLayer::default()
                    },
                }]
            }
        } else if classic {
            // Slim, strong and hybrid trees plan their own layer heights (Orca's `plan_layer_heights`).
            self.classic_tree_plan(config, &input)
                .into_iter()
                .filter(|(h, _)| h.h > 1e-6)
                .map(|(h, layer)| crate::support::StackLayer {
                    top: h.z,
                    height: h.h,
                    layer,
                })
                .collect()
        } else {
            crate::support::stack(
                &input.models,
                &tops,
                &input.thickness,
                &config.support_config(),
                mm(config.support_width()),
                &input.force,
                &input.block,
                input.center,
                heights,
            )
        };
        if stack.is_empty() {
            return;
        }
        let object: Vec<(f64, f64)> = (0..n)
            .map(|l| (self.plan.top(l) + lift, self.plan.thickness(l)))
            .collect();
        let support: Vec<(f64, f64)> = stack.iter().map(|l| (l.top, l.height)).collect();
        self.print = crate::layers::merge_layers(&object, &support);
        self.print_lifted = lift > 0.0;
        self.independent = independent;
        self.object_print = vec![0; n as usize];
        for (p, l) in self.print.iter().enumerate() {
            if let Some(slot) = l.object.and_then(|o| self.object_print.get_mut(o as usize)) {
                *slot = u32::try_from(p).unwrap_or(u32::MAX);
            }
        }
        self.stack = stack;
    }

    /// The support of object layer `layer`: the support layer, the flow of its beads against this
    /// layer's (support layers of their own height can be thicker), its index and the cutting plane.
    fn support_at(
        &self,
        cfg: &PrintConfig,
        layer: u32,
    ) -> Option<(&crate::support::SupportLayer, f32, u32, f64)> {
        if self.stack.is_empty() || !self.independent {
            let z = self.plan.slice_z.get(layer as usize).copied().unwrap_or(0.0);
            // Over a raft no support layer is the print's first (the dense first-layer pad is the raft's).
            let index = layer + u32::from(self.raft.is_some());
            return self
                .support_layers(cfg)
                .get(layer as usize)
                .map(|sl| (sl, 0.0, index, z));
        }
        let p = self.object_print.get(layer as usize)?;
        let s = self.print.get(*p as usize)?.support?;
        let st = self.stack.get(s as usize)?;
        // Over a raft no support layer is the print's first (the dense first-layer pad is the raft's).
        let index = s + u32::from(self.raft.is_some());
        let lift = if self.print_lifted {
            self.raft.as_ref().map_or(0.0, |r| r.offset)
        } else {
            0.0
        };
        Some((
            &st.layer,
            bead_ratio(cfg.support_width(), st.height, self.plan.thickness(layer)),
            index,
            st.top - st.height / 2.0 - lift,
        ))
    }

    /// A print layer that holds only support.
    /// A print layer that holds only support. `below` is the object layer under it and `ended` the
    /// filament the print layer under it ended on, which prints this one (Orca's support filament 0).
    fn support_only_paths(
        &self,
        p: u32,
        pl: &crate::layers::PrintLayer,
        cfg: &PrintConfig,
        below: Option<u32>,
        ended: Option<u8>,
    ) -> LayerPaths {
        #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
        let mut out = LayerPaths {
            index: p,
            local: p,
            z: pl.top as f32,
            height: pl.height as f32,
            ..LayerPaths::default()
        };
        let Some(st) = pl.support.and_then(|s| self.stack.get(s as usize)) else {
            return out;
        };
        let lift = if self.print_lifted {
            self.raft.as_ref().map_or(0.0, |r| r.offset)
        } else {
            0.0
        };
        let index = pl.support.unwrap_or(0) + u32::from(self.raft.is_some());
        let sp = self.support_paths(cfg, &st.layer, index, st.top - st.height / 2.0 - lift);
        out.support_areas = support_islands(&st.layer);
        let tool = ended.or_else(|| self.slots.first().copied()).unwrap_or(1);
        out.start_tool = tool;
        out.tools_before = self.tools_before(p);
        out.changes_before = self.changes_before(p);
        out.held_before = self.held_before(p);
        let mut works: Vec<ToolWork> = Vec::new();
        place_support(&mut works, sp, 0.0, support_tools(cfg, tool));
        // Starting on the filament the layer below ended on saves a change.
        crate::sorting::sort_by_key(&mut works, |w| w.tool != tool);
        let mut current = tool;
        let mut used_rows = 0.0;
        for w in &mut works {
            if w.tool != current && self.tool_count > 1 {
                let mut v = crate::tower::change_purge(cfg, self.tool_count, current, w.tool).wipe;
                if crate::tower::flag_or(cfg, "flush_into_support", true) {
                    v -= work_support_volume(w, cfg.line_width, pl.height);
                }
                if let (true, Some(t)) = (v > 0.5, self.tower(cfg)) {
                    let t = self.tower_origin.map_or(t, |o| t.at(o));
                    let (path, rows) = t.purge(v, pl.height, false, used_rows);
                    used_rows += rows;
                    w.tower.extend(path);
                }
            }
            current = w.tool;
        }
        let Some(work) = works.first_mut() else {
            return out;
        };
        // The prime tower keeps rising through support layers up to its last object layer; it is
        // only walled here, as no filament changes on a support layer.
        if self.tool_count > 1
            && let Some(b) = below
            && self.tower_top.is_some_and(|t| b < t)
            && crate::tower::flag_or(cfg, "prime_tower_outline", true)
            && !crate::tower::flag(cfg, "wipe_tower_no_sparse_layers")
            && let Some(tower) = self.tower(cfg)
        {
            let tower = self.tower_origin.map_or(tower, |o| tower.at(o));
            work.tower.insert(0, tower.wall(false, pl.top));
        }
        paths::plan_layer(
            &mut out,
            &works,
            cfg,
            p,
            (&[], pl.top, None),
            None,
            &self.object_hulls,
        );
        out
    }

    /// A raft layer, printed by the support filament.
    fn raft_paths(&self, p: u32, k: usize, config: &PrintConfig, first_cfg: &PrintConfig) -> LayerPaths {
        let Some(raft) = &self.raft else {
            return LayerPaths::default();
        };
        let center = [
            f64::midpoint(self.bounds[0], self.bounds[2]),
            f64::midpoint(self.bounds[1], self.bounds[3]),
        ];
        let tool = self.slots.first().copied().unwrap_or(1);
        // The skirt goes round the raft's first layer on the layers it is asked for.
        let skirt = if (config.skirt_loops > 0 || self.draft_hull.is_some())
            && (p < config.skirt_height || self.draft_hull.is_some())
        {
            let columns = if raft.layers.len() > 1 {
                self.raft_columns.clone()
            } else {
                Vec::new()
            };
            let area = raft.area_with(crate::raft::Kind::First, &raft.first_layer, &columns);
            let here = LayerRegions {
                regions: vec![(tool, area)],
                ..LayerRegions::default()
            };
            skirt_loops(
                &here,
                &[],
                config,
                self.draft_hull.as_deref(),
                &self.skirt_groups,
                (usize::from(self.tool_count), 0),
            )
        } else {
            Vec::new()
        };
        // Organic branches pass through the raft down to the bed: the raft prints around them (Orca's
        // `generate_support_toolpaths` trims the raft layers by the tree polygons).
        let trees = if config.enable_support && Self::is_organic(config) {
            let _ = self.support_layers(config);
            self.organic_raft
                .get()
                .and_then(|v| v.get(k))
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        // The support columns stand on the raft: a raft of one layer prints their widened first layer beside
        // its contact area (Orca's `generate_raft_base` with no raft layers of its own), a taller raft takes
        // them into its layers.
        let columns = if raft.layers.len() > 1 {
            self.raft_columns.clone()
        } else {
            Vec::new()
        };
        let pad = if raft.layers.len() == 1 && !self.raft_columns.is_empty() {
            // Columns that lie within the raft's contact area are the contact (Orca has no base layer there).
            let contact = raft.area(crate::raft::Kind::Contact, &raft.first_layer);
            let base = crate::support::open(
                &perimeters::difference(&self.raft_columns, &contact),
                mm(config.support_width()),
            );
            let layer = crate::support::SupportLayer {
                base,
                interface: contact,
                ..crate::support::SupportLayer::default()
            };
            self.support_pad(config, &layer, center)
        } else {
            Vec::new()
        };
        let mut out = crate::raft::layer_paths(
            raft,
            k,
            &raft.first_layer,
            config,
            first_cfg,
            center,
            tool,
            skirt,
            (&trees, &columns, pad),
        );
        out.index = p;
        out.local = p;
        out.start_tool = tool;
        out.tools_before = self.tools_before(p);
        out.changes_before = self.changes_before(p);
        out.held_before = self.held_before(p);
        out
    }

    /// Slices layers of this object alone (stages 2 to 6).
    pub(crate) fn slice_object_range(
        &self,
        config: &PrintConfig,
        layers: Range<u32>,
        progress: &dyn Progress,
    ) -> Result<SliceOutput> {
        par::slice(|| self.slice_object_range_now(config, layers, progress))
    }

    /// [`Self::slice_object_range`].
    fn slice_object_range_now(
        &self,
        config: &PrintConfig,
        layers: Range<u32>,
        progress: &dyn Progress,
    ) -> Result<SliceOutput> {
        config.check()?;
        let n = self.plan.count();
        let n_print = self.plan_count();
        if layers.start > layers.end || layers.end > n_print {
            return Err(Error::LayerRange {
                range: layers,
                count: n_print,
            });
        }
        // The layer below the range is worked out too, for where it ends (`LayerPaths::enter_from`), then dropped.
        let asked = layers.clone();
        let layers = layers.start.saturating_sub(1)..layers.end;
        // The object layers printed in this range of print layers.
        let object_range = |layers: &Range<u32>| {
            if self.print.is_empty() {
                layers.clone()
            } else {
                let range = self
                    .print
                    .get(layers.start as usize..layers.end as usize)
                    .unwrap_or(&[]);
                if let Some(a) = range.iter().find_map(|l| l.object) {
                    a..range.iter().rev().find_map(|l| l.object).unwrap_or(a) + 1
                } else {
                    let next = self
                        .print
                        .get(layers.start as usize..)
                        .and_then(|r| r.iter().find_map(|l| l.object))
                        .unwrap_or(n);
                    next..next
                }
            }
        };
        let objects = object_range(&layers);
        if !self.plan.custom
            && ((config.layer_height - self.plan.height).abs() > 1e-9
                || (if self.raft.is_some() {
                    config.layer_height
                } else {
                    config.initial_layer_print_height
                } - self.plan.first_height)
                    .abs()
                    > 1e-9)
        {
            return Err(Error::Config {
                key: "layer_height",
                reason: "differs from the session; build a new session".to_owned(),
            });
        }
        if config.enable_support
            && (config.support != self.support_cfg
                || (config.support_width() - self.support_width).abs() > 1e-9)
        {
            return Err(Error::Config {
                key: "support_*",
                reason: "support settings differ from the session; build a new session".to_owned(),
            });
        }
        let micros = Micros::default();
        let fam = Families::new(config);
        let configs = self
            .overrides
            .iter()
            .map(|o| {
                let mut c = config.clone();
                c.apply_value(o)?;
                c.check()?;
                crate::preflight::hold_temperatures(&mut c);
                Ok(c)
            })
            .collect::<Result<Vec<PrintConfig>>>()?;
        // Settings inside each modifier volume: the plate's with the modifier's overrides on top.
        let mod_cfgs = self
            .modifier_settings()
            .into_iter()
            .map(|o| {
                let mut c = config.clone();
                c.apply_value(o)?;
                c.check()?;
                crate::preflight::hold_temperatures(&mut c);
                Ok(c)
            })
            .collect::<Result<Vec<PrintConfig>>>()?;
        let cfg_index = |l: u32| self.layer_cfg.get(l as usize).copied().unwrap_or(0);
        let cfg_of = |l: u32| {
            usize::from(cfg_index(l))
                .checked_sub(1)
                .and_then(|i| configs.get(i))
                .unwrap_or(config)
        };
        // The first layer prints every line at `initial_layer_line_width`, so its scanlines are another family.
        let first_cfg = cfg_of(0).for_first_layer();
        let fam0 = Families::new(&first_cfg);
        // Over a raft the part's first layer is an ordinary layer; the raft's own first layer is the print's.
        let on_raft = self.raft.is_some();
        let layer_cfg_of = |l: u32| if l == 0 && !on_raft { &first_cfg } else { cfg_of(l) };
        // Neighbors read for top and bottom detection, plus one layer below for tool order.
        let (mut top_layers, mut bottom_layers) = config.shell_layers(self.plan.height);
        for c in &mod_cfgs {
            let (t, b) = c.shell_layers(self.plan.height);
            top_layers = top_layers.max(t);
            bottom_layers = bottom_layers.max(b);
        }
        // The shell rules read the layer just beyond the last shell layer on each side, and the layer below
        // is classified too (for the first solid layer over sparse infill), so two more layers each way.
        let spare = 4;
        let below = (bottom_layers + spare).max(if self.tool_count > 1 { 6 } else { 1 });
        let above = top_layers + spare;
        let a_lo = objects.start.saturating_sub(below);
        let a_hi = objects.end.saturating_add(above).min(n);
        let stopped = || progress.cancelled();
        if stopped() {
            return Err(Error::Cancelled);
        }
        // The whole-object plans are worked out here, before the parallel stages read them (the rule in
        // `par`). Each runs its own parallel pass; planned first inside a layer job, one could hang the
        // thread pool, since the thread planning it picks up other layer jobs while it waits, and those wait
        // for the plan further up the same thread. Height ranges and modifiers can turn a plan on too, so each
        // takes the first of these settings that asks for it. The interlocking beams come first, since the
        // plans below cut layers too.
        let reach: Vec<&PrintConfig> = [config, &first_cfg]
            .into_iter()
            .chain(&configs)
            .chain(&mod_cfgs)
            .collect();
        let first_with = |on: fn(&PrintConfig) -> bool| reach.iter().copied().find(|c| on(c));
        self.interlocked(fam, fam0, &micros);
        self.conical(fam, fam0, &micros, config);
        self.polyholes(fam, fam0, &micros, config);
        // The support plan is read by the supports of the layers, the brim on the first layer and the raft under
        // organic trees, also with `support_type` set to painted only and nothing painted. When it is still to
        // be planned, it is planned beside the plans below, the regions of every layer and the first part of
        // each object layer's paths (`layer_start`), none of which read it; each layer's support is added
        // after. Its input cuts the regions of every layer, which the plans below share, so that is worked out
        // first (the rule in `par::join_plans`).
        let support_cfg = if self.stack.is_empty() {
            first_with(|c| c.enable_support)
        } else {
            None
        };
        let pending = support_cfg.filter(|_| self.support.get().is_none());
        let input = pending.map(|c| self.support_input(c));
        let tags = Tags::of_all(
            [config, &first_cfg].into_iter().chain(&configs).chain(&mod_cfgs),
            self.tool_count,
        );
        // The object layer print layer `i` prints; None for raft and support-only layers.
        let object_of = |i: u32| match self.print.get(i as usize) {
            None => Some(i),
            Some(pl) if pl.raft.is_none() => pl.object,
            Some(_) => None,
        };
        let rest = || {
            if let Some(c) = first_with(|c| {
                c.sparse_infill_pattern == InfillPattern::Lightning && c.sparse_infill_density > 0.0
            }) {
                self.lightning_layers(c);
            }
            self.seam_plan(config);
            self.curl_plan(config);
            if let Some(c) = first_with(combine_on) {
                self.combine_plan(c);
            }
            progress.report(Stage::Contours, 0.0);
            // Layers the whole-object plans already cut with the same families are taken over, not cut again.
            let mut whole = self.take_whole(fam);
            let fam_of = |l: u32| if l == 0 && !on_raft { fam0 } else { fam };
            let taken: Vec<Option<LayerRegions>> = (a_lo..a_hi)
                .map(|l| {
                    if fam_of(l) == fam {
                        whole.get_mut(l as usize).and_then(Option::take)
                    } else {
                        None
                    }
                })
                .collect();
            drop(whole);
            let cut: Vec<Option<LayerRegions>> = par::map_range(a_lo..a_hi, |l| {
                if stopped() || taken.get((l - a_lo) as usize).is_some_and(Option::is_some) {
                    return None;
                }
                Some(self.layer_regions(l, fam_of(l), &micros))
            });
            let regions: Vec<LayerRegions> = taken
                .into_iter()
                .zip(cut)
                .map(|(a, b)| a.or(b).unwrap_or_default())
                .collect();
            // Without threads nothing runs beside the plan, so each layer is worked out in one go after it.
            let starts: Vec<Option<LayerStart>> =
                if cfg!(feature = "parallel") && pending.is_some() && !stopped() {
                    let get = |l: u32| regions.get(l.checked_sub(a_lo)? as usize);
                    par::map_range(layers.clone(), |i| {
                        if stopped() {
                            return None;
                        }
                        object_of(i)
                            .map(|l| self.layer_start(l, layer_cfg_of(l), &mod_cfgs, &get, &micros, &tags))
                    })
                } else {
                    Vec::new()
                };
            (regions, starts)
        };
        self.support_pending.0.store(input.is_some(), Ordering::Relaxed);
        let (planned, (regions, starts)) = par::join_plans(
            || {
                pending
                    .zip(input.as_ref())
                    .map(|(c, inp)| self.plan_support(c, inp))
            },
            rest,
        );
        self.support_pending.0.store(false, Ordering::Relaxed);
        drop(input);
        if let Some((planned, raft)) = planned {
            let _ = self.support.once(|| planned);
            if let Some(raft) = raft {
                let _ = self.organic_raft.set(raft);
            }
        } else if let Some(c) = support_cfg {
            // Planned before this range (or by the session): asked here as before, a lookup.
            self.support_layers(c);
        }
        // Lightning tree bases read the support plan, on independent support layers too.
        if let Some(c) = first_with(|c| {
            c.enable_support
                && c.support.style.is_classic_tree()
                && matches!(c.raw.get("support_base_pattern"), Some(serde_json::Value::String(p)) if p == "lightning")
        }) {
            self.tree_lightning(c);
        }
        if stopped() {
            return Err(Error::Cancelled);
        }
        progress.report(Stage::Contours, 1.0);
        let get = |l: u32| regions.get(l.checked_sub(a_lo)? as usize);
        let object_paths = |l: u32, start: Option<LayerStart>| {
            let mut p = match start {
                Some(s) => self.layer_finish(s, l, layer_cfg_of(l), &mod_cfgs, &get, &micros, &tags, true),
                None => self.layer_paths(l, layer_cfg_of(l), &mod_cfgs, &get, &micros, &tags),
            };
            p.cfg = cfg_index(l);
            p.prev_cfg = if l == 0 { p.cfg } else { cfg_index(l - 1) };
            p
        };
        let jobs: Vec<(u32, Option<LayerStart>)> = if starts.is_empty() {
            layers.clone().map(|i| (i, None)).collect()
        } else {
            layers.clone().zip(starts).collect()
        };
        let print_layer = |(i, start): (u32, Option<LayerStart>)| {
            if stopped() {
                return LayerPaths::default();
            }
            let Some(pl) = self.print.get(i as usize) else {
                return object_paths(i, start);
            };
            if let Some(k) = pl.raft {
                return self.raft_paths(i, k as usize, config, &first_cfg);
            }
            if let Some(l) = pl.object {
                let mut p = object_paths(l, start);
                p.index = i;
                p.local = i;
                #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
                {
                    p.z = pl.top as f32;
                }
                return p;
            }
            // Support only: printed with the settings of the object layer under it.
            let below = self
                .print
                .get(..i as usize)
                .and_then(|r| r.iter().rev().find_map(|l| l.object));
            // The filament the print layer under it ended on.
            let ended = Some(self.print_start(config, i, &get)).filter(|t| *t > 0);
            let mut p = self.support_only_paths(i, pl, below.map_or(&first_cfg, cfg_of), below, ended);
            p.cfg = below.map_or(0, cfg_index);
            p.prev_cfg = p.cfg;
            p
        };
        // The first layer's area and outlines are worked out next to the layers' paths.
        let (mut out_layers, first_layer_info) = par::join(
            || par::map_owned(jobs, print_layer),
            || self.first_layer_info(config),
        );
        if stopped() {
            return Err(Error::Cancelled);
        }
        progress.report(Stage::Paths, 1.0);
        let mut below_end = None;
        let mut below_wipe = crate::output::WipeTail::default();
        if layers.start < asked.start && !out_layers.is_empty() {
            let below = out_layers.remove(0);
            below_end = below.points.last().copied();
            below_wipe = below.wipe_tail();
        }
        for l in &mut out_layers {
            l.enter_from = below_end;
            below_end = l.points.last().copied().or(below_end);
            let tail = l.wipe_tail();
            l.below_wipe = if tail.points.is_empty() {
                below_wipe.clone()
            } else {
                std::mem::replace(&mut below_wipe, tail)
            };
        }
        let mut warnings = self.warnings.clone();
        let open: usize = object_range(&asked).filter_map(get).map(|r| r.open_chains).sum();
        if open > 0 {
            warnings.push(SliceWarning {
                code: WarningCode::OpenEdges,
                message: format!("{open} contour chains did not close and were dropped"),
                layer: None,
            });
        }
        for l in &mut out_layers {
            l.points.shrink_to_fit();
        }
        #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
        let layer_height = self.plan.height as f32;
        #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
        let (top_z, plate_bounds) = (self.plate_top() as f32, self.bounds.map(|v| v as f32));
        Ok(SliceOutput {
            layer_count: n_print,
            first_layer: asked.start,
            layer_height,
            tool_count: self.tool_count,
            layers: out_layers,
            plate_top_z: top_z,
            plate_bounds,
            objects: self.objects.clone(),
            first_layer_info,
            prime_tower: self
                .tower_top
                .and(self.tower_shape)
                .and_then(|p| p.report(config, self.tool_count)),
            vary_layer_cost: self.vary_cost,
            filament_map: self.nozzle_map.clone(),
            collisions: crate::collide::Hits::default(),
            configs,
            stage_micros: StageMicros {
                layers: self.prep_micros,
                contours: micros.contours.load(Ordering::Relaxed),
                perimeters: micros.perimeters.load(Ordering::Relaxed),
                surfaces: micros.surfaces.load(Ordering::Relaxed),
                infill: micros.infill.load(Ordering::Relaxed),
                paths: micros.paths.load(Ordering::Relaxed),
                gcode: 0,
                preview: 0,
            },
            warnings,
        })
    }

    /// The area of the volumes with `role` on a layer, cut at height `z`; None when there are none.
    fn volume_shapes(&self, role: crate::plate::VolumeRole, layer: u32, z: f64) -> Option<Shapes> {
        let mut all: Vec<Shapes> = Vec::new();
        let mut loops: Vec<Polygon> = Vec::new();
        for (_, part) in self.volumes.iter().filter(|(r, _)| *r == role) {
            loops.clear();
            part.slice(layer as usize, z, &mut loops);
            if !loops.is_empty() {
                all.push(perimeters::shapes_from_loops(&loops));
            }
        }
        (!all.is_empty()).then(|| perimeters::union_all(&all.iter().collect::<Vec<_>>()))
    }

    /// The area painted with fuzzy skin on a layer: each painted part's outline split by its fuzzy paint
    /// the way color paint splits it (Orca `fuzzy_skin_segmentation_by_painting` runs the color
    /// segmentation on the fuzzy skin facets), the painted pieces together. `None` with no fuzzy paint here.
    fn fuzzy_mask(&self, layer: u32) -> Option<Shapes> {
        if self.fuzzy_paint.is_empty() {
            return None;
        }
        let z = self.plan.slice_z.get(layer as usize).copied().unwrap_or(0.0);
        let mut pieces: Vec<Shapes> = Vec::new();
        let mut loops: Vec<Polygon> = Vec::new();
        for (k, facets) in &self.fuzzy_paint {
            let Some(p) = self.parts.get(*k) else { continue };
            let (lo, hi) = facets
                .iter()
                .flat_map(|(t, _)| t.iter().map(|v| v[2]))
                .fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(v), b.max(v)));
            if z < lo - 1e-6 || z > hi + 1e-6 {
                continue;
            }
            loops.clear();
            p.slice(layer as usize, z, &mut loops);
            if loops.is_empty() {
                continue;
            }
            let shapes = perimeters::shapes_from_loops(&loops);
            let painted: crate::paint::Facets = facets.iter().filter(|(_, s)| *s == 1).copied().collect();
            let ctx = crate::paint::LayerPaint {
                default_slot: 0,
                shapes: &shapes,
                layer,
                z,
                plan: &self.plan,
                above: &[],
                below: &[],
                facets: &painted,
            };
            pieces.extend(
                ctx.split()
                    .into_iter()
                    .filter(|(slot, sh)| *slot == 1 && !sh.is_empty())
                    .map(|(_, sh)| sh),
            );
        }
        (!pieces.is_empty()).then(|| perimeters::union_all(&pieces.iter().collect::<Vec<_>>()))
    }

    /// The painted support regions of one kind on every layer: painted pieces that face down, taken
    /// where each layer's slab cuts them and looked at from above.
    fn painted_support_layers(&self, state: u8) -> Vec<Shapes> {
        let n = self.plan.count() as usize;
        let mut pieces: Vec<Vec<Shapes>> = vec![Vec::new(); n];
        for (tri, s) in self.painted_supports.iter().filter(|(_, s)| *s == state) {
            let (a, b, c) = (tri[0], tri[1], tri[2]);
            let nz = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
            if nz >= 0.0 {
                continue;
            }
            let _ = s;
            let zs = [a[2], b[2], c[2]];
            let (lo, hi) = (
                zs.iter().copied().fold(f64::MAX, f64::min),
                zs.iter().copied().fold(f64::MIN, f64::max),
            );
            let first = self.plan.first_at_or_above(lo - 1e-9).min(n);
            for l in first..n {
                let top = self.plan.top(u32::try_from(l).unwrap_or(u32::MAX));
                let bottom = top - self.plan.thickness(u32::try_from(l).unwrap_or(u32::MAX));
                if bottom > hi {
                    break;
                }
                let poly = clip_to_slab(tri, bottom.min(hi), top.max(lo));
                if poly.len() >= 3 {
                    let mut ring: Vec<IntPoint<i32>> =
                        poly.iter().map(|p| IntPoint::new(mm(p[0]), mm(p[1]))).collect();
                    if crate::geom::area2_int(&ring) < 0 {
                        ring.reverse();
                    }
                    if let Some(slot) = pieces.get_mut(l) {
                        slot.push(vec![vec![ring]]);
                    }
                }
            }
        }
        pieces
            .into_iter()
            .map(|p| {
                if p.is_empty() {
                    Vec::new()
                } else {
                    perimeters::union_all(&p.iter().collect::<Vec<_>>())
                }
            })
            .collect()
    }

    /// The adaptive cubic octree over the model's triangles.
    fn octree(&self, cfg: &PrintConfig) -> Option<&crate::adaptive::Octree> {
        self.octree
            .once(|| {
                let tris: Vec<[[f64; 3]; 3]> = self
                    .parts
                    .iter()
                    .flat_map(|p| {
                        p.tris.iter().filter_map(|t| {
                            Some([
                                *p.verts.get(t[0] as usize)?,
                                *p.verts.get(t[1] as usize)?,
                                *p.verts.get(t[2] as usize)?,
                            ])
                        })
                    })
                    .collect();
                // Solid infill rests on sparse infill under the top shell, `top shell layers - 1` layers
                // below each upward facing surface: the lattice gets dense there too.
                let (top_n, _) = cfg.shell_layers(self.plan.height);
                let drop = f64::from(top_n.saturating_sub(1)) * self.plan.height;
                let rests: Vec<[[f64; 3]; 3]> = tris
                    .iter()
                    .filter(|t| {
                        let (u, v) = (
                            [t[1][0] - t[0][0], t[1][1] - t[0][1]],
                            [t[2][0] - t[0][0], t[2][1] - t[0][1]],
                        );
                        // Facing up: counterclockwise seen from above, and not steep.
                        let flat = u[0] * v[1] - u[1] * v[0];
                        let (a, b) = (
                            [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]],
                            [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]],
                        );
                        let n = [
                            a[1] * b[2] - a[2] * b[1],
                            a[2] * b[0] - a[0] * b[2],
                            a[0] * b[1] - a[1] * b[0],
                        ];
                        let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                        flat > 0.0 && n[2] > 0.707 * nl
                    })
                    .map(|t| t.map(|v| [v[0], v[1], v[2] - drop]))
                    .collect();
                let spacing =
                    crate::adaptive::line_spacing(cfg.sparse_infill_density, cfg.sparse_infill_width());
                crate::adaptive::build(
                    &tris,
                    &rests,
                    spacing,
                    cfg.sparse_infill_pattern == InfillPattern::SupportCubic,
                )
            })
            .as_ref()
    }

    /// The inputs of the sparse pattern of `layer` over `area`, cut at `z`.
    fn sparse_in<'a>(
        &self,
        cfg: &PrintConfig,
        layer: u32,
        area: &'a Shapes,
        z: f64,
    ) -> crate::patterns::SparseIn<'a> {
        let template = self.template_angle(cfg, "sparse_infill_rotate_template", layer);
        crate::patterns::SparseIn {
            pattern: cfg.sparse_infill_pattern,
            region: area,
            w_mm: cfg.sparse_infill_width(),
            spacing_mm: cfg.spacing_for(cfg.sparse_infill_width()),
            density: cfg.sparse_infill_density / 100.0,
            z_mm: z,
            layer: layer + self.raft_layers(),
            connect_mm: cfg.anchor_max_mm(),
            anchor_mm: crate::anchor::anchor_length(cfg, cfg.spacing_for(cfg.sparse_infill_width())),
            object: self.bounds,
            angle_deg: template
                .unwrap_or_else(|| crate::motion::raw_f(cfg, "infill_direction").unwrap_or(45.0))
                + self.model_turn(cfg),
            lateral_angles: [
                crate::motion::raw_f(cfg, "lateral_lattice_angle_1").unwrap_or(-45.0),
                crate::motion::raw_f(cfg, "lateral_lattice_angle_2").unwrap_or(45.0),
            ],
            overhang_angle_deg: crate::motion::raw_f(cfg, "infill_overhang_angle").unwrap_or(60.0),
            fixed_angle: template.is_some(),
            gyroid_layer_height: crate::firmware::truthy(cfg, "gyroid_optimized").then_some(self.plan.height),
        }
    }

    /// `align_infill_direction_to_model`: the objects' turn about Z, degrees, added to the infill angles.
    fn model_turn(&self, cfg: &PrintConfig) -> f64 {
        if crate::firmware::truthy(cfg, "align_infill_direction_to_model") {
            self.model_rotation
        } else {
            0.0
        }
    }

    /// The angle a rotation template (`sparse_infill_rotate_template` or `solid_infill_rotate_template`)
    /// gives object layer `layer`, degrees; `None` without a template.
    fn template_angle(&self, cfg: &PrintConfig, key: &str, layer: u32) -> Option<f64> {
        let Some(serde_json::Value::String(t)) = cfg.raw.get(key) else {
            return None;
        };
        crate::rotation::angle(
            t,
            layer,
            &self.plan,
            cfg.layer_height,
            (cfg.bottom_shell_layers, cfg.top_shell_layers),
        )
    }

    /// Infill of the patterns planned over the whole plate (lightning, adaptive and support cubic),
    /// clipped to `area`; `None` for the patterns drawn per layer.
    fn planned_sparse(
        &self,
        cfg: &PrintConfig,
        layer: u32,
        area: &Shapes,
    ) -> Option<Vec<Vec<crate::geom::Point>>> {
        match cfg.sparse_infill_pattern {
            InfillPattern::Lightning => {
                // `Fill::fill_surface` pulls the surface in half a spacing (the fill overlap is 0) before the
                // pattern sees it.
                let pulled = perimeters::offset(area, -mm(0.5 * cfg.spacing_for(cfg.sparse_infill_width())));
                let area = if pulled.is_empty() { area } else { &pulled };
                let lines = self
                    .lightning_layers(cfg)
                    .get(layer as usize)
                    .map_or(&[][..], Vec::as_slice);
                // Orca joins the clipped lines along the wall (`FillLightning` ends in `chain_or_connect_infill`).
                let spacing = cfg.spacing_for(cfg.sparse_infill_width());
                Some(crate::anchor::connect(
                    crate::lightning::clip(lines, area),
                    area,
                    crate::anchor::Params {
                        spacing,
                        anchor: crate::anchor::anchor_length(cfg, spacing),
                        anchor_max: cfg.anchor_max_mm(),
                    },
                ))
            }
            InfillPattern::AdaptiveCubic | InfillPattern::SupportCubic => {
                let segments = self
                    .octree(cfg)
                    .map_or_else(Vec::new, |o| crate::adaptive::lines(o, self.plan.top(layer)));
                let lines: Vec<Vec<[f64; 2]>> = segments.into_iter().map(|s| s.to_vec()).collect();
                // Orca joins the clipped lines along the wall (`FillAdaptive` ends in `chain_or_connect_infill`).
                let spacing = cfg.spacing_for(cfg.sparse_infill_width());
                Some(crate::anchor::connect(
                    crate::lightning::clip(&lines, area),
                    area,
                    crate::anchor::Params {
                        spacing,
                        anchor: crate::anchor::anchor_length(cfg, spacing),
                        anchor_max: cfg.anchor_max_mm(),
                    },
                ))
            }
            _ => None,
        }
    }

    /// The region slices of every layer with the interlocking beams applied, planned once; None when
    /// the settings ask for none or the object has one filament.
    /// `hole_to_polyhole` (Orca `PrintObject::_transform_hole_to_polyholes`): almost circular holes that
    /// span more than one layer (or sit on the first) become polygons sized for the nozzle, which print
    /// closer to the true diameter; with `hole_to_polyhole_twisted` the polygon turns a little every
    /// layer. Planned once, before the parallel stages.
    fn polyholes(
        &self,
        fam: Families,
        fam0: Families,
        micros: &Micros,
        cfg: &PrintConfig,
    ) -> Option<&Vec<Vec<HoleSwap>>> {
        if !crate::tower::flag(cfg, "hole_to_polyhole") {
            return None;
        }
        self.polyholes
            .plan(|| {
                struct Cand {
                    ring: Vec<IntPoint<i32>>,
                    center: (f64, f64),
                    radius: f64,
                    var: f64,
                }
                let n = self.plan.count();
                let twist = crate::tower::flag_or(cfg, "hole_to_polyhole_twisted", true);
                let threshold = cfg
                    .raw
                    .get("hole_to_polyhole_threshold")
                    .cloned()
                    .unwrap_or(serde_json::json!(0.01));
                let layers: Vec<Vec<Cand>> = par::map_range(0..n, |l| {
                    let r = self.layer_regions_with(l, if l == 0 { fam0 } else { fam }, micros, true);
                    let mut out = Vec::new();
                    for (_, shapes) in &r.regions {
                        for shape in shapes {
                            for hole in shape.iter().skip(1) {
                                if let Some(c) = circular(hole, &threshold) {
                                    out.push(Cand {
                                        ring: hole.clone(),
                                        center: c.0,
                                        radius: c.1,
                                        var: c.2,
                                    });
                                }
                            }
                        }
                    }
                    out
                });
                let mut used: Vec<Vec<bool>> = layers.iter().map(|l| vec![false; l.len()]).collect();
                let mut plan: Vec<Vec<HoleSwap>> = vec![Vec::new(); n as usize];
                let nozzle = cfg.nozzle_diameter;
                for (li, here) in layers.iter().enumerate() {
                    for (k, id) in here.iter().enumerate() {
                        if used.get(li).and_then(|u| u.get(k)).copied().unwrap_or(true) {
                            continue;
                        }
                        let layer_no = u32::try_from(li).unwrap_or(0);
                        let mut max_z = self.plan.top(layer_no);
                        let mut holes: Vec<(usize, usize)> = vec![(li, k)];
                        for (sl, cands) in layers.iter().enumerate().skip(li + 1) {
                            let sl_no = u32::try_from(sl).unwrap_or(0);
                            let bottom = self.plan.top(sl_no) - self.plan.thickness(sl_no);
                            if bottom - max_z > 1e-4 {
                                break;
                            }
                            let taken = used.get(sl);
                            let found = cands.iter().enumerate().find(|(j, c)| {
                                !taken.and_then(|u| u.get(*j)).copied().unwrap_or(true)
                                    && (c.center.0 - id.center.0).m_hypot(c.center.1 - id.center.1) < id.var
                                    && (c.radius - id.radius).abs() < id.var
                            });
                            if let Some((j, _)) = found {
                                if let Some(u) = used.get_mut(sl).and_then(|u| u.get_mut(j)) {
                                    *u = true;
                                }
                                max_z = self.plan.top(sl_no);
                                holes.push((sl, j));
                            }
                        }
                        if holes.len() >= 2 || (holes.len() == 1 && li == 0) {
                            let polys = create_polyholes(id.center, id.radius, nozzle, twist);
                            for (hl, hk) in holes {
                                let Some(p) = polys.get(hl % polys.len().max(1)) else {
                                    continue;
                                };
                                if let (Some(slot), Some(c)) =
                                    (plan.get_mut(hl), layers.get(hl).and_then(|l| l.get(hk)))
                                {
                                    slot.push((c.ring.clone(), p.clone()));
                                }
                            }
                        }
                    }
                }
                Some(plan)
            })
            .as_ref()
    }

    /// `make_overhang_printable` (Orca `PrintObject::apply_conical_overhang`): from the top down, each layer
    /// takes in the layer above pulled in by `tan(angle) * layer height`, so no overhang is steeper than the
    /// angle. Holes smaller than the hole size that the layer above covers stay open. Planned once, before the
    /// parallel stages, from the layers as they slice; returns the area each layer gains.
    fn conical(
        &self,
        fam: Families,
        fam0: Families,
        micros: &Micros,
        cfg: &PrintConfig,
    ) -> Option<&Vec<Shapes>> {
        let (angle, hole_mm2) = self.conical_params?;
        self.conical
            .plan(|| {
                let n = self.plan.count() as usize;
                if n < 2 {
                    return None;
                }
                let layers: Vec<Shapes> = par::map_range(0..self.plan.count(), |l| {
                    let r = self.layer_regions_with(l, if l == 0 { fam0 } else { fam }, micros, true);
                    let all: Vec<&Shapes> = r.regions.iter().map(|(_, s)| s).collect();
                    perimeters::union_all(&all)
                });
                let reach = mm(angle.to_radians().m_tan() * cfg.layer_height);
                let max_hole = hole_mm2 * 1e8;
                let mut adds: Vec<Shapes> = vec![Vec::new(); n];
                // The layer above as it ends up, after the cone it took from the layers over it.
                let mut upper: Shapes = layers.last().cloned().unwrap_or_default();
                for l in (0..n - 1).rev() {
                    let current = layers.get(l).cloned().unwrap_or_default();
                    let mut up = upper.clone();
                    if up.is_empty() {
                        upper = current;
                        continue;
                    }
                    if max_hole > 0.0 {
                        for shape in &current {
                            for hole in shape.iter().skip(1) {
                                #[allow(clippy::cast_precision_loss, reason = "an area")]
                                let area = (crate::geom::area2_int(hole).unsigned_abs() as f64) / 2.0;
                                if area >= max_hole {
                                    continue;
                                }
                                let mut ring = hole.clone();
                                if crate::geom::area2_int(&ring) < 0 {
                                    ring.reverse();
                                }
                                let hole_poly: Shapes = vec![vec![ring]];
                                if !perimeters::intersection(&up, &hole_poly).is_empty()
                                    && perimeters::difference(&hole_poly, &up).is_empty()
                                {
                                    up = perimeters::difference(&up, &hole_poly);
                                }
                            }
                        }
                    }
                    let shrunk = perimeters::offset(&up, -reach);
                    // Islands the layer already covers add nothing.
                    let add: Shapes = shrunk
                        .into_iter()
                        .filter(|island| !perimeters::difference(&vec![island.clone()], &current).is_empty())
                        .collect();
                    upper = if add.is_empty() {
                        current
                    } else {
                        perimeters::union_all(&[&current, &add])
                    };
                    if let Some(a) = adds.get_mut(l) {
                        *a = add;
                    }
                }
                Some(adds)
            })
            .as_ref()
    }

    fn interlocked(
        &self,
        fam: Families,
        fam0: Families,
        micros: &Micros,
    ) -> Option<&crate::interlock::Layers> {
        let params = self.interlock_params?;
        self.interlock
            .plan(|| {
                if self.slots.len() < 2 {
                    return None;
                }
                let n = self.plan.count();
                let base: Vec<LayerRegions> = par::map_range(0..n, |l| {
                    self.layer_regions_with(l, if l == 0 { fam0 } else { fam }, micros, true)
                });
                let mut layers: crate::interlock::Layers = base.into_iter().map(|r| r.regions).collect();
                crate::interlock::apply(&mut layers, &params);
                Some(layers)
            })
            .as_ref()
    }

    /// The seams of the whole object (Orca's `SeamPlacer`), planned once: the outer wall of every layer
    /// is the slice pulled in half a line, scored and aligned over the object, with surface visibility
    /// from a raycast over the model when the mode reads it.
    fn seam_plan(&self, cfg: &PrintConfig) -> Option<&crate::seamplan::Plan> {
        self.seams
            .plan(|| {
                if crate::spiral::enabled(cfg) || self.parts.is_empty() {
                    return None;
                }
                let mode = cfg.seam_position;
                let n = self.plan.count();
                let fam = Families::new(cfg);
                let micros = Micros::default();
                let width = cfg.outer_wall_width();
                // The visibility of the surface reads the mesh only, so it is worked out next to the layers
                // (their regions, then their wall rings).
                let visible = matches!(
                    mode,
                    crate::config::SeamPosition::Aligned
                        | crate::config::SeamPosition::AlignedBack
                        | crate::config::SeamPosition::Nearest
                );
                let layer_in = |regions: &[LayerRegions], l: u32| {
                    let here = regions.get(l as usize);
                    let mut rings = Vec::new();
                    let mut with_walls = 0;
                    for (_, shapes) in here.map_or(&[][..], |r| r.regions.as_slice()) {
                        let walls = perimeters::offset(shapes, -mm(width / 2.0));
                        let before = rings.len();
                        for ring in walls.iter().flat_map(|s| s.iter()) {
                            #[allow(clippy::cast_possible_truncation, reason = "a width in mm")]
                            rings.push((ring.clone(), width as f32));
                        }
                        with_walls += usize::from(rings.len() > before);
                    }
                    #[allow(clippy::cast_possible_truncation, reason = "heights in mm")]
                    crate::seamplan::LayerIn {
                        z: self.plan.slice_z.get(l as usize).copied().unwrap_or(0.0) as f32,
                        height: self.plan.thickness(l) as f32,
                        rings,
                        outline: here.map(slice_shapes).unwrap_or_default(),
                        multi: with_walls > 1,
                    }
                };
                let (layers, field) = par::join(
                    || {
                        let regions = self.whole_regions(fam, &micros);
                        par::map_range(0..n, |l| layer_in(&regions, l))
                    },
                    || {
                        visible
                            .then(|| self.visibility_field(mode == crate::config::SeamPosition::AlignedBack))
                    },
                );
                #[allow(clippy::cast_possible_truncation, reason = "a nozzle diameter in mm")]
                let mut plan = crate::seamplan::Plan::build(
                    &layers,
                    mode,
                    cfg.nozzle_diameter as f32,
                    field.as_ref(),
                    &self.seam_faces,
                );
                plan.stagger =
                    crate::tower::flag(cfg, "staggered_inner_seams").then(|| cfg.inner_wall_width());
                Some(plan)
            })
            .as_ref()
    }

    /// The curled stretches of every layer's outer wall (Orca `PrintObject::estimate_curled_extrusions`),
    /// planned once when `slowdown_for_curled_perimeters` asks for them. The outer wall is the slice of
    /// each region pulled in half a line, as the seam planner takes it.
    fn curl_plan(&self, cfg: &PrintConfig) -> Option<&Vec<std::sync::Arc<crate::quality::Curled>>> {
        self.curls
            .plan(|| {
                if !crate::quality::overhang_speed_on(cfg)
                    || !crate::tower::flag(cfg, "slowdown_for_curled_perimeters")
                    || crate::spiral::enabled(cfg)
                    || self.parts.is_empty()
                {
                    return None;
                }
                let n = self.plan.count();
                let fam = Families::new(cfg);
                let micros = Micros::default();
                let width = cfg.outer_wall_width();
                let regions = self.whole_regions(fam, &micros);
                let layers: Vec<crate::quality::CurlLayer> = par::map_range(0..n, |l| {
                    let here = regions.get(l as usize);
                    let mut rings = Vec::new();
                    for (_, shapes) in here.map_or(&[][..], |r| r.regions.as_slice()) {
                        for ring in perimeters::offset(shapes, -mm(width / 2.0))
                            .iter()
                            .flat_map(|s| s.iter())
                        {
                            let mut closed = ring.clone();
                            if let Some(f) = ring.first() {
                                closed.push(*f);
                            }
                            #[allow(clippy::cast_possible_truncation, reason = "a width in mm")]
                            rings.push((closed, width as f32));
                        }
                    }
                    #[allow(clippy::cast_possible_truncation, reason = "heights in mm")]
                    crate::quality::CurlLayer {
                        height: self.plan.thickness(l) as f32,
                        rings,
                        slice: here.map(slice_shapes).unwrap_or_default(),
                    }
                });
                Some(
                    crate::quality::curl_plan(&layers)
                        .into_iter()
                        .map(std::sync::Arc::new)
                        .collect(),
                )
            })
            .as_ref()
    }

    /// Surface visibility of the parts (`raycast.rs`).
    #[allow(clippy::cast_possible_truncation, reason = "mesh data is single precision")]
    fn visibility_field(&self, aligned_back: bool) -> crate::raycast::Field {
        let mut soup = crate::raycast::Soup::default();
        for part in &self.parts {
            let base = u32::try_from(soup.verts.len()).unwrap_or(0);
            soup.verts
                .extend(part.verts.iter().map(|v| [v[0] as f32, v[1] as f32, v[2] as f32]));
            soup.tris
                .extend(part.tris.iter().map(|t| [t[0] + base, t[1] + base, t[2] + base]));
        }
        crate::raycast::collapse(&mut soup, 16_000);
        // Negative volumes follow the model's triangles: a ray that leaves the model through one passes.
        let mut negative = crate::raycast::Soup::default();
        for (role, part) in &self.volumes {
            if *role != crate::plate::VolumeRole::Negative {
                continue;
            }
            let base = u32::try_from(negative.verts.len()).unwrap_or(0);
            negative
                .verts
                .extend(part.verts.iter().map(|v| [v[0] as f32, v[1] as f32, v[2] as f32]));
            negative
                .tris
                .extend(part.tris.iter().map(|t| [t[0] + base, t[1] + base, t[2] + base]));
        }
        let negative_from = (!negative.tris.is_empty()).then(|| {
            crate::raycast::collapse(&mut negative, 16_000);
            soup.tris.len()
        });
        if negative_from.is_some() {
            let base = u32::try_from(soup.verts.len()).unwrap_or(0);
            soup.verts.extend(negative.verts.iter().copied());
            soup.tris.extend(
                negative
                    .tris
                    .iter()
                    .map(|t| [t[0] + base, t[1] + base, t[2] + base]),
            );
        }
        let samples = crate::raycast::sample(&soup, 30_000);
        crate::raycast::Field::new(
            samples,
            crate::raycast::Rays::new(soup, aligned_back, negative_from),
        )
    }

    /// The lightning trees of every layer, planned once from the sparse areas of the whole plate.
    fn lightning_layers(&self, cfg: &PrintConfig) -> &[Vec<Vec<[f64; 2]>>] {
        self.lightning.plan(|| {
            let areas = self.whole_sparse(cfg);
            let ang = |key: &str| cfg.raw_number(key, 45.0);
            crate::lightning::plan(
                &areas,
                &crate::lightning::Params {
                    line_width: cfg.sparse_infill_width(),
                    joint_overlap: 0.5 * cfg.spacing_for(cfg.sparse_infill_width()),
                    density_percent: cfg.sparse_infill_density,
                    layer_height: self.plan.height,
                    overhang_angle: ang("lightning_overhang_angle"),
                    prune_angle: ang("lightning_prune_angle"),
                    straighten_angle: ang("lightning_straightening_angle"),
                },
            )
        })
    }

    /// `infill_combination` (Orca `PrintObject::combine_infill`): the groups of layers whose sparse infill
    /// prints once, on the group's top layer, at the group's height. Layers from the second up gather until
    /// the next would reach the cap (the nozzle, or `infill_combination_max_layer_height` when smaller; with
    /// sleipnir's variable layers also at most 0.75 of the nozzle). Each group keeps the sparse area that all
    /// its layers share, less pieces no bigger than a solid spacing squared.
    fn combine_plan(&self, cfg: &PrintConfig) -> Option<&Combine> {
        if !combine_on(cfg) {
            return None;
        }
        let plan = self.combine.plan(|| {
            let n = self.plan.count();
            let nozzle = cfg.nozzle_diameter;
            let mut cap = match cfg.raw.get("infill_combination_max_layer_height") {
                Some(serde_json::Value::String(t)) if t.trim().ends_with('%') => t
                    .trim()
                    .trim_end_matches('%')
                    .trim()
                    .parse::<f64>()
                    .map_or(nozzle, |p| nozzle * p / 100.0),
                Some(v) => v
                    .as_f64()
                    .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
                    .unwrap_or(nozzle),
                None => nozzle,
            };
            cap = if cap > 0.0 { cap.min(nozzle) } else { nozzle };
            if self.plan.custom {
                cap = cap.min(0.75 * nozzle);
            }
            let mut groups: Vec<(u32, u32)> = Vec::new();
            let (mut height, mut count) = (0.0f64, 0u32);
            for l in 1..n {
                let h = self.plan.thickness(l);
                if height + h >= cap + 1e-6 {
                    if count > 1 {
                        groups.push((l - count, l - 1));
                    }
                    height = 0.0;
                    count = 0;
                }
                height += h;
                count += 1;
            }
            if count > 1 {
                groups.push((n - count, n - 1));
            }
            if groups.is_empty() {
                return Combine::default();
            }
            let areas = self.whole_sparse(cfg);
            let threshold = {
                let s = mm(cfg.spacing_for(cfg.solid_infill_width()));
                f64::from(s) * f64::from(s)
            };
            let per_group: Vec<Shapes> = par::map_range(0..u32::try_from(groups.len()).unwrap_or(0), |g| {
                let Some(&(a, b)) = groups.get(g as usize) else {
                    return Vec::new();
                };
                let mut shared = areas.get(a as usize).cloned().unwrap_or_default();
                for l in a + 1..=b {
                    shared = perimeters::intersection(
                        &shared,
                        &areas.get(l as usize).cloned().unwrap_or_default(),
                    );
                }
                #[allow(clippy::cast_precision_loss, reason = "areas in internal units squared")]
                shared.retain(|sh| {
                    (sh.iter().map(|r| crate::geom::area2_int(r)).sum::<i64>().abs() as f64) / 2.0 > threshold
                });
                shared
            });
            let lined = matches!(
                cfg.sparse_infill_pattern,
                InfillPattern::Rectilinear
                    | InfillPattern::Grid
                    | InfillPattern::LateralLattice
                    | InfillPattern::Line
                    | InfillPattern::Honeycomb
                    | InfillPattern::LateralHoneycomb
            );
            let clearance =
                0.5 * cfg.inner_wall_width() + if lined { 1.5 } else { 0.5 } * cfg.solid_infill_width();
            let mut layer_group = vec![None; n as usize];
            let mut out = Combine::default();
            for (&(a, b), shared) in groups.iter().zip(per_group) {
                if shared.is_empty() {
                    continue;
                }
                let height = (a..=b).map(|l| self.plan.thickness(l)).sum();
                out.groups.push(CombineGroup {
                    top: b,
                    height,
                    grown: perimeters::offset(&shared, mm(clearance)),
                    shared,
                });
                let idx = out.groups.len() - 1;
                for l in a..=b {
                    if let Some(slot) = layer_group.get_mut(l as usize) {
                        *slot = Some(idx);
                    }
                }
            }
            out.layer = layer_group;
            out
        });
        (!plan.groups.is_empty()).then_some(plan)
    }

    /// The sparse area of every layer of the whole plate, with the base settings (what lightning infill and
    /// infill combination plan over).
    fn whole_sparse(&self, cfg: &PrintConfig) -> Vec<Shapes> {
        {
            let n = self.plan.count();
            let fam = Families::new(cfg);
            let micros = Micros::default();
            let w = mm(cfg.line_width);
            #[allow(
                clippy::cast_possible_truncation,
                reason = "overlap is a fraction of a line width"
            )]
            let overlap = (f64::from(w) * cfg.infill_wall_overlap / 100.0).round() as i32;
            let regions = self.whole_regions(fam, &micros);
            let slices: Vec<Shapes> = regions.iter().map(slice_shapes).collect();
            let (top_n, bot_n) = cfg.shell_layers(self.plan.height);
            // The infill area inside the walls of every layer, then what is sparse in it (Orca's lightning planner
            // reads the internal fill surfaces of every layer).
            let inners: Vec<Shapes> = par::map_range(0..n, |l| {
                let Some(here) = regions.get(l as usize) else {
                    return Vec::new();
                };
                let inner: Vec<Shapes> = here
                    .regions
                    .iter()
                    .map(|(_, shapes)| {
                        perimeters::walls_for(
                            cfg,
                            shapes,
                            cfg.wall_loops,
                            w,
                            overlap,
                            self.plan.thickness(l),
                            false,
                        )
                        .1
                    })
                    .collect();
                perimeters::union_all(&inner.iter().collect::<Vec<_>>())
            });
            let slice_of =
                |m: i64| -> Option<Shapes> { usize::try_from(m).ok().and_then(|o| slices.get(o)).cloned() };
            let inner_of =
                |m: i64| -> Option<Shapes> { usize::try_from(m).ok().and_then(|o| inners.get(o)).cloned() };
            let areas: Vec<Shapes> = par::map_range(0..n, |l| {
                let Some(here) = regions.get(l as usize) else {
                    return Vec::new();
                };
                let mut sparse: Vec<Shapes> = Vec::new();
                for (_, shapes) in &here.regions {
                    let inner = perimeters::walls_for(
                        cfg,
                        shapes,
                        cfg.wall_loops,
                        w,
                        overlap,
                        self.plan.thickness(l),
                        false,
                    )
                    .1;
                    let cls = crate::classify::classify(&crate::classify::In {
                        cfg,
                        layer: l,
                        count: n,
                        region: shapes,
                        inner: &inner,
                        slice: &slice_of,
                        inner_of: &inner_of,
                        top_layers: top_n,
                        bottom_layers: bot_n,
                        wall_loops: cfg.wall_loops,
                        cache: None,
                        tag: 0,
                        whole_lower: None,
                    });
                    sparse.push(cls.sparse);
                }
                perimeters::union_all(&sparse.iter().collect::<Vec<_>>())
            });
            areas
        }
    }

    /// The outline of every modifier volume on a layer, in the order of [`Self::modifier_settings`].
    fn modifier_shapes(&self, layer: u32, z: f64) -> Vec<Shapes> {
        let mut out = Vec::new();
        let mut loops: Vec<Polygon> = Vec::new();
        for (_, part) in self
            .volumes
            .iter()
            .filter(|(r, _)| *r == crate::plate::VolumeRole::Modifier)
        {
            loops.clear();
            part.slice(layer as usize, z, &mut loops);
            out.push(if loops.is_empty() {
                Vec::new()
            } else {
                perimeters::shapes_from_loops(&loops)
            });
        }
        out
    }

    /// The setting overrides of the modifier volumes, in order.
    fn modifier_settings(&self) -> Vec<&serde_json::Value> {
        self.volumes
            .iter()
            .zip(&self.volume_settings)
            .filter(|((r, _), _)| *r == crate::plate::VolumeRole::Modifier)
            .map(|(_, s)| s)
            .collect()
    }

    fn has_enforcers(&self) -> bool {
        self.painted_supports.iter().any(|(_, s)| *s == 1)
            || self
                .volumes
                .iter()
                .any(|(r, _)| *r == crate::plate::VolumeRole::SupportEnforcer)
    }

    /// What the support planners read: the part's outline and thickness on every layer, the
    /// enforcer and blocker areas, and the middle of the plate.
    fn support_input(&self, cfg: &PrintConfig) -> SupportInput {
        let n = self.plan.count();
        let fam = Families::new(cfg);
        let micros = Micros::default();
        let whole = self.whole_regions(fam, &micros);
        let models: Vec<Shapes> = par::map_range(0..n, |l| {
            let Some(r) = whole.get(l as usize) else {
                return Shapes::new();
            };
            if let [(_, only)] = r.regions.as_slice() {
                only.clone()
            } else {
                perimeters::union_all(&r.regions.iter().map(|(_, s)| s).collect::<Vec<_>>())
            }
        });
        let thickness: Vec<f64> = (0..n).map(|l| self.plan.thickness(l)).collect();
        let at = |l: usize| self.plan.slice_z.get(l).copied().unwrap_or(0.0);
        let region = |role| -> Vec<Shapes> {
            (0..n)
                .map(|l| self.volume_shapes(role, l, at(l as usize)).unwrap_or_default())
                .collect()
        };
        let merge = |mut a: Vec<Shapes>, b: Vec<Shapes>| -> Vec<Shapes> {
            for (x, y) in a.iter_mut().zip(b) {
                if !y.is_empty() {
                    *x = perimeters::union_all(&[x, &y]);
                }
            }
            a
        };
        let force = merge(
            region(crate::plate::VolumeRole::SupportEnforcer),
            self.painted_support_layers(1),
        );
        let block = merge(
            region(crate::plate::VolumeRole::SupportBlocker),
            self.painted_support_layers(2),
        );
        SupportInput {
            models,
            thickness,
            force,
            block,
            center: [
                f64::midpoint(self.bounds[0], self.bounds[2]),
                f64::midpoint(self.bounds[1], self.bounds[3]),
            ],
        }
    }

    /// Slim, strong and hybrid trees (Orca's `TreeSupport`), one support layer per object layer.
    fn classic_tree_layers(
        &self,
        cfg: &PrintConfig,
        input: &SupportInput,
    ) -> Vec<crate::support::SupportLayer> {
        self.classic_tree_plan(cfg, input)
            .into_iter()
            .map(|(_, l)| l)
            .collect()
    }

    /// Slim, strong and hybrid trees: each support layer's height and areas.
    fn classic_tree_plan(
        &self,
        cfg: &PrintConfig,
        input: &SupportInput,
    ) -> Vec<(crate::treeclassic::LayerH, crate::support::SupportLayer)> {
        let n = self.plan.count();
        let tops: Vec<f64> = (0..n).map(|l| self.plan.top(l)).collect();
        let sc = cfg.support_config();
        let inp = crate::treeclassic::TreeIn {
            models: &input.models,
            tops: &tops,
            thickness: &input.thickness,
            cfg: &sc,
            line_width: cfg.line_width,
            support_width: cfg.support_width(),
            force: &input.force,
            block: &input.block,
            object: self.bounds,
            bed: cfg.bed_rect(),
            critical_only: crate::firmware::truthy(cfg, "support_critical_regions_only"),
            first_layer_gap: sc.object_first_layer_gap,
            min_layer_height: cfg.raw_number("min_layer_height", 0.07),
            raft_first_layer_expansion: cfg.raw_number("raft_first_layer_expansion", 2.0),
            independent: cfg.independent_support_layer_height() && self.raft.is_none(),
            max_layer_height: {
                let max_raw = cfg.raw_number("max_layer_height", 0.0);
                if max_raw > 0.0 {
                    max_raw
                } else {
                    0.75 * cfg.nozzle_diameter
                }
            },
        };
        crate::treeclassic::plan(&inp)
            .into_iter()
            .map(|(h, t)| {
                let bases: Vec<&Shapes> = t.base.iter().map(|a| &a.shape).collect();
                let base = perimeters::union_all(&bases);
                let normals: Vec<&Shapes> = t.base.iter().filter(|a| a.infill).map(|a| &a.shape).collect();
                (
                    h,
                    crate::support::SupportLayer {
                        base,
                        interface: perimeters::union_all(&[&t.roof, &t.roof_first, &t.floor]),
                        normal: perimeters::union_all(&normals),
                        classic: Some(std::sync::Arc::new(t)),
                        ..crate::support::SupportLayer::default()
                    },
                )
            })
            .collect()
    }

    /// Warnings for features too thin for the walls to print (`WarningCode::ThinWall`): per layer, the parts of
    /// the slice that an opening by the smallest printable width removes (the outer wall width for classic
    /// walls, `min_feature_size` of the nozzle for Arachne and Athena), kept when a piece covers at least
    /// half a square millimeter so sharp corners do not count. Up to three places are named with the setting
    /// that would keep them.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "layer counts and mm"
    )]
    pub(crate) fn thin_warnings(&self, cfg: &PrintConfig) -> Vec<SliceWarning> {
        const SHOWN: usize = 3;
        let arachne = cfg.arachne_walls();
        let min_mm = if arachne {
            let v = match cfg.raw.get("min_feature_size") {
                Some(serde_json::Value::Number(n)) => n.as_f64(),
                Some(serde_json::Value::String(t)) => t.trim().trim_end_matches('%').trim().parse().ok(),
                _ => None,
            };
            v.unwrap_or(25.0) / 100.0 * cfg.nozzle_diameter
        } else {
            cfg.outer_wall_width()
        };
        let half = mm(min_mm / 2.0).max(1);
        let n = self.plan.count();
        let lost: Vec<Option<(f64, [f64; 2])>> = par::map_range(0..n, |l| {
            let z = self.plan.slice_z.get(l as usize).copied().unwrap_or(0.0);
            let mut loops: Vec<Polygon> = Vec::new();
            for p in &self.parts {
                p.slice(l as usize, z, &mut loops);
            }
            let slice = perimeters::shapes_from_loops(&loops);
            if slice.is_empty() {
                return None;
            }
            let kept = perimeters::offset(&perimeters::offset(&slice, -half), half + 2);
            let gone = perimeters::difference(&slice, &kept);
            let scale2 = crate::geom::SCALE * crate::geom::SCALE;
            let mut best: Option<(f64, [f64; 2])> = None;
            for piece in &gone {
                let one = vec![piece.clone()];
                let area = shapes_area(&one) / scale2;
                if area >= 0.5 && best.is_none_or(|(a, _)| area > a) {
                    let pts = piece.first().map_or(&[][..], Vec::as_slice);
                    let k = pts.len().max(1) as f64;
                    let c = pts.iter().fold([0.0, 0.0], |c, p| {
                        [
                            c[0] + f64::from(p.x) / crate::geom::SCALE,
                            c[1] + f64::from(p.y) / crate::geom::SCALE,
                        ]
                    });
                    best = Some((area, [c[0] / k, c[1] / k]));
                }
            }
            best
        });
        // Runs of layers that lose a thin feature.
        let mut runs: Vec<(u32, u32, [f64; 2])> = Vec::new();
        for (l, f) in lost.iter().enumerate() {
            let Some((_, at)) = f else { continue };
            let l = l as u32;
            match runs.last_mut() {
                Some(r) if r.1 + 1 == l => r.1 = l,
                _ => runs.push((l, l, *at)),
            }
        }
        let lift = self.raft.as_ref().map_or(0, crate::raft::Plan::count);
        let fix = if arachne {
            "Lower the minimum feature size or scale the part up."
        } else {
            "Switch the wall generator to Arachne, which prints features down to a quarter of the nozzle, or scale the part up."
        };
        let mut out: Vec<SliceWarning> = runs
            .iter()
            .take(SHOWN)
            .map(|&(a, b, at)| {
                let span = if a == b { format!("layer {}", a + 1 + lift) } else { format!("layers {} to {}", a + 1 + lift, b + 1 + lift) };
                SliceWarning {
                    code: WarningCode::ThinWall,
                    message: format!(
                        "A feature thinner than {min_mm:.2} mm on {span} near X {:.1} Y {:.1} mm is too thin for the walls and will not print. {fix}",
                        at[0], at[1]
                    ),
                    layer: Some(a + lift),
                }
            })
            .collect();
        if runs.len() > SHOWN {
            out.push(SliceWarning {
                code: WarningCode::ThinWall,
                message: format!(
                    "{} more places have features too thin to print. {fix}",
                    runs.len() - SHOWN
                ),
                layer: None,
            });
        }
        out
    }

    /// Warnings for regions that cannot print without support while support is off: floating regions and
    /// overhangs reaching more than 6 mm past what holds them (`crate::floating`), with their layers, place and
    /// the fix.
    pub(crate) fn floating_warnings(&self, cfg: &PrintConfig) -> Vec<SliceWarning> {
        const SHOWN: usize = 5;
        let n = self.plan.count();
        let tops: Vec<f64> = (0..n).map(|l| self.plan.top(l)).collect();
        let slice = |l: usize| -> Shapes {
            let z = self.plan.slice_z.get(l).copied().unwrap_or(0.0);
            let mut loops: Vec<Polygon> = Vec::new();
            for p in &self.parts {
                p.slice(l, z, &mut loops);
            }
            perimeters::shapes_from_loops(&loops)
        };
        let threshold = cfg.support.threshold_angle;
        let layers = crate::floating::Layers {
            tops: &tops,
            slice: &slice,
            threshold_deg: if threshold > 0.0 { threshold } else { 30.0 },
            max_bridge_mm: cfg.support.max_bridge_length.max(0.0),
        };
        let mut found = crate::floating::find(&self.parts, &layers);
        crate::sorting::sort_by_key(&mut found, |f| f.layers.0);
        let lift = self.raft.as_ref().map_or(0, crate::raft::Plan::count);
        let mut out: Vec<SliceWarning> = found
            .iter()
            .take(SHOWN)
            .map(|f| {
                let (a, b) = (f.layers.0 + 1 + lift, f.layers.1 + 1 + lift);
                let span = if a == b { format!("layer {a}") } else { format!("layers {a} to {b}") };
                let z = f.z;
                let message = match f.kind {
                    crate::floating::Kind::Floating => format!(
                        "A region starts in mid-air on {span} (from Z {z:.2} mm) near X {:.1} Y {:.1} mm, with nothing under it. Turn on supports or paint support there.",
                        f.at[0], f.at[1]
                    ),
                    crate::floating::Kind::Overhang => format!(
                        "An overhang on {span} near X {:.1} Y {:.1} mm reaches {:.1} mm past what holds it. Turn on supports or paint support there.",
                        f.at[0], f.at[1], f.reach
                    ),
                    crate::floating::Kind::Bridge => format!(
                        "A bridge on {span} near X {:.1} Y {:.1} mm spans {:.1} mm, longer than the {:.0} mm max bridge length, and can sag. Turn on supports, or slow bridges down and give them more fan.",
                        f.at[0], f.at[1], f.reach, cfg.support.max_bridge_length
                    ),
                };
                let code = if f.kind == crate::floating::Kind::Bridge { WarningCode::LongBridge } else { WarningCode::FloatingRegion };
                SliceWarning { code, message, layer: Some(f.layers.0 + lift) }
            })
            .collect();
        if found.len() > SHOWN {
            out.push(SliceWarning {
                code: WarningCode::FloatingRegion,
                message: format!(
                    "{} more regions need support. Turn on supports or paint support there.",
                    found.len() - SHOWN
                ),
                layer: None,
            });
        }
        out
    }

    /// Organic trees: tree supports of the organic style, which is also the tree default.
    fn is_organic(cfg: &PrintConfig) -> bool {
        // Orca: a tree support type with a style that is not a tree style (default, grid, snug) is organic.
        let s = &cfg.support;
        s.style == SupportStyle::TreeOrganic || (s.tree && !s.style.is_tree())
    }

    /// Orca's support parameters for organic trees (`SupportParameters`).
    fn organic_params(cfg: &PrintConfig) -> crate::organic::Params {
        let s = &cfg.support;
        let w = cfg.support_width();
        let spacing = cfg.spacing_for(w);
        let top = s.interface_top_layers as usize;
        let support_density = (spacing / (s.base_spacing + spacing)).min(1.0);
        let top_density = if top == 0 {
            support_density
        } else {
            (spacing / (if s.ironing { 0.0 } else { s.interface_spacing } + spacing)).min(1.0)
        };
        crate::organic::Params {
            num_top_interface_layers: top,
            num_top_base_interface_layers: 0,
            num_bottom_interface_layers: s.interface_bottom_layers as usize,
            has_top_contacts: top > 0,
            zero_gap_interface_top: top > 0 && s.top_z_distance <= 0.0,
            num_raft_layers: 0,
            base_angle: s.angle,
            support_spacing: spacing,
            interface_spacing: spacing,
            support_width: w,
            interface_width: w,
            top_interface_density: top_density,
            bottom_interface_density: (spacing / (s.bottom_interface_spacing + spacing)).min(1.0),
            support_density,
            base_rectilinear: s.base_pattern == InfillPattern::Honeycomb
                || support_density > 0.95
                || s.tree_settings.wall_count > 0,
            interface_rectilinear: top_density > 0.95,
        }
    }

    /// Organic trees (Orca's `TreeSupport3D`), one support layer per object layer.
    fn organic_layers(&self, cfg: &PrintConfig, input: &SupportInput) -> crate::organic::OrganicPlan {
        let n = self.plan.count();
        let tops: Vec<f64> = (0..n).map(|l| self.plan.top(l)).collect();
        let sc = cfg.support_config();
        let s = &cfg.support;
        let independent = cfg.independent_support_layer_height();
        // Orca's `gap_support_object` and `gap_object_support`: zero with a zero gap interface, else the Z distance,
        // rounded to whole layers when support shares the object's layers.
        let gap = |d: f64| {
            if independent {
                d
            } else {
                (d / cfg.layer_height + 1e-6).round() * cfg.layer_height
            }
        };
        let zero_top = s.interface_top_layers > 0 && s.top_z_distance <= 0.0;
        let zero_bottom =
            s.interface_bottom_layers > 0 && (s.bottom_z_distance <= 0.0 || s.top_z_distance <= 0.0);
        let t = &s.tree_settings;
        let raw = crate::organic::settings::Raw {
            layer_height: cfg.layer_height,
            resolution: cfg.raw_number("resolution", 0.012),
            min_feature_size: cfg.raw_number("min_feature_size", 25.0) / 100.0 * cfg.nozzle_diameter,
            support_line_width: cfg.support_width(),
            interface_line_width: cfg.support_width(),
            external_perimeter_width: cfg.outer_wall_width(),
            top_layers: s.interface_top_layers,
            bottom_layers: s.interface_bottom_layers,
            on_bed_only: s.on_build_plate_only,
            xy_distance: s.xy_distance,
            top_distance: if zero_top { 0.0 } else { gap(s.top_z_distance) },
            bottom_distance: if zero_bottom {
                0.0
            } else {
                gap(s.bottom_z_distance)
            },
            top_z_gap: s.top_z_distance,
            interface_spacing: s.interface_spacing,
            branch_distance: t.branch_distance_organic,
            branch_angle: t.branch_angle_organic,
            angle_slow: t.angle_slow,
            branch_diameter: t.branch_diameter_organic,
            branch_diameter_angle: t.branch_diameter_angle,
            top_rate: t.top_rate,
            tip_diameter: t.tip_diameter,
        };
        let brim = self.organic_brim(cfg, input.models.first());
        let inp = crate::organic::OrganicIn {
            tree: crate::treeclassic::TreeIn {
                models: &input.models,
                tops: &tops,
                thickness: &input.thickness,
                cfg: &sc,
                line_width: cfg.line_width,
                support_width: cfg.support_width(),
                force: &input.force,
                block: &input.block,
                object: self.bounds,
                bed: cfg.bed_rect(),
                critical_only: crate::firmware::truthy(cfg, "support_critical_regions_only"),
                first_layer_gap: sc.object_first_layer_gap,
                min_layer_height: cfg.raw_number("min_layer_height", 0.07),
                raft_first_layer_expansion: cfg.raw_number("raft_first_layer_expansion", 2.0),
                independent: false,
                max_layer_height: cfg.layer_height,
            },
            raw,
            params: Self::organic_params(cfg),
            first_layer_height: self.plan.top(0) + self.raft.as_ref().map_or(0.0, |r| r.offset),
            first_layer_expansion: cfg.raw_number("raft_first_layer_expansion", 2.0),
            first_layer_width: cfg
                .feature_widths
                .initial_layer
                .unwrap_or_else(|| cfg.support_width()),
            gap_xy_first_layer: s.object_first_layer_gap,
            brim,
            vertical_points: self
                .painted_supports
                .iter()
                .filter(|(_, st)| *st == 1)
                .filter(|(t, _)| {
                    ((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]))
                        .abs()
                        < 1e-9
                })
                .map(|(t, _)| {
                    [
                        (t[0][0] + t[1][0] + t[2][0]) / 3.0,
                        (t[0][1] + t[1][1] + t[2][1]) / 3.0,
                        (t[0][2] + t[1][2] + t[2][2]) / 3.0,
                    ]
                })
                .collect(),
            raft_tops: self
                .raft
                .as_ref()
                .map(|r| r.layers.iter().map(|l| l.top).collect())
                .unwrap_or_default(),
            raft_contact: self
                .raft
                .as_ref()
                .map(|r| r.area(crate::raft::Kind::Contact, &r.first_layer))
                .unwrap_or_default(),
            raft_expansion: cfg.raw_number("raft_expansion", 1.5),
        };
        crate::organic::plan(&inp)
    }

    /// The paths of an organic layer, with the contact loops and support ironing of the top contact
    /// (`LoopInterfaceProcessor` and the ironing pass of `generate_support_toolpaths`). Orca builds its organic
    /// contacts without the overhangs they hold up, so its loops come out empty there; here they follow the
    /// overhangs as on normal supports.
    fn organic_support_paths(
        &self,
        cfg: &PrintConfig,
        o: &crate::organic::OrganicLayer,
        layer: u32,
        center: [f64; 2],
    ) -> SupportPaths {
        let s = &cfg.support;
        let wmm = cfg.support_width();
        let p = self.organic_paths_in(cfg, center);
        let mut iron = Vec::new();
        if s.ironing && s.interface_top_layers > 0 && !o.top_contact.is_empty() {
            let area = perimeters::difference(&o.top_contact, &self.support_above(cfg, layer));
            let gap = s.ironing_spacing.max(0.01);
            let angle = crate::organic::paths::interface_angle(o, &p);
            iron = if s.ironing_concentric {
                crate::surface::fill(&area, crate::surface::Curve::Concentric, gap, 0.0)
            } else {
                crate::patterns::support_lines(&area, gap, gap, angle, false, 3.0 * gap, center)
            };
        }
        let mut loops = Vec::new();
        let looped;
        let layer_in = if s.interface_loops
            && s.interface_top_layers > 0
            && !o.top_contact.is_empty()
            && !o.hang.is_empty()
        {
            let (l, keep_out) = contact_loops(&o.top_contact, &o.hang, wmm);
            loops = l;
            let mut c = o.clone();
            c.top_contact = perimeters::difference(&o.top_contact, &keep_out);
            looped = c;
            &looped
        } else {
            o
        };
        let (support, mut interface) =
            crate::organic::paths::layer_paths(layer_in, layer, self.plan.top(layer), &p);
        loops.append(&mut interface);
        SupportPaths {
            support,
            interface: loops,
            ironing: iron,
        }
    }

    /// The first layer area the brim takes, which organic support keeps out of (Orca's `generate_raft_base`).
    fn organic_brim(&self, cfg: &PrintConfig, first: Option<&Shapes>) -> Option<Shapes> {
        let first = first?;
        let kind = match cfg.raw.get("brim_type") {
            Some(serde_json::Value::String(t)) => t.clone(),
            _ => "auto_brim".to_string(),
        };
        let width = cfg.raw_number("brim_width", 5.0);
        let has = (kind != "no_brim" && width > 0.0) || kind == "auto_brim";
        if !has || self.raft.is_some() {
            return None;
        }
        let gap = mm(cfg.raw_number("brim_object_gap", 0.0));
        let outer = kind == "outer_only" || kind == "outer_and_inner";
        let inner = kind == "inner_only" || kind == "outer_and_inner";
        Some(if outer && inner {
            perimeters::offset(first, gap)
        } else if outer {
            let contours: Shapes = first
                .iter()
                .filter_map(|sh| sh.first().map(|c| vec![c.clone()]))
                .collect();
            let holes: Shapes = first
                .iter()
                .flat_map(|sh| sh.iter().skip(1))
                .map(|h| vec![h.iter().rev().copied().collect()])
                .collect();
            perimeters::difference(&perimeters::offset_round(&contours, gap), &holes)
        } else {
            first.clone()
        })
    }

    /// What the organic toolpaths read (Orca's `SupportParameters` and flows).
    fn organic_paths_in(&self, cfg: &PrintConfig, center: [f64; 2]) -> crate::organic::paths::PathsIn {
        use crate::config::InterfacePattern as IP;
        use crate::organic::paths::ContactFill;
        let s = &cfg.support;
        let p = Self::organic_params(cfg);
        let first_width = cfg
            .feature_widths
            .initial_layer
            .unwrap_or_else(|| cfg.support_width());
        let h0 = self.plan.thickness(0);
        let pattern = match cfg.raw.get("support_base_pattern") {
            Some(serde_json::Value::String(t)) => t.clone(),
            _ => "default".to_string(),
        };
        let zero_gap = s.interface_top_layers > 0 && s.top_z_distance <= 0.0;
        let contact_fill = match s.interface_pattern {
            IP::Grid => ContactFill::Grid,
            IP::RectilinearInterlaced => ContactFill::Rectilinear,
            IP::Concentric => ContactFill::Concentric,
            IP::Auto if zero_gap => ContactFill::Concentric,
            _ if p.top_interface_density > 0.95 => ContactFill::Rectilinear,
            _ => ContactFill::SupportBase,
        };
        crate::organic::paths::PathsIn {
            width: p.support_width,
            spacing: p.support_spacing,
            interface_width: p.interface_width,
            interface_spacing: p.interface_spacing,
            first_width,
            first_spacing: (first_width - h0 * (1.0 - std::f64::consts::FRAC_PI_4)).max(first_width * 0.5),
            first_density: (cfg.raw_number("raft_first_layer_density", 90.0) / 100.0).clamp(0.01, 1.0),
            support_density: p.support_density,
            top_interface_density: p.top_interface_density,
            bottom_interface_density: p.bottom_interface_density,
            base_rectilinear: p.base_rectilinear,
            contact_fill,
            angle: s.angle,
            interface_pattern: s.interface_pattern,
            top_layers: s.interface_top_layers,
            bottom_layers: s.interface_bottom_layers,
            hollow: pattern == "default" || pattern == "hollow",
            double_wall_mm2: match s.tree_settings.wall_count {
                0 => 0.25 * std::f64::consts::PI * 25.0,
                1 => f64::MAX,
                _ => 1e-12,
            },
            center,
            anchor_max: cfg.anchor_max_mm(),
        }
    }

    /// The support area of every layer, planned once for the whole plate.
    fn support_layers(&self, cfg: &PrintConfig) -> &[crate::support::SupportLayer] {
        debug_assert!(
            self.support.get().is_some() || !self.support_pending.0.load(Ordering::Relaxed),
            "the support plan was asked for while it is planned beside the layers"
        );
        self.support.plan(|| {
            let input = self.support_input(cfg);
            let (layers, raft) = self.plan_support(cfg, &input);
            if let Some(raft) = raft {
                let _ = self.organic_raft.set(raft);
            }
            layers
        })
    }

    /// The support plan from its inputs, and the branches through the raft under organic trees. It reads and
    /// works out no value of the session that is worked out once, so it can run beside the layers.
    fn plan_support(
        &self,
        cfg: &PrintConfig,
        input: &SupportInput,
    ) -> (Vec<crate::support::SupportLayer>, Option<Vec<Shapes>>) {
        if cfg.support.style.is_classic_tree() {
            return (self.classic_tree_layers(cfg, input), None);
        }
        if Self::is_organic(cfg) {
            let plan = self.organic_layers(cfg, input);
            return (plan.layers, Some(plan.raft));
        }
        let layers = crate::support::plan(
            &input.models,
            &input.thickness,
            &cfg.support_config(),
            mm(cfg.support_width()),
            &input.force,
            &input.block,
            input.center,
        );
        (layers, None)
    }

    /// How many support layers under support layer `layer` print interface: Orca's support layer
    /// `interface_id`, which turns the interface lines of snug supports between layers.
    fn interface_id(&self, cfg: &PrintConfig, layer: u32) -> usize {
        let n = layer as usize;
        if self.stack.is_empty() {
            self.support_layers(cfg)
                .iter()
                .take(n)
                .filter(|l| !l.interface.is_empty())
                .count()
        } else {
            self.stack
                .iter()
                .take(n)
                .filter(|l| !l.layer.interface.is_empty())
                .count()
        }
    }

    /// The support islands of the support layer right above `layer`, when it rests on it.
    fn support_above(&self, cfg: &PrintConfig, layer: u32) -> Shapes {
        let next = layer as usize + 1;
        let sl = if self.stack.is_empty() {
            self.support_layers(cfg).get(next)
        } else {
            match (self.stack.get(layer as usize), self.stack.get(next)) {
                (Some(here), Some(up)) if up.top - up.height <= here.top + 1e-4 => Some(&up.layer),
                _ => None,
            }
        };
        sl.map(|l| perimeters::union_all(&[&l.base, &l.interface]))
            .unwrap_or_default()
    }

    /// The support, support interface and support ironing paths of one support layer. `layer` is its
    /// index (layer 0 prints the first-layer pad) and `z` the plane the object was cut at. Orca:
    /// `generate_support_toolpaths` and `SupportParameters` (SupportCommon.cpp, SupportParameters.hpp).
    fn support_paths(
        &self,
        cfg: &PrintConfig,
        sl: &crate::support::SupportLayer,
        layer: u32,
        z: f64,
    ) -> SupportPaths {
        use crate::config::InterfacePattern as P;
        let mut support: Vec<Vec<crate::geom::Point>>;
        let wmm = cfg.support_width();
        let s = &cfg.support;
        let center = [
            f64::midpoint(self.bounds[0], self.bounds[2]),
            f64::midpoint(self.bounds[1], self.bounds[3]),
        ];
        let tree = s.style.is_tree() || s.tree;
        if let Some(t) = &sl.classic {
            return self.classic_tree_paths(cfg, t, layer, center);
        }
        if let Some(o) = &sl.organic {
            return self.organic_support_paths(cfg, o, layer, center);
        }
        // Support flows are sized at the object layer height, so every layer's lines stay aligned.
        let spacing = cfg.spacing_for(wmm);
        let mut interface_area = sl.interface.clone();
        // The pad is the support layer that stands on the bed (Orca: a base layer with its bottom at 0), which
        // is the first one only when the first support rests on the bed rather than on the part.
        let on_bed = layer == 0 && self.stack.first().is_none_or(|st| st.top - st.height < 1e-4);
        if on_bed && self.raft.is_none() && !tree {
            support = self.support_pad(cfg, sl, center);
            // Interface on the first layer (a contact resting on the bed) prints as interface.
        } else if on_bed && self.raft.is_none() {
            // The first support layer is a dense pad wider than the support above it
            // (`raft_first_layer_expansion`, `raft_first_layer_density`), inside one loop.
            let both = perimeters::union_all(&[&sl.base, &sl.interface]);
            interface_area = Vec::new();
            let expand = s.tree_settings.brim_width.max(1.85);
            let pad = perimeters::offset(&both, mm(expand));
            let pitch = wmm / 0.9;
            support =
                crate::patterns::support_lines(&pad, wmm, pitch, 0.0, false, cfg.anchor_max_mm(), center);
            let loop_ring = perimeters::offset(&pad, -mm(wmm / 2.0));
            for ring in loop_ring.iter().filter_map(|sh| sh.first()) {
                let mut pts: Vec<crate::geom::Point> =
                    ring.iter().map(|p| crate::geom::Point::new(p.x, p.y)).collect();
                if let Some(f) = pts.first().copied() {
                    pts.push(f);
                }
                support.insert(0, pts);
            }
        } else if tree {
            // Branches: loops around each, and lines inside the wide ones.
            // Walls 0 lets the style decide: two.
            let walls = if s.tree_settings.wall_count == 0 {
                2
            } else {
                s.tree_settings.wall_count
            };
            // Hybrid: the normal part prints as normal support rows, the rest as branches.
            let normal = if sl.normal.is_empty() {
                Vec::new()
            } else {
                perimeters::intersection(&sl.base, &sl.normal)
            };
            let trees = if normal.is_empty() {
                sl.base.clone()
            } else {
                perimeters::difference(&sl.base, &normal)
            };
            let mut lines: Vec<Vec<crate::geom::Point>> = Vec::new();
            for k in 0..walls {
                let ring = perimeters::offset(&trees, -mm(wmm * (f64::from(k) + 0.5)));
                for r in ring.iter().flat_map(|sh| sh.iter()) {
                    let mut pts: Vec<crate::geom::Point> =
                        r.iter().map(|p| crate::geom::Point::new(p.x, p.y)).collect();
                    if let Some(f) = pts.first().copied() {
                        pts.push(f);
                    }
                    lines.push(pts);
                }
            }
            let core = perimeters::offset(&trees, -mm(wmm * (f64::from(walls) + 0.5)));
            lines.extend(crate::patterns::support_lines(
                &core,
                wmm,
                s.base_spacing + cfg.flow_spacing(),
                if layer.is_multiple_of(2) { 45.0 } else { 135.0 },
                false,
                0.0,
                center,
            ));
            if !normal.is_empty() {
                lines.extend(crate::patterns::support_lines(
                    &normal,
                    wmm,
                    s.base_spacing + cfg.flow_spacing(),
                    0.0,
                    true,
                    cfg.anchor_max_mm(),
                    center,
                ));
            }
            support = lines;
        } else if matches!(s.base_pattern, InfillPattern::Rectilinear | InfillPattern::Grid) {
            // Orca's support base filler (`FillSupportBase`): rows at `support_angle` joined along the outline;
            // plain rectilinear when the rows touch (density above 0.95). The rectilinear grid base turns a
            // right angle on every other layer.
            let pitch = s.base_spacing + spacing;
            let angle = if s.base_pattern == InfillPattern::Grid && layer % 2 == 1 {
                s.angle + 90.0
            } else {
                s.angle
            };
            support = if spacing / pitch <= 0.95 {
                crate::supportfill::support_base(&sl.base, spacing, spacing / pitch, angle, center)
            } else {
                crate::patterns::support_lines(
                    &sl.base,
                    spacing,
                    pitch,
                    angle,
                    false,
                    cfg.anchor_max_mm(),
                    center,
                )
            };
        } else {
            support = crate::patterns::sparse(&crate::patterns::SparseIn {
                pattern: s.base_pattern,
                region: &sl.base,
                w_mm: wmm,
                spacing_mm: s.base_spacing + spacing,
                density: 1.0,
                z_mm: z,
                layer,
                connect_mm: cfg.anchor_max_mm(),
                anchor_mm: 0.0,
                object: self.bounds,
                angle_deg: 45.0,
                lateral_angles: [-45.0, 45.0],
                overhang_angle_deg: 60.0,
                fixed_angle: false,
                gyroid_layer_height: None,
            });
        }
        if tree {
            let interface = crate::patterns::support_lines(
                &interface_area,
                wmm,
                s.interface_spacing + cfg.flow_spacing(),
                90.0,
                false,
                cfg.anchor_max_mm(),
                center,
            );
            return SupportPaths {
                support,
                interface,
                ..SupportPaths::default()
            };
        }
        let mut out = SupportPaths {
            support,
            ..SupportPaths::default()
        };
        if interface_area.is_empty() {
            return out;
        }
        let ironing = s.ironing && !sl.contact.is_empty();
        // Interface density: support ironing makes every top interface layer solid.
        let top_spacing = if s.ironing { 0.0 } else { s.interface_spacing } + spacing;
        let density = (spacing / top_spacing).min(1.0);
        let zero_gap = s.top_z_distance <= 0.0;
        // Snug interfaces (and the interlaced pattern) turn between +45 and -45 degrees from one interface
        // layer to the next; grid style and the rectilinear pattern keep a right angle to the base.
        let turning = 45.0
            * if self.interface_id(cfg, layer) % 2 == 1 {
                -1.0
            } else {
                1.0
            };
        let angle = match s.interface_pattern {
            P::RectilinearInterlaced => turning,
            _ if matches!(s.style, SupportStyle::Default | SupportStyle::Grid)
                || s.interface_pattern == P::Rectilinear =>
            {
                s.angle + 90.0
            }
            _ => turning,
        };
        // Contact loops around the top contact (`support_interface_loop_pattern`).
        if s.interface_loops && !sl.contact.is_empty() {
            let (loops, keep_out) = contact_loops(&sl.contact, &sl.hang, wmm);
            interface_area = perimeters::difference(&interface_area, &keep_out);
            out.interface.extend(loops);
        }
        let pattern = match s.interface_pattern {
            P::Grid => InfillPattern::Grid,
            P::Concentric => InfillPattern::Concentric,
            P::Auto if zero_gap => InfillPattern::Concentric,
            _ => InfillPattern::Rectilinear,
        };
        // Bottom interface (resting on the part) at `support_bottom_interface_spacing`, with the same filler,
        // which the top interface density picks (Orca's `contact_fill_pattern`).
        let bottom_density = (spacing / (s.bottom_interface_spacing + spacing)).min(1.0);
        let bottom_area = if sl.bottom.is_empty() {
            Vec::new()
        } else {
            perimeters::intersection(&interface_area, &sl.bottom)
        };
        let top_area = if bottom_area.is_empty() {
            interface_area
        } else {
            perimeters::difference(&interface_area, &bottom_area)
        };
        for (area, dens) in [(&top_area, density), (&bottom_area, bottom_density)] {
            if area.is_empty() {
                continue;
            }
            match pattern {
                InfillPattern::Grid => {
                    out.interface
                        .extend(crate::patterns::sparse(&crate::patterns::SparseIn {
                            pattern: InfillPattern::Grid,
                            region: area,
                            w_mm: wmm,
                            spacing_mm: spacing,
                            density: dens,
                            z_mm: z,
                            layer,
                            connect_mm: cfg.anchor_max_mm(),
                            anchor_mm: 0.0,
                            object: self.bounds,
                            angle_deg: angle,
                            lateral_angles: [-45.0, 45.0],
                            overhang_angle_deg: 60.0,
                            fixed_angle: false,
                            gyroid_layer_height: None,
                        }));
                }
                InfillPattern::Concentric => {
                    out.interface.extend(crate::surface::fill(
                        area,
                        crate::surface::Curve::Concentric,
                        spacing / dens,
                        0.0,
                    ));
                }
                // Solid lines when they touch, else the support base filler.
                _ if density <= 0.95 => {
                    out.interface.extend(crate::supportfill::support_base(
                        area, spacing, dens, angle, center,
                    ));
                }
                _ => out.interface.extend(crate::patterns::support_lines(
                    area,
                    spacing,
                    spacing / dens,
                    angle,
                    false,
                    cfg.anchor_max_mm(),
                    center,
                )),
            }
        }
        if ironing {
            // Over the top contact, less what the support layer above covers, at the interface angle.
            let area = perimeters::difference(&sl.contact, &self.support_above(cfg, layer));
            let gap = s.ironing_spacing.max(0.01);
            out.ironing = if s.ironing_concentric {
                crate::surface::fill(&area, crate::surface::Curve::Concentric, gap, 0.0)
            } else {
                crate::patterns::support_lines(&area, gap, gap, angle, false, 3.0 * gap, center)
            };
        }
        out
    }

    /// The toolpaths of a slim, strong or hybrid tree layer (Orca's `TreeSupport::generate_toolpaths`).
    fn classic_tree_paths(
        &self,
        cfg: &PrintConfig,
        t: &crate::treeclassic::TreeLayer,
        layer: u32,
        center: [f64; 2],
    ) -> SupportPaths {
        let s = &cfg.support;
        let wmm = cfg.support_width();
        let h = if self.stack.is_empty() {
            self.plan.thickness(layer)
        } else {
            self.stack.get(layer as usize).map_or(0.2, |s| s.height)
        }
        .max(0.01);
        let spacing = (wmm - h * (1.0 - std::f64::consts::FRAC_PI_4)).max(wmm * 0.5);
        let object_spacing = cfg.spacing_for(wmm);
        let first_w = cfg.feature_widths.initial_layer.unwrap_or(wmm);
        let h0 = self.plan.thickness(0);
        let first_spacing = (first_w - h0 * (1.0 - std::f64::consts::FRAC_PI_4)).max(first_w * 0.5);
        let pattern = match cfg.raw.get("support_base_pattern") {
            Some(serde_json::Value::String(p)) => p.clone(),
            _ => "default".to_string(),
        };
        let default_pattern = pattern == "default";
        // Lightning bases print their walls as hollow branches do, with the lightning lines inside.
        let lightning = pattern == "lightning";
        let with_infill =
            !(pattern == "hollow" || lightning || (default_pattern && s.style != SupportStyle::TreeHybrid));
        let has_roof = |l: &crate::support::SupportLayer| {
            l.classic
                .as_ref()
                .is_some_and(|c| !c.roof.is_empty() || !c.roof_first.is_empty())
        };
        let interface_id = if self.stack.is_empty() {
            self.support_layers(cfg)
                .iter()
                .take(layer as usize)
                .filter(|l| has_roof(l))
                .count()
        } else {
            self.stack
                .iter()
                .take(layer as usize)
                .filter(|l| has_roof(&l.layer))
                .count()
        };
        let inp = crate::treepaths::TreePathsIn {
            width: wmm,
            spacing,
            first_width: first_w,
            first_spacing,
            interface_density: (object_spacing / (s.interface_spacing + object_spacing)).min(1.0),
            bottom_density: (object_spacing / (s.bottom_interface_spacing + object_spacing)).min(1.0),
            base_density: (spacing / (s.base_spacing + spacing)).min(1.0),
            first_density: (cfg.raw_number("raft_first_layer_density", 90.0) / 100.0).clamp(0.01, 1.0),
            angle: s.angle,
            interface_pattern: s.interface_pattern,
            interface_id,
            wall_count: s.tree_settings.wall_count,
            with_infill,
            default_pattern,
            on_bed: layer == 0 && self.raft.is_none(),
            anchor_max: cfg.sparse_infill_anchor_max,
            center,
        };
        let (mut support, interface) = crate::treepaths::layer_paths(t, &inp);
        if lightning && !inp.on_bed {
            // Orca: the lines inside each base area pulled in a line spacing, pieces under 1 mm left out.
            let lines = self
                .tree_lightning(cfg)
                .get(layer as usize)
                .map_or(&[][..], Vec::as_slice);
            if !lines.is_empty() {
                for a in &t.base {
                    let area = perimeters::offset(&a.shape, -mm(spacing));
                    support.extend(crate::lightning::clip(lines, &area).into_iter().filter(|pl| {
                        let len: f64 = pl
                            .windows(2)
                            .map(|w| match w {
                                [a, b] => {
                                    let (dx, dy) = (f64::from(b.x - a.x), f64::from(b.y - a.y));
                                    (dx * dx + dy * dy).sqrt()
                                }
                                _ => 0.0,
                            })
                            .sum();
                        len >= crate::geom::SCALE
                    }));
                }
            }
        }
        SupportPaths {
            support,
            interface,
            ..SupportPaths::default()
        }
    }

    /// The lightning lines of slim, strong and hybrid tree bases (`support_base_pattern` = lightning) on
    /// every support layer, mm. Orca's `TreeSupport::generate_toolpaths` lightning block and the support
    /// `FillLightning::Generator`: each layer with support and another below it hands the layer below its
    /// base as the outline and, as what to hold up, that base pulled in two support widths less its own;
    /// the density doubles the support base density, at least 0.15, and the angles are 45 degrees.
    fn tree_lightning(&self, cfg: &PrintConfig) -> &[Vec<Vec<[f64; 2]>>] {
        self.tree_lightning.plan(|| {
            let layers = self.support_layers(cfg);
            let present: Vec<bool> = layers
                .iter()
                .map(|l| {
                    l.classic.as_ref().is_some_and(|t| {
                        !t.base.is_empty()
                            || !t.roof.is_empty()
                            || !t.roof_first.is_empty()
                            || !t.floor.is_empty()
                    })
                })
                .collect();
            let base_of = |k: usize| -> Shapes {
                layers
                    .get(k)
                    .and_then(|l| l.classic.as_ref())
                    .map(|t| perimeters::union_all(&t.base.iter().map(|a| &a.shape).collect::<Vec<_>>()))
                    .unwrap_or_default()
            };
            let wmm = cfg.support_width();
            let (mut contours, mut overhangs, mut at) = (Vec::new(), Vec::new(), Vec::new());
            for k in 1..layers.len() {
                if !present.get(k).copied().unwrap_or(false) {
                    continue;
                }
                let Some(lower) = (0..k).rev().find(|&j| present.get(j).copied().unwrap_or(false)) else {
                    continue;
                };
                if lower == 0 {
                    continue;
                }
                let low = base_of(lower);
                overhangs.push(perimeters::difference(
                    &perimeters::offset(&low, -mm(2.0 * wmm)),
                    &base_of(k),
                ));
                contours.push(low);
                at.push(lower);
            }
            let mut out = vec![Vec::new(); layers.len()];
            if contours.is_empty() {
                return out;
            }
            let lh = self.plan.height;
            let spacing = (wmm - lh * (1.0 - std::f64::consts::FRAC_PI_4)).max(wmm * 0.5);
            let density = (spacing / (cfg.support.base_spacing + spacing) * 2.0).clamp(0.15, 1.0);
            let lines = crate::lightning::plan_with(
                &contours,
                Some(overhangs),
                &crate::lightning::Params {
                    line_width: cfg.sparse_infill_width(),
                    joint_overlap: 0.0,
                    density_percent: density * 100.0,
                    layer_height: lh,
                    overhang_angle: 45.0,
                    prune_angle: 45.0,
                    straighten_angle: 45.0,
                },
            );
            for (k, l) in at.into_iter().zip(lines) {
                if let Some(slot) = out.get_mut(k) {
                    *slot = l;
                }
            }
            out
        })
    }

    /// The first support layer: the base widened by `raft_first_layer_expansion` in steps that each stay
    /// `support_object_first_layer_gap` clear of the part, printed as one loop around a fill of
    /// `raft_first_layer_density` across the base lines (Orca's `generate_raft_base` and the base flange in
    /// `generate_support_toolpaths`).
    fn support_pad(
        &self,
        cfg: &PrintConfig,
        sl: &crate::support::SupportLayer,
        center: [f64; 2],
    ) -> Vec<Vec<crate::geom::Point>> {
        let s = &cfg.support;
        if sl.base.is_empty() {
            return Vec::new();
        }
        let wmm = cfg.support_width();
        let h0 = self.plan.thickness(0);
        let first_spacing = (wmm - h0 * (1.0 - std::f64::consts::FRAC_PI_4)).max(wmm * 0.5);
        let density = (cfg.raw_number("raft_first_layer_density", 90.0) / 100.0).clamp(0.01, 1.0);
        let pad = self.pad_area(cfg, sl);
        // The loop runs half a line inside the area, the fill a little further in.
        let ring = perimeters::offset(&pad, -mm(wmm / 2.0));
        let mut support: Vec<Vec<crate::geom::Point>> = Vec::new();
        for r in ring.iter().flat_map(|sh| sh.iter()) {
            let mut pts: Vec<crate::geom::Point> =
                r.iter().map(|p| crate::geom::Point::new(p.x, p.y)).collect();
            if let Some(f) = pts.first().copied() {
                pts.push(f);
            }
            support.push(pts);
        }
        let inner = perimeters::offset(&ring, -mm(0.4 * first_spacing));
        support.extend(crate::patterns::support_lines(
            &inner,
            first_spacing,
            first_spacing / density,
            s.angle + 90.0,
            false,
            cfg.anchor_max_mm(),
            center,
        ));
        support
    }

    /// The area of the first support layer's pad: the base widened by `raft_first_layer_expansion` in steps
    /// that stay `support_object_first_layer_gap` clear of the part, less the interface.
    fn pad_area(&self, cfg: &PrintConfig, sl: &crate::support::SupportLayer) -> Shapes {
        let s = &cfg.support;
        let wmm = cfg.support_width();
        let expand = cfg.raw_number("raft_first_layer_expansion", 2.0).max(0.0);
        let mut pad = sl.base.clone();
        if expand > 1e-3 {
            let first = self.layer_regions(0, Families::new(cfg), &Micros::default());
            let part: Vec<&Shapes> = first.regions.iter().map(|(_, sh)| sh).collect();
            let trim = perimeters::offset(&perimeters::union_all(&part), mm(s.object_first_layer_gap));
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a few steps"
            )]
            let steps = ((expand / wmm).ceil() as u32).max(5);
            let step = mm(expand / f64::from(steps));
            for _ in 0..steps {
                pad = perimeters::difference(&perimeters::offset(&pad, step), &trim);
            }
        }
        perimeters::difference(&pad, &sl.interface)
    }

    /// Stage 2 for one layer: cut, merge per slot, resolve overlaps, and scan
    /// the outline for neighbors' top and bottom detection.
    fn layer_regions(&self, layer: u32, fam: Families, micros: &Micros) -> LayerRegions {
        self.layer_regions_with(layer, fam, micros, false)
    }

    /// [`Self::layer_regions`] of every layer with `fam`, cut once for all the whole-object plans; the slice
    /// takes them over afterwards (`take_whole`).
    fn whole_regions(&self, fam: Families, micros: &Micros) -> std::sync::Arc<Vec<LayerRegions>> {
        if let Ok(g) = self.whole.0.lock()
            && let Some((f, r)) = g.as_ref()
            && *f == fam
        {
            return std::sync::Arc::clone(r);
        }
        // Every layer below reads the interlocking beams, which plan in parallel: planned here first, not
        // inside the layer jobs (the rule in `par`).
        self.interlocked(fam, fam, micros);
        let all = std::sync::Arc::new(par::map_range(0..self.plan.count(), |l| {
            self.layer_regions(l, fam, micros)
        }));
        if let Ok(mut g) = self.whole.0.lock() {
            *g = Some((fam, std::sync::Arc::clone(&all)));
        }
        all
    }

    /// The regions [`Self::whole_regions`] cut with `fam`, one slot per layer, given up by the session.
    fn take_whole(&self, fam: Families) -> Vec<Option<LayerRegions>> {
        let kept = self.whole.0.lock().ok().and_then(|mut g| g.take());
        match kept {
            Some((f, all)) if f == fam => match std::sync::Arc::try_unwrap(all) {
                Ok(v) => v.into_iter().map(Some).collect(),
                Err(_) => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// The slices of the layer before beam interlocking (`base`), or the regions the layer prints.
    fn layer_regions_with(&self, layer: u32, fam: Families, micros: &Micros, base: bool) -> LayerRegions {
        let t = Timer::start();
        let z = self.plan.slice_z.get(layer as usize).copied().unwrap_or(0.0);
        let mut open_chains = 0;
        let mut regions: Vec<(u8, Shapes)> = Vec::with_capacity(self.slots.len());
        let mut loops: Vec<Polygon> = Vec::new();
        // Painted parts split into color regions; their pieces join the plain parts of the same slot.
        let mut painted: Vec<(u8, Shapes)> = Vec::new();
        for p in self.parts.iter().filter(|p| !p.paint.is_empty()) {
            loops.clear();
            open_chains += p.slice(layer as usize, z, &mut loops);
            if loops.is_empty() {
                continue;
            }
            let shapes = perimeters::shapes_from_loops_mode(&loops, fam.resolution, fam.slicing, fam.closing);
            let contour_at = |l: i64| -> Shapes {
                let Ok(idx) = usize::try_from(l) else {
                    return Vec::new();
                };
                let Some(&zl) = self.plan.slice_z.get(idx) else {
                    return Vec::new();
                };
                let mut lp: Vec<Polygon> = Vec::new();
                p.slice(idx, zl, &mut lp);
                perimeters::shapes_from_loops_mode(&lp, fam.resolution, fam.slicing, fam.closing)
            };
            let l = i64::from(layer);
            let step = |j: usize| i64::try_from(j).unwrap_or(i64::MAX / 2);
            let above: Vec<Shapes> = (1..=fam.top_shell).map(|j| contour_at(l + step(j))).collect();
            let below: Vec<Shapes> = (1..=fam.bottom_shell).map(|j| contour_at(l - step(j))).collect();
            let ctx = crate::paint::LayerPaint {
                default_slot: p.slot,
                shapes: &shapes,
                layer,
                z,
                plan: &self.plan,
                above: &above,
                below: &below,
                facets: &p.paint,
            };
            let mut split = ctx.split();
            // `mmu_segmented_region_max_width` (Orca's `cut_segmented_layers`): painted colors reach only this far
            // in from the outline, the rest is the part's own filament; with an interlocking depth, even layers
            // use that depth instead, so the colors interlock.
            let (width, depth) = fam.paint_band;
            let band = if layer.is_multiple_of(2) && depth > 0 {
                depth
            } else {
                width
            };
            if band > 0 && split.iter().any(|(slot, _)| *slot != p.slot) {
                let core = perimeters::offset(&shapes, -band);
                let mut moved: Vec<Shapes> = Vec::new();
                for (_, sh) in split.iter_mut().filter(|(slot, _)| *slot != p.slot) {
                    moved.push(perimeters::intersection(sh, &core));
                    *sh = perimeters::difference(sh, &core);
                }
                let mut own: Vec<&Shapes> = moved.iter().collect();
                let rest: Vec<Shapes> = split
                    .iter()
                    .filter(|(slot, _)| *slot == p.slot)
                    .map(|(_, sh)| sh.clone())
                    .collect();
                own.extend(rest.iter());
                let own = perimeters::union_all(&own);
                split.retain(|(slot, sh)| *slot != p.slot && !sh.is_empty());
                split.push((p.slot, own));
            }
            painted.extend(split);
        }
        for &slot in &self.slots {
            loops.clear();
            for p in self.parts.iter().filter(|p| p.slot == slot && p.paint.is_empty()) {
                open_chains += p.slice(layer as usize, z, &mut loops);
            }
            let mut shapes = if loops.is_empty() {
                Vec::new()
            } else {
                perimeters::shapes_from_loops_mode(&loops, fam.resolution, fam.slicing, fam.closing)
            };
            for (s, extra) in painted.iter().filter(|(s, _)| *s == slot) {
                let _ = s;
                shapes = if shapes.is_empty() {
                    extra.clone()
                } else {
                    perimeters::union_all(&[&shapes, extra])
                };
            }
            if !shapes.is_empty() {
                regions.push((slot, shapes));
            }
        }
        // Negative volumes are cut out of every part.
        if let Some(cut) = self.volume_shapes(crate::plate::VolumeRole::Negative, layer, z) {
            for (_, s) in &mut regions {
                *s = perimeters::difference(s, &cut);
            }
            regions.retain(|(_, s)| !s.is_empty());
        }
        // A higher slot wins where parts overlap.
        let bounds: Vec<_> = regions.iter().map(|(_, s)| perimeters::bounds(s)).collect();
        for i in 0..regions.len() {
            let later: Vec<&Shapes> = regions
                .iter()
                .enumerate()
                .skip(i + 1)
                .filter(|(j, _)| {
                    perimeters::overlaps(
                        bounds.get(i).copied().flatten(),
                        bounds.get(*j).copied().flatten(),
                    )
                })
                .map(|(_, (_, s))| s)
                .collect();
            if later.is_empty() {
                continue;
            }
            let clip = if later.len() == 1 {
                later.first().map(|s| (*s).clone()).unwrap_or_default()
            } else {
                perimeters::union_all(&later)
            };
            if let Some((_, s)) = regions.get(i) {
                let clipped = perimeters::difference(s, &clip);
                if let Some(r) = regions.get_mut(i) {
                    r.1 = clipped;
                }
            }
        }
        // Size compensation (`xy_contour_compensation`, `xy_hole_compensation`, the elephant foot). Orca
        // skips the XY part on objects painted with several colors.
        // The brim follows the outline as it was.
        // `make_overhang_printable`: the cone under the layers above joins the last region, and the other
        // regions give up what it covers.
        if let Some(add) = self
            .conical
            .get()
            .and_then(Option::as_ref)
            .and_then(|a| a.get(layer as usize))
            .filter(|a| !a.is_empty())
        {
            let last = regions.len().saturating_sub(1);
            for (i, (_, s)) in regions.iter_mut().enumerate() {
                *s = if i == last {
                    perimeters::union_all(&[&*s, add])
                } else {
                    perimeters::difference(s, add)
                };
            }
            if regions.is_empty() {
                regions.push((self.slots.first().copied().unwrap_or(1), add.clone()));
            }
            regions.retain(|(_, s)| !s.is_empty());
        }
        let raw = (layer == 0 && self.comp.is_some()).then(|| {
            let all: Vec<&Shapes> = regions.iter().map(|(_, s)| s).collect();
            perimeters::union_all(&all)
        });
        let mut lslices = None;
        if let Some(c) = &self.comp {
            lslices = c.apply(
                &mut regions,
                layer,
                self.parts.iter().any(|p| !p.paint.is_empty()),
            );
            regions.retain(|(_, s)| !s.is_empty());
        }
        // `hole_to_polyhole`: the holes found on this layer become their polygons.
        if let Some(swaps) = self
            .polyholes
            .get()
            .and_then(Option::as_ref)
            .and_then(|p| p.get(layer as usize))
            .filter(|p| !p.is_empty())
        {
            for (_, shapes) in &mut regions {
                for shape in shapes.iter_mut() {
                    for ring in shape.iter_mut().skip(1) {
                        if let Some((_, new)) = swaps.iter().find(|(old, _)| old == ring) {
                            ring.clone_from(new);
                        }
                    }
                }
            }
        }
        // Spiral vase: above the base only the largest outline prints, without its holes.
        if self.vase.is_some_and(|b| layer >= b) {
            for (_, s) in &mut regions {
                *s = crate::spiral::largest_contour(s);
            }
        }
        if base {
            return LayerRegions {
                region_cfg: vec![0; regions.len()],
                regions,
                open_chains,
                raw,
                lslices,
                union: std::sync::OnceLock::new(),
            };
        }
        // Beam interlocking between filaments reshapes the regions of the whole object.
        if let Some(il) = self.interlocked(fam, fam, micros)
            && let Some(r) = il.get(layer as usize)
        {
            regions.clone_from(r);
            regions.retain(|(_, s)| !s.is_empty());
        }
        // Inside a modifier volume the object prints with the modifier's settings, as a region of its
        // own: its outline gets walls, like the boundary between two filaments.
        let mut region_cfg: Vec<u16> = vec![0; regions.len()];
        let mods = self.modifier_shapes(layer, z);
        if !mods.is_empty() {
            let mut split: Vec<(u8, Shapes)> = Vec::new();
            let mut split_cfg: Vec<u16> = Vec::new();
            for (slot, shapes) in std::mem::take(&mut regions) {
                let mut rest = shapes;
                let mut pieces: Vec<(Shapes, u16)> = Vec::new();
                // The last modifier wins where they overlap.
                for (k, m) in mods.iter().enumerate().rev() {
                    let piece = perimeters::intersection(&rest, m);
                    if !piece.is_empty() {
                        rest = perimeters::difference(&rest, &piece);
                        pieces.push((piece, u16::try_from(k + 1).unwrap_or(u16::MAX)));
                    }
                }
                if !rest.is_empty() {
                    split.push((slot, rest));
                    split_cfg.push(0);
                }
                for (piece, k) in pieces {
                    split.push((slot, piece));
                    split_cfg.push(k);
                }
            }
            regions = split;
            region_cfg = split_cfg;
        }
        Micros::add(&micros.contours, &t);
        LayerRegions {
            regions,
            region_cfg,
            open_chains,
            raw,
            lslices,
            union: std::sync::OnceLock::new(),
        }
    }

    /// What depends on a region's own settings: its line width, shell layers and infill pattern.
    fn shell_of(&self, cfg: &PrintConfig) -> Shell {
        let w = mm(cfg.line_width);
        #[allow(
            clippy::cast_possible_truncation,
            reason = "overlap is a fraction of a line width"
        )]
        let overlap = (f64::from(w) * cfg.infill_wall_overlap / 100.0).round() as i32;
        let (top_n, bot_n) = cfg.shell_layers(self.plan.height);
        Shell {
            w,
            overlap,
            top_n,
            bot_n,
            on_lines: cfg.sparse_infill_pattern.on_scanlines(),
        }
    }

    /// The walls, infill area and surface classes of every region of `layer`, in region order (`None` for an
    /// empty region). `cfg` is the layer's settings and `base_shell` what follows from them, `below` the material
    /// of the layer below and `upper_slice` the outline of the layer above. Regions of one filament whose walls
    /// are set alike share their walls, worked out with the first of them. `facts` are the layer's bridge facts:
    /// a region that is the whole outline, walled and classified with the layer's settings, takes its classes
    /// from them.
    #[allow(
        clippy::too_many_arguments,
        reason = "the layer, its settings, its neighbors and the slice's shared state"
    )]
    fn region_preps<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        base_shell: &Shell,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        below: Option<&Shapes>,
        upper_slice: Option<&Shapes>,
        micros: &Micros,
        tags: &Tags<'_>,
        facts: Option<&crate::bridging::Facts>,
    ) -> Vec<Option<RegionPrep>> {
        let n = self.plan.count();
        let Some(here) = get(layer) else { return Vec::new() };
        let layer_height = self.plan.thickness(layer);
        let top_or_bottom = layer == 0 || layer + 1 == n;
        let base_cfg = cfg;
        let region_config = |j: usize| match here.region_cfg.get(j).copied().unwrap_or(0) {
            0 => base_cfg,
            k => mods.get(usize::from(k) - 1).unwrap_or(base_cfg),
        };
        let mut group_inner: Vec<Option<Shapes>> = vec![None; here.regions.len()];
        let mut out = Vec::with_capacity(here.regions.len());
        for (ri, (slot, shapes)) in here.regions.iter().enumerate() {
            if shapes.is_empty() {
                out.push(None);
                continue;
            }
            // A region inside a modifier volume prints with the modifier's settings.
            let region_k = here.region_cfg.get(ri).copied().unwrap_or(0);
            let cfg = region_config(ri);
            let own_shell;
            let sh = if region_k == 0 {
                base_shell
            } else {
                own_shell = self.shell_of(cfg);
                &own_shell
            };
            let (w, overlap, top_n, bot_n) = (sh.w, sh.overlap, sh.top_n, sh.bot_n);
            // The first and the last layer's own walls use `top_bottom_infill_wall_overlap` (Orca's
            // `PerimeterGenerator` with no layer above, and on layer 0). The neighbors' infill areas, which the
            // layers around share, keep `overlap`.
            #[allow(
                clippy::cast_possible_truncation,
                reason = "overlap is a fraction of a line width"
            )]
            let own_overlap = if top_or_bottom {
                (f64::from(w) * cfg.raw_number("top_bottom_infill_wall_overlap", 25.0) / 100.0).round() as i32
            } else {
                overlap
            };
            let t = Timer::start();
            let mut loops = cfg.wall_loops;
            // An extra wall on every other layer, for strength between the layers.
            if crate::tower::flag(cfg, "alternate_extra_wall")
                && (layer + self.raft_layers()) % 2 == 1
                && cfg.sparse_infill_density > 0.0
            {
                loops += 1;
            }
            if layer == 0 && self.raft.is_none() && cfg.only_one_wall_first_layer {
                loops = loops.min(1);
            }
            // The topmost layer is one wall, so its top surface reaches the outer wall.
            if crate::tower::flag(cfg, "only_one_wall_top") && layer + 1 == n && loops > 0 {
                loops = 1;
            }
            let top_ctx = upper_slice
                .filter(|_| crate::tower::flag(cfg, "only_one_wall_top") && loops > 1)
                .map(|upper| perimeters::TopCtx { upper, lower: below });
            // `counterbore_hole_bridging`: the part of a counterbore's floor that bridges can span.
            let (counterbore_cut, counterbore) = match below {
                Some(b) if layer > 0 && crate::counterbore::wanted(cfg) => crate::counterbore::mask(
                    shapes,
                    b,
                    mm(cfg.spacing_for(cfg.inner_wall_width())),
                    mm(cfg.outer_wall_width()),
                ),
                _ => (Vec::new(), Vec::new()),
            };
            // Regions of one filament whose walls are set alike share their walls, as in Orca: a
            // modifier that only changes the infill does not put walls along its boundary.
            let group: Vec<usize> = (0..here.regions.len())
                .filter(|&j| {
                    here.regions
                        .get(j)
                        .is_some_and(|(sl, sh)| sl == slot && !sh.is_empty())
                        && wall_key(region_config(j)) == wall_key(cfg)
                })
                .collect();
            let (islands, inner) = match group.first() {
                Some(&first) if group.len() > 1 => {
                    let own = if ri == first {
                        let all: Vec<&Shapes> = group
                            .iter()
                            .filter_map(|&j| here.regions.get(j).map(|r| &r.1))
                            .collect();
                        let (islands, inner) = perimeters::walls_for_top(
                            cfg,
                            &perimeters::union_all(&all),
                            loops,
                            w,
                            own_overlap,
                            layer_height,
                            top_or_bottom,
                            top_ctx.as_ref(),
                        );
                        if let Some(c) = group_inner.get_mut(first) {
                            *c = Some(inner.clone());
                        }
                        (islands, inner)
                    } else {
                        (
                            Vec::new(),
                            group_inner.get(first).cloned().flatten().unwrap_or_default(),
                        )
                    };
                    (own.0, perimeters::intersection(&own.1, shapes))
                }
                _ if !counterbore_cut.is_empty() => {
                    // Counterbore floors a bridge can span are not walled; they print as bridging infill.
                    let (islands, inner) = perimeters::walls_for_top(
                        cfg,
                        &perimeters::difference(shapes, &counterbore_cut),
                        loops,
                        w,
                        own_overlap,
                        layer_height,
                        top_or_bottom,
                        top_ctx.as_ref(),
                    );
                    (islands, perimeters::union_all(&[&inner, &counterbore]))
                }
                _ => {
                    // A region that is the whole outline, walled as the neighbors see it, shares the walls
                    // the layers around already asked for (the infill area memo). Classic walls do not read
                    // the top context.
                    let whole = self
                        .cache_for_walls()
                        .filter(|_| {
                            loops == cfg.wall_loops
                                && (top_ctx.is_none() || !cfg.arachne_walls())
                                && !top_or_bottom
                                && *shapes == slice_shapes(here)
                        })
                        .and_then(|c| {
                            c.walls(i64::from(layer), tags.of(cfg), || {
                                Some(perimeters::walls_for(
                                    cfg,
                                    shapes,
                                    cfg.wall_loops,
                                    w,
                                    overlap,
                                    layer_height,
                                    false,
                                ))
                            })
                        });
                    match whole {
                        Some(v) => (*v).clone(),
                        None => perimeters::walls_for_top(
                            cfg,
                            shapes,
                            loops,
                            w,
                            own_overlap,
                            layer_height,
                            top_or_bottom,
                            top_ctx.as_ref(),
                        ),
                    }
                }
            };
            Micros::add(&micros.perimeters, &t);
            // What each part of the infill area is (classify.rs).
            // `interface_shells` (Orca's `detect_surfaces_type`): with several filaments in the object, a region's
            // top and bottom surfaces are found against the same filament's area above and below, so the
            // borders between filaments get solid shells.
            let own_filament = self.slots.len() > 1
                && crate::firmware::truthy(cfg, "interface_shells")
                && self.vase.is_none();
            let slice_of = |m: i64| -> Option<Shapes> {
                let m = self
                    .vase
                    .map_or(Some(m), |b| crate::spiral::neighbor(b, layer, m))?;
                let l = u32::try_from(m).ok()?;
                let r = get(l)?;
                if own_filament {
                    let same: Vec<&Shapes> = r
                        .regions
                        .iter()
                        .filter(|(t, _)| t == slot)
                        .map(|(_, s)| s)
                        .collect();
                    return Some(perimeters::union_all(&same));
                }
                Some(lower_shapes(r))
            };
            // Neighbors that do not depend on this layer are worked out once for all the layers around.
            let shared = (self.vase.is_none() && !own_filament).then_some(&self.cache);
            let region_tag = tags.of(cfg);
            let inner_of = |m: i64| -> Option<Shapes> {
                let m = self
                    .vase
                    .map_or(Some(m), |b| crate::spiral::neighbor(b, layer, m))?;
                let l = u32::try_from(m).ok()?;
                let work = || {
                    get(l).map(|r| {
                        perimeters::walls_for(
                            cfg,
                            &slice_shapes(r),
                            cfg.wall_loops,
                            w,
                            overlap,
                            self.plan.thickness(l),
                            false,
                        )
                    })
                };
                match shared {
                    Some(c) => c.inner(m, region_tag, work),
                    None => work().map(|v| v.1),
                }
            };
            // A region that is the layer's whole outline, walled and classified with the layer's own settings, has
            // the classification the layer's bridge facts were worked out from: the same inputs to `classify`.
            let known = facts.filter(|f| {
                region_k == 0 && shared.is_some() && *shapes == slice_shapes(here) && f.inner == inner
            });
            let cls = match known {
                Some(f) => f.classes(),
                None => crate::classify::classify(&crate::classify::In {
                    cfg,
                    layer,
                    count: n,
                    region: shapes,
                    inner: &inner,
                    slice: &slice_of,
                    inner_of: &inner_of,
                    top_layers: top_n,
                    bottom_layers: bot_n,
                    wall_loops: cfg.wall_loops,
                    cache: shared,
                    tag: region_tag,
                    whole_lower: own_filament
                        .then(|| layer.checked_sub(1).and_then(get).map(lower_shapes))
                        .flatten(),
                }),
            };
            out.push(Some(RegionPrep {
                islands,
                inner,
                cls,
                known: known.is_some(),
            }));
        }
        out
    }

    /// Stages 3 to 6 for one layer. `tags` holds the settings tags of the slice's configs.
    fn layer_paths<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
    ) -> LayerPaths {
        self.layer_paths_with(layer, cfg, mods, get, micros, tags, true)
    }

    /// [`Self::layer_paths`]; `smooth` lets a spiral layer blend its XY with the loop below, which is planned
    /// again without that blend (so a layer never depends on another shard's work).
    #[allow(
        clippy::too_many_arguments,
        reason = "the layer, its settings and the slice's shared state"
    )]
    fn layer_paths_with<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
        smooth: bool,
    ) -> LayerPaths {
        let start = self.layer_start(layer, cfg, mods, get, micros, tags);
        self.layer_finish(start, layer, cfg, mods, get, micros, tags, smooth)
    }

    /// The first part of [`Self::layer_paths_with`]: what the layer's regions print (walls, infill, surfaces,
    /// gap fill), all but its support. It reads nothing of the support plan, so it can run while that is
    /// planned.
    fn layer_start<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
    ) -> LayerStart {
        let n = self.plan.count();
        let vase_cfg;
        let cfg = if self.vase.is_some_and(|b| layer >= b) {
            vase_cfg = crate::spiral::layer_cfg(cfg);
            &vase_cfg
        } else {
            cfg
        };
        #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
        let mut out = LayerPaths {
            index: layer,
            local: layer,
            z: self.plan.top(layer) as f32,
            height: self.plan.thickness(layer) as f32,
            ..LayerPaths::default()
        };
        let Some(here) = get(layer) else {
            return LayerStart { out, rest: None };
        };
        if crate::travel::wants_areas(cfg) {
            let slice = slice_shapes(here);
            let above = layer
                .checked_add(1)
                .filter(|&l| l < n)
                .and_then(get)
                .map(lower_shapes)
                .unwrap_or_default();
            let below = layer.checked_sub(1).and_then(get).map(lower_shapes);
            let top = crate::perimeters::difference(&slice, &above);
            let bottom = below.map_or_else(|| slice.clone(), |b| crate::perimeters::difference(&slice, &b));
            // The solid surfaces, for ironing every solid surface, come from the classification below.
            let solid = Shapes::new();
            out.areas = Some(Box::new(crate::output::LayerAreas {
                slice,
                top,
                bottom,
                solid,
            }));
        }
        if crate::gcode::auto_lift(cfg) {
            out.lift_overhangs = lift_overhangs(&self.plan, cfg, layer, get);
        }
        // Over a raft the lines of every layer turn with the layer's number in the print, the raft's included.
        let raft_n = self.raft_layers();
        let dir = Dir::for_layer(layer + raft_n);

        let t = Timer::start();
        let derive = |cfg: &PrintConfig| self.shell_of(cfg);
        let mut base_shell = derive(cfg);
        // The last base layer of a vase is the top surface under the spiral.
        if self.vase.is_some_and(|b| layer + 1 == b) {
            base_shell.top_n = base_shell.top_n.max(1);
        }
        Micros::add(&micros.surfaces, &t);

        // Material of the layer below, for walls that hang over it.
        let below_union: Shapes;
        let below: Option<&Shapes> = match layer.checked_sub(1).and_then(get) {
            None => None,
            Some(r) => {
                if let Some(foot) = &r.lslices {
                    // The first layers' outline before the elephant foot compensation, as Orca sees it.
                    below_union = foot.clone();
                    Some(&below_union)
                } else if let [(_, only)] = r.regions.as_slice() {
                    Some(only)
                } else {
                    below_union =
                        perimeters::union_all(&r.regions.iter().map(|(_, s)| s).collect::<Vec<_>>());
                    Some(&below_union)
                }
            }
        };
        // Internal bridges over sparse infill (bridging.rs), worked out from the layers around this one.
        let bridges: Option<crate::bridging::LayerBridges> = if layer >= 1
            && cfg.sparse_infill_density > 0.0
            && base_shell.top_n > 0
        {
            use std::sync::Arc;
            let cfg_tag = tags.of(cfg);
            let facts_cache: std::cell::RefCell<
                std::collections::HashMap<i64, Option<Arc<crate::bridging::Facts>>>,
            > = std::cell::RefCell::new(std::collections::HashMap::new());
            let base_slice = |m: i64| -> Option<Shapes> {
                let l = u32::try_from(m).ok()?;
                get(l).map(lower_shapes)
            };
            let base_overlap = base_shell.overlap;
            let base_inner = |m: i64| -> Option<Shapes> {
                let l = u32::try_from(m).ok()?;
                self.cache.inner(m, cfg_tag, || {
                    get(l).map(|r| {
                        perimeters::walls_for(
                            cfg,
                            &slice_shapes(r),
                            cfg.wall_loops,
                            base_shell.w,
                            base_overlap,
                            self.plan.thickness(l),
                            false,
                        )
                    })
                })
            };
            let fam = Families::new(cfg);
            let sparse_of = |l: u32, area: &Shapes| -> SparseLines {
                let as_int = |p: crate::geom::Point| IntPoint::new(p.x, p.y);
                if area.is_empty() {
                    return (Vec::new(), Vec::new());
                }
                if cfg.sparse_infill_pattern.on_scanlines() {
                    let base = if cfg.sparse_infill_pattern == InfillPattern::AlignedRectilinear {
                        0
                    } else {
                        l + self.raft_layers()
                    };
                    let frame = turned_frame(
                        self.template_angle(cfg, "sparse_infill_rotate_template", l),
                        Dir::for_layer(base),
                        self.model_turn(cfg),
                    );
                    let turn = frame.map_or(0.0, |f| f.1);
                    let d = match frame {
                        Some((d, _)) => d,
                        None if cfg.sparse_infill_pattern == InfillPattern::AlignedRectilinear => {
                            Dir::for_layer(0)
                        }
                        None => Dir::for_layer(l + self.raft_layers()),
                    };
                    let turned;
                    let area = if turn == 0.0 {
                        area
                    } else {
                        turned = crate::patterns::rotate_shapes(area, -turn);
                        &turned
                    };
                    let mut ev = Vec::new();
                    let spans = fam
                        .sparse(d)
                        .scan(area.iter().flat_map(|s| s.iter()).map(Vec::as_slice), &mut ev);
                    let mut lines: Vec<[crate::geom::Point; 2]> = Vec::new();
                    paths::span_lines(&spans, d, fam.sparse_spacing, &mut lines);
                    if turn != 0.0 {
                        for seg in &mut lines {
                            if let [a, b] = crate::patterns::rotate_points(seg, turn)[..] {
                                *seg = [a, b];
                            }
                        }
                    }
                    (
                        lines.into_iter().map(|s| [as_int(s[0]), as_int(s[1])]).collect(),
                        Vec::new(),
                    )
                } else {
                    let z = self.plan.top(l);
                    let polylines = self
                        .planned_sparse(cfg, l, area)
                        .unwrap_or_else(|| crate::patterns::sparse(&self.sparse_in(cfg, l, area, z)));
                    (Vec::new(), polylines)
                }
            };
            let facts = |l: i64| -> Option<Arc<crate::bridging::Facts>> {
                if let Some(f) = facts_cache.borrow().get(&l) {
                    return f.clone();
                }
                let f = self.cache.facts(l, cfg_tag, || {
                    let lu = u32::try_from(l).ok()?;
                    let here = get(lu)?;
                    // A layer of several regions: its facts are its regions' own classes put together, as Orca's
                    // `PrintObject::bridge_over_infill` reads each region's fill surfaces.
                    if self.vase.is_none() && here.regions.iter().filter(|(_, s)| !s.is_empty()).count() > 1 {
                        let upper = lu
                            .checked_add(1)
                            .filter(|&u| u < n)
                            .and_then(get)
                            .map(lower_shapes);
                        let below = lu.checked_sub(1).and_then(get).map(|r| {
                            match (&r.lslices, r.regions.as_slice()) {
                                (Some(foot), _) => foot.clone(),
                                (None, [(_, only)]) => only.clone(),
                                _ => perimeters::union_all(
                                    &r.regions.iter().map(|(_, s)| s).collect::<Vec<_>>(),
                                ),
                            }
                        });
                        let preps = self.cache.regions(l, cfg_tag, || {
                            let shell = self.shell_of(cfg);
                            self.region_preps(
                                lu,
                                cfg,
                                &shell,
                                mods,
                                get,
                                below.as_ref(),
                                upper.as_ref(),
                                micros,
                                tags,
                                None,
                            )
                        });
                        let parts: Vec<&RegionPrep> = preps.iter().flatten().collect();
                        let all = |f: &dyn Fn(&RegionPrep) -> &Shapes| {
                            perimeters::union_all(&parts.iter().map(|p| f(p)).collect::<Vec<_>>())
                        };
                        let inner = all(&|p| &p.inner);
                        let top = all(&|p| &p.cls.top);
                        let own_bottom = all(&|p| &p.cls.bottom);
                        let shell = all(&|p| &p.cls.shell);
                        let sparse = all(&|p| &p.cls.sparse);
                        let external: Vec<crate::bridging::Bridged> =
                            parts.iter().flat_map(|p| p.cls.bridges.iter().cloned()).collect();
                        let bridged =
                            perimeters::union_all(&external.iter().map(|b| &b.area).collect::<Vec<_>>());
                        let (lines, paths) = sparse_of(lu, &sparse);
                        return Some(crate::bridging::Facts {
                            inner,
                            top,
                            bottom: perimeters::union_all(&[&own_bottom, &bridged]),
                            shell,
                            sparse,
                            lines,
                            paths,
                            external,
                            own_bottom,
                        });
                    }
                    let region = slice_shapes(here);
                    let inner = base_inner(l)?;
                    let cls = crate::classify::classify(&crate::classify::In {
                        cfg,
                        layer: lu,
                        count: n,
                        region: &region,
                        inner: &inner,
                        slice: &base_slice,
                        inner_of: &base_inner,
                        top_layers: base_shell.top_n,
                        bottom_layers: base_shell.bot_n,
                        wall_loops: cfg.wall_loops,
                        cache: Some(&self.cache),
                        tag: cfg_tag,
                        whole_lower: None,
                    });
                    let (lines, paths) = sparse_of(lu, &cls.sparse);
                    let bridged: Shapes = cls
                        .bridges
                        .iter()
                        .fold(Shapes::new(), |acc, b| perimeters::union_all(&[&acc, &b.area]));
                    Some(crate::bridging::Facts {
                        inner,
                        top: cls.top,
                        bottom: perimeters::union_all(&[&cls.bottom, &bridged]),
                        shell: cls.shell,
                        sparse: cls.sparse,
                        lines,
                        paths,
                        external: cls.bridges,
                        own_bottom: cls.bottom,
                    })
                });
                facts_cache.borrow_mut().insert(l, f.clone());
                f
            };
            let print_z = |l: i64| -> f64 { u32::try_from(l).map_or(0.0, |u| self.plan.top(u)) };
            let nozzle = cfg.nozzle_diameter;
            let ratio = crate::motion::raw_f(cfg, "bridge_flow").unwrap_or(1.0);
            let thick = crate::tower::flag_or(cfg, "thick_internal_bridges", true);
            let line = bridge_line_width(cfg);
            let width = if thick {
                line.unwrap_or(nozzle) * ratio.max(0.0).sqrt()
            } else {
                line.unwrap_or_else(|| cfg.solid_infill_width())
            };
            // `internal_bridge_density`: the strands sit 1 over the density closer than the flow's spacing.
            let spacing = if thick {
                width + 0.05
            } else {
                cfg.spacing_for(width)
            } / bridge_density(cfg, "internal_bridge_density");
            let filter = match cfg.raw.get("dont_filter_internal_bridges") {
                Some(serde_json::Value::String(s)) => s.as_str(),
                _ => "disabled",
            };
            let env = crate::bridging::Env {
                cache: Some((&self.cache, cfg_tag)),
                facts: &facts,
                print_z: &print_z,
                count: i64::from(n),
                solid_spacing: cfg.spacing_for(cfg.solid_infill_width()),
                bridge_spacing: spacing,
                bridge_width: width,
                bridge_height: if thick { width } else { cfg.layer_height },
                sparse_full: cfg.sparse_infill_density >= 100.0 - 1e-6,
                multiplier: if filter == "disabled" { 3.0 } else { 1.0 },
                nofilter: filter == "nofilter",
                angle_bias: match cfg.sparse_infill_pattern {
                    InfillPattern::HilbertCurve => std::f64::consts::FRAC_PI_4,
                    InfillPattern::OctagramSpiral => std::f64::consts::PI / 16.0,
                    _ => 0.0,
                },
                custom_angle: crate::motion::raw_f(cfg, "internal_bridge_angle")
                    .filter(|a| *a > 0.0)
                    .map(|a| {
                        let relative = crate::tower::flag(cfg, "relative_bridge_angle");
                        (if relative { a } else { a + self.model_turn(cfg) }, relative)
                    }),
            };
            let memo = crate::bridging::Memo::default();
            let areas = crate::bridging::bridge_layer(&env, i64::from(layer), &memo);
            let ensure = crate::bridging::ensuring(&env, i64::from(layer), &memo);
            // `enable_extra_bridge_layer`: a second layer over the bridges of the layer below.
            let extra = crate::bridging::ExtraLayer::of(cfg);
            let mut areas = areas.as_ref().clone();
            if extra.internal {
                let second = crate::bridging::second_internal(
                    &env,
                    i64::from(layer),
                    &memo,
                    cfg.solid_infill_width(),
                    &areas,
                );
                areas.extend(second);
            }
            let extra_external = if extra.external {
                let band = cfg.outer_wall_width()
                    + cfg.inner_wall_width() * f64::from(cfg.wall_loops.saturating_sub(1));
                crate::bridging::second_external(&env, i64::from(layer), band)
            } else {
                Vec::new()
            };
            Some(crate::bridging::LayerBridges {
                extra_external,
                areas,
                ensure,
                spacing,
                thick,
                width,
                reference: (
                    mm(f64::midpoint(self.bounds[0], self.bounds[2])),
                    mm(f64::midpoint(self.bounds[1], self.bounds[3])),
                ),
                // Worked out already: the bridges of this layer read its facts.
                own: facts(i64::from(layer)),
            })
        } else {
            None
        };
        let mut solid_areas: Vec<Shapes> = Vec::new();
        let mut works: Vec<ToolWork> = Vec::with_capacity(here.regions.len());
        let mut events = Vec::new();
        let layer_height = self.plan.thickness(layer);
        let trim = paths::t_units(cfg.line_width / 2.0);
        let min_len = paths::t_units(cfg.line_width / 2.0);
        let base_cfg = cfg;
        let region_config = |j: usize| match here.region_cfg.get(j).copied().unwrap_or(0) {
            0 => base_cfg,
            k => mods.get(usize::from(k) - 1).unwrap_or(base_cfg),
        };
        let mut overhangs: Vec<(i32, &PrintConfig, crate::overhang::Overhang)> = Vec::new();
        // The layer below for the point by point overhang speed, once per region's settings.
        let lower = below.map(crate::overhang::Support::new).map(std::sync::Arc::new);
        let curled = layer.checked_sub(1).and_then(|k| {
            self.curls
                .get()
                .and_then(Option::as_ref)?
                .get(k as usize)
                .cloned()
        });
        let mut qualities: Vec<(&PrintConfig, std::sync::Arc<crate::quality::Context>)> = Vec::new();
        // The layer above, for `only_one_wall_top`: top surfaces keep one wall.
        let upper_slice: Option<Shapes> = layer
            .checked_add(1)
            .filter(|&l| l < n)
            .and_then(get)
            .map(lower_shapes);
        // The walls, infill area and surface classes of the layer's regions. Those of a layer of several regions go
        // through the session's memo.
        let own_facts = bridges.as_ref().and_then(|b| b.own.as_deref());
        let several = self.vase.is_none() && here.regions.iter().filter(|(_, s)| !s.is_empty()).count() > 1;
        let shared_preps = several.then(|| {
            self.cache.regions(i64::from(layer), tags.of(cfg), || {
                self.region_preps(
                    layer,
                    cfg,
                    &base_shell,
                    mods,
                    get,
                    below,
                    upper_slice.as_ref(),
                    micros,
                    tags,
                    None,
                )
            })
        });
        let mut own_preps = if several {
            Vec::new()
        } else {
            self.region_preps(
                layer,
                cfg,
                &base_shell,
                mods,
                get,
                below,
                upper_slice.as_ref(),
                micros,
                tags,
                own_facts,
            )
        };
        // Walls in the area painted with fuzzy skin get it there (Orca `apply_fuzzy_skin` on painted regions).
        let fuzzy_mask = self.fuzzy_mask(layer);
        for (ri, (slot, shapes)) in here.regions.iter().enumerate() {
            if shapes.is_empty() {
                continue;
            }
            // A region inside a modifier volume prints with the modifier's settings.
            let region_k = here.region_cfg.get(ri).copied().unwrap_or(0);
            let cfg = region_config(ri);
            let fam = Families::new(cfg);
            let own_shell;
            let sh = if region_k == 0 {
                &base_shell
            } else {
                own_shell = derive(cfg);
                &own_shell
            };
            let (w, overlap, on_lines) = (sh.w, sh.overlap, sh.on_lines);
            let Some(RegionPrep {
                islands,
                inner,
                cls,
                known,
            }) = (match &shared_preps {
                Some(p) => p.get(ri).cloned().flatten(),
                None => own_preps.get_mut(ri).and_then(Option::take),
            })
            else {
                continue;
            };
            let mut cls = cls;
            let known = own_facts.filter(|_| known);

            let t = Timer::start();
            let mut work = ToolWork {
                tool: *slot,
                islands,
                width: (region_k != 0).then(|| mm_f32(cfg.line_width)),
                overhang: below
                    .filter(|_| crate::tower::flag_or(cfg, "detect_overhang_wall", true))
                    .map(|b| {
                        // Every region of the layer hangs over the same layer below: work it out once per
                        // wall width and settings.
                        if let Some((_, _, o)) = overhangs
                            .iter()
                            .find(|(ow, oc, _)| *ow == w && std::ptr::eq(*oc, cfg))
                        {
                            return o.clone();
                        }
                        let o = crate::overhang::Overhang::new(b, w, cfg);
                        overhangs.push((w, cfg, o.clone()));
                        o
                    }),
                quality: lower
                    .as_ref()
                    .filter(|_| crate::quality::overhang_speed_on(cfg))
                    .map(|low| {
                        if let Some((_, q)) = qualities.iter().find(|(qc, _)| std::ptr::eq(*qc, cfg)) {
                            return q.clone();
                        }
                        #[allow(clippy::cast_possible_truncation, reason = "a layer height in mm")]
                        let q = std::sync::Arc::new(crate::quality::Context::new(
                            cfg,
                            low.clone(),
                            curled.clone(),
                            self.plan.thickness(layer) as f32,
                        ));
                        qualities.push((cfg, q.clone()));
                        q
                    }),
                fuzzy_paint: fuzzy_mask.clone(),
                ..ToolWork::default()
            };
            // Extra perimeters on overhangs (Orca `PerimeterGenerator::apply_extra_perimeters`): loops over the
            // part of the infill area that hangs where no bridge can anchor; the infill there goes.
            if let Some(under) = below
                && self.vase.is_none()
                && cfg.wall_loops > 0
                && crate::tower::flag_or(cfg, "detect_overhang_wall", true)
                && crate::tower::flag(cfg, "extra_perimeters_on_overhangs")
            {
                let line = bridge_line_width(cfg);
                let (width, spacing, flow) = if cfg.thick_bridges {
                    let d = line.unwrap_or(cfg.nozzle_diameter) * cfg.bridge_flow.sqrt();
                    let h = self.plan.thickness(layer);
                    (
                        d,
                        d + 0.05,
                        std::f64::consts::PI * d * d / 4.0 / crate::gcode::bead_area(d, h),
                    )
                } else {
                    let d = line.unwrap_or_else(|| cfg.inner_wall_width());
                    (d, cfg.spacing_for(d), cfg.bridge_flow)
                };
                // Orca measures against the layer below grown by half the nozzle (`lower_slices_polygons`).
                let grown = perimeters::offset(under, mm(cfg.nozzle_diameter / 2.0));
                let (extra, filled) =
                    crate::extraperim::generate(&inner, &grown, cfg.wall_loops, mm(width), mm(spacing));
                if !extra.is_empty() {
                    let cut = |s: &Shapes| {
                        if s.is_empty() {
                            Shapes::new()
                        } else {
                            perimeters::difference(s, &filled)
                        }
                    };
                    if !filled.is_empty() {
                        cls.top = cut(&cls.top);
                        cls.bottom = cut(&cls.bottom);
                        cls.shell = cut(&cls.shell);
                        cls.sparse = cut(&cls.sparse);
                        // A bridge grows from the part of it over air (Orca intersects the bottom surfaces with
                        // what is left of the infill before growing them): pieces left only over the anchors go.
                        let air = cut(&perimeters::difference(&inner, under));
                        for b in &mut cls.bridges {
                            b.area = cut(&b.area)
                                .into_iter()
                                .filter(|piece| {
                                    !air.is_empty()
                                        && !perimeters::intersection(&vec![piece.clone()], &air).is_empty()
                                })
                                .collect();
                        }
                        cls.bridges.retain(|b| !b.area.is_empty());
                    }
                    work.extra_perimeters = extra;
                    #[allow(clippy::cast_possible_truncation, reason = "a width and a flow ratio")]
                    {
                        work.extra_width = width as f32;
                        work.extra_flow = flow as f32;
                    }
                }
            }
            // The first solid layer over sparse infill is printed as bridge strands over it (bridging.rs);
            // the sparse infill under them goes and a solid ring stays under their edges at the walls.
            let mut bridge_paths: Vec<Vec<crate::geom::Point>> = Vec::new();
            // The second layer over the bridges over air of the layer below prints as a bridge too.
            if let Some(b) = &bridges {
                for x in &b.extra_external {
                    let have = cls
                        .bridges
                        .iter()
                        .fold(Shapes::new(), |acc, y| perimeters::union_all(&[&acc, &y.area]));
                    let part = perimeters::difference(&perimeters::intersection(&x.area, &inner), &have);
                    if !part.is_empty() {
                        cls.shell = perimeters::difference(&cls.shell, &part);
                        cls.sparse = perimeters::difference(&cls.sparse, &part);
                        cls.bridges.push(crate::bridging::Bridged {
                            area: part,
                            angle: x.angle,
                        });
                    }
                }
            }
            if let Some(b) = &bridges {
                let cut: Shapes = b
                    .areas
                    .iter()
                    .fold(Shapes::new(), |acc, x| perimeters::union_all(&[&acc, &x.area]));
                let ens = perimeters::intersection(&b.ensure, &inner);
                if !cut.is_empty() || !ens.is_empty() {
                    let solid = perimeters::union_all(&[&cls.shell, &ens]);
                    cls.shell = if cut.is_empty() {
                        solid
                    } else {
                        perimeters::difference(&solid, &cut)
                    };
                    let gone = perimeters::union_all(&[&cut, &ens]);
                    cls.sparse = perimeters::difference(&cls.sparse, &gone);
                }
                for x in &b.areas {
                    let part = perimeters::intersection(&x.area, &inner);
                    bridge_paths.extend(crate::bridging::fill(&part, x.angle, b.spacing, b.reference));
                }
                work.internal_bridge_paths = std::mem::take(&mut bridge_paths);
                #[allow(clippy::cast_possible_truncation, reason = "a flow ratio and a width")]
                {
                    work.internal_bridge_ratio =
                        crate::motion::raw_f(cfg, "bridge_flow").unwrap_or(1.0) as f32;
                    work.internal_bridge_width = if b.thick { b.width as f32 } else { 0.0 };
                }
            }
            // `extra_solid_infills` (Orca's `discover_horizontal_shells`): the sparse infill of the layers the
            // pattern names prints solid.
            if !cls.sparse.is_empty()
                && let Some(serde_json::Value::String(pattern)) = cfg.raw.get("extra_solid_infills")
                && crate::surface::layer_id_matches(pattern, layer)
            {
                cls.shell = perimeters::union_all(&[&cls.shell, &cls.sparse]);
                cls.sparse = Vec::new();
            }
            // `infill_combination`: the shared area of the group leaves every layer's sparse infill; the group's
            // top layer prints it at the group's height.
            let mut combined: Option<(Shapes, f64)> = None;
            if !cls.sparse.is_empty()
                && let Some(plan) = self.combine_plan(cfg)
                && let Some(g) = plan
                    .layer
                    .get(layer as usize)
                    .copied()
                    .flatten()
                    .and_then(|k| plan.groups.get(k))
            {
                if g.top == layer {
                    combined = Some((perimeters::intersection(&g.shared, &cls.sparse), g.height));
                }
                cls.sparse = perimeters::difference(&cls.sparse, &g.grown);
            }
            let scan_area =
                |f: crate::infill::Family, area: &Shapes, events: &mut Vec<(i32, i64)>| -> Spans {
                    f.scan(area.iter().flat_map(|s| s.iter()).map(Vec::as_slice), events)
                };
            // `sparse_infill_rotate_template`: the layer's angle, on the scanlines when it is one of their two
            // directions, else on the area turned onto them and the lines turned back.
            let sparse_frame = turned_frame(
                self.template_angle(cfg, "sparse_infill_rotate_template", layer),
                if cfg.sparse_infill_pattern == InfillPattern::AlignedRectilinear {
                    Dir::for_layer(0)
                } else {
                    dir
                },
                self.model_turn(cfg),
            );
            let sparse_turn = sparse_frame.map_or(0.0, |f| f.1);
            let sparse_dir = match sparse_frame {
                Some((d, _)) => d,
                None if cfg.sparse_infill_pattern == InfillPattern::AlignedRectilinear => Dir::for_layer(0),
                None => dir,
            };
            let sparse_area: std::borrow::Cow<'_, Shapes> = if sparse_turn == 0.0 {
                std::borrow::Cow::Borrowed(&cls.sparse)
            } else {
                std::borrow::Cow::Owned(crate::patterns::rotate_shapes(&cls.sparse, -sparse_turn))
            };
            let mut sparse_spans: Vec<(Dir, Spans)> = Vec::new();
            if cfg.sparse_infill_density > 0.0 && on_lines && !cls.sparse.is_empty() {
                let mut s = scan_area(fam.sparse(sparse_dir), &sparse_area, &mut events);
                infill::trim(&mut s, trim, min_len);
                sparse_spans.push((sparse_dir, s));
            }
            if !on_lines && cfg.sparse_infill_density > 0.0 && !cls.sparse.is_empty() {
                let z = self.plan.top(layer);
                work.sparse_paths = match known.filter(|f| f.sparse == cls.sparse) {
                    // The facts laid the same pattern over the same area.
                    Some(f) => f.paths.clone(),
                    None => match self.planned_sparse(cfg, layer, &cls.sparse) {
                        Some(lines) => lines,
                        None => crate::patterns::sparse(&self.sparse_in(cfg, layer, &cls.sparse, z)),
                    },
                };
            }
            let mut shell_area = cls.shell.clone();
            let mut internal_bridge: Spans = Vec::new();
            if crate::ironing::kind(cfg) == Some(crate::ironing::Kind::Solid) {
                solid_areas.push(perimeters::union_all(&[&cls.top, &cls.shell]));
            }
            // Narrow bands of internal solid infill are filled with variable-width beads instead of lines.
            let solid_spacing_mm = cfg.spacing_for(cfg.solid_infill_width());
            let solid_name = match cfg.raw.get("internal_solid_infill_pattern") {
                Some(serde_json::Value::String(s)) => s.as_str(),
                _ => "monotonic",
            };
            if crate::tower::flag_or(cfg, "detect_narrow_internal_solid_infill", true)
                && !shell_area.is_empty()
            {
                let (normal, narrow) = if matches!(
                    solid_name,
                    "monotonic" | "monotonicline" | "rectilinear" | "alignedrectilinear"
                ) {
                    crate::narrow::split_lines(&shell_area, dir, fam.solid_spacing, solid_spacing_mm)
                } else {
                    crate::narrow::split_core(&shell_area, solid_spacing_mm)
                };
                if !narrow.is_empty() {
                    // `FillConcentricInternal` runs over the no-overlap infill area: the region without the
                    // growth that lets lines overlap the walls.
                    let no_overlap = perimeters::intersection(&narrow, &perimeters::offset(&inner, -overlap));
                    work.shell_thick =
                        crate::narrow::concentric_lines(&no_overlap, cfg, solid_spacing_mm, layer_height);
                    work.region_narrow.clone_from(&narrow);
                    shell_area = normal;
                }
            }
            // `elefant_foot_layers_density`: the internal solid infill of the first layers above the bottom is
            // sparser, rising layer by layer to full density (Orca `Fill.cpp`, counting from the second layer).
            let mut shell_family = fam.solid(dir);
            let foot_density = cfg.raw_number("elefant_foot_layers_density", 100.0) / 100.0;
            let foot_layers = cfg.raw_number("elefant_foot_compensation_layers", 1.0).max(1.0);
            if (foot_density - 1.0).abs() > 1e-6 && layer > 0 && f64::from(layer) <= foot_layers {
                let d = 1.0 - (1.0 - foot_density) * (foot_layers - f64::from(layer - 1)) / foot_layers;
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_precision_loss,
                    reason = "a spacing in internal units"
                )]
                {
                    shell_family.spacing = (shell_family.spacing as f64 / d.max(0.05)).round() as i64;
                }
            }
            let mut shell = scan_area(shell_family, &shell_area, &mut events);
            let mut top = scan_area(fam.solid(dir), &cls.top, &mut events);
            let mut bottom = scan_area(
                if layer > 0 { shell_family } else { fam.solid(dir) },
                &cls.bottom,
                &mut events,
            );
            // Infill over air becomes bridge strands instead of solid infill (classify.rs grows the bridges
            // into the areas beside them and picks their direction; `bridging::fill` lays the strands).
            if !cls.bridges.is_empty() {
                // Thick bridges are round strands of the nozzle diameter; otherwise ordinary beads at the
                // usual spacing, scaled by the bridge flow.
                let line = bridge_line_width(cfg);
                let d_mm = if cfg.thick_bridges {
                    line.unwrap_or(cfg.nozzle_diameter) * cfg.bridge_flow.sqrt()
                } else {
                    line.unwrap_or(cfg.line_width)
                };
                // `bridge_density` (external bridges): the strands sit 1 over the density closer.
                let pitch = if cfg.thick_bridges {
                    d_mm + 0.05
                } else {
                    cfg.spacing_for(line.unwrap_or_else(|| cfg.solid_infill_width()))
                } / bridge_density(cfg, "bridge_density");
                let reference = (
                    mm(f64::midpoint(self.bounds[0], self.bounds[2])),
                    mm(f64::midpoint(self.bounds[1], self.bounds[3])),
                );
                let waves = crate::wave::Params::of(cfg);
                for b in &cls.bridges {
                    // Wave overhangs: rings growing from the material under the layer's edge.
                    if let (Some(w), Some(under)) = (waves.as_ref(), below) {
                        let seed = perimeters::intersection(shapes, under);
                        let rings = crate::wave::rings(&b.area, &seed, w);
                        if !rings.is_empty() {
                            work.wave_paths.extend(rings);
                            #[allow(clippy::cast_possible_truncation, reason = "a flow and a speed")]
                            {
                                work.wave_flow = w.flow_mm3 as f32;
                                work.wave_speed = w.speed;
                            }
                            continue;
                        }
                    }
                    work.bridge_paths
                        .extend(crate::bridging::fill(&b.area, b.angle, pitch, reference));
                }
                #[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
                {
                    work.bridge_flat_flow = if cfg.thick_bridges {
                        0.0
                    } else {
                        cfg.bridge_flow as f32
                    };
                }
                #[allow(clippy::cast_possible_truncation, reason = "widths are small")]
                {
                    work.bridge_width = d_mm as f32;
                }
            }
            // The top surface prints at its own line width: its area is what the layer above leaves
            // uncovered, filled at that spacing (the layers under it keep the solid spacing).
            let top_spacing = paths::t_units(cfg.spacing_for(cfg.top_surface_width()));
            if top_spacing != fam.solid_spacing && !top.is_empty() {
                top = scan_area(
                    crate::infill::Family {
                        dir,
                        spacing: top_spacing,
                    },
                    &cls.top,
                    &mut events,
                );
            }
            // Top, bottom and internal solid surfaces: straight-line patterns join or order the scanline
            // spans (monotonic.rs); patterns that are not straight lines are drawn from the region's shape.
            let surface_region = |which: usize| -> Shapes {
                match which {
                    0 => cls.top.clone(),
                    1 => cls.bottom.clone(),
                    _ => shell_area.clone(),
                }
            };
            let mut curved: [Vec<[crate::geom::Point; 2]>; 3] = [Vec::new(), Vec::new(), Vec::new()];
            // `solid_infill_rotate_template`: every solid surface of the layer at the template's angle.
            let solid_deg = self.template_angle(cfg, "solid_infill_rotate_template", layer);
            let model_turn = self.model_turn(cfg);
            for (which, key, default, spans) in [
                (0usize, "top_surface_pattern", "monotonicline", &mut top),
                (1, "bottom_surface_pattern", "monotonic", &mut bottom),
                (2, "internal_solid_infill_pattern", "monotonic", &mut shell),
            ] {
                let name = match cfg.raw.get(key) {
                    Some(serde_json::Value::String(s)) => s.as_str(),
                    _ => default,
                };
                // `top_surface_density` and `bottom_surface_density` (Orca's `Fill.cpp`, external surfaces
                // that are not bridges): the lines spread out; a top density of 0 leaves the top unfilled.
                let density = match which {
                    0 => cfg.raw_number("top_surface_density", 100.0),
                    1 => cfg.raw_number("bottom_surface_density", 100.0),
                    _ => 100.0,
                } / 100.0;
                if density <= 0.0 {
                    spans.clear();
                    continue;
                }
                let spread = |v: f64| if density < 1.0 { v / density } else { v };
                // The top surface's lines are a family of their own when its width differs.
                let surface_spacing = if which == 0 {
                    top_spacing
                } else if which == 2 || layer > 0 {
                    // Internal solid infill, which the bottom shell above the first layer is too.
                    shell_family.spacing
                } else {
                    fam.solid_spacing
                };
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_precision_loss,
                    reason = "a line spacing in internal units"
                )]
                let surface_spacing = if density < 1.0 {
                    spread(surface_spacing as f64).round() as i64
                } else {
                    surface_spacing
                };
                let surface_mm = spread(if which == 0 {
                    cfg.spacing_for(cfg.top_surface_width())
                } else {
                    cfg.spacing_for(cfg.solid_infill_width())
                });
                // Orca's FillMonotonic, FillRectilinear and FillAlignedRectilinear join neighboring lines along
                // the edge of the surface; FillMonotonicLines keeps them apart (anchor length 0).
                let link = match name {
                    "monotonic" | "rectilinear" | "alignedrectilinear" => Some(3.0 * surface_mm),
                    "monotonicline" => Some(0.0),
                    _ => None,
                };
                if let Some(link_max) = link {
                    let aligned_dir = Dir::for_layer(0);
                    // The lines end at the surface pulled in by 0.05 spacing and the turns follow it pulled in by
                    // half a spacing (Orca's `ExPolygonWithOffset` in `fill_surface_by_lines`).
                    let (d, turn) = turned_frame(
                        solid_deg,
                        if name == "alignedrectilinear" {
                            aligned_dir
                        } else {
                            dir
                        },
                        model_turn,
                    )
                    .unwrap_or((
                        if name == "alignedrectilinear" {
                            aligned_dir
                        } else {
                            dir
                        },
                        0.0,
                    ));
                    let region = surface_region(which);
                    if region.is_empty() {
                        continue;
                    }
                    let region = if turn == 0.0 {
                        region
                    } else {
                        crate::patterns::rotate_shapes(&region, -turn)
                    };
                    let outer = perimeters::offset(&region, -mm(0.05 * surface_mm));
                    let inner_c = perimeters::offset(&region, -mm(0.5 * surface_mm));
                    let family = crate::infill::Family {
                        dir: d,
                        spacing: surface_spacing,
                    };
                    let mut own = scan_area(family, &inner_c, &mut events);
                    let own_out = scan_area(family, &outer, &mut events);
                    if own.is_empty() {
                        continue;
                    }
                    spans.clear();
                    infill::trim(&mut own, 0, paths::t_units(0.05));
                    let edge = (link_max > 0.0 && !inner_c.is_empty()).then(|| {
                        let mut e = crate::edge::Edge::new(&inner_c);
                        // A turn may not pass another line end.
                        e.mark_ends(own.iter().flat_map(|iv| {
                            let off = i64::from(iv.k) * surface_spacing;
                            [d.point(off, iv.t0), d.point(off, iv.t1)]
                        }));
                        e
                    });
                    let links = crate::monotonic::Links {
                        edge: edge.as_ref(),
                        max: link_max,
                        chord_fallback: false,
                    };
                    let pls = crate::monotonic::polylines_outer(
                        &crate::monotonic::orca_spans(&own, d),
                        &crate::monotonic::orca_spans(&own_out, d),
                        surface_spacing,
                        links,
                        &|k, t| crate::monotonic::orca_point(d, k, t),
                    );
                    if let Some(slot_lines) = curved.get_mut(which) {
                        for pl in pls {
                            let pl = if turn == 0.0 {
                                pl
                            } else {
                                crate::patterns::rotate_points(&pl, turn)
                            };
                            slot_lines.extend(pl.windows(2).filter_map(|s| Some([*s.first()?, *s.get(1)?])));
                        }
                    }
                    continue;
                }
                // Orca lists the same eight patterns for the top, the bottom and the internal solid surfaces; the
                // straight ones are handled above, these are the curves.
                let (Some(curve), false) = (crate::surface::curve(name), spans.is_empty()) else {
                    continue;
                };
                let region = surface_region(which);
                let lines = crate::surface::fill(
                    &region,
                    curve,
                    surface_mm,
                    // `FillPlanePath` keeps one frame on every layer: minus the solid infill angle and a right angle.
                    -(solid_deg.unwrap_or_else(|| {
                        crate::motion::raw_f(cfg, "solid_infill_direction").unwrap_or(45.0)
                    }) + model_turn
                        + 90.0),
                );
                if lines.is_empty() {
                    continue;
                }
                spans.clear();
                if let Some(slot_lines) = curved.get_mut(which) {
                    for pl in lines {
                        slot_lines.extend(pl.windows(2).filter_map(|s| Some([*s.first()?, *s.get(1)?])));
                    }
                }
            }
            infill::trim(&mut internal_bridge, trim, min_len);
            infill::trim(&mut shell, trim, min_len);
            infill::trim(&mut top, trim, min_len);
            infill::trim(&mut bottom, trim, min_len);
            Micros::add(&micros.surfaces, &t);

            let t = Timer::start();
            if matches!(
                cfg.sparse_infill_pattern,
                InfillPattern::Rectilinear
                    | InfillPattern::AlignedRectilinear
                    | InfillPattern::ZigZag
                    | InfillPattern::CrossZag
                    | InfillPattern::LockedZag
            ) && cfg.anchor_max_mm() >= 0.05
                && let [(sd, _)] = sparse_spans.as_slice()
            {
                let d = *sd;
                let before = (work.sparse_paths.len(), work.sparse_alt.len());
                let w_mm = cfg.spacing_for(cfg.sparse_infill_width());
                let density = cfg.sparse_infill_density / 100.0;
                let step = crate::motion::raw_f(cfg, "infill_shift_step").unwrap_or(0.4);
                // Cross zag moves its lattice sideways every other layer (`horiz_move`).
                let shift = {
                    let id = layer + self.raft_layers();
                    let n = f64::from(id / 2) * step;
                    if id.is_multiple_of(2) { -n } else { n }
                };
                let area: &Shapes = &sparse_area;
                match cfg.sparse_infill_pattern {
                    InfillPattern::LockedZag => {
                        // Orca's FillLockedZag: a skin of `skin_infill_depth` along the walls is cross zag at the
                        // skin density, the skeleton inside (grown by `infill_lock_depth` into the skin) is zigzag
                        // across the layer's direction at the skeleton density; each set has its own line width.
                        let get = |k: &str, d: f64| crate::motion::raw_f(cfg, k).unwrap_or(d);
                        let (skin_depth, lock_depth) =
                            (get("skin_infill_depth", 2.0), get("infill_lock_depth", 1.0));
                        let (skin_density, skeleton_density) = (
                            get("skin_infill_density", 25.0) / 100.0,
                            get("skeleton_infill_density", 25.0) / 100.0,
                        );
                        let zig_area = perimeters::offset(area, -mm(skin_depth));
                        let skin_area = perimeters::difference(area, &zig_area);
                        let skeleton_area =
                            perimeters::intersection(&perimeters::offset(&zig_area, mm(lock_depth)), area);
                        let other = if d == Dir::D45 { Dir::D135 } else { Dir::D45 };
                        let width_of = |k: &str| {
                            let pct = match cfg.raw.get(k) {
                                Some(serde_json::Value::String(t)) => {
                                    t.trim().trim_end_matches('%').parse::<f64>().unwrap_or(100.0)
                                }
                                Some(v) => v.as_f64().unwrap_or(100.0),
                                None => 100.0,
                            };
                            #[allow(clippy::cast_possible_truncation, reason = "a width in mm")]
                            {
                                (cfg.nozzle_diameter * pct / 100.0) as f32
                            }
                        };
                        let skeleton = zig_lines(
                            &mut events,
                            &skeleton_area,
                            other,
                            w_mm,
                            skeleton_density,
                            0.0,
                            true,
                        );
                        let skin = zig_lines(&mut events, &skin_area, d, w_mm, skin_density, shift, true);
                        work.sparse_alt
                            .push((width_of("skeleton_infill_line_width"), skeleton));
                        work.sparse_alt.push((width_of("skin_infill_line_width"), skin));
                    }
                    pattern => {
                        let consistent = matches!(pattern, InfillPattern::ZigZag | InfillPattern::CrossZag);
                        let shift = if pattern == InfillPattern::CrossZag {
                            shift
                        } else {
                            0.0
                        };
                        work.sparse_paths.extend(zig_lines(
                            &mut events,
                            area,
                            d,
                            w_mm,
                            density,
                            shift,
                            consistent,
                        ));
                    }
                }
                if sparse_turn != 0.0 {
                    let back =
                        |p: &mut Vec<crate::geom::Point>| *p = crate::patterns::rotate_points(p, sparse_turn);
                    work.sparse_paths.iter_mut().skip(before.0).for_each(back);
                    work.sparse_alt
                        .iter_mut()
                        .skip(before.1)
                        .flat_map(|(_, ps)| ps.iter_mut())
                        .for_each(back);
                }
            } else {
                let before = work.sparse.len();
                for (sd, s) in &sparse_spans {
                    paths::span_lines(s, *sd, fam.sparse_spacing, &mut work.sparse);
                }
                if sparse_turn != 0.0 {
                    for seg in work.sparse.iter_mut().skip(before) {
                        if let [a, b] = crate::patterns::rotate_points(seg, sparse_turn)[..] {
                            *seg = [a, b];
                        }
                    }
                }
                if cfg.anchor_max_mm() > 0.0 && !work.sparse.is_empty() {
                    // Lines that end next to each other on a wall become one path.
                    let lines: Vec<Vec<crate::geom::Point>> = std::mem::take(&mut work.sparse)
                        .into_iter()
                        .map(|l| l.to_vec())
                        .collect();
                    work.sparse_paths.extend(crate::anchor::connect(
                        lines,
                        &inner,
                        crate::anchor::Params {
                            spacing: cfg.spacing_for(cfg.sparse_infill_width()),
                            anchor: crate::anchor::anchor_length(
                                cfg,
                                cfg.spacing_for(cfg.sparse_infill_width()),
                            ),
                            anchor_max: cfg.anchor_max_mm(),
                        },
                    ));
                }
            }
            if let Some((area, height)) = combined.filter(|(a, _)| !a.is_empty()) {
                let w = cfg.sparse_infill_width();
                let here = self.plan.thickness(layer);
                let spacing = (w - height * (1.0 - std::f64::consts::FRAC_PI_4)).max(0.5 * w);
                let lines = self.planned_sparse(cfg, layer, &area).unwrap_or_else(|| {
                    crate::patterns::sparse(&crate::patterns::SparseIn {
                        spacing_mm: spacing,
                        ..self.sparse_in(cfg, layer, &area, self.plan.top(layer))
                    })
                });
                #[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
                let flow =
                    (crate::gcode::bead_area(w, height) / crate::gcode::bead_area(w, here).max(1e-9)) as f32;
                work.sparse_thick.push((flow, lines));
            }
            paths::span_lines(
                &bottom,
                dir,
                if layer > 0 {
                    shell_family.spacing
                } else {
                    fam.solid_spacing
                },
                &mut work.bottom,
            );
            paths::span_lines(&shell, dir, shell_family.spacing, &mut work.shell);
            paths::span_lines(
                &internal_bridge,
                dir,
                fam.solid_spacing,
                &mut work.internal_bridge,
            );
            paths::span_lines(&top, dir, top_spacing, &mut work.top);
            // Gap fill of the surfaces themselves (`gap_fill_target`, fillgap.rs): over the surface without the
            // growth that lets lines overlap the walls.
            let gap_target = crate::fillgap::target(cfg);
            if gap_target != crate::fillgap::Target::Nowhere {
                let flat = perimeters::offset(&inner, -overlap);
                let solid_mm = cfg.spacing_for(cfg.solid_infill_width());
                let gaps_of = |which: usize, mm_pitch: f64| {
                    let region = perimeters::intersection(&surface_region(which), &flat);
                    curved
                        .get(which)
                        .map(|l| crate::fillgap::gaps(&region, l, mm_pitch, cfg))
                        .unwrap_or_default()
                };
                work.gap_top = gaps_of(0, cfg.spacing_for(cfg.top_surface_width()));
                work.gap_bottom = gaps_of(1, solid_mm);
                if gap_target == crate::fillgap::Target::Everywhere {
                    work.gap_shell = gaps_of(2, solid_mm);
                }
            }
            let [curved_top, curved_bottom, curved_shell] = curved;
            work.top.extend(curved_top);
            work.bottom.extend(curved_bottom);
            work.shell.extend(curved_shell);
            // The surfaces the lines fill (each connected surface is ordered as a unit).
            work.region_top.clone_from(&cls.top);
            work.region_bottom.clone_from(&cls.bottom);
            work.region_shell.clone_from(&shell_area);
            work.region_sparse.clone_from(&cls.sparse);
            Micros::add(&micros.infill, &t);
            // Features on filaments of their own (`*_filament_id`) print as works of those filaments.
            works.extend(split_by_feature(work, feature_tools(cfg, *slot)));
        }
        LayerStart {
            out,
            rest: Some(StartRest {
                works,
                dir,
                top_n: base_shell.top_n,
                solid_areas,
            }),
        }
    }

    /// The rest of [`Self::layer_paths_with`] after [`Self::layer_start`]: the layer's support, then the order of
    /// its filaments, the prime tower, brim, skirt and the plan of its paths.
    #[allow(
        clippy::too_many_arguments,
        reason = "the arguments of `layer_paths_with` and the first part"
    )]
    fn layer_finish<'a>(
        &self,
        start: LayerStart,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
        smooth: bool,
    ) -> LayerPaths {
        let LayerStart { mut out, rest } = start;
        let Some(StartRest {
            mut works,
            dir,
            top_n,
            solid_areas,
        }) = rest
        else {
            return out;
        };
        let Some(here) = get(layer) else { return out };
        let n = self.plan.count();
        let vase_cfg;
        let cfg = if self.vase.is_some_and(|b| layer >= b) {
            vase_cfg = crate::spiral::layer_cfg(cfg);
            &vase_cfg
        } else {
            cfg
        };
        let skirt_here = (cfg.skirt_loops > 0 || self.draft_hull.is_some())
            && (layer + self.raft_layers() < cfg.skirt_height || self.draft_hull.is_some());
        // What else the skirt goes round on this layer, as Orca's `Print::_make_skirt` collects it: the support's
        // paths, and on a plate with one skirt the prime tower's first layer.
        let mut skirt_extra: Vec<IntPoint<i32>> = Vec::new();
        if skirt_here
            && self.skirt_groups.is_empty()
            && self.tower_top.is_some()
            && let Some(t) = self.tower(cfg).map(|t| self.tower_origin.map_or(t, |o| t.at(o)))
        {
            for [x, y] in t.first_layer_corners() {
                let p = crate::geom::Point::from_mm(x, y);
                skirt_extra.push(IntPoint::new(p.x, p.y));
            }
        }
        if cfg.enable_support
            && (!cfg.support.manual || self.has_enforcers())
            && let (Some((sl, flow, index, z)), Some(active)) =
                (self.support_at(cfg, layer), works.first().map(|w| w.tool))
        {
            let sp = self.support_paths(cfg, sl, index, z);
            if skirt_here {
                for p in sp.support.iter().chain(&sp.interface).flatten() {
                    skirt_extra.push(IntPoint::new(p.x, p.y));
                }
            }
            out.support_areas = support_islands(sl);
            place_support(&mut works, sp, flow, support_tools(cfg, active));
        }
        let t = Timer::start();
        // Tools print in the planned order, which starts on the tool the layer below ended on.
        let rank = |slot: u8| {
            self.tool_order
                .get(layer as usize)
                .and_then(|o| o.iter().position(|t| *t == slot))
                .unwrap_or(usize::MAX)
        };
        crate::sorting::sort_by_key(&mut works, |w| rank(w.tool));
        // The layer below ended on the last of its planned tools that it really used; an empty
        // layer hands over what the one before it ended on.
        out.start_tool = self.print_start(
            cfg,
            self.object_print.get(layer as usize).copied().unwrap_or(layer),
            get,
        );
        out.tools_before = self.tools_before(self.object_print.get(layer as usize).copied().unwrap_or(layer));
        out.changes_before =
            self.changes_before(self.object_print.get(layer as usize).copied().unwrap_or(layer));
        out.held_before = self.held_before(self.object_print.get(layer as usize).copied().unwrap_or(layer));
        if self.tool_count > 1 {
            let tower = self
                .tower_top
                .filter(|t| layer <= *t)
                .and_then(|_| self.tower(cfg))
                .map(|t| self.tower_origin.map_or(t, |o| t.at(o)));
            let first = layer == 0 && self.raft.is_none();
            let mut was = out.start_tool;
            let changes = works.iter().any(|w| {
                let change = was != 0 && w.tool != was;
                was = w.tool;
                change
            });
            // One plain outline per layer keeps the column from toppling (`prime_tower_outline`,
            // on by default); with it off only the first layer is framed and the rows stack.
            // `wipe_tower_no_sparse_layers` leaves out the layers without a tool change.
            let walled = first
                || (crate::tower::flag_or(cfg, "prime_tower_outline", true)
                    && (changes || !crate::tower::flag(cfg, "wipe_tower_no_sparse_layers")));
            // Orca finishes the tower layer (outline and first-layer brim) with the layer's last filament;
            // `wipe_tower_filament` prints the outline when that filament prints on the layer.
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a filament slot"
            )]
            let wall_tool = cfg.raw_number("wipe_tower_filament", 0.0).clamp(0.0, 255.0) as u8;
            let wall_at = works
                .iter()
                .position(|w| wall_tool > 0 && w.tool == wall_tool)
                .unwrap_or(works.len().saturating_sub(1));
            let tower_height = self.tower_top.map_or(0.0, |t| self.plan.top(t));
            let mut current = out.start_tool;
            // Each purge of the layer starts where the one before it ended.
            let mut used_rows = 0.0;
            let mut last_purge: Option<usize> = None;
            let h = self.plan.thickness(layer);
            // Infill, objects and support take up a flush only where the tower purges the flush: a single
            // nozzle's change. A tool changer's head and a nozzle of a filament map hold their own filament
            // and prime a fixed volume (Orca's `Print::_make_wipe_tower`, type 2 without
            // `purge_in_prime_tower`; Bambu Studio's prime volume beside the chute flush).
            let absorbs = !crate::nozzles::shared(cfg)
                && (crate::tower::type1(cfg) || crate::tower::flush_on_tower(cfg));
            // Orca's `WipeTower2::save_on_last_wipe` (type 2 towers): the layer's first purge is cut by what
            // finishing the layer (its wall and the fill over the purges) extrudes anyway, down to the new
            // filament's `filament_minimal_purge_on_wipe_tower`.
            // The save is measured on the tower as Orca first plans it, before the saves shrink it.
            let saving = tower
                .as_ref()
                .filter(|_| crate::tower::saves_on_last_wipe(cfg))
                .and_then(|t| {
                    crate::tower::Tower::new(cfg, self.tool_count, self.tower_rows0)
                        .map(|t0| t0.shaped(t.width(), t.angle()).at(t.origin()))
                });
            let mut first_purge = true;
            for i in 0..works.len() {
                let Some(next_tool) = works.get(i).map(|w| w.tool) else {
                    continue;
                };
                let change = current != 0 && next_tool != current;
                let purge =
                    change.then(|| crate::tower::change_purge(cfg, self.tool_count, current, next_tool));
                // The old filament rams out before the change, printed with it at the end of its own work.
                let mut lead = None;
                if let (Some(p), Some(t), Some(prev)) = (purge, tower.as_ref(), i.checked_sub(1))
                    && p.ram > 0.0
                    && let Some(w) = works.get_mut(prev)
                {
                    let (path, rows, end) = t.ramming(cfg, p, current, h, used_rows);
                    used_rows += rows;
                    lead = end;
                    w.tower_after.extend(path);
                }
                let Some(work) = works.get_mut(i) else { continue };
                if let (true, Some(tower)) = (i == wall_at && walled, tower.as_ref()) {
                    work.tower.push(tower.wall(first, self.plan.top(layer)));
                    // a type 1 tower's brim narrows over the first layers (orca's brim chamfer)
                    if crate::tower::type1(cfg) {
                        work.tower
                            .extend(tower.chamfer(layer, h, self.plan.top(layer), tower_height));
                    } else if first {
                        work.tower
                            .extend(tower.brim(self.plan.thickness(0), tower_height));
                    }
                }
                if let Some(p) = purge {
                    let mut v = p.wipe;
                    // Flush into infill, objects or support: what the new filament prints anyway takes
                    // up the purge, and the tower (when there is one) purges the rest.
                    let mut taken = 0.0;
                    if absorbs {
                        if crate::tower::flag_or(cfg, "flush_into_infill", true)
                            || crate::tower::flag(cfg, "flush_into_objects")
                        {
                            taken += work_infill_volume(work, cfg.line_width, h);
                            if taken > 0.0 {
                                work.flush_first = true;
                            }
                        }
                        if crate::tower::flag(cfg, "flush_into_objects") {
                            taken += work_solid_volume(work, cfg.line_width, h);
                        }
                        if crate::tower::flag_or(cfg, "flush_into_support", true) {
                            taken += work_support_volume(work, cfg.line_width, h);
                        }
                    }
                    v = (v - taken).max(0.0);
                    if let Some(t0) = saving.as_ref().filter(|_| first_purge) {
                        v = t0.saved_wipe(cfg, v, h, first, used_rows, work.tool);
                    }
                    first_purge = false;
                    if let (true, Some(tower)) = (v > 0.5, tower.as_ref()) {
                        let (path, rows) = tower.purge_lead(v, h, first, used_rows, lead);
                        used_rows += rows;
                        work.tower.extend(path);
                        last_purge = Some(i);
                    }
                }
                current = work.tool;
            }
            // The depth the purges left free is filled by the filament of the last purge (Orca's
            // finish block), or with the outline when the layer purged nothing.
            let fill_at = last_purge.or((walled && !works.is_empty()).then_some(wall_at));
            if let (Some(i), Some(tower)) = (fill_at, tower.as_ref())
                && let Some(work) = works.get_mut(i)
            {
                work.tower.extend(tower.fill(cfg, used_rows, first));
            }
        }
        let brim_kind = crate::brim::Kind::of(cfg);
        let auto_brim = brim_kind == crate::brim::Kind::Auto;
        // No brim over a raft (Orca: `PrintObject::has_brim`).
        if layer == 0
            && self.raft.is_none()
            && brim_kind != crate::brim::Kind::Off
            && (cfg.brim_width > 0.0 || auto_brim)
        {
            let all: Vec<&Shapes> = here.regions.iter().map(|(_, s)| s).collect();
            // Orca's brim follows the outline before elephant foot compensation, unless
            // `brim_use_efc_outline` asks for the compensated one.
            let use_efc = crate::firmware::truthy(cfg, "brim_use_efc_outline")
                && cfg.raw_number("elefant_foot_compensation", 0.0) > 0.0;
            let union = match (&here.raw, use_efc) {
                (Some(raw), false) => raw.clone(),
                _ => perimeters::union_all(&all),
            };
            let object_height = self.plan.top(n.saturating_sub(1));
            // Orca (`Brim.cpp`): the brim is an even number of line spacings wide, each loop one spacing
            // (first layer line width less the rounded corners of the bead) from the last.
            let spacing_mm = (cfg.line_width
                - cfg.initial_layer_print_height * (1.0 - std::f64::consts::FRAC_PI_4))
                .max(cfg.line_width * 0.5);
            // `auto_brim` sizes the brim from each object's own height and first layer footprint (Orca
            // `configBrimWidthByVolumeGroups`, per object), never from the plate as a whole: four copies
            // side by side get the brim one of them gets.
            let owners: Vec<usize> = if auto_brim && self.objects.len() > 1 {
                let hulls: Vec<&[[f64; 2]]> = self.objects.iter().map(|o| o.hull.as_slice()).collect();
                union
                    .iter()
                    .map(|island| crate::brim::owner(island, &hulls))
                    .collect()
            } else {
                vec![0; union.len()]
            };
            let per_object: Vec<(f64, f64)> = if auto_brim {
                let objects = owners.iter().copied().max().map_or(1, |m| m + 1);
                (0..objects)
                    .map(|k| {
                        let own: Shapes = union
                            .iter()
                            .zip(&owners)
                            .filter(|(_, o)| **o == k)
                            .map(|(i, _)| i.clone())
                            .collect();
                        let height = if self.objects.len() > 1 {
                            self.object_heights
                                .get(k)
                                .copied()
                                .unwrap_or(object_height)
                                .min(object_height)
                        } else {
                            object_height
                        };
                        let width = if own.is_empty() {
                            0.0
                        } else {
                            crate::brim::width(cfg, &own, height)
                        };
                        (width, height)
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let object_width = cfg.brim_width;
            let painted_ears: Vec<crate::brim::Ear> = if brim_kind == crate::brim::Kind::Painted {
                self.brim_ears
                    .iter()
                    .map(|e| crate::brim::Ear {
                        at: {
                            let p = crate::geom::Point::from_mm(e[0], e[1]);
                            IntPoint::new(p.x, p.y)
                        },
                        head_radius: e[3],
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let gap_mm = cfg.raw_number("brim_object_gap", 0.0).clamp(0.0, 2.0);
            let combine = crate::tower::flag_or(cfg, "combine_brims", true);
            let bodies = perimeters::offset_round(&union, mm(gap_mm));
            // No brim where the first support layer prints (Orca Brim.cpp `outer_inner_brim_area`: the
            // support's first layer is a no-brim area).
            // Trees are left out: Orca also draws a brim around their bases there, which is not built yet.
            // Asked only with support on: the question builds the whole support plan, which with support off
            // nothing else needs.
            let no_brim: Shapes = match cfg.enable_support.then(|| self.support_at(cfg, 0)).flatten() {
                Some((sl, ..)) if sl.classic.is_none() && sl.organic.is_none() => {
                    let pad = if sl.base.is_empty() {
                        Vec::new()
                    } else {
                        self.pad_area(cfg, sl)
                    };
                    perimeters::union_all(&[&pad, &sl.interface])
                }
                _ => Vec::new(),
            };
            let clear = |areas: Vec<Shapes>| -> Vec<Shapes> {
                if no_brim.is_empty() {
                    areas
                } else {
                    areas
                        .iter()
                        .map(|a| perimeters::difference(a, &no_brim))
                        .collect()
                }
            };
            // The box the extruder printing filament `slot` reaches, when the filament map and the printer say so.
            let reach_of = |slot: u8| -> Option<Shapes> {
                let map = self.nozzle_map.as_ref()?;
                let boxes = crate::nozzles::reach_boxes(cfg, crate::nozzles::extruders(cfg));
                let b = boxes.get(map.extruder_of(slot)).copied().flatten()?;
                let p = |x: f64, y: f64| IntPoint::new(mm(x), mm(y));
                Some(vec![vec![vec![
                    p(b[0], b[1]),
                    p(b[2], b[1]),
                    p(b[2], b[3]),
                    p(b[0], b[3]),
                ]]])
            };
            // The brim area of each island, grouped by the filament that prints it (the one the island
            // is mostly made of).
            let mut by_slot: std::collections::BTreeMap<u8, Vec<Shapes>> = std::collections::BTreeMap::new();
            let mut finished: Vec<(u8, Vec<Vec<IntPoint<i32>>>)> = Vec::new();
            for (island, owner) in union.iter().zip(&owners) {
                let one: Shapes = vec![island.clone()];
                let brim_mm = if auto_brim {
                    let (width, height) = per_object.get(*owner).copied().unwrap_or((0.0, object_height));
                    crate::brim::island_width(width, &one, height, spacing_mm)
                } else {
                    object_width
                };
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "brim loop count is small"
                )]
                let count = 2 * (brim_mm / spacing_mm / 2.0).floor().max(0.0) as i32;
                if count == 0 {
                    continue;
                }
                let slot = here
                    .regions
                    .iter()
                    .map(|(slot, shapes)| (*slot, shapes_area(&perimeters::intersection(&one, shapes))))
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map_or(0, |(slot, _)| slot);
                let width_even = f64::from(count) * spacing_mm;
                let areas = crate::brim::island_areas(
                    cfg,
                    brim_kind,
                    &one,
                    &union,
                    width_even,
                    spacing_mm,
                    gap_mm,
                    &painted_ears,
                );
                let areas = clear(areas);
                // Orca Brim.cpp: where each extruder reaches only part of the bed (H2D, H2C), a brim is cut to
                // the reach of the extruder that prints it (the ring outside get_extruder_printable_polygons is a
                // no-brim area there).
                let areas = match reach_of(slot) {
                    Some(r) => areas.iter().map(|a| perimeters::intersection(a, &r)).collect(),
                    None => areas,
                };
                if combine {
                    by_slot.entry(slot).or_default().extend(areas);
                } else {
                    finished.push((slot, crate::brim::finish(&areas, &bodies, spacing_mm)));
                }
            }
            for (slot, areas) in by_slot {
                finished.push((slot, crate::brim::finish(&areas, &bodies, spacing_mm)));
            }
            for (slot, loops) in finished {
                // Orca prints an object's brim just before its first extrusion on the layer: with the
                // first filament in the layer's order that prints one of the island's features.
                let f = feature_tools(cfg, slot);
                let mine = [f.outer, f.inner, f.sparse, f.solid, f.top, f.bottom];
                let at = works.iter().position(|w| mine.contains(&w.tool)).unwrap_or(0);
                if let Some(work) = works.get_mut(at) {
                    work.brim.extend(loops);
                }
            }
        }
        if skirt_here && !works.is_empty() {
            let loops = skirt_loops(
                here,
                &skirt_extra,
                cfg,
                self.draft_hull.as_deref(),
                &self.skirt_groups,
                (usize::from(self.tool_count), layer),
            );
            // The layer's first filament prints the skirt, as in Orca, unless its extruder cannot reach it (H2D,
            // H2C): then the first filament whose extruder reaches all of it does.
            let at = self.skirt_tool_at(cfg, &works, &loops);
            if let Some(w) = works.get_mut(at) {
                w.skirt = loops;
            }
        }
        // Painted seam pieces within reach of this layer.
        let z = self.plan.top(layer);
        let reach = cfg.line_width * 2.0;
        let faces: Vec<crate::seam::SeamFace> = self
            .seam_faces
            .iter()
            .filter(|f| {
                let zs = f.tri.map(|v| v[2]);
                zs[0].min(zs[1]).min(zs[2]) <= z + reach && zs[0].max(zs[1]).max(zs[2]) >= z - reach
            })
            .copied()
            .collect();
        let vase = self
            .vase
            .filter(|&b| layer >= b && layer >= cfg.skirt_height)
            .map(|b| crate::spiral::VaseLayer {
                first: layer == b.max(cfg.skirt_height),
                last: layer + 1 == n,
                anchor: crate::geom::Point::from_mm(
                    f64::midpoint(self.bounds[0], self.bounds[2]),
                    self.bounds[1] - 1000.0,
                ),
                blend: None,
            })
            .map(|mut v| {
                // `spiral_mode_smooth`: each point moves toward the loop below (Orca's SpiralVase).
                if smooth
                    && !v.first
                    && crate::firmware::truthy(cfg, "spiral_mode_smooth")
                    && let Some(below) = layer.checked_sub(1)
                {
                    let prev = self.layer_paths_with(below, cfg, mods, get, micros, tags, false);
                    if prev.spiral {
                        v.blend = Some(crate::spiral::Blend {
                            below: prev.points,
                            max_xy: crate::spiral::max_xy_smoothing(cfg),
                        });
                    }
                }
                v
            });
        // A single extruder for several filaments primes each one in its own section along the
        // front of the bed before the first layer, the first layer's first filament last.
        if layer == 0
            && self.raft.is_none()
            && self.tool_count > 1
            && self.tower(cfg).is_some()
            && crate::tower::flag_or(cfg, "single_extruder_multi_material", true)
            && crate::tower::flag(cfg, "single_extruder_multi_material_priming")
            && let Some(first_tool) = works.first().map(|w| w.tool)
        {
            let mut order: Vec<u8> = self.tool_order.iter().flatten().copied().collect();
            order.sort_unstable();
            order.dedup();
            order.retain(|t| *t != first_tool);
            order.push(first_tool);
            let count = order.len();
            let primes: Vec<ToolWork> = order
                .iter()
                .enumerate()
                .map(|(k, &tool)| {
                    // Each filament wipes 20 mm3; the last wipes what changing to it needs.
                    let volume = match k.checked_sub(1).and_then(|p| order.get(p)) {
                        Some(&prev) if k + 1 == count => {
                            crate::tower::purge_volume(cfg, self.tool_count, prev, tool)
                        }
                        _ => 20.0,
                    };
                    ToolWork {
                        tool,
                        tower: vec![crate::tower::prime_section(
                            cfg,
                            k,
                            count,
                            volume,
                            self.plan.thickness(0),
                        )],
                        ..ToolWork::default()
                    }
                })
                .collect();
            let mut all = primes;
            all.append(&mut works);
            works = all;
        }
        paths::plan_layer_paths(
            &mut out,
            &works,
            cfg,
            layer,
            (&faces, z, self.seams.get().and_then(Option::as_ref)),
            vase.as_ref(),
            &self.object_hulls,
        );
        let fc = tags.filament(cfg, paths::first_slot(&out));
        paths::cool_with(&mut out, cfg, &fc);
        if let Some(role) = crate::brick::role(cfg, layer, n, top_n) {
            crate::brick::apply(&mut out, role);
        }
        if !solid_areas.is_empty()
            && let Some(a) = out.areas.as_mut()
        {
            let refs: Vec<&Shapes> = solid_areas.iter().collect();
            a.solid = perimeters::union_all(&refs);
        }
        if let Some(areas) = out.areas.take() {
            // The top surface angle: the profile's, or the solid infill direction of this layer.
            let base = crate::motion::raw_f(cfg, "top_layer_direction")
                .filter(|a| *a >= 0.0)
                .or_else(|| self.template_angle(cfg, "solid_infill_rotate_template", layer))
                .unwrap_or(if dir == Dir::D45 { 45.0 } else { 135.0 })
                + self.model_turn(cfg);
            if crate::ironing::add(&mut out, &areas, cfg, layer + 1 == n, base) {
                out.time_s = paths::estimate_time(&out, cfg);
            }
            out.areas = Some(areas);
        }
        Micros::add(&micros.paths, &t);
        out
    }
}

/// Convex hull of a point set, counterclockwise.
pub(crate) fn convex_hull(mut pts: Vec<IntPoint<i32>>) -> Vec<IntPoint<i32>> {
    crate::sorting::sort_by_key(&mut pts, |p| (p.x, p.y));
    pts.dedup();
    if pts.len() < 3 {
        return Vec::new();
    }
    let cross = |o: IntPoint<i32>, a: IntPoint<i32>, b: IntPoint<i32>| {
        (i64::from(a.x) - i64::from(o.x)) * (i64::from(b.y) - i64::from(o.y))
            - (i64::from(a.y) - i64::from(o.y)) * (i64::from(b.x) - i64::from(o.x))
    };
    let mut hull: Vec<IntPoint<i32>> = Vec::new();
    for pass in 0..2 {
        let start = hull.len();
        let iter: Box<dyn Iterator<Item = &IntPoint<i32>>> = if pass == 0 {
            Box::new(pts.iter())
        } else {
            Box::new(pts.iter().rev())
        };
        for &p in iter {
            while hull.len() >= start + 2
                && hull
                    .get(hull.len() - 2)
                    .zip(hull.last())
                    .is_some_and(|(&a, &b)| cross(a, b, p) <= 0)
            {
                hull.pop();
            }
            hull.push(p);
        }
        hull.pop();
    }
    hull
}

/// Whether `infill_combination` applies: on, with sparse infill that is neither empty nor solid.
fn combine_on(cfg: &PrintConfig) -> bool {
    crate::firmware::truthy(cfg, "infill_combination")
        && cfg.sparse_infill_density > 0.0
        && cfg.sparse_infill_density < 100.0
}

/// `make_overhang_printable`: the cone angle, degrees, and the largest hole kept open, mm2; None when off or
/// at 90 degrees, which allows any overhang.
fn conical_params(cfg: &PrintConfig) -> Option<(f64, f64)> {
    let angle = cfg.raw_number("make_overhang_printable_angle", 55.0);
    (crate::tower::flag(cfg, "make_overhang_printable") && angle < 90.0 - 1e-9).then(|| {
        (
            angle.max(0.0),
            cfg.raw_number("make_overhang_printable_hole_size", 0.0).max(0.0),
        )
    })
}

/// A hole that is a convex polygon of more than eight points whose points and edge midpoints all lie within
/// the margin of one circle (Orca `_transform_hole_to_polyholes`): its center, radius (the farthest point),
/// and the margin, all in internal units. `threshold` is `hole_to_polyhole_threshold`, mm or percent of the
/// mean radius.
fn circular(hole: &[IntPoint<i32>], threshold: &serde_json::Value) -> Option<((f64, f64), f64, f64)> {
    let n = hole.len();
    if n <= 8 {
        return None;
    }
    let pts: Vec<(f64, f64)> = hole.iter().map(|p| (f64::from(p.x), f64::from(p.y))).collect();
    let next = |k: usize| pts.iter().cycle().skip(k).copied();
    // Convex: every turn bends the same way (collinear points allowed).
    let turns: Vec<f64> = next(0)
        .zip(next(1))
        .zip(next(2))
        .take(n)
        .map(|((a, b), c)| (b.0 - a.0) * (c.1 - b.1) - (b.1 - a.1) * (c.0 - b.0))
        .collect();
    if turns.iter().any(|t| *t > 0.0) && turns.iter().any(|t| *t < 0.0) {
        return None;
    }
    // Orca's centroid: the area weighted mean of the edge midpoints.
    let (mut area, mut cx, mut cy) = (0.0, 0.0, 0.0);
    let mut p1 = *pts.last()?;
    for p2 in &pts {
        let a = p1.0 * p2.1 - p1.1 * p2.0;
        area += a;
        cx += (p1.0 + p2.0) * a;
        cy += (p1.1 + p2.1) * a;
        p1 = *p2;
    }
    if area == 0.0 {
        return None;
    }
    let center = (cx / (3.0 * area), cy / (3.0 * area));
    let dist = |p: (f64, f64)| (p.0 - center.0).m_hypot(p.1 - center.1);
    let radii: Vec<f64> = pts.iter().map(|p| dist(*p)).collect();
    let (dmin, dmax) = radii
        .iter()
        .fold((f64::MAX, 0.0_f64), |(lo, hi), r| (lo.min(*r), hi.max(*r)));
    #[allow(clippy::cast_precision_loss, reason = "a vertex count")]
    let mean = radii.iter().sum::<f64>() / n as f64;
    let mids: Vec<f64> = next(0)
        .zip(next(1))
        .take(n)
        .map(|(a, b)| dist((f64::midpoint(a.0, b.0), f64::midpoint(a.1, b.1))))
        .collect();
    let (lmin, lmax) = mids
        .iter()
        .fold((f64::MAX, 0.0_f64), |(lo, hi), r| (lo.min(*r), hi.max(*r)));
    let margin_mm = crate::config::float_or_percent(threshold, mean / crate::geom::SCALE).unwrap_or(0.01);
    let var = (margin_mm * crate::geom::SCALE).max(1.0);
    (dmax - dmin < var * 2.0 && lmax - lmin < var * 2.0).then_some((center, dmax, var))
}

/// Orca `create_polyholes`: a polygon with `max(3, round(4 r 0.4 / nozzle))` sides whose edges sit at the
/// circle's radius, clockwise. With `multiple` five of them, each turned a fifth of a side from the last, in
/// the order Orca lays them out, so successive layers turn the hole.
#[allow(clippy::cast_precision_loss, reason = "small side and polygon counts")]
fn create_polyholes(center: (f64, f64), radius: f64, nozzle: f64, multiple: bool) -> Vec<Vec<IntPoint<i32>>> {
    let r_mm = radius / crate::geom::SCALE;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a small side count"
    )]
    let edges = ((4.0 * r_mm * 0.4 / nozzle.max(0.01)).round().max(3.0)) as usize;
    let (count, rotation) = if multiple {
        (5usize, std::f64::consts::TAU / (edges * 5) as f64)
    } else {
        (1, 0.0)
    };
    let mut list: Vec<Vec<IntPoint<i32>>> = vec![Vec::new(); count];
    let new_radius = radius / (std::f64::consts::PI / edges as f64).m_cos();
    for i_poly in 0..count {
        let slot = if i_poly % 2 == 0 {
            i_poly / 2
        } else {
            count.div_ceil(2) + i_poly / 2
        };
        let mut ring: Vec<IntPoint<i32>> = (0..edges)
            .map(|e| {
                let angle = rotation * i_poly as f64 + std::f64::consts::TAU * e as f64 / edges as f64;
                #[allow(clippy::cast_possible_truncation, reason = "a point in internal units")]
                IntPoint::new(
                    (center.0 + new_radius * angle.m_cos()).round() as i32,
                    (center.1 + new_radius * angle.m_sin()).round() as i32,
                )
            })
            .collect();
        // Holes are clockwise.
        if crate::geom::area2_int(&ring) > 0 {
            ring.reverse();
        }
        if let Some(s) = list.get_mut(slot) {
            *s = ring;
        }
    }
    list
}

/// `bridge_line_width`: the width bridge strands print at, mm, when set (a percent is of the nozzle).
fn bridge_line_width(cfg: &PrintConfig) -> Option<f64> {
    // Orca's default is 100 percent of the nozzle; 0 means the feature's own width.
    match cfg.raw.get("bridge_line_width") {
        None => Some(cfg.nozzle_diameter),
        Some(v) => crate::config::float_or_percent(v, cfg.nozzle_diameter).filter(|w| *w > 0.0),
    }
}

/// `bridge_density` and `internal_bridge_density` as a share of 1, kept within Orca's 10 to 125 percent.
fn bridge_density(cfg: &PrintConfig, key: &str) -> f64 {
    (cfg.raw_number(key, 100.0) / 100.0).clamp(0.1, 1.25)
}

/// The spacing of the skirt's loops, mm (Orca's skirt flow at the first layer's height).
pub(crate) fn skirt_spacing_mm(cfg: &PrintConfig) -> f64 {
    (cfg.line_width - cfg.initial_layer_print_height * (1.0 - std::f64::consts::FRAC_PI_4))
        .max(cfg.line_width * 0.5)
}

/// The distance from a point to a segment, internal units.
fn point_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p.0 - (a.0 + dx * t)).m_hypot(p.1 - (a.1 + dy * t))
}

pub(crate) fn as_f(p: IntPoint<i32>) -> (f64, f64) {
    (f64::from(p.x), f64::from(p.y))
}

/// The edges of a closed polygon.
fn edges(poly: &[IntPoint<i32>]) -> impl Iterator<Item = ((f64, f64), (f64, f64))> + '_ {
    poly.iter()
        .zip(poly.iter().cycle().skip(1))
        .map(|(a, b)| (as_f(*a), as_f(*b)))
}

/// Whether a point is inside a counterclockwise convex polygon.
fn inside_hull(p: (f64, f64), hull: &[IntPoint<i32>]) -> bool {
    edges(hull).all(|(a, b)| (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0) >= 0.0)
}

/// The distance from a point to a convex polygon, 0 inside it.
pub(crate) fn point_to_hull(p: (f64, f64), hull: &[IntPoint<i32>]) -> f64 {
    if inside_hull(p, hull) {
        return 0.0;
    }
    edges(hull)
        .map(|(a, b)| point_segment(p, a, b))
        .fold(f64::MAX, f64::min)
}

/// The distance between two convex polygons, 0 when they touch or overlap.
fn hull_gap(a: &[IntPoint<i32>], b: &[IntPoint<i32>]) -> f64 {
    let near = |p: &[IntPoint<i32>], q: &[IntPoint<i32>]| {
        p.iter()
            .map(|v| point_to_hull(as_f(*v), q))
            .fold(f64::MAX, f64::min)
    };
    // Convex polygons that overlap without a vertex inside the other cross edge to edge.
    let side =
        |o: (f64, f64), p: (f64, f64), q: (f64, f64)| (p.0 - o.0) * (q.1 - o.1) - (p.1 - o.1) * (q.0 - o.0);
    let crossing = edges(a).any(|(p1, p2)| {
        edges(b).any(|(q1, q2)| {
            side(p1, p2, q1) * side(p1, p2, q2) < 0.0 && side(q1, q2, p1) * side(q1, q2, p2) < 0.0
        })
    });
    if crossing { 0.0 } else { near(a, b).min(near(b, a)) }
}

/// Skirt loops around a layer: the convex hull of everything on it, grown by
/// the brim width and `skirt_distance`, then one loop per `skirt_loops`, the
/// innermost first, as the slicers print them. With `groups` (`skirt_type`
/// per object) each group of objects gets the loops of its own hull.
fn skirt_loops(
    here: &LayerRegions,
    extra: &[IntPoint<i32>],
    cfg: &PrintConfig,
    whole: Option<&[IntPoint<i32>]>,
    groups: &[Vec<IntPoint<i32>>],
    (tools, layer): (usize, u32),
) -> Vec<Vec<IntPoint<i32>>> {
    let mut points: Vec<IntPoint<i32>> = here
        .regions
        .iter()
        .flat_map(|(_, s)| s.iter())
        .filter_map(|shape| shape.first())
        .flat_map(|ring| ring.iter().copied())
        .collect();
    if whole.is_none() && groups.len() > 1 {
        let mut buckets: Vec<Vec<IntPoint<i32>>> = vec![Vec::new(); groups.len()];
        points.extend_from_slice(extra);
        for p in points {
            let at = groups
                .iter()
                .enumerate()
                .min_by(|a, b| point_to_hull(as_f(p), a.1).total_cmp(&point_to_hull(as_f(p), b.1)))
                .map_or(0, |(i, _)| i);
            if let Some(b) = buckets.get_mut(at) {
                b.push(p);
            }
        }
        return buckets
            .into_iter()
            .flat_map(|b| loops_around(convex_hull(b), cfg, false, (tools, layer)))
            .collect();
    }
    match whole {
        Some(h) => loops_around(h.to_vec(), cfg, true, (tools, layer)),
        None if extra.is_empty() => loops_around(convex_hull(points), cfg, false, (tools, layer)),
        // Orca's occupied outline: the objects with their brim, then the support and the tower as they print.
        None => {
            let objects = convex_hull(points);
            let brim = mm(cfg.brim_width.max(0.0));
            let mut occupied: Vec<IntPoint<i32>> = if brim > 0 && objects.len() >= 3 {
                perimeters::offset_round(&vec![vec![objects]], brim)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .collect()
            } else {
                objects
            };
            occupied.extend_from_slice(extra);
            loops_around(convex_hull(occupied), cfg, true, (tools, layer))
        }
    }
}

/// The loops around one hull (a whole-part hull already includes the brim), outermost first.
/// Orca (`Print::_make_skirt`): `skirt_loops` of them, and with `min_skirt_length` more until the filament
/// of the loops, counted extruder by extruder, reaches that many mm for the extruder in turn.
fn loops_around(
    hull: Vec<IntPoint<i32>>,
    cfg: &PrintConfig,
    includes_brim: bool,
    (tools, layer): (usize, u32),
) -> Vec<Vec<IntPoint<i32>>> {
    if hull.len() < 3 {
        return Vec::new();
    }
    let base: Shapes = vec![vec![hull]];
    // Orca (`Print::_make_skirt`): loop k sits `skirt_distance + spacing * (k + 0.5)` from the occupied
    // outline (the part and its brim), corners rounded, and the loops print outermost first.
    let spacing = mm(skirt_spacing_mm(cfg));
    let brim = if cfg.brim_width > 0.0 && !includes_brim {
        cfg.brim_width
    } else {
        0.0
    };
    let gap = mm(cfg.skirt_distance + brim);
    // Filament per mm of loop: the skirt's cross section over the filament's.
    let min_length = cfg.raw_number("min_skirt_length", 0.0);
    let diameter = cfg.raw_number("filament_diameter", 1.75).max(0.1);
    let e_per_mm = skirt_spacing_mm(cfg) * cfg.initial_layer_print_height
        / (std::f64::consts::PI * diameter * diameter / 4.0);
    let (mut extruded, mut extruder) = (0.0_f64, 0usize);
    let mut out = Vec::new();
    // Draft shield with no skirt asked for is one loop, as in Orca.
    let mut remaining = cfg.skirt_loops.max(1);
    let mut k = 0;
    while remaining > 0 {
        remaining -= 1;
        let grow = gap + spacing / 2 + spacing * k;
        k += 1;
        let Some(ring) = perimeters::offset_round(&base, grow)
            .into_iter()
            .next()
            .and_then(|s| s.into_iter().next())
        else {
            break;
        };
        let ring = perimeters::simplify_ring(&ring, 500);
        if min_length > 0.0 {
            extruded += ring_length_mm(&ring) * e_per_mm;
            if extruded < min_length {
                if remaining == 0 {
                    remaining = 1;
                }
            } else if extruder + 1 < tools {
                extruder += 1;
                extruded = 0.0;
            }
        }
        out.push(ring);
        if k >= 1000 {
            break;
        }
    }
    out.reverse();
    // `single_loop_draft_shield`: above the first layer one loop prints, the innermost (the last).
    if layer > 0 && crate::tower::flag(cfg, "single_loop_draft_shield") && out.len() > 1 {
        out.drain(..out.len() - 1);
    }
    out
}

/// The length of a closed ring, mm.
fn ring_length_mm(ring: &[IntPoint<i32>]) -> f64 {
    ring.iter()
        .zip(ring.iter().cycle().skip(1))
        .map(|(a, b)| f64::from(b.x - a.x).m_hypot(f64::from(b.y - a.y)))
        .sum::<f64>()
        / 10_000.0
}

/// Merges the ranges covering each layer into distinct override objects.
/// Returns the objects and, per layer, 0 (base) or 1 plus the object's index.
/// Which filaments each layer prints and in what order, judged from the height each part and each
/// painted surface covers, plus the last layer with a tool change (where the prime tower ends).
/// Each layer starts with the tool the layer below ended on when it uses it, and ends on a tool the
/// layer above uses, so the nozzle changes filament as seldom as it can; `OrcaSlicer` orders layers the same way.
/// Returns the orders, the last layer with any change and the last with a change inside the layer.
/// The filament of each feature of a region on `slot`: Orca's `outer_wall_filament_id`,
/// `inner_wall_filament_id`, `sparse_infill_filament_id`, `internal_solid_filament_id`,
/// `top_surface_filament_id` and `bottom_surface_filament_id` (0 is the region's own filament),
/// filled in as Orca's `normalize_fdm` does: internal solid from sparse, then from top or bottom,
/// and top and bottom from internal solid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FeatureTools {
    outer: u8,
    inner: u8,
    sparse: u8,
    solid: u8,
    top: u8,
    bottom: u8,
}

/// Per-feature filament keys, and the older names Orca reads for them (`1` meant the default there).
const FEATURE_KEYS: [(&str, &[&str]); 6] = [
    (
        "outer_wall_filament_id",
        &["outer_wall_filament", "wall_filament", "perimeter_extruder"],
    ),
    ("inner_wall_filament_id", &["inner_wall_filament"]),
    (
        "sparse_infill_filament_id",
        &["sparse_infill_filament", "infill_extruder"],
    ),
    (
        "internal_solid_filament_id",
        &["solid_infill_filament", "solid_infill_extruder"],
    ),
    ("top_surface_filament_id", &["top_solid_infill_filament"]),
    ("bottom_surface_filament_id", &["bottom_solid_infill_filament"]),
];

/// A per-feature filament from settings read through `get`: the key, or an older name for it.
fn feature_id_of<'v>(get: impl Fn(&str) -> Option<&'v serde_json::Value>, key: &str, legacy: &[&str]) -> u8 {
    let num = |k: &str| -> Option<f64> {
        let x = match get(k)? {
            serde_json::Value::Array(a) => a.first()?.clone(),
            other => other.clone(),
        };
        match x {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(t) => t.trim().parse().ok(),
            _ => None,
        }
    };
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a filament slot"
    )]
    let slot = |x: f64| x.clamp(0.0, 255.0).round() as u8;
    if let Some(x) = num(key) {
        return slot(x);
    }
    // A legacy key's 1 is the default (the object's filament).
    legacy
        .iter()
        .find_map(|k| num(k))
        .map_or(0, |x| if slot(x) == 1 { 0 } else { slot(x) })
}

fn feature_tools(cfg: &PrintConfig, slot: u8) -> FeatureTools {
    let [outer, inner, sparse, mut solid, mut top, mut bottom] =
        FEATURE_KEYS.map(|(k, legacy)| feature_id_of(|name| cfg.raw.get(name), k, legacy));
    if solid == 0 && sparse > 0 {
        solid = sparse;
    }
    if solid == 0 && top > 0 {
        solid = top;
    }
    if solid == 0 && bottom > 0 {
        solid = bottom;
    }
    if top == 0 && solid > 0 {
        top = solid;
    }
    if bottom == 0 && solid > 0 {
        bottom = solid;
    }
    let or = |t: u8| if t == 0 { slot } else { t };
    FeatureTools {
        outer: or(outer),
        inner: or(inner),
        sparse: or(sparse),
        solid: or(solid),
        top: or(top),
        bottom: or(bottom),
    }
}

/// True when one of these settings objects puts a feature on a filament of its own.
fn uses_feature_tools(values: &[&serde_json::Value]) -> bool {
    values.iter().any(|v| {
        FEATURE_KEYS
            .iter()
            .any(|(k, legacy)| feature_id_of(|name| v.get(name), k, legacy) > 0)
    })
}

/// A region's work split into works of the filaments its features print with.
fn split_by_feature(work: ToolWork, t: FeatureTools) -> Vec<ToolWork> {
    let slot = work.tool;
    if [t.outer, t.inner, t.sparse, t.solid, t.top, t.bottom]
        .iter()
        .all(|&x| x == slot)
    {
        return vec![work];
    }
    let template = ToolWork {
        width: work.width,
        overhang: work.overhang.clone(),
        bridge_width: work.bridge_width,
        bridge_flat_flow: work.bridge_flat_flow,
        internal_bridge_width: work.internal_bridge_width,
        internal_bridge_ratio: work.internal_bridge_ratio,
        ..ToolWork::default()
    };
    let mut out: Vec<ToolWork> = Vec::new();
    let at = |out: &mut Vec<ToolWork>, tool: u8| -> usize {
        if let Some(k) = out.iter().position(|w| w.tool == tool) {
            return k;
        }
        let mut w = template.clone();
        w.tool = tool;
        out.push(w);
        out.len() - 1
    };
    // Walls first, so the region's islands keep their order; the outer wall and the rest can part.
    for isl in &work.islands {
        let parts = if t.outer == t.inner {
            vec![(t.outer, isl.clone())]
        } else {
            vec![
                (
                    t.outer,
                    perimeters::IslandWalls {
                        loops: isl.loops.iter().filter(|(k, _)| *k == 0).cloned().collect(),
                        gaps: Vec::new(),
                        wide: isl
                            .wide
                            .iter()
                            .filter(|l| l.inset == 0 && !l.is_odd)
                            .cloned()
                            .collect(),
                        gap_lines: Vec::new(),
                    },
                ),
                (
                    t.inner,
                    perimeters::IslandWalls {
                        loops: isl.loops.iter().filter(|(k, _)| *k != 0).cloned().collect(),
                        gaps: isl.gaps.clone(),
                        wide: isl
                            .wide
                            .iter()
                            .filter(|l| l.inset != 0 || l.is_odd)
                            .cloned()
                            .collect(),
                        gap_lines: isl.gap_lines.clone(),
                    },
                ),
            ]
        };
        for (tool, part) in parts {
            if part.loops.is_empty()
                && part.wide.is_empty()
                && part.gaps.is_empty()
                && part.gap_lines.is_empty()
            {
                continue;
            }
            let k = at(&mut out, tool);
            if let Some(w) = out.get_mut(k) {
                w.islands.push(part);
            }
        }
    }
    let ToolWork {
        sparse,
        sparse_paths,
        sparse_alt,
        sparse_thick,
        flush_first,
        bottom,
        shell,
        shell_thick,
        internal_bridge,
        internal_bridge_paths,
        top,
        bridge,
        bridge_paths,
        gap_bottom,
        gap_shell,
        gap_top,
        region_bottom,
        region_shell,
        region_narrow,
        region_sparse,
        region_top,
        ..
    } = work;
    if !(sparse.is_empty() && sparse_paths.is_empty() && sparse_alt.is_empty() && sparse_thick.is_empty()) {
        let k = at(&mut out, t.sparse);
        if let Some(w) = out.get_mut(k) {
            w.region_sparse.extend(region_sparse);
            w.sparse.extend(sparse);
            w.sparse_paths.extend(sparse_paths);
            w.sparse_alt.extend(sparse_alt);
            w.sparse_thick.extend(sparse_thick);
            w.flush_first |= flush_first;
        }
    }
    if !(bottom.is_empty() && gap_bottom.is_empty()) {
        let k = at(&mut out, t.bottom);
        if let Some(w) = out.get_mut(k) {
            w.bottom.extend(bottom);
            w.region_bottom.extend(region_bottom);
            w.gap_bottom.extend(gap_bottom);
        }
    }
    // Bridges print with the internal solid infill's filament (Orca's `frSolidInfill`).
    if !(shell.is_empty()
        && shell_thick.is_empty()
        && internal_bridge.is_empty()
        && internal_bridge_paths.is_empty()
        && bridge.is_empty()
        && bridge_paths.is_empty()
        && gap_shell.is_empty())
    {
        let k = at(&mut out, t.solid);
        if let Some(w) = out.get_mut(k) {
            w.gap_shell.extend(gap_shell);
            w.region_shell.extend(region_shell);
            w.region_narrow.extend(region_narrow);
            w.shell.extend(shell);
            w.shell_thick.extend(shell_thick);
            w.internal_bridge.extend(internal_bridge);
            w.internal_bridge_paths.extend(internal_bridge_paths);
            w.bridge.extend(bridge);
            w.bridge_paths.extend(bridge_paths);
        }
    }
    if !(top.is_empty() && gap_top.is_empty()) {
        let k = at(&mut out, t.top);
        if let Some(w) = out.get_mut(k) {
            w.top.extend(top);
            w.region_top.extend(region_top);
            w.gap_top.extend(gap_top);
        }
    }
    out
}

/// The filament slot a support setting names, 0 for the active one.
fn support_slot(cfg: &PrintConfig, key: &str) -> u8 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a filament slot"
    )]
    {
        cfg.raw_number(key, 0.0).clamp(0.0, 255.0).round() as u8
    }
}

/// The filaments of the support base and interface on a layer that starts on `active`.
fn support_tools(cfg: &PrintConfig, active: u8) -> (u8, u8) {
    let base = match support_slot(cfg, "support_filament") {
        0 => active,
        t => t,
    };
    let iface = match support_slot(cfg, "support_interface_filament") {
        0 => base,
        t => t,
    };
    (base, iface)
}

/// Puts a layer's support into the work of its filaments, adding a work for a filament the layer
/// does not print otherwise. Ironing goes with the interface.
/// The areas a travel to support may cross without a retraction (Orca `GCode::needs_retraction`): every
/// support island of the layer (`support_islands`, normal and organic support), or the branch areas of slim,
/// strong and hybrid trees (`base_areas`).
fn support_islands(sl: &crate::support::SupportLayer) -> Option<Box<crate::output::SupportAreas>> {
    let islands = if let Some(t) = &sl.classic {
        let refs: Vec<&Shapes> = t.base.iter().map(|a| &a.shape).collect();
        perimeters::union_all(&refs)
    } else if let Some(o) = &sl.organic {
        perimeters::union_all(&[
            &o.top_contact,
            &o.interface,
            &o.base_interface,
            &o.base,
            &o.bottom_contact,
        ])
    } else {
        perimeters::union_all(&[&sl.base, &sl.interface])
    };
    let keep_order = sl.classic.is_some() || sl.organic.is_some();
    (!islands.is_empty()).then(|| Box::new(crate::output::SupportAreas { islands, keep_order }))
}

fn place_support(works: &mut Vec<ToolWork>, sp: SupportPaths, flow: f32, (base, iface): (u8, u8)) {
    fn at(works: &mut Vec<ToolWork>, tool: u8) -> usize {
        if let Some(k) = works.iter().position(|w| w.tool == tool) {
            return k;
        }
        works.push(ToolWork {
            tool,
            ..ToolWork::default()
        });
        works.len() - 1
    }
    if !sp.support.is_empty() {
        let k = at(works, base);
        if let Some(w) = works.get_mut(k) {
            w.support = sp.support;
            w.support_flow = flow;
        }
    }
    if !sp.interface.is_empty() || !sp.ironing.is_empty() {
        let k = at(works, iface);
        if let Some(w) = works.get_mut(k) {
            w.support_interface = sp.interface;
            w.support_ironing = sp.ironing;
            w.support_flow = flow;
        }
    }
}

/// Tool changes and purge filament, grams, the filament plan `order` (filaments per layer, in print
/// order) asks for.
fn plan_changes(config: &PrintConfig, tools: u8, order: &[Vec<u8>]) -> (u32, f64) {
    let mut cur: Option<u8> = None;
    let (mut n, mut g) = (0u32, 0.0f64);
    for &t in order.iter().flatten() {
        if let Some(c) = cur
            && c != t
        {
            n += 1;
            g += crate::tower::change_waste(config, tools, c, t) * config.density(t) / 1000.0;
        }
        cur = Some(t);
    }
    (n, g)
}

/// sleipnir on a multi-color plate (`layerTopsMm`). A thin layer that prints more than
/// one filament repeats that layer's tool changes and purges, so wherever a fixed layer of
/// `layer_height` prints two or more filaments the plan keeps the fixed layers, and it varies the
/// layer height only where each layer prints one filament. Returns the plan to slice and what it
/// still costs against fixed layers (`None` with fixed layers or one filament).
fn keep_color_bands(
    config: &PrintConfig,
    plan: LayerPlan,
    raw: &[RawPart],
    max_z: f64,
) -> Result<(LayerPlan, Option<crate::output::VaryLayerCost>)> {
    let mut slots: Vec<u8> = raw
        .iter()
        .flat_map(|r| std::iter::once(r.0).chain(r.3.iter().map(|f| f.1)))
        .collect();
    slots.sort_unstable();
    slots.dedup();
    if !plan.custom || slots.len() < 2 {
        return Ok((plan, None));
    }
    let tools = slots.last().copied().unwrap_or(1);
    let first_h = if crate::raft::layers_asked(config) > 0 {
        config.layer_height
    } else {
        config.initial_layer_print_height
    };
    let fixed = LayerPlan::new(max_z, first_h, config.layer_height);
    let (top_shell, bottom_shell) = config.shell_layers(config.layer_height.max(0.01));
    let shells = (top_shell as usize, bottom_shell as usize);
    let order_of = |p: &LayerPlan| {
        let parts: Vec<PreparedPart> = raw
            .iter()
            .map(|(s, v, t, paint)| PreparedPart::new(*s, v.clone(), t.clone(), p).with_paint(paint.clone()))
            .collect();
        plan_tools(
            &parts,
            p,
            &slots,
            shells,
            &[],
            false,
            &[],
            &crate::toolorder::Choice::of(config, tools),
        )
        .0
    };
    let fixed_order = order_of(&fixed);
    let (fixed_n, fixed_g) = plan_changes(config, tools, &fixed_order);
    let cost = |order: &[Vec<u8>]| {
        let (n, g) = plan_changes(config, tools, order);
        crate::output::VaryLayerCost {
            extra_tool_changes: i64::from(n) - i64::from(fixed_n),
            extra_purge_g: g - fixed_g,
        }
    };
    let span = |p: &LayerPlan, l: usize| {
        let l = u32::try_from(l).unwrap_or(u32::MAX);
        (p.top(l) - p.thickness(l), p.top(l))
    };
    // Fixed layers kept as they are: those printing two or more filaments, to start with.
    let mut keep: Vec<bool> = fixed_order.iter().map(|o| o.len() > 1).collect();
    let first_order = order_of(&plan);
    if !keep.iter().any(|&k| k) && !first_order.iter().any(|o| o.len() > 1) {
        let c = cost(&first_order);
        return Ok((plan, Some(c)));
    }
    // The thinnest and thickest layers sleipnir asked for: a varied layer stays at least the
    // thinnest away from a band edge, and a gap left wider than the thickest is split evenly.
    let asked: Vec<f64> = (1..plan.count()).map(|l| plan.thickness(l)).collect();
    let min_h = asked
        .iter()
        .copied()
        .fold(f64::MAX, f64::min)
        .clamp(0.04, config.layer_height.max(0.04));
    let max_h = asked.iter().copied().fold(0.0, f64::max).max(config.layer_height);
    let wanted: Vec<f64> = (0..plan.count()).map(|l| plan.top(l)).collect();
    let last_wanted = wanted.last().copied().unwrap_or(max_z);
    let mut out: Option<(LayerPlan, Vec<Vec<u8>>)> = None;
    for _ in 0..8 {
        // Bands of consecutive kept fixed layers, bottom and top in mm.
        let mut bands: Vec<(f64, f64)> = Vec::new();
        for (l, _) in keep.iter().enumerate().filter(|(_, k)| **k) {
            let (b, t) = span(&fixed, l);
            match bands.last_mut() {
                Some(last) if (last.1 - b).abs() < 1e-6 => last.1 = t,
                _ => bands.push((b, t)),
            }
        }
        let mut tops: Vec<f64> = wanted
            .iter()
            .copied()
            .filter(|&z| {
                bands
                    .iter()
                    .all(|&(lo, hi)| z <= lo - min_h + 1e-9 || z >= hi + min_h - 1e-9)
            })
            .collect();
        for &(lo, hi) in &bands {
            if lo > 1e-6 {
                tops.push(lo);
            }
            tops.extend(
                (0..fixed.count())
                    .map(|l| fixed.top(l))
                    .filter(|&z| z > lo + 1e-6 && z <= hi + 1e-6),
            );
        }
        tops.sort_by(f64::total_cmp);
        tops.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        match tops.last().copied() {
            Some(t) if t < last_wanted - 1e-6 => {
                if last_wanted - t < min_h {
                    tops.pop();
                }
                tops.push(last_wanted);
            }
            None => tops.push(last_wanted),
            _ => {}
        }
        // Split gaps wider than the thickest asked layer (next to a band edge) evenly.
        let mut even: Vec<f64> = Vec::with_capacity(tops.len());
        let mut prev = 0.0f64;
        for &t in &tops {
            let gap = t - prev;
            let pieces = if prev > 0.0 {
                (gap / max_h - 1e-9).ceil().max(1.0)
            } else {
                1.0
            };
            let mut k = 1.0;
            while k < pieces {
                even.push(prev + gap * k / pieces);
                k += 1.0;
            }
            even.push(t);
            prev = t;
        }
        let next = LayerPlan::from_tops(max_z, &even, 0.04, 0.8)?;
        let next_order = order_of(&next);
        // A varied layer that still prints two filaments (across a color boundary between fixed
        // layers) keeps the fixed layers it overlaps too.
        let inside = |b: f64, t: f64| bands.iter().any(|&(lo, hi)| b >= lo - 1e-6 && t <= hi + 1e-6);
        let mut grew = false;
        for (l, o) in next_order.iter().enumerate() {
            let (b, t) = span(&next, l);
            if o.len() < 2 || inside(b, t) {
                continue;
            }
            for (f, k) in keep.iter_mut().enumerate() {
                let (fb, ft) = span(&fixed, f);
                if !*k && ft > b + 1e-6 && fb < t - 1e-6 {
                    *k = true;
                    grew = true;
                }
            }
        }
        out = Some((next, next_order));
        if !grew {
            break;
        }
    }
    let (p, o) = out.unwrap_or((plan, first_order));
    let c = cost(&o);
    Ok((p, Some(c)))
}

#[allow(
    clippy::too_many_arguments,
    reason = "the plate, its layers and the ways the order is chosen"
)]
fn plan_tools(
    parts: &[PreparedPart],
    plan: &LayerPlan,
    slots: &[u8],
    shells: (usize, usize),
    extra: &[Vec<u8>],
    only_extra: bool,
    first: &[u8],
    choice: &crate::toolorder::Choice,
) -> (Vec<Vec<u8>>, Option<u32>, Option<u32>) {
    let n = plan.count() as usize;
    if slots.len() < 2 {
        return (vec![Vec::new(); n], None, None);
    }
    // (slot, first layer, last layer) each covers.
    let mut spans: Vec<(u8, usize, usize)> = Vec::new();
    let layers_of = |lo: f64, hi: f64| -> Option<(usize, usize)> {
        let a = plan.first_at_or_above(lo);
        let b = plan.first_at_or_above(hi);
        (b > a).then(|| (a, b - 1))
    };
    for p in parts {
        let (lo, hi) = p
            .verts
            .iter()
            .fold((f64::MAX, f64::MIN), |(l, h), v| (l.min(v[2]), h.max(v[2])));
        if let Some((a, b)) = layers_of(lo, hi) {
            spans.push((p.slot, a, b));
        }
        for (tri, state) in &p.paint {
            let zs = tri.map(|v| v[2]);
            let (flo, fhi) = (zs[0].min(zs[1]).min(zs[2]), zs[0].max(zs[1]).max(zs[2]));
            if fhi - flo < 1e-6 {
                // A flat face colors the shell layers next to it.
                let up = tri_normal_z(tri) > 0.0;
                let first = plan.first_at_or_above(flo);
                if up {
                    let top = first.saturating_sub(1);
                    spans.push((*state, top.saturating_sub(shells.0.saturating_sub(1)), top));
                } else {
                    spans.push((*state, first, first + shells.1.saturating_sub(1)));
                }
            } else {
                // A painted wall shows no paint on the layer that is the part's own top or bottom.
                let h = plan.thickness(0);
                let lo_eff = if flo <= lo + 1e-6 { flo + h } else { flo };
                let hi_eff = if fhi >= hi - 1e-6 { fhi - h } else { fhi };
                if let Some((a, b)) = layers_of(lo_eff, hi_eff) {
                    spans.push((*state, a, b));
                }
            }
        }
    }
    let present = |l: usize| -> Vec<u8> {
        let mut v: Vec<u8> = spans
            .iter()
            .filter(|(_, a, b)| !only_extra && *a <= l && l <= *b)
            .map(|s| s.0)
            .chain(extra.get(l).into_iter().flatten().copied())
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    };
    let mut orders: Vec<Vec<u8>> = Vec::with_capacity(n);
    // The last layer with a change between layers or inside one, and the last with one inside.
    let (mut cur, mut top, mut top_within) = (0u8, None, None);
    // With a filament map, the filament each extruder printed last.
    let mut last: Vec<u8> = Vec::new();
    for l in 0..n {
        let here = present(l);
        if here.is_empty() {
            orders.push(Vec::new());
            continue;
        }
        let next = present(l + 1);
        let start = if here.contains(&cur) {
            cur
        } else {
            here.first().copied().unwrap_or(0)
        };
        let mut rest: Vec<u8> = here.iter().copied().filter(|t| *t != start).collect();
        if let Some(k) = rest.iter().rposition(|t| next.contains(t)) {
            let last = rest.remove(k);
            rest.push(last);
        }
        let mut order = vec![start];
        order.extend(rest);
        if l == 0 && !first.is_empty() {
            // The first layer starts with its outer wall filaments in the given order, then the rest.
            let mut ordered: Vec<u8> = first.iter().copied().filter(|t| here.contains(t)).collect();
            ordered.extend(here.iter().copied().filter(|t| !first.contains(t)));
            order = ordered;
        }
        // The profile's sequences, or the order with the least flush (toolorder.rs).
        if l == 0 {
            order = choice.first_layer(order);
        } else if let Some(o) = choice.order(l, &here, &next, cur, &last) {
            order = o;
        }
        if choice.grouped() {
            for &t in &order {
                let e = choice.extruder_of(t);
                if last.len() <= e {
                    last.resize(e + 1, 0);
                }
                if let Some(x) = last.get_mut(e) {
                    *x = t;
                }
            }
        }
        if order.len() > 1 {
            top_within = u32::try_from(l).ok();
        }
        if order.len() > 1 || (cur != 0 && order.first().copied().unwrap_or(start) != cur) {
            top = u32::try_from(l).ok();
        }
        cur = order.last().copied().unwrap_or(cur);
        orders.push(order);
    }
    (orders, top, top_within)
}

fn tri_normal_z(t: &[[f64; 3]; 3]) -> f64 {
    (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])
}

/// Volume of the sparse infill a tool prints on a layer, mm3.
fn work_infill_volume(work: &paths::ToolWork, width: f64, height: f64) -> f64 {
    let len = |a: crate::geom::Point, b: crate::geom::Point| a.dist_mm(b);
    let lines: f64 = work.sparse.iter().map(|[a, b]| len(*a, *b)).sum();
    let paths: f64 = work
        .sparse_paths
        .iter()
        .map(|p| {
            p.iter()
                .zip(p.iter().skip(1))
                .map(|(a, b)| len(*a, *b))
                .sum::<f64>()
        })
        .sum();
    (lines + paths) * crate::gcode::bead_area(width, height)
}

/// Volume of the solid infill (bottom, shell, top, bridges) a tool prints on a layer, mm3.
fn work_solid_volume(work: &paths::ToolWork, width: f64, height: f64) -> f64 {
    let len: f64 = [
        &work.bottom,
        &work.shell,
        &work.top,
        &work.bridge,
        &work.internal_bridge,
    ]
    .iter()
    .flat_map(|v| v.iter())
    .map(|[a, b]| a.dist_mm(*b))
    .sum();
    len * crate::gcode::bead_area(width, height)
}

/// Volume of the support a tool prints on a layer, mm3.
fn work_support_volume(work: &paths::ToolWork, width: f64, height: f64) -> f64 {
    let len: f64 = work
        .support
        .iter()
        .chain(work.support_interface.iter())
        .map(|p| {
            p.iter()
                .zip(p.iter().skip(1))
                .map(|(a, b)| a.dist_mm(*b))
                .sum::<f64>()
        })
        .sum();
    len * crate::gcode::bead_area(width, height)
}

/// The part of a triangle between two heights, as a polygon in the plane (Sutherland-Hodgman).
fn clip_to_slab(tri: &[[f64; 3]; 3], lo: f64, hi: f64) -> Vec<[f64; 2]> {
    let mut poly: Vec<[f64; 3]> = tri.to_vec();
    for (keep_above, limit) in [(true, lo), (false, hi)] {
        let inside = |p: &[f64; 3]| if keep_above { p[2] >= limit } else { p[2] <= limit };
        let mut next: Vec<[f64; 3]> = Vec::new();
        for k in 0..poly.len() {
            let (Some(p), Some(q)) = (poly.get(k), poly.get((k + 1) % poly.len())) else {
                continue;
            };
            let (pi, qi) = (inside(p), inside(q));
            if pi {
                next.push(*p);
            }
            if pi != qi {
                let t = (limit - p[2]) / (q[2] - p[2]);
                next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, limit]);
            }
        }
        poly = next;
    }
    poly.iter().map(|p| [p[0], p[1]]).collect()
}

/// Area of shapes in square internal units: outlines add, holes subtract.
fn shapes_area(shapes: &Shapes) -> f64 {
    let ring = |r: &[IntPoint<i32>]| -> f64 {
        let next = r.iter().cycle().skip(1);
        r.iter()
            .zip(next)
            .map(|(a, b)| f64::from(a.x) * f64::from(b.y) - f64::from(b.x) * f64::from(a.y))
            .sum::<f64>()
            / 2.0
    };
    shapes
        .iter()
        .flat_map(|s| s.iter().enumerate())
        .map(|(i, r)| if i == 0 { ring(r).abs() } else { -ring(r).abs() })
        .sum()
}

/// The plate's settings with one object's overrides on top.
/// An object's turn about Z from its transform, degrees (Orca: `atan2(m(1, 0), m(0, 0))` of the object's
/// transform).
fn z_turn(o: &crate::plate::PlateObject) -> f64 {
    let t = &o.transform;
    f64::from(t[1]).m_atan2(f64::from(t[0])).to_degrees()
}

fn object_config(base: &PrintConfig, over: &serde_json::Value) -> Result<PrintConfig> {
    let mut c = base.clone();
    if !over.is_null() {
        c.apply_value(over)?;
        c.check()?;
        crate::preflight::hold_temperatures(&mut c);
    }
    Ok(c)
}

fn resolve_ranges(
    plan: &LayerPlan,
    base: &PrintConfig,
    ranges: &[HeightRange],
    warnings: &mut Vec<SliceWarning>,
) -> Result<(Vec<serde_json::Value>, Vec<u16>)> {
    let bad = |reason: String| Error::Config {
        key: "options.heightRanges",
        reason,
    };
    let mut unsupported: Vec<String> = Vec::new();
    for (i, r) in ranges.iter().enumerate() {
        if !(r.z_from_mm.is_finite() && r.z_to_mm.is_finite() && r.z_from_mm < r.z_to_mm) {
            return Err(bad(format!("range {i} needs zFromMm below zToMm")));
        }
        let serde_json::Value::Object(map) = &r.settings else {
            return Err(bad(format!("range {i}: settings must be an object")));
        };
        for k in map.keys() {
            if READ_KEYS.contains(&k.as_str()) {
                if !RANGE_KEYS.contains(&k.as_str()) {
                    return Err(bad(format!(
                        "range {i}: {k} cannot change by height (allowed: {})",
                        RANGE_KEYS.join(", ")
                    )));
                }
            } else if !unsupported.contains(k) {
                unsupported.push(k.clone());
            }
        }
    }
    for k in unsupported {
        warnings.push(SliceWarning {
            code: WarningCode::UnsupportedSetting,
            message: format!("{k} is not applied by this engine (height range)"),
            layer: None,
        });
    }
    let mut objects: Vec<serde_json::Value> = Vec::new();
    let mut layer_cfg = vec![0u16; plan.slice_z.len()];
    for (l, slot) in layer_cfg.iter_mut().enumerate() {
        let z = plan.slice_z.get(l).copied().unwrap_or(0.0);
        let mut merged = serde_json::Map::new();
        for r in ranges.iter().filter(|r| r.z_from_mm <= z && z < r.z_to_mm) {
            if let serde_json::Value::Object(m) = &r.settings {
                for (k, v) in m {
                    if READ_KEYS.contains(&k.as_str()) {
                        merged.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        if merged.is_empty() {
            continue;
        }
        let value = serde_json::Value::Object(merged);
        let idx = if let Some(i) = objects.iter().position(|o| *o == value) {
            i
        } else {
            // Fail here, not mid-slice, when the values do not fit the settings.
            let mut c = base.clone();
            c.apply_value(&value)?;
            c.check()?;
            // The configs the layers print with are held to the machine's limits as they are built;
            // here a range that asks for more is reported once, or refused when it cannot be used.
            let issues = crate::preflight::hold_temperatures(&mut c);
            if crate::preflight::blocks(&issues) {
                return Err(Error::Blocked(crate::preflight::blocking_text(&issues)));
            }
            warnings.extend(issues.into_iter().map(|i| SliceWarning {
                code: WarningCode::SafetyLimit,
                message: format!("height range: {}", i.message),
                layer: None,
            }));
            objects.push(value);
            objects.len() - 1
        };
        *slot = u16::try_from(idx + 1).map_err(|_| bad("more than 65,000 distinct settings".to_owned()))?;
    }
    Ok((objects, layer_cfg))
}

/// Objects that are copies of an earlier one: the same mesh, filaments and turn, moved only across the bed, with
/// nothing of their own (settings, part settings, volumes, paint, brim ears). Per object, the object it copies
/// (itself for the first) and how far it moves, mm; None when there are no copies or the plate's settings span
/// objects in a way copies cannot follow (supports, skirt, draft shield, raft, spiral vase, object list order,
/// a prime tower kept for every layer).
fn copies_of(objects: &[&crate::plate::PlateObject], config: &PrintConfig) -> Option<Vec<(usize, [f64; 2])>> {
    let text = |k: &str| match config.raw.get(k) {
        Some(serde_json::Value::String(t)) => t.as_str(),
        _ => "",
    };
    if config.enable_support
        || config.skirt_loops > 0
        || text("draft_shield") == "enabled"
        || text("print_order") == "as_obj_list"
        || crate::raft::layers_asked(config) > 0
        || crate::spiral::enabled(config)
        || crate::tower::flag(config, "prime_tower_always")
    {
        return None;
    }
    let plain = |o: &crate::plate::PlateObject| {
        o.settings.is_null()
            && o.part_settings.is_empty()
            && o.volumes.is_empty()
            && o.brim_points.is_empty()
            && o.mesh.parts.iter().all(|p| {
                p.paint.is_empty()
                    && p.support_paint.is_empty()
                    && p.seam_paint.is_empty()
                    && p.fuzzy_paint.is_empty()
            })
    };
    let same = |a: &crate::plate::PlateObject, b: &crate::plate::PlateObject| {
        let (ta, tb) = (&a.transform, &b.transform);
        // The turn and scale (the first three columns) and the height and last row agree; only x and y move.
        ta.get(..12) == tb.get(..12)
            && ta.get(14..) == tb.get(14..)
            && a.slot_overrides == b.slot_overrides
            && (std::sync::Arc::ptr_eq(&a.mesh, &b.mesh)
                || (a.mesh.parts.len() == b.mesh.parts.len()
                    && a.mesh.parts.iter().zip(&b.mesh.parts).all(|(p, q)| {
                        p.name == q.name
                            && p.slot == q.slot
                            && p.positions == q.positions
                            && p.triangles == q.triangles
                    })))
    };
    let mut placed: Vec<(usize, [f64; 2])> = Vec::with_capacity(objects.len());
    for (i, o) in objects.iter().enumerate() {
        let of = if plain(o) {
            (0..i).find(|&k| {
                placed.get(k).is_some_and(|c| c.0 == k)
                    && objects.get(k).is_some_and(|p| plain(p) && same(p, o))
            })
        } else {
            None
        };
        let off = |k: usize| {
            let (a, b) = (
                objects.get(k).map_or(&o.transform, |p| &p.transform),
                &o.transform,
            );
            [
                f64::from(b[12]) - f64::from(a[12]),
                f64::from(b[13]) - f64::from(a[13]),
            ]
        };
        placed.push(of.map_or((i, [0.0, 0.0]), |k| (k, off(k))));
    }
    placed.iter().enumerate().any(|(i, c)| c.0 != i).then_some(placed)
}

/// Merges bit-identical vertices and applies the object transform.
fn weld(
    positions: &[[f32; 3]],
    tris: &[[u32; 3]],
    f: impl Fn([f32; 3]) -> [f64; 3] + Sync,
) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let (unique, remap) = crate::mesh::dedupe(positions);
    let verts = par::map_fine(&unique, |p| f(*p));
    let tris = tris
        .iter()
        .filter_map(|t| {
            let m = [
                remap.get(t[0] as usize)?,
                remap.get(t[1] as usize)?,
                remap.get(t[2] as usize)?,
            ];
            let m = [*m[0], *m[1], *m[2]];
            (m[0] != m[1] && m[1] != m[2] && m[0] != m[2]).then_some(m)
        })
        .collect();
    (verts, tris)
}

/// `shapes` moved by (`dx`, `dy`) units.
fn translate_shapes(shapes: &Shapes, dx: i32, dy: i32) -> Shapes {
    shapes
        .iter()
        .map(|shape| {
            shape
                .iter()
                .map(|ring| ring.iter().map(|p| IntPoint::new(p.x + dx, p.y + dy)).collect())
                .collect()
        })
        .collect()
}

/// Orca's `FillRectilinear` sweep over `area` for lines along `d` at `density`: lines joined end to end along the
/// walls. The lines end at the area pulled in by 0.05 spacing, the turns follow it pulled in by half a spacing, and
/// a line that never reaches the inner contour is dropped (`ExPolygonWithOffset`, `traverse_graph_generate_polylines`).
/// `consistent` is the pattern that keeps its place from layer to layer (zigzag, cross zag, locked zag: paths start
/// from the bottom of a line with an even index and from the top of the others, and turns only go to the next
/// line). `shift_mm` moves the lattice sideways (`horiz_move`): the area is moved the other way and the lines back,
/// which puts the lines of the shared lattice where Orca's shifted ones are.
#[allow(clippy::too_many_arguments, reason = "the pieces of one sweep")]
/// Where a template angle (degrees, the direction of the lines) puts the scanlines: on one of their two
/// directions when it is one, else on 45 degrees with the area turned by the returned angle (radians).
/// Layers whose sparse infill prints once for several (`infill_combination`).
#[derive(Debug, Clone, Default)]
struct Combine {
    groups: Vec<CombineGroup>,
    /// The group of each object layer.
    layer: Vec<Option<usize>>,
}

#[derive(Debug, Clone)]
struct CombineGroup {
    /// The layer that prints the group's infill.
    top: u32,
    /// The group's height, mm.
    height: f64,
    /// The sparse area every layer of the group shares, and the same grown by the clearance that the
    /// group's layers leave out of their own sparse infill.
    shared: Shapes,
    grown: Shapes,
}

/// The frame of a scanline fill: the template's angle when there is one, else the layer's own direction, plus
/// the model's turn; `None` when neither applies (the plain scanlines).
fn turned_frame(template: Option<f64>, own: Dir, model_turn: f64) -> Option<(Dir, f64)> {
    match template {
        Some(a) => Some(template_frame(a + model_turn)),
        None if model_turn != 0.0 => Some(template_frame(
            if own == Dir::D45 { 45.0 } else { 135.0 } + model_turn,
        )),
        None => None,
    }
}

fn template_frame(deg: f64) -> (Dir, f64) {
    let a = deg.rem_euclid(180.0);
    if (a - 45.0).abs() < 1e-9 {
        (Dir::D45, 0.0)
    } else if (a - 135.0).abs() < 1e-9 {
        (Dir::D135, 0.0)
    } else {
        (Dir::D45, (a - 45.0).to_radians())
    }
}

fn zig_lines(
    events: &mut Vec<(i32, i64)>,
    area: &Shapes,
    d: Dir,
    spacing_mm: f64,
    density: f64,
    shift_mm: f64,
    consistent: bool,
) -> Vec<Vec<crate::geom::Point>> {
    if area.is_empty() || density <= 0.0 {
        return Vec::new();
    }
    // The way Orca's x axis points, perpendicular to the lines.
    let across = if d == Dir::D45 { (-1.0, 1.0) } else { (-1.0, -1.0) };
    let unit = std::f64::consts::FRAC_1_SQRT_2 * crate::geom::SCALE;
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a shift of a few mm in internal units"
    )]
    let (sx, sy) = (
        (across.0 * shift_mm * unit).round() as i32,
        (across.1 * shift_mm * unit).round() as i32,
    );
    let area = translate_shapes(area, -sx, -sy);
    let inner_area = perimeters::offset(&area, -mm(0.5 * spacing_mm));
    let outer_area = perimeters::offset(&area, -mm(0.05 * spacing_mm));
    let family = crate::infill::Family {
        dir: d,
        spacing: paths::t_units((spacing_mm / density).min(1000.0)),
    };
    let spans_in = crate::monotonic::orca_spans(
        &family.scan(
            inner_area.iter().flat_map(|sh| sh.iter()).map(Vec::as_slice),
            events,
        ),
        d,
    );
    let spans_out = crate::monotonic::orca_spans(
        &family.scan(
            outer_area.iter().flat_map(|sh| sh.iter()).map(Vec::as_slice),
            events,
        ),
        d,
    );
    let edge = crate::edge::Edge::new(&inner_area);
    let links = crate::monotonic::Links {
        edge: Some(&edge),
        max: f64::MAX,
        chord_fallback: false,
    };
    let to_point = |k: i64, t: i64| crate::monotonic::orca_point(d, k, t);
    let mut lines = if consistent {
        // Cross zag shifts the lattice by whole lines too, which turns the parity of the line indices.
        #[allow(clippy::cast_possible_truncation, reason = "a handful of lines")]
        let gap = (shift_mm / (spacing_mm / density)).trunc() as i32;
        let odd = i32::from(gap.rem_euclid(2) != 0);
        crate::monotonic::zigzag_consistent(&spans_in, family.spacing, &spans_out, links, &to_point, &|k| {
            (k + odd).rem_euclid(2) == 0
        })
    } else {
        crate::monotonic::zigzag_with(&spans_in, family.spacing, &spans_out, links, &to_point)
    };
    if shift_mm != 0.0 {
        for l in &mut lines {
            for p in l.iter_mut() {
                *p = crate::geom::Point::new(p.x + sx, p.y + sy);
            }
        }
    }
    lines
}

#[cfg(test)]
mod tag_tests {
    use super::settings_tag;
    use crate::config::PrintConfig;

    #[test]
    fn the_first_layer_settings_have_a_tag_of_their_own() {
        let mut cfg = PrintConfig::default();
        cfg.feature_widths.initial_layer = Some(cfg.line_width + 0.08);
        let first = cfg.for_first_layer();
        // Only the typed widths differ: the profile values are the same.
        assert_eq!(first.raw, cfg.raw);
        assert_ne!(settings_tag(&first), settings_tag(&cfg));
        assert_eq!(settings_tag(&cfg.clone()), settings_tag(&cfg));
    }
}
