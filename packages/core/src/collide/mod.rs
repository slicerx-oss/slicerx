// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! heimdall's collision check: every move of a by-object print, and every tool change, against what is already
//! printed at that moment, with the head the printer really has.
//!
//! OrcaSlicer, Bambu Studio and PrusaSlicer test a by-object plate once, before slicing: each object's convex hull
//! grown by the extruder clearance radius, and the object heights against the gantry and lid clearances
//! (`Print::validate`, `sequential_print_clearance_valid`). That refuses safe plates and lets tool changes through
//! untested. Here each finished object is a 1 mm height grid built from its mesh ([`grid`]); every piece of the head
//! (the columns Preview draws, [`shapes`]) grows that grid once, so a move asks one lookup per piece; the gantry is
//! a beam across the bed at the profile's rod height, the lid a ceiling at its lid height. [`walk`] runs the moves
//! of each object's layers and its tool change trips, and [`report`] turns what they hit into the list the app
//! shows, with fixes and what they cost. The profile's clearance radius stays as a softer check: a plate inside
//! it whose head shape clears is reported as close, not as a hit.

pub(crate) mod grid;
pub(crate) mod plate;
pub mod report;
pub(crate) mod shapes;
pub(crate) mod walk;

use crate::config::PrintConfig;
use crate::plate::PlateObject;
use grid::{Grid, Profile};
use serde::{Deserialize, Serialize};
use shapes::{Changer, Column};
use std::sync::OnceLock;

pub use report::{Collision, CollisionFix, report};

/// Added around every piece of the head, mm: the drawn heads follow product photos.
const MARGIN_MM: f64 = 2.0;
/// How far a part must reach past a piece of the head before it counts, mm.
const EPS: f32 = 0.05;

/// What meets the print.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum Kind {
    /// The gantry beam, or the frame over the whole bed (the profile's lid height).
    Gantry,
    /// The toolhead or the nozzle while printing.
    Hotend,
    /// The nozzle on a travel.
    NozzleTravelThroughPart,
    /// The toolhead on its way to the chute, rack or dock and back.
    ToolChange,
    /// The toolhead at the rack, dock or switch bay.
    Dock,
    /// The paths of two objects, or of an object and the prime tower, cross on one layer.
    PathConflict,
    /// A print path in a zone the printer keeps clear: an exclusion area, or the nozzle wrap check's corner.
    KeepOut,
}

/// A hit with the head's own shape, or only inside the profile's clearance radius.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum Severity {
    Hit,
    Close,
}

/// The piece of the machine that meets the part.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum Part {
    Nozzle,
    Toolhead,
    Gantry,
    Lid,
}

/// A moment of the print: a layer, the move in it, and where the head is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Moment {
    /// Plate layer, 0-based.
    pub layer: u32,
    /// The layer's extrusion segment the move belongs to (the first one after a travel or tool change), as the
    /// preview counts them.
    pub segment: u32,
    /// Share of the layer's time before the move, 0 to 1.
    pub share: f32,
    /// The nozzle tip, mm.
    pub at: [f32; 3],
    /// Where the machine meets the part, mm.
    pub point: [f32; 3],
    /// During a tool change: the tools (0-based) and how far along the trip, 0 to 1.
    pub change: Option<(u8, u8, f32)>,
}

/// Every contact of one kind between the moves of one object and another object: the first and the deepest.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub kind: Kind,
    pub severity: Severity,
    pub part: Part,
    /// The object printing (index in print order).
    pub mover: u32,
    /// The object it meets.
    pub obstacle: u32,
    pub first: Moment,
    pub worst: Moment,
    /// How far into the part, mm: height above the piece of the head, or for a close call how far inside the radius.
    pub depth: f32,
    /// How far the part reaches into the piece of the head sideways, mm: the extra spacing that clears it.
    pub push: f32,
    pub last_layer: u32,
    pub moves: u32,
    /// While walking a layer range: the nozzle's nearest approach to the part, mm.
    pub near: f32,
}

impl Hit {
    fn key(&self) -> (Kind, Severity, Part, u32, u32) {
        (self.kind, self.severity, self.part, self.mover, self.obstacle)
    }
}

/// Hits of a layer range, one per kind, piece and pair of objects.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Hits(pub Vec<Hit>);

impl Hits {
    /// Adds one move's contact (or a whole record) to the list.
    pub(crate) fn add(&mut self, h: Hit) {
        if let Some(e) = self.0.iter_mut().find(|e| e.key() == h.key()) {
            let earlier = (h.first.layer, h.first.segment) < (e.first.layer, e.first.segment);
            if earlier {
                e.first = h.first;
            }
            if h.depth > e.depth {
                e.depth = h.depth;
                e.worst = h.worst;
            }
            e.push = e.push.max(h.push);
            e.near = e.near.min(h.near);
            e.last_layer = e.last_layer.max(h.last_layer);
            e.moves += h.moves;
        } else {
            self.0.push(h);
        }
    }

    pub(crate) fn merge(&mut self, other: Self) {
        for h in other.0 {
            self.add(h);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The hits as one list of numbers, for a layer range's JSON in the browser build.
    pub fn to_numbers(&self) -> Vec<f64> {
        let moment = |m: &Moment, out: &mut Vec<f64>| {
            let (a, b, s) = m.change.map_or((-1.0, -1.0, 0.0), |(a, b, s)| {
                (f64::from(a), f64::from(b), f64::from(s))
            });
            out.extend([f64::from(m.layer), f64::from(m.segment), f64::from(m.share)]);
            out.extend(m.at.iter().chain(&m.point).map(|&v| f64::from(v)));
            out.extend([a, b, s]);
        };
        let mut out = Vec::with_capacity(self.0.len() * HIT_NUMBERS);
        for h in &self.0 {
            out.extend([
                f64::from(h.kind as u8),
                f64::from(h.severity as u8),
                f64::from(h.part as u8),
                f64::from(h.mover),
                f64::from(h.obstacle),
                f64::from(h.depth),
                f64::from(h.push),
                f64::from(h.last_layer),
                f64::from(h.moves),
            ]);
            moment(&h.first, &mut out);
            moment(&h.worst, &mut out);
        }
        out
    }

    /// [`Self::to_numbers`] read back, records of one pair joined; a short record ends the list.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the numbers were written from these fields"
    )]
    pub fn from_numbers(v: &[f64]) -> Self {
        let moment = |m: &[f64]| -> Option<Moment> {
            let &[layer, segment, share, ax, ay, az, px, py, pz, a, b, s] = m else {
                return None;
            };
            Some(Moment {
                layer: layer as u32,
                segment: segment as u32,
                share: share as f32,
                at: [ax as f32, ay as f32, az as f32],
                point: [px as f32, py as f32, pz as f32],
                change: (a >= 0.0).then_some((a as u8, b as u8, s as f32)),
            })
        };
        let mut out = Self::default();
        for r in v.as_chunks::<HIT_NUMBERS>().0 {
            let (
                Some(
                    &[
                        kind,
                        severity,
                        part,
                        mover,
                        obstacle,
                        depth,
                        push,
                        last_layer,
                        moves,
                    ],
                ),
                Some(first),
                Some(worst),
            ) = (
                r.get(..9),
                r.get(9..21).and_then(moment),
                r.get(21..).and_then(moment),
            )
            else {
                break;
            };
            let kind = match kind as u8 {
                0 => Kind::Gantry,
                1 => Kind::Hotend,
                2 => Kind::NozzleTravelThroughPart,
                3 => Kind::ToolChange,
                4 => Kind::Dock,
                5 => Kind::PathConflict,
                _ => Kind::KeepOut,
            };
            let part = match part as u8 {
                0 => Part::Nozzle,
                1 => Part::Toolhead,
                2 => Part::Gantry,
                _ => Part::Lid,
            };
            // Layer ranges report the same pair each; it is one collision over the ranges together.
            out.add(Hit {
                kind,
                severity: if severity as u8 == 0 {
                    Severity::Hit
                } else {
                    Severity::Close
                },
                part,
                mover: mover as u32,
                obstacle: obstacle as u32,
                first,
                worst,
                depth: depth as f32,
                push: push as f32,
                last_layer: last_layer as u32,
                moves: moves as u32,
                near: f32::MAX,
            });
        }
        out
    }
}

/// Numbers per hit in [`Hits::to_numbers`].
const HIT_NUMBERS: usize = 33;

/// An object of the plate as the report needs it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MetaObject {
    pub id: String,
    pub height: f32,
    pub center: [f32; 2],
}

/// What the report needs besides the hits: the objects in print order and the settings its fixes read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
    pub objects: Vec<MetaObject>,
    pub radius: f32,
    pub rod: f32,
    pub lid: f32,
    pub layer_height: f32,
    pub travel_speed: f32,
    pub z_speed: f32,
    /// Seconds of one retraction and its recovery.
    pub retract_s: f32,
    pub z_hop: f32,
    /// The objects could print layer by layer instead (one layer plan, no spiral vase).
    pub by_layer: bool,
    /// The keep-out zones, by kind ([`plate::ZONE_EXCLUSION`], [`plate::ZONE_WRAP_CHECK`]); hits name zone `k` as
    /// obstacle `objects.len() + 1 + k`, after the prime tower at `objects.len()`.
    pub zones: Vec<u8>,
}

impl Meta {
    /// The facts as JSON, for a layer range's JSON in the browser build: the objects as `[id, height, x, y]`, then
    /// the numbers.
    pub fn to_json(&self) -> serde_json::Value {
        let mut objects = Vec::with_capacity(self.objects.len());
        for o in &self.objects {
            objects.push(serde_json::json!([o.id, o.height, o.center[0], o.center[1]]));
        }
        let numbers = [
            self.radius,
            self.rod,
            self.lid,
            self.layer_height,
            self.travel_speed,
            self.z_speed,
            self.retract_s,
            self.z_hop,
            if self.by_layer { 1.0 } else { 0.0 },
        ];
        serde_json::json!([objects, numbers, self.zones])
    }

    /// [`Self::to_json`] read back.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the numbers were written from f32 fields"
    )]
    pub fn from_json(v: &serde_json::Value) -> Self {
        let num = |v: Option<&serde_json::Value>| v.and_then(serde_json::Value::as_f64).unwrap_or(0.0) as f32;
        let text = |v: Option<&serde_json::Value>| {
            v.and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let list = |i: usize| {
            v.get(i)
                .and_then(serde_json::Value::as_array)
                .map_or(&[][..], Vec::as_slice)
        };
        let mut objects = Vec::new();
        for o in list(0) {
            objects.push(MetaObject {
                id: text(o.get(0)),
                height: num(o.get(1)),
                center: [num(o.get(2)), num(o.get(3))],
            });
        }
        let mut zones = Vec::new();
        for z in list(2) {
            zones.push(u8::from(z.as_u64() == Some(1)));
        }
        let n = |i: usize| num(v.get(1).and_then(|a| a.get(i)));
        Self {
            objects,
            radius: n(0),
            rod: n(1),
            lid: n(2),
            layer_height: n(3),
            travel_speed: n(4),
            z_speed: n(5),
            retract_s: n(6),
            z_hop: n(7),
            by_layer: n(8) > 0.5,
            zones,
        }
    }
}

/// One finished object as an obstacle.
struct Obstacle {
    object: PlateObject,
    /// The height grid, made the first time a move comes near enough to need it.
    grid: OnceLock<Grid>,
    top: f32,
    bounds: [f64; 4],
    hull: Vec<[f64; 2]>,
    /// Per head, the grid grown by each of its columns, made on first use.
    fields: Vec<OnceLock<Vec<Grid>>>,
    beam: OnceLock<Profile>,
}

impl Obstacle {
    fn grid(&self) -> &Grid {
        crate::par::Init::once(&self.grid, || Grid::of_object(&self.object))
    }
}

/// The plate's objects as obstacles and the machine that moves among them.
pub(crate) struct Model {
    pub meta: Meta,
    objects: Vec<Obstacle>,
    heads: Vec<Vec<Column>>,
    /// The extruder of each filament slot, 0-based.
    extruder_of: Vec<usize>,
    changer: Option<Changer>,
    lift_mm: f64,
    /// The change G-code lifts over the highest layer printed so far (`max_layer_z`).
    lift_over_print: bool,
    rod: f64,
    to_rod: f64,
    lid: f64,
    radius: f64,
    nozzle_height: f64,
}

impl std::fmt::Debug for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "collide::Model({} objects)", self.objects.len())
    }
}

impl Model {
    /// The model of a by-object plate, its objects in print order.
    pub(crate) fn new(
        objects: &[&PlateObject],
        config: &PrintConfig,
        printer_id: Option<&str>,
        extruder_of: Option<Vec<usize>>,
        by_layer: bool,
        zones: Vec<u8>,
    ) -> Self {
        let model = config.raw.get("printer_model").and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.as_str()),
            serde_json::Value::Array(a) => a.first().and_then(serde_json::Value::as_str),
            _ => None,
        });
        let mut machine = shapes::machine(printer_id, model);
        for c in machine.heads.iter_mut().flatten() {
            c.x = [c.x[0] - MARGIN_MM, c.x[1] + MARGIN_MM];
            c.y = [c.y[0] - MARGIN_MM, c.y[1] + MARGIN_MM];
        }
        let heads = machine.heads;
        let mut plate = crate::plate::Plate::default();
        for o in objects {
            plate.objects.push((*o).clone());
        }
        let hulls = crate::firmware::footprints(&plate);
        let mut built = Vec::with_capacity(objects.len());
        let mut listed = Vec::with_capacity(objects.len());
        for (o, f) in objects.iter().zip(&hulls) {
            // The mesh's top and its extent on the bed decide whether a move can come near it; its height grid waits
            // until one does.
            let (mut top, mut lo, mut hi) = (0.0f64, [f64::MAX; 2], [f64::MIN; 2]);
            for p in o.mesh.parts.iter().flat_map(|p| p.positions.iter()) {
                let [x, y, z] = o.apply(*p);
                top = top.max(z);
                lo = [lo[0].min(x), lo[1].min(y)];
                hi = [hi[0].max(x), hi[1].max(y)];
            }
            #[allow(clippy::cast_possible_truncation, reason = "plate positions in mm")]
            listed.push(MetaObject {
                id: o.id.clone(),
                height: top as f32,
                center: [f.center[0] as f32, f.center[1] as f32],
            });
            let mut fields = Vec::with_capacity(heads.len());
            for _ in &heads {
                fields.push(OnceLock::new());
            }
            #[allow(clippy::cast_possible_truncation, reason = "heights of a print fit in f32")]
            built.push(Obstacle {
                object: (*o).clone(),
                grid: OnceLock::new(),
                top: top as f32,
                bounds: [
                    lo[0].floor(),
                    lo[1].floor(),
                    hi[0].floor() + 1.0,
                    hi[1].floor() + 1.0,
                ],
                hull: f.hull.clone(),
                fields,
                beam: OnceLock::new(),
            });
        }
        let changer = machine.changer;
        // Bambu Studio grows each hull by half its `extruder_clearance_max_radius`; Orca and the others use
        // `extruder_clearance_radius`.
        let radius = if crate::firmware::bambu_printer(config, config.gcode_flavor) {
            config.raw_number("extruder_clearance_max_radius", 68.0)
        } else {
            config.raw_number("extruder_clearance_radius", 40.0)
        };
        // Without a filament map each tool has its own extruder where the machine has more than one head.
        let extruder_of =
            extruder_of.unwrap_or_else(|| (0..64).map(|t| t.min(heads.len().saturating_sub(1))).collect());
        #[allow(clippy::cast_possible_truncation, reason = "settings in mm and mm/s")]
        let meta = Meta {
            objects: listed,
            radius: radius as f32,
            rod: config.raw_number("extruder_clearance_height_to_rod", 40.0) as f32,
            lid: config.raw_number("extruder_clearance_height_to_lid", 120.0) as f32,
            layer_height: config.layer_height as f32,
            travel_speed: config.travel_speed.max(1.0) as f32,
            z_speed: config.raw_number("machine_max_speed_z", 12.0).max(1.0) as f32,
            retract_s: (2.0 * config.retraction_length / config.retraction_speed.max(1.0)) as f32,
            z_hop: config.z_hop as f32,
            by_layer,
            zones,
        };
        let lift_mm = changer.as_ref().map_or(3.0, |c| c.lift_mm);
        Self {
            meta,
            objects: built,
            heads,
            extruder_of,
            changer,
            lift_mm,
            lift_over_print: matches!(config.raw.get("change_filament_gcode"), Some(serde_json::Value::String(t)) if t.contains("max_layer_z")),
            rod: config.raw_number("extruder_clearance_height_to_rod", 40.0),
            to_rod: config.raw_number("extruder_clearance_dist_to_rod", 40.0),
            lid: config.raw_number("extruder_clearance_height_to_lid", 120.0),
            radius,
            nozzle_height: config.raw_number("nozzle_height", 2.5),
        }
    }

    fn head(&self, tool: u8) -> usize {
        let e = self
            .extruder_of
            .get(usize::from(tool.max(1) - 1))
            .copied()
            .unwrap_or(0);
        e.min(self.heads.len().saturating_sub(1))
    }

    fn fields(&self, j: usize, head: usize) -> &[Grid] {
        let (Some(o), Some(cols)) = (self.objects.get(j), self.heads.get(head)) else {
            return &[];
        };
        let Some(cell) = o.fields.get(head) else {
            return &[];
        };
        crate::par::Init::once(cell, || cols.iter().map(|c| o.grid().grown(c.x, c.y)).collect())
    }

    fn beam(&self, j: usize) -> Option<&Profile> {
        let o = self.objects.get(j)?;
        Some(crate::par::Init::once(&o.beam, || o.grid().beam(self.to_rod)))
    }

    /// How far a head piece reaches from the nozzle, mm, for pruning.
    fn reach(&self) -> f64 {
        self.heads
            .iter()
            .flatten()
            .map(|c| c.x[0].abs().max(c.x[1].abs()).max(c.y[0].abs()).max(c.y[1].abs()))
            .fold(0.0, f64::max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(layer: u32, depth: f32) -> Hit {
        let m = Moment {
            layer,
            segment: 0,
            share: 0.0,
            at: [0.0; 3],
            point: [0.0; 3],
            change: None,
        };
        Hit {
            kind: Kind::Gantry,
            severity: Severity::Hit,
            part: Part::Gantry,
            mover: 1,
            obstacle: 0,
            first: m,
            worst: m,
            depth,
            push: 0.0,
            last_layer: layer,
            moves: 1,
            near: f32::MAX,
        }
    }

    #[test]
    fn hits_and_facts_go_through_their_json_and_back() {
        let mut h = hit(4, 2.5);
        h.first.change = Some((1, 3, 0.25));
        h.kind = Kind::Dock;
        h.part = Part::Lid;
        h.severity = Severity::Close;
        let hits = Hits(vec![h, hit(7, 1.0)]);
        assert_eq!(Hits::from_numbers(&hits.to_numbers()), hits);
        // two layer ranges' records of one pair are one hit
        let mut both = Hits(vec![hit(7, 1.0)]).to_numbers();
        both.extend(Hits(vec![hit(9, 3.0)]).to_numbers());
        let joined = Hits::from_numbers(&both);
        assert_eq!(joined.0.len(), 1);
        assert_eq!(
            (joined.0[0].first.layer, joined.0[0].last_layer, joined.0[0].moves),
            (7, 9, 2)
        );
        let meta = Meta {
            objects: vec![MetaObject {
                id: "a".into(),
                height: 20.0,
                center: [10.0, 20.0],
            }],
            radius: 40.0,
            rod: 25.0,
            lid: 120.0,
            layer_height: 0.2,
            travel_speed: 500.0,
            z_speed: 12.0,
            retract_s: 0.1,
            z_hop: 0.4,
            by_layer: true,
            zones: vec![0, 1],
        };
        assert_eq!(Meta::from_json(&meta.to_json()), meta);
    }

    #[test]
    fn hits_of_one_pair_keep_the_first_moment_and_the_deepest() {
        let mut a = Hits::default();
        a.add(hit(5, 2.0));
        a.add(hit(3, 1.0));
        let mut b = Hits::default();
        b.add(hit(9, 4.0));
        a.merge(b);
        assert_eq!(a.0.len(), 1);
        let h = &a.0[0];
        assert_eq!(
            (h.first.layer, h.worst.layer, h.last_layer, h.moves),
            (3, 9, 9, 3)
        );
        assert!((h.depth - 4.0).abs() < 1e-6);
    }
}
