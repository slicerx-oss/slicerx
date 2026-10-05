// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The motion model behind the time estimate: what a Marlin style planner does
//! with the moves. Every move has a distance, a top speed and an acceleration;
//! the speed at each junction is limited by the axis jerk limits (or a junction
//! deviation) and by what the neighbors can reach, in a backward and a forward
//! pass; each move then takes the time of its trapezoid. Speeds are mm/s.

use crate::config::PrintConfig;
use crate::fm::Fm;
use crate::output::Feature;

/// One straight move: axis distances in mm, the requested speed, and the acceleration to use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Move {
    pub d: [f64; 4],
    pub feed: f64,
    pub accel: f64,
    /// X and Y jerk for this move, mm/s; 0 uses the machine's.
    pub jerk_xy: f64,
}

/// The machine's limits, X, Y, Z, E order.
#[derive(Debug, Clone, PartialEq)]
pub struct Limits {
    pub max_speed: [f64; 4],
    pub max_accel: [f64; 4],
    pub jerk: [f64; 4],
    /// Marlin style junction deviation in mm; 0 uses the jerk limits.
    pub junction_deviation: f64,
}

/// A limit read as a number from the first entry of a list, or a scalar.
pub fn raw_f(cfg: &PrintConfig, key: &str) -> Option<f64> {
    match cfg.raw.get(key)? {
        serde_json::Value::Array(a) => a.first().and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        }),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        v => v.as_f64(),
    }
}

impl Limits {
    /// The machine limits of a profile; None when it carries none (then the plain estimate is used).
    pub fn from_config(cfg: &PrintConfig) -> Option<Self> {
        raw_f(cfg, "machine_max_acceleration_x")?;
        let four = |prefix: &str, fallback: [f64; 4]| {
            let mut out = fallback;
            for (o, axis) in out.iter_mut().zip(["x", "y", "z", "e"]) {
                if let Some(v) = raw_f(cfg, &format!("{prefix}_{axis}")).filter(|v| *v > 0.0) {
                    *o = v;
                }
            }
            out
        };
        Some(Self {
            max_speed: four("machine_max_speed", [500.0, 500.0, 12.0, 120.0]),
            max_accel: four("machine_max_acceleration", [1000.0, 1000.0, 500.0, 5000.0]),
            jerk: four("machine_max_jerk", [8.0, 8.0, 0.4, 2.5]),
            junction_deviation: raw_f(cfg, "machine_max_junction_deviation")
                .unwrap_or(0.0)
                .max(0.0),
        })
    }
}

/// A `FloatOrPercent` setting in absolute terms (Orca's `get_abs_value`): a number is as it is, a percent
/// is that share of the setting `base` names. `None` when the key is absent.
fn abs_value(cfg: &PrintConfig, key: &str, base: f64) -> Option<f64> {
    let v = match cfg.raw.get(key)? {
        serde_json::Value::Array(a) => a.first()?,
        v => v,
    };
    crate::config::float_or_percent(v, base)
}

/// `key` as a number, or Orca's default when the profile does not carry it.
fn num_or(cfg: &PrintConfig, key: &str, default: f64) -> f64 {
    raw_f(cfg, key).unwrap_or(default)
}

/// Orca's `is_bridge`: bridges, internal bridges and overhanging walls.
fn bridge_like(feature: Feature) -> bool {
    matches!(
        feature,
        Feature::Bridge | Feature::InternalBridge | Feature::OverhangWall
    )
}

/// The acceleration `GCode::_extrude` asks for a path of `feature`, mm/s2, or 0 when `default_acceleration`
/// is not above 0 (then none is written): the first layer's, else the bridge, sparse, solid, outer, inner
/// or top surface one when it is above 0, else the default. Percentages follow Orca's `ratio_over`.
pub fn gcode_accel(cfg: &PrintConfig, feature: Feature, first_layer: bool) -> f64 {
    let default = num_or(cfg, "default_acceleration", 500.0);
    if default <= 0.0 {
        return 0.0;
    }
    let outer = num_or(cfg, "outer_wall_acceleration", 500.0);
    let initial = num_or(cfg, "initial_layer_acceleration", 300.0);
    let bridge = abs_value(cfg, "bridge_acceleration", outer).unwrap_or(0.5 * outer);
    let sparse = abs_value(cfg, "sparse_infill_acceleration", default).unwrap_or(default);
    let solid = abs_value(cfg, "internal_solid_infill_acceleration", default).unwrap_or(default);
    let a = if first_layer && initial > 0.0 {
        initial
    } else if bridge > 0.0 && bridge_like(feature) {
        bridge
    } else if sparse > 0.0 && feature == Feature::SparseInfill {
        sparse
    } else if solid > 0.0 && feature == Feature::InternalSolid {
        solid
    } else if outer > 0.0 && feature == Feature::OuterWall {
        outer
    } else if num_or(cfg, "inner_wall_acceleration", 10000.0) > 0.0 && feature == Feature::InnerWall {
        num_or(cfg, "inner_wall_acceleration", 10000.0)
    } else if num_or(cfg, "top_surface_acceleration", 500.0) > 0.0 && feature == Feature::TopSurface {
        num_or(cfg, "top_surface_acceleration", 500.0)
    } else {
        default
    };
    (a + 0.5).floor()
}

/// The X and Y jerk `GCode::_extrude` asks for, mm/s, or 0 when `default_jerk` is not above 0.
pub fn gcode_jerk(cfg: &PrintConfig, feature: Feature, first_layer: bool) -> f64 {
    let default = num_or(cfg, "default_jerk", 0.0);
    if default <= 0.0 {
        return 0.0;
    }
    let get = |k: &str| num_or(cfg, k, 9.0);
    let infill = matches!(
        feature,
        Feature::Bridge
            | Feature::InternalBridge
            | Feature::SparseInfill
            | Feature::InternalSolid
            | Feature::TopSurface
            | Feature::BottomSurface
            | Feature::Ironing
    );
    if first_layer && get("initial_layer_jerk") > 0.0 {
        get("initial_layer_jerk")
    } else if feature == Feature::OuterWall && get("outer_wall_jerk") > 0.0 {
        get("outer_wall_jerk")
    } else if feature == Feature::InnerWall && get("inner_wall_jerk") > 0.0 {
        get("inner_wall_jerk")
    } else if feature == Feature::TopSurface && get("top_surface_jerk") > 0.0 {
        get("top_surface_jerk")
    } else if infill && get("infill_jerk") > 0.0 {
        get("infill_jerk")
    } else {
        default
    }
}

/// The acceleration a print move gets in the time estimate: the G-code's, else the machine's limits.
pub fn feature_accel(cfg: &PrintConfig, feature: Feature, first_layer: bool) -> f64 {
    let own = Some(gcode_accel(cfg, feature, first_layer)).filter(|v| *v > 0.0);
    let cap = raw_f(cfg, "machine_max_acceleration_extruding").filter(|v| *v > 0.0);
    let a = own.or(cap).unwrap_or(5000.0);
    cap.map_or(a, |c| a.min(c))
}

/// The jerk (X and Y) a print move gets in the time estimate, mm/s.
pub fn feature_jerk(cfg: &PrintConfig, feature: Feature, first_layer: bool) -> Option<f64> {
    Some(gcode_jerk(cfg, feature, first_layer)).filter(|v| *v > 0.0)
}

/// The acceleration of travel moves.
pub fn travel_accel(cfg: &PrintConfig) -> f64 {
    let own = raw_f(cfg, "travel_acceleration").filter(|v| *v > 0.0);
    let default = raw_f(cfg, "default_acceleration").filter(|v| *v > 0.0);
    let cap = raw_f(cfg, "machine_max_acceleration_travel").filter(|v| *v > 0.0);
    let a = own.or(default).or(cap).unwrap_or(5000.0);
    cap.map_or(a, |c| a.min(c))
}

/// The acceleration of retract and unretract moves.
pub fn retract_accel(cfg: &PrintConfig) -> f64 {
    raw_f(cfg, "machine_max_acceleration_retracting")
        .filter(|v| *v > 0.0)
        .unwrap_or(1500.0)
}

/// True when the profile sets accelerations the G-code should carry.
pub fn accel_enabled(cfg: &PrintConfig) -> bool {
    [
        "default_acceleration",
        "outer_wall_acceleration",
        "inner_wall_acceleration",
        "initial_layer_acceleration",
        "top_surface_acceleration",
        "sparse_infill_acceleration",
    ]
    .iter()
    .any(|k| raw_f(cfg, k).is_some_and(|v| v > 0.0))
}

/// The acceleration and jerk last written, and the travel acceleration (0: not written yet).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Written {
    pub accel: i64,
    pub jerk: f64,
    pub travel: i64,
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "accelerations and jerk are small"
)]
fn rounded(v: f64) -> i64 {
    v.round() as i64
}

/// A number as C++ streams print it: no trailing zeros, six significant digits.
fn num(v: f64) -> String {
    let t = format!("{v:.6}");
    let t = t.trim_end_matches('0').trim_end_matches('.');
    // Six significant digits at most.
    let digits = t.chars().filter(char::is_ascii_digit).count();
    if digits > 6 {
        let r = format!(
            "{:.*}",
            6usize.saturating_sub(t.split('.').next().map_or(0, str::len)),
            v
        );
        return r.trim_end_matches('0').trim_end_matches('.').to_owned();
    }
    t.to_owned()
}

/// What `GCodeWriter` clamps accelerations and jerk to: the machine limits of the flavors that use them.
#[derive(Debug, Clone, Copy)]
struct Caps {
    accel: i64,
    travel_accel: i64,
    jerk_x: f64,
    jerk_y: f64,
}

fn caps(cfg: &PrintConfig, flavor: crate::config::GcodeFlavor) -> Caps {
    use crate::config::GcodeFlavor;
    // Only the flavors that take the machine's limits clamp to them.
    if !matches!(
        flavor,
        GcodeFlavor::Marlin
            | GcodeFlavor::Marlin2
            | GcodeFlavor::Bambu
            | GcodeFlavor::Klipper
            | GcodeFlavor::RepRapFirmware
    ) {
        return Caps {
            accel: 0,
            travel_accel: 0,
            jerk_x: 0.0,
            jerk_y: 0.0,
        };
    }
    let first = |k: &str| raw_f(cfg, k).unwrap_or(0.0);
    let mut accel = rounded(first("machine_max_acceleration_extruding"));
    if flavor == GcodeFlavor::Klipper {
        for k in ["machine_max_acceleration_x", "machine_max_acceleration_y"] {
            let v = rounded(first(k));
            // `std::min` with the extruding limit, so an extruding limit of 0 stays 0 (no cap).
            if v > 0 {
                accel = accel.min(v);
            }
        }
    }
    Caps {
        accel,
        travel_accel: if separate_travel(flavor) {
            rounded(first("machine_max_acceleration_travel"))
        } else {
            0
        },
        jerk_x: first("machine_max_jerk_x").round(),
        jerk_y: first("machine_max_jerk_y").round(),
    }
}

/// The flavors with an acceleration of their own for travel (`supports_separate_travel_acceleration`).
fn separate_travel(flavor: crate::config::GcodeFlavor) -> bool {
    use crate::config::GcodeFlavor;
    matches!(
        flavor,
        GcodeFlavor::Marlin2 | GcodeFlavor::RepRapFirmware | GcodeFlavor::Repetier
    )
}

#[allow(clippy::cast_precision_loss, reason = "accelerations are small")]
/// `GCodeWriter::set_acceleration_internal`: one acceleration line, or nothing when it is 0 or as written.
fn set_acceleration(set: &LineSettings, travel: bool, accel: i64, state: &mut Written, out: &mut String) {
    use crate::config::GcodeFlavor;
    use std::fmt::Write as _;
    let (flavor, cap) = (set.flavor, set.caps);
    let mut accel = accel;
    if !travel && cap.accel > 0 && accel > cap.accel {
        accel = cap.accel;
    }
    if travel && cap.travel_accel > 0 && accel > cap.travel_accel {
        accel = cap.travel_accel;
    }
    let separate = travel && separate_travel(flavor);
    let last = if separate {
        &mut state.travel
    } else {
        &mut state.accel
    };
    if accel == 0 || accel == *last {
        return;
    }
    *last = accel;
    match flavor {
        GcodeFlavor::Repetier => {
            let _ = writeln!(
                out,
                "{} Y{accel}",
                if separate {
                    format!("M202 X{accel}")
                } else {
                    format!("M201 X{accel}")
                }
            );
        }
        GcodeFlavor::Marlin2 | GcodeFlavor::RepRapFirmware => {
            let _ = writeln!(out, "{}{accel}", if separate { "M204 T" } else { "M204 P" });
        }
        GcodeFlavor::Klipper => {
            let _ = write!(out, "SET_VELOCITY_LIMIT ACCEL={accel}");
            if let Some(f) = set.accel_to_decel {
                let _ = write!(out, " ACCEL_TO_DECEL={}", num(accel as f64 * f / 100.0));
            }
            out.push('\n');
        }
        _ => {
            let _ = writeln!(out, "M204 S{accel}");
        }
    }
}

/// Klipper's `accel_to_decel_factor` when `accel_to_decel_enable` is on (it is by default).
fn accel_to_decel(cfg: &PrintConfig) -> Option<f64> {
    let on = match cfg.raw.get("accel_to_decel_enable") {
        Some(serde_json::Value::Bool(v)) => *v,
        Some(serde_json::Value::String(t)) => t != "0" && !t.eq_ignore_ascii_case("false"),
        Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|v| v != 0.0),
        _ => true,
    };
    on.then(|| cfg.raw_number("accel_to_decel_factor", 50.0))
}

/// `GCodeWriter::set_jerk_xy`: Klipper's square corner velocity, Marlin's `M205`; nothing under 0.01 or when
/// as written. Bambu printers also get the machine's Z and E jerk on the line.
fn set_jerk(set: &LineSettings, jerk: f64, state: &mut Written, out: &mut String) {
    use crate::config::GcodeFlavor;
    use std::fmt::Write as _;
    if jerk < 0.01 || (jerk - state.jerk).abs() < 1e-6 {
        return;
    }
    state.jerk = jerk;
    let (flavor, cap) = (set.flavor, set.caps);
    let clamp = |v: f64, m: f64| if m > 0.0 && v > m { m } else { v };
    match flavor {
        GcodeFlavor::Klipper => {
            let j = clamp(clamp(jerk, cap.jerk_x), cap.jerk_y);
            let _ = writeln!(out, "SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY={}", num(j));
        }
        GcodeFlavor::Cheetah => {
            // Cheetah's motion planner takes the limit in thousandths (CuraEngine's `writeJerk`: `M215`).
            let j = clamp(clamp(jerk, cap.jerk_x), cap.jerk_y) * 1000.0;
            let _ = writeln!(out, "M215 X{} Y{}", num(j), num(j));
        }
        GcodeFlavor::Repetier => {
            // Repetier takes one value for both axes: the lower of the machine's limits.
            let j = clamp(clamp(jerk, cap.jerk_x), cap.jerk_y);
            let _ = writeln!(out, "M207 X{}", num(j));
        }
        _ => {
            let _ = write!(
                out,
                "M205 X{} Y{}",
                num(clamp(jerk, cap.jerk_x)),
                num(clamp(jerk, cap.jerk_y))
            );
            if flavor == GcodeFlavor::Bambu {
                let _ = write!(out, " Z{} E{}", num(set.jerk_z), num(set.jerk_e));
            }
            out.push('\n');
        }
    }
}

#[allow(clippy::cast_precision_loss, reason = "accelerations are small")]
/// `GCodeWriter::set_accel_and_jerk` (Klipper): both on one `SET_VELOCITY_LIMIT` line.
fn set_accel_and_jerk(set: &LineSettings, accel: i64, jerk: f64, state: &mut Written, out: &mut String) {
    use std::fmt::Write as _;
    let cap = set.caps;
    let accel = if cap.accel > 0 && accel > cap.accel {
        cap.accel
    } else {
        accel
    };
    let mut line = String::from("SET_VELOCITY_LIMIT");
    let mut empty = true;
    if accel != 0 && accel != state.accel {
        let _ = write!(line, " ACCEL={accel}");
        if let Some(f) = set.accel_to_decel {
            let _ = write!(line, " ACCEL_TO_DECEL={}", num(accel as f64 * f / 100.0));
        }
        state.accel = accel;
        empty = false;
    }
    let mut j = jerk;
    if cap.jerk_x > 0.0 && j > cap.jerk_x {
        j = cap.jerk_x;
    }
    if cap.jerk_y > 0.0 && j > cap.jerk_y {
        j = cap.jerk_y;
    }
    if j > 0.01 && (j - state.jerk).abs() >= 1e-6 {
        let _ = write!(line, " SQUARE_CORNER_VELOCITY={}", num(j));
        state.jerk = j;
        empty = false;
    }
    if !empty {
        out.push_str(&line);
        out.push('\n');
    }
}

/// What the acceleration and jerk lines read from a profile besides the path: looked up once, since the lines go out
/// before every path.
#[derive(Debug, Clone, Copy)]
struct LineSettings {
    flavor: crate::config::GcodeFlavor,
    caps: Caps,
    accel_to_decel: Option<f64>,
    /// The machine's Z and E jerk, which Bambu's `M205` also carries.
    jerk_z: f64,
    jerk_e: f64,
}

impl LineSettings {
    fn new(cfg: &PrintConfig, flavor: crate::config::GcodeFlavor) -> Self {
        Self {
            flavor,
            caps: caps(cfg, flavor),
            accel_to_decel: accel_to_decel(cfg),
            jerk_z: raw_f(cfg, "machine_max_jerk_z").unwrap_or(0.0),
            jerk_e: raw_f(cfg, "machine_max_jerk_e").unwrap_or(0.0),
        }
    }

    /// The lines for `accel` and `jerk`, or nothing when `state` already holds them (one `SET_VELOCITY_LIMIT` on
    /// Klipper, an acceleration line and a jerk line elsewhere).
    fn lines(&self, travel: bool, accel: i64, jerk: f64, state: &mut Written) -> String {
        let mut s = String::new();
        if self.flavor == crate::config::GcodeFlavor::Klipper {
            set_accel_and_jerk(self, accel, jerk, state, &mut s);
        } else {
            set_acceleration(self, travel, accel, state, &mut s);
            set_jerk(self, jerk, state, &mut s);
        }
        s
    }
}

/// The acceleration and jerk lines of the paths of one layer: the settings are read once, and the acceleration and
/// jerk of each feature and of each kind of travel are worked out the first time a path needs them.
pub struct Motion<'a> {
    cfg: &'a PrintConfig,
    set: LineSettings,
    first_layer: bool,
    /// Per feature (by its id): the acceleration and jerk of its paths.
    print: [Option<(i64, f64)>; 17],
    /// Per kind of travel (see `travel_kind`): the acceleration and jerk.
    travel: [Option<(i64, f64)>; 3],
}

impl<'a> Motion<'a> {
    pub fn new(cfg: &'a PrintConfig, flavor: crate::config::GcodeFlavor, first_layer: bool) -> Self {
        Self {
            cfg,
            set: LineSettings::new(cfg, flavor),
            first_layer,
            print: [None; 17],
            travel: [None; 3],
        }
    }

    /// The lines that set the acceleration and jerk for a path of `feature`, or nothing when `state` already
    /// holds them (`GCode::_extrude`: one `SET_VELOCITY_LIMIT` on Klipper, a print acceleration line and a jerk
    /// line elsewhere).
    pub fn accel_lines(&mut self, feature: Feature, state: &mut Written) -> String {
        let (cfg, first_layer) = (self.cfg, self.first_layer);
        let value = || {
            (
                rounded(gcode_accel(cfg, feature, first_layer)),
                gcode_jerk(cfg, feature, first_layer),
            )
        };
        let (accel, jerk) = match self.print.get_mut(usize::from(feature as u8)) {
            Some(slot) => *slot.get_or_insert_with(value),
            None => value(),
        };
        self.set.lines(false, accel, jerk, state)
    }

    /// The lines before a travel, as `GCode::travel_to` writes them (see `travel_motion`).
    pub fn travel_lines(&mut self, short: bool, next: Feature, state: &mut Written) -> String {
        let (cfg, first_layer) = (self.cfg, self.first_layer);
        let value = || travel_motion(cfg, short, next, first_layer);
        let (accel, jerk) = match self.travel.get_mut(travel_kind(short, next)) {
            Some(slot) => *slot.get_or_insert_with(value),
            None => value(),
        };
        self.set.lines(true, accel, jerk, state)
    }
}

/// The travels `travel_motion` tells apart: 1 for a short one on to an overhanging wall, 2 for a short one on to an
/// outer wall, 0 for the rest.
fn travel_kind(short: bool, next: Feature) -> usize {
    match next {
        Feature::OverhangWall if short => 1,
        Feature::OuterWall if short => 2,
        _ => 0,
    }
}

/// The lines that set the acceleration and jerk for a path of `feature`, or nothing when `state` already
/// holds them (`GCode::_extrude`: one `SET_VELOCITY_LIMIT` on Klipper, a print acceleration line and a jerk
/// line elsewhere).
pub fn accel_lines(
    cfg: &PrintConfig,
    flavor: crate::config::GcodeFlavor,
    feature: Feature,
    first_layer: bool,
    state: &mut Written,
) -> String {
    Motion::new(cfg, flavor, first_layer).accel_lines(feature, state)
}

/// The lines before a travel, as `GCode::travel_to` writes them (see `travel_motion`).
pub fn travel_lines(
    cfg: &PrintConfig,
    flavor: crate::config::GcodeFlavor,
    short: bool,
    next: Feature,
    first_layer: bool,
    state: &mut Written,
) -> String {
    Motion::new(cfg, flavor, first_layer).travel_lines(short, next, state)
}

/// The acceleration and jerk of a travel (0: none). The first layer travels at
/// `initial_layer_travel_acceleration` and `initial_layer_travel_jerk` (a percent of the travel's). Later
/// travels run at the travel acceleration and jerk, except a short one (under the retraction minimum) that
/// goes on to an outer wall or an overhanging wall, which keeps that wall's.
fn travel_motion(cfg: &PrintConfig, short: bool, next: Feature, first_layer: bool) -> (i64, f64) {
    let mut accel = 0i64;
    let mut jerk = 0.0;
    if first_layer {
        let travel = num_or(cfg, "travel_acceleration", 10000.0);
        let initial = abs_value(cfg, "initial_layer_travel_acceleration", travel).unwrap_or(travel);
        if num_or(cfg, "default_acceleration", 500.0) > 0.0 && initial > 0.0 {
            accel = rounded(initial);
        }
        let travel_jerk = num_or(cfg, "travel_jerk", 12.0);
        let initial_jerk = abs_value(cfg, "initial_layer_travel_jerk", travel_jerk).unwrap_or(travel_jerk);
        if num_or(cfg, "default_jerk", 0.0) > 0.0 && initial_jerk > 0.0 {
            jerk = initial_jerk;
        }
    } else {
        if num_or(cfg, "default_acceleration", 500.0) > 0.0 {
            let outer = num_or(cfg, "outer_wall_acceleration", 500.0);
            if next == Feature::OverhangWall && short {
                let bridge = abs_value(cfg, "bridge_acceleration", outer).unwrap_or(0.5 * outer);
                if bridge > 0.0 {
                    accel = rounded(bridge);
                }
            } else if next == Feature::OuterWall && short {
                if outer > 0.0 {
                    accel = rounded(outer);
                }
            } else if num_or(cfg, "travel_acceleration", 10000.0) > 0.0 {
                accel = rounded(num_or(cfg, "travel_acceleration", 10000.0));
            }
        }
        if num_or(cfg, "default_jerk", 0.0) > 0.0 {
            if matches!(next, Feature::OuterWall | Feature::OverhangWall) && short {
                if num_or(cfg, "outer_wall_jerk", 9.0) > 0.0 {
                    jerk = num_or(cfg, "outer_wall_jerk", 9.0);
                }
            } else if num_or(cfg, "travel_jerk", 12.0) > 0.0 {
                jerk = num_or(cfg, "travel_jerk", 12.0);
            }
        }
    }
    (accel, jerk)
}

struct Block {
    dist: f64,
    unit: [f64; 4],
    nominal: f64,
    accel: f64,
    jerk: [f64; 4],
}

fn block(m: &Move, lim: &Limits) -> Option<Block> {
    let dist = (m.d[0] * m.d[0] + m.d[1] * m.d[1] + m.d[2] * m.d[2]).sqrt();
    let dist = if dist > 1e-9 { dist } else { m.d[3].abs() };
    if dist <= 1e-9 {
        return None;
    }
    let unit = m.d.map(|v| v / dist);
    let mut nominal = m.feed.max(0.1);
    let mut accel = m.accel.max(1.0);
    for (i, u) in unit.iter().enumerate() {
        let u = u.abs();
        if u > 1e-9 {
            nominal = nominal.min(lim.max_speed.get(i).copied().unwrap_or(f64::MAX) / u);
            accel = accel.min(lim.max_accel.get(i).copied().unwrap_or(f64::MAX) / u);
        }
    }
    let mut jerk = lim.jerk;
    if m.jerk_xy > 0.0 {
        for j in jerk.iter_mut().take(2) {
            *j = j.min(m.jerk_xy);
        }
    }
    Some(Block {
        dist,
        unit,
        nominal,
        accel,
        jerk,
    })
}

/// The fastest the junction between two moves can be taken.
fn junction(prev: &Block, next: &Block, lim: &Limits) -> f64 {
    let cap = prev.nominal.min(next.nominal);
    if lim.junction_deviation > 0.0 {
        let cos: f64 = prev.unit.iter().zip(&next.unit).take(3).map(|(a, b)| a * b).sum();
        let cos = cos.clamp(-1.0, 1.0);
        if cos > 0.9999 {
            return cap;
        }
        let sin_half = (0.5 * (1.0 - cos)).sqrt();
        let v = (next.accel.min(prev.accel) * lim.junction_deviation * sin_half / (1.0 - sin_half)).sqrt();
        // E still has a jerk limit.
        let de = (next.unit[3] - prev.unit[3]).abs();
        let ve = if de > 1e-9 { next.jerk[3] / de } else { f64::MAX };
        return cap.min(v.max(0.05)).min(ve.max(0.05));
    }
    let mut v = cap;
    for i in 0..4 {
        let dv = (next.unit.get(i).copied().unwrap_or(0.0) - prev.unit.get(i).copied().unwrap_or(0.0)).abs();
        if dv > 1e-9 {
            v = v.min(next.jerk.get(i).copied().unwrap_or(f64::MAX) / dv);
        }
    }
    v.max(0.05)
}

/// The speed a move can start from or stop at from rest.
fn safe_speed(b: &Block) -> f64 {
    let mut v = b.nominal;
    for (i, u) in b.unit.iter().enumerate() {
        let u = u.abs();
        if u > 1e-9 {
            v = v.min(b.jerk.get(i).copied().unwrap_or(f64::MAX) / 2.0 / u);
        }
    }
    v.max(0.05)
}

/// Seconds to run the moves in order, starting and ending at rest.
pub fn time(moves: &[Move], lim: &Limits) -> f64 {
    times_each(moves, lim).iter().sum()
}

/// [`time`] for each move (zero for a move with no length), in order.
pub fn times_each(moves: &[Move], lim: &Limits) -> Vec<f64> {
    let index: Vec<Option<Block>> = moves.iter().map(|m| block(m, lim)).collect();
    let blocks: Vec<&Block> = index.iter().flatten().collect();
    let each = block_times(&blocks, lim);
    let mut it = each.into_iter();
    index
        .iter()
        .map(|b| {
            if b.is_some() {
                it.next().unwrap_or(0.0)
            } else {
                0.0
            }
        })
        .collect()
}

fn block_times(blocks: &[&Block], lim: &Limits) -> Vec<f64> {
    let n = blocks.len();
    let (Some(&first), Some(&last)) = (blocks.first(), blocks.last()) else {
        return Vec::new();
    };
    let mut j = vec![0.0f64; n + 1];
    if let Some(s) = j.first_mut() {
        *s = safe_speed(first);
    }
    if let Some(e) = j.last_mut() {
        *e = safe_speed(last);
    }
    for (i, w) in blocks.windows(2).enumerate() {
        if let [a, b] = w
            && let Some(s) = j.get_mut(i + 1)
        {
            *s = junction(a, b, lim);
        }
    }
    for i in (0..n).rev() {
        let Some(b) = blocks.get(i) else { continue };
        let reach = (j.get(i + 1).copied().unwrap_or(0.0).m_powi(2) + 2.0 * b.accel * b.dist).sqrt();
        if let Some(s) = j.get_mut(i) {
            *s = s.min(reach);
        }
    }
    for i in 0..n {
        let Some(b) = blocks.get(i) else { continue };
        let reach = (j.get(i).copied().unwrap_or(0.0).m_powi(2) + 2.0 * b.accel * b.dist).sqrt();
        if let Some(s) = j.get_mut(i + 1) {
            *s = s.min(reach);
        }
    }
    blocks
        .iter()
        .enumerate()
        .map(|(i, b)| {
            trapezoid(
                b,
                j.get(i).copied().unwrap_or(0.0),
                j.get(i + 1).copied().unwrap_or(0.0),
            )
        })
        .collect()
}

fn trapezoid(b: &Block, v0: f64, v1: f64) -> f64 {
    let (a, d, vn) = (b.accel, b.dist, b.nominal.max(v0).max(v1));
    let da = (vn * vn - v0 * v0) / (2.0 * a);
    let dd = (vn * vn - v1 * v1) / (2.0 * a);
    if da + dd <= d {
        (vn - v0) / a + (vn - v1) / a + (d - da - dd) / vn
    } else {
        // Never reaches the top speed: accelerate to a peak and brake.
        let peak = ((2.0 * a * d + v0 * v0 + v1 * v1) / 2.0).sqrt().max(v0).max(v1);
        (peak - v0) / a + (peak - v1) / a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lim() -> Limits {
        Limits {
            max_speed: [500.0, 500.0, 12.0, 120.0],
            max_accel: [10000.0, 10000.0, 500.0, 5000.0],
            jerk: [10.0, 10.0, 0.4, 2.5],
            junction_deviation: 0.0,
        }
    }

    fn mv(dx: f64, dy: f64, feed: f64, accel: f64) -> Move {
        Move {
            d: [dx, dy, 0.0, 0.0],
            feed,
            accel,
            jerk_xy: 0.0,
        }
    }

    #[test]
    fn a_long_move_is_distance_over_speed_plus_the_ramps() {
        let t = time(&[mv(300.0, 0.0, 100.0, 1000.0)], &lim());
        // Ramps from and to 5 mm/s take about 0.095 s each and cover about 4.99 mm.
        let cruise = (300.0 - 2.0 * (100.0f64.m_powi(2) - 25.0) / 2000.0) / 100.0;
        assert!((t - (cruise + 2.0 * 0.095)).abs() < 0.01, "{t}");
    }

    #[test]
    fn a_short_move_never_reaches_its_speed() {
        let t = time(&[mv(1.0, 0.0, 300.0, 1000.0)], &lim());
        // Triangle from 5 mm/s: peak sqrt(1000 + 25) about 32 mm/s.
        assert!(t > 0.05 && t < 0.075, "{t}");
    }

    #[test]
    fn corners_slow_the_planner_and_straight_lines_do_not() {
        let straight = time(
            &[mv(50.0, 0.0, 100.0, 5000.0), mv(50.0, 0.0, 100.0, 5000.0)],
            &lim(),
        );
        let one = time(&[mv(100.0, 0.0, 100.0, 5000.0)], &lim());
        assert!((straight - one).abs() < 0.005, "{straight} {one}");
        let corner = time(
            &[mv(50.0, 0.0, 100.0, 5000.0), mv(0.0, 50.0, 100.0, 5000.0)],
            &lim(),
        );
        assert!(corner > straight + 0.01, "{corner} {straight}");
    }

    #[test]
    fn axis_limits_cap_speed_and_acceleration() {
        let mut l = lim();
        l.max_speed[0] = 50.0;
        let t = time(&[mv(100.0, 0.0, 200.0, 5000.0)], &l);
        assert!(t > 2.0, "{t}");
    }

    #[test]
    fn junction_deviation_replaces_the_jerk_rule() {
        let mut l = lim();
        l.junction_deviation = 0.05;
        let corner = time(&[mv(50.0, 0.0, 100.0, 5000.0), mv(0.0, 50.0, 100.0, 5000.0)], &l);
        assert!(corner > 1.0 && corner < 2.0, "{corner}");
    }

    #[test]
    fn empty_and_zero_length_moves_take_no_time() {
        assert!(time(&[], &lim()).abs() < 1e-12);
        assert!(time(&[mv(0.0, 0.0, 100.0, 1000.0)], &lim()).abs() < 1e-12);
    }

    #[test]
    fn feature_accelerations_follow_the_profile() {
        let mut cfg = PrintConfig::default();
        for (k, v) in [
            ("outer_wall_acceleration", 3000),
            ("default_acceleration", 5000),
            ("initial_layer_acceleration", 1000),
            ("machine_max_acceleration_extruding", 4000),
        ] {
            cfg.raw.insert(k.into(), serde_json::json!(v));
        }
        assert!((feature_accel(&cfg, Feature::OuterWall, false) - 3000.0).abs() < 1e-9);
        assert!(
            (feature_accel(&cfg, Feature::InnerWall, false) - 4000.0).abs() < 1e-9,
            "default capped by the machine"
        );
        assert!((feature_accel(&cfg, Feature::OuterWall, true) - 1000.0).abs() < 1e-9);
        assert!(Limits::from_config(&cfg).is_none());
    }

    fn with(pairs: &[(&str, serde_json::Value)]) -> PrintConfig {
        let mut cfg = PrintConfig::default();
        for (k, v) in pairs {
            cfg.raw.insert((*k).into(), v.clone());
        }
        cfg
    }

    #[test]
    fn orca_picks_the_acceleration_in_its_own_order() {
        // The first layer wins, then bridges (an overhanging wall is one), sparse, solid, outer, inner, top.
        let cfg = with(&[
            ("default_acceleration", serde_json::json!(5000)),
            ("outer_wall_acceleration", serde_json::json!(3000)),
            ("inner_wall_acceleration", serde_json::json!(4000)),
            ("top_surface_acceleration", serde_json::json!(2000)),
            ("initial_layer_acceleration", serde_json::json!(1000)),
            ("bridge_acceleration", serde_json::json!("50%")),
            ("sparse_infill_acceleration", serde_json::json!("100%")),
            ("internal_solid_infill_acceleration", serde_json::json!("80%")),
        ]);
        let a = |f: Feature, first: bool| gcode_accel(&cfg, f, first);
        assert!(
            (a(Feature::OverhangWall, false) - 1500.0).abs() < 1e-9,
            "50 percent of the outer wall"
        );
        assert!((a(Feature::SparseInfill, false) - 5000.0).abs() < 1e-9);
        assert!(
            (a(Feature::InternalSolid, false) - 4000.0).abs() < 1e-9,
            "80 percent of the default"
        );
        assert!((a(Feature::TopSurface, false) - 2000.0).abs() < 1e-9);
        assert!((a(Feature::Support, false) - 5000.0).abs() < 1e-9);
        assert!(
            (a(Feature::Bridge, true) - 1000.0).abs() < 1e-9,
            "the first layer wins"
        );
        // Nothing is written without a default acceleration.
        assert!(
            gcode_accel(
                &with(&[("default_acceleration", serde_json::json!(0))]),
                Feature::OuterWall,
                false
            )
            .abs()
                < 1e-9
        );
    }

    #[test]
    fn klipper_gets_one_line_and_accel_to_decel_only_when_on() {
        let mut cfg = with(&[
            ("default_acceleration", serde_json::json!(5000)),
            ("outer_wall_acceleration", serde_json::json!(3000)),
            ("default_jerk", serde_json::json!(10)),
            ("outer_wall_jerk", serde_json::json!(7)),
            ("accel_to_decel_factor", serde_json::json!("60%")),
        ]);
        let mut st = Written::default();
        let line = accel_lines(
            &cfg,
            crate::config::GcodeFlavor::Klipper,
            Feature::OuterWall,
            false,
            &mut st,
        );
        assert_eq!(
            line,
            "SET_VELOCITY_LIMIT ACCEL=3000 ACCEL_TO_DECEL=1800 SQUARE_CORNER_VELOCITY=7\n"
        );
        // Written once: the same request writes nothing more.
        assert_eq!(
            accel_lines(
                &cfg,
                crate::config::GcodeFlavor::Klipper,
                Feature::OuterWall,
                false,
                &mut st
            ),
            ""
        );
        cfg.raw
            .insert("accel_to_decel_enable".into(), serde_json::json!(false));
        let mut st = Written::default();
        let line = accel_lines(
            &cfg,
            crate::config::GcodeFlavor::Klipper,
            Feature::OuterWall,
            false,
            &mut st,
        );
        assert_eq!(line, "SET_VELOCITY_LIMIT ACCEL=3000 SQUARE_CORNER_VELOCITY=7\n");
    }

    #[test]
    fn a_short_travel_to_an_outer_wall_keeps_the_walls_acceleration_and_jerk() {
        let cfg = with(&[
            ("default_acceleration", serde_json::json!(5000)),
            ("outer_wall_acceleration", serde_json::json!(3000)),
            ("travel_acceleration", serde_json::json!(8000)),
            ("default_jerk", serde_json::json!(10)),
            ("outer_wall_jerk", serde_json::json!(7)),
            ("travel_jerk", serde_json::json!(12)),
        ]);
        let flavor = crate::config::GcodeFlavor::Marlin2;
        let mut st = Written::default();
        assert_eq!(
            travel_lines(&cfg, flavor, true, Feature::OuterWall, false, &mut st),
            "M204 T3000\nM205 X7 Y7\n"
        );
        assert_eq!(
            travel_lines(&cfg, flavor, false, Feature::InnerWall, false, &mut st),
            "M204 T8000\nM205 X12 Y12\n"
        );
    }

    #[test]
    fn one_motion_per_layer_writes_what_a_fresh_one_per_path_writes() {
        use crate::config::GcodeFlavor as F;
        let cfg = with(&[
            ("default_acceleration", serde_json::json!(5000)),
            ("outer_wall_acceleration", serde_json::json!(3000)),
            ("inner_wall_acceleration", serde_json::json!(4000)),
            ("top_surface_acceleration", serde_json::json!(2000)),
            ("initial_layer_acceleration", serde_json::json!(1000)),
            ("bridge_acceleration", serde_json::json!("50%")),
            ("sparse_infill_acceleration", serde_json::json!("90%")),
            ("internal_solid_infill_acceleration", serde_json::json!("80%")),
            ("travel_acceleration", serde_json::json!(8000)),
            ("initial_layer_travel_acceleration", serde_json::json!("60%")),
            ("default_jerk", serde_json::json!(10)),
            ("outer_wall_jerk", serde_json::json!(7)),
            ("inner_wall_jerk", serde_json::json!(8)),
            ("top_surface_jerk", serde_json::json!(6)),
            ("infill_jerk", serde_json::json!(11)),
            ("initial_layer_jerk", serde_json::json!(5)),
            ("travel_jerk", serde_json::json!(12)),
            ("initial_layer_travel_jerk", serde_json::json!("50%")),
            ("machine_max_acceleration_extruding", serde_json::json!([4500])),
            ("machine_max_acceleration_travel", serde_json::json!([7000])),
            ("machine_max_jerk_x", serde_json::json!([9])),
            ("machine_max_jerk_y", serde_json::json!([9])),
            ("machine_max_jerk_z", serde_json::json!([0.4])),
            ("machine_max_jerk_e", serde_json::json!([2.5])),
            ("accel_to_decel_factor", serde_json::json!("60%")),
        ]);
        let features = [
            Feature::OuterWall,
            Feature::InnerWall,
            Feature::OverhangWall,
            Feature::TopSurface,
            Feature::BottomSurface,
            Feature::InternalSolid,
            Feature::SparseInfill,
            Feature::Bridge,
            Feature::Support,
            Feature::SupportInterface,
            Feature::Brim,
            Feature::Ironing,
            Feature::GapFill,
            Feature::PrimeTower,
            Feature::Custom,
            Feature::Skirt,
            Feature::InternalBridge,
        ];
        for flavor in [
            F::Marlin,
            F::Marlin2,
            F::Klipper,
            F::Bambu,
            F::Repetier,
            F::RepRapFirmware,
        ] {
            for first in [false, true] {
                let mut motion = Motion::new(&cfg, flavor, first);
                let (mut kept, mut fresh) = (Written::default(), Written::default());
                // Twice through, so the second round reads what the first one worked out.
                for _ in 0..2 {
                    for f in features {
                        for short in [false, true] {
                            assert_eq!(
                                motion.travel_lines(short, f, &mut kept),
                                travel_lines(&cfg, flavor, short, f, first, &mut fresh),
                                "{flavor:?} first {first} travel to {f:?} short {short}"
                            );
                        }
                        assert_eq!(
                            motion.accel_lines(f, &mut kept),
                            accel_lines(&cfg, flavor, f, first, &mut fresh),
                            "{flavor:?} first {first} {f:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn each_flavor_writes_its_own_acceleration_and_jerk_lines() {
        use crate::config::GcodeFlavor as F;
        let cfg = with(&[
            ("default_acceleration", serde_json::json!(5000)),
            ("outer_wall_acceleration", serde_json::json!(3000)),
            ("default_jerk", serde_json::json!(10)),
            ("outer_wall_jerk", serde_json::json!(7)),
            ("travel_acceleration", serde_json::json!(8000)),
            ("travel_jerk", serde_json::json!(12)),
        ]);
        let print = |f: F| {
            let mut st = Written::default();
            accel_lines(&cfg, f, Feature::OuterWall, false, &mut st)
        };
        assert_eq!(
            print(F::Marlin),
            "M204 S3000\nM205 X7 Y7\n",
            "Marlin before 2 has one acceleration"
        );
        assert_eq!(print(F::Marlin2), "M204 P3000\nM205 X7 Y7\n");
        assert_eq!(print(F::Repetier), "M201 X3000 Y3000\nM207 X7\n");
        assert_eq!(print(F::Smoothie), "M204 S3000\nM205 X7 Y7\n");
        let travel = |f: F| {
            let mut st = Written::default();
            travel_lines(&cfg, f, false, Feature::InnerWall, false, &mut st)
        };
        assert_eq!(
            travel(F::Marlin2),
            "M204 T8000\nM205 X12 Y12\n",
            "separate travel acceleration"
        );
        assert_eq!(
            travel(F::Marlin),
            "M204 S8000\nM205 X12 Y12\n",
            "the print acceleration slot"
        );
        assert_eq!(travel(F::Repetier), "M202 X8000 Y8000\nM207 X12\n");
    }
}
