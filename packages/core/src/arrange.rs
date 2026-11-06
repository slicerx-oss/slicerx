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

use serde::Serialize;
use sx_geom::mesh::TriMesh;
use sx_geom::nest::{
    self, NestBed, NestFixed, NestItem, NestOptions, NestProblem, NestResult, NestZone, SilhouetteOptions,
};
use sx_geom::poly2d::Polygon;

use crate::api::ArrangeSpec;
use crate::config::PrintConfig;
use crate::error::{Error, Result};
use crate::fm::Fm as _;
use crate::plate::{Plate, PlateObject};

/// Room kept beyond what is computed, mm: the engine rounds a brim up to whole lines.
pub const MARGIN_SAFETY_MM: f64 = 1.0;
/// The spacing between objects and from the bed edge when the request names none, mm: the app's arrange default.
pub const DEFAULT_SPACING_MM: f64 = 6.0;
/// Turn step, degrees.
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
    /// Printing by object: heimdall's plate check of the layout (`sx check`), when every object fits.
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
}

/// Lays out every object of `plate` that has something to print with `cfg`: the new transform of each object, in the
/// plate's order (an object with no room, or nothing to print, keeps its own), and the report. With `lanes` the
/// objects taller than the gantry rod go first, one at a time, each out of the lanes of the ones before it. Printing by
/// object, `more` mm go on top of the clearance between objects (the push the plate check asked of a layout before).
pub(crate) fn arrange(
    plate: &Plate,
    cfg: &PrintConfig,
    spec: ArrangeSpec,
    lanes: bool,
    more: f64,
) -> Result<(Vec<[f32; 16]>, Arrangement)> {
    let by_object = cfg.print_by_object();
    let area = printable(plate, cfg);
    let origin = [area[0], area[1]];
    let gap = spec.spacing_mm.unwrap_or(DEFAULT_SPACING_MM).max(0.0);
    let rotate = spec.rotate.unwrap_or(true);
    let shapes: Vec<Shape> = plate
        .objects
        .iter()
        .enumerate()
        .filter_map(|(k, o)| shape(k, o, cfg, origin, by_object))
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
    };
    let rod = gantry(cfg);
    let tall: Vec<usize> = match rod {
        Some((rod, _)) if by_object && lanes => {
            (0..shapes.len()).filter(|&i| shapes[i].height > rod).collect()
        }
        _ => Vec::new(),
    };
    let placed = if tall.len() >= 2 {
        in_lanes(&shapes, &tall, &room, rod.map_or(0.0, |r| r.1))?
    } else {
        nest_all(&shapes, &room)?
    };
    let mut transforms: Vec<[f32; 16]> = plate.objects.iter().map(|o| o.transform).collect();
    let mut objects = Vec::new();
    let mut not_fit = Vec::new();
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
                reason: if fits_alone(s, &room)? {
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
            lanes: tall.len() >= 2,
            keep_out: kinds,
            objects,
            not_fit,
            check: None,
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
    let brim = brim_room(cfg, &s.hull, height);
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
/// none for no brim or one inside only, the width the automatic brim takes for this footprint and height (with the
/// gap and a line), else `brim_width` and the gap.
fn brim_room(cfg: &PrintConfig, hull: &[[f64; 2]], height: f64) -> f64 {
    let gap = cfg.raw_number("brim_object_gap", 0.0).clamp(0.0, 2.0);
    match crate::brim::Kind::of(cfg) {
        crate::brim::Kind::Off | crate::brim::Kind::Inner => 0.0,
        crate::brim::Kind::Auto => {
            let ring = hull
                .iter()
                .map(|p| {
                    i_overlay::i_float::int::point::IntPoint::new(
                        crate::geom::mm(p[0]),
                        crate::geom::mm(p[1]),
                    )
                })
                .collect();
            let footprint: crate::perimeters::Shapes = vec![vec![ring]];
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
            rotation_step_deg: STEP_DEG,
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

/// Every shape nested at once, the layout moved to the middle of the bed.
fn nest_all(shapes: &[Shape], room: &Room) -> Result<Vec<Put>> {
    if shapes.is_empty() {
        return Ok(Vec::new());
    }
    let items: Vec<&Shape> = shapes.iter().collect();
    let r = nest_result(&items, &[], room, &[])?;
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
fn in_lanes(shapes: &[Shape], tall: &[usize], room: &Room, to_rod: f64) -> Result<Vec<Put>> {
    let reach = to_rod + LANE_SAFETY_MM;
    let mut fixed: Vec<(&Shape, f64, [f64; 2])> = Vec::new();
    let mut out: Vec<Put> = Vec::new();
    let mut lanes: Vec<NestZone> = Vec::new();
    // The tallest first: it decides most.
    let mut order: Vec<usize> = tall.to_vec();
    order.sort_by(|&a, &b| shapes[b].height.total_cmp(&shapes[a].height).then(a.cmp(&b)));
    let w = room.bed.width_mm;
    for i in order {
        let s = &shapes[i];
        let r = nest_result(&[s], &fixed, room, &lanes)?;
        let Some(&(_, deg, offset)) = puts(&r).first() else {
            continue;
        };
        out.push((s.k, deg, offset));
        fixed.push((s, deg, offset));
        let b = bbox(&moved(&s.hull, deg, offset));
        lanes.push(NestZone {
            polygons: vec![Polygon::simple(vec![
                [0.0, b[1] - reach],
                [w, b[1] - reach],
                [w, b[3] + reach],
                [0.0, b[3] + reach],
            ])],
        });
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

/// Whether an empty bed holds `s` with its margins.
fn fits_alone(s: &Shape, room: &Room) -> Result<bool> {
    let r = run(problem(&[s], &[], room, &[], false))?;
    Ok(!r.placements.is_empty())
}
