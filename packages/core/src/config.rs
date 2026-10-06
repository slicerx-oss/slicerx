// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The resolved settings `sx-core` reads, under Orca's key names.
//!
//! The wire form is the `PrintConfig` object from
//! `packages/contracts/src/settings.ts`: Orca keys with typed values. Orca's own
//! string forms ("15%", `["0.4"]`) are accepted too, so an exported Orca
//! profile can be passed straight in. Unknown keys are ignored here; the
//! settings schema in `sx-settings` owns validation and defaults.

use crate::error::{Error, Result};
use crate::par::Init as _;
use serde_json::Value;

/// G-code dialect. The names are Orca's `gcode_flavor` values; `Bambu` is Marlin 2 with the Bambu printers'
/// extras (the `.gcode.3mf` wrapper is the host's job).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum GcodeFlavor {
    /// Marlin before 2: `M204 S` for every acceleration, no junction deviation.
    #[serde(rename = "marlin")]
    Marlin,
    #[default]
    #[serde(rename = "marlin2")]
    Marlin2,
    #[serde(rename = "klipper")]
    Klipper,
    #[serde(rename = "reprapfirmware")]
    RepRapFirmware,
    #[serde(rename = "bambu")]
    Bambu,
    /// `RepRap` with Sprinter (`reprap`).
    #[serde(rename = "reprap")]
    Sprinter,
    #[serde(rename = "repetier")]
    Repetier,
    #[serde(rename = "teacup")]
    Teacup,
    #[serde(rename = "makerware")]
    MakerWare,
    #[serde(rename = "sailfish")]
    Sailfish,
    #[serde(rename = "mach3")]
    Mach3,
    #[serde(rename = "machinekit")]
    Machinekit,
    #[serde(rename = "smoothie")]
    Smoothie,
    #[serde(rename = "no-extrusion")]
    NoExtrusion,
    /// Ultimaker's firmware on the S3, S5 and S7: Marlin moves under a header the printer reads before it
    /// starts, and print core switches the firmware runs itself (`griffin.rs`).
    #[serde(rename = "griffin")]
    Griffin,
    /// Griffin's successor on the S6 and S8; the same G-code, named apart in the header.
    #[serde(rename = "cheetah")]
    Cheetah,
}

impl GcodeFlavor {
    /// Parses Orca's `gcode_flavor` values and the contract's `GcodeFlavor`.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "marlin" | "marlinlegacy" => Some(Self::Marlin),
            "marlin2" => Some(Self::Marlin2),
            "klipper" => Some(Self::Klipper),
            "reprapfirmware" => Some(Self::RepRapFirmware),
            "bambu" => Some(Self::Bambu),
            "reprap" | "sprinter" => Some(Self::Sprinter),
            "repetier" => Some(Self::Repetier),
            "teacup" => Some(Self::Teacup),
            "makerware" => Some(Self::MakerWare),
            "sailfish" => Some(Self::Sailfish),
            "mach3" => Some(Self::Mach3),
            "machinekit" => Some(Self::Machinekit),
            "smoothie" => Some(Self::Smoothie),
            "no-extrusion" => Some(Self::NoExtrusion),
            "griffin" => Some(Self::Griffin),
            "cheetah" => Some(Self::Cheetah),
            _ => None,
        }
    }

    /// Marlin of either age: the flavors Orca writes machine limits, `M73`-style progress and object labels for.
    pub fn is_marlin(self) -> bool {
        matches!(self, Self::Marlin | Self::Marlin2 | Self::Bambu)
    }

    /// Ultimaker's Griffin or Cheetah.
    pub fn is_ultimaker(self) -> bool {
        matches!(self, Self::Griffin | Self::Cheetah)
    }
}

/// Sparse infill pattern. Only the patterns the core implements are listed;
/// others fall back to rectilinear with a warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InfillPattern {
    /// Parallel lines, direction alternating 90 degrees per layer.
    #[default]
    Rectilinear,
    /// Both directions on every layer.
    Grid,
    /// One fixed direction on every layer.
    Line,
    /// Three line sets at 60 degrees.
    Triangles,
    /// Two offset triangle sets.
    Stars,
    /// Three line sets that slide with height.
    Cubic,
    /// Two crossing sets that turn a little every layer.
    CrossHatch,
    Honeycomb,
    /// Honeycomb sliding sideways with height.
    Honeycomb3d,
    Gyroid,
    /// Loops offset inward from the outline.
    Concentric,
    /// Branching trees that hold up only what needs it.
    Lightning,
    /// Cubic lattice with small cells near the surface and big ones inside.
    AdaptiveCubic,
    /// Adaptive cubic that is dense only under top surfaces.
    SupportCubic,
    /// Rectilinear in one direction on every layer.
    AlignedRectilinear,
    /// Orca's quarter cubic: four line sets that slide with height.
    QuarterCubic,
    /// Orca's lateral lattice: two sets of slanted walls.
    LateralLattice,
    /// Space filling curves, anchored to the objects so every layer shares them.
    HilbertCurve,
    ArchimedeanChords,
    OctagramSpiral,
    /// Schwarz diamond lines, one curve per layer that stacks into a minimal surface.
    TpmsD,
    /// Fischer-Koch S minimal surface, traced with marching squares.
    TpmsFk,
    /// Honeycomb walls that lean with height, from Y shaped stacks of vertical sweeps.
    LateralHoneycomb,
    /// Rectilinear whose lines keep their place from layer to layer, joined in one direction.
    ZigZag,
    /// Zigzag whose lattice moves sideways by `infill_shift_step` every other layer.
    CrossZag,
    /// Zigzag skeleton inside a skin of cross zag, each at its own density and line width.
    LockedZag,
}

impl InfillPattern {
    /// The pattern a setting value names, when the engine draws it. The straight line patterns of the surface
    /// settings (`monotonic`, `monotonicline`) are not here: they are rectilinear fills with their own joins.
    pub fn from_key(key: &str) -> Option<Self> {
        Some(match key {
            "rectilinear" => Self::Rectilinear,
            "alignedrectilinear" => Self::AlignedRectilinear,
            "zigzag" | "zig-zag" => Self::ZigZag,
            "crosszag" => Self::CrossZag,
            "lockedzag" => Self::LockedZag,
            "line" => Self::Line,
            "grid" => Self::Grid,
            "triangles" => Self::Triangles,
            // Orca draws its tri-hexagon pattern with the stars fill.
            "stars" | "tri-hexagon" => Self::Stars,
            "cubic" => Self::Cubic,
            "adaptivecubic" => Self::AdaptiveCubic,
            "quartercubic" => Self::QuarterCubic,
            "supportcubic" => Self::SupportCubic,
            "lightning" => Self::Lightning,
            "honeycomb" => Self::Honeycomb,
            "3dhoneycomb" => Self::Honeycomb3d,
            "lateral-honeycomb" => Self::LateralHoneycomb,
            "lateral-lattice" => Self::LateralLattice,
            "crosshatch" => Self::CrossHatch,
            "tpmsd" => Self::TpmsD,
            "tpmsfk" => Self::TpmsFk,
            "gyroid" => Self::Gyroid,
            "concentric" => Self::Concentric,
            "hilbertcurve" => Self::HilbertCurve,
            "archimedeanchords" => Self::ArchimedeanChords,
            "octagramspiral" => Self::OctagramSpiral,
            _ => return None,
        })
    }

    /// True for the pattern drawn on the shared scanlines (rectilinear, as Orca's traversal);
    /// the rest are drawn over the sparse region as polygons.
    pub fn on_scanlines(self) -> bool {
        matches!(
            self,
            Self::Rectilinear | Self::AlignedRectilinear | Self::ZigZag | Self::CrossZag | Self::LockedZag
        )
    }
}

/// The order walls are printed in within an island.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WallSequence {
    /// Inner walls first, the outer wall last.
    #[default]
    InnerOuter,
    OuterInner,
    /// The first inner wall, then the outer wall, then the remaining inner walls.
    InnerOuterInner,
}

/// Where each wall loop starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SeamPosition {
    /// The rearmost point of the loop (the highest y, then the leftmost).
    #[default]
    Back,
    /// The point nearest to the nozzle when the loop starts.
    Nearest,
    /// A sharp corner, concave ones first, so seams stack in a line up the part
    /// and hide in the corners; the rearmost point when the loop is smooth.
    Aligned,
    /// [`Self::Aligned`] limited to the rear quarter of the loop.
    AlignedBack,
    /// A point chosen from the layer and the loop, the same on every run.
    Random,
}

/// How supports are laid out (`support_style`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SupportStyle {
    /// The type's own default: grid for normal supports, organic for tree supports.
    #[default]
    Default,
    /// Rectangular blocks around the overhang footprint (normal supports).
    Grid,
    /// Tight to the overhang (normal supports).
    Snug,
    TreeSlim,
    TreeStrong,
    TreeHybrid,
    TreeOrganic,
}

impl SupportStyle {
    /// Slim, strong and hybrid trees: Orca's `TreeSupport`, not the organic `TreeSupport3D`.
    pub fn is_classic_tree(self) -> bool {
        matches!(self, Self::TreeSlim | Self::TreeStrong | Self::TreeHybrid)
    }

    /// True for the tree styles.
    pub fn is_tree(self) -> bool {
        matches!(
            self,
            Self::TreeSlim | Self::TreeStrong | Self::TreeHybrid | Self::TreeOrganic
        )
    }
}

/// Tree support settings (`tree_support_*` keys, `OrcaSlicer`'s names and defaults).
#[derive(Debug, Clone, PartialEq)]
pub struct TreeSupportConfig {
    /// Slope of a branch from vertical, degrees, for the slim, strong and hybrid styles.
    pub branch_angle: f64,
    /// The same for the organic style.
    pub branch_angle_organic: f64,
    /// Widest a branch grows, mm (slim, strong, hybrid) and for organic.
    pub branch_diameter: f64,
    pub branch_diameter_organic: f64,
    /// How fast a branch widens going down, degrees.
    pub branch_diameter_angle: f64,
    /// Distance between branch tips, mm (slim, strong, hybrid) and for organic.
    pub branch_distance: f64,
    pub branch_distance_organic: f64,
    /// Diameter of a tip where it touches the part, mm.
    pub tip_diameter: f64,
    /// Walls around a branch; 0 lets the style decide.
    pub wall_count: u32,
    /// Brim under the branches that reach the bed.
    pub auto_brim: bool,
    pub brim_width: f64,
    /// Steeper than this a branch is slowed, degrees.
    pub angle_slow: f64,
    /// Share of the overhang area that gets tips.
    pub top_rate: f64,
}

impl Default for TreeSupportConfig {
    fn default() -> Self {
        Self {
            branch_angle: 40.0,
            branch_angle_organic: 40.0,
            branch_diameter: 5.0,
            branch_diameter_organic: 2.0,
            branch_diameter_angle: 5.0,
            branch_distance: 5.0,
            branch_distance_organic: 1.0,
            tip_diameter: 0.8,
            wall_count: 0,
            auto_brim: true,
            brim_width: 3.0,
            angle_slow: 25.0,
            top_rate: 30.0,
        }
    }
}

/// Support settings (`support_*` keys), used when `enable_support` is set.
#[derive(Debug, Clone, PartialEq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "one field per boolean setting of the profile"
)]
pub struct SupportConfig {
    /// `normal` or `tree`; tree supports are drawn as normal ones for now.
    pub tree: bool,
    pub style: SupportStyle,
    pub tree_settings: TreeSupportConfig,
    /// Overhangs narrower than this share of the line width overlap are left alone (`support_threshold_overlap`), percent.
    pub threshold_overlap: f64,
    /// Skip overhangs smaller than a few line widths (`support_remove_small_overhang`).
    pub remove_small_overhang: bool,
    /// Gap between the first layer of support and the part, mm.
    pub object_first_layer_gap: f64,
    /// Grow the support area by this much, mm.
    pub expansion: f64,
    /// Manual types print supports only where enforcers ask; none can be given yet.
    pub manual: bool,
    /// Slope from horizontal below which an overhang gets support, degrees.
    pub threshold_angle: f64,
    pub on_build_plate_only: bool,
    pub xy_distance: f64,
    pub top_z_distance: f64,
    pub bottom_z_distance: f64,
    pub interface_top_layers: u32,
    /// Interface layers where support rests on the part; 0 has none.
    pub interface_bottom_layers: u32,
    /// Distance between base lines, mm.
    pub base_spacing: f64,
    /// Distance between interface lines, mm; 0 prints them solid.
    pub interface_spacing: f64,
    pub base_pattern: InfillPattern,
    pub speed: f64,
    pub interface_speed: f64,
    /// Direction of the base lines (`support_angle`), degrees; the interface runs a right angle across.
    pub angle: f64,
    /// Distance between bottom interface lines (`support_bottom_interface_spacing`), mm.
    pub bottom_interface_spacing: f64,
    /// `support_interface_pattern`.
    pub interface_pattern: InterfacePattern,
    /// One loop around each top contact area (`support_interface_loop_pattern`).
    pub interface_loops: bool,
    /// Ironing over the top contact layers (`support_ironing`, `_flow` percent, `_spacing` mm, `_pattern`).
    pub ironing: bool,
    pub ironing_flow: f64,
    pub ironing_spacing: f64,
    pub ironing_concentric: bool,
    /// Layers from the bed on which every overhang gets support whatever its angle (`enforce_support_layers`).
    pub enforce_layers: u32,
    /// No support under bridges (`bridge_no_support`).
    pub bridge_no_support: bool,
    /// Longest bridge left without support for tree supports (`max_bridge_length`), mm.
    pub max_bridge_length: f64,
    /// The part's walls as the overhang detection sees them: wall loops, outer and inner wall width
    /// and the nozzle, mm. Filled from the print settings by [`PrintConfig::support_config`].
    pub walls: (u32, f64, f64, f64),
}

/// The pattern of support interface layers (`support_interface_pattern`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InterfacePattern {
    /// Rectilinear, or concentric when the top gap is zero.
    #[default]
    Auto,
    Rectilinear,
    Concentric,
    /// Rectilinear turning a right angle on every interface layer.
    RectilinearInterlaced,
    Grid,
}

impl Default for SupportConfig {
    fn default() -> Self {
        Self {
            tree: false,
            style: SupportStyle::Default,
            tree_settings: TreeSupportConfig::default(),
            threshold_overlap: 50.0,
            remove_small_overhang: true,
            object_first_layer_gap: 0.2,
            expansion: 0.0,
            manual: false,
            threshold_angle: 30.0,
            on_build_plate_only: false,
            xy_distance: 0.35,
            top_z_distance: 0.2,
            bottom_z_distance: 0.2,
            interface_top_layers: 2,
            interface_bottom_layers: 0,
            base_spacing: 2.5,
            interface_spacing: 0.5,
            base_pattern: InfillPattern::Rectilinear,
            speed: 150.0,
            interface_speed: 80.0,
            angle: 0.0,
            bottom_interface_spacing: 0.5,
            interface_pattern: InterfacePattern::Auto,
            interface_loops: false,
            ironing: false,
            ironing_flow: 10.0,
            ironing_spacing: 0.1,
            ironing_concentric: false,
            enforce_layers: 0,
            bridge_no_support: false,
            max_bridge_length: 10.0,
            walls: (2, 0.42, 0.45, 0.4),
        }
    }
}

/// Line widths set per feature, mm.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct FeatureWidths {
    pub outer_wall: Option<f64>,
    pub inner_wall: Option<f64>,
    pub sparse_infill: Option<f64>,
    pub internal_solid_infill: Option<f64>,
    pub top_surface: Option<f64>,
    pub support: Option<f64>,
    /// Every line of the first layer.
    pub initial_layer: Option<f64>,
}

/// Every setting the core reads, in millimeters, mm/s, percent and Celsius.
#[derive(Debug, Clone, PartialEq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "one field per boolean setting of the profile"
)]
pub struct PrintConfig {
    pub layer_height: f64,
    pub initial_layer_print_height: f64,
    pub wall_loops: u32,
    pub wall_sequence: WallSequence,
    /// One wall only on the first layer.
    pub only_one_wall_first_layer: bool,
    /// Minimum thickness of the top and bottom shells, mm; 0 leaves the layer counts alone.
    pub top_shell_thickness: f64,
    pub bottom_shell_thickness: f64,
    pub top_shell_layers: u32,
    pub bottom_shell_layers: u32,
    /// Percent, 0 to 100.
    pub sparse_infill_density: f64,
    pub sparse_infill_pattern: InfillPattern,
    /// Set when `sparse_infill_pattern` named a pattern the core does not have.
    pub sparse_infill_pattern_fallback: Option<String>,
    /// Longest gap between infill line ends that is bridged along the region's edge, mm; 0 keeps lines separate.
    pub sparse_infill_anchor_max: f64,
    pub line_width: f64,
    /// Widths that differ from `line_width` per feature (walls, infill, top surface and the first layer);
    /// `None` keeps the general line width. See [`PrintConfig::outer_wall_width`] and the like.
    pub feature_widths: FeatureWidths,
    /// Percent of the line width.
    pub infill_wall_overlap: f64,
    pub brim_width: f64,
    /// Loops of skirt around the first layers, 0 is off.
    pub skirt_loops: u32,
    /// Gap between the part (or its brim) and the skirt, mm.
    pub skirt_distance: f64,
    /// Layers the skirt is printed on.
    pub skirt_height: u32,
    pub enable_support: bool,
    pub support: SupportConfig,
    pub nozzle_diameter: f64,
    /// Per filament slot, index 0 is slot 1. The last entry repeats for higher slots.
    pub nozzle_temperature: Vec<f64>,
    pub hot_plate_temp: f64,
    pub filament_diameter: f64,
    /// g/cm3, per slot.
    pub filament_density: Vec<f64>,
    /// Money per kg, per slot.
    pub filament_cost: Vec<f64>,
    pub printable_area: Vec<[f64; 2]>,
    pub printable_height: f64,
    pub gcode_flavor: GcodeFlavor,
    pub outer_wall_speed: f64,
    pub inner_wall_speed: f64,
    pub sparse_infill_speed: f64,
    pub internal_solid_infill_speed: f64,
    pub top_surface_speed: f64,
    pub initial_layer_speed: f64,
    pub initial_layer_infill_speed: f64,
    pub travel_speed: f64,
    pub retraction_length: f64,
    pub retraction_speed: f64,
    pub retraction_minimum_travel: f64,
    /// Every key the config object carried, as given: custom G-code templates read
    /// the profile's other settings from here.
    pub raw: serde_json::Map<String, Value>,
    /// The moment of slicing for the date variables of custom G-code (`year` to `second`): Unix seconds and the
    /// offset of local time from UTC in minutes. Without it, native builds read the system clock in UTC and
    /// WASM builds read 1970.
    pub now: Option<(i64, i32)>,
    /// Limits of the target printer, for the G-code linter and the clamps.
    pub limits: crate::gcode_lint::Limits,
    /// Custom G-code came from somewhere other than the person's own settings
    /// (a project, a shared preset, a library file or a tool call).
    pub untrusted_gcode: bool,
    /// Lift the nozzle by this much on travels that retract, mm; 0 is off.
    pub z_hop: f64,
    /// Lift only when the nozzle is above / below these heights (below 0 means no limit).
    pub retract_lift_above: f64,
    pub retract_lift_below: f64,
    /// Speed of the unretract, mm/s; 0 uses `retraction_speed`.
    pub deretraction_speed: f64,
    /// Extra filament pushed after an unretract, mm.
    pub retract_restart_extra: f64,
    /// Wipe: move back along the last path while retracting.
    pub wipe: bool,
    pub wipe_distance: f64,
    pub fan_min_speed: f64,
    pub fan_max_speed: f64,
    /// Layers taking longer than this print at the minimum fan speed, shorter ones ramp toward the maximum, s.
    pub fan_cooling_layer_time: f64,
    pub close_fan_the_first_x_layers: u32,
    /// Fan speed on bridges and overhang walls, percent; used when `enable_overhang_bridge_fan`.
    pub overhang_fan_speed: f64,
    pub enable_overhang_bridge_fan: bool,
    /// Slow a layer down until it takes `slow_down_layer_time`, but not below `slow_down_min_speed`.
    pub slow_down_for_layer_cooling: bool,
    pub slow_down_layer_time: f64,
    pub slow_down_min_speed: f64,
    /// Temperatures of the first layer; empty means the same as the rest.
    pub nozzle_temperature_initial_layer: Vec<f64>,
    /// Bed temperature of the first layer; 0 means the same as the rest.
    pub hot_plate_temp_initial_layer: f64,
    /// Extrusion multiplier per slot; 1 leaves the geometric flow alone.
    pub filament_flow_ratio: Vec<f64>,
    /// Speed for walls hanging over the layer below by 25, 50, 75 and 100
    /// percent of the line width, mm/s; 0 keeps the wall speed.
    pub overhang_speed: [f64; 4],
    pub seam_position: SeamPosition,
    /// Bridge speed, mm/s.
    pub bridge_speed: f64,
    /// Speed of gap fill beads, mm/s.
    pub gap_infill_speed: f64,
    /// Speed of internal bridges (solid infill over sparse infill), mm/s.
    pub internal_bridge_speed: f64,
    /// Bridge extrusion multiplier applied to a round strand of the nozzle diameter.
    pub bridge_flow: f64,
    /// Bridges are round strands of the nozzle diameter (true) or ordinary flat beads (false).
    pub thick_bridges: bool,
    pub enable_pressure_advance: bool,
    /// Pressure advance (Klipper `ADVANCE`, Marlin `K`) per slot; used when enabled.
    pub pressure_advance: Vec<f64>,
}

/// The settings schema's defaults (`packages/settings/defaults.json`: key to `[group, value]`), embedded once.
pub(crate) const SCHEMA_DEFAULTS: &str = include_str!(concat!(env!("OUT_DIR"), "/defaults.json"));

/// The process keys of the schema defaults as one object. Printer and filament keys come from their profiles.
fn process_defaults() -> Value {
    let mut out = serde_json::Map::new();
    if let Ok(Value::Object(all)) = serde_json::from_str::<Value>(SCHEMA_DEFAULTS) {
        for (key, entry) in all {
            if let Some([scope, value]) = entry.as_array().map(Vec::as_slice)
                && scope == "process"
            {
                out.insert(key, value.clone());
            }
        }
    }
    Value::Object(out)
}

impl Default for PrintConfig {
    /// The settings schema's process defaults (what the app starts from) over the engine's own machine and
    /// filament values: a 256 mm Marlin 2 bed, 0.4 mm nozzle, PLA at 220 C. Any host that leaves a key out
    /// gets the same value the app shows.
    fn default() -> Self {
        static DEFAULT: std::sync::OnceLock<PrintConfig> = std::sync::OnceLock::new();
        DEFAULT
            .once(|| {
                let mut c = Self::builtin();
                // The schema's values all parse; a bad one would leave the engine's own.
                let _ = c.apply_value(&process_defaults());
                c
            })
            .clone()
    }
}

impl PrintConfig {
    /// The engine's own values, under the schema defaults.
    pub(crate) fn builtin() -> Self {
        Self {
            layer_height: 0.2,
            initial_layer_print_height: 0.2,
            wall_loops: 2,
            wall_sequence: WallSequence::InnerOuter,
            only_one_wall_first_layer: false,
            top_shell_thickness: 0.0,
            bottom_shell_thickness: 0.0,
            top_shell_layers: 5,
            bottom_shell_layers: 3,
            sparse_infill_density: 15.0,
            sparse_infill_pattern: InfillPattern::Rectilinear,
            sparse_infill_pattern_fallback: None,
            sparse_infill_anchor_max: 20.0,
            line_width: 0.42,
            feature_widths: FeatureWidths::default(),
            infill_wall_overlap: 15.0,
            brim_width: 5.0,
            skirt_loops: 0,
            skirt_distance: 2.0,
            skirt_height: 1,
            enable_support: false,
            support: SupportConfig::default(),
            nozzle_diameter: 0.4,
            nozzle_temperature: vec![220.0],
            hot_plate_temp: 55.0,
            filament_diameter: 1.75,
            filament_density: vec![1.24],
            filament_cost: vec![0.0],
            printable_area: vec![[0.0, 0.0], [256.0, 0.0], [256.0, 256.0], [0.0, 256.0]],
            printable_height: 250.0,
            gcode_flavor: GcodeFlavor::Marlin2,
            outer_wall_speed: 200.0,
            inner_wall_speed: 300.0,
            sparse_infill_speed: 270.0,
            internal_solid_infill_speed: 250.0,
            top_surface_speed: 200.0,
            initial_layer_speed: 50.0,
            initial_layer_infill_speed: 105.0,
            travel_speed: 500.0,
            retraction_length: 0.8,
            retraction_speed: 30.0,
            retraction_minimum_travel: 1.0,
            raw: serde_json::Map::new(),
            now: None,
            limits: crate::gcode_lint::Limits::default(),
            untrusted_gcode: true,
            z_hop: 0.0,
            retract_lift_above: 0.0,
            retract_lift_below: 0.0,
            deretraction_speed: 0.0,
            retract_restart_extra: 0.0,
            wipe: false,
            wipe_distance: 1.0,
            fan_min_speed: 35.0,
            fan_max_speed: 100.0,
            fan_cooling_layer_time: 60.0,
            close_fan_the_first_x_layers: 1,
            overhang_fan_speed: 100.0,
            enable_overhang_bridge_fan: true,
            slow_down_for_layer_cooling: true,
            slow_down_layer_time: 4.0,
            slow_down_min_speed: 10.0,
            nozzle_temperature_initial_layer: Vec::new(),
            hot_plate_temp_initial_layer: 0.0,
            filament_flow_ratio: vec![1.0],
            seam_position: SeamPosition::Back,
            overhang_speed: [0.0; 4],
            bridge_speed: 50.0,
            gap_infill_speed: 250.0,
            // 150 percent of the bridge speed, as when the setting is absent.
            internal_bridge_speed: 75.0,
            bridge_flow: 1.0,
            // Orca 2.4.2's default: external bridges are flat beads at the usual spacing.
            thick_bridges: false,
            enable_pressure_advance: false,
            pressure_advance: vec![0.0],
        }
    }
}

impl PrintConfig {
    /// Reads a config object with Orca keys. Missing keys keep the defaults.
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let v: Value = serde_json::from_slice(bytes).map_err(|e| Error::Config {
            key: "(root)",
            reason: e.to_string(),
        })?;
        Self::from_value(&v)
    }

    /// Same as [`Self::from_json`] for an already parsed value.
    pub fn from_value(v: &Value) -> Result<Self> {
        let mut c = Self::default();
        c.apply_value(v)?;
        c.check()?;
        Ok(c)
    }

    /// Applies the keys of a config object on top of these settings (a height
    /// range or per-object override). Keys not in the object keep their
    /// value. Does not run [`Self::check`].
    pub fn apply_value(&mut self, v: &Value) -> Result<()> {
        let Value::Object(map) = v else {
            return Err(Error::Config {
                key: "(root)",
                reason: "expected an object".to_owned(),
            });
        };
        let c = self;
        for (k, v) in map {
            // Never kept from a file: it runs programs or carries a credential.
            if !crate::preflight::is_never_imported(k) {
                c.raw.insert(k.clone(), v.clone());
            }
        }
        let get = |k: &str| map.get(k);
        macro_rules! float {
            ($key:ident) => {
                if let Some(x) = get(stringify!($key)) {
                    c.$key = num(x).ok_or_else(|| bad(stringify!($key)))?;
                }
            };
        }
        macro_rules! uint {
            ($key:ident) => {
                if let Some(x) = get(stringify!($key)) {
                    let n = num(x).ok_or_else(|| bad(stringify!($key)))?;
                    if !(0.0..=1000.0).contains(&n) {
                        return Err(bad(stringify!($key)));
                    }
                    #[allow(
                        clippy::cast_possible_truncation,
                        clippy::cast_sign_loss,
                        reason = "range checked above"
                    )]
                    {
                        c.$key = n.round() as u32;
                    }
                }
            };
        }
        macro_rules! floats {
            ($key:ident) => {
                if let Some(x) = get(stringify!($key)) {
                    c.$key = nums(x).ok_or_else(|| bad(stringify!($key)))?;
                }
            };
        }
        float!(layer_height);
        float!(initial_layer_print_height);
        uint!(wall_loops);
        uint!(top_shell_layers);
        uint!(bottom_shell_layers);
        float!(sparse_infill_density);
        float!(infill_wall_overlap);
        float!(brim_width);
        float!(printable_height);
        float!(outer_wall_speed);
        float!(inner_wall_speed);
        float!(sparse_infill_speed);
        float!(internal_solid_infill_speed);
        float!(top_surface_speed);
        float!(initial_layer_speed);
        float!(initial_layer_infill_speed);
        float!(travel_speed);
        float!(bridge_speed);
        float!(gap_infill_speed);
        // Orca's `internal_bridge_speed` is a speed or a percent of `bridge_speed`, 150 percent by default.
        // Read from everything applied so far, so an override of either key keeps the rule.
        c.internal_bridge_speed = match c.raw.get("internal_bridge_speed") {
            Some(x) => {
                let v = num(x).ok_or_else(|| bad("internal_bridge_speed"))?;
                let percent = x.as_str().is_some_and(|t| t.trim().ends_with('%'))
                    || x.as_array()
                        .and_then(|a| a.first())
                        .and_then(Value::as_str)
                        .is_some_and(|t| t.trim().ends_with('%'));
                if percent { c.bridge_speed * v / 100.0 } else { v }
            }
            None => c.bridge_speed * 1.5,
        };
        float!(bridge_flow);
        for (i, key) in [
            "overhang_1_4_speed",
            "overhang_2_4_speed",
            "overhang_3_4_speed",
            "overhang_4_4_speed",
        ]
        .into_iter()
        .enumerate()
        {
            if let Some(x) = get(key) {
                let v = num(x).ok_or_else(|| bad(key))?;
                if let Some(slot) = c.overhang_speed.get_mut(i) {
                    *slot = v;
                }
            }
        }
        if let Some(x) = get("enable_overhang_speed")
            && !flag(x).ok_or_else(|| bad("enable_overhang_speed"))?
        {
            c.overhang_speed = [0.0; 4];
        }
        floats!(nozzle_temperature);
        floats!(filament_density);
        floats!(filament_cost);
        floats!(filament_flow_ratio);
        floats!(pressure_advance);
        for (key, dst) in [
            ("nozzle_diameter", &mut c.nozzle_diameter),
            ("filament_diameter", &mut c.filament_diameter),
            ("hot_plate_temp", &mut c.hot_plate_temp),
            ("retraction_length", &mut c.retraction_length),
            ("retraction_speed", &mut c.retraction_speed),
            ("retraction_minimum_travel", &mut c.retraction_minimum_travel),
            ("top_shell_thickness", &mut c.top_shell_thickness),
            ("bottom_shell_thickness", &mut c.bottom_shell_thickness),
            ("z_hop", &mut c.z_hop),
            ("retract_lift_above", &mut c.retract_lift_above),
            ("retract_lift_below", &mut c.retract_lift_below),
            ("deretraction_speed", &mut c.deretraction_speed),
            ("retract_restart_extra", &mut c.retract_restart_extra),
            ("wipe_distance", &mut c.wipe_distance),
            ("fan_min_speed", &mut c.fan_min_speed),
            ("fan_max_speed", &mut c.fan_max_speed),
            ("fan_cooling_layer_time", &mut c.fan_cooling_layer_time),
            ("overhang_fan_speed", &mut c.overhang_fan_speed),
            ("slow_down_layer_time", &mut c.slow_down_layer_time),
            ("slow_down_min_speed", &mut c.slow_down_min_speed),
            (
                "hot_plate_temp_initial_layer",
                &mut c.hot_plate_temp_initial_layer,
            ),
        ] {
            if let Some(x) = get(key) {
                *dst = nums(x).and_then(|v| v.first().copied()).ok_or_else(|| bad(key))?;
            }
        }
        if let Some(x) = get("enable_support") {
            c.enable_support = flag(x).ok_or_else(|| bad("enable_support"))?;
        }
        // The Z gaps between support and part follow the layer height unless they are given: one layer, at most
        // 0.2 mm, which is what the vendor presets set for each layer height (Bambu Studio and Orca keep a preset's
        // gap when only the layer height changes; a 0.2 mm gap on 0.08 mm layers rounds to three layers there).
        // `auto` asks for the same.
        let auto_gap = c.layer_height.min(0.2);
        let gap_auto = |k: &str| match get(k) {
            None => true,
            Some(Value::String(t)) => t.trim().eq_ignore_ascii_case("auto"),
            _ => false,
        };
        let (top_auto, bottom_auto) = (
            gap_auto("support_top_z_distance"),
            gap_auto("support_bottom_z_distance"),
        );
        {
            let sc = &mut c.support;
            if let Some(Value::String(t)) = get("support_type") {
                sc.tree = t.starts_with("tree");
                sc.manual = t.contains("manual");
            }
            if let Some(Value::String(t)) = get("support_style") {
                sc.style = match t.as_str() {
                    "default" => SupportStyle::Default,
                    "grid" => SupportStyle::Grid,
                    "snug" => SupportStyle::Snug,
                    "tree_slim" => SupportStyle::TreeSlim,
                    "tree_strong" => SupportStyle::TreeStrong,
                    "tree_hybrid" => SupportStyle::TreeHybrid,
                    // Orca's value is `organic`; `tree_organic` is kept as an alias.
                    "organic" | "tree_organic" => SupportStyle::TreeOrganic,
                    _ => return Err(bad("support_style")),
                };
            }
            let tr = &mut sc.tree_settings;
            for (key, dst) in [
                ("tree_support_branch_angle", &mut tr.branch_angle),
                ("tree_support_branch_angle_organic", &mut tr.branch_angle_organic),
                ("tree_support_branch_diameter", &mut tr.branch_diameter),
                (
                    "tree_support_branch_diameter_organic",
                    &mut tr.branch_diameter_organic,
                ),
                (
                    "tree_support_branch_diameter_angle",
                    &mut tr.branch_diameter_angle,
                ),
                ("tree_support_branch_distance", &mut tr.branch_distance),
                (
                    "tree_support_branch_distance_organic",
                    &mut tr.branch_distance_organic,
                ),
                ("tree_support_tip_diameter", &mut tr.tip_diameter),
                ("tree_support_brim_width", &mut tr.brim_width),
                ("tree_support_angle_slow", &mut tr.angle_slow),
                ("tree_support_top_rate", &mut tr.top_rate),
                ("support_threshold_overlap", &mut sc.threshold_overlap),
                ("support_object_first_layer_gap", &mut sc.object_first_layer_gap),
                ("support_expansion", &mut sc.expansion),
            ] {
                if let Some(x) = get(key) {
                    *dst = num(x).ok_or_else(|| bad(key))?;
                }
            }
            if let Some(x) = get("tree_support_wall_count") {
                let n = num(x).ok_or_else(|| bad("tree_support_wall_count"))?;
                if !(0.0..=20.0).contains(&n) {
                    return Err(bad("tree_support_wall_count"));
                }
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "range checked above"
                )]
                {
                    tr.wall_count = n.round() as u32;
                }
            }
            for (key, dst) in [
                ("tree_support_auto_brim", &mut tr.auto_brim),
                ("support_remove_small_overhang", &mut sc.remove_small_overhang),
            ] {
                if let Some(x) = get(key) {
                    *dst = flag(x).ok_or_else(|| bad(key))?;
                }
            }
            for (key, dst) in [
                ("support_threshold_angle", &mut sc.threshold_angle),
                ("support_object_xy_distance", &mut sc.xy_distance),
                ("support_base_pattern_spacing", &mut sc.base_spacing),
                ("support_interface_spacing", &mut sc.interface_spacing),
                ("support_speed", &mut sc.speed),
                ("support_interface_speed", &mut sc.interface_speed),
                ("support_angle", &mut sc.angle),
                (
                    "support_bottom_interface_spacing",
                    &mut sc.bottom_interface_spacing,
                ),
                ("support_ironing_flow", &mut sc.ironing_flow),
                ("support_ironing_spacing", &mut sc.ironing_spacing),
                ("max_bridge_length", &mut sc.max_bridge_length),
            ] {
                if let Some(x) = get(key) {
                    *dst = num(x).ok_or_else(|| bad(key))?;
                }
            }
            for (key, auto, dst) in [
                ("support_top_z_distance", top_auto, &mut sc.top_z_distance),
                (
                    "support_bottom_z_distance",
                    bottom_auto,
                    &mut sc.bottom_z_distance,
                ),
            ] {
                if auto {
                    *dst = auto_gap;
                } else if let Some(x) = get(key) {
                    *dst = num(x).ok_or_else(|| bad(key))?;
                }
            }
            for (key, dst) in [
                ("support_interface_loop_pattern", &mut sc.interface_loops),
                ("support_ironing", &mut sc.ironing),
                ("bridge_no_support", &mut sc.bridge_no_support),
            ] {
                if let Some(x) = get(key) {
                    *dst = flag(x).ok_or_else(|| bad(key))?;
                }
            }
            if let Some(x) = get("enforce_support_layers") {
                let n = num(x).ok_or_else(|| bad("enforce_support_layers"))?;
                if !(0.0..=100_000.0).contains(&n) {
                    return Err(bad("enforce_support_layers"));
                }
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "range checked above"
                )]
                {
                    sc.enforce_layers = n.round() as u32;
                }
            }
            if let Some(Value::String(p)) = get("support_interface_pattern") {
                sc.interface_pattern = match p.as_str() {
                    "auto" | "default" => InterfacePattern::Auto,
                    "rectilinear" => InterfacePattern::Rectilinear,
                    "concentric" => InterfacePattern::Concentric,
                    "rectilinear_interlaced" => InterfacePattern::RectilinearInterlaced,
                    "grid" => InterfacePattern::Grid,
                    _ => return Err(bad("support_interface_pattern")),
                };
            }
            if let Some(Value::String(p)) = get("support_ironing_pattern") {
                sc.ironing_concentric = p == "concentric";
            }
            if let Some(x) = get("support_interface_top_layers") {
                let n = num(x).ok_or_else(|| bad("support_interface_top_layers"))?;
                if !(0.0..=50.0).contains(&n) {
                    return Err(bad("support_interface_top_layers"));
                }
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "range checked above"
                )]
                {
                    sc.interface_top_layers = n.round() as u32;
                }
            }
            if let Some(x) = get("support_interface_bottom_layers") {
                let n = num(x).ok_or_else(|| bad("support_interface_bottom_layers"))?;
                if !(-1.0..=50.0).contains(&n) {
                    return Err(bad("support_interface_bottom_layers"));
                }
                // -1 is "the same as the top".
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "range checked above"
                )]
                {
                    sc.interface_bottom_layers = if n < 0.0 {
                        sc.interface_top_layers
                    } else {
                        n.round() as u32
                    };
                }
            }
            if let Some(x) = get("support_on_build_plate_only") {
                sc.on_build_plate_only = flag(x).ok_or_else(|| bad("support_on_build_plate_only"))?;
            }
            if let Some(Value::String(p)) = get("support_base_pattern") {
                sc.base_pattern = match p.as_str() {
                    "rectilinear-grid" => InfillPattern::Grid,
                    "honeycomb" => InfillPattern::Honeycomb,
                    _ => InfillPattern::Rectilinear,
                };
            }
        }
        for (key, dst) in [
            ("wipe", &mut c.wipe),
            ("only_one_wall_first_layer", &mut c.only_one_wall_first_layer),
            ("thick_bridges", &mut c.thick_bridges),
            ("enable_overhang_bridge_fan", &mut c.enable_overhang_bridge_fan),
            ("slow_down_for_layer_cooling", &mut c.slow_down_for_layer_cooling),
        ] {
            if let Some(x) = get(key) {
                *dst = flag(x).ok_or_else(|| bad(key))?;
            }
        }
        for (key, dst) in [
            ("skirt_loops", &mut c.skirt_loops),
            ("skirt_height", &mut c.skirt_height),
        ] {
            if let Some(x) = get(key) {
                let n = num(x).ok_or_else(|| bad(key))?;
                if !(0.0..=1000.0).contains(&n) {
                    return Err(bad(key));
                }
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "range checked above"
                )]
                {
                    *dst = n.round() as u32;
                }
            }
        }
        if let Some(x) = get("skirt_distance") {
            c.skirt_distance = num(x).ok_or_else(|| bad("skirt_distance"))?;
        }
        if let Some(x) = get("close_fan_the_first_x_layers") {
            let n = num(x).ok_or_else(|| bad("close_fan_the_first_x_layers"))?;
            if !(0.0..=1000.0).contains(&n) {
                return Err(bad("close_fan_the_first_x_layers"));
            }
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "range checked above"
            )]
            {
                c.close_fan_the_first_x_layers = n.round() as u32;
            }
        }
        floats!(nozzle_temperature_initial_layer);
        if let Some(x) = get("enable_pressure_advance") {
            c.enable_pressure_advance = flag(x).ok_or_else(|| bad("enable_pressure_advance"))?;
        }
        if let Some(Value::String(s)) = get("brim_type")
            && s == "no_brim"
        {
            c.brim_width = 0.0;
        }
        if let Some(Value::String(s)) = get("sparse_infill_pattern") {
            match InfillPattern::from_key(s) {
                Some(p) => c.sparse_infill_pattern = p,
                None => c.sparse_infill_pattern_fallback = Some(s.clone()),
            }
        }
        if let Some(Value::String(v)) = get("wall_sequence") {
            c.wall_sequence = match v.as_str() {
                "inner wall/outer wall" => WallSequence::InnerOuter,
                "outer wall/inner wall" => WallSequence::OuterInner,
                "inner-outer-inner wall" => WallSequence::InnerOuterInner,
                _ => return Err(bad("wall_sequence")),
            };
        }
        if let Some(Value::String(v)) = get("seam_position") {
            c.seam_position = match v.as_str() {
                "back" | "rear" => SeamPosition::Back,
                "nearest" => SeamPosition::Nearest,
                "aligned" => SeamPosition::Aligned,
                "aligned_back" => SeamPosition::AlignedBack,
                "random" => SeamPosition::Random,
                _ => return Err(bad("seam_position")),
            };
        }
        if let Some(x) = get("gcode_flavor") {
            let s = x.as_str().ok_or_else(|| bad("gcode_flavor"))?;
            c.gcode_flavor = GcodeFlavor::parse(s).ok_or_else(|| bad("gcode_flavor"))?;
        }
        if let Some(x) = get("printable_area") {
            c.printable_area = points(x).ok_or_else(|| bad("printable_area"))?;
        }
        // Line width after the nozzle is known: 0 means automatic (1.05 times
        // the nozzle, as the settings schema resolves it) and "110%" is a
        // percentage of the nozzle diameter.
        if let Some(x) = get("line_width") {
            c.line_width = width(x, c.nozzle_diameter).ok_or_else(|| bad("line_width"))?;
        }
        for (key, slot) in [
            ("outer_wall_line_width", &mut c.feature_widths.outer_wall),
            ("inner_wall_line_width", &mut c.feature_widths.inner_wall),
            ("sparse_infill_line_width", &mut c.feature_widths.sparse_infill),
            (
                "internal_solid_infill_line_width",
                &mut c.feature_widths.internal_solid_infill,
            ),
            ("top_surface_line_width", &mut c.feature_widths.top_surface),
            ("support_line_width", &mut c.feature_widths.support),
            ("initial_layer_line_width", &mut c.feature_widths.initial_layer),
        ] {
            if let Some(x) = get(key) {
                // The top surface and the supports default to the nozzle's own width, the rest to 1.125 times it.
                let auto = if matches!(key, "top_surface_line_width" | "support_line_width") {
                    AUTO_NOZZLE_WIDTH_RATIO
                } else {
                    AUTO_WIDTH_RATIO
                };
                *slot = Some(width_auto(x, c.nozzle_diameter, auto).ok_or_else(|| bad(key))?);
            }
        }
        // Orca (`PrintConfigDef::normalize_fdm`): spiral vase mode is one wall, no top shell, no infill and
        // no retraction at the layer change.
        if crate::firmware::truthy(c, "spiral_mode") {
            c.wall_loops = 1;
            c.top_shell_layers = 0;
            c.top_shell_thickness = 0.0;
            c.sparse_infill_density = 0.0;
            c.raw
                .insert("retract_when_changing_layer".to_owned(), Value::Bool(false));
        }
        Ok(())
    }

    /// Rejects values that would make slicing meaningless or unbounded.
    pub fn check(&self) -> Result<()> {
        let range = |key: &'static str, v: f64, lo: f64, hi: f64| {
            if v.is_finite() && (lo..=hi).contains(&v) {
                Ok(())
            } else {
                Err(Error::Config {
                    key,
                    reason: format!("{v} is outside {lo} to {hi}"),
                })
            }
        };
        range("layer_height", self.layer_height, 0.04, 0.8)?;
        range(
            "initial_layer_print_height",
            self.initial_layer_print_height,
            0.04,
            0.8,
        )?;
        range("line_width", self.line_width, 0.1, 2.0)?;
        let w = &self.feature_widths;
        for (key, v) in [
            ("outer_wall_line_width", w.outer_wall),
            ("inner_wall_line_width", w.inner_wall),
            ("sparse_infill_line_width", w.sparse_infill),
            ("internal_solid_infill_line_width", w.internal_solid_infill),
            ("top_surface_line_width", w.top_surface),
            ("support_line_width", w.support),
            ("initial_layer_line_width", w.initial_layer),
        ] {
            if let Some(v) = v {
                range(key, v, 0.1, 2.0)?;
            }
        }
        // Geometry tolerances and overlaps Orca bounds only from below (internal_bridge_flow 0 to 2 as Orca
        // has it): values far past anything the settings offer overflow the scaled outlines.
        for (key, default, lo, hi) in [
            ("internal_bridge_flow", 1.0, 0.0, 2.0),
            ("resolution", 0.01, 0.0, 10.0),
            ("slice_closing_radius", 0.049, 0.0, 10.0),
            ("min_feature_size", 25.0, 0.0, 500.0),
            ("top_bottom_infill_wall_overlap", 25.0, -100.0, 100.0),
            // -1 is Orca's automatic width; 100 mm is brim_width's ceiling.
            ("prime_tower_brim_width", 3.0, -1.0, 100.0),
            // Degrees; Orca sets no limit and angles past a turn wrap around.
            ("wipe_tower_rotation_angle", 0.0, -3600.0, 3600.0),
            // Orca's limits; a point distance of 0 divides each wall without end (Orca's own note).
            ("fuzzy_skin_point_distance", 0.3, 0.01, 5.0),
            ("fuzzy_skin_thickness", 0.2, 0.0, 2.0),
            // Orca bounds these only from below; 100 mm is brim_width's ceiling.
            ("raft_expansion", 1.5, 0.0, 100.0),
            ("raft_first_layer_expansion", 2.0, 0.0, 100.0),
        ] {
            range(key, self.raw_number(key, default), lo, hi)?;
        }
        // Orca sets no upper limit, but a compensation of meters overflows the scaled outlines; the settings
        // offer at most 1 mm, so 5 mm either way turns away only nonsense.
        for key in [
            "elefant_foot_compensation",
            "xy_hole_compensation",
            "xy_contour_compensation",
        ] {
            range(key, self.raw_number(key, 0.0), -5.0, 5.0)?;
        }
        // Densities that spread solid lines apart, in Orca's limits (PrintConfig.cpp). A top density of 0
        // leaves the top open; one just above 0 would space the lines meters apart, so it starts at 1.
        range(
            "bottom_surface_density",
            self.raw_number("bottom_surface_density", 100.0),
            10.0,
            100.0,
        )?;
        range(
            "elefant_foot_layers_density",
            self.raw_number("elefant_foot_layers_density", 100.0),
            50.0,
            100.0,
        )?;
        let top = self.raw_number("top_surface_density", 100.0);
        if top.abs() > 0.0 || !top.is_finite() {
            range("top_surface_density", top, 1.0, 100.0)?;
        }
        // Orca's limits (PrintConfig.cpp): the print flow ratio 0.01 to 2, the ratios by role 0 to 2.
        range(
            "print_flow_ratio",
            self.raw_number("print_flow_ratio", 1.0),
            0.01,
            2.0,
        )?;
        for key in [
            "top_solid_infill_flow_ratio",
            "bottom_solid_infill_flow_ratio",
            "brim_flow_ratio",
            "outer_wall_flow_ratio",
            "inner_wall_flow_ratio",
            "overhang_flow_ratio",
            "sparse_infill_flow_ratio",
            "internal_solid_infill_flow_ratio",
            "gap_fill_flow_ratio",
            "support_flow_ratio",
            "support_interface_flow_ratio",
            "first_layer_flow_ratio",
        ] {
            range(key, self.raw_number(key, 1.0), 0.0, 2.0)?;
        }
        range("sparse_infill_density", self.sparse_infill_density, 0.0, 100.0)?;
        range("infill_wall_overlap", self.infill_wall_overlap, 0.0, 100.0)?;
        range("brim_width", self.brim_width, 0.0, 100.0)?;
        range("filament_diameter", self.filament_diameter, 0.5, 5.0)?;
        range("printable_height", self.printable_height, 1.0, 5000.0)?;
        range("wall_loops", f64::from(self.wall_loops), 0.0, 50.0)?;
        range("top_shell_layers", f64::from(self.top_shell_layers), 0.0, 100.0)?;
        range(
            "bottom_shell_layers",
            f64::from(self.bottom_shell_layers),
            0.0,
            100.0,
        )?;
        for (key, v) in [
            ("outer_wall_speed", self.outer_wall_speed),
            ("inner_wall_speed", self.inner_wall_speed),
            ("sparse_infill_speed", self.sparse_infill_speed),
            ("internal_solid_infill_speed", self.internal_solid_infill_speed),
            ("top_surface_speed", self.top_surface_speed),
            ("bridge_speed", self.bridge_speed),
            ("gap_infill_speed", self.gap_infill_speed),
            ("internal_bridge_speed", self.internal_bridge_speed),
            ("support_speed", self.support.speed),
            ("support_interface_speed", self.support.interface_speed),
            ("initial_layer_speed", self.initial_layer_speed),
            ("initial_layer_infill_speed", self.initial_layer_infill_speed),
            ("travel_speed", self.travel_speed),
            ("retraction_speed", self.retraction_speed),
        ] {
            range(key, v, 1.0, 2000.0)?;
        }
        for (key, list, lo, hi) in [
            ("filament_flow_ratio", &self.filament_flow_ratio[..], 0.1, 3.0),
            ("pressure_advance", &self.pressure_advance[..], 0.0, 10.0),
            ("bridge_flow", &[self.bridge_flow][..], 0.1, 2.0),
        ] {
            for &v in list {
                range(key, v, lo, hi)?;
            }
        }
        range("support_threshold_angle", self.support.threshold_angle, 0.0, 89.0)?;
        let t = &self.support.tree_settings;
        for (key, v, lo, hi) in [
            ("tree_support_branch_angle", t.branch_angle, 0.0, 85.0),
            (
                "tree_support_branch_angle_organic",
                t.branch_angle_organic,
                0.0,
                85.0,
            ),
            ("tree_support_branch_diameter", t.branch_diameter, 1.0, 100.0),
            (
                "tree_support_branch_diameter_organic",
                t.branch_diameter_organic,
                1.0,
                100.0,
            ),
            (
                "tree_support_branch_diameter_angle",
                t.branch_diameter_angle,
                0.0,
                15.0,
            ),
            ("tree_support_branch_distance", t.branch_distance, 1.0, 100.0),
            (
                "tree_support_branch_distance_organic",
                t.branch_distance_organic,
                1.0,
                100.0,
            ),
            ("tree_support_tip_diameter", t.tip_diameter, 0.1, 100.0),
            ("tree_support_brim_width", t.brim_width, 0.0, 100.0),
            ("tree_support_angle_slow", t.angle_slow, 0.0, 90.0),
            ("tree_support_top_rate", t.top_rate, 0.0, 100.0),
            (
                "support_threshold_overlap",
                self.support.threshold_overlap,
                0.0,
                100.0,
            ),
            (
                "support_object_first_layer_gap",
                self.support.object_first_layer_gap,
                0.0,
                5.0,
            ),
            ("support_expansion", self.support.expansion, -10.0, 10.0),
        ] {
            range(key, v, lo, hi)?;
        }
        range("support_object_xy_distance", self.support.xy_distance, 0.0, 10.0)?;
        range("support_top_z_distance", self.support.top_z_distance, 0.0, 5.0)?;
        range(
            "support_bottom_z_distance",
            self.support.bottom_z_distance,
            0.0,
            5.0,
        )?;
        range(
            "support_base_pattern_spacing",
            self.support.base_spacing,
            0.1,
            50.0,
        )?;
        range(
            "support_interface_spacing",
            self.support.interface_spacing,
            0.0,
            20.0,
        )?;
        for (key, v, hi) in [
            ("skirt_distance", self.skirt_distance, 100.0),
            ("top_shell_thickness", self.top_shell_thickness, 50.0),
            ("bottom_shell_thickness", self.bottom_shell_thickness, 50.0),
            ("z_hop", self.z_hop, 50.0),
            ("wipe_distance", self.wipe_distance, 50.0),
            ("retract_restart_extra", self.retract_restart_extra, 10.0),
            ("fan_min_speed", self.fan_min_speed, 100.0),
            ("fan_max_speed", self.fan_max_speed, 100.0),
            ("overhang_fan_speed", self.overhang_fan_speed, 100.0),
            ("slow_down_layer_time", self.slow_down_layer_time, 600.0),
            ("fan_cooling_layer_time", self.fan_cooling_layer_time, 3600.0),
            ("slow_down_min_speed", self.slow_down_min_speed, 2000.0),
            ("deretraction_speed", self.deretraction_speed, 2000.0),
            (
                "hot_plate_temp_initial_layer",
                self.hot_plate_temp_initial_layer,
                200.0,
            ),
        ] {
            range(key, v, 0.0, hi)?;
        }
        for v in self.overhang_speed {
            if v != 0.0 {
                range("overhang_speed", v, 1.0, 2000.0)?;
            }
        }
        if self.printable_area.len() < 3 {
            return Err(Error::Config {
                key: "printable_area",
                reason: "needs at least 3 points".to_owned(),
            });
        }
        Ok(())
    }

    /// Line widths by feature, mm: the feature's own setting, else the general line width.
    pub fn outer_wall_width(&self) -> f64 {
        self.feature_widths.outer_wall.unwrap_or(self.line_width)
    }

    pub fn inner_wall_width(&self) -> f64 {
        self.feature_widths.inner_wall.unwrap_or(self.line_width)
    }

    /// The support settings with the wall facts the support planner reads.
    #[must_use]
    pub fn support_config(&self) -> SupportConfig {
        let mut s = self.support.clone();
        s.walls = (
            self.wall_loops,
            self.outer_wall_width(),
            self.inner_wall_width(),
            self.nozzle_diameter,
        );
        s
    }

    pub fn sparse_infill_width(&self) -> f64 {
        self.feature_widths.sparse_infill.unwrap_or(self.line_width)
    }

    pub fn solid_infill_width(&self) -> f64 {
        self.feature_widths
            .internal_solid_infill
            .unwrap_or(self.line_width)
    }

    pub fn top_surface_width(&self) -> f64 {
        self.feature_widths.top_surface.unwrap_or(self.line_width)
    }

    pub fn support_width(&self) -> f64 {
        self.feature_widths.support.unwrap_or(self.line_width)
    }

    /// True when some feature has a width of its own that differs from `line_width`.
    pub fn has_feature_widths(&self) -> bool {
        let w = &self.feature_widths;
        [
            w.outer_wall,
            w.inner_wall,
            w.sparse_infill,
            w.internal_solid_infill,
            w.top_surface,
            w.support,
        ]
        .into_iter()
        .flatten()
        .any(|v| (v - self.line_width).abs() > 1e-9)
    }

    /// The settings for the first layer: every width is `initial_layer_line_width` when it is set.
    #[must_use]
    pub fn for_first_layer(&self) -> Self {
        let Some(w) = self.feature_widths.initial_layer else {
            return self.clone();
        };
        let mut c = self.clone();
        c.line_width = w;
        c.feature_widths = FeatureWidths {
            initial_layer: Some(w),
            ..FeatureWidths::default()
        };
        c
    }

    /// Distance between neighboring beads, mm: the line width less the
    /// rounded edges that overlap, `w - h * (1 - pi / 4)` (the layer height `h`).
    pub fn flow_spacing(&self) -> f64 {
        self.spacing_for(self.line_width)
    }

    /// [`PrintConfig::flow_spacing`] for a line of another width.
    /// Orca's `infill_anchor_max` (older profiles: `sparse_infill_anchor_max`) in mm: a plain number, or a
    /// percent of the sparse infill line spacing (`Fill.cpp`, `params.anchor_length_max`). Default 20 mm.
    pub fn anchor_max_mm(&self) -> f64 {
        let spacing = self.spacing_for(self.sparse_infill_width());
        for key in ["infill_anchor_max", "sparse_infill_anchor_max"] {
            if let Some(v) = self.raw.get(key)
                && let Some(mm) = float_or_percent(v, spacing)
            {
                return mm;
            }
        }
        self.sparse_infill_anchor_max
    }

    pub fn spacing_for(&self, width: f64) -> f64 {
        (width - self.layer_height * (1.0 - std::f64::consts::FRAC_PI_4)).max(width * 0.5)
    }

    /// Top and bottom shell layers on a layer `height` mm thick: the layer
    /// counts, or as many layers as the minimum shell thickness needs.
    pub fn shell_layers(&self, height: f64) -> (u32, u32) {
        let need = |mm: f64, layers: u32| {
            let n = if height > 0.0 {
                (mm / height - 1e-6).ceil().max(0.0)
            } else {
                0.0
            };
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a few layers"
            )]
            layers.max(n.min(100.0) as u32)
        };
        (
            need(self.top_shell_thickness, self.top_shell_layers),
            need(self.bottom_shell_thickness, self.bottom_shell_layers),
        )
    }

    /// Filament `slot`'s own value of a printer retraction key (`filament_<key>`), when it sets one: an
    /// entry that is not empty, null or `nil`. The cut retraction keys count only with
    /// `enable_long_retraction_when_cut` at 2, as in Orca's `compute_filament_override_value`.
    pub fn filament_override(&self, key: &str, slot: u8) -> Option<&Value> {
        if key.ends_with("_when_cut")
            && (self.raw_number("enable_long_retraction_when_cut", 0.0) - 2.0).abs() > 0.5
        {
            return None;
        }
        let v = match self.raw.get(&format!("filament_{key}"))? {
            Value::Array(a) => a.get(usize::from(slot.max(1) - 1)).or_else(|| a.last())?,
            v => v,
        };
        let unset = match v {
            Value::Null => true,
            Value::String(t) => t.trim().is_empty() || t == "nil",
            Value::Array(a) => a.is_empty(),
            _ => false,
        };
        (!unset).then_some(v)
    }

    /// The retraction length filament `slot` prints with: `for_filament(slot).retraction_length` without
    /// the copy of the config.
    pub fn filament_retraction_length(&self, slot: u8) -> f64 {
        self.filament_override("retraction_length", slot)
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
            })
            .unwrap_or(self.retraction_length)
    }

    /// This config as filament `slot` prints it: each retraction setting the filament overrides
    /// ([`FILAMENT_OVERRIDES`]) replaces the printer's value. Borrowed when the filament overrides nothing.
    pub fn for_filament(&self, slot: u8) -> std::borrow::Cow<'_, PrintConfig> {
        let own: Vec<(&str, &Value)> = FILAMENT_OVERRIDES
            .iter()
            .filter_map(|k| self.filament_override(k, slot).map(|v| (*k, v)))
            .collect();
        if own.is_empty() {
            return std::borrow::Cow::Borrowed(self);
        }
        let mut c = self.clone();
        let num = |v: &Value| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|t| t.trim().parse().ok()))
        };
        for (key, v) in own {
            let field = match key {
                "retraction_length" => Some(&mut c.retraction_length),
                "retraction_speed" => Some(&mut c.retraction_speed),
                "retraction_minimum_travel" => Some(&mut c.retraction_minimum_travel),
                "z_hop" => Some(&mut c.z_hop),
                "retract_lift_above" => Some(&mut c.retract_lift_above),
                "retract_lift_below" => Some(&mut c.retract_lift_below),
                "deretraction_speed" => Some(&mut c.deretraction_speed),
                "retract_restart_extra" => Some(&mut c.retract_restart_extra),
                "wipe_distance" => Some(&mut c.wipe_distance),
                _ => None,
            };
            match (field, num(v)) {
                (Some(f), Some(x)) => *f = x,
                (Some(_), None) => continue,
                (None, _) => {}
            }
            if key == "wipe" {
                c.wipe = v.as_bool().unwrap_or_else(|| num(v).is_some_and(|x| x != 0.0));
            }
            c.raw.insert(key.to_owned(), Value::Array(vec![v.clone()]));
        }
        std::borrow::Cow::Owned(c)
    }

    /// Value for a 1-based filament slot from a per-slot list.
    pub fn per_slot(list: &[f64], slot: u8, fallback: f64) -> f64 {
        let i = usize::from(slot.max(1) - 1);
        list.get(i).or_else(|| list.last()).copied().unwrap_or(fallback)
    }

    /// Filament density for a slot, g/cm3. Unset or 0 (the settings default
    /// before a filament profile is chosen) falls back to PLA's 1.24.
    pub fn density(&self, slot: u8) -> f64 {
        let d = Self::per_slot(&self.filament_density, slot, DEFAULT_DENSITY);
        if d.is_finite() && d > 0.0 {
            d
        } else {
            DEFAULT_DENSITY
        }
    }

    /// Filament price for a slot, money per kg; 0 when unset.
    pub fn cost_per_kg(&self, slot: u8) -> f64 {
        let c = Self::per_slot(&self.filament_cost, slot, 0.0);
        if c.is_finite() && c > 0.0 { c } else { 0.0 }
    }

    /// Extrusion multiplier for a slot; 1 when unset.
    pub fn flow_ratio(&self, slot: u8) -> f64 {
        Self::per_slot(&self.filament_flow_ratio, slot, 1.0)
    }

    /// The extrusion multiplier Orca applies by role (`GCode::_extrude`): the print flow ratio, the top and
    /// bottom solid and brim ratios, and with `set_other_flow_ratios` the ratios of the other roles and of the
    /// first layer.
    pub fn role_flow_ratio(&self, feature: crate::output::Feature, first_layer: bool) -> f64 {
        use crate::output::Feature as F;
        let r = |k: &str| self.raw_number(k, 1.0);
        let mut v = r("print_flow_ratio");
        v *= match feature {
            F::TopSurface => r("top_solid_infill_flow_ratio"),
            F::BottomSurface => r("bottom_solid_infill_flow_ratio"),
            F::Brim => r("brim_flow_ratio"),
            _ => 1.0,
        };
        if crate::tower::flag(self, "set_other_flow_ratios") {
            v *= match feature {
                F::OuterWall => r("outer_wall_flow_ratio"),
                F::InnerWall => r("inner_wall_flow_ratio"),
                F::OverhangWall => r("overhang_flow_ratio"),
                F::SparseInfill => r("sparse_infill_flow_ratio"),
                F::InternalSolid => r("internal_solid_infill_flow_ratio"),
                F::GapFill => r("gap_fill_flow_ratio"),
                F::Support => r("support_flow_ratio"),
                F::SupportInterface => r("support_interface_flow_ratio"),
                _ => 1.0,
            };
            if first_layer && !matches!(feature, F::Brim | F::Skirt) {
                v *= r("first_layer_flow_ratio");
            }
        }
        v
    }

    /// Pressure advance for a slot when enabled, else 0.
    pub fn pressure_advance_for(&self, slot: u8) -> f64 {
        if self.enable_pressure_advance {
            Self::per_slot(&self.pressure_advance, slot, 0.0)
        } else {
            0.0
        }
    }

    /// `ensure_vertical_shell_thickness` is `ensure_all` (Orca's default and what its profiles use).
    pub fn ensure_all_shells(&self) -> bool {
        matches!(self.raw.get("ensure_vertical_shell_thickness"), Some(Value::String(s)) if s == "ensure_all")
    }

    /// `wall_generator` is `arachne`: variable-width walls. Fixed-width walls stay the default when the
    /// setting is absent.
    pub fn arachne_walls(&self) -> bool {
        ["perimeter_generator", "wall_generator"]
            .iter()
            .any(|k| matches!(self.raw.get(*k), Some(Value::String(s)) if s == "arachne" || is_aegis(s)))
    }

    /// True when `print_sequence` is `by object`: each object prints completely before the next.
    pub fn print_by_object(&self) -> bool {
        matches!(self.raw.get("print_sequence"), Some(Value::String(s)) if s == "by object")
    }

    /// Support on layers of its own height (`independent_support_layer_height`); on unless the
    /// settings turn it off, as in Orca.
    pub fn independent_support_layer_height(&self) -> bool {
        !self.raw.contains_key("independent_support_layer_height")
            || crate::firmware::truthy(self, "independent_support_layer_height")
    }

    /// A numeric setting from the raw map (a number or a numeric string, or the first entry of a list).
    pub fn raw_number(&self, key: &str, default: f64) -> f64 {
        let v = match self.raw.get(key) {
            Some(Value::Array(a)) => a.first(),
            other => other,
        };
        match v {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(default),
            // A percent ("80%") reads as its number.
            Some(Value::String(t)) => t.trim().trim_end_matches('%').trim().parse().unwrap_or(default),
            _ => default,
        }
    }

    /// Axis-aligned bed rectangle `(min_x, min_y, max_x, max_y)` in mm.
    pub fn bed_rect(&self) -> [f64; 4] {
        let mut r = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for p in &self.printable_area {
            r[0] = r[0].min(p[0]);
            r[1] = r[1].min(p[1]);
            r[2] = r[2].max(p[0]);
            r[3] = r[3].max(p[1]);
        }
        r
    }
}

/// A boolean as `true`, `"1"`, `1`, or Orca's one-element list of those.
fn flag(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => Some(s == "1" || s == "true"),
        Value::Number(n) => n.as_f64().map(|n| n != 0.0),
        Value::Array(a) => a.first().and_then(flag),
        _ => None,
    }
}

/// Keys the engine reads. Others in an override are reported as unsupported.
pub const READ_KEYS: &[&str] = &[
    "raft_layers",
    "raft_contact_distance",
    "raft_expansion",
    "raft_first_layer_density",
    "raft_first_layer_expansion",
    "ensure_vertical_shell_thickness",
    "print_sequence",
    "extruder_clearance_radius",
    "extruder_clearance_height_to_rod",
    "extruder_clearance_height_to_lid",
    "layer_height",
    "initial_layer_print_height",
    "wall_loops",
    "wall_sequence",
    "only_one_wall_first_layer",
    "top_shell_thickness",
    "bottom_shell_thickness",
    "top_shell_layers",
    "bottom_shell_layers",
    "sparse_infill_density",
    "sparse_infill_pattern",
    "line_width",
    "infill_wall_overlap",
    "top_bottom_infill_wall_overlap",
    "top_surface_density",
    "bottom_surface_density",
    "extra_solid_infills",
    "small_area_infill_flow_compensation",
    "small_area_infill_flow_compensation_model",
    "mmu_segmented_region_max_width",
    "mmu_segmented_region_interlocking_depth",
    "interface_shells",
    "sparse_infill_rotate_template",
    "solid_infill_rotate_template",
    "gcode_add_line_number",
    "notes",
    "change_extrusion_role_gcode",
    "filament_change_extrusion_role_gcode",
    "process_change_extrusion_role_gcode",
    "brim_width",
    "brim_type",
    "sparse_infill_anchor_max",
    "infill_anchor",
    "infill_anchor_max",
    "sparse_infill_anchor",
    "skirt_loops",
    "skirt_distance",
    "skirt_height",
    "seam_position",
    "enable_support",
    "support_type",
    "support_threshold_angle",
    "support_on_build_plate_only",
    "support_object_xy_distance",
    "support_top_z_distance",
    "support_bottom_z_distance",
    "support_interface_top_layers",
    "support_interface_bottom_layers",
    "support_base_pattern",
    "support_base_pattern_spacing",
    "support_interface_pattern",
    "support_interface_spacing",
    "support_speed",
    "support_interface_speed",
    "support_style",
    "support_threshold_overlap",
    "support_remove_small_overhang",
    "support_object_first_layer_gap",
    "support_expansion",
    "support_critical_regions_only",
    "support_interface_not_for_body",
    "support_bottom_interface_spacing",
    "support_angle",
    "support_interface_loop_pattern",
    "support_ironing",
    "support_ironing_flow",
    "support_ironing_spacing",
    "support_ironing_pattern",
    "enforce_support_layers",
    "bridge_no_support",
    "small_support_perimeter_speed",
    "small_support_perimeter_threshold",
    "support_flow_ratio",
    "support_interface_flow_ratio",
    "support_line_width",
    "tree_support_angle_slow",
    "tree_support_auto_brim",
    "tree_support_branch_angle",
    "tree_support_branch_angle_organic",
    "tree_support_branch_diameter",
    "tree_support_branch_diameter_angle",
    "tree_support_branch_diameter_organic",
    "tree_support_branch_distance",
    "tree_support_branch_distance_organic",
    "tree_support_brim_width",
    "tree_support_tip_diameter",
    "tree_support_top_rate",
    "tree_support_wall_count",
    "nozzle_diameter",
    "nozzle_temperature",
    "hot_plate_temp",
    "filament_diameter",
    "filament_density",
    "filament_cost",
    "printable_area",
    "printable_height",
    "gcode_flavor",
    "outer_wall_speed",
    "inner_wall_speed",
    "sparse_infill_speed",
    "internal_solid_infill_speed",
    "top_surface_speed",
    "initial_layer_speed",
    "initial_layer_infill_speed",
    "travel_speed",
    "bridge_speed",
    "gap_infill_speed",
    "internal_bridge_speed",
    "bridge_flow",
    "thick_bridges",
    "overhang_1_4_speed",
    "overhang_2_4_speed",
    "overhang_3_4_speed",
    "overhang_4_4_speed",
    "enable_overhang_speed",
    "retraction_length",
    "retraction_speed",
    "retraction_minimum_travel",
    "z_hop",
    "retract_lift_above",
    "retract_lift_below",
    "deretraction_speed",
    "retract_restart_extra",
    "wipe",
    "wipe_distance",
    "fan_min_speed",
    "fan_max_speed",
    "fan_cooling_layer_time",
    "close_fan_the_first_x_layers",
    "overhang_fan_speed",
    "enable_overhang_bridge_fan",
    "slow_down_for_layer_cooling",
    "slow_down_layer_time",
    "slow_down_min_speed",
    "nozzle_temperature_initial_layer",
    "hot_plate_temp_initial_layer",
    "filament_flow_ratio",
    "enable_pressure_advance",
    "pressure_advance",
];

/// Fuzzy skin settings (`fuzzy.rs` reads them from the raw map). An object's own value is applied, so an
/// object setting with one of these keys is not reported as unsupported. A height range does not carry them.
pub const FUZZY_KEYS: &[&str] = &[
    "fuzzy_skin",
    "fuzzy_skin_mode",
    "fuzzy_skin_thickness",
    "fuzzy_skin_point_distance",
    "fuzzy_skin_first_layer",
    "fuzzy_skin_noise_type",
    "fuzzy_skin_scale",
    "fuzzy_skin_octaves",
    "fuzzy_skin_persistence",
    "fuzzy_skin_ripple_offset",
    "fuzzy_skin_ripples_per_layer",
    "fuzzy_skin_layers_between_ripple_offset",
];

/// The printer retraction settings a filament may override with its own `filament_` value (Orca 2.4.2
/// PrintConfig.cpp `filament_extruder_override_keys`).
pub const FILAMENT_OVERRIDES: [&str; 16] = [
    "retraction_length",
    "z_hop",
    "z_hop_types",
    "retract_lift_above",
    "retract_lift_below",
    "retract_lift_enforce",
    "retraction_speed",
    "deretraction_speed",
    "retract_restart_extra",
    "retraction_minimum_travel",
    "wipe_distance",
    "retract_when_changing_layer",
    "wipe",
    "retract_before_wipe",
    "long_retractions_when_cut",
    "retraction_distances_when_cut",
];

/// Keys a height range may change: they only touch how a layer is written or
/// how its walls are laid out, not the geometry other layers depend on.
pub const RANGE_KEYS: &[&str] = &[
    "wall_loops",
    "nozzle_temperature",
    "filament_flow_ratio",
    "enable_pressure_advance",
    "pressure_advance",
    "outer_wall_speed",
    "inner_wall_speed",
    "sparse_infill_speed",
    "internal_solid_infill_speed",
    "top_surface_speed",
    "travel_speed",
    "retraction_length",
    "retraction_speed",
    "retraction_minimum_travel",
];

fn bad(key: &'static str) -> Error {
    Error::Config {
        key,
        reason: "unexpected value".to_owned(),
    }
}

/// Density used when the config has none, g/cm3 (PLA).
pub const DEFAULT_DENSITY: f64 = 1.24;

/// Automatic line width as a multiple of the nozzle diameter.
pub const AUTO_WIDTH_RATIO: f64 = 1.125;

/// What a width of 0 means for the top surface and supports: the nozzle diameter itself (Orca's and Bambu
/// Studio's `Flow::auto_extrusion_width`).
pub const AUTO_NOZZLE_WIDTH_RATIO: f64 = 1.0;

/// A line width: millimeters, a percentage of the nozzle ("110%"), or 0 for automatic.
fn width(v: &Value, nozzle: f64) -> Option<f64> {
    width_auto(v, nozzle, AUTO_WIDTH_RATIO)
}

/// [`width`] with the factor of the nozzle that a 0 stands for.
fn width_auto(v: &Value, nozzle: f64, auto: f64) -> Option<f64> {
    let percent = match v {
        Value::String(s) => s.trim().ends_with('%'),
        Value::Array(a) => a
            .first()
            .and_then(Value::as_str)
            .is_some_and(|s| s.trim().ends_with('%')),
        _ => false,
    };
    let n = num(v)?;
    Some(if n == 0.0 {
        nozzle * auto
    } else if percent {
        nozzle * n / 100.0
    } else {
        n
    })
}

/// A number, a numeric string, or a percent string ("15%"): a number of mm, or a percent of `base`
/// (Orca's `FloatOrPercent`).
pub(crate) fn float_or_percent(v: &Value, base: f64) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            match t.strip_suffix('%') {
                Some(p) => p.trim().parse::<f64>().ok().map(|p| p * 0.01 * base),
                None => t.parse().ok(),
            }
        }
        Value::Array(a) => a.first().and_then(|x| float_or_percent(x, base)),
        _ => None,
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('%').trim().parse().ok(),
        Value::Array(a) => a.first().and_then(num),
        _ => None,
    }
}

/// A list of numbers, a single number, or Orca's comma-separated string.
fn nums(v: &Value) -> Option<Vec<f64>> {
    match v {
        Value::Array(a) => a.iter().map(num).collect(),
        Value::String(s) if s.contains(',') => s.split(',').map(|p| p.trim().parse().ok()).collect(),
        other => num(other).map(|n| vec![n]),
    }
}

/// `[[x, y], ...]` or Orca's `["0x0", "256x0", ...]`.
fn points(v: &Value) -> Option<Vec<[f64; 2]>> {
    let Value::Array(a) = v else { return None };
    a.iter()
        .map(|p| match p {
            Value::Array(xy) => Some([num(xy.first()?)?, num(xy.get(1)?)?]),
            Value::String(s) => {
                let (x, y) = s.split_once('x')?;
                Some([x.trim().parse().ok()?, y.trim().parse().ok()?])
            }
            _ => None,
        })
        .collect()
}

/// `aegis` is the wall generator value for our implementation of preFlight's Athena method; `athena` stays a
/// permanent alias that reads the same.
pub(crate) fn is_aegis(value: &str) -> bool {
    value == "aegis" || value == "athena"
}

/// aegis (`wall_generator` or `perimeter_generator` = `aegis`, or the alias `athena`): the center distance of the outer bead to the
/// first inner one and of inner beads, mm (preFlight `PreciseWalls`). A spacing is the bead width less the
/// overlap, and a percent overlap is of twice the layer height, so the default 10.73 percent is the
/// (1 - pi/4) h that Orca's flow spacing leaves. `external_perimeter_overlap` only counts with two walls or
/// more and `perimeter_perimeter_overlap` (80 percent at most) with three or more; the outer to first inner
/// spacing averages the two beads' spacings. A bare number is mm; the spacing never goes under a fifth of
/// the width. None for any other generator.
pub(crate) fn athena_spacing(
    cfg: &PrintConfig,
    ext: f64,
    inner: f64,
    layer_height: f64,
) -> Option<(f64, f64)> {
    let generator = ["perimeter_generator", "wall_generator"]
        .iter()
        .find_map(|k| match cfg.raw.get(*k) {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        });
    if !generator.is_some_and(is_aegis) {
        return None;
    }
    // preFlight's key names first, then the ones this engine used before.
    let overlap = |keys: &[&str]| keys.iter().find_map(|k| cfg.raw.get(*k));
    let standard = (1.0 - std::f64::consts::FRAC_PI_4) * 50.0;
    let spacing = |width: f64, ov: Option<&Value>, cap: f64| -> f64 {
        let amount = match ov {
            Some(Value::String(t)) if t.trim().ends_with('%') => {
                let p = t
                    .trim()
                    .trim_end_matches('%')
                    .trim()
                    .parse::<f64>()
                    .unwrap_or(standard);
                layer_height * (p.min(cap) * 2.0 / 100.0)
            }
            Some(Value::String(t)) => t.trim().parse::<f64>().unwrap_or(0.0).min(width),
            Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0).min(width),
            _ => layer_height * (standard * 2.0 / 100.0),
        };
        (width - amount).max(width * 0.2)
    };
    let walls = cfg.wall_loops;
    let ext_ov =
        overlap(&["external_perimeter_overlap", "ext_perimeter_perimeter_overlap"]).filter(|_| walls >= 2);
    let int_ov = overlap(&["perimeter_perimeter_overlap"]).filter(|_| walls >= 3);
    Some((
        f64::midpoint(spacing(ext, ext_ov, 100.0), spacing(inner, ext_ov, 100.0)),
        spacing(inner, int_ov, 80.0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_schema_defaults() {
        // Every process default of the schema parses, and a config that leaves everything out is the same
        // as the defaults any host starts from.
        let v = process_defaults();
        let mut c = PrintConfig::builtin();
        c.apply_value(&v).unwrap();
        let parsed = PrintConfig::from_value(&serde_json::json!({})).unwrap();
        assert_eq!(format!("{:?}", PrintConfig::default()), format!("{parsed:?}"));
        assert_eq!(format!("{c:?}"), format!("{parsed:?}"));
        let Value::Object(map) = v else {
            panic!("not an object")
        };
        assert!(map.len() > 300, "{}", map.len());
        for (k, want) in &map {
            if !crate::preflight::is_never_imported(k) {
                assert_eq!(parsed.raw.get(k), Some(want), "{k}");
            }
        }
        // The values the schema and the app show for the visible defaults.
        assert_eq!(parsed.seam_position, SeamPosition::Aligned);
        assert!(parsed.arachne_walls());
        // The default wall generator is aegis, and the old name athena reads the same.
        assert_eq!(
            parsed.raw.get("wall_generator"),
            Some(&Value::String("aegis".into()))
        );
        assert!(athena_spacing(&parsed, 0.42, 0.45, 0.2).is_some());
        let old = PrintConfig::from_value(&serde_json::json!({"wall_generator": "athena"})).unwrap();
        assert!(old.arachne_walls() && athena_spacing(&old, 0.42, 0.45, 0.2).is_some());
        let arachne = PrintConfig::from_value(&serde_json::json!({"wall_generator": "arachne"})).unwrap();
        assert!(arachne.arachne_walls() && athena_spacing(&arachne, 0.42, 0.45, 0.2).is_none());
    }

    #[test]
    fn reads_typed_and_orca_forms() {
        let c = PrintConfig::from_json(
            br#"{"layer_height":0.28,"sparse_infill_density":"20%","nozzle_diameter":["0.6"],
                "printable_area":["0x0","220x0","220x220","0x220"],"gcode_flavor":"klipper",
                "wall_loops":3,"brim_type":"no_brim"}"#,
        )
        .unwrap();
        assert!((c.layer_height - 0.28).abs() < 1e-9);
        assert!((c.sparse_infill_density - 20.0).abs() < 1e-9);
        assert!((c.nozzle_diameter - 0.6).abs() < 1e-9);
        assert!((c.printable_area[1][0] - 220.0).abs() < 1e-9);
        assert_eq!(c.gcode_flavor, GcodeFlavor::Klipper);
        assert_eq!(c.wall_loops, 3);
        assert!(c.brim_width.abs() < 1e-9);
    }

    #[test]
    fn line_width_auto_and_percent() {
        let auto = PrintConfig::from_json(br#"{"line_width":"0","nozzle_diameter":[0.4]}"#).unwrap();
        assert!((auto.line_width - 0.45).abs() < 1e-9);
        let zero = PrintConfig::from_json(br#"{"line_width":0,"nozzle_diameter":[0.6]}"#).unwrap();
        assert!((zero.line_width - 0.675).abs() < 1e-9);
        let pct = PrintConfig::from_json(br#"{"line_width":"110%","nozzle_diameter":["0.4"]}"#).unwrap();
        assert!((pct.line_width - 0.44).abs() < 1e-9);
        let mm = PrintConfig::from_json(br#"{"line_width":"0.45"}"#).unwrap();
        assert!((mm.line_width - 0.45).abs() < 1e-9);
    }

    #[test]
    fn fuzzy_skin_and_raft_sizes_keep_to_their_ranges() {
        use serde_json::json;
        // A point distance of 0 or -1 never finished; a huge thickness or raft expansion crashed the slice.
        for (key, bad, ok) in [
            (
                "fuzzy_skin_point_distance",
                [json!(0), json!(-1), json!(6)],
                [json!(0.01), json!(0.3), json!(5)],
            ),
            (
                "fuzzy_skin_thickness",
                [json!(1e9), json!("inf"), json!(-0.1)],
                [json!(0), json!(0.2), json!(2)],
            ),
            (
                "raft_expansion",
                [json!(1e9), json!("inf"), json!(-1)],
                [json!(0), json!(1.5), json!(100)],
            ),
            (
                "raft_first_layer_expansion",
                [json!(1e9), json!("inf"), json!(-1)],
                [json!(0), json!(2), json!(100)],
            ),
        ] {
            for v in bad {
                let err = PrintConfig::from_value(&json!({ key: v })).unwrap_err();
                assert!(err.to_string().contains(key), "{key} {v}: {err}");
            }
            for v in ok {
                assert!(PrintConfig::from_value(&json!({ key: v })).is_ok(), "{key} {v}");
            }
        }
    }

    #[test]
    fn the_prime_tower_rotation_is_a_number() {
        use serde_json::json;
        // An infinite rotation never finished slicing on a two-extruder plate.
        for v in [json!("inf"), json!("nan"), json!(1e9), json!(-4000)] {
            let err = PrintConfig::from_value(&json!({ "wipe_tower_rotation_angle": v })).unwrap_err();
            assert!(
                err.to_string().contains("wipe_tower_rotation_angle"),
                "{v}: {err}"
            );
        }
        // Angles past a turn wrap around, as they do in Orca.
        for v in [json!(0), json!(-90), json!("45"), json!(720)] {
            assert!(
                PrintConfig::from_value(&json!({ "wipe_tower_rotation_angle": v })).is_ok(),
                "{v}"
            );
        }
    }

    #[test]
    fn the_prime_tower_brim_is_held_to_a_bed_sized_width() {
        use serde_json::json;
        // An infinite tower brim never finished slicing on a two-extruder plate.
        for v in [json!("inf"), json!(1e9), json!(101), json!(-2)] {
            let err = PrintConfig::from_value(&json!({ "prime_tower_brim_width": v })).unwrap_err();
            assert!(err.to_string().contains("prime_tower_brim_width"), "{v}: {err}");
        }
        // -1 is Orca's automatic width.
        for v in [json!(-1), json!(0), json!(3), json!("10"), json!(100)] {
            assert!(
                PrintConfig::from_value(&json!({ "prime_tower_brim_width": v })).is_ok(),
                "{v}"
            );
        }
    }

    #[test]
    fn tolerances_and_overlaps_turn_away_only_nonsense() {
        use serde_json::json;
        // Each of these crashed the slice at 1e9 or "inf" (overflow in the scaled outlines or the
        // extrusion total).
        for (key, ok) in [
            ("internal_bridge_flow", [json!(0), json!(1.2), json!(2)]),
            ("resolution", [json!(0), json!(0.0125), json!(10)]),
            ("slice_closing_radius", [json!(0), json!(0.049), json!(10)]),
            ("min_feature_size", [json!(0), json!("25%"), json!(500)]),
            (
                "top_bottom_infill_wall_overlap",
                [json!(-100), json!("25%"), json!(100)],
            ),
        ] {
            for v in [json!(1e9), json!(-1e9), json!("inf")] {
                let err = PrintConfig::from_value(&json!({ key: v })).unwrap_err();
                assert!(err.to_string().contains(key), "{key} {v}: {err}");
            }
            for v in ok {
                assert!(PrintConfig::from_value(&json!({ key: v })).is_ok(), "{key} {v}");
            }
        }
    }

    #[test]
    fn surface_densities_keep_to_orcas_ranges() {
        use serde_json::json;
        // A bottom density of 1e-6 spread the lines past the scaled range and crashed; a foot density of
        // 1e9 squeezed them to nothing and never finished.
        for (key, bad, ok) in [
            (
                "bottom_surface_density",
                [json!(1e-6), json!(9), json!(101), json!("inf")],
                [json!(10), json!("80%"), json!(100)],
            ),
            (
                "elefant_foot_layers_density",
                [json!(1e9), json!(49), json!(-1), json!("nan")],
                [json!(50), json!("75%"), json!(100)],
            ),
            (
                "top_surface_density",
                [json!(1e-6), json!(0.5), json!(101), json!(-1)],
                [json!(0), json!(1), json!("100%")],
            ),
        ] {
            for v in bad {
                let err = PrintConfig::from_value(&json!({ key: v })).unwrap_err();
                assert!(err.to_string().contains(key), "{key} {v}: {err}");
            }
            for v in ok {
                assert!(PrintConfig::from_value(&json!({ key: v })).is_ok(), "{key} {v}");
            }
        }
    }

    #[test]
    fn compensations_turn_away_only_nonsense() {
        use serde_json::json;
        // These overflowed the scaled outlines (or ran for minutes at 1000 mm) instead of slicing.
        for key in [
            "elefant_foot_compensation",
            "xy_hole_compensation",
            "xy_contour_compensation",
        ] {
            for bad in [json!("inf"), json!(1e9), json!(1000), json!(-6)] {
                let err = PrintConfig::from_value(&json!({ key: bad })).unwrap_err();
                assert!(err.to_string().contains(key), "{key} {bad}: {err}");
            }
            for ok in [json!(0.15), json!("-0.1"), json!(0), json!(5)] {
                assert!(PrintConfig::from_value(&json!({ key: ok })).is_ok(), "{key} {ok}");
            }
        }
    }

    #[test]
    fn flow_ratios_keep_to_orcas_ranges() {
        use serde_json::json;
        // An infinite print flow ratio overflowed the extrusion total and crashed the G-code writer.
        for (key, lo) in [
            ("print_flow_ratio", 0.01),
            ("top_solid_infill_flow_ratio", 0.0),
            ("first_layer_flow_ratio", 0.0),
            ("support_interface_flow_ratio", 0.0),
        ] {
            for bad in [json!("inf"), json!(1e9), json!(2.5), json!(lo - 0.01)] {
                let err = PrintConfig::from_value(&json!({ key: bad })).unwrap_err();
                assert!(err.to_string().contains(key), "{key} {bad}: {err}");
            }
            for ok in [json!(0.95), json!("1.05"), json!(2), json!(lo)] {
                assert!(PrintConfig::from_value(&json!({ key: ok })).is_ok(), "{key} {ok}");
            }
        }
    }

    #[test]
    fn feature_line_widths_are_range_checked_like_line_width() {
        use serde_json::json;
        // A width this wide overflowed the scaled geometry and crashed the slice.
        for key in [
            "outer_wall_line_width",
            "inner_wall_line_width",
            "sparse_infill_line_width",
            "internal_solid_infill_line_width",
            "top_surface_line_width",
            "support_line_width",
            "initial_layer_line_width",
        ] {
            for bad in [json!(1e9), json!("inf"), json!("5000%")] {
                let err = PrintConfig::from_value(&json!({ key: bad })).unwrap_err();
                assert!(err.to_string().contains(key), "{key} {bad}: {err}");
            }
            for ok in [json!(0.42), json!(0), json!("110%")] {
                assert!(PrintConfig::from_value(&json!({ key: ok })).is_ok(), "{key} {ok}");
            }
        }
    }

    #[test]
    fn reads_support_style_and_tree_keys() {
        let c = PrintConfig::from_json(
            br#"{"support_style":"tree_hybrid","tree_support_branch_angle":"35","tree_support_wall_count":2,
                "tree_support_auto_brim":"0","support_threshold_overlap":"60%"}"#,
        )
        .unwrap();
        assert_eq!(c.support.style, SupportStyle::TreeHybrid);
        assert!((c.support.tree_settings.branch_angle - 35.0).abs() < 1e-9);
        assert_eq!(c.support.tree_settings.wall_count, 2);
        assert!(!c.support.tree_settings.auto_brim);
        assert!((c.support.threshold_overlap - 60.0).abs() < 1e-9);
        // OrcaSlicer's defaults.
        let d = PrintConfig::default().support.tree_settings;
        assert!((d.branch_diameter - 5.0).abs() < 1e-9 && (d.branch_diameter_organic - 2.0).abs() < 1e-9);
        assert!((d.tip_diameter - 0.8).abs() < 1e-9 && (d.brim_width - 3.0).abs() < 1e-9);
        assert!(PrintConfig::from_json(br#"{"support_style":"forest"}"#).is_err());
        // Orca writes `organic`; the older `tree_organic` still reads.
        for v in ["organic", "tree_organic"] {
            let c = PrintConfig::from_json(format!(r#"{{"support_style":"{v}"}}"#).as_bytes()).unwrap();
            assert_eq!(c.support.style, SupportStyle::TreeOrganic);
        }
        assert!(PrintConfig::from_json(br#"{"tree_support_branch_angle":120}"#).is_err());
    }

    #[test]
    fn support_gaps_follow_the_layer_height_unless_given() {
        let gaps = |j: &[u8]| {
            let c = PrintConfig::from_json(j).unwrap();
            (c.support.top_z_distance, c.support.bottom_z_distance)
        };
        assert_eq!(gaps(br#"{"layer_height":0.08}"#), (0.08, 0.08));
        assert_eq!(gaps(br#"{"layer_height":0.28}"#), (0.2, 0.2));
        assert_eq!(
            gaps(br#"{"layer_height":0.12,"support_top_z_distance":"auto","support_bottom_z_distance":0.3}"#),
            (0.12, 0.3)
        );
        assert_eq!(
            gaps(br#"{"layer_height":0.08,"support_top_z_distance":0.2}"#),
            (0.2, 0.08)
        );
    }

    #[test]
    fn rejects_out_of_range() {
        assert!(PrintConfig::from_json(br#"{"layer_height":5}"#).is_err());
    }
}
