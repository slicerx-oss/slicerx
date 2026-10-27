// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The print time of a finished G-code file, worked out the way `OrcaSlicer` 2.4.2's G-code processor
//! does it (`GCodeProcessor` in `libslic3r/GCode/GCodeProcessor.cpp`: `process_G1`, `process_G2_G3`,
//! `process_filament_change`, `TimeMachine::calculate_time` and the planner kernels). The file is
//! read line by line, so everything in it counts: the start and end G-code, the change G-code,
//! dwells, and the accelerations and limits the file sets.
//!
//! The model, as Orca has it:
//! - Every `G0` to `G3` move becomes a block (arcs in segments, as the firmware plans them). Its top
//!   speed is the feed rate raised to the machine's minimum feed rate, cut by a centripetal limit on
//!   gentle corners (`sqrt(acceleration * radius)`) and by the axis speed limits.
//! - Its acceleration is the travel one for travels, the retract one for extruder-only moves and the
//!   print one otherwise (wipes included), each as the last `M204` or `SET_VELOCITY_LIMIT` set it and
//!   clamped by the machine's limits, then cut so no axis exceeds its own.
//! - The junction speed follows Marlin's classic jerk rule on the XYZ velocity change and on E;
//!   Marlin 2 with a junction deviation turns that into a jerk of `sqrt(deviation * acceleration * 2.5)`.
//! - A queue of blocks gets Marlin's reverse and forward passes; once it holds more than 256 blocks,
//!   all but the last 64 are timed and dropped. `G4`, `M400` with a time, `G92` without E and similar
//!   commands empty the queue and add their time.
//! - A filament change adds the machine's unload and load times (and its tool change time when the
//!   nozzle changes), as a stop in the motion.
//! - `G29` takes 260 s (on Bambu Lab printers only inside an `M622 J1` block), `M191` above 40 °C 720 s.
//!
//! Klipper plans motion differently, so a file for the Klipper flavor gets the model its documentation
//! (Kinematics and the config reference) describes instead of the jerk rules above:
//! - One acceleration for every toolhead move, as the last `SET_VELOCITY_LIMIT ACCEL`, `M204 S` or
//!   `M204 P T` (the smaller of the two) set it, under the profile's machine acceleration limit when it
//!   has one (its stand-in for printer.cfg; without one it is not clamped). `max_velocity` caps the
//!   toolhead speed along the path and the Z limits cut moves that climb. Retractions and other extruder-only moves keep to the extrude-only limits, which
//!   Klipper derives from a move with a cross section of 4 nozzle diameters squared.
//! - A junction runs at the approximated centripetal speed: with the square corner velocity `v` and
//!   `s` the sine of half the angle at the corner (180 degrees straight on),
//!   `speed^2 = v^2 (sqrt(2) - 1) s / (1 - s)`,
//!   exactly `v` at 90 degrees, 0 on a reversal, unlimited straight on. The extruder may change its
//!   speed by at most 1 mm/s at a junction (`instantaneous_corner_velocity`'s default), and a move
//!   without X, Y or Z movement starts and ends at rest.
//! - Lookahead runs forward and backward over the whole queue, which stops at its end. A second pass
//!   at the virtual "acceleration to deceleration" rate (`acceleration * (1 - minimum_cruise_ratio)`,
//!   or an explicit `ACCEL_TO_DECEL` from older firmware) caps each move's top speed at what it could
//!   reach at that rate, so a short zigzag keeps a stretch at cruise speed.
//! - Arcs are cut into 1 mm segments (the `[gcode_arcs]` default resolution). `M201`, `M203`,
//!   `M205` and `M566` are not Klipper commands and change nothing.

use crate::config::{GcodeFlavor, PrintConfig};
use crate::fm::Fm as _;

mod bbl;

/// The time of a file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Estimate {
    /// Seconds for the whole file.
    pub total: f64,
    /// Seconds up to the second layer change (Orca's first layer time, start G-code included).
    pub first_layer: f64,
    /// Seconds per stretch of the file between `;@L` layer markers: entry `i` ends at marker `i`, the
    /// last entry is what follows the last marker.
    pub segments: Vec<f64>,
    /// Seconds into the print at the end of each line (empty unless asked for).
    pub lines: Vec<f64>,
    /// Seconds per feature, the way Bambu Studio's preview lists them: by the latest `; FEATURE:` tag, with
    /// travel moves as `Undefined` (inside the start and end G-code they keep `Custom`), filament changes as
    /// `Flush`, and a wait counted with the move it lands on. In order of first use.
    pub features: Vec<(String, f64)>,
    /// Seconds of travel moves, the start sequence's left out.
    pub travel: f64,
    /// Seconds of the start sequence: the moves under the first `Custom` feature tag, when it comes before any move.
    pub prepare: f64,
    /// Seconds of waits with no move after them at the end of the file (the end G-code's last dwells). Whether
    /// the total counts them depends on the printer's rules.
    pub end_wait: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Noop,
    Retract,
    Unretract,
    Travel,
    Extrude,
    Wipe,
    ToolChange,
}

#[derive(Debug, Clone, Copy, Default)]
struct Trapezoid {
    accelerate_until: f64,
    decelerate_after: f64,
    cruise: f64,
}

#[derive(Debug, Clone, Copy)]
struct Block {
    kind: Kind,
    distance: f64,
    acceleration: f64,
    entry: f64,
    cruise: f64,
    exit: f64,
    max_entry: f64,
    safe: f64,
    nominal_length: bool,
    recalculate: bool,
    trap: Trapezoid,
    layer: u32,
    segment: usize,
    line: usize,
    /// Klipper: the move's requested top speed, before the lookahead caps it into `cruise`.
    limit: f64,
    /// Klipper: the virtual acceleration of the smoothed pass.
    smooth: f64,
    /// Klipper: the smoothed pass's speed at the start of the move, from the last plan.
    smooth_entry: f64,
    /// Klipper: a cap on `smooth_entry` once the move before has been timed and dropped.
    smooth_max: f64,
    /// The feature the move counts under, an index into [`Machine::features`].
    role: u16,
    /// Whether the move belongs to the start sequence.
    prepare: bool,
}

fn accel_distance(from: f64, to: f64, a: f64) -> f64 {
    if a == 0.0 {
        0.0
    } else {
        (to * to - from * from) / (2.0 * a)
    }
}

fn intersection_distance(v0: f64, v1: f64, a: f64, d: f64) -> f64 {
    if a == 0.0 {
        0.0
    } else {
        (2.0 * a * d - v0 * v0 + v1 * v1) / (4.0 * a)
    }
}

fn speed_from_distance(v0: f64, d: f64, a: f64) -> f64 {
    (v0 * v0 + 2.0 * a * d).max(0.0).sqrt()
}

/// The fastest speed from which `target` is still reachable over `d` at acceleration `a`.
fn max_allowable_speed(a: f64, target: f64, d: f64) -> f64 {
    (target * target - 2.0 * a * d).max(0.0).sqrt()
}

fn accel_time(v0: f64, d: f64, a: f64) -> f64 {
    if a == 0.0 {
        0.0
    } else {
        (speed_from_distance(v0, d, a) - v0) / a
    }
}

impl Block {
    fn calculate_trapezoid(&mut self) {
        let mut accelerate = accel_distance(self.entry, self.cruise, self.acceleration).max(0.0);
        let decelerate = accel_distance(self.cruise, self.exit, -self.acceleration).max(0.0);
        let mut cruise_distance = self.distance - accelerate - decelerate;
        if cruise_distance < 0.0 {
            // No room to reach the top speed: accelerate, then brake to the exit speed.
            accelerate = intersection_distance(self.entry, self.exit, self.acceleration, self.distance)
                .clamp(0.0, self.distance.max(0.0));
            cruise_distance = 0.0;
            self.trap.cruise = speed_from_distance(self.entry, accelerate, self.acceleration);
        } else {
            self.trap.cruise = self.cruise;
        }
        self.trap.accelerate_until = accelerate;
        self.trap.decelerate_after = accelerate + cruise_distance;
    }

    fn time(&self) -> f64 {
        let t = &self.trap;
        let cruise_distance = t.decelerate_after - t.accelerate_until;
        let cruise = if t.cruise == 0.0 {
            0.0
        } else {
            cruise_distance / t.cruise
        };
        accel_time(self.entry, t.accelerate_until, self.acceleration)
            + cruise
            + accel_time(t.cruise, self.distance - t.decelerate_after, -self.acceleration)
    }
}

/// Marlin's forward pass kernel: a short accelerating block limits the entry of the next.
fn forward_kernel(prev: &Block, curr: &mut Block) {
    if !prev.nominal_length && prev.entry < curr.entry {
        let v = max_allowable_speed(-prev.acceleration, prev.entry, prev.distance);
        if v < curr.entry {
            curr.entry = v;
            curr.recalculate = true;
        }
    }
}

#[allow(
    clippy::float_cmp,
    reason = "the firmware's planner compares the speeds exactly"
)]
/// Marlin's reverse pass kernel: the entry speed must allow braking to the next block's entry.
fn reverse_kernel(curr: &mut Block, next: &Block) {
    if curr.entry != curr.max_entry || next.recalculate {
        let v = if curr.nominal_length {
            curr.max_entry
        } else {
            curr.max_entry
                .min(max_allowable_speed(-curr.acceleration, next.entry, curr.distance))
        };
        if curr.entry != v {
            curr.entry = v;
            curr.recalculate = true;
        }
    }
}

fn recalculate_trapezoids(blocks: &mut [Block]) {
    let n = blocks.len();
    for i in 1..n {
        let next_entry_changed = blocks.get(i).is_some_and(|b| b.recalculate);
        let next_entry = blocks.get(i).map_or(0.0, |b| b.entry);
        if let Some(curr) = blocks.get_mut(i - 1)
            && (curr.recalculate || next_entry_changed)
        {
            curr.exit = next_entry;
            curr.calculate_trapezoid();
            curr.recalculate = false;
        }
    }
    if let Some(last) = blocks.last_mut() {
        last.exit = last.safe;
        last.calculate_trapezoid();
        last.recalculate = false;
    }
}

/// The square of the highest speed at each junction of `blocks` (one more entry than blocks: the last is
/// the end of the queue) that is reachable from both sides at the rate `accel` gives each move, under the
/// caps in `start` (squared) and `head` on the first.
fn reachable(start: &[f64], blocks: &[Block], accel: impl Fn(&Block) -> f64, head: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(start.len());
    let mut v = head;
    let mut moves = blocks.iter();
    for s in start {
        v = v.min(*s);
        out.push(v);
        if let Some(b) = moves.next() {
            v += 2.0 * accel(b) * b.distance;
        }
    }
    let mut v = 0.0f64;
    if let Some(last) = out.last_mut() {
        *last = 0.0;
    }
    for ((o, s), b) in out
        .iter_mut()
        .rev()
        .skip(1)
        .zip(start.iter().rev().skip(1))
        .zip(blocks.iter().rev())
    {
        v = (v + 2.0 * accel(b) * b.distance).min(*s);
        *o = o.min(v);
    }
    out
}

/// Klipper's lookahead over the queue (see the module notes): junction speeds from both directions, each
/// move's top speed cut to what the smoothed pass can reach in it, then the real passes at the moves'
/// accelerations. The queue ends at rest.
fn plan_klipper(blocks: &mut [Block]) {
    let mut cap: Vec<f64> = blocks.iter().map(|b| b.limit * b.limit).collect();
    let junctions = |cap: &[f64], blocks: &[Block]| -> Vec<f64> {
        let mut start = Vec::with_capacity(blocks.len() + 1);
        let mut before = f64::INFINITY;
        for (b, c) in blocks.iter().zip(cap) {
            start.push((b.max_entry * b.max_entry).min(before).min(*c));
            before = *c;
        }
        start.push(0.0);
        start
    };
    let start = junctions(&cap, blocks);
    let head = blocks
        .first()
        .map_or(f64::INFINITY, |b| b.smooth_max * b.smooth_max);
    let smooth = reachable(&start, blocks, |b| b.smooth, head);
    for ((c, b), w) in cap.iter_mut().zip(blocks.iter()).zip(smooth.windows(2)) {
        if let [s0, s1] = *w {
            // The peak of a move that speeds up from s0 and slows to s1 at the virtual rate.
            let d2 = 2.0 * b.smooth * b.distance;
            let peak = if (s0 - s1).abs() <= d2 {
                0.5 * (s0 + s1 + d2)
            } else {
                s0.min(s1) + d2
            };
            *c = c.min(peak);
        }
    }
    let start = junctions(&cap, blocks);
    let real = reachable(&start, blocks, |b| b.acceleration, f64::INFINITY);
    for (((b, w), c), s) in blocks.iter_mut().zip(real.windows(2)).zip(&cap).zip(&smooth) {
        if let [v0, v1] = *w {
            b.entry = v0.sqrt();
            b.exit = v1.sqrt();
            b.cruise = c.sqrt();
            b.smooth_entry = s.sqrt();
            b.calculate_trapezoid();
            b.recalculate = false;
        }
    }
}

/// The square of the speed Klipper allows through a junction for the square corner velocity `scv`,
/// with `cos` the cosine of the angle between the two paths' directions (1 straight on, -1 a reversal).
fn corner_speed2(scv: f64, cos: f64) -> f64 {
    if cos > 0.999_999 {
        return f64::INFINITY;
    }
    if cos < -0.999_999 {
        return 0.0;
    }
    // The sine of half the angle at the corner, which is 180 degrees straight on and 90 at a square corner.
    let s = f64::midpoint(1.0, cos).sqrt();
    scv * scv * (std::f64::consts::SQRT_2 - 1.0) * s / (1.0 - s)
}

/// Klipper's default `instantaneous_corner_velocity`: the extruder's largest speed change at a junction.
const KLIPPER_EXTRUDER_CORNER: f64 = 1.0;
/// Klipper's default `minimum_cruise_ratio`.
const KLIPPER_CRUISE_RATIO: f64 = 0.5;
/// Klipper's default `square_corner_velocity`.
const KLIPPER_SQUARE_CORNER: f64 = 5.0;
/// Klipper's default `[gcode_arcs]` resolution, mm per segment.
const KLIPPER_ARC_SEGMENT: f64 = 1.0;

#[derive(Clone, Copy)]
struct CurveMotion {
    distance: f64,
    plane: f64,
    radius: f64,
    enter: [f64; 3],
    exit: [f64; 3],
}

/// The machine envelope (Orca's `MachineEnvelopeConfig`, normal mode), X, Y, Z, E order.
#[derive(Debug, Clone)]
struct Envelope {
    speed: [f64; 4],
    accel: [f64; 4],
    jerk: [f64; 4],
    junction_deviation: f64,
    min_extruding: f64,
    min_travel: f64,
    extruding: f64,
    retracting: f64,
    travel: f64,
}

impl Envelope {
    /// Orca's defaults for each limit.
    fn defaults() -> Self {
        Self {
            speed: [500.0, 500.0, 12.0, 120.0],
            accel: [1000.0, 1000.0, 500.0, 5000.0],
            jerk: [10.0, 10.0, 0.2, 2.5],
            junction_deviation: 0.01,
            min_extruding: 0.0,
            min_travel: 0.0,
            extruding: 1500.0,
            retracting: 1500.0,
            travel: 0.0,
        }
    }

    fn from_config(cfg: &PrintConfig) -> Self {
        let mut e = Self::defaults();
        let get = |key: &str| crate::motion::raw_f(cfg, key);
        for (axis, (s, (a, j))) in ["x", "y", "z", "e"]
            .iter()
            .zip(e.speed.iter_mut().zip(e.accel.iter_mut().zip(e.jerk.iter_mut())))
        {
            if let Some(v) = get(&format!("machine_max_speed_{axis}")) {
                *s = v;
            }
            if let Some(v) = get(&format!("machine_max_acceleration_{axis}")) {
                *a = v;
            }
            if let Some(v) = get(&format!("machine_max_jerk_{axis}")) {
                *j = v;
            }
        }
        for (key, slot) in [
            ("machine_max_junction_deviation", &mut e.junction_deviation),
            ("machine_min_extruding_rate", &mut e.min_extruding),
            ("machine_min_travel_rate", &mut e.min_travel),
            ("machine_max_acceleration_extruding", &mut e.extruding),
            ("machine_max_acceleration_retracting", &mut e.retracting),
            ("machine_max_acceleration_travel", &mut e.travel),
        ] {
            if let Some(v) = get(key) {
                *slot = v;
            }
        }
        e
    }
}

/// The flavors as Orca's processor tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fw {
    MarlinLegacy,
    Marlin2,
    Klipper,
    RepRap,
    Repetier,
    Smoothie,
    Other,
}

fn fw_of(flavor: GcodeFlavor) -> Fw {
    match flavor {
        GcodeFlavor::Marlin | GcodeFlavor::Bambu => Fw::MarlinLegacy,
        GcodeFlavor::Marlin2 => Fw::Marlin2,
        GcodeFlavor::Klipper => Fw::Klipper,
        GcodeFlavor::RepRapFirmware => Fw::RepRap,
        GcodeFlavor::Repetier => Fw::Repetier,
        GcodeFlavor::Smoothie => Fw::Smoothie,
        _ => Fw::Other,
    }
}

/// The motion state of the last block (`TimeMachine::State`).
#[derive(Debug, Clone, Copy, Default)]
struct Motion {
    feedrate: f64,
    safe: f64,
    axis: [f64; 4],
    dir: [f64; 3],
    /// Klipper: whether the move had X, Y or Z movement, and its filament per mm of path.
    xyz: bool,
    e_ratio: f64,
}

/// Klipper's state beyond the shared envelope.
#[derive(Debug, Clone, Copy)]
struct KlipperState {
    /// `minimum_cruise_ratio`.
    cruise_ratio: f64,
    /// An explicit `ACCEL_TO_DECEL` (firmware before the cruise ratio), which wins while set.
    accel_to_decel: Option<f64>,
    /// `max_extrude_only_velocity` and `max_extrude_only_accel`.
    extrude_only_speed: f64,
    extrude_only_accel: f64,
    /// The profile's stand-in for printer.cfg `max_accel` and `max_velocity`, when it sets them: caps on what
    /// the file asks for. Klipper itself takes higher values from `SET_VELOCITY_LIMIT` and `M204`, but the
    /// profile is the only record of the printer's configuration we have; without one nothing is capped.
    accel_cap: Option<f64>,
    speed_cap: Option<f64>,
}

impl KlipperState {
    fn new(cfg: &PrintConfig, env: &Envelope, accel: f64) -> Self {
        // An extruder-only move may go as fast as the filament of a print move at the top speed and
        // acceleration with a cross section of 4 nozzle diameters squared.
        let nozzle = crate::motion::raw_f(cfg, "nozzle_diameter").unwrap_or(cfg.nozzle_diameter);
        let filament = crate::motion::raw_f(cfg, "filament_diameter").unwrap_or(cfg.filament_diameter);
        let area = std::f64::consts::PI * 0.25 * filament * filament;
        let ratio = if area > 0.0 && nozzle > 0.0 {
            4.0 * nozzle * nozzle / area
        } else {
            1.0
        };
        let set = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| crate::motion::raw_f(cfg, k))
                .filter(|v| *v > 0.0)
        };
        Self {
            cruise_ratio: KLIPPER_CRUISE_RATIO,
            accel_to_decel: None,
            extrude_only_speed: env.speed[0] * ratio,
            extrude_only_accel: accel * ratio,
            // Klipper has one acceleration for every move, so the print limit stands for it, else the travel one.
            accel_cap: set(&[
                "machine_max_acceleration_extruding",
                "machine_max_acceleration_travel",
            ]),
            // `max_velocity` applies along the path; the X limit stands for it, else the Y one.
            speed_cap: set(&["machine_max_speed_x", "machine_max_speed_y"]),
        }
    }

    /// An acceleration the file asks for, under the profile's cap.
    fn accel(&self, a: f64) -> f64 {
        self.accel_cap.map_or(a, |c| a.min(c))
    }

    /// A top speed the file asks for, under the profile's cap.
    fn speed(&self, v: f64) -> f64 {
        self.speed_cap.map_or(v, |c| v.min(c))
    }

    /// The virtual acceleration of the smoothed pass for a move at `accel`.
    fn smooth(&self, accel: f64) -> f64 {
        match self.accel_to_decel {
            Some(a) => a.min(accel).max(0.0),
            None => accel * (1.0 - self.cruise_ratio),
        }
    }
}

struct Machine {
    fw: Fw,
    env: Envelope,
    acceleration: f64,
    max_acceleration: f64,
    retract: f64,
    max_retract: f64,
    travel: f64,
    max_travel: f64,
    e_factor: f64,
    klipper: KlipperState,
    blocks: Vec<Block>,
    prev: Motion,
    pending: Vec<(Kind, f64)>,
    time: f64,
    first_layer: f64,
    segments: Vec<f64>,
    lines: Option<Vec<f64>>,
    /// The Bambu Lab rules of [`bbl`] instead of the planner above.
    bbl: bool,
    /// Under those rules: the waits not yet carried by a move, oldest first.
    waits: Vec<bbl::Wait>,
    features: Vec<(String, f64)>,
    travel_time: f64,
    prepare_time: f64,
    end_wait: f64,
}

/// Where a wait was booked when it was read: its stretch of the file, its line and whether it was in the first layer.
#[derive(Debug, Clone, Copy)]
struct Book {
    segment: usize,
    line: usize,
    first: bool,
}

const QUEUE: usize = 64;
const REFRESH: usize = QUEUE * 4;

impl Machine {
    fn new(cfg: &PrintConfig) -> Self {
        let fw = fw_of(cfg.gcode_flavor);
        let mut env = match fw {
            Fw::MarlinLegacy | Fw::Marlin2 | Fw::Klipper | Fw::RepRap => Envelope::from_config(cfg),
            _ => Envelope::defaults(),
        };
        if matches!(fw, Fw::MarlinLegacy | Fw::Klipper) {
            env.travel = env.extruding;
        }
        if fw == Fw::RepRap {
            env.min_extruding = 0.0;
            env.min_travel = 0.0;
        }
        let bbl = bbl::applies(cfg, fw);
        // Under the Bambu Lab rules the travel acceleration has the (extruding) limit as its ceiling too.
        let max_travel = if bbl || matches!(fw, Fw::Repetier | Fw::Marlin2 | Fw::RepRap) {
            env.travel
        } else {
            0.0
        };
        let or = |v: f64, d: f64| if v > 0.0 { v } else { d };
        if fw == Fw::Klipper && crate::motion::raw_f(cfg, "machine_max_jerk_x").is_none() {
            env.jerk[0] = KLIPPER_SQUARE_CORNER;
            env.jerk[1] = KLIPPER_SQUARE_CORNER;
        }
        let klipper = KlipperState::new(cfg, &env, or(env.extruding, 1500.0));
        Self {
            fw,
            klipper,
            acceleration: or(env.extruding, 1500.0),
            max_acceleration: env.extruding,
            retract: or(env.retracting, 1500.0),
            max_retract: env.retracting,
            travel: or(max_travel, 1250.0),
            max_travel,
            env,
            e_factor: 1.0,
            blocks: Vec::with_capacity(REFRESH + 8),
            prev: Motion::default(),
            pending: Vec::new(),
            time: 0.0,
            first_layer: 0.0,
            segments: Vec::new(),
            lines: None,
            bbl,
            waits: Vec::new(),
            features: vec![("Undefined".to_owned(), 0.0)],
            travel_time: 0.0,
            prepare_time: 0.0,
            end_wait: 0.0,
        }
    }

    /// The index of feature `name` in [`Self::features`], added on first use.
    fn role_id(&mut self, name: &str) -> u16 {
        let i = self
            .features
            .iter()
            .position(|(n, _)| n == name)
            .unwrap_or_else(|| {
                self.features.push((name.to_owned(), 0.0));
                self.features.len() - 1
            });
        u16::try_from(i).unwrap_or(0)
    }

    /// Adds a timed move: `motion` is its own time, `t` that plus the wait it carries.
    fn account(&mut self, b: &Block, motion: f64, t: f64) {
        self.time += t;
        if b.layer == 1 {
            self.first_layer += motion;
        }
        if self.segments.len() <= b.segment {
            self.segments.resize(b.segment + 1, 0.0);
        }
        if let Some(s) = self.segments.get_mut(b.segment) {
            *s += motion;
        }
        if let Some(slot) = self.lines.as_mut().and_then(|l| l.get_mut(b.line)) {
            *slot += motion;
        }
        if let Some(f) = self.features.get_mut(usize::from(b.role)) {
            f.1 += t;
        }
        if b.prepare {
            self.prepare_time += t;
        } else if b.kind == Kind::Travel {
            self.travel_time += t;
        }
    }

    fn set_acceleration(&mut self, v: f64) {
        self.acceleration = if self.max_acceleration == 0.0 {
            v
        } else {
            v.min(self.max_acceleration)
        };
    }

    fn set_travel(&mut self, v: f64) {
        self.travel = if self.max_travel == 0.0 {
            v
        } else {
            v.min(self.max_travel)
        };
    }

    fn set_retract(&mut self, v: f64) {
        self.retract = if self.max_retract == 0.0 {
            v
        } else {
            v.min(self.max_retract)
        };
    }

    /// The jerk Marlin 2 derives from a junction deviation (`get_axis_max_jerk_with_jd`).
    fn jd_jerk(&self, axis_accel: f64) -> f64 {
        let jd = self.env.junction_deviation;
        if jd <= 0.0 {
            return 0.0;
        }
        let mut a = self.acceleration;
        if axis_accel > 0.0 {
            a = if a > 0.0 { a.min(axis_accel) } else { axis_accel };
        }
        if a <= 0.0 { 0.0 } else { (jd * a * 2.5).sqrt() }
    }

    fn uses_jd(&self) -> bool {
        self.fw == Fw::Marlin2 && self.env.junction_deviation > 0.0
    }

    fn axis_jerk(&self) -> [f64; 4] {
        if self.uses_jd() {
            self.env.accel.map(|a| self.jd_jerk(a))
        } else {
            self.env.jerk
        }
    }

    /// Times the queued blocks, keeping the last `keep` for later passes (`TimeMachine::calculate_time`).
    fn calculate(&mut self, keep: usize, additional: f64, target: Kind, last: bool) {
        let drain = last && !self.pending.is_empty();
        // The Marlin style queue leaves a lone block untimed; Klipper runs every move it is given.
        let least = if self.fw == Fw::Klipper { 1 } else { 2 };
        if self.blocks.len() < least && !drain {
            if additional > 0.0 {
                self.pending.push((target, additional));
            }
            return;
        }
        let mut extra = std::mem::take(&mut self.pending);
        if additional > 0.0 {
            extra.push((target, additional));
        }
        // Adjacent entries of the same kind merge.
        let mut merged: Vec<(Kind, f64)> = Vec::with_capacity(extra.len());
        for (k, t) in extra {
            match merged.last_mut() {
                Some(m) if m.0 == k => m.1 += t,
                _ => merged.push((k, t)),
            }
        }
        let n = self.blocks.len();
        if self.fw == Fw::Klipper {
            plan_klipper(&mut self.blocks);
        } else {
            for i in (1..n).rev() {
                if let Some((head, tail)) = self.blocks.split_at_mut_checked(i)
                    && let (Some(curr), Some(next)) = (head.last_mut(), tail.first())
                {
                    reverse_kernel(curr, next);
                }
            }
            for i in 0..n.saturating_sub(1) {
                if let Some((head, tail)) = self.blocks.split_at_mut_checked(i + 1)
                    && let (Some(prev), Some(curr)) = (head.last(), tail.first_mut())
                {
                    forward_kernel(prev, curr);
                }
            }
            recalculate_trapezoids(&mut self.blocks);
        }
        let process = n.saturating_sub(keep);
        let mut idx = 0usize;
        for i in 0..process {
            let Some(b) = self.blocks.get(i).copied() else {
                break;
            };
            let motion = b.time();
            let mut t = motion;
            if let Some(&(k, extra)) = merged.get(idx)
                && (k == Kind::Noop || k == b.kind)
            {
                t += extra;
                idx += 1;
            }
            self.account(&b, motion, t);
        }
        if let Some(rest) = merged.get(idx..)
            && !rest.is_empty()
        {
            if last {
                // Nothing left to carry it: it counts in the total only.
                let leftover: f64 = rest.iter().map(|r| r.1).sum();
                self.time += leftover;
                self.end_wait += leftover;
            } else {
                self.pending.extend_from_slice(rest);
            }
        }
        if keep > 0 {
            self.blocks.drain(..process);
            if let Some(first) = self.blocks.first_mut() {
                first.max_entry = first.entry;
                first.smooth_max = first.smooth_entry;
            }
        } else {
            self.blocks.clear();
        }
    }

    fn synchronize(&mut self, additional: f64, target: Kind, book: Book) {
        if self.bbl {
            self.wait(additional, target, book);
        } else {
            self.calculate(0, additional, target, false);
        }
    }
}

/// The processor's state while reading the file.
#[allow(clippy::struct_excessive_bools, reason = "the processor's modal flags")]
struct Reader {
    m: Machine,
    start: [f64; 4],
    end: [f64; 4],
    origin: [f64; 4],
    relative: bool,
    e_relative: bool,
    inches: bool,
    feedrate: f64,
    wiping: bool,
    layer: u32,
    segment: usize,
    line: usize,
    bbl: bool,
    measure_g29: bool,
    filaments: usize,
    filament_map: Vec<usize>,
    extruder: Option<usize>,
    filament_of: Vec<Option<usize>>,
    last_filament_of: Vec<Option<usize>>,
    unloaded: bool,
    load_time: f64,
    unload_time: f64,
    change_time: f64,
    retract_length: Vec<f64>,
    retract_speed: Vec<f64>,
    deretract_speed: Vec<f64>,
    restart_extra: Vec<f64>,
    /// The current feature ([`Machine::role_id`]), whether it is `Custom`, whether a motion line has been read
    /// yet, and whether the moves belong to the start sequence.
    role: u16,
    custom: bool,
    moved: bool,
    prepare: bool,
}

/// A printer retraction list by filament: the printer's, with each filament's own `filament_` value in its place
/// when one filament overrides it.
fn retract_list(cfg: &PrintConfig, key: &str, filaments: usize) -> Vec<f64> {
    let base = raw_list(cfg, key);
    let slots = 1..=u8::try_from(filaments.clamp(1, 64)).unwrap_or(1);
    if slots.clone().all(|s| cfg.filament_override(key, s).is_none()) {
        return base;
    }
    slots
        .map(|s| {
            let f = cfg.for_filament(s);
            match key {
                "retraction_length" => f.retraction_length,
                "retraction_speed" => f.retraction_speed,
                "deretraction_speed" => f.deretraction_speed,
                _ => f.retract_restart_extra,
            }
        })
        .collect()
}

fn raw_list(cfg: &PrintConfig, key: &str) -> Vec<f64> {
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
            })
            .collect(),
        Some(serde_json::Value::String(s)) => s.split(',').filter_map(|t| t.trim().parse().ok()).collect(),
        Some(v) => v.as_f64().into_iter().collect(),
        None => Vec::new(),
    }
}

fn list_len(cfg: &PrintConfig, key: &str) -> usize {
    match cfg.raw.get(key) {
        Some(serde_json::Value::Array(a)) => a.len(),
        Some(serde_json::Value::String(s)) if key.ends_with("colour") || key.ends_with("color") => {
            s.split([',', ';']).filter(|t| !t.trim().is_empty()).count()
        }
        Some(serde_json::Value::String(s)) => s.split(',').count(),
        Some(_) => 1,
        None => 0,
    }
}

fn at(list: &[f64], i: usize, fallback: f64) -> f64 {
    list.get(i).or(list.first()).copied().unwrap_or(fallback)
}

/// One G-code word's value: `X12.5` read for `X`. A letter with nothing after it has no value, as
/// the firmware reads it (Marlin's `parser.seenval`). Orca's processor reads it as 0 with `strtod`,
/// so Bambu's start G-code line `M221 S` (Bambu: push the soft endstop state) becomes zero flow for
/// the rest of the print in Orca's estimate, which drops the E jerk limit; the printer keeps its flow.
fn value(words: &[&str], key: u8) -> Option<f64> {
    value_of(words.iter().copied(), key)
}

/// [`value`] over the words as they come.
fn value_of<'a>(mut words: impl Iterator<Item = &'a str>, key: u8) -> Option<f64> {
    words.find_map(|w| {
        let b = w.as_bytes();
        let first = *b.first()?;
        if !first.eq_ignore_ascii_case(&key) {
            return None;
        }
        w.get(1..)?.parse::<f64>().ok()
    })
}

/// Lines read ahead at a time by [`estimate`].
const BLOCK: usize = 16_384;

/// A plain move's X, Y, Z, E and F, as [`Reader::line`] and [`Reader::g1`] read them.
type Move = [Option<f64>; 5];

/// The words of a `G0` or `G1` line, read ahead of the reader (they depend on the line alone); `None` for any other
/// line, which the reader reads itself.
fn plain_move(line: &[u8]) -> Option<Move> {
    let text = std::str::from_utf8(line).ok()?.trim_start();
    if text.starts_with(';') {
        return None;
    }
    let code = text.split(';').next().unwrap_or("");
    let mut it = code.split_ascii_whitespace();
    let cmd = it.next()?;
    if !cmd.eq_ignore_ascii_case("G0") && !cmd.eq_ignore_ascii_case("G1") {
        return None;
    }
    let mut out = [None; 5];
    for (v, k) in out.iter_mut().zip(*b"XYZEF") {
        *v = value_of(it.clone(), k);
    }
    Some(out)
}

fn has(words: &[&str], key: u8) -> bool {
    words
        .iter()
        .any(|w| w.as_bytes().first().is_some_and(|c| c.eq_ignore_ascii_case(&key)))
}

const AXES: [u8; 4] = *b"XYZE";

impl Reader {
    fn new(cfg: &PrintConfig, per_line: Option<usize>) -> Self {
        let mut m = Machine::new(cfg);
        m.lines = per_line.map(|n| vec![0.0; n]);
        let printer_model = cfg
            .raw
            .get("printer_model")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let filaments = [
            "filament_diameter",
            "filament_colour",
            "filament_type",
            "nozzle_temperature",
        ]
        .iter()
        .map(|k| list_len(cfg, k))
        .max()
        .unwrap_or(1)
        .max(1);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "extruder numbers are small"
        )]
        let filament_map = raw_list(cfg, "filament_map")
            .iter()
            .map(|v| (v.round().max(1.0) as usize) - 1)
            .collect();
        Self {
            m,
            start: [0.0; 4],
            end: [0.0; 4],
            origin: [0.0; 4],
            relative: false,
            e_relative: false,
            inches: false,
            feedrate: 0.0,
            wiping: false,
            layer: 0,
            segment: 0,
            line: 0,
            bbl: cfg.gcode_flavor == GcodeFlavor::Bambu || printer_model.starts_with("Bambu Lab"),
            measure_g29: false,
            filaments,
            filament_map,
            extruder: None,
            filament_of: vec![None; 64],
            last_filament_of: vec![None; 64],
            unloaded: true,
            load_time: cfg.raw_number("machine_load_filament_time", 0.0),
            unload_time: cfg.raw_number("machine_unload_filament_time", 0.0),
            // Bambu Studio names the switch time `machine_switch_extruder_time` (its `extruder_change_times`).
            change_time: match cfg.raw.get("machine_tool_change_time") {
                Some(_) => cfg.raw_number("machine_tool_change_time", 0.0),
                None => cfg.raw_number("machine_switch_extruder_time", 0.0),
            },
            retract_length: retract_list(cfg, "retraction_length", filaments),
            retract_speed: retract_list(cfg, "retraction_speed", filaments),
            deretract_speed: retract_list(cfg, "deretraction_speed", filaments),
            restart_extra: retract_list(cfg, "retract_restart_extra", filaments),
            role: 0,
            custom: false,
            moved: false,
            prepare: false,
        }
    }

    /// Where a wait read now is booked.
    fn book(&self) -> Book {
        Book {
            segment: self.segment,
            line: self.line,
            first: self.layer <= 1,
        }
    }

    /// The feature a move of `kind` counts under: travel has none, except in the start and end G-code.
    fn role_of(&self, kind: Kind) -> u16 {
        if kind == Kind::Travel && !self.custom {
            0
        } else {
            self.role
        }
    }

    fn scale(&self) -> f64 {
        if self.inches { 25.4 } else { 1.0 }
    }

    fn axis_target(&self, a: usize, v: Option<f64>) -> f64 {
        let start = self.start.get(a).copied().unwrap_or(0.0);
        let Some(v) = v else { return start };
        let rel = self.relative || (a == 3 && self.e_relative);
        let v = v * self.scale();
        if rel {
            start + v
        } else {
            self.origin.get(a).copied().unwrap_or(0.0) + v
        }
    }

    fn delay(&mut self, extra: f64) {
        if extra > 0.0 {
            if self.m.segments.len() <= self.segment {
                self.m.segments.resize(self.segment + 1, 0.0);
            }
            if let Some(segment) = self.m.segments.get_mut(self.segment) {
                *segment += extra;
            }
            if self.layer <= 1 {
                self.m.first_layer += extra;
            }
            if let Some(slot) = self.m.lines.as_mut().and_then(|l| l.get_mut(self.line)) {
                *slot += extra;
            }
        }
    }

    fn sync(&mut self, extra: f64) {
        self.delay(extra);
        let book = self.book();
        self.m.synchronize(extra, Kind::Noop, book);
    }

    /// `process_G1`: a straight move to absolute `target`, with the feed rate in mm/min when given.
    fn move_to(&mut self, target: [f64; 4], feed: Option<f64>) {
        self.plan_move(target, feed, None);
    }

    fn plan_move(&mut self, target: [f64; 4], feed: Option<f64>, curve: Option<CurveMotion>) {
        self.end = target;
        if let Some(f) = feed {
            self.feedrate = f / 60.0;
        }
        let d: [f64; 4] = [
            self.end[0] - self.start[0],
            self.end[1] - self.start[1],
            self.end[2] - self.start[2],
            self.end[3] - self.start[3],
        ];
        if curve.is_none() && d.iter().all(|v| *v == 0.0) {
            return;
        }
        let xyz = curve.is_some() || d[0] != 0.0 || d[1] != 0.0 || d[2] != 0.0;
        let kind = if self.wiping {
            Kind::Wipe
        } else if d[3] < 0.0 {
            if xyz { Kind::Travel } else { Kind::Retract }
        } else if d[3] > 0.0 {
            if curve.is_none() && d[0] == 0.0 && d[1] == 0.0 {
                if d[2] == 0.0 {
                    Kind::Unretract
                } else {
                    Kind::Travel
                }
            } else {
                Kind::Extrude
            }
        } else if xyz {
            Kind::Travel
        } else {
            Kind::Noop
        };
        let sq = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        let distance = curve.map_or_else(|| if sq > 0.0 { sq.sqrt() } else { d[3].abs() }, |c| c.distance);
        if self.m.fw == Fw::Klipper {
            self.klipper_move(kind, d, distance, xyz && sq > 0.0);
            return;
        }
        if self.m.bbl {
            self.bbl_move(kind, d, distance);
            return;
        }
        // curved axes use their peak speed share, not the endpoint chord.
        let envelope_delta = curve.map_or(d, |c| [c.plane, c.plane, d[2], d[3]]);
        let inv = 1.0 / distance;
        let extrusion_only = !xyz && d[3] != 0.0;
        let role = self.role_of(kind);
        let prepare = self.prepare;
        let m = &mut self.m;
        let mut curr = Motion {
            feedrate: if d[3] == 0.0 {
                self.feedrate.max(m.env.min_travel)
            } else {
                self.feedrate.max(m.env.min_extruding)
            },
            ..Motion::default()
        };
        let norm = sq.sqrt();
        curr.dir = if extrusion_only || norm == 0.0 {
            [d[0], d[1], d[2]]
        } else {
            [d[0] / norm, d[1] / norm, d[2] / norm]
        };
        if let Some(c) = curve {
            curr.dir = c.enter;
            let requested = if kind == Kind::Travel {
                m.travel
            } else {
                m.acceleration
            };
            let radial = requested.min(m.env.accel[0]).min(m.env.accel[1]);
            curr.feedrate = curr
                .feedrate
                .min((radial * c.radius).sqrt() * c.distance / c.plane);
        }
        let prev = m.prev;
        // Centripetal limit on gentle corners (Bambu's planner).
        if curve.is_none()
            && (prev.dir[0] != 0.0 || prev.dir[1] != 0.0)
            && (curr.dir[0] != 0.0 || curr.dir[1] != 0.0)
        {
            let unit = |v: [f64; 3]| {
                let l = v[0].m_hypot(v[1]);
                [v[0] / l, v[1] / l]
            };
            let (v1, v2) = (unit(prev.dir), unit(curr.dir));
            let diff = (v2[0] - v1[0]).m_hypot(v2[1] - v1[1]);
            if diff < 0.5 && diff > 0.00001 {
                let dot = v1[0] * v2[0] + v1[1] * v2[1];
                let cross = v1[0] * v2[1] - v1[1] * v2[0];
                let angle = cross.m_atan2(dot);
                let sin_half = ((1.0 - angle.m_cos()) * 0.5).sqrt();
                let r = d[0].m_hypot(d[1]) * 0.5 / sin_half;
                curr.feedrate = curr.feedrate.min((m.acceleration * r).sqrt());
            }
        }
        let mut factor = 1.0f64;
        for ((axis, index), (dv, max)) in curr
            .axis
            .iter_mut()
            .zip(0..4)
            .zip(envelope_delta.iter().zip(m.env.speed))
        {
            *axis = curr.feedrate * dv * inv;
            if index == 3 {
                *axis *= m.e_factor;
            }
            let a = axis.abs();
            if a != 0.0 && max != 0.0 {
                factor = factor.min(max / a);
            }
        }
        curr.feedrate *= factor;
        let cruise = curr.feedrate;
        if factor < 1.0 {
            for a in &mut curr.axis {
                *a *= factor;
            }
        }
        let mut acceleration = if kind == Kind::Travel {
            m.travel
        } else if extrusion_only {
            m.retract
        } else {
            m.acceleration
        };
        for (dv, max) in envelope_delta.iter().zip(m.env.accel) {
            let share = dv.abs() * inv;
            if acceleration * share > max {
                acceleration = max / share;
            }
        }
        let jerk = m.axis_jerk();
        curr.safe = cruise;
        for (axis, (a, j)) in curr.axis.iter().zip(jerk).enumerate() {
            if a.abs() > j {
                // convert the filament limit to path speed for a mixed move.
                let limit = if axis == 3 { cruise * j / a.abs() } else { j };
                curr.safe = curr.safe.min(limit);
            }
        }
        let mut vmax = curr.safe;
        if !m.blocks.is_empty() && prev.feedrate > 0.0001 {
            let prev_larger = prev.feedrate > cruise;
            let smaller = if prev_larger {
                cruise / prev.feedrate
            } else {
                prev.feedrate / cruise
            };
            vmax = if prev_larger { cruise } else { prev.feedrate };
            let mut v_factor = 1.0f64;
            let mut limited = false;
            // X, Y and Z together on the velocity vector.
            let scale = if prev_larger { smaller } else { 1.0 };
            let mut jv = [
                (cruise * curr.dir[0] - prev.feedrate * prev.dir[0] * scale).abs(),
                (cruise * curr.dir[1] - prev.feedrate * prev.dir[1] * scale).abs(),
                (cruise * curr.dir[2] - prev.feedrate * prev.dir[2] * scale).abs(),
            ];
            let max_xyz = if m.uses_jd() {
                [
                    m.jd_jerk(m.env.accel[0]),
                    m.jd_jerk(m.env.accel[1]),
                    m.jd_jerk(m.env.accel[2]),
                ]
            } else {
                [m.env.jerk[0], m.env.jerk[1], m.env.jerk[2]]
            };
            for i in 0..3 {
                let (Some(&j), Some(&lim)) = (jv.get(i), max_xyz.get(i)) else {
                    continue;
                };
                if j > lim {
                    v_factor *= lim / j;
                    for x in &mut jv {
                        *x *= v_factor;
                    }
                    limited = true;
                }
            }
            // E on its own.
            let mut v_exit = prev.axis[3];
            let mut v_entry = curr.axis[3];
            if prev_larger {
                v_exit *= smaller;
            }
            if limited {
                v_exit *= v_factor;
                v_entry *= v_factor;
            }
            let e_jerk = if v_exit > v_entry {
                if v_entry > 0.0 || v_exit < 0.0 {
                    v_exit - v_entry
                } else {
                    v_exit.max(-v_entry)
                }
            } else if v_entry < 0.0 || v_exit > 0.0 {
                v_entry - v_exit
            } else {
                (-v_exit).max(v_entry)
            };
            if e_jerk > jerk[3] {
                v_factor *= jerk[3] / e_jerk;
                limited = true;
            }
            if limited {
                vmax *= v_factor;
            }
            let threshold = vmax * 0.99;
            if prev.safe > threshold && curr.safe > threshold {
                vmax = curr.safe;
            }
        }
        let allowable = max_allowable_speed(-acceleration, curr.safe, distance);
        let mut block = Block {
            kind,
            distance,
            acceleration,
            entry: vmax.min(allowable),
            cruise,
            exit: curr.safe,
            max_entry: vmax,
            safe: curr.safe,
            nominal_length: cruise <= allowable,
            recalculate: true,
            trap: Trapezoid::default(),
            layer: self.layer.max(1),
            segment: self.segment,
            line: self.line,
            limit: cruise,
            smooth: 0.0,
            smooth_entry: 0.0,
            smooth_max: f64::INFINITY,
            role,
            prepare,
        };
        block.calculate_trapezoid();
        if let Some(c) = curve {
            curr.dir = c.exit;
            for (axis, direction) in curr.axis.iter_mut().zip(c.exit) {
                *axis = cruise * direction;
            }
        }
        m.prev = curr;
        m.blocks.push(block);
        if m.blocks.len() > REFRESH {
            m.calculate(QUEUE, 0.0, Kind::Noop, false);
        }
    }

    /// A straight move as Klipper plans it (see the module notes); `d` is the move in X, Y, Z and E.
    fn klipper_move(&mut self, kind: Kind, d: [f64; 4], distance: f64, xyz: bool) {
        let role = self.role_of(kind);
        let prepare = self.prepare;
        let m = &mut self.m;
        let mut top = self.feedrate;
        let mut acceleration = m.acceleration;
        let mut curr = Motion {
            xyz,
            ..Motion::default()
        };
        if xyz {
            top = top.min(m.env.speed[0]);
            let climb = d[2].abs() / distance;
            if climb > 0.0 {
                if m.env.speed[2] > 0.0 {
                    top = top.min(m.env.speed[2] / climb);
                }
                if m.env.accel[2] > 0.0 {
                    acceleration = acceleration.min(m.env.accel[2] / climb);
                }
            }
            curr.dir = [d[0] / distance, d[1] / distance, d[2] / distance];
            curr.e_ratio = d[3] * m.e_factor / distance;
        } else {
            top = top.min(m.klipper.extrude_only_speed);
            acceleration = m.klipper.extrude_only_accel;
        }
        let prev = m.prev;
        let junction = if m.blocks.is_empty() || !xyz || !prev.xyz {
            0.0
        } else {
            let cos = prev.dir[0] * curr.dir[0] + prev.dir[1] * curr.dir[1] + prev.dir[2] * curr.dir[2];
            let mut v2 = corner_speed2(m.env.jerk[0], cos);
            let change = (curr.e_ratio - prev.e_ratio).abs();
            if change > 1e-12 {
                let e = KLIPPER_EXTRUDER_CORNER / change;
                v2 = v2.min(e * e);
            }
            v2.sqrt()
        };
        curr.feedrate = top;
        m.prev = curr;
        m.blocks.push(Block {
            kind,
            distance,
            acceleration,
            entry: 0.0,
            cruise: top,
            exit: 0.0,
            max_entry: junction,
            safe: 0.0,
            nominal_length: false,
            recalculate: true,
            trap: Trapezoid::default(),
            layer: self.layer.max(1),
            segment: self.segment,
            line: self.line,
            limit: top,
            smooth: m.klipper.smooth(acceleration),
            smooth_entry: 0.0,
            smooth_max: f64::INFINITY,
            role,
            prepare,
        });
        if m.blocks.len() > REFRESH {
            m.calculate(QUEUE, 0.0, Kind::Noop, false);
        }
    }

    fn g1(&mut self, words: &[&str]) {
        let mut target = [0.0; 4];
        for (i, (t, k)) in target.iter_mut().zip(AXES).enumerate() {
            *t = self.axis_target(i, value(words, k));
        }
        self.move_to(target, value(words, b'F'));
    }

    /// [`Self::line`] for a `G0` or `G1` line read ahead ([`plain_move`]).
    fn plain(&mut self, m: &Move) {
        self.start = self.end;
        self.moved = true;
        let mut target = [0.0; 4];
        for (i, (t, v)) in target.iter_mut().zip(m).enumerate() {
            *t = self.axis_target(i, *v);
        }
        self.move_to(target, m[4]);
    }

    /// `process_G2_G3`: an arc in the segments the firmware cuts it into.
    fn arc(&mut self, words: &[&str], clockwise: bool) {
        let mut end = [0.0; 4];
        for (i, (t, k)) in end.iter_mut().zip(AXES).enumerate() {
            *t = self.axis_target(i, value(words, k));
        }
        let (sx, sy) = (self.start[0], self.start[1]);
        let rel_center = if has(words, b'R') {
            let Some(r) = value(words, b'R').filter(|r| *r != 0.0) else {
                return;
            };
            let (vx, vy) = (end[0] - sx, end[1] - sy);
            let q2 = vx * vx + vy * vy;
            if q2 <= 0.0 {
                return;
            }
            let t2 = r * r / q2 - 0.25;
            let t = if t2 > 0.0 { t2.sqrt() } else { 0.0 };
            let (mx, my) = (f64::midpoint(sx, end[0]), f64::midpoint(sy, end[1]));
            let (px, py) = (-vy * t, vx * t);
            let c = if (r > 0.0) == clockwise {
                (mx - px, my - py)
            } else {
                (mx + px, my + py)
            };
            (c.0 - sx, c.1 - sy)
        } else {
            let (i, j) = (value(words, b'I'), value(words, b'J'));
            if i.is_none() && j.is_none() {
                return;
            }
            (i.unwrap_or(0.0) * self.scale(), j.unwrap_or(0.0) * self.scale())
        };
        let center = (sx + rel_center.0, sy + rel_center.1);
        let rs = (sx - center.0, sy - center.1);
        let re = (end[0] - center.0, end[1] - center.1);
        let full = (end[0] - sx).abs() < 1e-4 && (end[1] - sy).abs() < 1e-4;
        let angle = if full {
            if clockwise {
                -std::f64::consts::TAU
            } else {
                std::f64::consts::TAU
            }
        } else {
            let mut a = (rs.0 * re.1 - rs.1 * re.0).m_atan2(rs.0 * re.0 + rs.1 * re.1);
            if a < 0.0 {
                a += std::f64::consts::TAU;
            }
            if clockwise {
                a -= std::f64::consts::TAU;
            }
            a
        };
        let start_radius = rs.0.m_hypot(rs.1);
        let dz = end[2] - self.start[2];
        let length = angle * start_radius;
        if length.m_hypot(dz) < 0.001 {
            return;
        }
        let feed = value(words, b'F');
        let extrusion = has(words, b'E').then(|| end[3] - self.start[3]);
        if self.bbl && self.m.fw == Fw::MarlinLegacy && start_radius > 0.0 {
            let plane = length.abs();
            let distance = plane.m_hypot(dz);
            let sense = if clockwise { -1.0 } else { 1.0 };
            let tangent = |radial: (f64, f64)| {
                let radius = radial.0.m_hypot(radial.1);
                [
                    -sense * radial.1 / radius * plane / distance,
                    sense * radial.0 / radius * plane / distance,
                    dz / distance,
                ]
            };
            if re.0.m_hypot(re.1) > 0.0 && plane > 0.0 {
                let curve = CurveMotion {
                    distance,
                    plane,
                    radius: start_radius,
                    enter: tangent(rs),
                    exit: tangent(re),
                };
                self.plan_move(end, feed, Some(curve));
                return;
            }
        }
        let segments = if self.m.fw == Fw::Marlin2 {
            let feed_mm_s = feed.map_or(self.feedrate, |f| f / 60.0);
            let radius = rel_center.0.m_hypot(rel_center.1);
            let seg = (8.0 * radius * 0.02).sqrt().min(feed_mm_s / 50.0).clamp(0.1, 2.0);
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a segment count"
            )]
            let n = (radius * angle.abs() / seg + 0.8) as usize;
            n.max(1)
        } else if self.m.fw == Fw::Klipper {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a segment count"
            )]
            let n = (length.abs() / KLIPPER_ARC_SEGMENT).floor() as usize;
            n.max(1)
        } else {
            arc_steps(start_radius, angle.abs(), 0.0125)
        };
        #[allow(clippy::cast_precision_loss, reason = "a segment count")]
        let per = 1.0 / segments as f64;
        let theta = angle * per;
        let z_per = dz * per;
        let e_per = extrusion.map_or(0.0, |e| e * per);
        let (cos_t, sin_t) = if matches!(self.m.fw, Fw::Marlin2 | Fw::Klipper) {
            (theta.m_cos(), theta.m_sin())
        } else {
            (1.0 - 0.5 * theta * theta, theta - theta * theta * theta / 6.0)
        };
        let mut r = (-rel_center.0, -rel_center.1);
        let mut target = [self.start[0], self.start[1], self.start[2], self.start[3]];
        let mut count = 25usize;
        for i in 1..segments {
            let correct = if self.m.fw == Fw::Marlin2 {
                count -= 1;
                count == 0
            } else {
                let c = count == 0;
                count = count.saturating_sub(1);
                c
            };
            if correct {
                count = 25;
                #[allow(clippy::cast_precision_loss, reason = "a segment count")]
                let ti = i as f64 * theta;
                r = (
                    -rel_center.0 * ti.m_cos() + rel_center.1 * ti.m_sin(),
                    -rel_center.0 * ti.m_sin() - rel_center.1 * ti.m_cos(),
                );
            } else {
                r = (r.0 * cos_t - r.1 * sin_t, r.0 * sin_t + r.1 * cos_t);
            }
            target[0] = center.0 + r.0;
            target[1] = center.1 + r.1;
            target[2] += z_per;
            target[3] += e_per;
            self.start = self.end;
            let mut t = target;
            if extrusion.is_none() {
                t[3] = self.start[3];
            }
            self.move_to(t, if i == 1 { feed } else { None });
        }
        self.start = self.end;
        let mut t = end;
        if extrusion.is_none() {
            t[3] = self.start[3];
        }
        self.move_to(t, if segments == 1 { feed } else { None });
    }

    fn filament_change(&mut self, id: usize) {
        if self.m.bbl {
            self.bbl_filament_change(id);
            return;
        }
        let next_extruder = self.filament_map.get(id).copied().unwrap_or(0);
        let prev_extruder = self.extruder;
        let prev_filament = prev_extruder.and_then(|e| self.filament_of.get(e).copied().flatten());
        if prev_filament == Some(id) {
            return;
        }
        if let Some(slot) = prev_extruder.and_then(|e| self.last_filament_of.get_mut(e)) {
            *slot = prev_filament;
        }
        let load = |unloaded: bool, t: f64| if unloaded { 0.0 } else { t };
        let mut extra = 0.0;
        if prev_extruder == Some(next_extruder) {
            if let Some(s) = self.filament_of.get_mut(next_extruder) {
                *s = Some(id);
            }
            extra += load(self.unloaded, self.unload_time);
            self.unloaded = false;
            extra += load(self.unloaded, self.load_time);
        } else if prev_extruder.is_none() {
            self.extruder = Some(next_extruder);
            if let Some(s) = self.filament_of.get_mut(next_extruder) {
                *s = Some(id);
            }
            self.unloaded = false;
            extra += load(self.unloaded, self.load_time);
        } else {
            self.extruder = Some(next_extruder);
            match self.last_filament_of.get(next_extruder).copied().flatten() {
                None => {
                    if let Some(s) = self.filament_of.get_mut(next_extruder) {
                        *s = Some(id);
                    }
                    self.unloaded = false;
                    extra += load(self.unloaded, self.load_time);
                }
                Some(f) if f != id => {
                    if let Some(s) = self.filament_of.get_mut(next_extruder) {
                        *s = Some(id);
                    }
                    extra += load(self.unloaded, self.unload_time);
                    self.unloaded = false;
                    extra += load(self.unloaded, self.load_time);
                }
                Some(_) => {}
            }
            extra += self.change_time;
        }
        self.change_stop(extra);
    }

    /// A zero length move of feature `Flush` that takes the stop of a filament change, so the delay lands on the
    /// change itself.
    fn change_stop(&mut self, extra: f64) {
        let role = self.m.role_id("Flush");
        let mut b = Block {
            kind: Kind::ToolChange,
            distance: 0.0,
            acceleration: 0.0,
            entry: 0.0,
            cruise: 0.0,
            exit: 0.0,
            max_entry: 0.0,
            safe: 0.0,
            nominal_length: false,
            recalculate: false,
            trap: Trapezoid::default(),
            layer: self.layer.max(1),
            segment: self.segment,
            line: self.line,
            limit: 0.0,
            smooth: 0.0,
            smooth_entry: 0.0,
            smooth_max: 0.0,
            role,
            prepare: self.prepare,
        };
        b.calculate_trapezoid();
        self.m.blocks.push(b);
        self.delay(extra);
        let book = self.book();
        self.m.synchronize(extra, Kind::ToolChange, book);
    }

    fn tool(&mut self, cmd: &str) {
        let digits: String = cmd
            .get(1..)
            .unwrap_or("")
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let Ok(id) = digits.parse::<usize>() else { return };
        if id > 254 || id >= self.filaments {
            return;
        }
        self.filament_change(id);
    }

    fn tag(&mut self, comment: &str) {
        let c = comment.trim_end();
        if let Some(name) = c.trim_start().strip_prefix("FEATURE:") {
            let name = name.trim();
            // Bambu Studio lists the floating vertical shell with the internal solid infill.
            let name = if name == "Floating vertical shell" {
                "Internal solid infill"
            } else {
                name
            };
            self.custom = name == "Custom";
            self.prepare = self.custom && !self.moved;
            self.role = self.m.role_id(name);
        } else if c.starts_with("@L ") {
            self.segment += 1;
        } else if c == "LAYER_CHANGE" || c == " CHANGE_LAYER" {
            self.layer += 1;
        } else if let Some(t) = c.trim_start().strip_prefix("MANUAL_TOOL_CHANGE ") {
            // A tool change written as a comment (`manual_filament_change`) still changes the filament.
            self.tool(t.trim());
        } else if let Some(rest) = c.strip_prefix("VG1 ") {
            // Bambu Studio's H2D change template writes the in-printer flush as comment lines the printer skips
            // (`;VG1 E<length> F<feed>`); its estimate times each as a move of the extruder alone. The position
            // stays where it was.
            let words: Vec<&str> = rest.split_ascii_whitespace().collect();
            if let Some(len) = value(&words, b'E').filter(|l| *l != 0.0) {
                let (e, feed) = (self.start[3], self.feedrate);
                let mut target = self.start;
                target[3] = e + len * self.scale();
                self.move_to(target, value(&words, b'F'));
                self.end[3] = e;
                self.feedrate = feed;
            }
        } else if c.starts_with(" WIPE_START") || c.starts_with("WIPE_START") {
            self.wiping = true;
        } else if c.starts_with(" WIPE_END") || c.starts_with("WIPE_END") {
            self.wiping = false;
        } else if c.starts_with(" COLOR_CHANGE") || c.starts_with("COLOR_CHANGE") {
            let mut parts = c.split(',').filter(|p| !p.is_empty());
            let _ = parts.next();
            let filament = parts
                .next()
                .and_then(|t| t.strip_prefix('T'))
                .and_then(|t| t.trim().parse::<usize>().ok())
                .unwrap_or(0);
            let current = self
                .extruder
                .and_then(|e| self.filament_of.get(e).copied().flatten())
                .unwrap_or(0);
            if current == filament {
                self.sync(0.0);
            }
        } else if c == " PAUSE_PRINTING" || c == "PAUSE_PRINT" {
            self.sync(0.0);
        }
    }

    fn line(&mut self, raw: &str) {
        self.start = self.end;
        let text = raw.trim_start();
        if let Some(comment) = text.strip_prefix(';') {
            self.tag(comment);
            return;
        }
        let code = text.split(';').next().unwrap_or("");
        let mut it = code.split_ascii_whitespace();
        let Some(cmd) = it.next() else { return };
        // The words after the command: on the stack for a usual line, on the heap past 16 of them.
        let mut few: [&str; 16] = [""; 16];
        let mut many: Vec<&str> = Vec::new();
        let mut count = 0;
        for w in it {
            if let Some(slot) = few.get_mut(count).filter(|_| many.is_empty()) {
                *slot = w;
            } else {
                if many.is_empty() {
                    many.extend_from_slice(&few);
                }
                many.push(w);
            }
            count += 1;
        }
        let words: &[&str] = if many.is_empty() {
            few.get(..count).unwrap_or(&[])
        } else {
            &many
        };
        if self.m.fw == Fw::Klipper && cmd.eq_ignore_ascii_case("SET_VELOCITY_LIMIT") {
            self.velocity_limit(code);
            return;
        }
        if cmd.len() > 1
            && cmd
                .as_bytes()
                .first()
                .is_some_and(|c| c.eq_ignore_ascii_case(&b'T'))
        {
            self.tool(cmd);
            return;
        }
        let upper: std::borrow::Cow<'_, str> = if cmd.bytes().any(|b| b.is_ascii_lowercase()) {
            cmd.to_ascii_uppercase().into()
        } else {
            cmd.into()
        };
        if self.m.fw == Fw::Klipper {
            match upper.as_ref() {
                // Not Klipper commands: the firmware reports them as unknown and moves on.
                "M201" | "M203" | "M205" | "M566" => return,
                // `M204 S`, or `M204 P T` as the smaller of the two; P or T alone does nothing.
                "M204" => {
                    let a = value(words, b'S')
                        .or_else(|| value(words, b'P').zip(value(words, b'T')).map(|(p, t)| p.min(t)));
                    if let Some(a) = a {
                        self.m.acceleration = self.m.klipper.accel(a);
                        self.m.travel = self.m.acceleration;
                    }
                    return;
                }
                _ => {}
            }
        }
        if matches!(upper.as_ref(), "G0" | "G1" | "G2" | "G3" | "G28") {
            self.moved = true;
        }
        if self.m.bbl && self.bbl_line(upper.as_ref(), words) {
            return;
        }
        match upper.as_ref() {
            "G0" | "G1" => self.g1(words),
            "G2" => self.arc(words, true),
            "G3" => self.arc(words, false),
            "G4" | "M400" => {
                if let Some(s) = value(words, b'S') {
                    self.sync(s);
                } else if let Some(p) = value(words, b'P') {
                    self.sync(p * 0.001);
                }
            }
            "G10" | "G11" => self.firmware_retract(upper == "G10"),
            "G20" => self.inches = true,
            "G21" => self.inches = false,
            "G28" => {
                let any = has(words, b'X') || has(words, b'Y') || has(words, b'Z');
                let mut target = self.start;
                for (i, k) in b"XYZ".iter().enumerate() {
                    if (!any || has(words, *k))
                        && let Some(t) = target.get_mut(i)
                    {
                        *t = self.axis_target(i, Some(0.0));
                    }
                }
                self.move_to(target, None);
            }
            "G29" => {
                if !self.bbl || self.measure_g29 {
                    self.sync(260.0);
                }
            }
            "G90" => self.relative = false,
            "G91" => self.relative = true,
            "G92" => self.set_position(words),
            "M1" => self.sync(0.0),
            "M82" => self.e_relative = false,
            "M83" => self.e_relative = true,
            "M191" => {
                if value(words, b'S').is_some_and(|t| t > 40.0) {
                    self.sync(720.0);
                }
            }
            "M201" => {
                for (a, k) in self.m.env.accel.iter_mut().zip(AXES) {
                    if let Some(v) = value(words, k) {
                        *a = v;
                    }
                }
            }
            "M203" => {
                if self.m.fw != Fw::Repetier {
                    let f = if matches!(
                        self.m.fw,
                        Fw::MarlinLegacy | Fw::Marlin2 | Fw::Smoothie | Fw::Klipper
                    ) {
                        1.0
                    } else {
                        1.0 / 60.0
                    };
                    for (s, k) in self.m.env.speed.iter_mut().zip(AXES) {
                        if let Some(v) = value(words, k) {
                            *s = v * f;
                        }
                    }
                }
            }
            "M204" => {
                if let Some(s) = value(words, b'S') {
                    self.m.set_acceleration(s);
                    self.m.set_travel(s);
                    if let Some(t) = value(words, b'T') {
                        self.m.set_retract(t);
                    }
                } else {
                    if let Some(p) = value(words, b'P') {
                        self.m.set_acceleration(p);
                    }
                    if let Some(r) = value(words, b'R') {
                        self.m.set_retract(r);
                    }
                    if let Some(t) = value(words, b'T') {
                        self.m.set_travel(t);
                    }
                }
            }
            "M205" => {
                let env = &mut self.m.env;
                if let Some(x) = value(words, b'X') {
                    env.jerk[0] = x;
                    env.jerk[1] = x;
                }
                if let Some(y) = value(words, b'Y') {
                    env.jerk[1] = y;
                }
                if let Some(z) = value(words, b'Z') {
                    env.jerk[2] = z;
                }
                if let Some(e) = value(words, b'E') {
                    env.jerk[3] = e;
                }
                if let Some(s) = value(words, b'S') {
                    env.min_extruding = s;
                }
                if let Some(t) = value(words, b'T') {
                    env.min_travel = t;
                }
                if let Some(j) = value(words, b'J') {
                    env.junction_deviation = j;
                }
            }
            "M221" => {
                if let (Some(s), false) = (value(words, b'S'), has(words, b'T')) {
                    self.m.e_factor = s * 0.01;
                }
            }
            "M566" => {
                for (j, k) in self.m.env.jerk.iter_mut().zip(AXES) {
                    if let Some(v) = value(words, k) {
                        *j = v / 60.0;
                    }
                }
            }
            "M622" => {
                if value(words, b'J').is_some_and(|j| (j.round() - 1.0).abs() < 0.5) {
                    self.measure_g29 = true;
                }
            }
            "M623" => self.measure_g29 = false,
            "M702" => {
                if has(words, b'C') {
                    self.unloaded = true;
                    self.sync(0.0);
                }
            }
            "SYNC" => {
                if let Some(t) = value(words, b'T') {
                    self.sync(t);
                }
            }
            _ => {}
        }
    }

    /// Klipper's `SET_VELOCITY_LIMIT`: the square corner velocity (kept as the X and Y jerk), the
    /// acceleration of every move, the top speed, and the minimum cruise ratio or the older explicit
    /// `ACCEL_TO_DECEL`. The acceleration and top speed stay under the profile's machine limits when it
    /// sets them (see [`KlipperState`]).
    fn velocity_limit(&mut self, code: &str) {
        let find = |key: &str| {
            code.split_ascii_whitespace().find_map(|w| {
                let (k, v) = w.split_once('=')?;
                if k.eq_ignore_ascii_case(key) {
                    Some(v.parse::<f64>().unwrap_or(0.0))
                } else {
                    None
                }
            })
        };
        if let Some(j) = find("SQUARE_CORNER_VELOCITY") {
            self.m.env.jerk[0] = j;
            self.m.env.jerk[1] = j;
        }
        if let Some(a) = find("ACCEL") {
            self.m.acceleration = self.m.klipper.accel(a);
            self.m.travel = self.m.acceleration;
        }
        if let Some(v) = find("VELOCITY") {
            let v = self.m.klipper.speed(v);
            self.m.env.speed[0] = v;
            self.m.env.speed[1] = v;
        }
        if let Some(r) = find("MINIMUM_CRUISE_RATIO") {
            self.m.klipper.cruise_ratio = r.clamp(0.0, 1.0);
            self.m.klipper.accel_to_decel = None;
        }
        if let Some(a) = find("ACCEL_TO_DECEL") {
            self.m.klipper.accel_to_decel = Some(a);
        }
    }

    fn set_position(&mut self, words: &[&str]) {
        let s = self.scale();
        let mut any = false;
        for ((o, e), k) in self.origin.iter_mut().zip(self.end).zip(AXES).take(3) {
            if let Some(v) = value(words, k) {
                *o = e - v * s;
                any = true;
            }
        }
        if let Some(e) = value(words, b'E') {
            self.end[3] = e * s;
            any = true;
        } else {
            self.sync(0.0);
        }
        let unknown = words.iter().any(|w| {
            w.as_bytes()
                .first()
                .is_some_and(|c| !matches!(c.to_ascii_uppercase(), b'X' | b'Y' | b'Z' | b'E' | b'F'))
        });
        if !any && !unknown {
            self.origin = self.end;
        }
    }

    fn firmware_retract(&mut self, retract: bool) {
        let tool = self.extruder.unwrap_or(0);
        let len = at(&self.retract_length, tool, 0.8);
        let (e, speed) = if retract {
            (-len, at(&self.retract_speed, tool, 30.0))
        } else {
            (
                len + at(&self.restart_extra, tool, 0.0),
                at(&self.deretract_speed, tool, at(&self.retract_speed, tool, 30.0)),
            )
        };
        let mut target = self.start;
        target[3] = self.axis_target(3, Some(e / self.scale()));
        self.move_to(target, Some(speed * 60.0));
    }
}

/// Segments Orca cuts an arc into for the time estimate (`ArcWelder::arc_discretization_steps`).
fn arc_steps(radius: f64, angle: f64, deviation: f64) -> usize {
    let d = radius - deviation;
    if d < 1e-4 {
        if angle < std::f64::consts::PI
            || radius * (1.0 + (std::f64::consts::PI - 0.5 * angle).m_cos()) < deviation
        {
            1
        } else {
            2
        }
    } else {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a segment count"
        )]
        let n = (angle / (2.0 * (d / radius).m_acos())).ceil() as usize;
        n.max(1)
    }
}

/// The print time of `gcode` under the settings `cfg`; with `per_line`, also the time at each line.
pub fn estimate(gcode: &[u8], cfg: &PrintConfig, per_line: bool) -> Estimate {
    estimate_counting(gcode, cfg, per_line, bbl::COUNT_END_WAIT)
}

/// [`estimate`], with the Bambu Lab rules' end waits counted in the total or not (`count_end_wait`).
fn estimate_counting(gcode: &[u8], cfg: &PrintConfig, per_line: bool, count_end_wait: bool) -> Estimate {
    let line_count = if per_line {
        gcode.split(|&b| b == b'\n').count()
    } else {
        0
    };
    let mut r = Reader::new(cfg, per_line.then_some(line_count));
    // The moves' words are read a block ahead on other threads while the reader works through the block before, in
    // order: the times add up as they do line by line.
    let lines: Vec<&[u8]> = gcode.split(|&b| b == b'\n').collect();
    let blocks: Vec<&[&[u8]]> = lines.chunks(BLOCK).collect();
    let read = |k: usize| -> Vec<Option<Move>> {
        blocks
            .get(k)
            .map_or_else(Vec::new, |b| crate::par::map_fine(b, |l| plain_move(l)))
    };
    let mut ahead = read(0);
    for k in 0..blocks.len() {
        let block = blocks.get(k).copied().unwrap_or(&[]);
        let moves = std::mem::take(&mut ahead);
        let base = k * BLOCK;
        let ((), next) = crate::par::join(
            || {
                for (j, (line, m)) in block.iter().zip(&moves).enumerate() {
                    r.line = base + j;
                    match m {
                        Some(m) => r.plain(m),
                        None => match std::str::from_utf8(line) {
                            Ok(s) => r.line(s),
                            Err(_) => r.line(&String::from_utf8_lossy(line)),
                        },
                    }
                }
            },
            || read(k + 1),
        );
        ahead = next;
    }
    if r.m.bbl {
        r.m.bbl_finish(count_end_wait);
    } else {
        r.m.calculate(0, 0.0, Kind::Noop, true);
    }
    let mut segments = std::mem::take(&mut r.m.segments);
    if segments.len() <= r.segment {
        segments.resize(r.segment + 1, 0.0);
    }
    let lines = r.m.lines.take().map_or_else(Vec::new, |l| {
        let mut last = 0.0;
        l.into_iter()
            .map(|t| {
                last += t;
                last
            })
            .collect()
    });
    Estimate {
        total: r.m.time,
        first_layer: r.m.first_layer,
        segments,
        lines,
        features: std::mem::take(&mut r.m.features),
        travel: r.m.travel_time,
        prepare: r.m.prepare_time,
        end_wait: r.m.end_wait,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, serde_json::Value)]) -> PrintConfig {
        let mut c = PrintConfig::default();
        for (k, v) in pairs {
            c.raw.insert((*k).to_owned(), v.clone());
        }
        c
    }

    fn marlin() -> PrintConfig {
        let mut c = cfg(&[
            ("machine_max_acceleration_x", serde_json::json!([1000])),
            ("machine_max_acceleration_y", serde_json::json!([1000])),
            ("machine_max_acceleration_extruding", serde_json::json!([1000])),
            ("machine_max_jerk_x", serde_json::json!([10])),
            ("machine_max_jerk_y", serde_json::json!([10])),
        ]);
        c.gcode_flavor = GcodeFlavor::Marlin;
        c
    }

    #[test]
    fn a_long_straight_move_is_its_trapezoid() {
        // Out 100 mm and back at 50 mm/s and 1000 mm/s2: the reversal and both ends run at the 10 mm/s
        // jerk speed.
        let e = estimate(b"G1 X100 E1 F3000\nG1 X0 E2\n", &marlin(), false);
        let ramp = (50.0f64 * 50.0 - 10.0 * 10.0) / 2000.0;
        let one = 2.0 * (40.0 / 1000.0) + (100.0 - 2.0 * ramp) / 50.0;
        assert!((e.total - 2.0 * one).abs() < 1e-6, "{} vs {}", e.total, 2.0 * one);
    }

    #[test]
    fn extrusion_below_the_junction_limit_keeps_the_travel_time() {
        let prefix = "G90\nM83\nM201 X20000 Y20000 Z500 E5000\nM203 X1000 Y1000 Z30 E50\nM204 S1000 T1000\nM205 X9 Y9 Z3 E2.5\n";
        let travel = "G1 X20 Y0 F1500\nG1 X20 Y20 F6000\nG1 X0 Y20 F1500\nG1 X0 Y0 F6000\n";
        let extrude = "G1 X20 Y0 E2 F1500\nG1 X20 Y20 E2 F6000\nG1 X0 Y20 E2 F1500\nG1 X0 Y0 E2 F6000\n";
        let plain = estimate(
            format!("{prefix}{}G4 S0\n", travel.repeat(100)).as_bytes(),
            &marlin(),
            false,
        )
        .total;
        let with = estimate(
            format!("{prefix}{}G4 S0\n", extrude.repeat(100)).as_bytes(),
            &marlin(),
            false,
        )
        .total;
        // filament speed at the xy junction limit is 0.9 mm/s, below its 2.5 mm/s limit.
        assert!((with - plain).abs() < 0.01, "{with} vs {plain}");
    }

    #[test]
    fn extruder_safe_speed_uses_the_filament_to_path_ratio() {
        for (extrusion, expected) in [(2, 9.0), (40, 1.25)] {
            let mut r = Reader::new(&marlin(), None);
            for line in ["M83", "M203 X1000 Y1000 Z30 E50", "M205 X9 Y9 Z3 E2.5"] {
                r.line(line);
            }
            r.line(&format!("G1 X20 E{extrusion} F6000"));
            assert!(
                (r.m.prev.safe - expected).abs() < 1e-9,
                "{} vs {expected}",
                r.m.prev.safe
            );
        }
    }

    #[test]
    fn the_last_lone_block_is_not_timed() {
        // Orca's final pass needs two blocks in the queue; a file of one move takes no time.
        assert!(estimate(b"G1 X100 F3000\n", &marlin(), false).total.abs() < 1e-12);
    }

    #[test]
    fn dwells_and_filament_changes_add_their_time() {
        let mut c = marlin();
        c.raw
            .insert("filament_diameter".into(), serde_json::json!([1.75, 1.75]));
        let base = estimate(
            b"T0\nG1 X10 F600\nG4 S0\nT1\nG1 X20\nM400 P0\nT0\nG1 X30\nG1 X40\n",
            &c,
            false,
        )
        .total;
        c.raw
            .insert("machine_load_filament_time".into(), serde_json::json!(20));
        c.raw
            .insert("machine_unload_filament_time".into(), serde_json::json!(10));
        // The first T loads (20 s), each later one unloads and loads (30 s); G4 S5 and M400 P500.
        let e = estimate(
            b"T0\nG1 X10 F600\nG4 S5\nT1\nG1 X20\nM400 P500\nT0\nG1 X30\nG1 X40\n",
            &c,
            false,
        );
        assert!(
            (e.total - base - 85.5).abs() < 1e-6,
            "{} vs {}",
            e.total,
            base + 85.5
        );
    }

    #[test]
    fn a_virtual_flush_line_takes_its_extruder_time_and_moves_nothing() {
        // `;VG1 E30 F600`: 30 mm of filament at 10 mm/s, about 3 s with the extruder's ramps; the
        // next move starts from where the head was.
        let c = marlin();
        let plain = estimate(b"M83\nG1 X10 F600\nG1 X20 E1\nG1 X30\n", &c, false).total;
        let with = estimate(b"M83\nG1 X10 F600\n;VG1 E30 F600\nG1 X20 E1\nG1 X30\n", &c, false).total;
        assert!((with - plain - 3.0).abs() < 0.1, "{with} vs {plain}");
        // A comment of any other kind is not timed.
        let other = estimate(b"M83\nG1 X10 F600\n;G1 E30 F600\nG1 X20 E1\nG1 X30\n", &c, false).total;
        assert!((other - plain).abs() < 1e-9);
    }

    #[test]
    fn a_bambu_extruder_switch_takes_its_switch_time() {
        // Two nozzles, one filament each: Bambu Studio adds `machine_switch_extruder_time` per switch.
        let mut c = marlin();
        c.raw
            .insert("filament_diameter".into(), serde_json::json!([1.75, 1.75]));
        c.raw
            .insert("nozzle_diameter".into(), serde_json::json!([0.4, 0.4]));
        c.raw.insert("filament_map".into(), serde_json::json!([1, 2]));
        let base = estimate(b"T0\nG1 X10 F600\nT1\nG1 X20\nT0\nG1 X30\nG1 X40\n", &c, false).total;
        c.raw
            .insert("machine_switch_extruder_time".into(), serde_json::json!(5.6));
        let e = estimate(b"T0\nG1 X10 F600\nT1\nG1 X20\nT0\nG1 X30\nG1 X40\n", &c, false);
        assert!(
            (e.total - base - 11.2).abs() < 1e-6,
            "{} vs {}",
            e.total,
            base + 11.2
        );
    }

    #[test]
    fn a_bare_flow_word_keeps_the_flow() {
        // `M221 S` sets nothing on the printer, so the time is the same as without the line.
        let moves = b"G1 X10 E1 F3000\nG1 X0 E2\nG1 X10 E3\n";
        let mut with = b"M221 S ; push soft endstop status\n".to_vec();
        with.extend_from_slice(moves);
        let (a, b) = (
            estimate(moves, &marlin(), false).total,
            estimate(&with, &marlin(), false).total,
        );
        assert!((a - b).abs() < 1e-12, "{a} {b}");
    }

    #[test]
    fn waits_belong_to_their_own_segment() {
        for text in [
            "G1 X10 F600\n;@L 0 0\nG1 X20\nG4 S{wait}\n",
            ";@L 0 0\nG4 S{wait}\n;@L 0 0\nG1 X10 F600\nG1 X20\n",
            ";@L 0 0\nG4 S{wait}\n",
        ] {
            for trace in [false, true] {
                let base = estimate(text.replace("{wait}", "0").as_bytes(), &marlin(), trace);
                let waited = estimate(text.replace("{wait}", "120").as_bytes(), &marlin(), trace);
                assert!((waited.total - base.total - 120.0).abs() < 1e-9);
                assert_eq!(base.segments.len(), waited.segments.len());
                for (i, (a, b)) in base.segments.iter().zip(&waited.segments).enumerate() {
                    let extra = if i == 1 { 120.0 } else { 0.0 };
                    assert!((b - a - extra).abs() < 1e-9, "segment {i}: {waited:?}");
                }
                assert!((waited.segments.iter().sum::<f64>() - waited.total).abs() < 1e-9);
            }
        }
        let mut c = marlin();
        c.raw
            .insert("filament_diameter".into(), serde_json::json!([1.75, 1.75]));
        c.raw
            .insert("machine_load_filament_time".into(), serde_json::json!(20));
        c.raw
            .insert("machine_unload_filament_time".into(), serde_json::json!(10));
        let e = estimate(b"T0\n;@L 0 0\nT1\n", &c, true);
        assert_eq!(e.segments, [20.0, 30.0]);
        assert!((e.total - 50.0).abs() < 1e-9);
        let text = "G4 S5\n;LAYER_CHANGE\nG1 X10 F600\n;@L 0 0\n;LAYER_CHANGE\nG1 X20\nG4 S120\n";
        let base = estimate(text.replace("G4 S120", "G4 S0").as_bytes(), &marlin(), false);
        let waited = estimate(text.as_bytes(), &marlin(), false);
        assert!(waited.first_layer >= 5.0);
        assert!((waited.first_layer - base.first_layer).abs() < 1e-9);
    }

    #[test]
    fn layer_markers_split_the_time() {
        let g = b"G1 X10 F600\n;@L 0 0\nG1 X20\n;@L 0 0\nG1 X30\n";
        let e = estimate(g, &marlin(), false);
        assert_eq!(e.segments.len(), 3);
        let sum: f64 = e.segments.iter().sum();
        assert!((sum - e.total).abs() < 1e-9);
        assert!(e.segments.iter().all(|s| *s > 0.9));
    }

    #[test]
    fn the_file_sets_the_acceleration() {
        let slow = estimate(b"M204 S200\nG1 X100 F6000\nG1 X0\n", &marlin(), false).total;
        let fast = estimate(b"M204 S1000\nG1 X100 F6000\nG1 X0\n", &marlin(), false).total;
        assert!(slow > fast + 0.2, "{slow} {fast}");
    }

    #[test]
    fn full_circles_keep_the_commanded_direction_and_endpoint() {
        for flavor in [GcodeFlavor::Marlin, GcodeFlavor::Marlin2] {
            let mut c = marlin();
            c.gcode_flavor = flavor;
            for (command, direction) in [("G2", -1.0), ("G3", 1.0)] {
                for (suffix, z, e) in [("", 0.0, 0.0), (" Z1 E2", 1.0, 2.0)] {
                    let mut r = Reader::new(&c, None);
                    r.line("M83");
                    r.line(&format!("{command} I0 J10{suffix} F1200"));
                    // at the bottom of the circle, clockwise exits toward negative x.
                    assert!(
                        r.m.prev.dir[0] * direction > 0.98,
                        "{command}: {:?}",
                        r.m.prev.dir
                    );
                    assert!(
                        r.end
                            .iter()
                            .zip([0.0, 0.0, z, e])
                            .all(|(actual, expected)| (actual - expected).abs() < 1e-12),
                        "{:?}",
                        r.end
                    );
                }
            }
        }
    }

    #[test]
    fn reflected_full_circle_paths_take_the_same_time() {
        for flavor in [GcodeFlavor::Marlin, GcodeFlavor::Marlin2] {
            let mut c = marlin();
            c.gcode_flavor = flavor;
            let prefix = "G90\nM204 S1000\nM205 X9 Y9 Z3 E2.5\n";
            let clockwise = "G1 X20 Y0 F6000\nG2 X20 Y0 I0 J10 F6000\nG1 X0 Y0 F1500\n";
            let reflected = "G1 X20 Y0 F6000\nG3 X20 Y0 I0 J-10 F6000\nG1 X0 Y0 F1500\n";
            let a = estimate(
                format!("{prefix}{}G4 S0\n", clockwise.repeat(20)).as_bytes(),
                &c,
                false,
            )
            .total;
            let b = estimate(
                format!("{prefix}{}G4 S0\n", reflected.repeat(20)).as_bytes(),
                &c,
                false,
            )
            .total;
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
    }

    #[test]
    fn arcs_take_about_their_length() {
        // A half circle of radius 10 at 20 mm/s: about pi * 10 / 20 s.
        let e = estimate(b"G1 X0 Y0 F1200\nG2 X20 Y0 I10 J0\n", &marlin(), false);
        let expect = std::f64::consts::PI * 10.0 / 20.0;
        assert!((e.total - expect).abs() < 0.15, "{} vs {expect}", e.total);
    }

    #[test]
    fn line_times_include_each_wait_at_its_own_line() {
        for prefix in ["", "G1 X10 F600\nG1 X20\n"] {
            for (waits, first, second) in [
                ("M400 S180\nM400 S180\n", 180.0, 180.0),
                ("G4 S5\nM400 P500\n", 5.0, 0.5),
            ] {
                let text = format!("{prefix}{waits}");
                let e = estimate(text.as_bytes(), &marlin(), true);
                let plain = estimate(text.as_bytes(), &marlin(), false);
                let before = prefix.lines().count();
                let at = |line: usize| *e.lines.get(line).expect("trace line");
                let prior = if before == 0 { 0.0 } else { at(before - 1) };
                assert!((at(before) - prior - first).abs() < 1e-9, "first wait: {e:?}");
                assert!(
                    (at(before + 1) - at(before) - second).abs() < 1e-9,
                    "second wait: {e:?}"
                );
                assert!((at(before + 1) - e.total).abs() < 1e-9);
                assert!((e.total - plain.total).abs() < 1e-9);
                if !prefix.is_empty() {
                    let motion = estimate(prefix.as_bytes(), &marlin(), true);
                    assert!(
                        (at(0) - motion.lines.first().copied().expect("motion trace")).abs() < 1e-9,
                        "wait moved before motion"
                    );
                }
            }
        }
    }

    #[test]
    fn line_times_keep_tool_changes_and_arc_segments() {
        let mut c = marlin();
        c.raw
            .insert("filament_diameter".into(), serde_json::json!([1.75, 1.75]));
        c.raw
            .insert("machine_load_filament_time".into(), serde_json::json!(20));
        c.raw
            .insert("machine_unload_filament_time".into(), serde_json::json!(10));
        let e = estimate(b"T0\nG4 S2\nT1\nM400 P500\n", &c, true);
        for (actual, expected) in e.lines.iter().zip([20.0, 22.0, 52.0, 52.5, 52.5]) {
            assert!((actual - expected).abs() < 1e-9, "tool trace: {e:?}");
        }
        let text = b"G1 X0 Y0 F1200\nG2 X20 Y0 I10 J0\nG1 X30\nM400 S5\n";
        let arc = estimate(text, &marlin(), true);
        let plain = estimate(text, &marlin(), false);
        assert!(arc.lines.get(1).copied().unwrap_or(0.0) > 1.4);
        assert!(arc.lines.windows(2).all(|w| w.first() <= w.get(1)));
        assert!((arc.lines.last().copied().unwrap_or(0.0) - arc.total).abs() < 1e-9);
        assert!((arc.total - plain.total).abs() < 1e-9);
    }

    #[test]
    fn line_times_rise_with_the_file() {
        let e = estimate(b"G1 X10 F600\nM104 S200\nG1 X20\n", &marlin(), true);
        assert_eq!(e.lines.len(), 4);
        let (Some(&a), Some(&b), Some(&c)) = (e.lines.first(), e.lines.get(1), e.lines.get(2)) else {
            panic!()
        };
        assert!(a > 0.0 && (b - a).abs() < 1e-12 && c > b);
    }

    fn klipper() -> PrintConfig {
        let mut c = cfg(&[
            ("machine_max_acceleration_extruding", serde_json::json!([1000])),
            ("nozzle_diameter", serde_json::json!([0.4])),
            ("filament_diameter", serde_json::json!([1.75])),
        ]);
        c.gcode_flavor = GcodeFlavor::Klipper;
        c
    }

    /// Klipper's time for `moves` after setting 1000 mm/s2, a 5 mm/s square corner velocity and `extra`.
    fn klipper_time(extra: &str, moves: &str) -> f64 {
        let text = format!("SET_VELOCITY_LIMIT ACCEL=1000 SQUARE_CORNER_VELOCITY=5 {extra}\n{moves}");
        estimate(text.as_bytes(), &klipper(), false).total
    }

    /// Within 0.1 microsecond: a ramp that ends at rest takes a square root of a difference near zero, so
    /// rounding in the last bit of a speed shows up around 1e-9 s.
    fn close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-7, "{actual} vs {expected}");
    }

    #[test]
    fn klipper_corner_speed_is_the_square_corner_velocity_at_90_degrees() {
        close(corner_speed2(5.0, 0.0), 25.0);
        close(corner_speed2(5.0, -1.0), 0.0);
        assert!(corner_speed2(5.0, 1.0).is_infinite());
        // A 120 degree corner (the path turns through 60): s = sin(60), so 25 (sqrt(2) - 1) s / (1 - s).
        let s = 0.75f64.sqrt();
        close(
            corner_speed2(5.0, 0.5),
            25.0 * (2.0f64.sqrt() - 1.0) * s / (1.0 - s),
        );
        // Zero allows no speed through any corner, but straight on is still free.
        close(corner_speed2(0.0, 0.0), 0.0);
        assert!(corner_speed2(0.0, 1.0).is_infinite());
    }

    #[test]
    fn klipper_straight_move_is_one_trapezoid() {
        // 100 mm at 100 mm/s and 1000 mm/s2 from rest to rest: 5 mm up in 0.1 s, 90 mm at speed, 5 mm down.
        // The smoothed pass (500 mm/s2) could reach sqrt(500 * 100) = 224 mm/s, so it does not bind.
        close(klipper_time("", "G1 X100 F6000\n"), 0.1 + 0.9 + 0.1);
        // A lone move is timed (the firmware runs it).
        close(klipper_time("MINIMUM_CRUISE_RATIO=0", "G1 X100 F6000\n"), 1.1);
    }

    #[test]
    fn klipper_square_corner_runs_at_the_square_corner_velocity() {
        // Each leg: up to 100 mm/s in 5 mm and 0.1 s, down to 5 mm/s in (100^2 - 5^2) / 2000 = 4.9875 mm
        // and 0.095 s, the other 90.0125 mm at 100 mm/s.
        let leg = 0.1 + 0.095 + 90.0125 / 100.0;
        close(klipper_time("", "G1 X100 F6000\nG1 Y100\n"), 2.0 * leg);
        // With a square corner velocity of 0 the corner stops: two lone trapezoids.
        let stop = "SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=0\nG1 X100 F6000\nG1 Y100\n";
        close(klipper_time("", stop), 2.2);
    }

    #[test]
    fn klipper_minimum_cruise_ratio_caps_short_zigzags() {
        // Ten 2 mm moves that reverse each time, so every junction is a stop. At a ratio of 0.5 the
        // virtual rate is 500 mm/s2 and the top speed sqrt(500 * 2) = 31.6 mm/s: 0.5 mm up, 1 mm at speed,
        // 0.5 mm down, 3 * 31.6 / 1000 s a move. Without it each move peaks at sqrt(1000 * 2) = 44.7 mm/s
        // and takes 2 * 44.7 / 1000 s.
        let zigzag = "G1 X2 F6000\nG1 X0\n".repeat(5);
        let capped = 10.0 * 3.0 * 1000.0f64.sqrt() / 1000.0;
        close(klipper_time("", &zigzag), capped);
        close(klipper_time("MINIMUM_CRUISE_RATIO=0.5", &zigzag), capped);
        close(
            klipper_time("MINIMUM_CRUISE_RATIO=0", &zigzag),
            10.0 * 2.0 * 2000.0f64.sqrt() / 1000.0,
        );
        // The older firmware's explicit rate: half the acceleration is the same cap.
        close(klipper_time("ACCEL_TO_DECEL=500", &zigzag), capped);
        // The documented example: a lone 1.5 mm move at 0.5 cruises for 0.75 mm. Its peak is
        // sqrt(500 * 1.5) mm/s, reached after 0.375 mm.
        let peak = 750.0f64.sqrt();
        close(
            klipper_time("", "G1 X1.5 F6000\n"),
            2.0 * peak / 1000.0 + 0.75 / peak,
        );
    }

    #[test]
    fn klipper_staircase_combines_corners_and_the_cruise_ratio() {
        // Six 2 mm moves turning 90 degrees each time (junctions at 5 mm/s). An inner move's smoothed peak
        // is (25 + 25) / 2 + 500 * 2 = 1025 mm2/s2, the end ones (0 + 25) / 2 + 1000 = 1012.5.
        let inner = |s0: f64, s1: f64, peak2: f64| {
            let (v0, v1, v) = (s0.sqrt(), s1.sqrt(), peak2.sqrt());
            let ramps = (peak2 - s0) / 2000.0 + (peak2 - s1) / 2000.0;
            (v - v0) / 1000.0 + (v - v1) / 1000.0 + (2.0 - ramps) / v
        };
        let expected = 2.0 * inner(0.0, 25.0, 1012.5) + 4.0 * inner(25.0, 25.0, 1025.0);
        let stairs = "G1 X2 F6000\nG1 Y2\nG1 X4\nG1 Y4\nG1 X6\nG1 Y6\n";
        close(klipper_time("", stairs), expected);
    }

    #[test]
    fn klipper_limits_the_extruder_speed_change_at_a_junction() {
        // A travel straight into an extrusion of 0.04 mm per mm: the extruder may change by 1 mm/s, so the
        // junction runs at 25 mm/s. Each 50 mm leg: 5 mm up (0.1 s), (100^2 - 25^2) / 2000 = 4.6875 mm
        // down (0.075 s), 40.3125 mm at 100 mm/s.
        let leg = 0.1 + 0.075 + 40.3125 / 100.0;
        close(klipper_time("", "M83\nG1 X50 F6000\nG1 X100 E2\n"), 2.0 * leg);
        close(klipper_time("", "M83\nG1 X50 F6000\nG1 X100\n"), 1.1);
    }

    #[test]
    fn klipper_m204_needs_s_or_both_p_and_t() {
        close(klipper_time("", "M204 P500\nG1 X100 F6000\n"), 1.1);
        // 500 mm/s2: 10 mm up in 0.2 s, 80 mm at speed, 10 mm down.
        close(klipper_time("", "M204 P500 T800\nG1 X100 F6000\n"), 1.2);
        close(klipper_time("", "M204 S500\nG1 X100 F6000\n"), 1.2);
        // Machine limit commands are not Klipper's.
        close(
            klipper_time("", "M201 X100 Y100\nM203 X10 Y10\nG1 X100 F6000\n"),
            1.1,
        );
    }

    #[test]
    fn klipper_profile_limits_cap_what_the_file_asks_for() {
        // The profile's 1000 mm/s2 caps ACCEL=2000; without a profile limit 2000 applies: 2.5 mm up in
        // 0.05 s, 95 mm at speed, 2.5 mm down.
        close(
            klipper_time("", "SET_VELOCITY_LIMIT ACCEL=2000\nG1 X100 F6000\n"),
            1.1,
        );
        close(klipper_time("", "M204 S2000\nG1 X100 F6000\n"), 1.1);
        let mut open = klipper();
        open.raw.remove("machine_max_acceleration_extruding");
        let text = "SET_VELOCITY_LIMIT ACCEL=2000\nG1 X100 F6000\n";
        close(estimate(text.as_bytes(), &open, false).total, 1.05);
        // A 50 mm/s speed limit caps VELOCITY=200 and the 100 mm/s feed: 1.25 mm up in 0.05 s, 97.5 mm at
        // 50 mm/s, 1.25 mm down.
        let mut slow = klipper();
        slow.raw
            .insert("machine_max_speed_x".into(), serde_json::json!([50]));
        let text = "SET_VELOCITY_LIMIT ACCEL=1000 VELOCITY=200\nG1 X100 F6000\n";
        close(estimate(text.as_bytes(), &slow, false).total, 2.05);
        // Unset, the file's velocity is the top speed and the feed rate is under it.
        close(estimate(text.as_bytes(), &klipper(), false).total, 1.1);
    }

    #[test]
    fn klipper_arcs_run_in_one_millimeter_segments() {
        use crate::fm::Fm as _;
        // A quarter circle of radius 10 (15.7 mm) is 15 chords of 2 * 10 * sin(3 degrees), each turn
        // gentle enough to keep 10 mm/s; the start and the stop each cost 10 / 1000 s more than cruising.
        let chords = 15.0 * 20.0 * (std::f64::consts::PI / 60.0).m_sin();
        close(klipper_time("", "G2 X10 Y10 I10 J0 F600\n"), chords / 10.0 + 0.01);
    }

    #[test]
    fn klipper_keeps_its_plan_across_queue_refills() {
        use std::fmt::Write as _;
        // Thousands of moves are planned in batches; the result matches the lone-batch sum of identical
        // stair steps (each inner step as in the staircase test).
        let mut steps = String::new();
        for i in 1..=600 {
            let _ = writeln!(steps, "G1 X{} F6000\nG1 Y{}", 2 * i, 2 * i);
        }
        let inner = 1025.0f64.sqrt();
        let one = 2.0 * (inner - 5.0) / 1000.0 + (2.0 - 2.0 * 1000.0 / 2000.0) / inner;
        let end = {
            let v = 1012.5f64.sqrt();
            v / 1000.0 + (v - 5.0) / 1000.0 + (2.0 - (1012.5 / 2000.0 + 987.5 / 2000.0)) / v
        };
        close(klipper_time("", &steps), 2.0 * end + 1198.0 * one);
    }
}
