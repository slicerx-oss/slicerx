// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A `PrusaSlicer` filament's ramped travel lift, as `sx slice` prints it: the travel climbs along its path from where
//! the retraction and any wipe end at the filament's ramp angle, holds the ramp's height once it gets there and drops
//! straight down at its end. Near the top the climb bends over into the height (the blend) when the printer's machine
//! limits ask for it. The travel to a new layer ramps up from the old layer's height whether or not it retracts, and
//! the first travel of the print lifts straight up.
//!
//! The projects are rows, islands and rings of 10 mm boxes, 15 layers of 0.2 mm, on the MK4 and XL stock filaments
//! (a ramp of 0.6 mm at 1 degree) or with one setting changed. Each slices with the printer values the engine reads
//! from `config/<name>.json` (machine limits, retraction, lift limits, wipe), since a project's printer settings stay
//! the current printer's. Every check holds the slice to the rule applied to the slice's own travels.

#![allow(
    clippy::disallowed_methods,
    reason = "a G-code reader's own measures, checked with tolerances, never written"
)]

use serde_json::Value;
use std::f64::consts::SQRT_2;
use std::path::{Path, PathBuf};
use std::process::Command;

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prusa-lift")
}

/// The G-code of a project, sliced with its printer values.
fn slice(name: &str) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_sx"))
        .arg("slice")
        .arg(dir().join(format!("{name}.3mf")))
        .args(["--plate", "1", "--config"])
        .arg(dir().join(format!("config/{name}.json")))
        .args(["-o", "-"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{name}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

/// The machine limits the blend reads (first values): the X feed rate limit, the travel acceleration limit, the Z
/// acceleration, feed rate and jerk limits.
#[derive(Clone, Copy)]
struct Limits {
    feed_x: f64,
    accel: f64,
    accel_z: f64,
    feed_z: f64,
    jerk_z: f64,
}

fn limits(name: &str) -> Limits {
    let text = std::fs::read_to_string(dir().join(format!("config/{name}.json"))).unwrap();
    let cfg: Value = serde_json::from_str(&text).unwrap();
    let first = |k: &str| cfg[k][0].as_f64().unwrap_or_else(|| panic!("{name}: {k}"));
    Limits {
        feed_x: first("machine_max_speed_x"),
        accel: first("machine_max_acceleration_travel"),
        accel_z: first("machine_max_acceleration_z"),
        feed_z: first("machine_max_speed_z"),
        jerk_z: first("machine_max_jerk_z"),
    }
}

/// The lift a project's filament asks for: the ramp's height (mm) and angle (degrees), and the printer's limits.
#[derive(Clone, Copy)]
struct Rule {
    h: f64,
    deg: f64,
    lim: Limits,
}

impl Rule {
    fn of(name: &str, h: f64, deg: f64) -> Self {
        Self {
            h,
            deg,
            lim: limits(name),
        }
    }

    fn k(&self) -> f64 {
        self.deg.to_radians().tan()
    }

    fn straight(&self) -> bool {
        self.deg <= 0.0 || self.deg >= 90.0
    }

    /// The blend's length on a climb `len` long, when it bends: the count of its steps is 6 or less and the climb is
    /// at least v squared over A long.
    fn blend(&self, len: f64) -> Option<f64> {
        let lim = self.lim;
        let speed = (SQRT_2 * lim.feed_x * self.k()).min(lim.feed_z);
        let steps = (speed / lim.jerk_z).ceil();
        (steps <= 6.0 && len >= lim.feed_x * lim.feed_x / lim.accel)
            .then(|| SQRT_2 * lim.feed_x * speed / lim.accel_z)
    }

    /// How high the ramp is `s` mm along a climb `len` long.
    fn height(&self, s: f64, len: f64) -> f64 {
        if self.h <= 0.0 {
            return 0.0;
        }
        if self.straight() {
            return self.h;
        }
        let slope = self.k();
        let reach = self.h / slope;
        match self.blend(len) {
            Some(bend) if s > reach - bend / 2.0 => {
                if s >= reach + bend / 2.0 {
                    self.h
                } else {
                    let left = reach + bend / 2.0 - s;
                    (self.h - slope / (2.0 * bend) * left * left).max(0.0)
                }
            }
            _ => (slope * s).min(self.h),
        }
    }

    /// The top of a climb `len` long.
    fn top(&self, len: f64) -> f64 {
        self.height(len, len)
    }

    /// The top of a climb `len` long without the blend.
    fn line(&self, len: f64) -> f64 {
        (self.k() * len).min(self.h)
    }
}

/// One move: where it starts and ends, and how much filament it pushes (negative when it retracts).
#[derive(Clone, Copy, Debug)]
struct Move {
    from: [f64; 3],
    to: [f64; 3],
    de: f64,
}

impl Move {
    fn xy(&self) -> f64 {
        (self.to[0] - self.from[0]).hypot(self.to[1] - self.from[1])
    }

    fn dz(&self) -> f64 {
        self.to[2] - self.from[2]
    }
}

/// The moves between two extruding moves.
#[derive(Debug, Default)]
struct Travel {
    moves: Vec<Move>,
    /// A layer marker came inside it.
    layer_change: bool,
    /// The print's first layer marker came inside it.
    first: bool,
    /// The first move after the layer marker.
    after_marker: usize,
    /// The height of the extruding move that ends it.
    end_z: f64,
}

impl Travel {
    /// Where the climb starts: after the last move that retracts (a retraction or a wipe), from the layer marker on.
    fn ramp_start(&self) -> usize {
        self.moves
            .iter()
            .rposition(|m| m.de < 0.0)
            .map_or(self.after_marker, |i| (i + 1).max(self.after_marker))
    }

    fn ramp(&self) -> &[Move] {
        self.moves.get(self.ramp_start()..).unwrap_or(&[])
    }

    /// The height where the climb starts.
    fn base(&self) -> f64 {
        let i = self.ramp_start();
        match i.checked_sub(1).and_then(|j| self.moves.get(j)) {
            Some(m) => m.to[2],
            None => self.moves.get(i).map_or(self.end_z, |m| m.from[2]),
        }
    }

    /// The climb's length in XY.
    fn len(&self) -> f64 {
        self.ramp().iter().map(Move::xy).sum()
    }

    fn top(&self) -> f64 {
        self.ramp().iter().map(|m| m.to[2]).fold(self.base(), f64::max)
    }

    fn retracts(&self) -> bool {
        self.moves.iter().any(|m| m.de < 0.0)
    }

    fn wipes(&self) -> bool {
        self.moves.iter().any(|m| m.de < 0.0 && m.xy() > 0.0)
    }

    /// The last move that changes the height is a move straight down to the layer, with no move across after it.
    fn drops(&self) -> bool {
        let Some(i) = self.moves.iter().rposition(|m| m.dz().abs() > 1e-9) else {
            return false;
        };
        let m = self.moves[i];
        m.xy() < 1e-9
            && m.dz() < 0.0
            && (m.to[2] - self.end_z).abs() < 1e-6
            && self.moves[i + 1..].iter().all(|n| n.xy() < 1e-9)
    }

    /// The highest point before the climb starts.
    fn top_before_ramp(&self) -> f64 {
        self.moves[self.after_marker.min(self.ramp_start())..self.ramp_start()]
            .iter()
            .map(|m| m.to[2])
            .fold(f64::MIN, f64::max)
    }
}

/// Every travel of a G-code file, from its start to its last extruding move.
fn travels(gcode: &str) -> Vec<Travel> {
    let mut at = [0.0_f64; 3];
    let (mut e, mut relative, mut marked) = (0.0_f64, false, false);
    let mut out = Vec::new();
    let mut cur = Travel::default();
    for line in gcode.lines() {
        if line.starts_with(";LAYER_CHANGE") {
            cur.layer_change = true;
            cur.first = !marked;
            cur.after_marker = cur.moves.len();
            marked = true;
            continue;
        }
        let code = line.split(';').next().unwrap_or("").trim();
        let mut words = code.split_whitespace();
        match words.next() {
            Some("M83") => relative = true,
            Some("M82") => relative = false,
            Some("G0" | "G1" | "G2" | "G3") => {
                let mut to = at;
                let mut de = 0.0;
                for w in words {
                    let (axis, v) = w.split_at(1);
                    let Ok(v) = v.parse::<f64>() else { continue };
                    match axis {
                        "X" => to[0] = v,
                        "Y" => to[1] = v,
                        "Z" => to[2] = v,
                        "E" => {
                            de = if relative { v } else { v - e };
                            e = if relative { e + v } else { v };
                        }
                        _ => {}
                    }
                }
                let m = Move { from: at, to, de };
                at = to;
                if de > 0.0 && m.xy() > 0.0 {
                    cur.end_z = to[2];
                    if !cur.moves.is_empty() || cur.layer_change {
                        out.push(std::mem::take(&mut cur));
                    }
                } else if m.xy() > 0.0 || m.dz().abs() > 1e-9 || de.abs() > 1e-9 {
                    cur.moves.push(m);
                }
            }
            _ => {}
        }
    }
    out
}

/// What a project's same-layer travels must do: lift by the rule when they retract (`lifts`), or never.
fn same_layer(
    name: &str,
    rule: Rule,
    lifts: bool,
    keep: impl Fn(f64) -> bool,
    wrong: &mut Vec<String>,
) -> usize {
    let mut lifted = 0;
    for t in travels(&slice(name)).iter().filter(|t| !t.layer_change) {
        let (len, rise) = (t.len(), t.top() - t.base());
        if !keep(len) {
            continue;
        }
        if lifts && t.retracts() && rule.h > 0.0 {
            let want = rule.top(len);
            if (rise - want).abs() > 0.005 {
                wrong.push(format!(
                    "{name}: a travel {len:.2} long at Z {} lifts {rise:.3}, not {want:.3}",
                    t.base()
                ));
            }
            lifted += 1;
        } else if rise > 0.0005 {
            wrong.push(format!(
                "{name}: a travel {len:.2} long at Z {} lifts {rise:.3}, not 0",
                t.base()
            ));
        }
    }
    if lifts && rule.h > 0.0 && lifted == 0 {
        wrong.push(format!("{name}: no travel to check"));
    }
    lifted
}

/// What a project's layer changes must do: ramp up from the old layer by the rule and drop to the new one, or, when
/// the ramp gets no higher than the new layer, move from the old height to the new one without a drop. Returns the
/// counts of each.
fn layer_changes(name: &str, rule: Rule, wrong: &mut Vec<String>) -> (usize, usize) {
    let (mut ramps, mut short) = (0, 0);
    let all = travels(&slice(name));
    let changes: Vec<&Travel> = all.iter().filter(|t| t.layer_change && !t.first).collect();
    if changes.len() != 14 {
        wrong.push(format!("{name}: {} layer changes, not 14", changes.len()));
    }
    for t in changes {
        let (old, new, len, top) = (t.base(), t.end_z, t.len(), t.top());
        let want = if rule.straight() { 0.0 } else { rule.top(len) };
        if want <= new - old + 0.0005 {
            if top > new + 0.0005 || t.drops() {
                wrong.push(format!(
                    "{name}: the layer change to Z {new} ({len:.2} long) tops at {top:.3} (drop: {}), not at the new layer",
                    t.drops()
                ));
            }
            short += 1;
        } else {
            if (top - old - want).abs() > 0.005 || !t.drops() {
                wrong.push(format!(
                    "{name}: the layer change to Z {new} ({len:.2} long) tops {:.3} above the old layer (drop: {}), not {want:.3}",
                    top - old,
                    t.drops()
                ));
            }
            ramps += 1;
        }
    }
    (ramps, short)
}

/// Every travel that lifts on a layer climbs only once its retraction and wipe are done, never more steeply than the
/// ramp's angle (straight up only at 0 or 90 degrees), and ends with a drop straight down to the layer.
fn shape(name: &str, rule: Rule, wrong: &mut Vec<String>) {
    let k = rule.k();
    for t in travels(&slice(name))
        .iter()
        .filter(|t| !t.layer_change && t.top() > t.base() + 0.0005)
    {
        let at = t.base();
        if !t.drops() {
            wrong.push(format!("{name}: a travel at Z {at} ends without a drop"));
        }
        if t.top_before_ramp() > at + 1e-6 {
            wrong.push(format!(
                "{name}: a travel at Z {at} lifts before its retraction ends"
            ));
        }
        for m in t.ramp().iter().filter(|m| m.dz() > 1e-9) {
            let steep = if rule.straight() {
                m.xy() > 0.0
            } else {
                m.xy() < 1e-9 || m.dz() > k * m.xy() + 0.0011
            };
            if steep {
                wrong.push(format!(
                    "{name}: a travel at Z {at} climbs {:.3} over {:.3}",
                    m.dz(),
                    m.xy()
                ));
            }
        }
    }
}

/// The steepest climb of a project's same-layer travels, in degrees, over moves at least `least` mm long (long enough
/// for the heights' rounding not to matter).
fn steepest(name: &str, least: f64) -> f64 {
    travels(&slice(name))
        .iter()
        .filter(|t| !t.layer_change)
        .flat_map(|t| t.ramp().to_vec())
        .filter(|m| m.dz() > 1e-9 && m.xy() >= least)
        .map(|m| m.dz().atan2(m.xy()).to_degrees())
        .fold(0.0, f64::max)
}

fn done(wrong: &[String]) {
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn a_ramp_climbs_at_the_filaments_angle_up_to_its_height() {
    let mut wrong = Vec::new();
    let name = "mk4--row--FSL5";
    same_layer(name, Rule::of(name, 0.6, 5.0), true, |_| true, &mut wrong);
    let angle = steepest(name, 3.0);
    if (angle - 5.0).abs() > 0.05 {
        wrong.push(format!("{name}: the ramp climbs at {angle:.2} degrees, not 5"));
    }
    done(&wrong);
}

#[test]
fn a_steep_ramp_lifts_its_height_and_layer_changes_ramp_from_the_old_layer() {
    let mut wrong = Vec::new();
    let name = "mk4--isl--FSL30";
    let rule = Rule::of(name, 0.6, 30.0);
    same_layer(name, rule, true, |_| true, &mut wrong);
    // At 30 degrees the ramp reaches 0.6 mm in 1.04 mm.
    let angle = steepest(name, 1.0);
    if (angle - 30.0).abs() > 0.05 {
        wrong.push(format!("{name}: the ramp climbs at {angle:.2} degrees, not 30"));
    }
    let (ramps, _) = layer_changes(name, rule, &mut wrong);
    if ramps != 14 {
        wrong.push(format!("{name}: {ramps} layer changes ramp, not 14"));
    }
    done(&wrong);
}

#[test]
fn travels_shorter_than_the_blend_climb_at_one_degree() {
    let mut wrong = Vec::new();
    let name = "mk4--row--stock";
    let n = same_layer(name, Rule::of(name, 0.6, 1.0), true, |len| len < 22.5, &mut wrong);
    if n < 10 {
        wrong.push(format!("{name}: {n} travels under 22.5 mm"));
    }
    done(&wrong);
}

#[test]
fn a_ramp_starts_after_the_retraction_and_ends_with_a_drop() {
    let mut wrong = Vec::new();
    for (name, deg) in [
        ("mk4--row--FSL5", 5.0),
        ("mk4--isl--FSL30", 30.0),
        ("mk4--row--stock", 1.0),
    ] {
        shape(name, Rule::of(name, 0.6, deg), &mut wrong);
    }
    done(&wrong);
}

#[test]
fn a_long_ramp_bends_into_its_height() {
    let mut wrong = Vec::new();
    for name in ["mk4--row--stock", "mk4--isl--stock"] {
        let rule = Rule::of(name, 0.6, 1.0);
        same_layer(name, rule, true, |len| len >= 22.5, &mut wrong);
    }
    // The blend changes some of the island travels' tops from the line's. The row's travels between objects are all
    // longer than the blend's end (42.2 mm), so they top at the full height either way.
    {
        let name = "mk4--isl--stock";
        let rule = Rule::of(name, 0.6, 1.0);
        let bent = travels(&slice(name))
            .iter()
            .filter(|t| !t.layer_change && t.retracts())
            .filter(|t| (rule.top(t.len()) - rule.line(t.len())).abs() > 0.005)
            .count();
        if bent == 0 {
            wrong.push(format!("{name}: no travel in the blend"));
        }
    }
    done(&wrong);
}

#[test]
fn the_blend_needs_a_travel_as_long_as_the_printer_brakes() {
    let mut wrong = Vec::new();
    for name in ["mk4--row--Z3MAT2400", "mk4--row--Z2MAT1000"] {
        let rule = Rule::of(name, 0.6, 1.0);
        same_layer(name, rule, true, |_| true, &mut wrong);
        layer_changes(name, rule, &mut wrong);
    }
    // At a travel acceleration limit of 1000 nothing bends: every climb is the 1 degree line.
    let name = "mk4--row--Z2MAT1000";
    let k = Rule::of(name, 0.6, 1.0).k();
    for t in travels(&slice(name)).iter().filter(|t| !t.first) {
        for m in t.ramp().iter().filter(|m| m.dz() > 1e-9 && m.xy() > 1.0) {
            if (m.dz() - k * m.xy()).abs() > 0.0011 {
                wrong.push(format!(
                    "{name}: a climb of {:.3} over {:.3} is not the line",
                    m.dz(),
                    m.xy()
                ));
            }
        }
    }
    done(&wrong);
}

#[test]
fn the_ramp_starts_where_the_wipe_ends() {
    let mut wrong = Vec::new();
    let name = "xl--isl--stock";
    let rule = Rule::of(name, 0.6, 1.0);
    same_layer(name, rule, true, |_| true, &mut wrong);
    layer_changes(name, rule, &mut wrong);
    shape(name, rule, &mut wrong);
    if !travels(&slice(name)).iter().any(Travel::wipes) {
        wrong.push(format!("{name}: no travel wipes"));
    }
    done(&wrong);
}

#[test]
fn the_blend_needs_few_enough_z_jerk_steps() {
    let mut wrong = Vec::new();
    for (name, deg) in [("mk4--row--Z4JZ1", 1.0), ("mk4--row--Z4S2JZ3", 2.0)] {
        let rule = Rule::of(name, 0.6, deg);
        same_layer(name, rule, true, |_| true, &mut wrong);
    }
    done(&wrong);
}

#[test]
fn a_low_z_feed_rate_limit_narrows_the_blend() {
    let mut wrong = Vec::new();
    let name = "mk4--row--Z2FZ3";
    same_layer(name, Rule::of(name, 0.6, 1.0), true, |_| true, &mut wrong);
    done(&wrong);
}

#[test]
fn a_layer_change_ramps_up_from_the_old_layer() {
    let mut wrong = Vec::new();
    for name in ["mk4--isl--stock", "mk4--row--stock"] {
        let (ramps, _) = layer_changes(name, Rule::of(name, 0.6, 1.0), &mut wrong);
        if ramps != 14 {
            wrong.push(format!("{name}: {ramps} layer changes ramp, not 14"));
        }
    }
    done(&wrong);
}

#[test]
fn a_layer_change_ramps_without_a_retraction_and_outside_the_lift_limits() {
    let mut wrong = Vec::new();
    for name in [
        "mk4--isl--RL0",
        "mk4--isl--A5",
        "mk4--isl--B01",
        "mk4--isl--RBT50",
    ] {
        let rule = Rule::of(name, 0.6, 1.0);
        same_layer(name, rule, false, |_| true, &mut wrong);
        let (ramps, _) = layer_changes(name, rule, &mut wrong);
        if ramps != 14 {
            wrong.push(format!("{name}: {ramps} layer changes ramp, not 14"));
        }
    }
    let gcode = slice("mk4--isl--RL0");
    if travels(&gcode).iter().any(Travel::retracts) {
        wrong.push("mk4--isl--RL0 retracts".to_owned());
    }
    done(&wrong);
}

#[test]
fn a_short_layer_change_moves_to_the_new_layer_without_a_drop() {
    let mut wrong = Vec::new();
    let name = "mk4--ring--stock";
    let (ramps, short) = layer_changes(name, Rule::of(name, 0.6, 1.0), &mut wrong);
    if ramps == 0 || short == 0 {
        wrong.push(format!("{name}: {ramps} layer changes ramp and {short} do not"));
    }
    done(&wrong);
}

#[test]
fn a_ramp_as_high_as_the_layer_step_ends_on_the_new_layer() {
    let mut wrong = Vec::new();
    let name = "mk4--isl--FML02";
    let rule = Rule::of(name, 0.2, 1.0);
    same_layer(name, rule, true, |_| true, &mut wrong);
    let (_, short) = layer_changes(name, rule, &mut wrong);
    if short != 14 {
        wrong.push(format!(
            "{name}: {short} layer changes end on the new layer, not 14"
        ));
    }
    done(&wrong);
}

#[test]
fn a_ramp_at_90_degrees_lifts_straight_up_and_not_at_layer_changes() {
    let mut wrong = Vec::new();
    let name = "mk4--isl--FSL90";
    let rule = Rule::of(name, 0.6, 90.0);
    same_layer(name, rule, true, |_| true, &mut wrong);
    shape(name, rule, &mut wrong);
    let (_, short) = layer_changes(name, rule, &mut wrong);
    if short != 14 {
        wrong.push(format!(
            "{name}: {short} layer changes stay at the new layer, not 14"
        ));
    }
    done(&wrong);
}

#[test]
fn a_ramp_of_height_0_never_lifts() {
    let mut wrong = Vec::new();
    for name in [
        "mk4--row--FML0",
        "mk4--isl--FML0",
        "mk4--ring--FML0",
        "xl--row--FML0",
        "xl--isl--FML0",
        "xl--ring--FML0",
    ] {
        let all = travels(&slice(name));
        if !all.iter().any(Travel::retracts) {
            wrong.push(format!("{name}: no retraction"));
        }
        for t in all.iter().filter(|t| t.layer_change || !t.moves.is_empty()) {
            let from = if t.first { t.after_marker } else { 0 };
            let top = t.moves[from..].iter().map(|m| m.to[2]).fold(f64::MIN, f64::max);
            if top > t.end_z + 0.0005 {
                wrong.push(format!("{name}: a travel to Z {} goes up to {top}", t.end_z));
            }
        }
    }
    done(&wrong);
}

#[test]
fn the_first_travel_lifts_straight_up() {
    let mut wrong = Vec::new();
    for (name, lift) in [
        ("mk4--row--stock", Some(0.8)),
        ("mk4--row--FML02", Some(0.4)),
        ("mk4--row--FSL90", Some(0.8)),
        ("mk4--row--A5", None),
        ("mk4--row--RL0", None),
    ] {
        let all = travels(&slice(name));
        let Some(t) = all.iter().find(|t| t.first) else {
            wrong.push(format!("{name}: no first travel"));
            continue;
        };
        let moves = &t.moves[t.after_marker..];
        let Some(across) = moves.iter().position(|m| m.xy() > 0.0) else {
            wrong.push(format!("{name}: the first travel does not move"));
            continue;
        };
        let top = moves.iter().map(|m| m.to[2]).fold(f64::MIN, f64::max);
        match lift {
            Some(z) => {
                let up = moves[..across].last();
                if !up.is_some_and(|m| m.xy() < 1e-9 && (m.to[2] - z).abs() < 1e-6) {
                    wrong.push(format!(
                        "{name}: the first travel moves across from {up:?}, not from Z {z}"
                    ));
                }
                if moves[across..]
                    .iter()
                    .any(|m| m.xy() > 0.0 && (m.to[2] - z).abs() > 1e-6)
                {
                    wrong.push(format!("{name}: the first travel leaves Z {z}"));
                }
                if !t.drops() {
                    wrong.push(format!("{name}: the first travel ends without a drop"));
                }
            }
            None => {
                if top > t.end_z + 0.0005 {
                    wrong.push(format!("{name}: the first travel goes up to {top}"));
                }
            }
        }
    }
    done(&wrong);
}
