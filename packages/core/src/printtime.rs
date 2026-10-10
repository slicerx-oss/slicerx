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

use crate::config::{GcodeFlavor, PrintConfig};
use crate::fm::Fm as _;

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
    blocks: Vec<Block>,
    prev: Motion,
    pending: Vec<(Kind, f64)>,
    time: f64,
    first_layer: f64,
    segments: Vec<f64>,
    lines: Option<Vec<f64>>,
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
        let max_travel = if matches!(fw, Fw::Repetier | Fw::Marlin2 | Fw::RepRap) {
            env.travel
        } else {
            0.0
        };
        let or = |v: f64, d: f64| if v > 0.0 { v } else { d };
        Self {
            fw,
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
        if self.blocks.len() < 2 && !drain {
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
        let process = n.saturating_sub(keep);
        let mut idx = 0usize;
        for b in self.blocks.iter().take(process) {
            let mut t = b.time();
            if let Some(&(k, extra)) = merged.get(idx)
                && (k == Kind::Noop || k == b.kind)
            {
                t += extra;
                idx += 1;
            }
            self.time += t;
            if b.layer == 1 {
                self.first_layer += t;
            }
            if self.segments.len() <= b.segment {
                self.segments.resize(b.segment + 1, 0.0);
            }
            if let Some(s) = self.segments.get_mut(b.segment) {
                *s += t;
            }
            if let Some(slot) = self.lines.as_mut().and_then(|l| l.get_mut(b.line)) {
                *slot = self.time;
            }
        }
        if let Some(rest) = merged.get(idx..)
            && !rest.is_empty()
        {
            if last {
                // Nothing left to carry it: it counts in the total only.
                let leftover: f64 = rest.iter().map(|r| r.1).sum();
                self.time += leftover;
                if let Some(s) = self.segments.last_mut() {
                    *s += leftover;
                } else {
                    self.segments.push(leftover);
                }
            } else {
                self.pending.extend_from_slice(rest);
            }
        }
        if keep > 0 {
            self.blocks.drain(..process);
            if let Some(first) = self.blocks.first_mut() {
                first.max_entry = first.entry;
            }
        } else {
            self.blocks.clear();
        }
    }

    fn synchronize(&mut self, additional: f64, target: Kind) {
        self.calculate(0, additional, target, false);
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
    words.iter().find_map(|w| {
        let b = w.as_bytes();
        let first = *b.first()?;
        if !first.eq_ignore_ascii_case(&key) {
            return None;
        }
        w.get(1..)?.parse::<f64>().ok()
    })
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
        m.lines = per_line.map(|n| vec![f64::NAN; n]);
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

    fn sync(&mut self, extra: f64) {
        self.m.synchronize(extra, Kind::Noop);
    }

    /// `process_G1`: a straight move to absolute `target`, with the feed rate in mm/min when given.
    fn move_to(&mut self, target: [f64; 4], feed: Option<f64>) {
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
        if d.iter().all(|v| *v == 0.0) {
            return;
        }
        let xyz = d[0] != 0.0 || d[1] != 0.0 || d[2] != 0.0;
        let kind = if self.wiping {
            Kind::Wipe
        } else if d[3] < 0.0 {
            if xyz { Kind::Travel } else { Kind::Retract }
        } else if d[3] > 0.0 {
            if d[0] == 0.0 && d[1] == 0.0 {
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
        let distance = if sq > 0.0 { sq.sqrt() } else { d[3].abs() };
        let inv = 1.0 / distance;
        let extrusion_only = !xyz && d[3] != 0.0;
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
        let prev = m.prev;
        // Centripetal limit on gentle corners (Bambu's planner).
        if (prev.dir[0] != 0.0 || prev.dir[1] != 0.0) && (curr.dir[0] != 0.0 || curr.dir[1] != 0.0) {
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
        for ((axis, index), (dv, max)) in curr.axis.iter_mut().zip(0..4).zip(d.iter().zip(m.env.speed)) {
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
        for (dv, max) in d.iter().zip(m.env.accel) {
            let share = dv.abs() * inv;
            if acceleration * share > max {
                acceleration = max / share;
            }
        }
        let jerk = m.axis_jerk();
        curr.safe = cruise;
        for (a, j) in curr.axis.iter().zip(jerk) {
            if a.abs() > j {
                curr.safe = curr.safe.min(j);
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
        };
        block.calculate_trapezoid();
        m.prev = curr;
        m.blocks.push(block);
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
            std::f64::consts::TAU
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
        } else {
            arc_steps(start_radius, angle.abs(), 0.0125)
        };
        #[allow(clippy::cast_precision_loss, reason = "a segment count")]
        let per = 1.0 / segments as f64;
        let theta = angle * per;
        let z_per = dz * per;
        let e_per = extrusion.map_or(0.0, |e| e * per);
        let (cos_t, sin_t) = if self.m.fw == Fw::Marlin2 {
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
        // A zero length block takes the stop, so the delay lands on the change itself.
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
        };
        b.calculate_trapezoid();
        self.m.blocks.push(b);
        self.m.synchronize(extra, Kind::ToolChange);
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
        if c.starts_with("@L ") {
            self.segment += 1;
        } else if c == "LAYER_CHANGE" || c == " CHANGE_LAYER" {
            self.layer += 1;
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

    /// Klipper's `SET_VELOCITY_LIMIT`: square corner velocity as the X and Y jerk, the acceleration
    /// for print and travel moves, and the velocity as the X and Y top speed.
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
            self.m.set_acceleration(a);
            self.m.set_travel(a);
        }
        if let Some(v) = find("VELOCITY") {
            self.m.env.speed[0] = v;
            self.m.env.speed[1] = v;
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
    let line_count = if per_line {
        gcode.split(|&b| b == b'\n').count()
    } else {
        0
    };
    let mut r = Reader::new(cfg, per_line.then_some(line_count));
    for (i, line) in gcode.split(|&b| b == b'\n').enumerate() {
        r.line = i;
        match std::str::from_utf8(line) {
            Ok(s) => r.line(s),
            Err(_) => r.line(&String::from_utf8_lossy(line)),
        }
    }
    r.m.calculate(0, 0.0, Kind::Noop, true);
    let mut segments = std::mem::take(&mut r.m.segments);
    if segments.len() <= r.segment {
        segments.resize(r.segment + 1, 0.0);
    }
    let lines = r.m.lines.take().map_or_else(Vec::new, |l| {
        let mut last = 0.0;
        l.into_iter()
            .map(|t| {
                if !t.is_nan() {
                    last = t;
                }
                last
            })
            .collect()
    });
    Estimate {
        total: r.m.time,
        first_layer: r.m.first_layer,
        segments,
        lines,
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
    fn arcs_take_about_their_length() {
        // A half circle of radius 10 at 20 mm/s: about pi * 10 / 20 s.
        let e = estimate(b"G1 X0 Y0 F1200\nG2 X20 Y0 I10 J0\n", &marlin(), false);
        let expect = std::f64::consts::PI * 10.0 / 20.0;
        assert!((e.total - expect).abs() < 0.15, "{} vs {expect}", e.total);
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
}
