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

/// How far into [`Stage::Layers`] a slice is once the interlocking, conical and polyhole plans are done, once the
/// lightning plan is too, and once the seam plan is; the stage ends with the first contour. Before these, preparing
/// the session took the stage to `api::LAYERS_SESSION`.
pub(crate) const LAYERS_PLANS: f32 = 0.55;
/// See [`LAYERS_PLANS`].
pub(crate) const LAYERS_LATE_PLANS: f32 = 0.6;
/// See [`LAYERS_PLANS`].
pub(crate) const LAYERS_SEAM_PLAN: f32 = 0.8;

/// The warning for manual supports on a plate with no enforcers.
const NO_ENFORCERS: &str =
    "Manual supports print only where enforcers ask, and the plate has none, so none are printed";
/// Support enforcers on a plate with support turned off.
const ENFORCERS_UNUSED: &str = "Support enforcers are on the plate but support is off, so they print no support; turn on supports to use them";
/// Why support printed on the object's layers although the settings ask for layers of its own height.
const SUPPORT_ON_OBJECT_LAYERS: &str = "Support prints on the model's layers because this print uses a prime tower. That saves a filament change on every support layer.";

/// A plate's first object as its own session saw itself: bounds, footprints, object settings and interleave flag
/// ([`SliceSession::swap_own`]).
type OwnView = (
    [f64; 4],
    Vec<crate::output::ObjectFootprint>,
    Vec<serde_json::Value>,
    bool,
);

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
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent flags of one plate's session"
)]
pub struct SliceSession {
    /// Per-layer results that the layers around one layer share (`shells::Cache`).
    cache: crate::shells::Cache,
    /// The outlines of painted parts (`paint::Cache`).
    paint: crate::paint::Cache,
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
    /// Objects with painted parts: their parts (indexes into `parts`) and the paint of all of them. Color is cut
    /// on the union of an object's parts, so a face where two parts meet is no outline and carries no color.
    painted_objects: Vec<PaintedObject>,
    /// The objects printed after this one when the plate prints by object; each is a session of
    /// its own, so it has its own layers, supports and first layer.
    followers: Vec<SliceSession>,
    /// Per object of the sequence (this one first): its own setting overrides, when they differ.
    object_settings: Vec<serde_json::Value>,
    /// Objects print layer by layer (each layer holds every object's paths) instead of one after
    /// the other.
    interleave: bool,
    /// Objects printed layer by layer, each from a session of its own: the plate's tool order across them and the
    /// prime tower they share (`sequence.rs` prints them by it, over all their paths). Every object's session holds
    /// it, and leaves the tower out of its own layers.
    plate_tools: Option<std::sync::Arc<PlateTools>>,
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
    /// Spiral vase mode: where each base layer ends ([`Self::vase_exits`]).
    vase_exits: VaseExits,
    /// `interlocking_beam` settings, when the beams are on.
    interlock_params: Option<crate::interlock::Params>,
    interlock: std::sync::OnceLock<Option<crate::interlock::Layers>>,
    /// `make_overhang_printable`: the area each layer gains from the cone under the layers above it.
    conical: std::sync::OnceLock<Option<Vec<Shapes>>>,
    conical_params: Option<(f64, f64)>,
    /// `hole_to_polyhole`: per layer, the circular holes found and the polygons that replace them.
    polyholes: std::sync::OnceLock<Option<Vec<Vec<HoleSwap>>>>,
    /// Painted brim ears on the bed: the object of this session's own plate that carries each, and x, y, z in plate
    /// coordinates and the head radius, mm.
    brim_ears: Vec<(usize, [f64; 4])>,
    /// The hull of each object of this session's own plate, numbered as [`Self::brim_ears`] numbers them, to tell
    /// which object a first layer island belongs to; empty when no object carries painted ears.
    ear_hulls: Vec<Vec<[f64; 2]>>,
    /// Draft shield: the convex hull of the whole part, which the skirt follows on every layer.
    draft_hull: Option<Vec<IntPoint<i32>>>,
    /// `skirt_type` per object: the hull of each group of objects whose skirts would touch; empty otherwise.
    skirt_groups: Vec<Vec<IntPoint<i32>>>,
    /// `print_order` as object list: the hull of each object in the plate's list order, which the islands
    /// of a layer follow; empty for the default order.
    object_hulls: Vec<Vec<IntPoint<i32>>>,
    /// The plate object of each part in `parts`, as [`Self::footprints`] numbers them.
    part_object: Vec<u16>,
    /// Each object's own slice per layer, worked out on first use for the owners of the paths (`owners.rs`); only
    /// a session of more than one object reads it.
    object_slices: Vec<std::sync::OnceLock<std::sync::Arc<crate::owners::Slices>>>,
    /// The session of one object of a plate sliced object by object (`followers`): that object's index on the
    /// plate, which its paths are stamped with when the plate's layers are put together.
    plate_index: u16,
    /// The raft under the part: its layers come before the part's, which sit on top of it.
    raft: Option<crate::raft::Plan>,
    support: std::sync::OnceLock<Vec<crate::support::SupportLayer>>,
    /// Set while the support plan is worked out beside the layers (`slice_object_range_now`), when nothing
    /// else may ask for it.
    support_pending: Pending,
    /// Organic trees over a raft: the branches passing through each raft layer.
    organic_raft: std::sync::OnceLock<Vec<Shapes>>,
    /// Organic trees of the v2 engine: the areas by kind of each support layer, in the order of
    /// `support`.
    organic2: std::sync::OnceLock<Vec<std::sync::Arc<crate::organic2::Layer>>>,
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
    /// slice of the whole plate at build time (as Orca collects the filaments of a plate). Empty
    /// otherwise.
    used_tools: Vec<Vec<u8>>,
    /// The filaments of `used_tools` that each object layer prints without its support. With support
    /// on layers of its own, an object layer prints only the support of its own print layer, not the
    /// support `used_tools` counts on it.
    object_tools: Vec<Vec<u8>>,
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
    /// The support columns that stand on the raft (as Orca's raft base has them): the raft's
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
    /// Set by `shed`: what only slicing reads is gone, the collision model with it.
    shed_done: bool,
    /// The tower's rows before the saves of a type 2 tower (`tower::plan_rows_unsaved`), which the saves are
    /// measured on.
    tower_rows0: f64,
    /// A type 1 tower's wall filament, blocks and contact layers, planned on the first tower layer sliced (set up
    /// front for a plate whose objects print from sessions of their own).
    tower_plan: std::sync::OnceLock<crate::tower::TowerPlan>,
}

/// One plate object printed as a copy of an object of the sequence.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Instance {
    /// The object of the sequence whose paths it prints.
    pub(crate) sub: usize,
    /// How far the copy moves, internal units.
    pub(crate) shift: [i32; 2],
    /// The plate object it is.
    pub(crate) object: u16,
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
#[derive(Debug, Clone, PartialEq)]
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
                "{name} lies wholly outside the printable area; move it onto the bed or arrange the plate"
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
    /// Support and interface over a top surface of the part, printed as round beads (`SupportLayer::on_part`).
    round: Vec<Vec<crate::geom::Point>>,
    round_interface: Vec<Vec<crate::geom::Point>>,
    /// Ironing over the top contact (`support_ironing`).
    ironing: Vec<Vec<crate::geom::Point>>,
}

/// One loop around the top contact `contact`, kept to the stretch under the overhangs `hang`, with notches
/// around small hexagons placed every three of their radii along it (Orca's loop
/// interface, one contact loop). Returns the loop pieces and the area the interface fill keeps out of.
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
#[derive(Debug, Default, Clone)]
struct LayerRegions {
    /// `(slot, shapes)` in priority order, disjoint.
    regions: Vec<(u8, Shapes)>,
    /// Per region: 0 for the layer's settings, `k` for the `k`th modifier volume's.
    region_cfg: Vec<u16>,
    open_chains: usize,
    /// The first layer's outline before size compensation, for the brim.
    raw: Option<Shapes>,
    /// On the elephant foot layers, the outline before the foot compensation: what
    /// the layers next to it see.
    lslices: Option<Shapes>,
    /// The union of `regions`, worked out on first use: every region of this layer and its neighbors reads it.
    union: std::sync::OnceLock<Shapes>,
    /// What hangs past the layer below, for the auto lift ([`lift_overhangs`]).
    lift_hang: LiftHang,
}

/// One layer's overhang for the auto lift, worked out on first use: the layer's own lift and those of the
/// layers up to 0.4 mm above read it. It is kept with what it was worked out from, the growth and opening
/// and the layer below (by address, within the one list of layers), and a reader with other values works
/// it out again, so a stored one is always the one a new run would give. A copy starts empty, since its
/// layer below is another.
#[derive(Debug, Default)]
struct LiftHang(std::sync::OnceLock<((i32, i32, usize), Shapes)>);

impl Clone for LiftHang {
    fn clone(&self) -> Self {
        Self::default()
    }
}

/// The overhangs an auto lift spirals over, as Orca finds them for its lifts: per layer, what hangs more than 30 percent of a line past the layer below, opened
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
    let mut sets: Vec<std::borrow::Cow<'a, Shapes>> = Vec::new();
    let mut l = layer;
    while l >= 1 && plan.top(l) >= top - 0.4 - 1e-6 {
        if let (Some(here), Some(below)) = (get(l), get(l - 1)) {
            let hang = || {
                let held = crate::perimeters::offset(&lower_shapes(below), grow);
                let hang = crate::perimeters::difference(&lower_shapes(here), &held);
                crate::perimeters::offset(&crate::perimeters::offset(&hang, -open), open)
            };
            // Not `once`: a layer reading a neighbor's overhang while another thread works it out works it
            // out too rather than wait.
            let key = (grow, open, std::ptr::from_ref(below).addr());
            let hang = match here.lift_hang.0.get() {
                Some((k, stored)) if *k == key => std::borrow::Cow::Borrowed(stored),
                Some(_) => std::borrow::Cow::Owned(hang()),
                None => match here.lift_hang.0.set((key, hang())) {
                    Ok(()) => here.lift_hang.0.get().map_or_else(
                        || std::borrow::Cow::Owned(hang()),
                        |(_, s)| std::borrow::Cow::Borrowed(s),
                    ),
                    Err((_, own)) => std::borrow::Cow::Owned(own),
                },
            };
            if !hang.is_empty() {
                sets.push(hang);
            }
        }
        l -= 1;
    }
    let refs: Vec<&Shapes> = sets.iter().map(AsRef::as_ref).collect();
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
    /// Drops the specks and pinholes from the regions and the outlines beside them, and keeps the outline
    /// without the gaps between regions. The layers around read the outline: a pinhole in it would come back
    /// as a hole as wide as the walls in every inset of it.
    fn drop_specks(&mut self) {
        let mut cfg = std::mem::take(&mut self.region_cfg).into_iter();
        let mut kept: Vec<(u8, Shapes)> = Vec::with_capacity(self.regions.len());
        for (slot, s) in std::mem::take(&mut self.regions) {
            let c = cfg.next().unwrap_or(0);
            let s = perimeters::union_min_area(&[&s], crate::paint::SPECK);
            if !s.is_empty() {
                kept.push((slot, s));
                self.region_cfg.push(c);
            }
        }
        self.regions = kept;
        for s in [&mut self.raw, &mut self.lslices].into_iter().flatten() {
            *s = perimeters::union_min_area(&[s], crate::paint::SPECK);
        }
        let all: Vec<&Shapes> = self.regions.iter().map(|(_, s)| s).collect();
        self.union = std::sync::OnceLock::from(perimeters::union_min_area(&all, crate::paint::SPECK));
    }

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
    bridges: AtomicU64,
    seams: AtomicU64,
}

thread_local! {
    /// The microseconds the stage timers on this thread counted since the innermost [`OwnTimer`] started.
    static COUNTED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

impl Micros {
    fn add(counter: &AtomicU64, t: &Timer) {
        let us = t.micros();
        counter.fetch_add(us, Ordering::Relaxed);
        COUNTED.with(|c| c.set(c.get() + us));
    }
}

/// A stage timer for work that can run other timed stages inside it (the regions or walls of a layer it
/// reads, or a layer job the thread picks up while it waits for its parallel work): it counts its time less
/// what the stage timers on its thread counted meanwhile, so no time is counted twice.
struct OwnTimer {
    t: Timer,
    outer: u64,
}

impl OwnTimer {
    fn start() -> Self {
        Self {
            outer: COUNTED.with(|c| c.replace(0)),
            t: Timer::start(),
        }
    }

    fn stop(self, counter: &AtomicU64) {
        let us = self.t.micros();
        let inner = COUNTED.with(|c| c.replace(self.outer + us));
        counter.fetch_add(us.saturating_sub(inner), Ordering::Relaxed);
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

/// Spiral vase mode: where each solid base layer ends, for the settings tag of the config they were planned with;
/// a copy of a session starts without them.
#[derive(Debug, Default)]
struct VaseExits(std::sync::Mutex<Option<(u64, BaseExits)>>);

/// Where each solid base layer of a spiral vase ends, by layer.
type BaseExits = std::sync::Arc<Vec<Option<crate::geom::Point>>>;

impl Clone for VaseExits {
    fn clone(&self) -> Self {
        Self::default()
    }
}

/// An object with painted parts: its parts, as indexes into the session's parts (their paint stays with them).
#[derive(Debug, Clone)]
struct PaintedObject {
    parts: Vec<usize>,
}

impl PaintedObject {
    /// The objects among `parts` (`object` gives each part's) that have any painted part.
    fn of(parts: &[PreparedPart], object: &[usize]) -> Vec<Self> {
        let mut out: Vec<(usize, Self, bool)> = Vec::new();
        for (k, p) in parts.iter().enumerate() {
            let Some(&o) = object.get(k) else { continue };
            match out.iter_mut().find(|(id, _, _)| *id == o) {
                Some((_, obj, painted)) => {
                    obj.parts.push(k);
                    *painted |= !p.paint.is_empty();
                }
                None => out.push((o, Self { parts: vec![k] }, !p.paint.is_empty())),
            }
        }
        out.into_iter()
            .filter(|(_, _, painted)| *painted)
            .map(|(_, obj, _)| obj)
            .collect()
    }
}

/// Scanline families for one layer.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Families {
    sparse_spacing: i64,
    solid_spacing: i64,
    /// How many layers a painted top or bottom colors, the surface layer included (`top_color_penetration_layers`
    /// and `bottom_color_penetration_layers`, else the top and bottom shell layers), and how deep unpainted ones keep
    /// the walls' paint off.
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
    /// Painted tops and bottoms: how much farther in they reach on each shell layer beyond them, and the
    /// narrowest piece kept (`paint::LayerPaint`), internal units.
    paint_step: i32,
    paint_small: i32,
}

/// What a layer's regions depend on, see [`Families::cut`].
type RegionCut = (
    i64,
    perimeters::Slicing,
    i32,
    usize,
    usize,
    (i32, i32),
    (i32, i32),
);

impl Families {
    /// What the regions of a layer depend on: the contour resolution, slicing mode and closing radius, the shell
    /// layers and the painted band. The scanline spacings are not read there.
    fn cut(&self) -> RegionCut {
        (
            self.resolution,
            self.slicing,
            self.closing,
            self.top_shell,
            self.bottom_shell,
            self.paint_band,
            (self.paint_step, self.paint_small),
        )
    }

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
        // A file's penetration counts as it carries them (at least 1); without them, the shell layers.
        let penetration = |key: &str, shell: u32| -> usize {
            let n = cfg.raw_number(key, -1.0);
            if n.is_finite() && n >= 1.0 {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a layer count, clamped"
                )]
                {
                    n.round().min(1000.0) as usize
                }
            } else {
                shell as usize
            }
        };
        Self {
            sparse_spacing: paths::t_units(sparse_mm),
            solid_spacing: paths::t_units(cfg.spacing_for(cfg.solid_infill_width())),
            top_shell: penetration("top_color_penetration_layers", top),
            bottom_shell: penetration("bottom_color_penetration_layers", bottom),
            // Extrusion rate smoothing turns arc fitting off, so walls keep the plain resolution then.
            // As OrcaSlicer simplifies wall outlines: the profile's `resolution`, a fifth of it
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
            // The outer wall's spacing plus its width a layer, and pieces narrower than half the outer wall
            // width go; the profile's widths, so the first layer cuts the same colors.
            paint_step: {
                let w = cfg.profile_outer_wall_width();
                mm(cfg.spacing_for(w) + w)
            },
            paint_small: mm(0.25 * cfg.profile_outer_wall_width()),
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
        Self::with_plan(plate, config, tops, ranges, true)
    }

    /// [`Self::with_options`], where `by_ranges` false keeps `layer_height` when no tops are given. A request that
    /// turns sleipnir on and gets no plan from it slices that way, as the app does, which plans by ranges only with
    /// sleipnir off.
    pub(crate) fn with_plan(
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        ranges: &[HeightRange],
        by_ranges: bool,
    ) -> Result<Self> {
        use crate::layers::RangeTops;
        // A range's layer height plans the layers below; the rest of its settings change by height.
        let (own, asked) = crate::layers::without_layer_heights(plate, ranges)?;
        // Without tops of the caller's (a request's own, or sleipnir's when its config turns `smart_layer` on), a
        // project's layer height ranges (`Mesh::layer_heights`, and the `layer_height` of the request's ranges, which
        // is how the app sends them) plan the layers.
        let planned = tops.is_none() && by_ranges;
        let by_range = if planned {
            crate::layers::plate_range_tops(
                plate,
                ranges,
                config.initial_layer_print_height,
                config.layer_height,
            )
        } else {
            RangeTops::None
        };
        let tops = match &by_range {
            RangeTops::Tops(t) => Some(t.as_slice()),
            _ => tops,
        };
        let mut session = par::slice(|| Self::build(plate, config, tops, &own))?;
        if asked && !planned {
            session.push_warning(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: crate::layers::RANGE_LAYER_HEIGHT_UNUSED.to_owned(),
                layer: None,
            });
        }
        if by_range == RangeTops::Differ {
            session.push_warning(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: crate::layers::LAYER_HEIGHTS_DIFFER.to_owned(),
                layer: None,
            });
        }
        Ok(session)
    }

    /// [`Self::with_options`]: the filament map first (on a printer with two extruders fed by their own
    /// AMS), then the plate sliced with the settings that carry it.
    fn build(
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        ranges: &[HeightRange],
    ) -> Result<Self> {
        // The settings by height a project file gives an object (`Mesh::height_ranges`) are that object's, ahead
        // of the caller's own ranges, so the caller's win where they overlap.
        let with_file: Vec<HeightRange>;
        let ranges = if plate.objects.iter().any(|o| !o.mesh.height_ranges.is_empty()) {
            with_file = plate
                .objects
                .iter()
                .flat_map(|o| {
                    o.mesh.height_ranges.iter().map(|r| HeightRange {
                        objects: vec![o.id.clone()],
                        ..r.clone()
                    })
                })
                .chain(ranges.iter().cloned())
                .collect();
            &with_file
        } else {
            ranges
        };
        // Older names of the per-feature filament keys in the plate's own settings read as ours (`crate::legacy`).
        let renamed_plate = crate::legacy::plate_with_current_names(plate);
        let plate = renamed_plate.as_ref().unwrap_or(plate);
        let renamed_ranges: Option<Vec<HeightRange>> = ranges
            .iter()
            .any(|r| crate::legacy::value_with_current_names(&r.settings).is_some())
            .then(|| {
                ranges
                    .iter()
                    .map(|r| HeightRange {
                        settings: crate::legacy::value_with_current_names(&r.settings)
                            .unwrap_or_else(|| r.settings.clone()),
                        ..r.clone()
                    })
                    .collect()
            });
        let ranges = renamed_ranges.as_deref().unwrap_or(ranges);
        check_extent(plate)?;
        let map = if crate::nozzles::shared(config) {
            let usage = crate::nozzles::Usage::of_plate(plate, config, ranges);
            // Every filament of the project, not only up to the highest the plate prints with: Bambu Studio lists
            // the unused ones too, on the left extruder.
            let tools = usage
                .layers
                .iter()
                .flatten()
                .copied()
                .max()
                .unwrap_or(1)
                .max(crate::nozzles::project_filaments(config));
            crate::nozzles::Map::resolve(config, tools, &usage)
        } else {
            None
        };
        let Some(map) = map else {
            return Self::build_plate(plate, config, tops, ranges);
        };
        let mut mapped = map.apply(config);
        let _ = mapped.refresh_variants()?;
        let mut session = Self::build_plate(plate, &mapped, tops, ranges)?;
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
    fn skirt_tool_at(&self, cfg: &PrintConfig, works: &[ToolWork], loops: &[paths::SkirtPath]) -> usize {
        let Some(map) = self.nozzle_map.as_ref() else {
            return 0;
        };
        let pts = loops.iter().flat_map(|l| &l.points);
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
        // walls. OrcaSlicer refuses the plate too.
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
        // Each object's footprint, worked out once for its own session and the plate's.
        let hulls = crate::firmware::footprints(plate);
        let hull_of = |obj: &crate::plate::PlateObject| {
            plate
                .objects
                .iter()
                .position(|o| std::ptr::eq(o, obj))
                .and_then(|i| hulls.get(i).cloned())
                .map(|h| vec![h])
        };
        // Each printable object's index on the plate, which its paths are stamped with (`owners.rs`).
        let plate_index_of = |obj: &crate::plate::PlateObject| {
            plate
                .objects
                .iter()
                .position(|o| std::ptr::eq(o, obj))
                .and_then(|i| u16::try_from(i).ok())
                .unwrap_or(u16::MAX)
        };
        let printable_index: Vec<u16> = printable.iter().map(|o| plate_index_of(o)).collect();
        let mut subs: Vec<Self> = Vec::with_capacity(sliced.len());
        let mut own_cfgs: Vec<PrintConfig> = Vec::with_capacity(sliced.len());
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
            let mut one = Self::build_one_with(
                &sub,
                &own_cfg,
                own.as_deref(),
                &own_ranges,
                interleaved,
                hull_of(obj),
            )?;
            one.plate_index = plate_index_of(obj);
            subs.push(one);
            own_cfgs.push(own_cfg);
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
        // Each object's session sees only its own enforcers; the plate has none only when no object has any.
        if subs.iter().any(Self::has_enforcers) {
            for s in &mut subs {
                s.warnings.retain(|w| w.message != NO_ENFORCERS);
            }
        }
        let mut first = subs.remove(0);
        // The first object's own view, which its support layers are planned with once the plate's tower is known.
        let mut first_own: OwnView = (
            first.bounds,
            first.objects.clone(),
            first.object_settings.clone(),
            first.interleave,
        );
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
        first.objects = hulls;
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
            first.place_copies(plate, config, tops, &placed, &own_bounds, &printable_index);
        }
        if first.interleave {
            first.plan_interleaved();
            first.plan_plate_tools(config)?;
            // Each object plans its support layers as one session of the plate would: on the object's layers when
            // the plate's tower prints (it now stands in each object's session). The plate's layers and filaments
            // are planned again with them.
            let mut cfgs = own_cfgs.iter();
            if let Some(c) = cfgs.next() {
                // As its own session saw itself: its bounds, footprint and settings, without the other objects.
                let followers = std::mem::take(&mut first.followers);
                first.swap_own(&mut first_own);
                first.plan_support_layers(c);
                first.swap_own(&mut first_own);
                first.followers = followers;
            }
            for (f, c) in first.followers.iter_mut().zip(cfgs) {
                f.plan_support_layers(c);
            }
            let said: Vec<SliceWarning> = first.followers.iter().flat_map(|f| f.warnings.clone()).collect();
            for w in said {
                first.push_warning(w);
            }
            first.plan_interleaved();
            first.plan_plate_tools(config)?;
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
        printable_index: &[u16],
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
                object: printable_index
                    .get(self.instances.len())
                    .copied()
                    .unwrap_or(u16::MAX),
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
        Self::build_one_with(plate, config, tops, ranges, interleaved, None)
    }

    /// [`Self::build_one`] with the plate's footprints when they are known already (`firmware::footprints`): the
    /// hull of every vertex of each object, which on a part of millions of vertices takes a good part of a second.
    fn build_one_with(
        plate: &Plate,
        config: &PrintConfig,
        tops: Option<&[f64]>,
        ranges: &[HeightRange],
        interleaved: bool,
        hulls: Option<Vec<crate::output::ObjectFootprint>>,
    ) -> Result<Self> {
        config.check()?;
        // Worked out once here, for the prime tower's placement and the session's objects.
        let hulls = hulls.unwrap_or_else(|| crate::firmware::footprints(plate));
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
        // The object of each part in `raw`.
        let mut part_object: Vec<usize> = Vec::new();
        for (obj_index, obj) in plate.objects.iter().enumerate() {
            let (mut lo, mut hi) = (f64::MAX, f64::MIN);
            let mut oxy = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
            for (part_index, part) in obj.mesh.parts.iter().enumerate() {
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
                // Read from the plate's mesh in place: a painted part's paint is tens of megabytes.
                let paint =
                    crate::paint::Facets::of_part(&obj.mesh, part_index, |p| &p.paint, &obj.transform);
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
                        crate::paint::Facets::of_part(
                            &obj.mesh,
                            part_index,
                            |p| &p.fuzzy_paint,
                            &obj.transform,
                        ),
                    ));
                }
                raw.push((slot, verts, tris, paint));
                part_object.push(obj_index);
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
        if below_bed(min_z) {
            warnings.push(SliceWarning {
                code: WarningCode::OutsideBed,
                message: "Part of the plate is below the bed; it is cut off at z = 0".to_owned(),
                layer: None,
            });
        }
        // What the loaders read but changed or could not apply (a project's unknown part types, say).
        for n in plate.objects.iter().flat_map(|o| &o.mesh.notes) {
            if !warnings.iter().any(|w: &SliceWarning| w.message == *n) {
                warnings.push(SliceWarning {
                    code: WarningCode::UnsupportedSetting,
                    message: n.clone(),
                    layer: None,
                });
            }
        }
        // Enforcers only add support when support is on; with it off they do nothing, which is easy to miss.
        if !config.enable_support
            && (painted_supports.iter().any(|(_, s)| *s == 1)
                || plate
                    .objects
                    .iter()
                    .flat_map(|o| &o.volumes)
                    .any(|v| v.role == crate::plate::VolumeRole::SupportEnforcer))
        {
            warnings.push(SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: ENFORCERS_UNUSED.to_owned(),
                layer: None,
            });
        }
        if config.enable_support {
            warnings.extend(support_slot_warnings(config));
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
                message: NO_ENFORCERS.to_owned(),
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
        let painted_objects = PaintedObject::of(&parts, &part_object);
        let mut volumes = Vec::new();
        let mut volume_settings: Vec<serde_json::Value> = Vec::new();
        // A part with its own settings prints its area like a modifier shaped as the part. These come before the
        // objects' modifier volumes, so a modifier wins over the part's settings where it reaches into the part
        // (the last modifier wins where they overlap).
        for (v, t, settings) in part_regions {
            volumes.push((
                crate::plate::VolumeRole::Modifier,
                PreparedPart::new(1, v, t, &plan),
            ));
            volume_settings.push(settings);
        }
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
        let mut slots: Vec<u8> = parts
            .iter()
            .flat_map(|p| std::iter::once(p.slot).chain(p.paint.states()))
            .collect();
        slots.sort_unstable();
        slots.dedup();
        // A vase layer is one outline in one filament; OrcaSlicer refuses an object of several.
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
                &hulls,
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
        // Painted ears the model carries, moved to plate coordinates, with the plate object that carries each; only
        // those on the bed count.
        let brim_ears: Vec<(usize, [f64; 4])> = plate
            .objects
            .iter()
            .enumerate()
            .flat_map(|(k, o)| {
                o.brim_points.iter().filter_map(move |b| {
                    let w = o.apply([b[0], b[1], b[2]]);
                    (w[2] <= 1e-4).then(|| (k, [w[0], w[1], w[2], f64::from(b[3])]))
                })
            })
            .collect();
        let object_slices = (0..plan.count()).map(|_| std::sync::OnceLock::new()).collect();
        let mut session = Self {
            cache: crate::shells::Cache::default(),
            paint: crate::paint::Cache::default(),
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
            painted_objects,
            followers: Vec::new(),
            object_settings: Vec::new(),
            interleave: false,
            plate_tools: None,
            overrides,
            ear_hulls: if brim_ears.is_empty() {
                Vec::new()
            } else {
                hulls.iter().map(|h| h.hull.clone()).collect()
            },
            objects: hulls,
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
            organic2: std::sync::OnceLock::new(),
            print: Vec::new(),
            object_print: Vec::new(),
            stack: Vec::new(),
            interleaved: Vec::new(),
            used_tools: Vec::new(),
            object_tools: Vec::new(),
            support_tools: Vec::new(),
            print_lifted: false,
            independent: false,
            seams: std::sync::OnceLock::new(),
            whole: WholeRegions::default(),
            vase_exits: VaseExits::default(),
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
            part_object: part_object
                .iter()
                .map(|&o| u16::try_from(o).unwrap_or(u16::MAX))
                .collect(),
            object_slices,
            plate_index: 0,
            instances: Vec::new(),
            whole_plate: None,
            nozzle_map: None,
            collide: None,
            collide_meta: None,
            shed_done: false,
            tower_rows0: 1.0,
            tower_plan: std::sync::OnceLock::new(),
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
        // An object of a plate printed layer by layer plans them once the plate's tower is known (`build_plate`).
        if !interleaved {
            session.plan_support_layers(config);
            session.plan_raft(config);
        }
        Ok(session)
    }

    /// Swaps the session's bounds, footprints, object settings and interleave flag with `own`.
    fn swap_own(&mut self, own: &mut OwnView) {
        std::mem::swap(&mut self.bounds, &mut own.0);
        std::mem::swap(&mut self.objects, &mut own.1);
        std::mem::swap(&mut self.object_settings, &mut own.2);
        std::mem::swap(&mut self.interleave, &mut own.3);
    }

    /// Plans support on layers of its own height, only when no prime tower prints (`own_support_layers`). The raft
    /// was planned with the setting, so its gap to the part follows the choice here.
    fn plan_support_layers(&mut self, config: &PrintConfig) {
        let own = self.own_support_layers(config);
        if own != config.independent_support_layer_height() && self.raft.is_some() {
            self.raft = crate::raft::plan_with(config, own);
        }
        self.plan_print(config, own);
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
    /// of their own, as in Orca: each object's occupied outline (here its footprint hull and
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
            let room = self.purge_room(config, fam, &micros, l, to);
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

    /// What filament `to`'s infill (and objects, with `flush_into_objects`) on layer `l` can take up of a change's
    /// flush, mm3, estimated from the layer's regions.
    fn purge_room(&self, config: &PrintConfig, fam: Families, micros: &Micros, l: u32, to: u8) -> f64 {
        let regions = self.layer_regions(l, fam, micros);
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
        room
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

    /// The filament slots the whole plate prints, ascending: each object's planned tool order, or its own slots
    /// when it prints with one filament.
    pub(crate) fn plate_slots(&self) -> Vec<u8> {
        let mut slots: Vec<u8> = self
            .sequence()
            .flat_map(|s| {
                if s.tool_order.iter().any(|l| !l.is_empty()) {
                    s.tool_order.iter().flatten().copied().collect::<Vec<u8>>()
                } else {
                    s.slots.clone()
                }
            })
            .filter(|&t| t > 0)
            .collect();
        slots.sort_unstable();
        slots.dedup();
        slots
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
        let mut mapped = self.mapped_config(config);
        if !mapped.variant_sources.is_empty() {
            let _ = mapped.to_mut().refresh_variants()?;
        }
        let config = mapped.as_ref();
        let paths_of = |layers: Range<u32>, progress: &dyn Progress| {
            if self.followers.is_empty() && self.instances.is_empty() {
                self.slice_object_range(config, layers, progress)
            } else {
                crate::sequence::slice_range(self, config, layers, progress)
            }
        };
        let mut out = paths_of(layers.clone(), progress)?;
        // A support-only layer slows down together with the object layer printed after it
        // (`gcode::settle_cooling`): when such a pair spans an end of the range, the layer on the other side
        // is sliced too, so every range settles its layers as the whole plate does.
        let cools =
            config.slow_down_for_layer_cooling || out.configs.iter().any(|c| c.slow_down_for_layer_cooling);
        let below = match out.layers.first() {
            Some(l)
                if cools
                    && layers.start > 0
                    && !l.paths.is_empty()
                    && !paths::support_only(l)
                    && self.support_only_at(layers.start - 1) != Some(false) =>
            {
                Some(paths_of(layers.start - 1..layers.start, &crate::NoProgress)?)
            }
            _ => None,
        };
        let above = match out.layers.last() {
            Some(l) if cools && layers.end < self.layer_count() && paths::support_only(l) => {
                Some(paths_of(layers.end..layers.end + 1, &crate::NoProgress)?)
            }
            _ => None,
        };
        crate::gcode::settle_cooling(&mut out, config, (below.as_ref(), above.as_ref()));
        out.filament_map.clone_from(&self.nozzle_map);
        out.raised_wall = crate::overhang::raised_wall(config);
        // From the filaments the whole plate prints, so every range of layers reads the same mode.
        if let Some((chamber, warning)) = crate::chamber::resolve(config, &self.plate_slots()) {
            if let Some(message) = warning {
                let w = SliceWarning {
                    code: WarningCode::UnsupportedSetting,
                    message,
                    layer: None,
                };
                if !out.warnings.contains(&w) {
                    out.warnings.push(w);
                }
            }
            out.chamber = Some(chamber);
        }
        if let Some(w) = crate::firmware::label_limit_warning(&out.objects, config, config.gcode_flavor)
            && !out.warnings.contains(&w)
        {
            out.warnings.push(w);
        }
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
        // what OrcaSlicer's skirt hull starts from: the outlines before the elephant foot
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

    /// This session's index on the plate when it is one object of a plate sliced object by object.
    pub(crate) fn plate_index(&self) -> u16 {
        self.plate_index
    }

    /// Each object's own slice on object layer `layer` (`owners.rs`), worked out once.
    fn object_slices_at(&self, layer: usize) -> Option<std::sync::Arc<crate::owners::Slices>> {
        let cell = self.object_slices.get(layer)?;
        Some(
            cell.once(|| {
                let z = self.plan.slice_z.get(layer).copied().unwrap_or(0.0);
                let loops: Vec<Vec<Polygon>> = self
                    .parts
                    .iter()
                    .map(|p| {
                        let mut v = Vec::new();
                        p.slice(layer, z, &mut v);
                        v
                    })
                    .collect();
                std::sync::Arc::new(crate::owners::slices_of(&self.part_object, &loops))
            })
            .clone(),
        )
    }

    /// The owners of a print layer's paths (`owners.rs`): `object` is the object layer it prints (None for a raft
    /// or support only layer, `next` then the first object layer over it). `min_held` is the support's line spacing
    /// (`owners::assign`).
    fn stamp_owners(&self, l: &mut LayerPaths, object: Option<u32>, next: Option<u32>, min_held: f64) {
        let mut objects = self.part_object.clone();
        objects.sort_unstable();
        objects.dedup();
        match objects.as_slice() {
            [] => {}
            [one] => crate::owners::stamp(l, *one),
            _ => {
                let here = object
                    .and_then(|k| self.object_slices_at(k as usize))
                    .unwrap_or_default();
                // Layers up from the object layer (or, under it, from the first object layer).
                let base = object.or(next.map(|n| n.saturating_sub(1)));
                let above = |k: usize| {
                    let b = base? as usize;
                    self.object_slices_at(b + k)
                };
                crate::owners::assign(l, &here, &above, min_held);
            }
        }
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
        debug_assert!(
            !self.shed_done,
            "the collision model is dropped once slicing is done"
        );
        self.collide.as_deref()
    }

    /// Drops what only slicing reads (meshes, caches, support and paint data), for a one-shot run whose last layer
    /// range is cut. Keeps what writing the output reads: the layer plan, the print layers, the collision report's
    /// facts and the filament map.
    pub(crate) fn shed(&mut self) {
        // Only cutting the layers walks the collision model, and its obstacles hold the plate's loaded meshes, so
        // only its facts stay for the report.
        if let Some(model) = self.collide.take() {
            self.collide_meta = Some(std::sync::Arc::new(model.meta.clone()));
        }
        self.shed_done = true;
        self.parts = Vec::new();
        self.volumes = Vec::new();
        self.cache = crate::shells::Cache::default();
        self.paint = crate::paint::Cache::default();
        self.painted_supports = Vec::new();
        self.seam_faces = Vec::new();
        self.fuzzy_paint = Vec::new();
        self.object_slices
            .iter_mut()
            .for_each(|s| *s = std::sync::OnceLock::new());
        self.support = std::sync::OnceLock::new();
        self.organic_raft = std::sync::OnceLock::new();
        self.organic2 = std::sync::OnceLock::new();
        self.interlock = std::sync::OnceLock::new();
        self.conical = std::sync::OnceLock::new();
        self.polyholes = std::sync::OnceLock::new();
        self.stack = Vec::new();
        self.whole_plate = None;
        self.followers.iter_mut().for_each(Self::shed);
    }

    /// What the collision report needs besides the hits, on a by-object plate.
    pub fn collide_meta(&self) -> Option<&crate::collide::Meta> {
        self.collide
            .as_deref()
            .map(|m| &m.meta)
            .or(self.collide_meta.as_deref())
    }

    /// [`Self::collide_meta`] with the travel, retraction, Z hop and Z speed of the run's settings `config`, which
    /// the report's fixes cost with.
    pub fn collide_meta_for(&self, config: &PrintConfig) -> Option<crate::collide::Meta> {
        self.collide_meta().map(|m| m.clone().with_run(config))
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

    /// The filaments a region on `slot` prints its features with. Paint wins: a region only paint gives this filament
    /// (no part of the session is on it) prints every feature with it, whatever the plate, object, height range or
    /// modifier asks for; the per-feature filaments move the features of the parts' own, unpainted regions only.
    fn feature_tools(&self, cfg: &PrintConfig, slot: u8) -> FeatureTools {
        if self.parts.iter().any(|p| p.slot == slot) {
            feature_tools(cfg, slot)
        } else {
            feature_tools_from(|_| None, slot)
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
    /// 0 is whichever filament is active: for the base as in Orca, for the interface as Bambu Studio prints it): those filaments join the tool order of the
    /// layers that have support, and the prime tower is planned again for them.
    fn plan_support_tools(&mut self, config: &PrintConfig) -> Result<()> {
        let (base, iface) = (
            support_slot(config, "support_filament"),
            support_slot(config, "support_interface_filament"),
        );
        if !crate::collide::rules::support_runs(
            config.enable_support,
            config.support.manual,
            self.has_enforcers(),
        ) || (base == 0 && iface == 0)
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
                // An interface without a filament of its own prints with the active one (see `support_tools`).
                if base > 0 && !sl.base.is_empty() {
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
    /// Orca's first-layer order (the outer wall filaments, the one whose smallest island is
    /// largest first).
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
        self.tower_with(cfg, self.tower_top.map_or(0.0, |t| self.plan.top(t)))
    }

    /// [`Self::tower`] for a tower `height` mm tall.
    fn tower_with(&self, cfg: &PrintConfig, height: f64) -> Option<crate::tower::Tower> {
        match &self.tower_shape {
            Some(p) => p.tower(cfg, self.tool_count),
            None => crate::tower::Tower::new(cfg, self.tool_count, self.tower_rows),
        }
        .map(|t| t.ribbed(cfg, height, self.plan.top(0)))
    }

    /// The object each first layer island belongs to: the one whose hull holds it (all 0 with one object).
    fn island_owners(&self, union: &Shapes) -> Vec<usize> {
        if self.objects.len() <= 1 {
            return vec![0; union.len()];
        }
        let hulls: Vec<&[[f64; 2]]> = self.objects.iter().map(|o| o.hull.as_slice()).collect();
        union
            .iter()
            .map(|island| crate::brim::owner(island, &hulls))
            .collect()
    }

    /// `auto_brim`: the brim width (mm, before the islands' own limits) and the height of each object, by the owner
    /// of each island of `union`. The brim is sized from each object's own height and first layer footprint (per
    /// object, as Orca's auto brim does), never from the plate as a whole: four copies side by side get the
    /// brim one of them gets.
    fn auto_brim_widths(
        &self,
        cfg: &PrintConfig,
        union: &Shapes,
        owners: &[usize],
        object_height: f64,
    ) -> Vec<(f64, f64)> {
        let objects = owners.iter().copied().max().map_or(1, |m| m + 1);
        (0..objects)
            .map(|k| {
                let own: Shapes = union
                    .iter()
                    .zip(owners)
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
    }

    /// How far each object's automatic brim reaches past its first layer, mm: the brim gap and the widest brim
    /// any of its islands prints, in whole loops, the same widths the first layer then prints. Empty when the brim
    /// is not automatic or a raft takes its place.
    fn auto_brim_rooms(&self, config: &PrintConfig) -> Vec<f64> {
        if crate::brim::Kind::of(config) != crate::brim::Kind::Auto || self.raft.is_some() {
            return Vec::new();
        }
        let cfg = config.for_first_layer();
        let here = self.layer_regions(0, Families::new(&cfg), &Micros::default());
        let union = brim_outline(&cfg, &here);
        let object_height = self.plan.top(self.plan.count().saturating_sub(1));
        let owners = self.island_owners(&union);
        let widths = self.auto_brim_widths(&cfg, &union, &owners, object_height);
        let spacing = brim_spacing(&cfg);
        let gap = cfg.raw_number("brim_object_gap", 0.0).clamp(0.0, 2.0);
        let mut rooms: Vec<f64> = vec![0.0; self.objects.len().max(1)];
        for (island, owner) in union.iter().zip(&owners) {
            let (width, height) = widths.get(*owner).copied().unwrap_or((0.0, object_height));
            let one: Shapes = vec![island.clone()];
            let loops = brim_loops(crate::brim::island_width(width, &one, height, spacing), spacing);
            if loops > 0
                && let Some(room) = rooms.get_mut(*owner)
            {
                *room = room.max(gap + f64::from(loops) * spacing);
            }
        }
        rooms
    }

    /// What each object's first layer lays down past its hull, with its own settings: its brim (the automatic
    /// brim at the width the first layer prints), its support's pad and brim, a skirt of its own.
    fn tower_rooms(&self, config: &PrintConfig) -> Vec<f64> {
        let auto = self.auto_brim_rooms(config);
        (0..self.objects.len())
            .map(|k| {
                let brim = auto.get(k).copied().unwrap_or(0.0);
                self.object_config(k, config).map_or_else(
                    |_| crate::tower::room_with(config, config.brim_width.max(brim)),
                    |c| crate::tower::room_with(&c, c.brim_width.max(brim)),
                )
            })
            .collect()
    }

    /// Sizes the prime tower for its deepest layer and places it clear of the objects.
    fn place_tower(&mut self, config: &PrintConfig) -> Result<()> {
        let Some(top) = self.tower_top else {
            return Ok(());
        };
        let rooms = self.tower_rooms(config);
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
        self.tower_plan = std::sync::OnceLock::new();
        Ok(())
    }

    /// The tower's rows before the saves of a type 2 tower, at its placed width.
    fn unsaved_rows(&self, config: &PrintConfig) -> f64 {
        let (Some(top), Some(shape)) = (self.tower_top, self.tower_shape) else {
            return self.tower_rows;
        };
        if !crate::tower::saves_first_purge(config) {
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
            let tool = self.feature_tools(cfg, *slot).outer;
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
        // Support on layers of its own: `used_tools` and the tool order count the support planned on
        // the object's layers, but this layer prints only the support of its own print layer (most of
        // it prints on support-only layers between the object's).
        if self.independent && !self.stack.is_empty() {
            let mut tools: Vec<u8> = match self.object_tools.get(l as usize) {
                Some(own) => own.clone(),
                None => used.slots().collect(),
            };
            if crate::collide::rules::support_runs(
                cfg.enable_support,
                cfg.support.manual,
                self.has_enforcers(),
            ) && let Some((sl, ..)) = self.support_at(cfg, l)
                && let Some(&active) = tools.first()
            {
                tools.extend(support_order(cfg, sl, active));
            }
            return order.iter().rev().copied().find(|t| tools.contains(t));
        }
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
                            // As `support_only_paths` prints it: the filament the layer below ended
                            // on first.
                            let start = self.print_start(cfg, at, get);
                            let mut tools = support_order(cfg, &st.layer, start);
                            crate::sorting::sort_by_key(&mut tools, |t| *t != start);
                            tools.last().copied()
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
        held_in(self.nozzle_map.as_ref(), &self.tool_order, p as usize)
    }

    /// The tool changes the plan makes below print layer `p` (`LayerPaths::changes_before`).
    fn changes_before(&self, p: u32) -> u32 {
        changes_in(&self.tool_order, p as usize)
    }

    /// How far below object layer `layer`'s top its prime tower prints, mm ([`crate::tower::sunk_by`]): 0 unless
    /// `wipe_tower_no_sparse_layers` leaves out tower layers under it. The tower prints on the first layer and on
    /// the layers the plan changes filament on.
    pub(crate) fn tower_sunk(&self, cfg: &PrintConfig, layer: u32) -> f64 {
        if self.tool_count < 2
            || self.plate_tools.is_some()
            || !crate::tower::flag(cfg, "wipe_tower_no_sparse_layers")
        {
            return 0.0;
        }
        let print = |l: u32| self.object_print.get(l as usize).copied().unwrap_or(l) as usize;
        let mut last: Option<u8> = None;
        let mut next = 0usize;
        crate::tower::sunk_by((0..=layer).map(|q| {
            let p = print(q);
            let mut changes = false;
            for (i, order) in self.tool_order.iter().enumerate().take(p + 1).skip(next) {
                for &t in order {
                    changes |= i == p && last.is_some_and(|l| l != t);
                    last = Some(t);
                }
            }
            next = next.max(p + 1);
            let first = q == 0 && self.raft.is_none();
            (
                q == layer || first || changes,
                self.plan.top(q),
                self.plan.thickness(q),
            )
        }))
    }

    /// The tools the plan prints with below print layer `p` (`LayerPaths::tools_before`).
    fn tools_before(&self, p: u32) -> u64 {
        tools_in(&self.tool_order, p as usize)
    }

    /// By object: the filament this object holds once its first `p` print layers are printed, from its plan
    /// alone (0 before it prints anything). An object of one filament plans no tool order; it holds that one.
    pub(crate) fn tool_after(&self, p: u32) -> u8 {
        let planned = self.tool_order.iter().take(p as usize).flatten().last().copied();
        match (planned, self.slots.as_slice()) {
            (Some(t), _) => t,
            (None, [one]) if p > 0 => *one,
            _ => 0,
        }
    }

    /// By object: what printing this whole object hands to the next one, from its plan alone, so a layer
    /// range that starts at a later object knows it without slicing the objects before.
    pub(crate) fn hand_over(&self) -> HandOver {
        let n = self.plan_count();
        let first = self.tool_order.iter().flatten().next().copied();
        let (first, last) = match (first, self.slots.as_slice()) {
            (Some(f), _) => (f, self.tool_after(n)),
            (None, [one]) => (*one, *one),
            _ => (0, 0),
        };
        let mut tools = self.tools_before(n);
        let mut held = self.held_before(n);
        if first != 0 && tools == 0 {
            tools = 1u64 << u32::from(first.max(1) - 1).min(63);
            if let Some(map) = &self.nozzle_map
                && let Some(h) = held.get_mut(map.nozzle_of(first))
            {
                *h = first;
            }
        }
        HandOver {
            first,
            last,
            tools,
            changes: self.changes_before(n),
            held,
        }
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
        let tools_of = |l: &LayerPaths, support: bool| {
            use crate::output::Feature;
            let mut v: Vec<u8> = l
                .paths
                .iter()
                .filter(|p| p.feature != Feature::PrimeTower)
                .filter(|p| support || !matches!(p.feature, Feature::Support | Feature::SupportInterface))
                .map(|p| p.tool)
                .collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let used: Vec<Vec<u8>> = out.layers.iter().map(|l| tools_of(l, true)).collect();
        self.object_tools = out.layers.iter().map(|l| tools_of(l, false)).collect();
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
    /// prints, as Orca's tool ordering reads the sliced layers (after the painted
    /// segmentation). From the parts alone, a part claims its filament on every layer between its lowest and
    /// highest point and a painted triangle its color on every layer it spans, so layers looked like they
    /// change filament when they do not, and the prime tower was sized for purges that never happen. The
    /// slice takes the cut regions over (`whole_regions`, `take_whole`).
    fn plan_painted_tools(&mut self, config: &PrintConfig) {
        if !self.used_tools.is_empty() || self.slots.len() < 2 {
            return;
        }
        let regions = self.whole_regions(Families::new(config), &Micros::default());
        let own: Vec<Vec<u8>> = regions
            .iter()
            .map(|r| {
                let mut v: Vec<u8> = r
                    .regions
                    .iter()
                    .filter(|(_, s)| !s.is_empty())
                    .map(|(t, _)| *t)
                    .collect();
                v.sort_unstable();
                v.dedup();
                v
            })
            .collect();
        drop(regions);
        self.used_tools = own
            .iter()
            .enumerate()
            .map(|(l, v)| {
                let mut v = v.clone();
                if let Some(s) = self.support_tools.get(l) {
                    v.extend(s.iter().copied());
                }
                v.sort_unstable();
                v.dedup();
                v
            })
            .collect();
        self.object_tools = own;
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

    /// Plans the filaments of a plate whose objects print layer by layer from sessions of their own (their own
    /// settings) as one session of the whole plate plans them: each plate layer prints the filaments of all its
    /// objects in one order, starting on the one the layer below ended on, and one prime tower stands for the
    /// plate's changes. The objects' sessions keep their own settings and plans and leave the tower to the plate,
    /// which `sequence.rs` prints over their paths.
    fn plan_plate_tools(&mut self, config: &PrintConfig) -> Result<()> {
        if !self.instances.is_empty() || self.followers.is_empty() || self.plate_slots().len() < 2 {
            return Ok(());
        }
        let layers: Vec<Vec<Option<u32>>> = if self.interleaved.is_empty() {
            let n = self.sequence().map(Self::plan_count).max().unwrap_or(0);
            (0..n)
                .map(|g| {
                    self.sequence()
                        .map(|s| (g < s.plan_count()).then_some(g))
                        .collect()
                })
                .collect()
        } else {
            self.interleaved.iter().map(|(_, of)| of.clone()).collect()
        };
        // Each object's support filaments of their own (0: the active one), for its layers of support only.
        let support: Vec<(u8, u8)> = (0..self.sequence().count())
            .map(|k| {
                self.object_config(k, config).map(|c| {
                    if c.enable_support {
                        (
                            support_slot(&c, "support_filament"),
                            support_slot(&c, "support_interface_filament"),
                        )
                    } else {
                        (0, 0)
                    }
                })
            })
            .collect::<Result<_>>()?;
        let present = |g: usize| -> Vec<u8> {
            let mut v: Vec<u8> = layers
                .get(g)
                .into_iter()
                .flatten()
                .zip(self.sequence())
                .zip(&support)
                .filter_map(|((p, s), &own)| p.map(|p| s.print_tools(p, own)))
                .flatten()
                .collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let mut first: Vec<u8> = Vec::new();
        for t in self.sequence().flat_map(|s| s.first_layer_order(config)) {
            if !first.contains(&t) {
                first.push(t);
            }
        }
        let choice = crate::toolorder::Choice::of(config, self.tool_count);
        let (orders, any_top, within_top) = order_layers(layers.len(), &present, &first, &choice);
        let always = crate::tower::flag(config, "prime_tower_always");
        let mut top = if always { any_top } else { within_top };
        // As one session keeps the tower up to a change between layers whose flush the new filament's infill
        // cannot take up, from the room in every object's layer.
        if !always && let Some(last) = any_top.filter(|l| Some(*l) > top) {
            let fam = Families::new(config);
            let micros = Micros::default();
            for g in top.map_or(0, |t| t + 1)..=last {
                let ended = g
                    .checked_sub(1)
                    .and_then(|p| orders.get(p as usize))
                    .and_then(|o| o.last())
                    .copied();
                let started = orders.get(g as usize).and_then(|o| o.first()).copied();
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
                let mut room = 0.0;
                for (k, (p, s)) in layers
                    .get(g as usize)
                    .into_iter()
                    .flatten()
                    .zip(self.sequence())
                    .enumerate()
                {
                    if let Some(l) = p.and_then(|p| s.object_layer(p)) {
                        let c = self.object_config(k, config)?;
                        room += s.purge_room(&c, fam, &micros, l, to);
                    }
                }
                if need * 1.25 > room + 0.5 {
                    top = Some(g);
                }
            }
        }
        // Each plate layer's height and top, from the first object that prints on it.
        let slot = |g: usize| -> (f64, f64) {
            layers
                .get(g)
                .into_iter()
                .flatten()
                .zip(self.sequence())
                .find_map(|(p, s)| p.map(|p| (s.print_height(p), s.print_top(p))))
                .unwrap_or((self.plan.height, 0.0))
        };
        let thickness = |g: usize| slot(g).0;
        let tower_height = top.map_or(0.0, |t| slot(t as usize).1);
        let tools = self.tool_count;
        let shape = match top {
            Some(t) => {
                let rooms = self.tower_rooms(config);
                let height = self.sequence().map(Self::plate_top).fold(0.0, f64::max);
                crate::tower::place(
                    config,
                    tools,
                    &|w| crate::tower::plan_rows(config, w, tools, &orders, &thickness, t as usize),
                    crate::tower::rib_size(config, tools, &orders, &thickness, t as usize),
                    &self.objects,
                    &rooms,
                    height,
                )?
            }
            None => None,
        };
        let rows = shape.map_or(1.0, |p| p.rows);
        let rows0 = match (top, shape) {
            (Some(t), Some(p)) if crate::tower::saves_first_purge(config) => {
                crate::tower::plan_rows_unsaved(config, p.width, tools, &orders, &thickness, t as usize)
            }
            _ => rows,
        };
        let tower_plan = match (top, shape.and_then(|p| p.tower(config, tools))) {
            (Some(t), Some(tower)) if crate::tower::type1(config) => {
                crate::tower::TowerPlan::new(config, tools, &orders, &thickness, t as usize, &tower)
            }
            _ => crate::tower::TowerPlan::default(),
        };
        let plate = std::sync::Arc::new(PlateTools {
            orders,
            layers,
            tower_top: top,
            tower_height,
        });
        let share = |s: &mut Self| {
            s.tower_shape = shape;
            s.tower_rows = rows;
            s.tower_origin = shape.map(|p| p.origin);
            s.tower_rows0 = rows0;
            s.tower_top = top.map(|_| s.plan_layer_at(tower_height));
            s.plate_tools = Some(plate.clone());
            s.tower_plan = std::sync::OnceLock::from(tower_plan.clone());
        };
        share(self);
        for f in &mut self.followers {
            share(f);
        }
        Ok(())
    }

    /// The plate's tool plan when its objects print layer by layer from sessions of their own; None otherwise.
    pub(crate) fn plate_tools(&self) -> Option<&PlateTools> {
        self.plate_tools.as_deref()
    }

    /// The tower's side of plate layer `g` when it starts on filament `start`, on a plate with [`PlateTools`]: its
    /// place in the plan, and whether it holds only support. None when the tower does not stand on it (a raft
    /// layer, or above the tower).
    pub(crate) fn plate_tower_layer(
        &self,
        cfg: &PrintConfig,
        g: u32,
        start: u8,
    ) -> Option<(TowerLayer, Option<bool>)> {
        let tools = self.plate_tools.as_deref()?;
        let of = tools.layers.get(g as usize)?;
        let printing = || {
            of.iter()
                .zip(self.sequence())
                .filter_map(|(p, s)| p.map(|p| (p, s)))
        };
        let tower = self
            .tower_with(cfg, tools.tower_height)
            .map(|t| self.tower_origin.map_or(t, |o| t.at(o)));
        if let Some((l, s)) = printing().find_map(|(p, s)| s.object_layer(p).map(|l| (l, s))) {
            let at = TowerLayer {
                layer: l,
                first: l == 0 && s.raft.is_none(),
                h: s.plan.thickness(l),
                top: s.plan.top(l),
                tower_height: tools.tower_height,
                start,
                tower: tower.filter(|_| tools.tower_top.is_some_and(|t| g <= t)),
                order_at: g,
            };
            return Some((at, None));
        }
        // Support only: walled while an object layer under it is below the tower's top.
        let (p, s) =
            printing().find(|(p, s)| s.print.get(*p as usize).is_some_and(|l| l.support.is_some()))?;
        let pl = s.print.get(p as usize)?;
        let below = s
            .print
            .get(..p as usize)
            .and_then(|r| r.iter().rev().find_map(|l| l.object));
        let walled = below.is_some_and(|b| s.tower_top.is_some_and(|t| b < t));
        let at = TowerLayer {
            layer: below.unwrap_or(0),
            first: false,
            h: pl.height,
            top: pl.top,
            tower_height: tools.tower_height,
            start,
            tower,
            order_at: g,
        };
        Some((at, Some(walled)))
    }

    /// [`Self::tower_sunk`] for plate layer `g` on a plate with [`PlateTools`]: the plate plans the changes.
    pub(crate) fn plate_tower_sunk(&self, cfg: &PrintConfig, g: u32) -> f64 {
        let Some(tools) = self.plate_tools.as_deref() else {
            return 0.0;
        };
        if !crate::tower::flag(cfg, "wipe_tower_no_sparse_layers") {
            return 0.0;
        }
        // Each plate layer's top, height, and whether it is the print's first layer.
        let level = |q: usize| {
            tools.layers.get(q).and_then(|of| {
                of.iter().zip(self.sequence()).find_map(|(p, s)| {
                    let p = (*p)?;
                    let first = s.object_layer(p) == Some(0) && s.raft.is_none();
                    if s.print.is_empty() {
                        return (p < s.plan.count()).then(|| (s.plan.top(p), s.plan.thickness(p), first));
                    }
                    let pl = s.print.get(p as usize)?;
                    Some((pl.top, pl.height, first))
                })
            })
        };
        let mut last: Option<u8> = None;
        crate::tower::sunk_by((0..=g as usize).filter_map(|q| {
            let mut changes = false;
            for &t in tools.orders.get(q).into_iter().flatten() {
                changes |= last.is_some_and(|l| l != t);
                last = Some(t);
            }
            let (top, h, first) = level(q)?;
            Some((q == g as usize || first || changes, top, h))
        }))
    }

    /// The tower's side of a plate layer that holds only support, over the filaments' turns: a purge into the tower
    /// for each change, less what the support takes up, and the outline when `walled`. As one session prints a
    /// support layer of its own.
    pub(crate) fn support_tower_turns(
        &self,
        cfg: &PrintConfig,
        at: &TowerLayer,
        walled: bool,
        turns: &mut [PlateTurn],
    ) {
        if self.tool_count < 2 {
            return;
        }
        let mut current = at.start;
        let mut used_rows = 0.0;
        let mut wipe_starts: Vec<(f64, f64)> = Vec::new();
        for w in turns.iter_mut() {
            if current != 0 && w.tool != current {
                let mut v = crate::tower::change_purge(cfg, self.tool_count, current, w.tool).wipe;
                if crate::tower::flag_or(cfg, "flush_into_support", true) {
                    v = crate::tower::tower_share(cfg, w.tool, v, w.support);
                }
                if let (true, Some(t)) = (v > 0.5, at.tower) {
                    wipe_starts.push(t.row_start(used_rows));
                    let (path, rows) = t.purge(v, at.h, false, used_rows);
                    used_rows += rows;
                    w.tower.extend(path);
                }
            }
            current = w.tool;
        }
        if walled
            && crate::tower::flag_or(cfg, "prime_tower_outline", true)
            && !crate::tower::flag(cfg, "wipe_tower_no_sparse_layers")
            && let (Some(t), Some(w)) = (at.tower, turns.first_mut())
        {
            w.tower.splice(0..0, t.wall_pieces(false, at.top, &wipe_starts));
        }
    }

    /// The filament the plan has plate layer `g` start on: the last one of the nearest layer below that prints any.
    pub(crate) fn plate_start(&self, g: u32) -> u8 {
        self.plate_tools.as_deref().map_or(0, |t| {
            t.orders
                .iter()
                .take(g as usize)
                .rev()
                .find_map(|o| o.last().copied())
                .unwrap_or(0)
        })
    }

    /// What the plate's plan prints before plate layer `g`: the tools, the changes and, with a filament map, what
    /// each nozzle holds (`LayerPaths::tools_before`, `changes_before`, `held_before`).
    pub(crate) fn plate_before(&self, g: u32) -> (u64, u32, Vec<u8>) {
        let Some(t) = self.plate_tools.as_deref() else {
            return (0, 0, Vec::new());
        };
        let p = g as usize;
        (
            tools_in(&t.orders, p),
            changes_in(&t.orders, p),
            held_in(self.nozzle_map.as_ref(), &t.orders, p),
        )
    }

    /// The filaments print layer `p` prints, as the plan has them: its planned order, or the one filament of an
    /// object of one filament. A layer of support only prints the support's own filaments (`support`: base and
    /// interface, 0 for the active one) where it has base or interface; a raft layer none.
    fn print_tools(&self, p: u32, support: (u8, u8)) -> Vec<u8> {
        let Some(l) = self.object_layer(p) else {
            let Some(st) = self
                .print
                .get(p as usize)
                .and_then(|l| l.support)
                .and_then(|s| self.stack.get(s as usize))
            else {
                return Vec::new();
            };
            let mut v = Vec::new();
            if support.0 > 0 && !st.layer.base.is_empty() {
                v.push(support.0);
            }
            if support.1 > 0 && !st.layer.interface.is_empty() {
                v.push(support.1);
            }
            return v;
        };
        match self.tool_order.get(l as usize) {
            Some(o) if !o.is_empty() => o.clone(),
            _ if self.slots.len() == 1 => self.slots.clone(),
            _ => Vec::new(),
        }
    }

    /// The object layer print layer `p` prints, None for a support or raft layer.
    fn object_layer(&self, p: u32) -> Option<u32> {
        if self.print.is_empty() {
            (p < self.plan.count()).then_some(p)
        } else {
            self.print.get(p as usize)?.object
        }
    }

    /// Height of print layer `p`, mm.
    fn print_height(&self, p: u32) -> f64 {
        if self.print.is_empty() {
            self.plan.thickness(p)
        } else {
            self.print.get(p as usize).map_or(self.plan.height, |l| l.height)
        }
    }

    /// The last layer of the plan whose top is at most `z` mm (the first one when none is).
    fn plan_layer_at(&self, z: f64) -> u32 {
        (0..self.plan.count())
            .take_while(|&l| self.plan.top(l) <= z + 1e-6)
            .last()
            .unwrap_or(0)
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
    /// layers move up by the raft's height and the gap to it (as Orca plans a raft).
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

    /// True when normal support prints on layers of its own height: the setting
    /// (`independent_support_layer_height`) is on and no prime tower prints. With a tower, Bambu Studio prints support
    /// on the object's layers, as with the setting off: every support-only layer would add a filament change and its
    /// purge when the support or the object uses another filament. Slim, strong and hybrid trees and organic trees keep
    /// the setting. When the tower turns it off, the slice says so.
    fn own_support_layers(&mut self, config: &PrintConfig) -> bool {
        let setting = config.independent_support_layer_height();
        let s = &config.support;
        if !setting
            || !crate::collide::rules::support_runs(config.enable_support, s.manual, self.has_enforcers())
            || s.style.is_classic_tree()
            || Self::is_organic(config)
            || self.vase.is_some()
        {
            return setting;
        }
        if self.tower_top.is_none() || self.tower(config).is_none() {
            return true;
        }
        self.push_warning(SliceWarning {
            code: WarningCode::UnsupportedSetting,
            message: SUPPORT_ON_OBJECT_LAYERS.to_owned(),
            layer: None,
        });
        false
    }

    /// Plans support on layers of its own height when `own` says so ([`Self::own_support_layers`]: the settings ask
    /// for it, `independent_support_layer_height` is Orca's default, and no prime tower prints) and merges those layers with the
    /// object's. Organic trees and spiral vases keep support on the object's layers (Orca turns
    /// support off in vase mode).
    fn plan_print(&mut self, config: &PrintConfig, own: bool) {
        let s = &config.support;
        let tree = s.style.is_tree() || s.tree;
        // Organic trees stay on the object's layers in OrcaSlicer (they have no layer stack of their own).
        let organic = Self::is_organic(config);
        // Slim, strong and hybrid trees are planned on the object's layers (src/treeclassic.rs).
        let classic = s.style.is_classic_tree();
        if !(crate::collide::rules::support_runs(config.enable_support, s.manual, self.has_enforcers())
            && !organic
            && !(classic && (self.raft.is_some() || !own))
            && (own || (self.raft.is_some() && !tree))
            && self.vase.is_none())
        {
            return;
        }
        let independent = own;
        let n = self.plan.count();
        let input = self.support_input(config);
        // Over a raft the object's layers are lifted by the raft and its gap, and support stands on
        // the raft (as OrcaSlicer plans a raft).
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
            bridge_h: round_support_beads(config).map(|b| b.0),
            bottom_h: round_support_beads(config).map(|b| b.1),
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
                // The columns are the first support layer's base, not its contact, as in OrcaSlicer.
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
            // Slim, strong and hybrid trees plan their own layer heights, as in OrcaSlicer.
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

    /// Whether print layer `i` holds only support (no object layer and no raft), when this session prints the
    /// plate's layers itself; None when they come from the sessions of its objects.
    fn support_only_at(&self, i: u32) -> Option<bool> {
        if !(self.followers.is_empty() && self.instances.is_empty()) {
            return None;
        }
        Some(
            self.print
                .get(i as usize)
                .is_some_and(|pl| pl.object.is_none() && pl.raft.is_none() && pl.support.is_some()),
        )
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
        let round = round_support_flow(cfg, pl.height);
        place_support(&mut works, sp, (0.0, round), support_tools(cfg, tool));
        // Starting on the filament the layer below ended on saves a change.
        crate::sorting::sort_by_key(&mut works, |w| w.tool != tool);
        let mut current = tool;
        let mut used_rows = 0.0;
        let mut wipe_starts: Vec<(f64, f64)> = Vec::new();
        for w in &mut works {
            if w.tool != current && self.tool_count > 1 {
                let mut v = crate::tower::change_purge(cfg, self.tool_count, current, w.tool).wipe;
                if crate::tower::flag_or(cfg, "flush_into_support", true) {
                    v = crate::tower::tower_share(
                        cfg,
                        w.tool,
                        v,
                        work_support_volume(w, cfg.line_width, pl.height),
                    );
                }
                if let (true, Some(t)) = (v > 0.5 && self.plate_tools.is_none(), self.tower(cfg)) {
                    let t = self.tower_origin.map_or(t, |o| t.at(o));
                    wipe_starts.push(t.row_start(used_rows));
                    let (path, rows) = t.purge(v, pl.height, false, used_rows);
                    used_rows += rows;
                    w.tower.extend(path);
                }
            }
            current = w.tool;
        }
        if self.plate_tools.is_some() {
            out.turns = turn_rooms(&works, cfg.line_width, pl.height);
        }
        let Some(work) = works.first_mut() else {
            return out;
        };
        // The prime tower keeps rising through support layers up to its last object layer; it is
        // only walled here, as no filament changes on a support layer.
        if self.tool_count > 1
            && self.plate_tools.is_none()
            && let Some(b) = below
            && self.tower_top.is_some_and(|t| b < t)
            && crate::tower::flag_or(cfg, "prime_tower_outline", true)
            && !crate::tower::flag(cfg, "wipe_tower_no_sparse_layers")
            && let Some(tower) = self.tower(cfg)
        {
            let tower = self.tower_origin.map_or(tower, |o| tower.at(o));
            work.tower
                .splice(0..0, tower.wall_pieces(false, pl.top, &wipe_starts));
        }
        paths::plan_layer(
            &mut out,
            &works,
            cfg,
            p,
            (&crate::seam::NO_SEAMS, pl.top, None),
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
            let room = skirt_room(config);
            skirt_loops(
                &here,
                &[],
                config,
                self.draft_hull.as_deref(),
                &self.skirt_groups,
                (usize::from(self.tool_count), 0),
                room.as_ref(),
            )
        } else {
            Skirt::default()
        };
        let cut = skirt_cut(&skirt);
        // Organic branches pass through the raft down to the bed: the raft prints around them (OrcaSlicer
        // trims the raft layers by the tree polygons).
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
        // its contact area (OrcaSlicer's raft base with no raft layers of its own), a taller raft takes
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
            skirt.paths,
            (&trees, &columns, pad),
        );
        out.skirt_cut = cut;
        out.index = p;
        out.local = p;
        out.start_tool = tool;
        out.tools_before = self.tools_before(p);
        out.changes_before = self.changes_before(p);
        out.held_before = self.held_before(p);
        out
    }

    /// Where the print stands under layer `top`: the last point and wipe tail of the highest layer below it that
    /// has paths, as one range from the first layer carries them past empty layers. Looked for a few layers at a
    /// time; each look starts its own range, which takes the same end from below it when its layers are empty.
    fn end_below(
        &self,
        config: &PrintConfig,
        top: u32,
    ) -> Result<(Option<crate::geom::Point>, crate::output::WipeTail)> {
        const STEP: u32 = 8;
        let lo = top.saturating_sub(STEP);
        let out = self.slice_object_range_now(config, lo..top, &crate::NoProgress)?;
        if let Some(l) = out.layers.iter().rev().find(|l| !l.paths.is_empty()) {
            return Ok((l.exit_point(), l.wipe_tail()));
        }
        Ok(out
            .layers
            .first()
            .map(|l| (l.enter_from, l.below_wipe.clone()))
            .unwrap_or_default())
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
        // Each parallel pass reports how many of its layers are done, so a host can show a moving bar. The end of a
        // stage stays the one report the stage makes when it is done.
        let tick = |stage: Stage, done: &std::sync::atomic::AtomicUsize, total: usize| {
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d < total {
                #[allow(clippy::cast_precision_loss, reason = "a progress fraction")]
                progress.report(stage, d as f32 / total as f32);
            }
        };
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
        // The plans are the last of the layers stage: a host's bar keeps moving until the first contour.
        progress.report(Stage::Layers, LAYERS_PLANS);
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
        let fam_of = |l: u32| if l == 0 && !on_raft { fam0 } else { fam };
        // A layer outside `a_lo..a_hi` that a neighbor reads after all (the shell, bridge and tool order rules can
        // look further than the window above): cut on demand, once, so what a layer reads never depends on where
        // its range starts. Ranges that concatenate give the bytes one range gives, and the session's own caches
        // (`shells::Cache`) never keep a value worked out from a missing neighbor.
        let spill: Vec<std::sync::OnceLock<LayerRegions>> =
            (0..n).map(|_| std::sync::OnceLock::new()).collect();
        let beyond = |l: u32| {
            spill
                .get(l as usize)
                .map(|c| c.once(|| self.layer_regions(l, fam_of(l), &micros)))
        };
        let rest = || {
            if let Some(c) = first_with(|c| {
                c.sparse_infill_pattern == InfillPattern::Lightning && c.sparse_infill_density > 0.0
            }) {
                self.lightning_layers(c);
            }
            progress.report(Stage::Layers, LAYERS_LATE_PLANS);
            // A painted plate keeps the regions of every layer from the start (`whole_regions`), so this range's
            // regions do not wait for the plans below, which only read those. Then the regions shared by the
            // layer jobs (`plan_shared_preps`) are worked out beside the plans.
            let beside = first_with(combine_on).is_none() && self.keeps_whole(fam);
            let plans = || {
                // Ahead of the first contour, the seam plan's layers move the bar; beside the layer jobs they would
                // only send it back.
                let t = Timer::start();
                self.seam_plan(config, (!beside).then_some(progress));
                Micros::add(&micros.seams, &t);
                if !beside {
                    progress.report(Stage::Layers, LAYERS_SEAM_PLAN);
                }
                self.curl_plan(config);
                if let Some(c) = first_with(combine_on) {
                    self.combine_plan(c);
                }
            };
            if !beside {
                plans();
            }
            progress.report(Stage::Contours, 0.0);
            // Layers the whole-object plans already cut with the same families are taken over, not cut again.
            let mut whole = self.take_whole(fam);
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
            let cut_done = std::sync::atomic::AtomicUsize::new(0);
            let cut_total = (a_hi - a_lo) as usize;
            let cut: Vec<Option<LayerRegions>> = par::map_range(a_lo..a_hi, |l| {
                if stopped() || taken.get((l - a_lo) as usize).is_some_and(Option::is_some) {
                    tick(Stage::Contours, &cut_done, cut_total);
                    return None;
                }
                let r = Some(self.layer_regions(l, fam_of(l), &micros));
                tick(Stage::Contours, &cut_done, cut_total);
                r
            });
            let regions: Vec<LayerRegions> = taken
                .into_iter()
                .zip(cut)
                .map(|(a, b)| a.or(b).unwrap_or_default())
                .collect();
            let get = |l: u32| {
                l.checked_sub(a_lo)
                    .and_then(|i| regions.get(i as usize))
                    .or_else(|| beyond(l))
            };
            let ahead = || {
                if !stopped() {
                    self.plan_shared_preps(
                        layers.clone().filter_map(object_of),
                        &layer_cfg_of,
                        &mod_cfgs,
                        &get,
                        &micros,
                        &tags,
                    );
                }
            };
            if beside {
                let ((), ()) = par::join_plans(plans, ahead);
            } else {
                ahead();
            }
            // Without threads nothing runs beside the plan, so each layer is worked out in one go after it.
            let starts: Vec<Option<LayerStart>> =
                if cfg!(feature = "parallel") && pending.is_some() && !stopped() {
                    let start_done = std::sync::atomic::AtomicUsize::new(0);
                    let start_total = layers.len();
                    par::map_range(layers.clone(), |i| {
                        if stopped() {
                            return None;
                        }
                        let s = object_of(i)
                            .map(|l| self.layer_start(l, layer_cfg_of(l), &mod_cfgs, &get, &micros, &tags));
                        tick(Stage::Perimeters, &start_done, start_total);
                        s
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
        let get = |l: u32| {
            l.checked_sub(a_lo)
                .and_then(|i| regions.get(i as usize))
                .or_else(|| beyond(l))
        };
        // Spiral vase mode: each layer above the first starts from where the base layer below it ended.
        let vase_exits = self.vase.filter(|_| objects.end > 1).map(|b| {
            self.vase_exits(config, b, |l, entry| {
                self.layer_paths(l, layer_cfg_of(l), &mod_cfgs, &get, &micros, &tags, entry)
            })
        });
        let object_paths = |l: u32, start: Option<LayerStart>| {
            let entry = self.vase_entry(vase_exits.as_deref().map(Vec::as_slice), l);
            let mut p = match start {
                Some(s) => self.layer_finish(
                    s,
                    l,
                    layer_cfg_of(l),
                    &mod_cfgs,
                    &get,
                    &micros,
                    &tags,
                    true,
                    entry,
                ),
                None => self.layer_paths(l, layer_cfg_of(l), &mod_cfgs, &get, &micros, &tags, entry),
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
        let print_layer_raw = |(i, start): (u32, Option<LayerStart>)| {
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
        // Each path's object (`owners.rs`).
        let print_layer = |job: (u32, Option<LayerStart>)| {
            let i = job.0;
            let mut p = print_layer_raw(job);
            let (object, next) = match self.print.get(i as usize) {
                None => (Some(i), None),
                Some(pl) => (
                    pl.object,
                    self.print
                        .get(i as usize..)
                        .and_then(|r| r.iter().find_map(|l| l.object)),
                ),
            };
            self.stamp_owners(&mut p, object, next, config.support.base_spacing);
            p
        };
        // The first layer's area and outlines are worked out next to the layers' paths.
        let path_done = std::sync::atomic::AtomicUsize::new(0);
        let path_total = jobs.len();
        let (mut out_layers, first_layer_info) = par::join(
            || {
                par::map_owned(jobs, |job| {
                    let p = print_layer(job);
                    tick(Stage::Paths, &path_done, path_total);
                    p
                })
            },
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
            below_end = below.exit_point();
            below_wipe = below.wipe_tail();
            // An empty layer below leaves the nozzle where the last layer with paths ended, as one range over
            // the whole plate carries it up.
            if below.paths.is_empty() && layers.start > 0 {
                (below_end, below_wipe) = self.end_below(config, layers.start)?;
            }
        }
        for l in &mut out_layers {
            l.enter_from = below_end;
            below_end = l.exit_point().or(below_end);
            let tail = l.wipe_tail();
            l.below_wipe = if tail.points.is_empty() {
                below_wipe.clone()
            } else {
                std::mem::replace(&mut below_wipe, tail)
            };
        }
        let mut warnings = self.warnings.clone();
        warnings.extend(self.skirt_note(&out_layers)?);
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
            prime_tower: self.tower_top.and(self.tower_shape).and_then(|p| {
                let t = self.tower(config)?.at(p.origin);
                Some(p.report(&t, self.plan.thickness(0), self.plan.top(self.tower_top?)))
            }),
            vary_layer_cost: self.vary_cost,
            filament_map: self.nozzle_map.clone(),
            collisions: crate::collide::Hits::default(),
            chamber: None,
            raised_wall: None,
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
                bridges: micros.bridges.load(Ordering::Relaxed),
                seams: micros.seams.load(Ordering::Relaxed),
            },
            warnings,
        })
    }

    /// The note for a skirt cut to the bed on any of `layers`, naming the object it was cut beside, or the refusal when
    /// less than one whole loop of it is left on the bed.
    fn skirt_note(&self, layers: &[LayerPaths]) -> Result<Option<SliceWarning>> {
        let mut cuts = layers.iter().filter_map(|l| l.skirt_cut.map(|c| (l.index, c)));
        let Some((layer, first)) = cuts.next() else {
            return Ok(None);
        };
        if let Some((_, short)) = std::iter::once((layer, first)).chain(cuts).find(|(_, c)| c.short) {
            let name = crate::preflight::nearest_name(&self.objects, short.at);
            return Err(Error::Blocked(format!(
                "the skirt round {name} does not fit on the bed: less than one full loop of it is left inside the \
                 printable area; move {name} in from the edge, or lower the skirt distance"
            )));
        }
        let name = crate::preflight::nearest_name(&self.objects, first.at);
        Ok(Some(SliceWarning {
            code: WarningCode::OutsideBed,
            message: format!("The skirt near {name} was cut to fit on the bed"),
            layer: Some(layer),
        }))
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
    /// the way color paint splits it (Orca runs the color segmentation on the fuzzy skin
    /// facets), the painted pieces together. `None` with no fuzzy paint here.
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
                .flat_map(|(t, _)| t.map(|v| v[2]))
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
            let painted = facets.with_state(1);
            let ctx = crate::paint::LayerPaint {
                default_slot: 0,
                shapes: &shapes,
                layer,
                z,
                plan: &self.plan,
                above: &[],
                below: &[],
                facets: &[&painted],
                step: 0,
                small: 0,
                memo: None,
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

    /// The painted support regions of one kind on every layer: painted pieces that face down, each
    /// given to the first layer cut above it, where the layer's outline first reaches over it (the
    /// overhang the support planners look at), and looked at from above. Kept only where that
    /// layer's own slab held it, an underside lying in the upper half of the layer below was dropped,
    /// and the support it asked for was never printed.
    fn painted_support_layers(&self, state: u8) -> Vec<Shapes> {
        let n = self.plan.count() as usize;
        let planes = &self.plan.slice_z;
        let mut pieces: Vec<Vec<Shapes>> = vec![Vec::new(); n];
        for (tri, _) in self.painted_supports.iter().filter(|(_, s)| *s == state) {
            let (a, b, c) = (tri[0], tri[1], tri[2]);
            let nz = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
            if nz >= 0.0 {
                continue;
            }
            let zs = [a[2], b[2], c[2]];
            let (lo, hi) = (
                zs.iter().copied().fold(f64::MAX, f64::min),
                zs.iter().copied().fold(f64::MIN, f64::max),
            );
            // A point on a cutting plane counts as above it, as the slicer cuts the mesh: the layer cut
            // there still has the outline below it.
            let first = planes
                .partition_point(|&p| crate::layers::on_or_above(lo, p))
                .min(n);
            for l in first..n {
                let below = l
                    .checked_sub(1)
                    .and_then(|k| planes.get(k))
                    .copied()
                    .unwrap_or(f64::MIN);
                if crate::layers::on_or_above(below, hi) && l > first {
                    break;
                }
                let Some(&plane) = planes.get(l) else { break };
                let poly = clip_to_slab(tri, below, plane);
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
                // The surface is pulled in half a spacing (the fill overlap is 0) before the pattern sees it, as in
                // OrcaSlicer.
                let pulled = perimeters::offset(area, -mm(0.5 * cfg.spacing_for(cfg.sparse_infill_width())));
                let area = if pulled.is_empty() { area } else { &pulled };
                let lines = self
                    .lightning_layers(cfg)
                    .get(layer as usize)
                    .map_or(&[][..], Vec::as_slice);
                // OrcaSlicer joins the clipped lightning lines along the wall.
                let spacing = cfg.spacing_for(cfg.sparse_infill_width());
                Some(crate::anchor::connect(
                    crate::lightning::clip(lines, area),
                    area,
                    crate::anchor::Params {
                        spacing,
                        anchor: crate::anchor::anchor_length(cfg, spacing),
                        anchor_max: cfg.anchor_max_mm(),
                        tongues: true,
                    },
                ))
            }
            InfillPattern::AdaptiveCubic | InfillPattern::SupportCubic => {
                let segments = self
                    .octree(cfg)
                    .map_or_else(Vec::new, |o| crate::adaptive::lines(o, self.plan.top(layer)));
                let lines: Vec<Vec<[f64; 2]>> = segments.into_iter().map(|s| s.to_vec()).collect();
                // OrcaSlicer joins the clipped adaptive cubic lines along the wall.
                let spacing = cfg.spacing_for(cfg.sparse_infill_width());
                Some(crate::anchor::connect(
                    crate::lightning::clip(&lines, area),
                    area,
                    crate::anchor::Params {
                        spacing,
                        anchor: crate::anchor::anchor_length(cfg, spacing),
                        anchor_max: cfg.anchor_max_mm(),
                        tongues: false,
                    },
                ))
            }
            _ => None,
        }
    }

    /// The region slices of every layer with the interlocking beams applied, planned once; None when
    /// the settings ask for none or the object has one filament.
    /// `hole_to_polyhole`: almost circular holes that
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

    /// `make_overhang_printable`: from the top down, each layer
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

    /// The seams of the whole object, planned once as Orca plans them: the outer wall of every layer
    /// is the slice pulled in half a line, scored and aligned over the object, with surface visibility
    /// from a raycast over the model when the mode reads it.
    fn seam_plan(
        &self,
        cfg: &PrintConfig,
        progress: Option<&dyn Progress>,
    ) -> Option<&crate::seamplan::Plan> {
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
                        let regions = self.whole_regions_with(fam, &micros, progress);
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

    /// The curled stretches of every layer's outer wall,
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
            // `lightning_engine` = `v2` picks the second planner; `lightning_parity` turns on its reference
            // output mode.
            if matches!(cfg.raw.get("lightning_engine"), Some(serde_json::Value::String(e)) if e == "v2") {
                let width = cfg.sparse_infill_width();
                let spacing = cfg.spacing_for(width);
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "clamped to 1..=10 first"
                )]
                let lines_per_branch = cfg.raw_number("fill_multiline", 1.0).round().clamp(1.0, 10.0) as u32;
                return crate::lightning2::plan(
                    &areas,
                    &crate::lightning2::Params {
                        line_width: width,
                        spacing,
                        junction_trim: 0.5 * spacing,
                        density_percent: cfg.sparse_infill_density,
                        lines_per_branch,
                        layer_height: self.plan.height,
                        thickness: (0..self.plan.count()).map(|l| self.plan.thickness(l)).collect(),
                        overhang_angle: ang("lightning_overhang_angle"),
                        prune_angle: ang("lightning_prune_angle"),
                        straighten_angle: ang("lightning_straightening_angle"),
                        quirks: if crate::firmware::truthy(cfg, "lightning_parity") {
                            crate::lightning2::Quirks::reference()
                        } else {
                            crate::lightning2::Quirks::default()
                        },
                    },
                );
            }
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

    /// `infill_combination`: the groups of layers whose sparse infill
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

    /// Slim, strong and hybrid trees, one support layer per object layer.
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
            // 0 is Orca's "support every bridge" for supports (the Bambu Lab presets ship it). With support off
            // there is no length to hold a bridge to, and Orca warns about no bridge, so 0 sets no limit here.
            max_bridge_mm: if cfg.support.max_bridge_length > 0.0 {
                cfg.support.max_bridge_length
            } else {
                f64::INFINITY
            },
            // The outer wall is the bead that prints along the edge of a ledge: one narrower than it rests on
            // the layer under it, as the next wall of any slope does.
            ledge_mm: cfg.outer_wall_width(),
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
        // The rest in one line each for bridges and for regions, so a long bridge is never counted as a region.
        let rest = found.get(SHOWN..).unwrap_or_default();
        let bridges = rest
            .iter()
            .filter(|f| f.kind == crate::floating::Kind::Bridge)
            .count();
        if rest.len() > bridges {
            out.push(SliceWarning {
                code: WarningCode::FloatingRegion,
                message: format!(
                    "{} more regions need support. Turn on supports or paint support there.",
                    rest.len() - bridges
                ),
                layer: None,
            });
        }
        if bridges > 0 {
            out.push(SliceWarning {
                code: WarningCode::LongBridge,
                message: format!(
                    "{bridges} more bridges are longer than the {:.0} mm max bridge length. Turn on supports, or slow bridges down and give them more fan.",
                    cfg.support.max_bridge_length
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

    /// The support parameters organic trees read, as Orca derives them.
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

    /// Organic trees, one support layer per object layer.
    fn organic_layers(&self, cfg: &PrintConfig, input: &SupportInput) -> crate::organic::OrganicPlan {
        let n = self.plan.count();
        let tops: Vec<f64> = (0..n).map(|l| self.plan.top(l)).collect();
        let sc = cfg.support_config();
        let s = &cfg.support;
        let independent = cfg.independent_support_layer_height();
        // The gaps between support and object, as OrcaSlicer sets them: zero with a zero gap interface, else the Z distance,
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
            first_layer_width: cfg.first_layer_support_width(),
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
    /// (Orca's loop interface and its support ironing pass). Orca builds its organic
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
            ..SupportPaths::default()
        }
    }

    /// The first layer area the brim takes, which organic support keeps out of, as in Orca.
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

    /// What the organic toolpaths read: the support parameters and flows.
    fn organic_paths_in(&self, cfg: &PrintConfig, center: [f64; 2]) -> crate::organic::paths::PathsIn {
        use crate::config::InterfacePattern as IP;
        use crate::organic::paths::ContactFill;
        let s = &cfg.support;
        let p = Self::organic_params(cfg);
        let first_width = cfg.first_layer_support_width();
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

    /// Organic trees from the v2 engine (`organic_support_engine: "v2"`); the default
    /// `legacy` keeps the existing engine.
    fn organic_v2(cfg: &PrintConfig) -> bool {
        crate::organic2::selected(cfg)
    }

    /// The v2 engine's settings, from the same values the existing engine reads.
    fn organic2_settings(cfg: &PrintConfig) -> crate::organic2::Settings {
        let s = &cfg.support;
        let t = &s.tree_settings;
        let independent = cfg.independent_support_layer_height();
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
        let w = cfg.support_width();
        let quirks = match cfg.raw.get("organic_quirks") {
            Some(serde_json::Value::String(q)) => crate::organic2::Quirks::parse(q),
            _ => crate::organic2::Quirks::default(),
        };
        crate::organic2::Settings {
            layer_height: cfg.layer_height,
            line_width: cfg.line_width,
            support_width: w,
            external_perimeter_width: cfg.outer_wall_width(),
            resolution: cfg.raw_number("resolution", 0.012),
            min_feature_size: cfg.raw_number("min_feature_size", 25.0) / 100.0 * cfg.nozzle_diameter,
            branch_angle: t.branch_angle_organic,
            angle_slow: t.angle_slow,
            branch_diameter: t.branch_diameter_organic,
            branch_diameter_angle: t.branch_diameter_angle,
            tip_diameter: t.tip_diameter,
            top_rate: t.top_rate,
            branch_distance: t.branch_distance_organic,
            first_layer_expansion: cfg.raw_number("raft_first_layer_expansion", 2.0).max(0.0),
            line_join: cfg.anchor_max_mm(),
            xy_distance: s.xy_distance,
            top_distance: if zero_top { 0.0 } else { gap(s.top_z_distance) },
            bottom_distance: if zero_bottom {
                0.0
            } else {
                gap(s.bottom_z_distance)
            },
            top_layers: s.interface_top_layers,
            bottom_layers: s.interface_bottom_layers,
            on_bed_only: s.on_build_plate_only,
            threshold_angle: s.threshold_angle,
            support_angle: s.angle,
            interface_spacing: s.interface_spacing,
            zero_top_gap: zero_top,
            raft_layers: 0,
            raft_expansion: cfg.raw_number("raft_expansion", 1.5),
            quirks,
        }
    }

    /// The walls and bottom-bridge surfaces of every region of `layer`, as the layer's own paths make them
    /// (`region_preps`), for the bridge removal of the v2 organic engine.
    #[allow(
        clippy::too_many_arguments,
        reason = "the slice's shared state, as region_preps takes it"
    )]
    fn organic2_regions<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
    ) -> Vec<crate::organic2::overhang::RegionIn> {
        let n = self.plan.count();
        let Some(here) = get(layer) else { return Vec::new() };
        let below: Option<Shapes> =
            layer
                .checked_sub(1)
                .and_then(get)
                .map(|r| match (&r.lslices, r.regions.as_slice()) {
                    (Some(foot), _) => foot.clone(),
                    (None, [(_, only)]) => only.clone(),
                    _ => perimeters::union_all(&r.regions.iter().map(|(_, s)| s).collect::<Vec<_>>()),
                });
        let upper = layer
            .checked_add(1)
            .filter(|&u| u < n)
            .and_then(get)
            .map(lower_shapes);
        let shell = self.shell_of(cfg);
        let preps = self.region_preps(
            layer,
            cfg,
            &shell,
            mods,
            get,
            below.as_ref(),
            upper.as_ref(),
            micros,
            tags,
            None,
        );
        let open = |ring: &[IntPoint<i32>]| -> Vec<IntPoint<i32>> {
            let mut pl = ring.to_vec();
            if let Some(&f) = pl.first() {
                pl.push(f);
            }
            pl
        };
        preps
            .iter()
            .enumerate()
            .filter_map(|(ri, prep)| {
                let prep = prep.as_ref()?;
                let rc = match here.region_cfg.get(ri).copied().unwrap_or(0) {
                    0 => cfg,
                    k => mods.get(usize::from(k) - 1).unwrap_or(cfg),
                };
                // Thin bridges leave the wall pieces over a gap in the overhang: the reference keeps the
                // support under them whole then (measured), so their bands have no width.
                let bridge = if rc.thick_bridges { rc.nozzle_diameter } else { 0.0 };
                let mut walls: Vec<Vec<IntPoint<i32>>> = Vec::new();
                for island in &prep.islands {
                    walls.extend(island.loops.iter().map(|(_, ring)| open(ring)));
                    walls.extend(island.wide.iter().filter(|l| !l.is_odd).map(|l| l.points.clone()));
                }
                Some(crate::organic2::overhang::RegionIn {
                    walls,
                    bridges: prep.cls.bridges.iter().map(|b| b.area.clone()).collect(),
                    bridge_width: bridge,
                    bridge_spacing: bridge,
                })
            })
            .collect()
    }

    /// Organic trees from the v2 engine, one support layer per object layer.
    fn organic2_layers(&self, cfg: &PrintConfig, input: &SupportInput) -> crate::organic2::Plan {
        let n = self.plan.count();
        let tops: Vec<f64> = (0..n).map(|l| self.plan.top(l)).collect();
        // What the layers' own paths read, for the walls and bridge surfaces of the layers with overhang.
        let micros = Micros::default();
        let whole = self.whole_regions(Families::new(cfg), &micros);
        let mods: Vec<PrintConfig> = self
            .modifier_settings()
            .into_iter()
            .filter_map(|o| {
                let mut c = cfg.clone();
                c.apply_value(o).ok()?;
                c.check().ok()?;
                Some(c)
            })
            .collect();
        let tags = Tags::of_all(std::iter::once(cfg).chain(&mods), self.tool_count);
        let get = |l: u32| whole.get(l as usize);
        let regions = |k: usize| -> Vec<crate::organic2::overhang::RegionIn> {
            u32::try_from(k).map_or_else(
                |_| Vec::new(),
                |l| self.organic2_regions(l, cfg, &mods, &get, &micros, &tags),
            )
        };
        let inp = crate::organic2::Input {
            models: &input.models,
            tops: &tops,
            force: &input.force,
            block: &input.block,
            bed: cfg.bed_rect(),
            center: input.center,
            settings: Self::organic2_settings(cfg),
            detect: {
                // The walls' bridge flow: a round bead of the nozzle with thick bridges, else the line.
                let bridge = if cfg.thick_bridges {
                    cfg.nozzle_diameter
                } else {
                    cfg.outer_wall_width()
                };
                crate::organic2::overhang::Detect {
                    manual: cfg.support.manual,
                    enforce_layers: cfg.support.enforce_layers as usize,
                    remove_small: cfg.support.remove_small_overhang,
                    critical_only: crate::firmware::truthy(cfg, "support_critical_regions_only"),
                    max_bridge: cfg.support.max_bridge_length,
                    bridge_width: bridge,
                    bridge_spacing: bridge,
                    outer_wall_width: cfg.outer_wall_width(),
                    inner_wall_spacing: cfg.spacing_for(cfg.inner_wall_width()),
                    wall_loops: cfg.wall_loops,
                    slice_z: self.plan.slice_z.clone(),
                }
            },
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
            raft_offset: self.raft.as_ref().map_or(0.0, |r| r.offset),
            raft_contact: self
                .raft
                .as_ref()
                .map(|r| r.area(crate::raft::Kind::Contact, &r.first_layer))
                .unwrap_or_default(),
            regions: Some(&regions),
        };
        crate::organic2::plan(&inp)
    }

    /// The v2 organic areas of a support layer of this session's plan, if it has them.
    fn organic2_for(&self, sl: &crate::support::SupportLayer) -> Option<&crate::organic2::Layer> {
        let areas = self.organic2.get()?;
        let k = self.support.get()?.iter().position(|x| std::ptr::eq(x, sl))?;
        areas.get(k).map(std::convert::AsRef::as_ref)
    }

    /// What the v2 organic toolpaths read.
    fn organic2_paths_in(
        cfg: &PrintConfig,
        center: [f64; 2],
        first_height: f64,
    ) -> crate::organic2::paths::PathsIn {
        let s = &cfg.support;
        let w = cfg.support_width();
        let spacing = cfg.spacing_for(w);
        let first_width = cfg.first_layer_support_width();
        let pattern = match cfg.raw.get("support_base_pattern") {
            Some(serde_json::Value::String(t)) => t.clone(),
            _ => "default".to_string(),
        };
        let top = s.interface_top_layers;
        let support_density = (spacing / (s.base_spacing + spacing)).min(1.0);
        let top_interface_density = if top == 0 {
            support_density
        } else {
            (spacing / (if s.ironing { 0.0 } else { s.interface_spacing } + spacing)).min(1.0)
        };
        crate::organic2::paths::PathsIn {
            width: w,
            spacing,
            first_spacing: (first_width - first_height * (1.0 - std::f64::consts::FRAC_PI_4))
                .max(first_width * 0.5),
            first_density: (cfg.raw_number("raft_first_layer_density", 90.0) / 100.0).clamp(0.01, 1.0),
            support_density,
            top_interface_density,
            bottom_interface_density: (spacing / (s.bottom_interface_spacing + spacing)).min(1.0),
            angle: s.angle,
            wall_count: s.tree_settings.wall_count,
            hollow: matches!(pattern.as_str(), "default" | "hollow" | "none"),
            join: cfg.anchor_max_mm(),
            center,
        }
    }

    /// The paths of a v2 organic layer, with the contact loops and support ironing of the top
    /// contact as on the other organic layers.
    fn organic2_support_paths(
        &self,
        cfg: &PrintConfig,
        o: &crate::organic2::Layer,
        index: u32,
        z: f64,
        center: [f64; 2],
    ) -> SupportPaths {
        let s = &cfg.support;
        let wmm = cfg.support_width();
        let p = Self::organic2_paths_in(cfg, center, self.plan.thickness(0));
        let mut iron = Vec::new();
        if s.ironing && s.interface_top_layers > 0 && !o.top_contact.is_empty() {
            let gap = s.ironing_spacing.max(0.01);
            iron = if s.ironing_concentric {
                crate::surface::fill(&o.top_contact, crate::surface::Curve::Concentric, gap, 0.0)
            } else {
                crate::patterns::support_lines(
                    &o.top_contact,
                    gap,
                    gap,
                    s.angle + 90.0,
                    false,
                    3.0 * gap,
                    center,
                )
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
        // Over a raft no support layer is the print's first.
        let first = index == 0;
        let (support, mut interface) = crate::organic2::paths::layer_paths(layer_in, first, z, &p);
        loops.append(&mut interface);
        SupportPaths {
            support,
            interface: loops,
            ironing: iron,
            ..SupportPaths::default()
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
        if Self::is_organic(cfg) && Self::organic_v2(cfg) {
            let plan = self.organic2_layers(cfg, input);
            let (layers, areas): (Vec<crate::support::SupportLayer>, Vec<_>) = plan
                .layers
                .into_iter()
                .map(crate::organic2::Layer::into_support)
                .unzip();
            let _ = self.organic2.set(areas);
            return (layers, Some(plan.raft));
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

    /// How many support layers under support layer `layer` print interface: the interface
    /// count that turns the interface lines of snug supports between layers, as in Orca.
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
    /// index (layer 0 prints the first-layer pad) and `z` the plane the object was cut at, as
    /// Orca prints support.
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
        if let Some(o) = self.organic2_for(sl) {
            return self.organic2_support_paths(cfg, o, layer, z, center);
        }
        if let Some(t) = &sl.classic {
            return self.classic_tree_paths(cfg, t, layer, center);
        }
        if let Some(o) = &sl.organic {
            return self.organic_support_paths(cfg, o, layer, center);
        }
        if !sl.on_part.is_empty() {
            // Where the layer rests on a top surface of the part it is filled on its own, the same way, so those
            // lines can print as round beads.
            let cut = |a: &Shapes, keep: bool| {
                if a.is_empty() {
                    Vec::new()
                } else if keep {
                    perimeters::intersection(a, &sl.on_part)
                } else {
                    perimeters::difference(a, &sl.on_part)
                }
            };
            let part = |keep: bool| crate::support::SupportLayer {
                base: cut(&sl.base, keep),
                interface: cut(&sl.interface, keep),
                normal: cut(&sl.normal, keep),
                contact: cut(&sl.contact, keep),
                hang: sl.hang.clone(),
                bottom: cut(&sl.bottom, keep),
                ..crate::support::SupportLayer::default()
            };
            let mut out = self.support_paths(cfg, &part(false), layer, z);
            let on = self.support_paths(cfg, &part(true), layer, z);
            out.round = on.support;
            out.round_interface = on.interface;
            out.ironing.extend(on.ironing);
            return out;
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
            // OrcaSlicer's support base: rows at `support_angle` joined along the outline;
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
        // which the top interface density picks, as in OrcaSlicer.
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

    /// The toolpaths of a slim, strong or hybrid tree layer.
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
        let first_w = cfg.first_layer_support_width();
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
    /// every support layer, mm, as Orca fills tree support with
    /// lightning: each layer with support and another below it hands the layer below its
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
    /// `raft_first_layer_density` across the base lines (Orca's raft
    /// base and its base flange).
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
        self.whole_regions_with(fam, micros, None)
    }

    /// [`Self::whole_regions`], reporting [`Stage::Layers`] from [`LAYERS_LATE_PLANS`] to [`LAYERS_SEAM_PLAN`] as
    /// the layers are cut, when there is a `progress` and they are not cut yet.
    fn whole_regions_with(
        &self,
        fam: Families,
        micros: &Micros,
        progress: Option<&dyn Progress>,
    ) -> std::sync::Arc<Vec<LayerRegions>> {
        if let Ok(g) = self.whole.0.lock()
            && let Some((f, r)) = g.as_ref()
            && *f == fam
        {
            return std::sync::Arc::clone(r);
        }
        // Every layer below reads the interlocking beams, which plan in parallel: planned here first, not
        // inside the layer jobs (the rule in `par`).
        self.interlocked(fam, fam, micros);
        let n = self.plan.count();
        let done = std::sync::atomic::AtomicUsize::new(0);
        let all = std::sync::Arc::new(par::map_range(0..n, |l| {
            let r = self.layer_regions(l, fam, micros);
            if let Some(p) = progress {
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                #[allow(clippy::cast_precision_loss, reason = "a progress fraction")]
                let f = d as f32 / n as f32;
                p.report(
                    Stage::Layers,
                    LAYERS_LATE_PLANS + (LAYERS_SEAM_PLAN - LAYERS_LATE_PLANS) * f,
                );
            }
            r
        }));
        if let Ok(mut g) = self.whole.0.lock() {
            *g = Some((fam, std::sync::Arc::clone(&all)));
        }
        all
    }

    /// The regions [`Self::whole_regions`] cut with `fam`, one slot per layer, given up by the session. A plate
    /// with painted parts keeps them instead, and every layer range reads them (`kept_regions`).
    fn take_whole(&self, fam: Families) -> Vec<Option<LayerRegions>> {
        if self.parts.iter().any(|p| !p.paint.is_empty()) {
            return Vec::new();
        }
        let kept = self.whole.0.lock().ok().and_then(|mut g| g.take());
        match kept {
            Some((f, all)) if f == fam => match std::sync::Arc::try_unwrap(all) {
                Ok(v) => v.into_iter().map(Some).collect(),
                Err(_) => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// Whether the session keeps the regions [`Self::whole_regions`] cut with `fam` for every range (a plate with
    /// painted parts), so the whole-object plans that read them cut no layer.
    fn keeps_whole(&self, fam: Families) -> bool {
        self.parts.iter().any(|p| !p.paint.is_empty())
            && self
                .whole
                .0
                .lock()
                .is_ok_and(|g| g.as_ref().is_some_and(|(f, _)| *f == fam))
    }

    /// A copy of layer `layer`'s regions from [`Self::whole_regions`] when a part is painted and they were cut
    /// the way `fam` cuts: cutting a painted layer is the dearest part of a slice, and every range of layers and
    /// the first layer's plans read the layers again.
    fn kept_regions(&self, layer: u32, fam: Families) -> Option<LayerRegions> {
        if self.parts.iter().all(|p| p.paint.is_empty()) {
            return None;
        }
        let all = {
            let g = self.whole.0.lock().ok()?;
            let (f, all) = g.as_ref()?;
            (f.cut() == fam.cut()).then(|| std::sync::Arc::clone(all))?
        };
        all.get(layer as usize).cloned()
    }

    /// The slices of the layer before beam interlocking (`base`), or the regions the layer prints.
    fn layer_regions_with(&self, layer: u32, fam: Families, micros: &Micros, base: bool) -> LayerRegions {
        if !base && let Some(r) = self.kept_regions(layer, fam) {
            return r;
        }
        let t = Timer::start();
        let z = self.plan.slice_z.get(layer as usize).copied().unwrap_or(0.0);
        let mut open_chains = 0;
        let mut regions: Vec<(u8, Shapes)> = Vec::with_capacity(self.slots.len());
        let mut loops: Vec<Polygon> = Vec::new();
        // Painted parts split into color regions; their pieces join the plain parts of the same slot.
        let mut painted: Vec<(u8, Shapes)> = Vec::new();
        // A painted part shows more than its own filament on this layer: the regions drop the specks that the
        // booleans leave where colors meet (`LayerRegions::drop_specks`).
        let mut colors = false;
        let cut: crate::paint::CutKey = (fam.resolution, fam.slicing, fam.closing);
        let in_painted: Vec<bool> = {
            let mut v = vec![false; self.parts.len()];
            for o in &self.painted_objects {
                for &k in &o.parts {
                    if let Some(f) = v.get_mut(k) {
                        *f = true;
                    }
                }
            }
            v
        };
        for (o, obj) in self.painted_objects.iter().enumerate() {
            // Each part's outline, then their union: the outline the paint splits (Bambu Studio's color segmentation
            // works on the object's merged layer outline, so a face where two parts meet is not on it).
            let mut own: Vec<(u8, Shapes)> = Vec::with_capacity(obj.parts.len());
            for &k in &obj.parts {
                let Some(p) = self.parts.get(k) else { continue };
                loops.clear();
                open_chains += p.slice(layer as usize, z, &mut loops);
                if loops.is_empty() {
                    continue;
                }
                own.push((
                    p.slot,
                    perimeters::shapes_from_loops_mode(&loops, fam.resolution, fam.slicing, fam.closing),
                ));
            }
            if own.is_empty() {
                continue;
            }
            let merged = if own.len() == 1 {
                own.first().map(|(_, s)| s.clone()).unwrap_or_default()
            } else {
                perimeters::union_all(&own.iter().map(|(_, s)| s).collect::<Vec<_>>())
            };
            // The layers around read the whole plate's outline: a painted face another part covers is no surface.
            let contour_at = |l: i64| -> Shapes {
                u32::try_from(l)
                    .map(|l| (*self.plate_outline(l, cut)).clone())
                    .unwrap_or_default()
            };
            let l = i64::from(layer);
            let step = |j: usize| i64::try_from(j).unwrap_or(i64::MAX / 2);
            // Each outline is cut once for the session (a memo entry). Asked for together, the outlines of the layers
            // around are cut side by side, unless this layer is itself cut inside a memo entry's work.
            let around: Vec<i64> = (1..=fam.top_shell)
                .map(|j| l + step(j))
                .chain((1..=fam.bottom_shell).map(|j| l - step(j)))
                .collect();
            let mut above: Vec<Shapes> = par::map(&around, |&m| contour_at(m));
            let below: Vec<Shapes> = above.split_off(fam.top_shell.min(above.len()));
            // Slot 0 marks what no paint claims; the parts' own filaments take it below.
            let facets: Vec<&crate::paint::Facets> = obj
                .parts
                .iter()
                .filter_map(|&k| self.parts.get(k).map(|p| &p.paint))
                .filter(|f| !f.is_empty())
                .collect();
            let ctx = crate::paint::LayerPaint {
                default_slot: 0,
                shapes: &merged,
                layer,
                z,
                plan: &self.plan,
                above: &above,
                below: &below,
                facets: &facets,
                step: fam.paint_step,
                small: fam.paint_small,
                memo: Some((&self.paint, self.parts.len() + o, cut)),
            };
            let split = ctx.split();
            let mut free: Vec<Shapes> = Vec::new();
            let mut colored: Vec<(u8, Shapes)> = Vec::new();
            for (slot, sh) in split {
                if slot == 0 {
                    free.push(sh);
                } else {
                    colored.push((slot, sh));
                }
            }
            // `mmu_segmented_region_max_width`: painted colors reach only this far
            // in from the outline, the rest is the parts' own filaments; with an interlocking depth, even layers
            // use that depth instead, so the colors interlock.
            let (width, depth) = fam.paint_band;
            let band = if layer.is_multiple_of(2) && depth > 0 {
                depth
            } else {
                width
            };
            if band > 0 && !colored.is_empty() {
                let core = perimeters::offset(&merged, -band);
                for (_, sh) in &mut colored {
                    free.push(perimeters::intersection(sh, &core));
                    *sh = perimeters::difference(sh, &core);
                }
            }
            colored.retain(|(_, sh)| !sh.is_empty());
            let free = match free.len() {
                0 => Vec::new(),
                1 => free.pop().unwrap_or_default(),
                _ => perimeters::union_all(&free.iter().collect::<Vec<_>>()),
            };
            // What no paint claims prints in the filament of the part it lies in. Paint, whatever part it lies in,
            // joins the other areas of its filament as one region (Bambu Studio prints a filament painted across
            // several parts as one region, walled only where the filament changes).
            let mut pieces = colored;
            if !free.is_empty() {
                if own.len() == 1 {
                    if let Some((slot, _)) = own.first() {
                        pieces.push((*slot, free));
                    }
                } else {
                    for (slot, sh) in &own {
                        let piece = perimeters::intersection(&free, sh);
                        if !piece.is_empty() {
                            pieces.push((*slot, piece));
                        }
                    }
                }
            }
            let first = pieces.first().map(|(s, _)| *s);
            if pieces.iter().any(|(slot, _)| Some(*slot) != first) {
                colors = true;
                for (_, sh) in &mut pieces {
                    *sh = perimeters::union_min_area(&[sh], crate::paint::SPECK);
                }
                pieces.retain(|(_, sh)| !sh.is_empty());
            }
            painted.extend(pieces);
        }
        for &slot in &self.slots {
            loops.clear();
            for (_, p) in self
                .parts
                .iter()
                .enumerate()
                .filter(|(k, p)| p.slot == slot && !in_painted.get(*k).copied().unwrap_or(false))
            {
                open_chains += p.slice(layer as usize, z, &mut loops);
            }
            let mut shapes = if loops.is_empty() {
                Vec::new()
            } else {
                perimeters::shapes_from_loops_mode(&loops, fam.resolution, fam.slicing, fam.closing)
            };
            let extra: Vec<&Shapes> = painted
                .iter()
                .filter(|(s, _)| *s == slot)
                .map(|(_, sh)| sh)
                .collect();
            if colors && !extra.is_empty() {
                let mut all = vec![&shapes];
                all.extend(extra);
                shapes = perimeters::union_min_area(&all, crate::paint::SPECK);
            } else {
                for e in extra {
                    shapes = if shapes.is_empty() {
                        e.clone()
                    } else {
                        perimeters::union_all(&[&shapes, e])
                    };
                }
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
                let clipped = if colors {
                    perimeters::difference_min_area(s, &clip, crate::paint::SPECK)
                } else {
                    perimeters::difference(s, &clip)
                };
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
            let mut out = LayerRegions {
                region_cfg: vec![0; regions.len()],
                regions,
                open_chains,
                raw,
                lslices,
                union: std::sync::OnceLock::new(),
                lift_hang: LiftHang::default(),
            };
            if colors {
                out.drop_specks();
            }
            return out;
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
        let mut out = LayerRegions {
            regions,
            region_cfg,
            open_chains,
            raw,
            lslices,
            union: std::sync::OnceLock::new(),
            lift_hang: LiftHang::default(),
        };
        if colors {
            out.drop_specks();
        }
        Micros::add(&micros.contours, &t);
        out
    }

    /// Every part's outline on `layer` together, cut once (kept under the index after the last part).
    fn plate_outline(&self, layer: u32, cut: crate::paint::CutKey) -> std::sync::Arc<Shapes> {
        self.paint.outline(self.parts.len(), layer, cut, || {
            (0..self.parts.len()).fold(Vec::new(), |all, k| {
                perimeters::union_all(&[&all, &self.painted_outline(k, layer, cut)])
            })
        })
    }

    /// The outline of painted part `k` on `layer`, cut once (`paint::Cache::outline`).
    fn painted_outline(&self, k: usize, layer: u32, cut: crate::paint::CutKey) -> std::sync::Arc<Shapes> {
        self.paint.outline(k, layer, cut, || {
            let (Some(p), Some(&z)) = (self.parts.get(k), self.plan.slice_z.get(layer as usize)) else {
                return Vec::new();
            };
            let mut loops: Vec<Polygon> = Vec::new();
            p.slice(layer as usize, z, &mut loops);
            perimeters::shapes_from_loops_mode(&loops, cut.0, cut.1, cut.2)
        })
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

    /// A layer of several regions: its regions' walls and classes go through the session's memo
    /// ([`Self::shared_preps`]), read by the layer itself and by the bridge facts of the layers around it.
    fn several(&self, here: &LayerRegions) -> bool {
        self.vase.is_none() && here.regions.iter().filter(|(_, s)| !s.is_empty()).count() > 1
    }

    /// The walls, infill area and surface classes of the regions of layer `layer`, a layer of several regions
    /// ([`Self::several`]), with the settings `cfg`, worked out once for the session.
    fn shared_preps<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
    ) -> std::sync::Arc<Vec<Option<RegionPrep>>> {
        self.cache.regions(i64::from(layer), tags.of(cfg), || {
            self.several_preps(layer, cfg, mods, get, micros, tags)
        })
    }

    /// [`Self::shared_preps`] worked out.
    fn several_preps<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
    ) -> Vec<Option<RegionPrep>> {
        let upper = layer
            .checked_add(1)
            .filter(|&u| u < self.plan.count())
            .and_then(get)
            .map(lower_shapes);
        let below = layer
            .checked_sub(1)
            .and_then(get)
            .map(|r| match (&r.lslices, r.regions.as_slice()) {
                (Some(foot), _) => foot.clone(),
                (None, [(_, only)]) => only.clone(),
                _ => perimeters::union_all(&r.regions.iter().map(|(_, s)| s).collect::<Vec<_>>()),
            });
        let shell = self.shell_of(cfg);
        self.region_preps(
            layer,
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
    }

    /// Works out the [`Self::shared_preps`] that the layers `layers` will read (each with its settings from
    /// `cfg_of`), before the layer jobs start. Inside a layer job they are worked out under a claim on the
    /// session's memo, where the parallel helpers run as plain loops (the rule in `par`), so the regions of a
    /// layer would be walled one after another on one thread, and the bridge facts of the layer above wait
    /// for them. Here no claim is held: the layers and their regions are worked out side by side, and the
    /// memo takes the results over.
    #[allow(
        clippy::too_many_arguments,
        reason = "the layers, their settings and the slice's shared state"
    )]
    fn plan_shared_preps<'a, 'c>(
        &self,
        layers: impl Iterator<Item = u32>,
        cfg_of: &dyn Fn(u32) -> &'c PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
    ) {
        if self.vase.is_some() {
            return;
        }
        let n = self.plan.count();
        let several = |l: u32| get(l).is_some_and(|r| self.several(r));
        let mut wanted: Vec<(u32, &'c PrintConfig)> = Vec::new();
        for l in layers {
            let cfg = cfg_of(l);
            // The layer's own regions, then the facts its bridges read (`layer_start`): this layer's and the
            // ones just below and above it, worked out with this layer's settings.
            let bridged = l >= 1 && cfg.sparse_infill_density > 0.0 && self.shell_of(cfg).top_n > 0;
            let reads = [Some(l), l.checked_sub(1), l.checked_add(1).filter(|&u| u < n)];
            for m in reads.into_iter().flatten().take(if bridged { 3 } else { 1 }) {
                if several(m) && !wanted.iter().any(|&(w, c)| w == m && tags.of(c) == tags.of(cfg)) {
                    wanted.push((m, cfg));
                }
            }
        }
        wanted.retain(|&(m, cfg)| !self.cache.has_regions(i64::from(m), tags.of(cfg)));
        let preps = par::map(&wanted, |&(m, cfg)| {
            self.several_preps(m, cfg, mods, get, micros, tags)
        });
        for ((m, cfg), p) in wanted.into_iter().zip(preps) {
            let _ = self.cache.regions(i64::from(m), tags.of(cfg), || p);
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
        // Regions of one filament whose walls are set alike share their walls, as in Orca: a
        // modifier that only changes the infill does not put walls along its boundary. Walls on other
        // filaments (a modifier's own wall filament) are set apart: shared, they would print on the filament
        // of the region that walls the group.
        let key_of = |j: usize, slot: u8| {
            let c = region_config(j);
            let t = self.feature_tools(c, slot);
            (wall_key(c), t.outer, t.inner)
        };
        let group_of = |ri: usize| -> Vec<usize> {
            let Some((slot, _)) = here.regions.get(ri) else {
                return Vec::new();
            };
            let key = key_of(ri, *slot);
            (0..here.regions.len())
                .filter(|&j| {
                    here.regions
                        .get(j)
                        .is_some_and(|(sl, sh)| sl == slot && !sh.is_empty())
                        && key_of(j, *slot) == key
                })
                .collect()
        };
        // One region: what it prints, and the infill area of its group's walls when it walls the group (the
        // other regions of the group read that from `group_inner`).
        let prep = |ri: usize, group_inner: &[Option<Shapes>]| -> (Option<RegionPrep>, Option<Shapes>) {
            let Some((slot, shapes)) = here.regions.get(ri) else {
                return (None, None);
            };
            if shapes.is_empty() {
                return (None, None);
            }
            let mut walled_group = None;
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
            // The first and the last layer's own walls use `top_bottom_infill_wall_overlap` (as OrcaSlicer's
            // walls do with no layer above, and on layer 0). The neighbors' infill areas, which the
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
            // A layer taken down to one wall keeps the outer wall of its part (`island_walls`).
            let mut one_wall_layer = false;
            if layer == 0 && self.raft.is_none() && cfg.only_one_wall_first_layer {
                one_wall_layer = loops > 1;
                loops = loops.min(1);
            }
            // The topmost layer is one wall, so its top surface reaches the outer wall.
            if crate::tower::flag(cfg, "only_one_wall_top") && layer + 1 == n && loops > 0 {
                one_wall_layer |= loops > 1;
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
            let group = group_of(ri);
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
                            one_wall_layer,
                        );
                        walled_group = Some(inner.clone());
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
                        one_wall_layer,
                    );
                    (islands, perimeters::union_all(&[&inner, &counterbore]))
                }
                _ => {
                    // The walls of the whole outline without the top context, shared with the layers around.
                    let shared = self.cache_for_walls().filter(|_| {
                        loops == cfg.wall_loops && !top_or_bottom && *shapes == slice_shapes(here)
                    });
                    let memo = |c: &crate::shells::Cache| {
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
                    };
                    // unchanged classic regions can share walls that do not read the top context.
                    let whole = shared
                        .filter(|_| {
                            top_ctx.as_ref().is_none_or(|top| {
                                !cfg.arachne_walls()
                                    && !perimeters::classic_top_candidate(cfg, shapes, w, own_overlap, top)
                            })
                        })
                        .and_then(memo);
                    let fresh = || {
                        perimeters::walls_for_top(
                            cfg,
                            shapes,
                            loops,
                            w,
                            own_overlap,
                            layer_height,
                            top_or_bottom,
                            top_ctx.as_ref(),
                            one_wall_layer,
                        )
                    };
                    // Arachne regions whose islands get no one-wall top run share them too.
                    let reused = std::cell::Cell::new(whole.is_some());
                    let walls = match (&whole, shared, top_ctx.as_ref()) {
                        (Some(v), ..) => (**v).clone(),
                        (None, Some(c), Some(top)) if cfg.arachne_walls() => crate::arachne::island_walls_or(
                            shapes,
                            cfg,
                            loops,
                            own_overlap,
                            layer_height,
                            top_or_bottom,
                            Some(top),
                            one_wall_layer,
                            Some(&|| {
                                reused.set(true);
                                memo(c).map(|v| (*v).clone())
                            }),
                        ),
                        _ => fresh(),
                    };
                    #[cfg(test)]
                    crate::walls_oracle::check(layer, &walls, reused.get(), top_ctx.is_some(), || {
                        if cfg.arachne_walls() {
                            crate::arachne::reference::island_walls(
                                shapes,
                                cfg,
                                loops,
                                own_overlap,
                                layer_height,
                                top_or_bottom,
                                top_ctx.as_ref(),
                                one_wall_layer,
                            )
                        } else {
                            fresh()
                        }
                    });
                    walls
                }
            };
            Micros::add(&micros.perimeters, &t);
            // What each part of the infill area is (classify.rs).
            // `interface_shells`: with several filaments in the object, a region's
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
            (
                Some(RegionPrep {
                    islands,
                    inner,
                    cls,
                    known: known.is_some(),
                }),
                walled_group,
            )
        };
        let count = here.regions.len();
        // Regions that share no walls are worked out side by side; a group's other regions wait for its walls.
        if (0..count).all(|ri| group_of(ri).len() < 2) {
            let count = u32::try_from(count).unwrap_or(u32::MAX);
            return par::map_range(0..count, |ri| prep(ri as usize, &[]).0);
        }
        let mut group_inner: Vec<Option<Shapes>> = vec![None; count];
        let mut out = Vec::with_capacity(count);
        for ri in 0..count {
            let (p, walled) = prep(ri, &group_inner);
            if let (Some(w), Some(slot)) = (walled, group_inner.get_mut(ri)) {
                *slot = Some(w);
            }
            out.push(p);
        }
        out
    }

    /// Stages 3 to 6 for one layer. `tags` holds the settings tags of the slice's configs; `entry` is where a
    /// spiral vase's layer starts from ([`Self::vase_entry`]).
    #[allow(
        clippy::too_many_arguments,
        reason = "the layer, its settings and the slice's shared state"
    )]
    fn layer_paths<'a>(
        &self,
        layer: u32,
        cfg: &PrintConfig,
        mods: &[PrintConfig],
        get: &(dyn Fn(u32) -> Option<&'a LayerRegions> + Sync),
        micros: &Micros,
        tags: &Tags<'_>,
        entry: Option<crate::geom::Point>,
    ) -> LayerPaths {
        self.layer_paths_with(layer, cfg, mods, get, micros, tags, true, entry)
    }

    /// Spiral vase mode: where each solid base layer ends, each planned from where the layer below it ended
    /// (`plan(layer, entry)`), worked out in order once per config for every range of layers to read. A base
    /// layer's walls start nearest the end of the layer below, and the spiral nearest the end of the last.
    fn vase_exits(
        &self,
        config: &PrintConfig,
        base: u32,
        plan: impl Fn(u32, Option<crate::geom::Point>) -> LayerPaths,
    ) -> BaseExits {
        let tag = settings_tag(config);
        if let Ok(g) = self.vase_exits.0.lock()
            && let Some((t, v)) = g.as_ref()
            && *t == tag
        {
            return std::sync::Arc::clone(v);
        }
        // Worked out with no lock held: two ranges that ask at once each plan the same layers.
        let mut exits: Vec<Option<crate::geom::Point>> = Vec::with_capacity(base as usize);
        let mut entry = None;
        for layer in 0..base {
            let end = plan(layer, entry).exit_point().or(entry);
            exits.push(end);
            entry = end;
        }
        let v = std::sync::Arc::new(exits);
        if let Ok(mut g) = self.vase_exits.0.lock() {
            *g = Some((tag, std::sync::Arc::clone(&v)));
        }
        v
    }

    /// Where object layer `layer` of a spiral vase starts from: the end of the base layer below it, and for the
    /// spiral the end of the last base layer. None for the first layer and for other prints.
    fn vase_entry(
        &self,
        exits: Option<&[Option<crate::geom::Point>]>,
        layer: u32,
    ) -> Option<crate::geom::Point> {
        let base = self.vase?;
        let below = layer.min(base).checked_sub(1)?;
        exits?.get(below as usize).copied().flatten()
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
        entry: Option<crate::geom::Point>,
    ) -> LayerPaths {
        let start = self.layer_start(layer, cfg, mods, get, micros, tags);
        self.layer_finish(start, layer, cfg, mods, get, micros, tags, smooth, entry)
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
        let bridges_timer = OwnTimer::start();
        let bridges_on = cfg.sparse_infill_density > 0.0 && base_shell.top_n > 0;
        // A floating vertical shell (vshell.rs) reads the sparse infill of the layer below from the same facts.
        let floating_on = crate::vshell::wanted(cfg, mods);
        let (bridges, lower_facts): (
            Option<crate::bridging::LayerBridges>,
            Option<std::sync::Arc<crate::bridging::Facts>>,
        ) = if layer >= 1 && (bridges_on || floating_on) {
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
            // The facts of layer `l`, worked out once for the session.
            let shared_facts = |l: i64| -> Option<Arc<crate::bridging::Facts>> {
                self.cache.facts(l, cfg_tag, || {
                    let lu = u32::try_from(l).ok()?;
                    let here = get(lu)?;
                    // A layer of several regions: its facts are its regions' own classes put together, as OrcaSlicer
                    // reads each region's fill surfaces for its internal bridges.
                    if self.several(here) {
                        let preps = self.shared_preps(lu, cfg, mods, get, micros, tags);
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
                })
            };
            let facts = |l: i64| -> Option<Arc<crate::bridging::Facts>> {
                if let Some(f) = facts_cache.borrow().get(&l) {
                    return f.clone();
                }
                let f = shared_facts(l);
                facts_cache.borrow_mut().insert(l, f.clone());
                f
            };
            let layer_bridges = if bridges_on {
                let print_z = |l: i64| -> f64 { u32::try_from(l).map_or(0.0, |u| self.plan.top(u)) };
                let ratio = crate::motion::raw_f(cfg, "bridge_flow").unwrap_or(1.0);
                let thick = crate::tower::flag_or(cfg, "thick_internal_bridges", true);
                let nominal = bridge_nominal(cfg, thick);
                let bead = crate::overhang::bridge_bead(nominal, self.plan.thickness(layer), ratio, thick);
                let (thick, width) = (bead.round, bead.width);
                // `internal_bridge_density`: the strands sit 1 over the density closer than the flow's spacing.
                let density = bridge_density(cfg, "internal_bridge_density");
                let spacing = bead.spacing / density;
                let stretch = stretch_of(cfg, self.plan.thickness(layer), &bead, density);
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
                // The bridges below read the facts of this layer and the layers next to it. Asked for from inside the
                // bridges' own memo claims, where the parallel helpers run as plain loops (the rule in `par`), they would
                // be worked out one after another on this thread; asked for here, outside any claim, side by side.
                let reads = crate::bridging::facts_read(&env, i64::from(layer));
                drop(par::map(&reads, |&l| shared_facts(l)));
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
                    flow: bead.flow,
                    stretch,
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
            let lower = if floating_on {
                facts(i64::from(layer) - 1)
            } else {
                None
            };
            (layer_bridges, lower)
        } else {
            (None, None)
        };
        bridges_timer.stop(&micros.bridges);
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
        // Every region of the layer hangs over the same layer below: it is grown once per distance, whatever the
        // region's filament, and the rest worked out once per wall width and settings.
        let mut overhangs = below.map(|b| crate::overhang::Overhangs::new(b, layer_height));
        // The layer below for the point by point overhang speed, once per region's settings.
        let lower = below.map(crate::overhang::Support::new).map(std::sync::Arc::new);
        let curled = layer.checked_sub(1).and_then(|k| {
            self.curls
                .get()
                .and_then(Option::as_ref)?
                .get(k as usize)
                .cloned()
        });
        // Keyed by the region's settings and the extruder (its wall speeds are the reference).
        let mut qualities: Vec<(&PrintConfig, usize, std::sync::Arc<crate::quality::Context>)> = Vec::new();
        // The layer above, for `only_one_wall_top`: top surfaces keep one wall.
        let upper_slice: Option<Shapes> = layer
            .checked_add(1)
            .filter(|&l| l < n)
            .and_then(get)
            .map(lower_shapes);
        // The walls, infill area and surface classes of the layer's regions. Those of a layer of several regions go
        // through the session's memo.
        let own_facts = bridges.as_ref().and_then(|b| b.own.as_deref());
        let several = self.several(here);
        let shared_preps = several.then(|| self.shared_preps(layer, cfg, mods, get, micros, tags));
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
        // Walls in the area painted with fuzzy skin get it there, as in OrcaSlicer.
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
                overhang: overhangs
                    .as_mut()
                    .filter(|_| crate::tower::flag_or(cfg, "detect_overhang_wall", true))
                    .map(|o| o.get(w, cfg, *slot)),
                quality: lower
                    .as_ref()
                    .filter(|_| crate::quality::overhang_speed_on(cfg))
                    .map(|low| {
                        let e = crate::nozzles::extruder_of_slot(cfg, *slot);
                        if let Some((_, _, q)) = qualities
                            .iter()
                            .find(|(qc, qe, _)| std::ptr::eq(*qc, cfg) && *qe == e)
                        {
                            return q.clone();
                        }
                        #[allow(clippy::cast_possible_truncation, reason = "a layer height in mm")]
                        let q = std::sync::Arc::new(
                            crate::quality::Context::new(
                                &cfg.for_extruder(e),
                                low.clone(),
                                curled.clone(),
                                self.plan.thickness(layer) as f32,
                            )
                            .with_clear_speeds(cfg),
                        );
                        qualities.push((cfg, e, q.clone()));
                        q
                    }),
                fuzzy_paint: fuzzy_mask.clone(),
                ..ToolWork::default()
            };
            // Extra perimeters on overhangs, as OrcaSlicer adds them: loops over the
            // part of the infill area that hangs where no bridge can anchor; the infill there goes.
            if let Some(under) = below
                && self.vase.is_none()
                && cfg.wall_loops > 0
                && crate::tower::flag_or(cfg, "detect_overhang_wall", true)
                && crate::tower::flag(cfg, "extra_perimeters_on_overhangs")
            {
                // The loops print with the overhang walls' bead.
                let (width, flow) = crate::overhang::bead(cfg, self.plan.thickness(layer));
                let spacing = if cfg.thick_bridges {
                    width + 0.05
                } else {
                    cfg.spacing_for(width)
                };
                // OrcaSlicer measures against the layer below grown by half the nozzle.
                let grown = overhangs
                    .as_mut()
                    .map(|o| o.grown(mm(cfg.nozzle_diameter / 2.0)))
                    .unwrap_or_default();
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
                let mut widths: Vec<f32> = Vec::new();
                for x in &b.areas {
                    let part = perimeters::intersection(&x.area, &inner);
                    if let Some(st) = b.stretch {
                        for piece in crate::bridging::fill_even(&part, x.angle, b.spacing, st.edge) {
                            #[allow(clippy::cast_possible_truncation, reason = "a width")]
                            widths.extend(std::iter::repeat_n(
                                st.width(piece.spacing) as f32,
                                piece.paths.len(),
                            ));
                            bridge_paths.extend(piece.paths);
                        }
                    } else {
                        bridge_paths.extend(crate::bridging::fill(&part, x.angle, b.spacing, b.reference));
                    }
                }
                work.internal_bridge_paths = std::mem::take(&mut bridge_paths);
                work.internal_bridge_path_widths = widths;
                #[allow(clippy::cast_possible_truncation, reason = "a flow ratio and a width")]
                {
                    // A flat strand carries its flow against a flat bead of its (narrowed) width; a round one is
                    // worked out from its width.
                    work.internal_bridge_ratio = if b.thick { 0.0 } else { b.flow as f32 };
                    work.internal_bridge_width = b.width as f32;
                }
            }
            // `extra_solid_infills`: the sparse infill of the layers the
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
                // Bambu Lab printers decide per connected piece (`narrow::split_pieces`); the others split inside a
                // piece, as Orca does.
                let bambu = crate::firmware::bambu_printer(cfg, cfg.gcode_flavor);
                let (normal, narrow) = if bambu {
                    crate::narrow::split_pieces(&shell_area)
                } else if matches!(
                    solid_name,
                    "monotonic" | "monotonicline" | "rectilinear" | "alignedrectilinear"
                ) {
                    crate::narrow::split_lines(&shell_area, dir, fam.solid_spacing, solid_spacing_mm)
                } else {
                    crate::narrow::split_core(&shell_area, solid_spacing_mm)
                };
                if !narrow.is_empty() {
                    // On a Bambu Lab printer a narrow piece that rests on the sparse infill of the layer below is
                    // a floating vertical shell (vshell.rs); the others stay internal solid infill.
                    let lower = lower_facts.as_deref().filter(|_| bambu);
                    let unsupported = lower.map(|f| crate::vshell::unsupported(&f.sparse));
                    let (floating, rest) = match &unsupported {
                        Some(u) => crate::vshell::split(&narrow, u),
                        None => (Shapes::new(), narrow),
                    };
                    if !rest.is_empty() {
                        // The beads fill the band out to the infill area's overlap with the wall, as a floating
                        // shell's do: the band of a stack of 5 top layers is a bead wider than that of 4.
                        let band = perimeters::intersection(&rest, &inner);
                        work.shell_thick =
                            crate::narrow::concentric_lines(&band, cfg, solid_spacing_mm, layer_height);
                        work.region_narrow = rest;
                    }
                    if let (false, Some(u), Some(f)) = (floating.is_empty(), &unsupported, lower) {
                        // A floating shell's beads fill the band from the inner wall's spacing edge (the infill area
                        // without its overlap with the wall, `vshell::wall_shift` closer to it for fixed-width walls)
                        // to `vshell::reach` past the piece over the sparse infill, except on a ring that rests wholly
                        // on the sparse infill below.
                        let flat = perimeters::offset(
                            &inner,
                            crate::vshell::wall_shift(cfg, layer_height) - overlap,
                        );
                        let band =
                            crate::vshell::band(&floating, &flat, &cls.sparse, u, crate::vshell::reach(cfg));
                        let support = crate::vshell::Support::new(u, f.segments(), cfg.sparse_infill_width());
                        work.floating = crate::vshell::beads(
                            &band,
                            cfg,
                            solid_spacing_mm,
                            layer_height,
                            &support,
                            crate::vshell::slows(cfg),
                        );
                        work.region_floating = floating;
                    }
                    shell_area = normal;
                }
            }
            // `elefant_foot_layers_density`: the internal solid infill of the first layers above the bottom is
            // sparser, rising layer by layer to full density (as in OrcaSlicer, counting from the second layer).
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
                // The bridge line width (the nozzle when round, the solid infill's when unset) at the bridge flow:
                // round threads, or flat beads whose width and spacing narrow below a flow of 1.
                let nominal = bridge_nominal(cfg, cfg.thick_bridges);
                let bead =
                    crate::overhang::bridge_bead(nominal, layer_height, cfg.bridge_flow, cfg.thick_bridges);
                // `bridge_density` (external bridges): the strands sit 1 over the density closer.
                let density = bridge_density(cfg, "bridge_density");
                let pitch = bead.spacing / density;
                let stretch = stretch_of(cfg, layer_height, &bead, density);
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
                    if let Some(st) = stretch {
                        for piece in crate::bridging::fill_even(&b.area, b.angle, pitch, st.edge) {
                            #[allow(clippy::cast_possible_truncation, reason = "a width")]
                            work.bridge_path_widths.extend(std::iter::repeat_n(
                                st.width(piece.spacing) as f32,
                                piece.paths.len(),
                            ));
                            work.bridge_paths.extend(piece.paths);
                        }
                    } else {
                        work.bridge_paths
                            .extend(crate::bridging::fill(&b.area, b.angle, pitch, reference));
                    }
                }
                #[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
                {
                    work.bridge_flat_flow = if bead.round { 0.0 } else { bead.flow as f32 };
                }
                #[allow(clippy::cast_possible_truncation, reason = "widths are small")]
                {
                    work.bridge_width = bead.width as f32;
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
                // `top_surface_density` and `bottom_surface_density` (external surfaces that are not
                // bridges): the lines spread out; a top density of 0 leaves the top unfilled.
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
                // Monotonic, rectilinear and aligned rectilinear join each line to its neighbor along the edge of the
                // surface however long the turn is: which ends are neighbors decides it, not a length (only ironing
                // keeps a limit, ironing.rs). Monotonic line keeps its lines apart.
                let link = match name {
                    "monotonic" | "rectilinear" | "alignedrectilinear" => Some(f64::MAX),
                    "monotonicline" => Some(0.0),
                    _ => None,
                };
                if let Some(link_max) = link {
                    let aligned_dir = Dir::for_layer(0);
                    // The lines end at the surface pulled in by 0.05 spacing and the turns follow it pulled in by
                    // half a spacing, as OrcaSlicer's line fills do.
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
                    let mut region = surface_region(which);
                    let narrow_lines =
                        !crate::tower::flag_or(cfg, "detect_narrow_internal_solid_infill", true);
                    if which == 2 && narrow_lines && !region.is_empty() {
                        // With narrow detection off, a band of internal solid infill too narrow for the lines (where
                        // the lines' ends, half a spacing in, leave nothing or a strip under 0.3 spacings) prints as
                        // one line along its middle, as the printer maker's slicer does. The bead is as wide as the
                        // band, and at least a solid line's spacing (its flow).
                        let thin = thin_bands(&region, surface_mm);
                        if !thin.is_empty() {
                            let width = mm(surface_mm);
                            let lines = crate::narrow::concentric_lines(&thin, cfg, surface_mm, layer_height);
                            work.shell_thick.extend(lines.into_iter().map(|mut l| {
                                l.widths.iter_mut().for_each(|w| *w = (*w).max(width));
                                l
                            }));
                            work.region_narrow.extend(thin.iter().cloned());
                            // The rest less a margin round the band, so no sliver along it is left for the lines.
                            let k = mm(0.15 * surface_mm);
                            let rest = perimeters::difference(&region, &perimeters::offset(&thin, k));
                            region = perimeters::offset(&perimeters::offset(&rest, -k), k);
                            if region.is_empty() {
                                // The scanlines laid over the whole surface are dropped with it.
                                spans.clear();
                            }
                        }
                    }
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
                    // Rectilinear and aligned rectilinear are one sweep from the left (a turn to the neighbor on
                    // either side, the shorter when both are free, round a notch on the same line only when neither
                    // is); monotonic and monotonic line are monotonic regions.
                    let (spans_in, spans_out) = (
                        crate::monotonic::orca_spans(&own, d),
                        crate::monotonic::orca_spans(&own_out, d),
                    );
                    let to_point = |k: i64, t: i64| crate::monotonic::orca_point(d, k, t);
                    let pls = if matches!(name, "rectilinear" | "alignedrectilinear") {
                        crate::monotonic::zigzag_with(
                            &spans_in,
                            surface_spacing,
                            &spans_out,
                            links,
                            &to_point,
                        )
                    } else {
                        crate::monotonic::polylines_outer(
                            &spans_in,
                            &spans_out,
                            surface_spacing,
                            links,
                            &to_point,
                        )
                    };
                    if let Some(slot_lines) = curved.get_mut(which) {
                        for pl in pls {
                            // The turns: pieces between two points on different scanlines (a line keeps its own).
                            let turns: Vec<bool> = pl
                                .windows(2)
                                .map(|w| match w {
                                    // A point halves its scanline value to land on the grid, so the two ends of
                                    // one line can read scanline values one unit apart: a turn moves further.
                                    [a, b] => (d.st(a.x, a.y).0 - d.st(b.x, b.y).0).abs() > 1,
                                    _ => false,
                                })
                                .collect();
                            let pl = if turn == 0.0 {
                                pl
                            } else {
                                crate::patterns::rotate_points(&pl, turn)
                            };
                            work.joins.extend(
                                pl.windows(2)
                                    .zip(&turns)
                                    .filter(|(_, t)| **t)
                                    .filter_map(|(w, _)| Some([*w.first()?, *w.get(1)?])),
                            );
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
                    // The plane-path patterns keep one frame on every layer: minus the solid infill angle and a right angle.
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
                // Cross zag moves its lattice sideways every other layer.
                let shift = {
                    let id = layer + self.raft_layers();
                    let n = f64::from(id / 2) * step;
                    if id.is_multiple_of(2) { -n } else { n }
                };
                let area: &Shapes = &sparse_area;
                match cfg.sparse_infill_pattern {
                    InfillPattern::LockedZag => {
                        // Locked zag, as OrcaSlicer prints it: a skin of `skin_infill_depth` along the walls is cross zag at the
                        // skin density, the skeleton inside (grown by `infill_lock_depth` into the skin) is zigzag
                        // across the layer's direction at the skeleton density; each set has its own line width.
                        let get = |k: &str, d: f64| crate::motion::raw_f(cfg, k).unwrap_or(d);
                        let (skin_depth, lock_depth) =
                            (get("skin_infill_depth", 2.0), get("infill_lock_depth", 1.0));
                        // Percent settings: "60%" as projects and presets write them, or 60.
                        let percent = |k: &str, d: f64| {
                            cfg.raw
                                .get(k)
                                .and_then(|v| crate::config::float_or_percent(v, 100.0))
                                .unwrap_or(d)
                        };
                        let (skin_density, skeleton_density) = (
                            percent("skin_infill_density", 25.0) / 100.0,
                            percent("skeleton_infill_density", 25.0) / 100.0,
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
                            tongues: false,
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
            works.extend(split_by_feature(work, self.feature_tools(cfg, *slot)));
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

    /// The prime tower's part of a layer over the filaments' turns, in print order: its outline, the purge after each
    /// change (less what the new filament's infill, objects or support take up), the old filament's ramming before
    /// the change and the fill of the depth the purges left. Without a tower (`at.tower` None) only the flush into
    /// infill is planned.
    pub(crate) fn tower_turns<W: TowerTurn>(&self, cfg: &PrintConfig, at: &TowerLayer, works: &mut [W]) {
        if let Some(t) = at.tower.as_ref().filter(|t| t.is_type1()) {
            self.type1_tower_turns(cfg, at, t, works);
            return;
        }
        let TowerLayer {
            layer,
            first,
            h,
            top,
            tower_height,
            start,
            tower,
            ..
        } = *at;
        let mut was = start;
        let changes = works.iter().any(|w| {
            let change = was != 0 && w.tool() != was;
            was = w.tool();
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
            .position(|w| wall_tool > 0 && w.tool() == wall_tool)
            .unwrap_or(works.len().saturating_sub(1));
        let mut current = start;
        // Each purge of the layer starts where the one before it ended.
        let mut used_rows = 0.0;
        let mut last_purge: Option<usize> = None;
        // Infill, objects and support take up a flush only where the tower purges the flush: a single
        // nozzle's change. A tool changer's head and a nozzle of a filament map hold their own filament
        // and prime a fixed volume (OrcaSlicer's type 2 tower without
        // `purge_in_prime_tower`; Bambu Studio's prime volume beside the chute flush).
        let absorbs =
            !crate::nozzles::shared(cfg) && (crate::tower::type1(cfg) || crate::tower::flush_on_tower(cfg));
        // As OrcaSlicer's type 2 towers save on the last wipe: the layer's first purge is cut by what
        // finishing the layer (its wall and the fill over the purges) extrudes anyway, down to the new
        // filament's `filament_minimal_purge_on_wipe_tower`.
        // The save is measured on the tower as Orca first plans it, before the saves shrink it.
        let saving = tower
            .as_ref()
            .filter(|_| crate::tower::saves_first_purge(cfg))
            .and_then(|t| {
                crate::tower::Tower::new(cfg, self.tool_count, self.tower_rows0)
                    .map(|t0| t0.shaped(t.width(), t.angle()).at(t.origin()))
            });
        let mut first_purge = true;
        let order: Vec<u8> = works.iter().map(TowerTurn::tool).collect();
        let planned = saving
            .as_ref()
            .filter(|_| crate::tower::flush_on_tower(cfg))
            .map_or(0.0, |t0| {
                t0.planned_rows(cfg, self.tool_count, start, &order, h, first)
            });
        // Where the layer's wall is in its work's tower paths, and where each wipe after a change starts (the
        // wall opens level with them).
        let mut wall_slot: Option<(usize, usize)> = None;
        let mut wipe_starts: Vec<(f64, f64)> = Vec::new();
        for i in 0..works.len() {
            let Some(next_tool) = works.get(i).map(TowerTurn::tool) else {
                continue;
            };
            let change = current != 0 && next_tool != current;
            let purge = change.then(|| crate::tower::change_purge(cfg, self.tool_count, current, next_tool));
            // The old filament rams out before the change, printed with it at the end of its own work.
            let mut lead = None;
            if let (Some(p), Some(t), Some(prev)) = (purge, tower.as_ref(), i.checked_sub(1))
                && p.ram > 0.0
                && let Some(w) = works.get_mut(prev)
            {
                let (path, rows, end) = t.ramming(cfg, p, current, h, used_rows);
                used_rows += rows;
                lead = end;
                w.tower_after().extend(path);
            }
            let Some(work) = works.get_mut(i) else { continue };
            if let (true, Some(tower)) = (i == wall_at && walled, tower.as_ref()) {
                wall_slot = Some((i, work.tower().len()));
                work.tower().push(tower.wall(first, top));
                // a type 1 tower's brim narrows over the first layers (orca's brim chamfer)
                if crate::tower::type1(cfg) {
                    work.tower().extend(tower.chamfer(layer, h, top, tower_height));
                } else if first {
                    work.tower()
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
                        taken += work.infill_volume(cfg.line_width, h);
                        if taken > 0.0 {
                            work.set_flush_first();
                        }
                    }
                    if crate::tower::flag(cfg, "flush_into_objects") {
                        taken += work.solid_volume(cfg.line_width, h);
                    }
                    if crate::tower::flag_or(cfg, "flush_into_support", true) {
                        taken += work.support_volume(cfg.line_width, h);
                    }
                }
                v = crate::tower::tower_share(cfg, next_tool, v, taken).max(0.0);
                if let Some(t0) = saving.as_ref().filter(|_| first_purge) {
                    v = if crate::tower::flush_on_tower(cfg) {
                        t0.saved_first_wipe(
                            cfg,
                            v,
                            h,
                            first,
                            if first { used_rows } else { planned },
                            work.tool(),
                        )
                    } else {
                        t0.saved_wipe(cfg, v, h, first, used_rows, work.tool())
                    };
                }
                first_purge = false;
                if let (true, Some(tower)) = (v > 0.5, tower.as_ref()) {
                    if lead.is_none() {
                        wipe_starts.push(tower.row_start(used_rows));
                    }
                    let (path, rows) = tower.purge_lead(v, h, first, used_rows, lead, false);
                    used_rows += rows;
                    work.tower().extend(path);
                    last_purge = Some(i);
                }
            }
            current = work.tool();
        }
        if let (Some((wi, at)), Some(tower)) = (wall_slot, tower.as_ref())
            && let Some(work) = works.get_mut(wi)
            && at < work.tower().len()
        {
            let pieces = tower.wall_pieces(first, top, &wipe_starts);
            work.tower().splice(at..=at, pieces);
        }
        // The depth the purges left free is filled by the filament of the last purge (Orca's
        // finish block), or with the outline when the layer purged nothing.
        let fill_at = last_purge.or((walled && !works.is_empty()).then_some(wall_at));
        if let (Some(i), Some(tower)) = (fill_at, tower.as_ref())
            && let Some(work) = works.get_mut(i)
        {
            work.tower().extend(tower.fill(cfg, used_rows, first));
        }
    }

    /// [`Self::tower_turns`] on a type 1 (Bambu Lab) tower, which splits the layer's tower between its filaments:
    ///
    /// - Each change's rows go right after it, in the new filament, in the block of the new filament's adhesion
    ///   category (one block per category along the depth, [`crate::tower::TowerPlan`]), from where that block's
    ///   rows on this layer stopped. A contact change (the category comes onto the tower on this layer) fills the
    ///   same depth with denser rows and no nozzle wipe.
    /// - The wall (with the first layers' brim) goes with the print's wall filament: before the first change when
    ///   the layer starts on it, else right after the rows of the change into it, else the same way with the first
    ///   filament of its category, else after the first change's rows.
    /// - What a block's rows leave free is filled by the last filament that changed into the block on this layer,
    ///   after its rows; with no change into it, by the filament the layer starts on before the first change when
    ///   it is of the block's category, else with the wall.
    /// - A layer without a change prints its wall and fill in one piece with the filament it holds.
    fn type1_tower_turns<W: TowerTurn>(
        &self,
        cfg: &PrintConfig,
        at: &TowerLayer,
        tower: &crate::tower::Tower,
        works: &mut [W],
    ) {
        #[derive(Clone, Copy, PartialEq, Eq)]
        enum Place {
            /// With the filament the layer starts on, after its last work before the first change.
            Before(usize),
            /// In this work's tower paths, after the rows of the change into it.
            After(usize),
        }
        let TowerLayer {
            layer,
            first,
            h,
            top,
            tower_height,
            start,
            order_at,
            ..
        } = *at;
        let plan = self.tower_plan.once(|| {
            crate::tower::TowerPlan::new(
                cfg,
                self.tool_count,
                &self.tool_order,
                &|l| self.plan.thickness(u32::try_from(l).unwrap_or(0)),
                self.tower_top.map_or(0, |t| t as usize),
                tower,
            )
        });
        let cat = |s: u8| crate::tower::block_of(cfg, s);
        // The layer's changes: the work each goes into and its filament.
        let mut changes: Vec<(usize, u8)> = Vec::new();
        let mut was = start;
        for (i, w) in works.iter().enumerate() {
            if was != 0 && w.tool() != was {
                changes.push((i, w.tool()));
            }
            was = w.tool();
        }
        let walled = first
            || (crate::tower::flag_or(cfg, "prime_tower_outline", true)
                && (!changes.is_empty() || !crate::tower::flag(cfg, "wipe_tower_no_sparse_layers")));
        // The last work of the filament the layer starts on, before its first change.
        let lead_end = changes.first().and_then(|c| c.0.checked_sub(1));
        let wall_place = if let Some(&(i0, _)) = changes.first() {
            let wall = plan.wall;
            let into =
                |keep: &dyn Fn(u8) -> bool| changes.iter().find(|c| keep(c.1)).map(|c| Place::After(c.0));
            let before = lead_end.map(Place::Before);
            let same_cat = |s: u8| wall != 0 && cat(s) == cat(wall);
            (if wall != 0 && start == wall { before } else { None })
                .or_else(|| into(&|t| wall != 0 && t == wall))
                .or_else(|| if same_cat(start) { before } else { None })
                .or_else(|| into(&same_cat))
                .unwrap_or(Place::After(i0))
        } else {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a filament slot"
            )]
            let wall_tool = cfg.raw_number("wipe_tower_filament", 0.0).clamp(0.0, 255.0) as u8;
            Place::After(
                works
                    .iter()
                    .position(|w| wall_tool > 0 && w.tool() == wall_tool)
                    .unwrap_or(works.len().saturating_sub(1)),
            )
        };
        let blocks = plan.blocks.len().max(1);
        let block_index = |s: u8| plan.blocks.iter().position(|b| b.0 == cat(s)).unwrap_or(0);
        let block_range = |k: usize| {
            plan.blocks
                .get(k)
                .and_then(|b| plan.block(b.0))
                .unwrap_or((0.0, None))
        };
        let mut used = vec![0.0f64; blocks];
        let mut last_into: Vec<Option<usize>> = vec![None; blocks];
        let absorbs = !crate::nozzles::shared(cfg);
        let mut current = start;
        let mut wall_slot: Option<(usize, usize)> = None;
        let mut wipe_starts: Vec<(f64, f64)> = Vec::new();
        for i in 0..works.len() {
            let Some(next_tool) = works.get(i).map(TowerTurn::tool) else {
                continue;
            };
            let change = current != 0 && next_tool != current;
            let purge = change.then(|| crate::tower::change_purge(cfg, self.tool_count, current, next_tool));
            let k = block_index(next_tool);
            let base = block_range(k).0;
            let mut lead = None;
            if let (Some(p), Some(prev)) = (purge, i.checked_sub(1))
                && p.ram > 0.0
                && let Some(w) = works.get_mut(prev)
                && let Some(u) = used.get_mut(k)
            {
                let (path, rows, end) = tower.ramming(cfg, p, current, h, base + *u);
                *u += rows;
                lead = end;
                w.tower_after().extend(path);
            }
            let Some(work) = works.get_mut(i) else { continue };
            if let Some(p) = purge {
                let mut taken = 0.0;
                if absorbs {
                    if crate::tower::flag_or(cfg, "flush_into_infill", true)
                        || crate::tower::flag(cfg, "flush_into_objects")
                    {
                        taken += work.infill_volume(cfg.line_width, h);
                        if taken > 0.0 {
                            work.set_flush_first();
                        }
                    }
                    if crate::tower::flag(cfg, "flush_into_objects") {
                        taken += work.solid_volume(cfg.line_width, h);
                    }
                    if crate::tower::flag_or(cfg, "flush_into_support", true) {
                        taken += work.support_volume(cfg.line_width, h);
                    }
                }
                let v = (p.wipe - taken).max(0.0);
                if v > 0.5
                    && let Some(u) = used.get_mut(k)
                {
                    let contact = !first && plan.contact(order_at as usize, cat(next_tool));
                    if lead.is_none() && !contact {
                        wipe_starts.push(tower.row_start(base + *u));
                    }
                    let (path, rows) = tower.purge_lead(v, h, first, base + *u, lead, contact);
                    *u += rows;
                    work.tower().extend(path);
                    if let Some(l) = last_into.get_mut(k) {
                        *l = Some(i);
                    }
                }
            }
            if walled && wall_place == Place::After(i) {
                wall_slot = Some((i, work.tower().len()));
                work.tower().push(tower.wall(first, top));
                work.tower().extend(tower.chamfer(layer, h, top, tower_height));
            }
            current = work.tool();
        }
        // What the filament the layer starts on prints before the first change.
        let mut before: Vec<crate::tower::TowerPath> = Vec::new();
        if walled {
            let pieces = tower.wall_pieces(first, top, &wipe_starts);
            match (wall_place, wall_slot) {
                (Place::Before(_), _) => {
                    before.extend(pieces);
                    before.extend(tower.chamfer(layer, h, top, tower_height));
                }
                (Place::After(_), Some((wi, at))) => {
                    if let Some(work) = works.get_mut(wi)
                        && at < work.tower().len()
                    {
                        work.tower().splice(at..=at, pieces);
                    }
                }
                (Place::After(_), None) => {}
            }
        }
        if changes.is_empty() {
            // No change: the fill of the whole depth goes with the wall.
            if let Place::After(wi) = wall_place
                && walled
                && let Some(work) = works.get_mut(wi)
            {
                work.tower().extend(tower.fill(cfg, 0.0, first));
            }
        } else {
            for k in 0..blocks {
                let (from, to) = block_range(k);
                let piece = tower.fill_range(cfg, from + used.get(k).copied().unwrap_or(0.0), to, first);
                if piece.is_empty() {
                    continue;
                }
                let block_cat = plan.blocks.get(k).map_or_else(|| cat(start), |b| b.0);
                let into = last_into.get(k).copied().flatten();
                let place = into.map(Place::After).or_else(|| {
                    lead_end
                        .filter(|_| plan.blocks.len() <= 1 || cat(start) == block_cat)
                        .map(Place::Before)
                });
                match place.unwrap_or(wall_place) {
                    Place::Before(_) => before.extend(piece),
                    Place::After(wi) => {
                        if let Some(work) = works.get_mut(wi) {
                            work.tower().extend(piece);
                        }
                    }
                }
            }
        }
        if !before.is_empty()
            && let Some(work) = lead_end.and_then(|k| works.get_mut(k))
        {
            work.tower_after().splice(0..0, before);
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
        entry: Option<crate::geom::Point>,
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
        // What else the skirt goes round on this layer, as OrcaSlicer's skirt collects it: the support's
        // paths, and on a plate with one skirt the prime tower's first layer.
        let mut skirt_extra: Vec<IntPoint<i32>> = Vec::new();
        if skirt_here
            && self.skirt_groups.is_empty()
            // A plate whose objects have settings of their own gives each object a skirt of its own: none of them
            // goes round the plate's tower.
            && self.plate_tools.is_none()
            && self.tower_top.is_some()
            && let Some(t) = self.tower(cfg).map(|t| self.tower_origin.map_or(t, |o| t.at(o)))
        {
            for [x, y] in t.first_layer_corners() {
                let p = crate::geom::Point::from_mm(x, y);
                skirt_extra.push(IntPoint::new(p.x, p.y));
            }
        }
        if crate::collide::rules::support_runs(cfg.enable_support, cfg.support.manual, self.has_enforcers())
            && let (Some((sl, flow, index, z)), Some(active)) =
                (self.support_at(cfg, layer), works.first().map(|w| w.tool))
        {
            let sp = self.support_paths(cfg, sl, index, z);
            if skirt_here {
                for p in sp
                    .support
                    .iter()
                    .chain(&sp.interface)
                    .chain(&sp.round)
                    .chain(&sp.round_interface)
                    .flatten()
                {
                    skirt_extra.push(IntPoint::new(p.x, p.y));
                }
            }
            out.support_areas = support_islands(sl);
            let round = round_support_flow(cfg, self.plan.thickness(layer));
            place_support(&mut works, sp, (flow, round), support_tools(cfg, active));
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
            // A plate that prints its objects from sessions of their own prints one tower over all of them.
            let tower = if self.plate_tools.is_some() {
                None
            } else {
                self.tower_top
                    .filter(|t| layer <= *t)
                    .and_then(|_| self.tower(cfg))
                    .map(|t| self.tower_origin.map_or(t, |o| t.at(o)))
            };
            let at = TowerLayer {
                layer,
                first: layer == 0 && self.raft.is_none(),
                h: self.plan.thickness(layer),
                top: self.plan.top(layer),
                tower_height: self.tower_top.map_or(0.0, |t| self.plan.top(t)),
                start: out.start_tool,
                tower,
                order_at: layer,
            };
            self.tower_turns(cfg, &at, &mut works);
            if self.plate_tools.is_some() {
                out.turns = turn_rooms(&works, cfg.line_width, at.h);
            }
        }
        let brim_kind = crate::brim::Kind::of(cfg);
        let auto_brim = brim_kind == crate::brim::Kind::Auto;
        // No brim over a raft, as in OrcaSlicer.
        if layer == 0
            && self.raft.is_none()
            && brim_kind != crate::brim::Kind::Off
            && (cfg.brim_width > 0.0 || auto_brim)
        {
            let union = brim_outline(cfg, here);
            let object_height = self.plan.top(n.saturating_sub(1));
            let spacing_mm = brim_spacing(cfg);
            // `brim_ears`: an object that carries painted ears prints them in place of the automatic ones, as
            // `painted` does; an object with none keeps the automatic ears. Empty for the other kinds, and when no
            // object carries any.
            let ear = |e: &[f64; 4]| crate::brim::Ear {
                at: {
                    let p = crate::geom::Point::from_mm(e[0], e[1]);
                    IntPoint::new(p.x, p.y)
                },
                head_radius: e[3],
            };
            let own_ears: Vec<Vec<crate::brim::Ear>> =
                if brim_kind == crate::brim::Kind::Ears && !self.brim_ears.is_empty() {
                    (0..self.ear_hulls.len())
                        .map(|k| {
                            self.brim_ears
                                .iter()
                                .filter(|(o, _)| *o == k)
                                .map(|(_, e)| ear(e))
                                .collect()
                        })
                        .collect()
                } else {
                    Vec::new()
                };
            // `auto_brim` sizes the brim from each object's own height and first layer footprint (per
            // object, as Orca's auto brim does), never from the plate as a whole: four copies
            // side by side get the brim one of them gets. Painted mouse ears go by object too.
            let owners: Vec<usize> = if auto_brim {
                self.island_owners(&union)
            } else if own_ears.len() > 1 {
                let hulls: Vec<&[[f64; 2]]> = self.ear_hulls.iter().map(Vec::as_slice).collect();
                union
                    .iter()
                    .map(|island| crate::brim::owner(island, &hulls))
                    .collect()
            } else {
                vec![0; union.len()]
            };
            let per_object: Vec<(f64, f64)> = if auto_brim {
                self.auto_brim_widths(cfg, &union, &owners, object_height)
            } else {
                Vec::new()
            };
            let object_width = cfg.brim_width;
            let painted_ears: Vec<crate::brim::Ear> = if brim_kind == crate::brim::Kind::Painted {
                self.brim_ears.iter().map(|(_, e)| ear(e)).collect()
            } else {
                Vec::new()
            };
            let gap_mm = cfg.raw_number("brim_object_gap", 0.0).clamp(0.0, 2.0);
            let combine = crate::tower::flag_or(cfg, "combine_brims", true);
            let bodies = perimeters::offset_round(&union, mm(gap_mm));
            // No brim where the first support layer prints (in OrcaSlicer the support's first layer is a
            // no-brim area).
            // Trees are left out: Orca also draws a brim around their bases there, which is not built yet.
            // Asked only with support on: the question builds the whole support plan, which with support off
            // nothing else needs.
            let no_brim: Shapes = match cfg.enable_support.then(|| self.support_at(cfg, 0)).flatten() {
                Some((sl, ..))
                    if sl.classic.is_none() && sl.organic.is_none() && self.organic2_for(sl).is_none() =>
                {
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
            let bed = crate::brim::Bed::of(cfg);
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
                let count = brim_loops(brim_mm, spacing_mm);
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
                let (kind, ears) = match own_ears.get(*owner) {
                    Some(own) if !own.is_empty() => (crate::brim::Kind::Painted, own.as_slice()),
                    _ => (brim_kind, painted_ears.as_slice()),
                };
                let areas =
                    crate::brim::island_areas(cfg, kind, &one, &union, width_even, spacing_mm, gap_mm, ears);
                let areas = clear(areas);
                // As in OrcaSlicer, where each extruder reaches only part of the bed (H2D, H2C), a brim is cut to
                // the reach of the extruder that prints it (the ring outside get_extruder_printable_polygons is a
                // no-brim area there).
                let areas = match reach_of(slot) {
                    Some(r) => areas.iter().map(|a| perimeters::intersection(a, &r)).collect(),
                    None => areas,
                };
                // A brim near the bed's edge or an excluded area is cut to the bed rather than run off it.
                let areas = match &bed {
                    Some(bed) => bed.cut(areas).0,
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
                let f = self.feature_tools(cfg, slot);
                let mine = [f.outer, f.inner, f.sparse, f.solid, f.top, f.bottom];
                let at = works.iter().position(|w| mine.contains(&w.tool)).unwrap_or(0);
                if let Some(work) = works.get_mut(at) {
                    work.brim.extend(loops);
                }
            }
        }
        if skirt_here && !works.is_empty() {
            // A skirt near the bed's edge or a keep-out zone is cut to the bed rather than run off it, as the brim is.
            let room = skirt_room(cfg);
            let skirt = skirt_loops(
                here,
                &skirt_extra,
                cfg,
                self.draft_hull.as_deref(),
                &self.skirt_groups,
                (usize::from(self.tool_count), layer),
                room.as_ref(),
            );
            out.skirt_cut = skirt_cut(&skirt);
            // The layer's first filament prints the skirt, as in Orca, unless its extruder cannot reach it (H2D,
            // H2C): then the first filament whose extruder reaches all of it does.
            let at = self.skirt_tool_at(cfg, &works, &skirt.paths);
            if let Some(w) = works.get_mut(at) {
                w.skirt = skirt.paths;
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
        let faces = crate::seam::SeamIndex::new(&faces);
        let vase = self
            .vase
            .filter(|&b| layer >= b && layer >= cfg.skirt_height)
            .map(|b| {
                let first = layer == b.max(cfg.skirt_height);
                crate::spiral::VaseLayer {
                    first,
                    last: layer + 1 == n,
                    anchor: entry.unwrap_or_else(|| {
                        crate::geom::Point::from_mm(
                            f64::midpoint(self.bounds[0], self.bounds[2]),
                            self.bounds[1] - 1000.0,
                        )
                    }),
                    enter: entry.filter(|_| first && layer == b),
                    blend: None,
                }
            })
            .map(|mut v| {
                // `spiral_mode_smooth`: each point moves toward the loop below, as OrcaSlicer's vase mode does.
                if smooth
                    && !v.first
                    && crate::firmware::truthy(cfg, "spiral_mode_smooth")
                    && let Some(below) = layer.checked_sub(1)
                {
                    let prev = self.layer_paths_with(below, cfg, mods, get, micros, tags, false, entry);
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
            (
                vase.as_ref(),
                entry.filter(|_| self.vase.is_some_and(|b| layer < b)),
            ),
            &self.object_hulls,
        );
        let fc = tags.filament(cfg, paths::first_slot(&out));
        // Without sparse tower layers a change prints on top of the tower as it stands, below the layer.
        sink_tower(&mut out, self.tower_sunk(cfg, layer));
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
            // What each top surface filament irons: the regions it is the top surface filament of.
            let mut owners: Vec<(u8, Shapes)> = Vec::new();
            if crate::ironing::kind(cfg).is_some() {
                for (ri, (slot, shapes)) in here.regions.iter().enumerate() {
                    let rc = match here.region_cfg.get(ri).copied().unwrap_or(0) {
                        0 => cfg,
                        k => mods.get(usize::from(k) - 1).unwrap_or(cfg),
                    };
                    let tool = self.feature_tools(rc, *slot).top.max(1);
                    match owners.iter_mut().find(|(t, _)| *t == tool) {
                        Some((_, own)) => *own = perimeters::union_all(&[&*own, shapes]),
                        None => owners.push((tool, shapes.clone())),
                    }
                }
            }
            crate::ironing::add(&mut out, &areas, cfg, layer + 1 == n, base, &owners);
            out.areas = Some(areas);
        }
        // The layer's time and the cooling slowdown come after its ironing, so the slowdown pools the ironing with
        // the layer's other paths and counts its time. Brick layers change flows only, after the time.
        paths::cool_with(&mut out, cfg, &fc);
        if let Some(role) = crate::brick::role(cfg, layer, n, top_n) {
            crate::brick::apply(&mut out, role);
        }
        Micros::add(&micros.paths, &t);
        out
    }
}

/// Prints the layer's prime tower `by` mm below the layer (`PathInfo::dz`); the G-code drops to it over the tower and
/// comes back up there.
pub(crate) fn sink_tower(out: &mut LayerPaths, by: f64) {
    if by <= 0.0 {
        return;
    }
    #[allow(clippy::cast_possible_truncation, reason = "preview data is f32")]
    let dz = -by as f32;
    for p in out
        .paths
        .iter_mut()
        .filter(|p| p.feature == crate::output::Feature::PrimeTower)
    {
        p.dz = dz;
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
/// the margin of one circle, as Orca measures it for polyholes: its center, radius (the farthest point),
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

/// A polyhole as Orca makes it: a polygon with `max(3, round(4 r 0.4 / nozzle))` sides whose edges sit at the
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
pub(crate) fn bridge_line_width(cfg: &PrintConfig) -> Option<f64> {
    // Orca's default is 100 percent of the nozzle; 0 means the feature's own width.
    match cfg.raw.get("bridge_line_width") {
        None => Some(cfg.nozzle_diameter),
        Some(v) => crate::config::float_or_percent(v, cfg.nozzle_diameter).filter(|w| *w > 0.0),
    }
}

/// The width a bridge strand is worked out from: the bridge line width (the nozzle when unset and the strands
/// are round, else the internal solid infill's). Bambu Lab printers have no bridge line width of their own:
/// left at its default, round strands start from the nozzle and flat ones from the internal solid infill's width.
fn bridge_nominal(cfg: &PrintConfig, round: bool) -> f64 {
    let line = bridge_line_width(cfg);
    if round {
        return line.unwrap_or(cfg.nozzle_diameter);
    }
    let default_line = match cfg.raw.get("bridge_line_width") {
        None => true,
        Some(serde_json::Value::String(v)) => v.trim() == "100%",
        Some(_) => false,
    };
    if even_bridges(cfg) && default_line {
        return cfg.solid_infill_width();
    }
    line.unwrap_or_else(|| cfg.solid_infill_width())
}

/// Round bridge strands (`thick_bridges`) on a printer other than a Bambu Lab one: the strand's diameter (the bridge
/// line width times the root of `bridge_flow`) and the diameter of the bead a support layer prints where it rests on
/// a top surface of the part (the bridge line width times `bridge_flow`), mm.
fn round_support_beads(cfg: &PrintConfig) -> Option<(f64, f64)> {
    if !cfg.thick_bridges || crate::firmware::bambu_printer(cfg, cfg.gcode_flavor) {
        return None;
    }
    let w = bridge_nominal(cfg, true);
    let f = cfg.bridge_flow.max(0.0);
    Some((w * f.sqrt(), w * f))
}

/// The flow of a support layer's round beads over the part ([`round_support_beads`]) against a support bead of
/// height `h`; 0 when there are none.
#[allow(clippy::cast_possible_truncation, reason = "a flow ratio")]
fn round_support_flow(cfg: &PrintConfig, h: f64) -> f32 {
    match round_support_beads(cfg) {
        Some((_, d)) if h > 0.0 => {
            (std::f64::consts::PI * d * d / 4.0 / crate::gcode::bead_area(cfg.support_width(), h)) as f32
        }
        _ => 0.0,
    }
}

/// Bambu Lab printers spread the strands of each bridge piece evenly across it (`bridging::fill_even`); the
/// others keep the strands on the grid through the object's center.
fn even_bridges(cfg: &PrintConfig) -> bool {
    crate::firmware::bambu_printer(cfg, cfg.gcode_flavor)
}

/// How a bridge piece spreads its strands on a printer that does ([`even_bridges`]), for strands of `bead` at
/// `density`. The bridge region starts half the innermost wall's spacing past that wall's centerline, less
/// `infill_wall_overlap` of the mean of the inner wall's and the internal solid infill's spacings, whatever the wall
/// generator. The piece is cut from the infill area, so its edge moves from where the infill area starts to there.
/// With variable-width walls the infill area starts half the inner wall's spacing past the innermost wall's
/// centerline, less `infill_wall_overlap` of the line width. Fixed-width walls cut it at the walls' widths from the
/// outline (the outer wall's and one inner wall's per further loop, less the same overlap), while their inner walls
/// sit by the precise outer wall setting, so the edge is worked out from the outline.
fn stretch_of(
    cfg: &PrintConfig,
    height: f64,
    bead: &crate::overhang::BridgeBead,
    density: f64,
) -> Option<crate::bridging::Stretch> {
    if !even_bridges(cfg) {
        return None;
    }
    let share = cfg.infill_wall_overlap / 100.0;
    let (outer, inner, solid) = (
        cfg.outer_wall_width(),
        cfg.inner_wall_width(),
        cfg.solid_infill_width(),
    );
    // Spacings at a layer height, and how far the region starts past the innermost wall's centerline.
    let spacing = |w: f64, h: f64| (w - h * (1.0 - std::f64::consts::FRAC_PI_4)).max(w * 0.5);
    let past_wall =
        |h: f64| spacing(inner, h) / 2.0 - share * f64::midpoint(spacing(inner, h), spacing(solid, h));
    // Where the infill area starts past that centerline cancels most of the region's own offset, so these two keep
    // the set layer height.
    let set = cfg.layer_height;
    let edge = if cfg.arachne_walls() {
        spacing(inner, set) / 2.0 - share * cfg.line_width - past_wall(set)
    } else if cfg.wall_loops < 2 {
        inner / 2.0 - share * cfg.line_width - past_wall(set)
    } else {
        // The innermost wall's centerline from the outline, at the layer's own height as its walls are laid: the
        // outer wall's, then the first inner wall's pitch (the two widths' mean with the precise outer wall and inner
        // walls first, else the two spacings' mean), then an inner spacing for each further inner wall.
        let precise = crate::tower::flag_or(cfg, "precise_outer_wall", true)
            && cfg.wall_sequence == crate::config::WallSequence::InnerOuter;
        let first = if precise {
            f64::midpoint(outer, inner)
        } else {
            f64::midpoint(spacing(outer, height), spacing(inner, height))
        };
        let innermost = outer / 2.0 + first + f64::from(cfg.wall_loops - 2) * spacing(inner, height);
        let infill = outer + inner * f64::from(cfg.wall_loops - 1) - share * cfg.line_width;
        infill - (innermost + past_wall(height))
    };
    Some(crate::bridging::Stretch {
        edge,
        density,
        gap: bead.width - bead.spacing,
    })
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

/// A layer's skirt: its paths in print order, a point where it was cut to the bed, and a point of a skirt of which
/// less than one whole loop's length is left on the bed (the plate is refused then).
#[derive(Debug, Default)]
struct Skirt {
    paths: Vec<paths::SkirtPath>,
    cut: Option<IntPoint<i32>>,
    short: Option<IntPoint<i32>>,
}

impl Skirt {
    fn add(&mut self, other: Self) {
        self.paths.extend(other.paths);
        self.cut = self.cut.or(other.cut);
        self.short = self.short.or(other.short);
    }
}

/// Skirt loops around a layer: the convex hull of everything on it, grown by
/// the brim width and `skirt_distance`, then one loop per `skirt_loops`, the
/// innermost first, as the slicers print them. With `groups` (`skirt_type`
/// per object) each group of objects gets the loops of its own hull. With `room`
/// (the bed less its keep-out zones, [`skirt_room`]) each loop is cut to it ([`skirt_around`]).
fn skirt_loops(
    here: &LayerRegions,
    extra: &[IntPoint<i32>],
    cfg: &PrintConfig,
    whole: Option<&[IntPoint<i32>]>,
    groups: &[Vec<IntPoint<i32>>],
    (tools, layer): (usize, u32),
    room: Option<&Shapes>,
) -> Skirt {
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
        let mut all = Skirt::default();
        for b in buckets {
            all.add(skirt_around(convex_hull(b), cfg, false, (tools, layer), room));
        }
        return all;
    }
    match whole {
        Some(h) => skirt_around(h.to_vec(), cfg, true, (tools, layer), room),
        None if extra.is_empty() => skirt_around(convex_hull(points), cfg, false, (tools, layer), room),
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
            skirt_around(convex_hull(occupied), cfg, true, (tools, layer), room)
        }
    }
}

/// Where a skirt's centerline may run: the bed less its keep-out zones (`bed_exclude_area`, the nozzle wrap check
/// corner), half a skirt line spacing in from their edges so the bead stays on the bed, the way the brim is cut to
/// it. None when the settings name no printable area.
fn skirt_room(cfg: &PrintConfig) -> Option<Shapes> {
    crate::brim::Bed::of(cfg).map(|bed| bed.room(mm(skirt_spacing_mm(cfg)) / 2))
}

/// A layer's record of its skirt cut to the bed, when it was.
fn skirt_cut(skirt: &Skirt) -> Option<crate::output::SkirtCut> {
    let mm_of = |p: IntPoint<i32>| [f64::from(p.x) / SCALE, f64::from(p.y) / SCALE];
    skirt.cut.map(|at| crate::output::SkirtCut {
        at: mm_of(skirt.short.unwrap_or(at)),
        short: skirt.short.is_some(),
    })
}

/// The loops around one hull (a whole-part hull already includes the brim), outermost first.
/// As in Orca: `skirt_loops` of them, and with `min_skirt_length` more until the filament
/// of the loops, counted extruder by extruder, reaches that many mm for the extruder in turn.
#[cfg(test)]
pub(crate) fn loops_around(
    hull: Vec<IntPoint<i32>>,
    cfg: &PrintConfig,
    includes_brim: bool,
    tools_layer: (usize, u32),
) -> Vec<Vec<IntPoint<i32>>> {
    skirt_around(hull, cfg, includes_brim, tools_layer, None)
        .paths
        .into_iter()
        .map(|p| p.points)
        .collect()
}

/// [`loops_around`], each loop cut to `room` when one is given. A loop that lies inside it stays whole, so a skirt
/// that fits prints exactly as before. A loop that leaves it is kept as its pieces inside.
///
/// The length of a cut skirt is what is left on the bed: `min_skirt_length` counts only that, and the loops it adds
/// are cut too. A cut skirt keeps at least one whole loop's length on the bed (the length of its innermost loop
/// before the cut): when the loops asked for leave less, loops are added outward, each cut, until they do, as
/// `min_skirt_length` adds them. When no loop adds anything more on the bed, the skirt is short (`Skirt::short`)
/// and the plate is refused.
fn skirt_around(
    hull: Vec<IntPoint<i32>>,
    cfg: &PrintConfig,
    includes_brim: bool,
    (tools, layer): (usize, u32),
    room: Option<&Shapes>,
) -> Skirt {
    if hull.len() < 3 {
        return Skirt::default();
    }
    let base: Shapes = vec![vec![hull]];
    // As in OrcaSlicer, loop k sits `skirt_distance + spacing * (k + 0.5)` from the occupied
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
    let mut out: Vec<Vec<paths::SkirtPath>> = Vec::new();
    // The skirt's length on the bed and one whole loop's length, mm, and where it was cut.
    let (mut on_bed, mut one_loop, mut cut) = (0.0_f64, None::<f64>, None::<IntPoint<i32>>);
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
        let whole = ring_length_mm(&ring);
        let first_loop = *one_loop.get_or_insert(whole);
        let (paths, length) = match room {
            Some(room) => {
                let (paths, length, at) = clip_ring(&ring, room);
                cut = cut.or(at);
                (paths, length)
            }
            None => (
                vec![paths::SkirtPath {
                    points: ring,
                    open: false,
                }],
                whole,
            ),
        };
        on_bed += length;
        if min_length > 0.0 {
            extruded += length * e_per_mm;
            if extruded < min_length {
                if remaining == 0 {
                    remaining = 1;
                }
            } else if extruder + 1 < tools {
                extruder += 1;
                extruded = 0.0;
            }
        }
        if cut.is_some() && remaining == 0 && on_bed < first_loop {
            remaining = 1;
        }
        // A loop with nothing on the bed: the loops further out have nothing on it either.
        let empty = paths.is_empty();
        if !empty {
            out.push(paths);
        }
        if k >= 1000 || empty {
            break;
        }
    }
    out.reverse();
    // `single_loop_draft_shield`: above the first layer one loop prints, the innermost (the last).
    if layer > 0 && crate::tower::flag(cfg, "single_loop_draft_shield") && out.len() > 1 {
        out.drain(..out.len() - 1);
    }
    let short = cut.filter(|_| on_bed < one_loop.unwrap_or(0.0));
    Skirt {
        paths: out.into_iter().flatten().collect(),
        cut,
        short,
    }
}

/// The shortest piece of a cut skirt loop that is kept, internal units: a shorter one would only leave a blob.
const SKIRT_PIECE_MIN: f64 = 1.0 * SCALE;

/// `ring` cut to `room`: the ring itself when it lies inside, else its pieces inside (the two at the ring's start
/// joined into one), with the length kept on the bed (mm) and, when it was cut, a point where it was.
fn clip_ring(ring: &[IntPoint<i32>], room: &Shapes) -> (Vec<paths::SkirtPath>, f64, Option<IntPoint<i32>>) {
    let Some(&start) = ring.first() else {
        return (Vec::new(), 0.0, None);
    };
    let mut closed = ring.to_vec();
    closed.push(start);
    let mut pieces = crate::support::clip_inside(&closed, room);
    if pieces.len() == 1 && pieces.first() == Some(&closed) {
        let length = ring_length_mm(ring);
        return (
            vec![paths::SkirtPath {
                points: ring.to_vec(),
                open: false,
            }],
            length,
            None,
        );
    }
    // A cut loop whose start lies inside: its last piece runs on into its first.
    if pieces.len() >= 2
        && pieces.first().and_then(|p| p.first()) == Some(&start)
        && pieces.last().and_then(|p| p.last()) == Some(&start)
        && let Some(mut last) = pieces.pop()
        && let Some(first) = pieces.first_mut()
    {
        last.extend(first.iter().skip(1).copied());
        *first = last;
    }
    let polyline = |p: &[IntPoint<i32>]| -> f64 {
        p.windows(2)
            .map(|w| match w {
                [a, b] => f64::from(b.x - a.x).m_hypot(f64::from(b.y - a.y)),
                _ => 0.0,
            })
            .sum()
    };
    // Where it was cut: the end of the first piece, on the edge, or the ring's start when nothing is left.
    let at = pieces.first().and_then(|p| p.last()).copied().unwrap_or(start);
    let mut length = 0.0;
    let kept: Vec<paths::SkirtPath> = pieces
        .into_iter()
        .filter_map(|p| {
            let l = polyline(&p);
            (l >= SKIRT_PIECE_MIN).then(|| {
                length += l;
                paths::SkirtPath {
                    points: p,
                    open: true,
                }
            })
        })
        .collect();
    (kept, length / SCALE, Some(at))
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
/// The filament of each feature of a region on `slot`: `outer_wall_filament_id`,
/// `inner_wall_filament_id`, `sparse_infill_filament_id`, `internal_solid_filament_id`,
/// `top_surface_filament_id` and `bottom_surface_filament_id` (0 is the region's own filament),
/// filled in as Orca does: internal solid from sparse, then from top or bottom,
/// and top and bottom from internal solid. On a Bambu Lab printer internal solid is not taken from sparse: Bambu
/// Studio keeps it, and the surfaces with it, on the region's own filament when only sparse infill moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FeatureTools {
    outer: u8,
    inner: u8,
    sparse: u8,
    solid: u8,
    top: u8,
    bottom: u8,
}

/// Per-feature filament keys. Older and other slicers' names for them are set under these names when the settings
/// are read (`crate::legacy`).
const FEATURE_KEYS: [&str; 6] = [
    "outer_wall_filament_id",
    "inner_wall_filament_id",
    "sparse_infill_filament_id",
    "internal_solid_filament_id",
    "top_surface_filament_id",
    "bottom_surface_filament_id",
];

/// A per-feature filament from settings read through `get`, 0 when unset.
fn feature_id_of<'v>(get: impl Fn(&str) -> Option<&'v serde_json::Value>, key: &str) -> u8 {
    let x = match get(key) {
        Some(serde_json::Value::Array(a)) => a.first(),
        other => other,
    };
    let n = match x {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(t)) => t.trim().parse().ok(),
        _ => None,
    };
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a filament slot"
    )]
    n.map_or(0, |x| x.clamp(0.0, 255.0).round() as u8)
}

fn feature_tools(cfg: &PrintConfig, slot: u8) -> FeatureTools {
    feature_tools_from(|name| cfg.raw.get(name), slot)
}

/// The filaments a part on `slot` prints its features with, from settings read through `get`: the part's own
/// first, then the plate's, as [`FeatureTools`] keeps them.
pub(crate) fn feature_slots<'v>(
    get: impl Fn(&str) -> Option<&'v serde_json::Value> + Copy,
    slot: u8,
) -> [u8; 6] {
    let t = feature_tools_from(get, slot);
    [t.outer, t.inner, t.sparse, t.solid, t.top, t.bottom]
}

fn feature_tools_from<'v>(
    get: impl Fn(&str) -> Option<&'v serde_json::Value> + Copy,
    slot: u8,
) -> FeatureTools {
    let [outer, inner, sparse, mut solid, mut top, mut bottom] = FEATURE_KEYS.map(|k| feature_id_of(get, k));
    let bambu = get("printer_model")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|m| m.starts_with("Bambu Lab"));
    if solid == 0 && sparse > 0 && !bambu {
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
            .any(|k| feature_id_of(|name| v.get(name), k) > 0)
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
        floating,
        region_floating,
        internal_bridge,
        internal_bridge_paths,
        internal_bridge_path_widths,
        top,
        bridge,
        bridge_paths,
        bridge_path_widths,
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
    // Bridges print with the internal solid infill's filament, as in OrcaSlicer.
    if !(shell.is_empty()
        && shell_thick.is_empty()
        && floating.is_empty()
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
            w.floating.extend(floating);
            w.region_floating.extend(region_floating);
            w.internal_bridge.extend(internal_bridge);
            // Each path keeps its own width; a work that sets none sends its default width for each path.
            let widths = |have: &[f32], paths: usize, of: f32| -> Vec<f32> {
                if have.len() == paths {
                    have.to_vec()
                } else {
                    vec![of; paths]
                }
            };
            if !internal_bridge_path_widths.is_empty() || !w.internal_bridge_path_widths.is_empty() {
                let mut all = widths(
                    &w.internal_bridge_path_widths,
                    w.internal_bridge_paths.len(),
                    w.internal_bridge_width,
                );
                all.extend(widths(
                    &internal_bridge_path_widths,
                    internal_bridge_paths.len(),
                    w.internal_bridge_width,
                ));
                w.internal_bridge_path_widths = all;
            }
            if !bridge_path_widths.is_empty() || !w.bridge_path_widths.is_empty() {
                let mut all = widths(&w.bridge_path_widths, w.bridge_paths.len(), w.bridge_width);
                all.extend(widths(&bridge_path_widths, bridge_paths.len(), w.bridge_width));
                w.bridge_path_widths = all;
            }
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
/// The filament `key` (`support_filament` or `support_interface_filament`) asks support to print with, 1-based;
/// 0 is whichever filament is active. A filament past the ones the settings set up is 0 as well: support then
/// prints with the active filament instead of changing to one that is not there (the slice warns, see
/// [`support_slot_warnings`]).
pub(crate) fn support_slot(cfg: &PrintConfig, key: &str) -> u8 {
    let asked = support_slot_asked(cfg, key);
    match filament_count(cfg) {
        Some(n) if usize::from(asked) > n => 0,
        _ => asked,
    }
}

/// The value of `key` as a filament slot, as the settings give it.
fn support_slot_asked(cfg: &PrintConfig, key: &str) -> u8 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a filament slot"
    )]
    {
        cfg.raw_number(key, 0.0).clamp(0.0, 255.0).round() as u8
    }
}

/// How many filaments the settings set up: the length of `filament_colour`, which hosts and projects give per
/// filament. `None` when the settings have no such list, so nothing is checked against it.
fn filament_count(cfg: &PrintConfig) -> Option<usize> {
    cfg.raw
        .get("filament_colour")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .filter(|n| *n > 0)
}

/// A warning for each support filament key that asks for a filament the settings do not set up.
fn support_slot_warnings(cfg: &PrintConfig) -> Vec<SliceWarning> {
    let Some(n) = filament_count(cfg) else {
        return Vec::new();
    };
    ["support_filament", "support_interface_filament"]
        .into_iter()
        .filter_map(|key| {
            let asked = support_slot_asked(cfg, key);
            (usize::from(asked) > n).then(|| SliceWarning {
                code: WarningCode::UnsupportedSetting,
                message: format!(
                    "{key} asks for filament {asked}, but this print has {n}; support prints with the current filament instead"
                ),
                layer: None,
            })
        })
        .collect()
}

/// The filaments of the support base and interface on a layer that starts on `active`.
fn support_tools(cfg: &PrintConfig, active: u8) -> (u8, u8) {
    let base = match support_slot(cfg, "support_filament") {
        0 => active,
        t => t,
    };
    // An interface without a filament of its own prints with the active one too, not the base's: Bambu Studio prints
    // it with the object's filament when only the base has its own.
    let iface = match support_slot(cfg, "support_interface_filament") {
        0 => active,
        t => t,
    };
    (base, iface)
}

/// The filaments support layer `sl` prints with on a layer that starts on `active`, in the order
/// [`place_support`] adds their works: the base, then the interface.
fn support_order(cfg: &PrintConfig, sl: &crate::support::SupportLayer, active: u8) -> Vec<u8> {
    let (base, iface) = support_tools(cfg, active);
    let mut v = Vec::new();
    if !sl.base.is_empty() {
        v.push(base);
    }
    if !sl.interface.is_empty() && !v.contains(&iface) {
        v.push(iface);
    }
    v
}

/// Puts a layer's support into the work of its filaments, adding a work for a filament the layer
/// does not print otherwise. Ironing goes with the interface.
/// The areas a travel to support may cross without a retraction, as in Orca: every
/// support island of the layer (`support_islands`, normal and organic support), or the branch areas of slim,
/// strong and hybrid trees.
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

fn place_support(
    works: &mut Vec<ToolWork>,
    sp: SupportPaths,
    (flow, round): (f32, f32),
    (base, iface): (u8, u8),
) {
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
    if !sp.support.is_empty() || !sp.round.is_empty() {
        let k = at(works, base);
        if let Some(w) = works.get_mut(k) {
            w.support = sp.support;
            w.support_round = sp.round;
            w.support_round_flow = round;
            w.support_flow = flow;
        }
    }
    if !sp.interface.is_empty() || !sp.ironing.is_empty() || !sp.round_interface.is_empty() {
        let k = at(works, iface);
        if let Some(w) = works.get_mut(k) {
            w.support_interface = sp.interface;
            w.support_interface_round = sp.round_interface;
            w.support_round_flow = round;
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
        .flat_map(|r| std::iter::once(r.0).chain(r.3.states()))
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

/// By object: what an object's plan leaves for the objects after it ([`SliceSession::hand_over`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct HandOver {
    /// The filament it starts on, 0 when it prints none.
    pub first: u8,
    /// The filament it ends on, 0 when it prints none.
    pub last: u8,
    /// The tools it prints with (bit per 0-based tool, as `LayerPaths::tools_before`).
    pub tools: u64,
    /// The tool changes it makes.
    pub changes: u32,
    /// With a filament map: what each nozzle holds at its end. Empty without a map.
    pub held: Vec<u8>,
}

/// The tool plan of a plate whose objects print layer by layer from sessions of their own (their own settings): one
/// order of the filaments per plate layer across all of them, as one session of the whole plate plans it, and the
/// prime tower they share.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PlateTools {
    /// Per plate layer (the objects' shared layers, or the layers [`SliceSession::interleaved_layers`] pairs by
    /// height), the order its filaments print in.
    pub orders: Vec<Vec<u8>>,
    /// Per plate layer, the print layer of each object of the sequence on it.
    pub layers: Vec<Vec<Option<u32>>>,
    /// The last plate layer the prime tower stands on.
    pub tower_top: Option<u32>,
    /// The tower's height, mm.
    pub tower_height: f64,
}

/// One layer of the prime tower, for [`SliceSession::tower_turns`].
#[derive(Debug, Clone, Copy)]
pub(crate) struct TowerLayer {
    /// The layer's index in the plan.
    pub layer: u32,
    /// The print's first layer (no raft under it).
    pub first: bool,
    /// The layer's height and its top, mm.
    pub h: f64,
    pub top: f64,
    /// The tower's height, mm.
    pub tower_height: f64,
    /// The filament the layer starts on (0 before the first one).
    pub start: u8,
    /// The tower as placed; None leaves it out.
    pub tower: Option<crate::tower::Tower>,
    /// The layer's index in the tool plan the tower was planned from (the plate's layer on a plate whose objects
    /// print from sessions of their own).
    pub order_at: u32,
}

/// One filament's turn on a layer, as the prime tower plans it: the turn's filament, what a change into it can flush
/// into, and the tower pieces printed before and after it.
pub(crate) trait TowerTurn {
    fn tool(&self) -> u8;
    /// The sparse infill, solid infill and support the turn starts with, mm3, for beads `width` wide and `height`
    /// high.
    fn infill_volume(&self, width: f64, height: f64) -> f64;
    fn solid_volume(&self, width: f64, height: f64) -> f64;
    fn support_volume(&self, width: f64, height: f64) -> f64;
    /// The turn prints its sparse infill first, to take up the purge.
    fn set_flush_first(&mut self);
    fn tower(&mut self) -> &mut Vec<crate::tower::TowerPath>;
    fn tower_after(&mut self) -> &mut Vec<crate::tower::TowerPath>;
}

impl TowerTurn for ToolWork {
    fn tool(&self) -> u8 {
        self.tool
    }
    fn infill_volume(&self, width: f64, height: f64) -> f64 {
        work_infill_volume(self, width, height)
    }
    fn solid_volume(&self, width: f64, height: f64) -> f64 {
        work_solid_volume(self, width, height)
    }
    fn support_volume(&self, width: f64, height: f64) -> f64 {
        work_support_volume(self, width, height)
    }
    fn set_flush_first(&mut self) {
        self.flush_first = true;
    }
    fn tower(&mut self) -> &mut Vec<crate::tower::TowerPath> {
        &mut self.tower
    }
    fn tower_after(&mut self) -> &mut Vec<crate::tower::TowerPath> {
        &mut self.tower_after
    }
}

/// A filament's turn on a plate layer whose objects come from sessions of their own (`sequence.rs`): the volumes
/// each object's first work of that filament reported (`LayerPaths::turns`), added up as the plate prints them.
#[derive(Debug, Clone, Default)]
pub(crate) struct PlateTurn {
    pub tool: u8,
    pub infill: f64,
    pub solid: f64,
    pub support: f64,
    pub flush_first: bool,
    pub tower: Vec<crate::tower::TowerPath>,
    pub tower_after: Vec<crate::tower::TowerPath>,
}

impl TowerTurn for PlateTurn {
    fn tool(&self) -> u8 {
        self.tool
    }
    fn infill_volume(&self, _: f64, _: f64) -> f64 {
        self.infill
    }
    fn solid_volume(&self, _: f64, _: f64) -> f64 {
        self.solid
    }
    fn support_volume(&self, _: f64, _: f64) -> f64 {
        self.support
    }
    fn set_flush_first(&mut self) {
        self.flush_first = true;
    }
    fn tower(&mut self) -> &mut Vec<crate::tower::TowerPath> {
        &mut self.tower
    }
    fn tower_after(&mut self) -> &mut Vec<crate::tower::TowerPath> {
        &mut self.tower_after
    }
}

/// The first work of each filament on a layer: whether it prints its sparse infill first, and the volumes a change
/// into it can flush into.
/// The first layer outline the brim grows from: the outline before elephant foot compensation, as in Orca, unless
/// `brim_use_efc_outline` asks for the compensated one.
fn brim_outline(cfg: &PrintConfig, here: &LayerRegions) -> Shapes {
    let use_efc = crate::firmware::truthy(cfg, "brim_use_efc_outline")
        && cfg.raw_number("elefant_foot_compensation", 0.0) > 0.0;
    match (&here.raw, use_efc) {
        (Some(raw), false) => raw.clone(),
        _ => perimeters::union_all(&here.regions.iter().map(|(_, s)| s).collect::<Vec<_>>()),
    }
}

/// The distance between brim loops, mm: as in Orca, the first layer line width less the rounded corners of the
/// bead.
fn brim_spacing(cfg: &PrintConfig) -> f64 {
    (cfg.line_width - cfg.initial_layer_print_height * (1.0 - std::f64::consts::FRAC_PI_4))
        .max(cfg.line_width * 0.5)
}

/// How many loops a brim `width` mm wide prints: an even number of spacings, as in Orca.
fn brim_loops(width: f64, spacing: f64) -> i32 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "brim loop count is small"
    )]
    let pairs = (width / spacing / 2.0).floor().max(0.0) as i32;
    2 * pairs
}

fn turn_rooms(works: &[ToolWork], width: f64, height: f64) -> Vec<crate::output::TurnRoom> {
    let mut rooms: Vec<crate::output::TurnRoom> = Vec::new();
    for w in works {
        if rooms.iter().any(|r| r.tool == w.tool) {
            continue;
        }
        rooms.push(crate::output::TurnRoom {
            tool: w.tool,
            flush_first: w.flush_first,
            infill: work_infill_volume(w, width, height),
            solid: work_solid_volume(w, width, height),
            support: work_support_volume(w, width, height),
        });
    }
    rooms
}

/// The tool changes `orders` makes in its first `p` layers.
fn changes_in(orders: &[Vec<u8>], p: usize) -> u32 {
    let mut order = orders.iter().take(p).flatten();
    let Some(&first) = order.next() else { return 0 };
    order
        .fold((first, 0u32), |(at, n), &t| (t, n + u32::from(t != at)))
        .1
}

/// The tools (bit per 0-based tool) `orders` prints with in its first `p` layers.
fn tools_in(orders: &[Vec<u8>], p: usize) -> u64 {
    orders
        .iter()
        .take(p)
        .flatten()
        .fold(0, |m, &t| m | 1u64 << u32::from(t.max(1) - 1).min(63))
}

/// With a filament map, the filament each nozzle holds after the first `p` layers of `orders`.
fn held_in(map: Option<&crate::nozzles::Map>, orders: &[Vec<u8>], p: usize) -> Vec<u8> {
    let Some(map) = map else {
        return Vec::new();
    };
    let nozzles = map.nozzle.iter().map(|&n| usize::from(n) + 1).max().unwrap_or(1);
    let mut held = vec![0u8; nozzles];
    for &t in orders.iter().take(p).flatten() {
        if let Some(h) = held.get_mut(map.nozzle_of(t)) {
            *h = t;
        }
    }
    held
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
        let cut = plan.cutting(lo, hi);
        (cut.end > cut.start).then(|| (cut.start, cut.end - 1))
    };
    for p in parts {
        let (lo, hi) = p
            .verts
            .iter()
            .fold((f64::MAX, f64::MIN), |(l, h), v| (l.min(v[2]), h.max(v[2])));
        if let Some((a, b)) = layers_of(lo, hi) {
            spans.push((p.slot, a, b));
        }
        for (tri, state) in p.paint.iter() {
            let (tri, state) = (&tri, &state);
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
                // A painted wall shows no paint on the layer that is the part's own top or bottom, where an
                // unpainted surface holds it back; a sloped face is that surface itself, so one facing down keeps
                // its paint on the bottom layer and one facing up on the top layer.
                let h = plan.thickness(0);
                let nz = crate::paint::unit_nz(tri).unwrap_or(0.0);
                let down = nz < -crate::paint::SLOPED;
                let up = nz > crate::paint::SLOPED;
                let lo_eff = if flo <= lo + 1e-6 && !down { flo + h } else { flo };
                let hi_eff = if fhi >= hi - 1e-6 && !up { fhi - h } else { fhi };
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
    order_layers(n, &present, first, choice)
}

/// The order the filaments of each of `n` layers print in, from the filaments each one has (`present`): a layer
/// starts on the filament the layer below ended on and ends on one the next layer has, unless the first layer's
/// order (`first`), the profile's sequences or the least flush (`choice`) say otherwise. Also the last layer with a
/// change between layers or inside one, and the last with one inside.
fn order_layers(
    n: usize,
    present: &dyn Fn(usize) -> Vec<u8>,
    first: &[u8],
    choice: &crate::toolorder::Choice,
) -> (Vec<Vec<u8>>, Option<u32>, Option<u32>) {
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
    let length = |paths: &[Vec<crate::geom::Point>]| -> f64 {
        paths
            .iter()
            .map(|p| {
                p.iter()
                    .zip(p.iter().skip(1))
                    .map(|(a, b)| a.dist_mm(*b))
                    .sum::<f64>()
            })
            .sum()
    };
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
    let round = length(&work.support_round) + length(&work.support_interface_round);
    len * crate::gcode::bead_area(width, height)
        + round * crate::gcode::bead_area(width, height) * f64::from(work.support_round_flow)
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
            // The per-feature filaments are read from the settings as given, not through `READ_KEYS`; their older
            // names were read as ours already (`crate::legacy`).
            if RANGE_KEYS.contains(&k.as_str()) || !crate::legacy::targets(k).is_empty() {
                continue;
            }
            if READ_KEYS.contains(&k.as_str()) {
                return Err(bad(format!(
                    "range {i}: {k} cannot change by height (allowed: {})",
                    RANGE_KEYS.join(", ")
                )));
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
                    if RANGE_KEYS.contains(&k.as_str()) {
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
pub(crate) fn copies_of(
    objects: &[&crate::plate::PlateObject],
    config: &PrintConfig,
) -> Option<Vec<(usize, [f64; 2])>> {
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
    let mut placed: Vec<(usize, [f64; 2])> = Vec::with_capacity(objects.len());
    for (i, o) in objects.iter().enumerate() {
        let of = if plain(o) {
            (0..i).find_map(|k| {
                let p = objects.get(k)?;
                let first = placed.get(k).is_some_and(|c| c.0 == k) && plain(p);
                first.then(|| moved(p, o)).flatten().map(|off| (k, off))
            })
        } else {
            None
        };
        placed.push(of.unwrap_or((i, [0.0, 0.0])));
    }
    placed.iter().enumerate().any(|(i, c)| c.0 != i).then_some(placed)
}

/// How far `b` stands from `a` across the bed, mm, when it is `a` moved there and nothing else: the same mesh,
/// filaments and height ranges under the same turn and scale, or, for two build items of a project file (whose parts load already
/// placed, [`crate::mesh::Placement`]), the same object of the file under the same item turn and scale, with parts
/// of the same triangles whose vertices lie at the items' difference. None for anything else.
fn moved(a: &crate::plate::PlateObject, b: &crate::plate::PlateObject) -> Option<[f64; 2]> {
    // The parts are placed in single precision, so each vertex is the item's difference away within its rounding;
    // a micron is well past that and well under anything a slice resolves.
    const ROUNDING_MM: f64 = 1e-3;
    type Points = [[f32; 3]];
    let (ta, tb) = (&a.transform, &b.transform);
    // The turn and scale (the first three columns) and the height and last row agree; only x and y move.
    if ta.get(..12) != tb.get(..12) || ta.get(14..) != tb.get(14..) || a.slot_overrides != b.slot_overrides {
        return None;
    }
    // A copy prints the first one's layers, so the settings and layer heights a project file gives each by height
    // (`Mesh::height_ranges`, `Mesh::layer_heights`) must be the same.
    if a.mesh.height_ranges != b.mesh.height_ranges || a.mesh.layer_heights != b.mesh.layer_heights {
        return None;
    }
    let own = [
        f64::from(tb[12]) - f64::from(ta[12]),
        f64::from(tb[13]) - f64::from(ta[13]),
    ];
    let (ma, mb) = (&a.mesh, &b.mesh);
    let parts_match = |same: &dyn Fn(&Points, &Points) -> bool| {
        ma.parts.len() == mb.parts.len()
            && ma.parts.iter().zip(&mb.parts).all(|(p, q)| {
                p.name == q.name
                    && p.slot == q.slot
                    && p.triangles == q.triangles
                    && same(&p.positions, &q.positions)
            })
    };
    if std::sync::Arc::ptr_eq(ma, mb) || parts_match(&|u, v| u == v) {
        return Some(own);
    }
    // Build items of one object: only an exact copy of its turn and scale, and nothing of their own on the meshes.
    let (pa, pb) = (ma.placement.as_ref()?, mb.placement.as_ref()?);
    let bare =
        |m: &crate::mesh::Mesh| m.volumes.is_empty() && m.part_settings.is_empty() && m.settings.is_null();
    if pa.object != pb.object || pa.transform.get(..9) != pb.transform.get(..9) || !bare(ma) || !bare(mb) {
        return None;
    }
    let step: [f64; 3] = std::array::from_fn(|c| {
        pb.transform.get(9 + c).copied().unwrap_or(0.0) - pa.transform.get(9 + c).copied().unwrap_or(0.0)
    });
    // The items' difference is in the mesh's space; the plate object's turn takes it onto the bed, where it may
    // only move across.
    let m = ta.map(f64::from);
    let across = |r: usize| {
        (0..3)
            .map(|c| m.get(c * 4 + r).copied().unwrap_or(0.0) * step.get(c).copied().unwrap_or(0.0))
            .sum::<f64>()
    };
    if across(2).abs() > 1e-9 {
        return None;
    }
    let close = |u: &Points, v: &Points| {
        u.len() == v.len()
            && u.iter().zip(v).all(|(p, q)| {
                p.iter()
                    .zip(q)
                    .zip(&step)
                    .all(|((&p, &q), &d)| (f64::from(q) - f64::from(p) - d).abs() <= ROUNDING_MM)
            })
    };
    parts_match(&close).then(|| [own[0] + across(0), own[1] + across(1)])
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

/// Orca's rectilinear sweep over `area` for lines along `d` at `density`: lines joined end to end along the
/// walls. The lines end at the area pulled in by 0.05 spacing, the turns follow it pulled in by half a spacing, and
/// a line that never reaches the inner contour is dropped.
/// `consistent` is the pattern that keeps its place from layer to layer (zigzag, cross zag, locked zag: paths start
/// from the bottom of a line with an even index and from the top of the others, and turns only go to the next
/// line). `shift_mm` moves the lattice sideways: the area is moved the other way and the lines back,
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

/// a thousandth of a mm under the bed still counts as on it (prusa's sinking threshold). bambu writes -0.001,
/// which f32 widens to just under that, hence the slack.
fn below_bed(min_z: f64) -> bool {
    min_z < -(0.001 + 1e-4)
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

#[cfg(test)]
mod feature_slot_tests {
    use super::feature_slots;
    use crate::config::PrintConfig;
    use serde_json::json;

    /// The filaments of outer and inner wall, sparse and internal solid infill, top and bottom surface of a part on
    /// `slot` with these settings as the object's own, read as a slice reads them: over the engine's defaults.
    fn slots_on(c: &serde_json::Value, slot: u8) -> [u8; 6] {
        let mut cfg = PrintConfig::from_value(&json!({})).expect("the defaults read");
        cfg.apply_value(c).expect("the settings read");
        feature_slots(|k| cfg.raw.get(k), slot)
    }

    fn slots(c: &serde_json::Value) -> [u8; 6] {
        slots_on(c, 1)
    }

    #[test]
    fn on_a_bambu_printer_solid_infill_stays_on_the_parts_filament_when_only_sparse_moves() {
        // Bambu Studio: walls on 2, sparse on 3, solid unset: solid infill and the surfaces print with filament 1.
        let c = json!({"printer_model": "Bambu Lab H2D", "wall_filament": 2, "sparse_infill_filament": 3});
        assert_eq!(slots(&c), [2, 2, 3, 1, 1, 1]);
        // Solid infill set: the surfaces follow it.
        let c = json!({"printer_model": "Bambu Lab P1S", "sparse_infill_filament": 2, "solid_infill_filament": 3});
        assert_eq!(slots(&c), [1, 1, 2, 3, 3, 3]);
    }

    #[test]
    fn bambu_studio_names_are_read_as_strings_or_numbers() {
        // Bambu Studio writes every value as a string.
        for v in [json!("2"), json!(2)] {
            let c = json!({"printer_model": "Bambu Lab X2D", "sparse_infill_filament": v});
            assert_eq!(slots(&c), [1, 1, 2, 1, 1, 1], "sparse_infill_filament {v}");
        }
        // `wall_filament` is both walls in Bambu Studio.
        let c = json!({"printer_model": "Bambu Lab X2D", "wall_filament": "2"});
        assert_eq!(slots(&c), [2, 2, 1, 1, 1, 1]);
    }

    #[test]
    fn a_bambu_studio_one_is_filament_one_and_zero_is_the_parts_own() {
        // Studio 2.8 is 1 based with 0 for the part's own filament: a part on 2 with infill on "1" prints infill
        // with filament 1.
        let c = json!({"printer_model": "Bambu Lab X2D", "sparse_infill_filament": "1"});
        assert_eq!(slots_on(&c, 2), [2, 2, 1, 2, 2, 2]);
        let c = json!({"printer_model": "Bambu Lab X2D", "sparse_infill_filament": "0"});
        assert_eq!(slots_on(&c, 2), [2, 2, 2, 2, 2, 2]);
    }

    #[test]
    fn a_plates_own_bambu_studio_names_are_left_unread() {
        // Bambu Studio prints a project's values for these on nothing, "1" and others alike.
        for v in ["1", "2", "3"] {
            let c = json!({"printer_model": "Bambu Lab X2D", "wall_filament": v, "sparse_infill_filament": v,
                "solid_infill_filament": v});
            let cfg = PrintConfig::from_value(&c).expect("the settings read");
            assert_eq!(feature_slots(|k| cfg.raw.get(k), 2), [2; 6], "{v}");
        }
    }

    #[test]
    fn orca_and_prusaslicer_names_keep_one_as_the_parts_own() {
        // Not measured against their output yet: the old rule stays for these names.
        let c = json!({"infill_extruder": 1, "perimeter_extruder": "1"});
        assert_eq!(slots_on(&c, 2), [2, 2, 2, 2, 2, 2]);
        let c = json!({"infill_extruder": 3});
        assert_eq!(slots_on(&c, 2), [2, 2, 3, 3, 3, 3]);
    }

    #[test]
    fn our_own_name_wins_over_an_older_one_in_the_same_settings() {
        let c = json!({"sparse_infill_filament": "3", "sparse_infill_filament_id": 2});
        assert_eq!(slots(&c), [1, 1, 2, 2, 2, 2]);
    }

    #[test]
    fn on_other_printers_solid_infill_follows_sparse_as_orca_fills_it() {
        let c = json!({"printer_model": "Generic Marlin", "sparse_infill_filament_id": 2});
        assert_eq!(slots(&c), [1, 1, 2, 2, 2, 2]);
        assert_eq!(
            slots(&json!({"sparse_infill_filament_id": 2})),
            [1, 1, 2, 2, 2, 2]
        );
    }
}

#[cfg(test)]
mod below_bed_tests {
    use super::below_bed;

    #[test]
    fn a_part_on_the_bed_or_a_thousandth_into_it_is_not_below_it() {
        assert!(!below_bed(f64::from(0.0f32)));
        // bambu writes this, and as an f32 it is -0.00100000005
        assert!(!below_bed(f64::from(-0.001f32)));
        assert!(below_bed(f64::from(-0.01f32)));
    }
}

#[cfg(test)]
mod paint_tests {
    #![allow(
        clippy::cast_possible_truncation,
        clippy::indexing_slicing,
        reason = "a small procedural model"
    )]
    use super::*;
    use crate::mesh::{Mesh, MeshPart};
    use crate::paint::PaintFacet;

    /// A 10 mm slab of filament 1 with a wavy disc of filament 2 sunk into its bottom, the disc's side and top
    /// painted with filament 1. Where the paint meets the disc's outline, each corner the color's tips are
    /// rounded off at leaves a speck of filament 2.
    fn painted_disc() -> Mesh {
        const N: u32 = 48;
        let mut positions: Vec<[f32; 3]> = Vec::new();
        for z in [0.0, 0.8] {
            for k in 0..N {
                let a = std::f64::consts::TAU * f64::from(k) / f64::from(N);
                let r = 3.0 + 0.5 * (6.0 * a).m_sin();
                let (s, c) = a.m_sin_cos();
                positions.push([(5.0 + r * c) as f32, (5.0 + r * s) as f32, z]);
            }
        }
        positions.extend([[5.0, 5.0, 0.0], [5.0, 5.0, 0.8]]);
        let (b, t) = (|k: u32| k % N, |k: u32| N + k % N);
        let mut triangles = Vec::new();
        let mut painted = Vec::new();
        for k in 0..N {
            triangles.push([2 * N, b(k + 1), b(k)]);
            for tri in [
                [2 * N + 1, t(k), t(k + 1)],
                [b(k), b(k + 1), t(k + 1)],
                [b(k), t(k + 1), t(k)],
            ] {
                triangles.push(tri);
                painted.push(PaintFacet {
                    v: tri.map(|i| positions[i as usize]),
                    state: 1,
                });
            }
        }
        let mut slab = Vec::new();
        for z in [0.0, 1.2] {
            for (x, y) in [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)] {
                slab.push([x, y, z]);
            }
        }
        let mut slab_tris = vec![[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7]];
        for k in 0..4u32 {
            let n = (k + 1) % 4;
            slab_tris.push([k, n, 4 + n]);
            slab_tris.push([k, 4 + n, 4 + k]);
        }
        Mesh {
            name: "disc".into(),
            parts: vec![
                MeshPart {
                    name: "slab".into(),
                    slot: 1,
                    positions: slab,
                    triangles: slab_tris,
                    ..MeshPart::default()
                },
                MeshPart {
                    name: "disc".into(),
                    slot: 2,
                    positions,
                    triangles,
                    paint: painted,
                    ..MeshPart::default()
                },
            ],
            ..Mesh::default()
        }
    }

    #[test]
    fn painted_layers_have_no_specks_or_pinholes() {
        let cfg = PrintConfig::default();
        let plate = Plate::single_on(painted_disc(), cfg.bed_rect(), cfg.printable_height);
        let session = SliceSession::new(&plate, &cfg).unwrap();
        let fam = Families::new(&cfg);
        // 0.01 mm2 in square units.
        let speck = |r: &Vec<IntPoint<i32>>| crate::geom::area2_int(r).unsigned_abs() < 2_000_000;
        let mut painted = 0;
        for l in 0..session.plan.count() {
            let r = session.layer_regions(l, fam, &Micros::default());
            painted += usize::from(r.regions.len() > 1);
            for (slot, shapes) in &r.regions {
                let n = shapes.iter().flatten().filter(|r| speck(r)).count();
                assert_eq!(n, 0, "layer {l}: {n} specks in the region of filament {slot}");
            }
            let n = slice_shapes(&r).iter().flatten().filter(|r| speck(r)).count();
            assert_eq!(n, 0, "layer {l}: {n} specks and pinholes in the outline");
        }
        assert!(painted >= 3, "{painted} layers with two filaments");
    }
}

#[cfg(test)]
mod footprint_tests {
    use crate::config::PrintConfig;
    use crate::mesh::{Mesh, MeshPart};
    use crate::plate::Plate;
    use crate::session::SliceSession;

    /// An axis-aligned box from (0,0,0) to (x,y,z).
    fn block(name: &str, x: f32, y: f32, z: f32) -> Mesh {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [x, 0.0, 0.0],
            [x, y, 0.0],
            [0.0, y, 0.0],
            [0.0, 0.0, z],
            [x, 0.0, z],
            [x, y, z],
            [0.0, y, z],
        ];
        let triangles = vec![
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        Mesh {
            name: name.to_owned(),
            parts: vec![MeshPart {
                name: name.to_owned(),
                slot: 1,
                color: None,
                positions,
                triangles,
                paint: Vec::new(),
                support_paint: Vec::new(),
                seam_paint: Vec::new(),
                fuzzy_paint: Vec::new(),
                paint_texts: Vec::new(),
            }],
            ..Mesh::default()
        }
    }

    /// Objects with settings of their own are sliced apart, each in a session of its own: worked out once for
    /// the plate, every footprint is what the object alone would give, in the plate's order.
    #[test]
    fn a_plate_sliced_apart_keeps_every_object_footprint() {
        let mut plate = Plate::single(block("a", 20.0, 10.0, 5.0));
        let mut b = plate.objects[0].clone();
        b.id = "object-2".to_owned();
        b.name = "b".to_owned();
        b.mesh = std::sync::Arc::new(block("b", 8.0, 30.0, 12.0));
        b.transform[12] += 40.0;
        b.settings = serde_json::json!({ "wall_loops": 3 });
        plate.objects.push(b);
        let alone = |i: usize| {
            crate::firmware::footprints(&Plate {
                bed: plate.bed,
                objects: vec![plate.objects[i].clone()],
            })
        };
        let all = crate::firmware::footprints(&plate);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0], alone(0)[0]);
        assert_eq!(all[1], alone(1)[0]);
        let session = SliceSession::new(&plate, &PrintConfig::default()).expect("the plate builds");
        assert_eq!(session.footprints(), all.as_slice());
    }
}

#[cfg(test)]
mod shared_paint_tests {
    use crate::api::{self, SliceRequest};
    use crate::mesh::{Mesh, MeshPart};
    use crate::paint::{Facets, PaintFacet, Pieces};
    use std::sync::Arc;

    /// `facets` with each piece moved `dx` mm along x and its filament changed by `state`.
    fn moved(facets: &[PaintFacet], dx: f32, state: impl Fn(u8) -> u8) -> Vec<PaintFacet> {
        facets
            .iter()
            .map(|f| PaintFacet {
                v: f.v.map(|p| [p[0] + dx, p[1], p[2]]),
                state: state(f.state),
            })
            .collect()
    }

    /// Two painted objects: the painted cube (top in filament 2, a side in fuzzy skin), and a model of three parts.
    /// Its first part has paint but no triangles, so the session skips it; the second is the cube with its top in
    /// filament 3; the third is the cube 25 mm along x, top in filament 2, no fuzzy skin. A part that read another
    /// part's paint, or the paint at the wrong index, would print another color or none.
    fn request() -> (SliceRequest, Arc<Mesh>, Arc<Mesh>) {
        let cube = Mesh::load(include_bytes!("../tests/fixtures/painted-cube.sxmp"), "cube.3mf")
            .expect("the painted cube loads");
        let p = &cube.parts[0];
        assert!(!p.paint.is_empty() && !p.fuzzy_paint.is_empty());
        let empty = MeshPart {
            name: "empty".to_owned(),
            positions: Vec::new(),
            triangles: Vec::new(),
            paint: moved(&p.paint, 0.0, |_| 1),
            fuzzy_paint: p.fuzzy_paint.clone(),
            ..p.clone()
        };
        let third = MeshPart {
            name: "third".to_owned(),
            positions: p.positions.iter().map(|q| [q[0] + 25.0, q[1], q[2]]).collect(),
            paint: moved(&p.paint, 25.0, |s| s),
            support_paint: moved(&p.support_paint, 25.0, |s| s),
            seam_paint: moved(&p.seam_paint, 25.0, |s| s),
            fuzzy_paint: Vec::new(),
            ..p.clone()
        };
        let second = MeshPart {
            name: "second".to_owned(),
            paint: moved(&p.paint, 0.0, |s| if s == 2 { 3 } else { s }),
            ..p.clone()
        };
        let parts = Mesh {
            name: "parts".to_owned(),
            parts: vec![empty, second, third],
            ..cube.clone()
        };
        let req: SliceRequest = serde_json::from_value(serde_json::json!({
            "plate": { "objects": [
                { "id": "a", "mesh": "cube", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 150, 150, 0, 1] },
                { "id": "b", "mesh": "parts", "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 40, 60, 0, 1] }
            ] },
            "config": { "filament_colour": ["#FF0000", "#0000FF", "#00FF00"], "enable_prime_tower": false, "fuzzy_skin": "none" },
            "options": {}
        }))
        .expect("the request parses");
        (req, Arc::new(cube), Arc::new(parts))
    }

    /// The session reads each part's color and fuzzy skin paint in place from the plate's mesh, and reads it as a
    /// copy of the paint would: the same pieces part by part, and the same G-code.
    #[test]
    fn paint_read_in_place_prints_as_a_copy_of_it() {
        let (req, cube, parts) = request();
        let (config, _) = api::request_config_checked(&req).expect("the config builds");
        let meshes = move |id: &str| Ok(if id == "cube" { cube.clone() } else { parts.clone() });
        let plate = api::build_plate(&req, &meshes).expect("the plate builds");
        let shared = api::build_session(&req, &plate, &config).expect("the session builds");
        // The paint as the session copied it before, part by part in the session's order.
        let mut copied = api::build_session(&req, &plate, &config).expect("the session builds");
        let placed: Vec<(&MeshPart, &[f32; 16])> = plate
            .objects
            .iter()
            .flat_map(|o| {
                o.mesh
                    .parts
                    .iter()
                    .filter(|p| !p.triangles.is_empty())
                    .map(|p| (p, &o.transform))
            })
            .collect();
        assert_eq!(placed.len(), 3);
        assert_eq!(copied.parts.len(), placed.len());
        for (part, (p, t)) in copied.parts.iter_mut().zip(&placed) {
            part.paint = Facets::placed(&p.paint, t);
        }
        let fuzzy: Vec<(usize, Facets)> = placed
            .iter()
            .enumerate()
            .filter(|(_, (p, _))| !p.fuzzy_paint.is_empty())
            .map(|(k, (p, t))| (k, Facets::placed(&p.fuzzy_paint, t)))
            .collect();
        assert_eq!(fuzzy.iter().map(|f| f.0).collect::<Vec<_>>(), [0, 1]);
        copied.fuzzy_paint = fuzzy;

        let in_place = |f: &Facets| matches!(f, Facets::Placed(Pieces::Part(..), _));
        assert_eq!(shared.parts.len(), copied.parts.len());
        for (k, (a, b)) in shared.parts.iter().zip(&copied.parts).enumerate() {
            assert!(
                in_place(&a.paint),
                "part {k}: the paint is read in place, not copied"
            );
            assert!(
                a.paint.iter().eq(b.paint.iter()),
                "part {k}: the same painted pieces"
            );
        }
        assert_eq!(shared.fuzzy_paint.len(), copied.fuzzy_paint.len());
        for ((i, a), (j, b)) in shared.fuzzy_paint.iter().zip(&copied.fuzzy_paint) {
            assert_eq!(i, j);
            assert!(in_place(a), "part {i}: the fuzzy skin paint is read in place");
            assert!(a.iter().eq(b.iter()), "part {i}: the same fuzzy skin pieces");
        }

        let gcode = |session: &super::SliceSession| {
            let mut out = Vec::new();
            api::slice_shard(
                &req,
                session,
                &config,
                0..session.layer_count(),
                &crate::NoProgress,
                &mut out,
            )
            .expect("the plate slices");
            out
        };
        let g = gcode(&shared);
        assert!(
            g == gcode(&copied),
            "read in place, the paint prints the bytes its copy prints"
        );
        let text = String::from_utf8_lossy(&g);
        for tool in ["T1", "T2"] {
            assert!(
                text.lines().any(|l| l.starts_with(tool)),
                "a painted top prints with {tool}"
            );
        }
    }
}

/// The parts of a solid surface too narrow for its lines: where the surface pulled in by half a spacing (the lines'
/// ends) is gone or a strip under 0.3 spacings wide. Slivers under 0.3 spacings, such as a corner the lines' turns cut
/// off, are not bands.
fn thin_bands(region: &Shapes, spacing_mm: f64) -> Shapes {
    let k = mm(0.15 * spacing_mm);
    let ends = perimeters::offset(region, -mm(0.5 * spacing_mm));
    let core = perimeters::offset(&perimeters::offset(&ends, -k), k);
    let reach = perimeters::offset(&core, mm(0.5 * spacing_mm) + k);
    let rest = perimeters::difference(region, &reach);
    perimeters::offset(&perimeters::offset(&rest, -k), k)
}

#[cfg(test)]
mod solid_join_tests {
    use crate::fm::Fm;
    use crate::geom::SCALE;
    use crate::mesh::{Mesh, MeshPart};
    use crate::output::Feature;
    use crate::plate::Plate;
    use crate::session::SliceSession;

    /// A 10 x 10 mm block, 2 mm tall and turned 20 degrees: every layer is a solid surface, and its edges meet the
    /// fill lines at uneven places. (The edges of a square turned 0 or 45 degrees meet the lines where both ends of a
    /// line round alike.)
    fn block() -> Mesh {
        let (sin, cos) = 20.0_f32.to_radians().m_sin_cos();
        let corners = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]
            .map(|[x, y]: [f32; 2]| [x * cos - y * sin, x * sin + y * cos]);
        let positions = [0.0, 2.0]
            .iter()
            .flat_map(|&z| corners.map(|[x, y]| [x, y, z]))
            .collect();
        Mesh {
            name: "block".to_owned(),
            parts: vec![MeshPart {
                name: "block".to_owned(),
                slot: 1,
                color: None,
                positions,
                triangles: vec![
                    [0, 2, 1],
                    [0, 3, 2],
                    [4, 5, 6],
                    [4, 6, 7],
                    [0, 1, 5],
                    [0, 5, 4],
                    [1, 2, 6],
                    [1, 6, 5],
                    [2, 3, 7],
                    [2, 7, 6],
                    [3, 0, 4],
                    [3, 4, 7],
                ],
                paint: Vec::new(),
                support_paint: Vec::new(),
                seam_paint: Vec::new(),
                fuzzy_paint: Vec::new(),
                paint_texts: Vec::new(),
            }],
            ..Mesh::default()
        }
    }

    /// A join of a straight solid surface links two scanlines. A fill line whose two ends round to scanline values
    /// one unit apart is a line, on the 135 degree layers too: no join runs along the layer's lines.
    #[test]
    fn a_solid_join_always_links_two_scanlines() {
        let req: crate::api::SliceRequest = serde_json::from_value(serde_json::json!({
            "plate": { "objects": [{ "mesh": "block" }] },
            "config": {
                "bottom_surface_pattern": "monotonic",
                "internal_solid_infill_pattern": "monotonic",
                "top_surface_pattern": "monotonic",
                "bottom_shell_layers": 3,
                "top_shell_layers": 7,
            },
        }))
        .expect("the request parses");
        let config = crate::api::request_config(&req).expect("the config builds");
        let session = SliceSession::new(&Plate::single(block()), &config).expect("the plate builds");
        let out = session
            .slice_range_with(&config, 0..session.layer_count(), &crate::NoProgress)
            .expect("the block slices");
        let solid = |f: Feature| {
            matches!(
                f,
                Feature::BottomSurface | Feature::InternalSolid | Feature::TopSurface
            )
        };
        let (mut at_135, mut checked) = (0, 0);
        for (z, l) in out.layers.iter().enumerate() {
            // The layer's fill direction, from its longest solid line.
            let Some(dir) = l
                .paths
                .iter()
                .filter(|p| solid(p.feature))
                .flat_map(|p| l.path_points(p).windows(2))
                .filter_map(|w| {
                    let (a, b) = (w.first()?, w.get(1)?);
                    let v = [f64::from(b.x - a.x), f64::from(b.y - a.y)];
                    Some((v[0].m_hypot(v[1]), v))
                })
                .max_by(|a, b| a.0.total_cmp(&b.0))
                .map(|(n, v)| [v[0] / n, v[1] / n])
            else {
                continue;
            };
            if dir[0] * dir[1] < 0.0 {
                at_135 += 1;
            }
            for [a, b] in &l.joins {
                let v = [f64::from(b.x - a.x), f64::from(b.y - a.y)];
                let across = (v[0] * dir[1] - v[1] * dir[0]).abs() / SCALE;
                // A line's ends sit a unit or two (0.1 um each) off its scanline; a turn, even one piece of a
                // turn round a corner, moves 0.005 mm or more across.
                assert!(
                    across > 0.002,
                    "layer {z}: a join from {a:?} to {b:?} moves {across:.4} mm across the lines"
                );
                checked += 1;
            }
        }
        assert!(at_135 >= 3, "the block has 135 degree solid layers ({at_135})");
        assert!(checked > 50, "the block's surfaces have joins ({checked})");
    }
}
