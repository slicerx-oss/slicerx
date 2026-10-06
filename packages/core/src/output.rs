// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What stages 1 to 6 produce: ordered extrusion paths per layer.

use crate::geom::Point;

/// Extrusion role. The numbers are the SXPV feature ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Feature {
    OuterWall = 0,
    InnerWall = 1,
    OverhangWall = 2,
    TopSurface = 3,
    BottomSurface = 4,
    InternalSolid = 5,
    SparseInfill = 6,
    Bridge = 7,
    Support = 8,
    SupportInterface = 9,
    Brim = 10,
    Ironing = 11,
    GapFill = 12,
    PrimeTower = 13,
    Custom = 14,
    Skirt = 15,
    InternalBridge = 16,
}

impl Feature {
    /// The `;TYPE:` label Orca writes, so G-code viewers color it the same way.
    pub fn gcode_label(self) -> &'static str {
        match self {
            Self::OuterWall => "Outer wall",
            Self::InnerWall => "Inner wall",
            Self::OverhangWall => "Overhang wall",
            Self::TopSurface => "Top surface",
            Self::BottomSurface => "Bottom surface",
            Self::InternalSolid => "Internal solid infill",
            Self::SparseInfill => "Sparse infill",
            Self::Bridge => "Bridge",
            Self::Support => "Support",
            Self::SupportInterface => "Support interface",
            Self::Brim => "Brim",
            Self::Ironing => "Ironing",
            Self::GapFill => "Gap infill",
            Self::PrimeTower => "Prime tower",
            Self::Custom => "Custom",
            Self::Skirt => "Skirt",
            Self::InternalBridge => "Internal Bridge",
        }
    }
}

/// Pipeline stages, in order (`SLICE_STAGES` in `packages/contracts/src/slice.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Layers,
    Contours,
    Perimeters,
    Surfaces,
    Infill,
    Paths,
    Gcode,
    Preview,
}

/// Microseconds per stage, summed over threads' wall time per stage.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StageMicros {
    pub layers: u64,
    pub contours: u64,
    pub perimeters: u64,
    pub surfaces: u64,
    pub infill: u64,
    pub paths: u64,
    pub gcode: u64,
    pub preview: u64,
}

/// One extrusion path inside a layer. Points live in [`LayerPaths::points`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathInfo {
    /// Range into [`LayerPaths::points`]. Closed loops repeat the first point at the end.
    pub start: u32,
    pub end: u32,
    /// 1-based filament slot.
    pub tool: u8,
    pub feature: Feature,
    pub speed_mm_s: f32,
    pub width_mm: f32,
    /// Multiplies the bead's extrusion: 1 for a normal bead, other for
    /// bridges (a round strand) and other flow changes.
    pub flow: f32,
    /// The bead is printed this much higher than the layer, mm (brick layers lift the inner walls half a layer).
    pub dz: f32,
    /// The overhang fan runs while this piece prints: it hangs past `overhang_fan_threshold` over the layer
    /// below (Orca turns the fan on point by point along walls whose overhang slows them).
    pub overhang_fan: bool,
}

/// a layer's last path, which the next layer's change retraction wipes along (orca's `Wipe` path)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WipeTail {
    pub points: Vec<Point>,
    /// a loop the wipe follows on past its start
    pub forward: bool,
    pub speed_mm_s: f32,
    /// its line width; 0 after the prime tower, after which orca writes the width again
    pub width_mm: f32,
}

/// The ordered toolpath of one layer. Travels are implicit: from the end of
/// one path to the start of the next.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LayerPaths {
    pub index: u32,
    /// Index within the object when printing by object (equals `index` otherwise).
    pub local: u32,
    /// When this layer starts the next object: the height to lift to before moving there, mm.
    pub lift_z: f32,
    /// By object: the top of the objects printed before this layer's object, mm (0 otherwise).
    pub below_top: f32,
    /// Top of the layer, mm.
    pub z: f32,
    pub height: f32,
    /// Tool active when the layer starts (0 before the first tool change).
    pub start_tool: u8,
    /// The tools (bit per 0-based tool, the 64th standing for the rest) the plan prints with in the layers
    /// before this one, so an output that starts mid print knows them (an Ultimaker primes a print core the
    /// first time it prints).
    pub tools_before: u64,
    /// The tool changes the plan makes in the layers before this one (Orca's `m_toolchange_count` there).
    pub changes_before: u32,
    /// With a filament map: the filament (1-based, 0 for none) each nozzle holds when the layer starts, so a
    /// change flushes only when the new filament's nozzle holds another one. Empty without a map.
    pub held_before: Vec<u8>,
    /// Settings this layer uses: 0 is the base config, `k` is
    /// `SliceOutput::configs[k - 1]` (a height range applies).
    pub cfg: u16,
    /// Settings of the layer below, so G-code can tell when a setting changes.
    pub prev_cfg: u16,
    pub points: Vec<Point>,
    pub paths: Vec<PathInfo>,
    /// Per point: the Z, mm, and the flow of the segment that ends at it against the bead's usual flow.
    /// Spiral vase layers and layers with scarf seams fill both; they are empty for other layers.
    pub zs: Vec<f32>,
    pub flows: Vec<f32>,
    /// The layer is a spiral vase layer: it starts a layer lower and climbs along its loop.
    pub spiral: bool,
    /// The first spiral layer: the nozzle travels to the loop's start instead of continuing from the
    /// layer below.
    pub spiral_start: bool,
    /// Estimated print time, seconds.
    pub time_s: f32,
    /// Where the layer below ended (the last point of its last path), so the travel into this layer
    /// retracts only when it is long enough, as any other travel. None for the first layer and when
    /// the layer below is not known.
    pub enter_from: Option<Point>,
    /// the last path of the layer below, for the wipe of the layer change retraction; empty when the
    /// layer below is not known
    pub below_wipe: WipeTail,
    /// The layer's regions, kept when the profile plans travels (`reduce_crossing_wall`,
    /// `reduce_infill_retraction`).
    pub(crate) areas: Option<Box<LayerAreas>>,
    /// The support islands of the layer, for the writer's retraction rule.
    pub(crate) support_areas: Option<Box<SupportAreas>>,
    /// With auto lift: the overhangs of this layer and the layers up to 0.4 mm below, where a travel spirals.
    pub(crate) lift_overhangs: Option<Box<crate::perimeters::Shapes>>,
    /// Each path's speed before the cooling slowdown, kept when the slowdown changed some, so the slowdown
    /// can be worked out again once the written layer's time is known (`gcode::settle_cooling`).
    pub(crate) unslowed: Option<Box<[f32]>>,
    /// Seconds the written layer takes in the cooling buffer's model beyond the paths' model of it
    /// (`gcode::settle_cooling`); the fan reads both.
    pub(crate) cooling_extra_s: f32,
    /// The layer's G-code from `gcode::settle_cooling` when settling changed nothing, for the writer to take
    /// as it is (with the settings and flavor it was written for, and no custom G-code of the layer slider).
    pub(crate) written: Option<std::sync::Arc<crate::gcode::LayerChunk>>,
}

/// Where a travel to a support path needs no retraction (Orca `GCode::needs_retraction`): inside one support
/// island (`support_islands`), or inside the branch areas of slim, strong and hybrid trees (`base_areas`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SupportAreas {
    pub islands: crate::perimeters::Shapes,
    /// Tree support: each island prints its sheath, then its fill, in that order (a `no_sort` collection).
    pub keep_order: bool,
}

impl SupportAreas {
    /// Whether the straight move from `a` to `b` stays inside one island.
    pub(crate) fn holds(&self, a: Point, b: Point) -> bool {
        use i_overlay::i_float::int::point::IntPoint;
        let (pa, pb) = (IntPoint::new(a.x, a.y), IntPoint::new(b.x, b.y));
        let cross = |p: IntPoint<i32>, q: IntPoint<i32>, r: IntPoint<i32>| -> i64 {
            i64::from(q.x - p.x) * i64::from(r.y - p.y) - i64::from(q.y - p.y) * i64::from(r.x - p.x)
        };
        self.islands.iter().any(|shape| {
            let inside = |p: IntPoint<i32>| {
                shape.first().is_some_and(|c| crate::perimeters::point_in(c, p))
                    && !shape.iter().skip(1).any(|h| crate::perimeters::point_in(h, p))
            };
            if !(inside(pa) && inside(pb)) {
                return false;
            }
            // The move may not cross the island's outline or a hole.
            !shape.iter().any(|ring| {
                let n = ring.len();
                (0..n).any(|i| {
                    let (Some(&c), Some(&d)) = (ring.get(i), ring.get((i + 1) % n)) else {
                        return false;
                    };
                    let (d1, d2) = (cross(pa, pb, c), cross(pa, pb, d));
                    let (d3, d4) = (cross(c, d, pa), cross(c, d, pb));
                    (d1 > 0) != (d2 > 0) && d1 != 0 && d2 != 0 && (d3 > 0) != (d4 > 0) && d3 != 0 && d4 != 0
                })
            })
        })
    }
}

/// The layer's slice and the parts of it a travel planner needs, in internal units.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct LayerAreas {
    /// Everything the layer covers.
    pub slice: crate::perimeters::Shapes,
    /// The part of the slice with nothing above it (top surfaces).
    pub top: crate::perimeters::Shapes,
    /// The part with nothing below it (bottom surfaces and the first layer).
    pub bottom: crate::perimeters::Shapes,
    /// Solid only because of the shells: within the top or bottom shell layers of a surface.
    pub solid: crate::perimeters::Shapes,
}

impl LayerPaths {
    /// Points of one path.
    pub fn path_points(&self, p: &PathInfo) -> &[Point] {
        self.points.get(p.start as usize..p.end as usize).unwrap_or(&[])
    }

    /// the last path, as the writer leaves the nozzle at the layer's end
    pub(crate) fn wipe_tail(&self) -> WipeTail {
        self.paths.last().map_or_else(WipeTail::default, |p| {
            let pts = self.path_points(p);
            WipeTail {
                points: pts.to_vec(),
                forward: crate::gcode::wipes_forward(pts, p.feature),
                speed_mm_s: p.speed_mm_s,
                width_mm: if p.feature == Feature::PrimeTower {
                    0.0
                } else {
                    p.width_mm
                },
            }
        })
    }
}

/// Warning codes (`SliceWarningCode` in the contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningCode {
    OpenEdges,
    ThinWall,
    FloatingRegion,
    /// A bridge longer than `max_bridge_length` with support off.
    LongBridge,
    OutsideBed,
    UnsupportedSetting,
    /// The person must do something by hand before printing.
    ManualStep,
    /// A setting was lowered to the nozzle or machine limit.
    SafetyLimit,
    /// The print sequence would run the nozzle or gantry into a printed object.
    Collision,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SliceWarning {
    pub code: WarningCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<u32>,
}

/// The footprint of one object on the plate, for object labels in the G-code.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ObjectFootprint {
    pub id: String,
    pub name: String,
    /// Convex hull of the object's XY outline, counterclockwise, mm.
    pub hull: Vec<[f64; 2]>,
    /// Center of the hull's bounding box, mm.
    pub center: [f64; 2],
}

/// The prime tower as placed: front left corner, size and rotation (degrees, about the corner), mm,
/// and why it stands there. The slice report's `primeTower`.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerPlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub depth: f64,
    pub angle: f64,
    pub reason: crate::tower::TowerReason,
}

/// Tool changes and purge filament the plate's variable layer heights add against fixed layers of
/// `layer_height` (negative when they save). The slice report's `varyLayerCost`.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaryLayerCost {
    pub extra_tool_changes: i64,
    /// Grams of filament purged on the tower and into the chute.
    pub extra_purge_g: f64,
}

/// Result of stages 1 to 6 for a range of layers.
#[derive(Debug, Clone, Default)]
pub struct SliceOutput {
    /// Layers in the whole plate, not only this range.
    pub layer_count: u32,
    /// Index of `layers[0]` in the whole plate.
    pub first_layer: u32,
    /// Nominal layer height, mm.
    pub layer_height: f32,
    /// Highest filament slot used on the plate.
    pub tool_count: u8,
    pub layers: Vec<LayerPaths>,
    /// Top of the last layer of the plate, mm.
    pub plate_top_z: f32,
    /// Bounds of the plate's footprint `[min_x, min_y, max_x, max_y]`, mm.
    pub plate_bounds: [f32; 4],
    /// Settings that height ranges change, referenced by [`LayerPaths::cfg`].
    pub configs: Vec<crate::config::PrintConfig>,
    pub stage_micros: StageMicros,
    pub warnings: Vec<SliceWarning>,
    /// One footprint per plate object, in plate order.
    pub objects: Vec<ObjectFootprint>,
    /// What the first layer covers, for the printer's start G-code variables.
    pub first_layer_info: FirstLayerInfo,
    /// Where the prime tower stands, when the plate has one.
    pub prime_tower: Option<TowerPlacement>,
    /// What variable layer heights cost against fixed layers, on a multi-color plate that has them.
    pub vary_layer_cost: Option<VaryLayerCost>,
    /// The filament map, on a printer with two extruders fed by their own AMS.
    pub filament_map: Option<crate::nozzles::Map>,
    /// By object: what these layers' moves and tool changes meet of the other objects (`collide`).
    pub collisions: crate::collide::Hits,
}

/// The plate's first layer as the start G-code variables read it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FirstLayerInfo {
    /// Area of the slices, the brim around them and the prime tower, mm2, for a print lower than 0.3 mm
    /// (where `hold_chamber_temp_for_flat_print` reads it); 0 for taller prints.
    pub area_mm2: f32,
    /// The outlines of the slices (contours and holes), mm.
    pub rings: Vec<Vec<[f32; 2]>>,
    /// The convex hull of the outlines the skirt goes round (before the elephant foot compensation, on the
    /// layers up to `skirt_height`), mm.
    pub skirt_outline: Vec<[f64; 2]>,
}

impl SliceOutput {
    /// Settings for a config index from [`LayerPaths::cfg`] or `prev_cfg`.
    pub fn config_at<'a>(
        &'a self,
        base: &'a crate::config::PrintConfig,
        cfg: u16,
    ) -> &'a crate::config::PrintConfig {
        usize::from(cfg)
            .checked_sub(1)
            .and_then(|i| self.configs.get(i))
            .unwrap_or(base)
    }

    /// True when this output covers the plate's first layer.
    pub fn has_first_layer(&self) -> bool {
        self.first_layer == 0
    }

    /// True when this output covers the plate's last layer.
    pub fn has_last_layer(&self) -> bool {
        self.first_layer as usize + self.layers.len() >= self.layer_count as usize
    }
}

#[cfg(test)]
mod support_area_tests {
    use super::SupportAreas;
    use crate::geom::Point;
    use i_overlay::i_float::int::point::IntPoint;

    #[test]
    fn a_move_inside_one_island_is_held_and_one_between_islands_is_not() {
        let square = |x0: i32| {
            vec![vec![
                IntPoint::new(x0, 0),
                IntPoint::new(x0 + 100_000, 0),
                IntPoint::new(x0 + 100_000, 100_000),
                IntPoint::new(x0, 100_000),
            ]]
        };
        let a = SupportAreas {
            islands: vec![square(0), square(200_000)],
            keep_order: false,
        };
        assert!(a.holds(Point::new(10_000, 10_000), Point::new(90_000, 90_000)));
        assert!(!a.holds(Point::new(10_000, 10_000), Point::new(210_000, 10_000)));
    }
}
