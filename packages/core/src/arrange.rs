// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Arrange for a plate of distinct objects (`plate.placement` `arrange`): every object of the plate is packed on the
//! printer's bed with sx-geom's nest, the true shape nest the app's Arrange runs, before the slice. Each object keeps
//! its rotation and scale and may turn about Z. The layout keeps:
//!
//! - the printable area, and off the printer's keep-out zones (`bed_exclude_area`, the nozzle wrap check corner
//!   `head_wrap_detect_zone`), as the slice reads them ([`crate::preflight::keep_out_zones`]);
//! - by layer, the spacing between objects (6 mm unless asked), room for each object's brim, support pad and skirt,
//!   the skirt round the whole print off the keep-out zones, and the prime tower's room when the plate prints in two
//!   filaments or more;
//! - by object, the extruder clearance radius the plate check holds the plate to ([`crate::collide::clearance_radius`])
//!   plus what each object prints round itself ([`crate::collide::rules::object_room_around`]), and on request lanes
//!   across the bed so no two objects taller than the gantry rod share the gantry's reach.
//!
//! The settings are the plate's; an object's own settings do not change its room. The nest counts work, not time, so
//! the same plate always gives the same layout. Objects with no room are listed, never overlapped.

// Object and shape indices are built from the plate and checked in this module.
#![allow(
    clippy::indexing_slicing,
    reason = "indices of the plate's objects, built here"
)]

use std::collections::HashMap;

use serde::Serialize;
use sx_geom::mesh::TriMesh;
use sx_geom::nest::{
    self, NestBed, NestFixed, NestItem, NestOptions, NestProblem, NestResult, NestZone, SilhouetteOptions,
};
use sx_geom::poly2d::Polygon;

use crate::api::ArrangeSpec;
use crate::collide::rules::support;
use crate::config::PrintConfig;
use crate::error::{Error, Result};
use crate::fm::Fm as _;
use crate::plate::{Plate, PlateObject};

/// Room kept beyond what is computed, mm: the engine rounds a brim up to whole lines.
pub const MARGIN_SAFETY_MM: f64 = 1.0;
/// The spacing between objects and from the bed edge when the request names none, mm: the app's arrange default.
pub const DEFAULT_SPACING_MM: f64 = 6.0;
/// Turn step when the request names none, degrees: the app's arrange default.
const STEP_DEG: f64 = 10.0;
/// How much further a gantry lane reaches than the rod's reach, mm: the plate check counts the bed in 1 mm cells, so a
/// footprint can reach a cell further either way.
const LANE_SAFETY_MM: f64 = 2.0;

/// An object the arrange placed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangedObject {
    pub id: String,
    pub name: String,
    /// The middle of its footprint's box on the bed, machine coordinates, mm.
    pub center_mm: [f64; 2],
    /// How far the arrange turned it about Z, after its own rotation, degrees counterclockwise, 0 to 360.
    pub turn_deg: f64,
    /// Its new transform, 4x4 column-major, machine coordinates, mm.
    pub transform: Vec<f32>,
}

/// An object the arrange found no room for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotFit {
    pub id: String,
    pub name: String,
    /// `no_room`: the bed holds it, but not beside the others; `too_large`: not even an empty bed holds it with its
    /// margins.
    pub reason: &'static str,
}

/// A plate's layout and how it was made.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Arrangement {
    /// The plate prints by object (`print_sequence`), so its objects keep the extruder clearance apart.
    pub by_object: bool,
    /// The spacing between objects and from the bed edge, mm.
    pub spacing_mm: f64,
    /// Printing by object: the extruder clearance radius the objects keep apart, mm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clearance_mm: Option<f64>,
    /// Objects could turn about Z.
    pub rotate: bool,
    /// Printing by object: the objects taller than the gantry rod went in lanes of their own across the bed.
    pub lanes: bool,
    /// What the layout keeps clear of besides the bed edge: `exclusion-area`, `wrap-check-zone`, `prime-tower`.
    pub keep_out: Vec<&'static str>,
    /// The objects placed, in the plate's order.
    pub objects: Vec<ArrangedObject>,
    /// The objects with no room, in the plate's order; they keep their transforms and are not sliced.
    pub not_fit: Vec<NotFit>,
    /// Printing by object: the print order the layout takes, as object ids, when it is not the plate's own: the plate
    /// check's one-click new order, taken when the layout in the plate's order still has a strike it is sure of (an
    /// object taller than the gantry rod printed before a low one under its gantry). The request's objects are put in
    /// this order. Empty otherwise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
    /// Printing by object: heimdall's plate check of the layout (`sx check`), when every object fits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<crate::collide::check::PlateCheck>,
    /// With [`crate::api::ArrangeSpec::new_plates`]: the objects with no room laid out on new, empty plates, in order,
    /// each as an arrange of the objects still left lays it out. Objects no plate takes stay in `not_fit` only.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub plates: Vec<PlateLayout>,
}

/// One new plate of an arrange ([`Arrangement::plates`]).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateLayout {
    /// The objects placed on it, in the plate's order.
    pub objects: Vec<ArrangedObject>,
    /// Printing by object: the print order it takes when it is not the plate's own ([`Arrangement::order`]).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
    /// Printing by object, when every object of it fits: the plate check of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<crate::collide::check::PlateCheck>,
}

/// One object as the nest takes it.
struct Shape {
    /// Its place in the plate.
    k: usize,
    /// Its outline seen from above where it stands, plate coordinates (from the printable area's front left corner).
    polygons: Vec<Polygon>,
    hull: Vec<[f64; 2]>,
    /// How tall it stands, mm.
    height: f64,
    /// How far its first layer reaches past its outline (brim, support pad), mm.
    grow: f64,
    /// How far everything printed for it reaches (its skirt included), mm.
    reach: f64,
}

/// The plate's room: the bed, the zones, and how the objects are spaced.
struct Room {
    bed: NestBed,
    zones: Vec<NestZone>,
    keep_out_zones: u32,
    tower_zones: u32,
    gap: f64,
    /// By object: the clearance radius and the safety.
    apart: Option<f64>,
    skirt: bool,
    rotate: bool,
    /// Turn step, degrees.
    step: f64,
    /// The nest's work after its first layout.
    budget: f64,
}

/// Lays out every object of `plate` that has something to print with `cfg`: the new transform of each object, in the
/// plate's order (an object with no room, or nothing to print, keeps its own), and the report. With `lanes` the
/// objects taller than the gantry rod go first, one at a time, each out of the lanes of the ones before it. Printing by
/// object, `more` mm go on top of the clearance between objects (the push the plate check asked of a layout before).
pub(crate) fn arrange(
    plate: &Plate,
    cfg: &PrintConfig,
    spec: &ArrangeSpec,
    lanes: bool,
    more: f64,
) -> Result<(Vec<[f32; 16]>, Arrangement)> {
    let by_object = cfg.print_by_object();
    let area = printable(plate, cfg);
    let origin = [area[0], area[1]];
    let gap = spec.spacing_mm.unwrap_or(DEFAULT_SPACING_MM).max(0.0);
    let rotate = spec.rotate.unwrap_or(true);
    // Printing by layer, whether each object gets support, by its mesh and how it is turned and scaled (copies share
    // one answer). By object the support pad stays in each object's reach, as the slice's clearance check counts it.
    let mut turns = HashMap::new();
    let shapes: Vec<Shape> = plate
        .objects
        .iter()
        .enumerate()
        .filter_map(|(k, o)| {
            let bare = if by_object {
                None
            } else {
                unsupported(cfg, o, &mut turns)
            };
            shape(k, o, bare.as_ref().unwrap_or(cfg), origin, by_object)
        })
        .collect();
    let (zones, keep_out, kinds) = zones(plate, cfg, origin, &area, by_object);
    let radius = crate::collide::clearance_radius(cfg);
    let skirt_whole = whole_skirt(cfg) && !by_object;
    let room = Room {
        bed: NestBed {
            width_mm: area[2] - area[0],
            depth_mm: area[3] - area[1],
            round: delta(cfg),
        },
        zones,
        keep_out_zones: keep_out,
        tower_zones: u32::from(kinds.contains(&"prime-tower")),
        gap,
        apart: by_object.then_some(radius.max(0.0) + MARGIN_SAFETY_MM + more.max(0.0)),
        skirt: skirt_whole,
        rotate,
        step: spec
            .step_deg
            .filter(|d| d.is_finite())
            .map_or(STEP_DEG, |d| d.clamp(1.0, 90.0)),
        budget: spec.effort.unwrap_or_default().budget(),
    };
    // The objects asked to stay, where they stand, and the ones to pack round them.
    let kept = |s: &Shape| spec.keep.contains(&plate.objects[s.k].id);
    let (stay, shapes): (Vec<Shape>, Vec<Shape>) = shapes.into_iter().partition(|s| kept(s));
    let rod = gantry(cfg);
    let over = |s: &Shape| rod.is_some_and(|(rod, _)| by_object && lanes && s.height > rod);
    let tall: Vec<usize> = (0..shapes.len()).filter(|&i| over(&shapes[i])).collect();
    let stay_tall = stay.iter().filter(|s| over(s)).count();
    let placed = if tall.len() + stay_tall >= 2 && !tall.is_empty() {
        in_lanes(&shapes, &tall, &stay, &room, rod.unwrap_or((f64::MAX, 0.0)))?
    } else {
        nest_all(&shapes, &stay, &room)?
    };
    let mut transforms: Vec<[f32; 16]> = plate.objects.iter().map(|o| o.transform).collect();
    let mut objects = Vec::new();
    let mut not_fit = Vec::new();
    // Whether an empty bed holds a part, by its outline: copies are tried once.
    let mut alone = HashMap::new();
    for s in &shapes {
        let o = &plate.objects[s.k];
        match placed.iter().find(|p| p.0 == s.k) {
            Some(&(_, angle, offset)) => {
                let t = turned(&o.transform, angle, offset, origin);
                transforms[s.k] = t;
                let hull = moved(&s.hull, angle, offset);
                let b = bbox(&hull);
                objects.push(ArrangedObject {
                    id: o.id.clone(),
                    name: name_of(o),
                    center_mm: [
                        round3(f64::midpoint(b[0], b[2]) + origin[0]),
                        round3(f64::midpoint(b[1], b[3]) + origin[1]),
                    ],
                    turn_deg: round3(angle.rem_euclid(360.0)),
                    transform: t.to_vec(),
                });
            }
            None => not_fit.push(NotFit {
                id: o.id.clone(),
                name: name_of(o),
                reason: if fits_alone(s, &room, &mut alone)? {
                    "no_room"
                } else {
                    "too_large"
                },
            }),
        }
    }
    Ok((
        transforms,
        Arrangement {
            by_object,
            spacing_mm: gap,
            clearance_mm: by_object.then_some(radius),
            rotate,
            lanes: tall.len() + stay_tall >= 2 && !tall.is_empty(),
            keep_out: kinds,
            objects,
            not_fit,
            order: Vec::new(),
            check: None,
            plates: Vec::new(),
        },
    ))
}

/// Whether some object of the plate stands taller than the gantry rod clears, printing by object: lanes may help.
pub(crate) fn has_tall(plate: &Plate, cfg: &PrintConfig) -> bool {
    let Some((rod, _)) = gantry(cfg) else {
        return false;
    };
    plate
        .objects
        .iter()
        .filter(|o| z_span(o).is_some_and(|(lo, hi)| hi - lo > rod))
        .count()
        >= 2
}

/// The plate's object ids in a print order where every object taller than the gantry rod prints after the low ones, each
/// set in the plate's order: the gantry over a tall one then never passes over a low one still to print. `None` when
/// that is the plate's own order, or the printer has no gantry rod (a delta).
pub(crate) fn tall_last(plate: &Plate, cfg: &PrintConfig) -> Option<Vec<String>> {
    let (rod, _) = gantry(cfg)?;
    let tall = |o: &PlateObject| z_span(o).is_some_and(|(lo, hi)| hi - lo > rod);
    let order: Vec<String> = plate
        .objects
        .iter()
        .filter(|o| !tall(o))
        .chain(plate.objects.iter().filter(|o| tall(o)))
        .map(|o| o.id.clone())
        .collect();
    let same = order.iter().zip(&plate.objects).all(|(id, o)| id == &o.id);
    (!same).then_some(order)
}

/// The printable area `[min x, min y, max x, max y]` on the machine: the config's, else the plate's bed from 0, 0.
fn printable(plate: &Plate, cfg: &PrintConfig) -> [f64; 4] {
    let r = cfg.bed_rect();
    if r[2] > r[0] && r[3] > r[1] {
        r
    } else {
        [
            0.0,
            0.0,
            f64::from(plate.bed.width_mm),
            f64::from(plate.bed.depth_mm),
        ]
    }
}

/// A delta printer's round bed.
fn delta(cfg: &PrintConfig) -> bool {
    let text = |k: &str| cfg.raw.get(k).and_then(serde_json::Value::as_str);
    crate::collide::rules::is_delta(text("printer_structure"), None, text("printer_model"))
}

/// The gantry rod's height and how far its beam reaches either way of the nozzle, mm; `None` on a delta.
fn gantry(cfg: &PrintConfig) -> Option<(f64, f64)> {
    (!delta(cfg)).then(|| {
        (
            cfg.raw_number("extruder_clearance_height_to_rod", 40.0),
            cfg.raw_number("extruder_clearance_dist_to_rod", 40.0),
        )
    })
}

/// A skirt round the whole print.
fn whole_skirt(cfg: &PrintConfig) -> bool {
    let own = matches!(cfg.raw.get("skirt_type"), Some(serde_json::Value::String(t)) if t == "perobject");
    !own && cfg.skirt_loops > 0 && cfg.skirt_height > 0
}

fn name_of(o: &PlateObject) -> String {
    [&o.name, &o.mesh.name, &o.id]
        .into_iter()
        .find(|n| !n.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// The lowest and highest point of an object as placed, mm; `None` with nothing to print.
fn z_span(o: &PlateObject) -> Option<(f64, f64)> {
    let mut span: Option<(f64, f64)> = None;
    for part in o.mesh.parts.iter().filter(|p| !p.triangles.is_empty()) {
        for &p in &part.positions {
            let z = o.apply(p)[2];
            span = Some(span.map_or((z, z), |(lo, hi)| (lo.min(z), hi.max(z))));
        }
    }
    span
}

/// The plate's settings for object `o`, printing by layer, when it gets no support though support is on ([`support::gets_support`]): no
/// enforcer asks for it and, with automatic support, no underside needs it, so its first layer prints no support pad
/// to keep room for. `None` when it may get support, or support is off. `seen` holds the answers by mesh and by how the
/// object is turned and scaled, so copies are read once.
fn unsupported(
    cfg: &PrintConfig,
    o: &PlateObject,
    seen: &mut HashMap<(usize, [u32; 12]), bool>,
) -> Option<PrintConfig> {
    if !cfg.enable_support {
        return None;
    }
    let enforcers = o
        .volumes
        .iter()
        .any(|v| v.role == crate::plate::VolumeRole::SupportEnforcer)
        || o.mesh
            .parts
            .iter()
            .any(|p| p.support_paint.iter().any(|f| f.state == 1));
    let mut key = [0_u32; 12];
    for (k, v) in key.iter_mut().zip(o.transform) {
        *k = v.to_bits();
    }
    let overhang = *seen
        .entry((std::sync::Arc::as_ptr(&o.mesh) as usize, key))
        .or_insert_with(|| {
            let mut positions = Vec::new();
            let mut triangles = Vec::new();
            for part in o.mesh.parts.iter().filter(|p| !p.triangles.is_empty()) {
                let base = u32::try_from(positions.len()).unwrap_or(u32::MAX);
                positions.extend(part.positions.iter().map(|&p| o.apply(p)));
                triangles.extend(part.triangles.iter().map(|t| t.map(|i| i.saturating_add(base))));
            }
            support::has_overhang(&positions, &triangles, cfg)
        });
    (!support::gets_support(cfg, enforcers, overhang)).then(|| {
        let mut bare = cfg.clone();
        bare.enable_support = false;
        bare
    })
}

/// Object `k` as the nest takes it, its outline in plate coordinates; `None` when it has nothing to print.
fn shape(k: usize, o: &PlateObject, cfg: &PrintConfig, origin: [f64; 2], by_object: bool) -> Option<Shape> {
    let (lo, hi) = z_span(o)?;
    let meshes: Vec<TriMesh> = o
        .mesh
        .parts
        .iter()
        .filter(|p| !p.triangles.is_empty())
        .map(|p| {
            TriMesh::new(
                p.positions.iter().map(|q| q.map(f64::from)).collect(),
                p.triangles.clone(),
            )
        })
        .collect();
    let mut m: [f64; 16] = o.transform.map(f64::from);
    m[12] -= origin[0];
    m[13] -= origin[1];
    let s = nest::silhouette(&meshes, Some(&m), &SilhouetteOptions::default());
    let polygons: Vec<Polygon> = s
        .outline
        .iter()
        .filter_map(|r| {
            let (outer, holes) = r.split_first()?;
            Some(Polygon {
                outer: outer.clone(),
                holes: holes.to_vec(),
            })
        })
        .collect();
    if polygons.is_empty() || s.hull.len() < 3 {
        return None;
    }
    let height = hi - lo;
    // The first layer, cut where the engine sizes an automatic brim from (half the first layer above the lowest point).
    let cut = cfg.initial_layer_print_height.max(0.02) / 2.0;
    let first = nest::base(&meshes, Some(&m), cut, &SilhouetteOptions::default());
    let brim = brim_room(cfg, &s.hull, &first, height);
    // What the first layer lays down past the outline, without a skirt of its own.
    let mut first = cfg.clone();
    first.raw.insert(
        "skirt_type".to_owned(),
        serde_json::Value::String("combined".to_owned()),
    );
    let grow = crate::tower::room_with(&first, brim);
    let reach = if by_object {
        crate::collide::rules::object_room_around(cfg, brim, &s.hull)
    } else if whole_skirt(cfg) {
        grow + cfg.skirt_distance.max(0.0)
            + f64::from(cfg.skirt_loops) * crate::session::skirt_spacing_mm(cfg)
    } else {
        crate::tower::room_with(cfg, brim)
    };
    Some(Shape {
        k,
        polygons,
        hull: s.hull,
        height,
        grow,
        reach: reach.max(grow),
    })
}

/// How far an object's brim reaches past its outline `hull` (plate coordinates) for an object `height` mm tall, mm:
/// none for no brim or one inside only; for the automatic brim, the room the engine's first layer gives it: the width
/// it sizes from the object's first layer (`first`, its islands), each island's own loops of it (an island much
/// smaller than the object gets fewer), the gap, and the most of those over the islands, as the slice keeps the
/// prime tower off it; without a first layer, the width for the hull with a line; else `brim_width` and the gap.
fn brim_room(cfg: &PrintConfig, hull: &[[f64; 2]], first: &[Vec<Vec<[f64; 2]>>], height: f64) -> f64 {
    let gap = cfg.raw_number("brim_object_gap", 0.0).clamp(0.0, 2.0);
    let ring = |r: &[[f64; 2]]| -> Vec<i_overlay::i_float::int::point::IntPoint<i32>> {
        r.iter()
            .map(|p| {
                i_overlay::i_float::int::point::IntPoint::new(crate::geom::mm(p[0]), crate::geom::mm(p[1]))
            })
            .collect()
    };
    match crate::brim::Kind::of(cfg) {
        crate::brim::Kind::Off | crate::brim::Kind::Inner => 0.0,
        crate::brim::Kind::Auto if !first.is_empty() && cfg.raw_number("raft_layers", 0.0) <= 0.0 => {
            let islands: crate::perimeters::Shapes = first
                .iter()
                .map(|shape| shape.iter().map(|r| ring(r)).collect())
                .collect();
            let width = crate::brim::width(cfg, &islands, height);
            if width <= 0.0 {
                return 0.0;
            }
            let spacing = crate::session::brim_spacing(cfg);
            islands
                .iter()
                .map(|island| {
                    let one: crate::perimeters::Shapes = vec![island.clone()];
                    let loops = crate::session::brim_loops(
                        cfg,
                        crate::brim::island_width(width, &one, height, spacing),
                        spacing,
                    );
                    if loops > 0 {
                        gap + f64::from(loops) * spacing
                    } else {
                        0.0
                    }
                })
                .fold(0.0, f64::max)
        }
        crate::brim::Kind::Auto => {
            let footprint: crate::perimeters::Shapes = vec![vec![ring(hull)]];
            let width = crate::brim::width(cfg, &footprint, height);
            if width > 0.0 {
                width + gap + cfg.line_width.max(0.0)
            } else {
                0.0
            }
        }
        _ => cfg.brim_width.max(0.0) + gap,
    }
}

/// The zones the layout keeps clear of, plate coordinates: the printer's keep-out zones first (how many, the second
/// value), then the prime tower's room when a plate printed by layer prints one; and which kinds there are.
fn zones(
    plate: &Plate,
    cfg: &PrintConfig,
    origin: [f64; 2],
    area: &[f64; 4],
    by_object: bool,
) -> (Vec<NestZone>, u32, Vec<&'static str>) {
    let mut out = Vec::new();
    let mut kinds = Vec::new();
    for (kind, pts) in crate::collide::plate::zones(cfg) {
        out.push(NestZone {
            polygons: vec![Polygon::simple(
                pts.iter().map(|p| [p[0] - origin[0], p[1] - origin[1]]).collect(),
            )],
        });
        let id = crate::collide::plate::zone_id(kind);
        if !kinds.contains(&id) {
            kinds.push(id);
        }
    }
    let keep_out = u32::try_from(out.len()).unwrap_or(u32::MAX);
    if !by_object && let Some(r) = tower_room(plate, cfg, origin, area) {
        out.push(NestZone {
            polygons: vec![Polygon::simple(vec![
                [r[0], r[1]],
                [r[2], r[1]],
                [r[2], r[3]],
                [r[0], r[3]],
            ])],
        });
        kinds.push("prime-tower");
    }
    (out, keep_out, kinds)
}

/// How many filaments the plate prints in: the slots of its parts, and the support filaments when support or a raft
/// prints.
fn tools(plate: &Plate, cfg: &PrintConfig) -> usize {
    let mut used: Vec<u8> = plate
        .objects
        .iter()
        .flat_map(|o| {
            o.mesh
                .parts
                .iter()
                .filter(|p| !p.triangles.is_empty())
                .map(|p| o.slot_for(&p.name, p.slot))
        })
        .collect();
    if cfg.enable_support || cfg.raw_number("raft_layers", 0.0) > 0.0 {
        for k in ["support_filament", "support_interface_filament"] {
            let n = cfg.raw_number(k, 0.0).round();
            if (1.0..=64.0).contains(&n) {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a slot from 1 to 64"
                )]
                used.push(n as u8);
            }
        }
    }
    used.sort_unstable();
    used.dedup();
    used.len()
}

/// The room the prime tower takes on a plate printed in two filaments or more, plate coordinates `[x0, y0, x1, y1]`:
/// the tower at its configured spot (`wipe_tower_x`, `wipe_tower_y`), `prime_tower_width` square, with its brim and
/// the safety round it, pulled onto the bed with its brim 1 mm inside the edge. The engine then finds that spot clear,
/// or a nearer clear one.
fn tower_room(plate: &Plate, cfg: &PrintConfig, origin: [f64; 2], area: &[f64; 4]) -> Option<[f64; 4]> {
    if tools(plate, cfg) < 2 || !crate::tower::flag_or(cfg, "enable_prime_tower", false) {
        return None;
    }
    let width = cfg.raw_number("prime_tower_width", 35.0).max(5.0);
    let brim = cfg.raw_number("prime_tower_brim_width", 3.0).max(0.0);
    let (w, d) = (area[2] - area[0], area[3] - area[1]);
    let edge = 1.0 + brim;
    let inside = |v: f64, lo: f64, hi: f64| if hi < lo { v } else { v.clamp(lo, hi) };
    let x = inside(
        cfg.raw_number("wipe_tower_x", 15.0) - origin[0],
        edge,
        w - edge - width,
    );
    let y = inside(
        cfg.raw_number("wipe_tower_y", 220.0) - origin[1],
        edge,
        d - edge - width,
    );
    let m = brim + MARGIN_SAFETY_MM;
    Some([x - m, y - m, x + width + m, y + width + m])
}

/// A point turned about Z by `deg` and moved by `offset`.
fn place_pt(p: [f64; 2], deg: f64, offset: [f64; 2]) -> [f64; 2] {
    let (s, c) = deg.to_radians().m_sin_cos();
    [c * p[0] - s * p[1] + offset[0], s * p[0] + c * p[1] + offset[1]]
}

fn moved(ring: &[[f64; 2]], deg: f64, offset: [f64; 2]) -> Vec<[f64; 2]> {
    ring.iter().map(|&p| place_pt(p, deg, offset)).collect()
}

fn bbox(ring: &[[f64; 2]]) -> [f64; 4] {
    ring.iter()
        .fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |b, p| {
            [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])]
        })
}

/// `t` (column-major, machine coordinates) as the nest placed it: turned about Z by `deg` about the plate's origin
/// `origin` (the printable area's front left corner, where the nest's coordinates start), its move too, then moved by
/// `offset` (plate coordinates). On a bed whose area does not start at 0, 0 (a delta, centered on it) the turn is about
/// that corner, as the nest turned the outline.
#[allow(clippy::cast_possible_truncation, reason = "transforms are f32 mm")]
fn turned(t: &[f32; 16], deg: f64, offset: [f64; 2], origin: [f64; 2]) -> [f32; 16] {
    let (s, c) = deg.to_radians().m_sin_cos();
    let mut out = *t;
    for col in 0..4 {
        let (mut x, mut y) = (f64::from(t[col * 4]), f64::from(t[col * 4 + 1]));
        if col == 3 {
            x -= origin[0];
            y -= origin[1];
        }
        let (u, v) = (c * x - s * y, s * x + c * y);
        let (u, v) = if col == 3 {
            (u + offset[0] + origin[0], v + offset[1] + origin[1])
        } else {
            (u, v)
        };
        out[col * 4] = u as f32;
        out[col * 4 + 1] = v as f32;
    }
    out
}

/// A placed object, as the nest gives it: its place in the plate, its turn and its move (plate coordinates).
type Put = (usize, f64, [f64; 2]);

/// The nest's request for `items` around the objects `fixed` holds where they are, with `extra` zones.
fn problem(
    items: &[&Shape],
    fixed: &[(&Shape, f64, [f64; 2])],
    room: &Room,
    extra: &[NestZone],
    own: bool,
) -> NestProblem {
    let all: Vec<f64> = items
        .iter()
        .map(|s| s.reach)
        .chain(fixed.iter().map(|f| f.0.reach))
        .collect();
    let far = all.iter().copied().fold(0.0_f64, f64::max);
    let (apart_mm, extra_of): (f64, Box<dyn Fn(f64) -> f64>) = match room.apart {
        Some(a) if own => (a, Box::new(|r: f64| r.max(0.0))),
        Some(a) => (a + far, Box::new(|_| 0.0)),
        None => (0.0, Box::new(|_| 0.0)),
    };
    let mut zones = room.zones.clone();
    // The prime tower's room goes last: the nest counts the last `tower_zones` as the tower.
    let tower = room.tower_zones as usize;
    let at = zones.len() - tower;
    for (i, z) in extra.iter().enumerate() {
        zones.insert(at + i, z.clone());
    }
    NestProblem {
        bed: room.bed,
        items: items
            .iter()
            .map(|s| NestItem {
                id: s.k.to_string(),
                polygons: s.polygons.clone(),
                grow: s.grow,
                reach: s.reach,
                apart_extra: extra_of(s.reach),
                copies: 1,
                hull: s.hull.clone(),
            })
            .collect(),
        fixed: fixed
            .iter()
            .map(|(s, deg, offset)| NestFixed {
                id: s.k.to_string(),
                polygons: s
                    .polygons
                    .iter()
                    .map(|p| Polygon {
                        outer: moved(&p.outer, *deg, *offset),
                        holes: p.holes.iter().map(|h| moved(h, *deg, *offset)).collect(),
                    })
                    .collect(),
                grow: s.grow,
                reach: s.reach,
                apart_extra: extra_of(s.reach),
                hull: moved(&s.hull, *deg, *offset),
            })
            .collect(),
        zones,
        options: NestOptions {
            gap_mm: room.gap,
            apart_mm,
            safety_mm: MARGIN_SAFETY_MM,
            rotate: room.rotate,
            rotation_step_deg: room.step,
            budget: room.budget,
            skirt: room.skirt,
            tower_zones: room.tower_zones,
            keep_out_zones: if room.apart.is_some() {
                room.keep_out_zones
            } else {
                0
            },
            center: fixed.is_empty(),
            ..NestOptions::default()
        },
    }
}

fn run(p: NestProblem) -> Result<NestResult> {
    nest::nest(p).map_err(|e| Error::Config {
        key: "plate.arrange",
        reason: e.to_string(),
    })
}

/// The better of two layouts of the same plate: more objects placed, then the fuller one.
fn better(a: NestResult, b: NestResult) -> NestResult {
    if a.stats.placed != b.stats.placed {
        return if a.stats.placed > b.stats.placed { a } else { b };
    }
    if b.stats.utilization > a.stats.utilization + 1e-9 {
        b
    } else {
        a
    }
}

/// Nests `items` around `fixed`: printing by object, with each pair spaced by the farther reach of the plate and, when
/// the reaches differ, also by each object's own reach, keeping the better; with the keep-out zones at their edge
/// spacing, and when that leaves objects over, at the half spacing too, keeping the one that places more.
fn nest_result(
    items: &[&Shape],
    fixed: &[(&Shape, f64, [f64; 2])],
    room: &Room,
    extra: &[NestZone],
) -> Result<NestResult> {
    let reaches: Vec<f64> = items
        .iter()
        .map(|s| s.reach)
        .chain(fixed.iter().map(|f| f.0.reach))
        .collect();
    let differ = reaches.iter().any(|r| (r - reaches[0]).abs() > 1e-9);
    let modes: &[bool] = if room.apart.is_some() && differ {
        &[true, false]
    } else {
        &[false]
    };
    let mut best: Option<NestResult> = None;
    for &own in modes {
        let p = problem(items, fixed, room, extra, own);
        let keep_out = p.options.keep_out_zones > 0;
        let mut r = run(p.clone())?;
        if keep_out && !r.left_over.is_empty() {
            let mut q = p;
            q.options.keep_out_zones = 0;
            let other = run(q)?;
            if other.placements.len() > r.placements.len() {
                r = other;
            }
        }
        best = Some(match best {
            Some(b) => better(b, r),
            None => r,
        });
    }
    best.ok_or_else(|| Error::Config {
        key: "plate.arrange",
        reason: "no layout".to_owned(),
    })
}

/// Every shape nested at once round the ones that stay (`stay`, where they stand); with none staying, the layout moved
/// to the middle of the bed.
fn nest_all(shapes: &[Shape], stay: &[Shape], room: &Room) -> Result<Vec<Put>> {
    if shapes.is_empty() {
        return Ok(Vec::new());
    }
    let items: Vec<&Shape> = shapes.iter().collect();
    let fixed: Vec<(&Shape, f64, [f64; 2])> = stay.iter().map(|s| (s, 0.0, [0.0, 0.0])).collect();
    let r = nest_result(&items, &fixed, room, &[])?;
    Ok(puts(&r))
}

fn puts(r: &NestResult) -> Vec<Put> {
    r.placements
        .iter()
        .filter_map(|p| Some((p.id.parse::<usize>().ok()?, p.angle_deg, p.offset)))
        .collect()
}

/// Printing by object with two or more objects taller than the gantry rod: those go first, one at a time, each out of
/// the lanes across the bed of the ones before it (their footprint's y span grown by the rod's reach and
/// [`LANE_SAFETY_MM`]), so the gantry over a later one never passes over an earlier one; then the rest around them.
/// `rod` is the gantry rod's height and its reach either way of the nozzle, mm. The objects that stay (`stay`) stand where they are, and the tall ones among them hold their lanes from the start.
fn in_lanes(
    shapes: &[Shape],
    tall: &[usize],
    stay: &[Shape],
    room: &Room,
    rod: (f64, f64),
) -> Result<Vec<Put>> {
    let reach = rod.1 + LANE_SAFETY_MM;
    let mut fixed: Vec<(&Shape, f64, [f64; 2])> = stay.iter().map(|s| (s, 0.0, [0.0, 0.0])).collect();
    let mut out: Vec<Put> = Vec::new();
    let w = room.bed.width_mm;
    let lane = |b: [f64; 4]| NestZone {
        polygons: vec![Polygon::simple(vec![
            [0.0, b[1] - reach],
            [w, b[1] - reach],
            [w, b[3] + reach],
            [0.0, b[3] + reach],
        ])],
    };
    let mut lanes: Vec<NestZone> = stay
        .iter()
        .filter(|s| s.height > rod.0)
        .map(|s| lane(bbox(&s.hull)))
        .collect();
    // The tallest first: it decides most.
    let mut order: Vec<usize> = tall.to_vec();
    order.sort_by(|&a, &b| shapes[b].height.total_cmp(&shapes[a].height).then(a.cmp(&b)));
    for i in order {
        let s = &shapes[i];
        let r = nest_result(&[s], &fixed, room, &lanes)?;
        let Some(&(_, deg, offset)) = puts(&r).first() else {
            continue;
        };
        out.push((s.k, deg, offset));
        fixed.push((s, deg, offset));
        lanes.push(lane(bbox(&moved(&s.hull, deg, offset))));
    }
    let rest: Vec<&Shape> = shapes
        .iter()
        .enumerate()
        .filter(|(i, _)| !tall.contains(i))
        .map(|(_, s)| s)
        .collect();
    if !rest.is_empty() {
        let r = nest_result(&rest, &fixed, room, &[])?;
        out.extend(puts(&r));
    }
    Ok(out)
}

/// Whether an empty bed holds `s` with its margins. `seen` keeps the answers by outline (moved to its own corner) and
/// margins, so copies of one part are tried once.
fn fits_alone(s: &Shape, room: &Room, seen: &mut HashMap<String, bool>) -> Result<bool> {
    let b = bbox(&s.hull);
    let key = serde_json::json!([
        s.polygons
            .iter()
            .map(|p| {
                let at = |r: &[[f64; 2]]| {
                    r.iter()
                        .map(|q| [round3(q[0] - b[0]), round3(q[1] - b[1])])
                        .collect::<Vec<_>>()
                };
                (at(&p.outer), p.holes.iter().map(|h| at(h)).collect::<Vec<_>>())
            })
            .collect::<Vec<_>>(),
        round3(s.grow),
        round3(s.reach),
        round3(s.height),
    ])
    .to_string();
    if let Some(&fits) = seen.get(&key) {
        return Ok(fits);
    }
    let r = run(problem(&[s], &[], room, &[], false))?;
    let fits = !r.placements.is_empty();
    seen.insert(key, fits);
    Ok(fits)
}
