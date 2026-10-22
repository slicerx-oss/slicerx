// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Print time the way Bambu Studio estimates it for Bambu Lab printers. The rules below were checked against
//! Bambu Studio's own estimate on the H2D, X2D, A1, P1S and X1 Carbon; other printers keep the planner in the
//! parent module.
//!
//! What differs from that planner:
//! - Junction speed: the two moves' unit directions are compared one axis at a time. Where they differ, the junction
//!   runs at the lowest axis jerk divided by that axis's difference (at most 10000 mm/s), which can be above both top
//!   speeds; with the same direction it is the lower top speed. The extruder plays no part. When both moves' rest
//!   speeds are above 99 % of that, the move's own rest speed is used.
//! - Rest speed (the speed a move may start or end at with nothing around it): each axis whose speed is above its
//!   jerk caps it at that jerk, the extruder's jerk taken directly as a path speed.
//! - The corner cap on gentle turns (under about 29 degrees) uses the move's own acceleration, travel included.
//! - Planning: a forward check, then a backward pass that lifts each entry to the junction speed unless braking to
//!   the next move needs less. A move may enter at a speed the move before it could never reach, so ramping up over
//!   many short moves costs almost nothing; braking is modeled in full.
//! - An arc is one move, capped at `sqrt(print acceleration * radius)`; it starts from the previous move's rest
//!   speed and extruder speed. Bambu Studio leaves arcs given by a radius (R, no I or J) untimed; here they take
//!   the time of the same arc with its center.
//! - A wait is carried by the oldest move still queued; waits with no move after them at the end of the file are
//!   reported apart ([`COUNT_END_WAIT`]).
//! - The travel acceleration has the extruding limit as its ceiling (the `marlin` flavor), `G4` and `M400` add
//!   their S and P, a bare `M221 S` is zero flow, `M702 C` takes the unload time and `M1020 S` changes filament
//!   like `T`.

use super::{Block, Book, Fw, Kind, Machine, Motion, QUEUE, REFRESH, Reader, Trapezoid, has, value};
use crate::config::PrintConfig;
use crate::fm::Fm as _;

/// Whether waits with no move after them at the end of the file count in the total. Bambu Studio leaves them out:
/// on the H2D and X2D that is the end G-code's 361 s (two 180 s air purification waits and 1 s), which the printer
/// runs only in part; on the X1 Carbon and A1 it is about 1 s. Kept counted until that choice is made;
/// [`super::Estimate::end_wait`] reports them either way.
pub(super) const COUNT_END_WAIT: bool = true;

/// The highest junction speed, mm/s.
const JUNCTION_CAP: f64 = 10_000.0;

/// The printers these rules apply to: Bambu Lab printers (the `bambu` flavor, or a `printer_model` that starts with
/// "Bambu Lab") on the `marlin` flavor's planner.
pub(super) fn applies(cfg: &PrintConfig, fw: Fw) -> bool {
    fw == Fw::MarlinLegacy && crate::firmware::bambu_printer(cfg, cfg.gcode_flavor)
}

/// A wait not yet carried by a move: what it may land on (`Noop` any move, `ToolChange` the change itself), its
/// seconds and where it was booked.
#[derive(Debug, Clone, Copy)]
pub(super) struct Wait {
    kind: Kind,
    time: f64,
    book: Book,
}

/// The unit vector of `v`, or zero.
fn unit(v: [f64; 3]) -> [f64; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l > 0.0 {
        [v[0] / l, v[1] / l, v[2] / l]
    } else {
        [0.0; 3]
    }
}

/// The length of the difference of the XY parts of `a` and `b`, each made unit length; None when either has none.
fn turn(a: [f64; 3], b: [f64; 3]) -> Option<f64> {
    let (la, lb) = (a[0].m_hypot(a[1]), b[0].m_hypot(b[1]));
    (la > 0.0 && lb > 0.0).then(|| (b[0] / lb - a[0] / la).m_hypot(b[1] / lb - a[1] / la))
}

/// Cuts `top` and the axis speeds so no axis is above its cap; the new top speed.
fn cap_speed(axis: &mut [f64; 4], top: f64, caps: [f64; 4]) -> f64 {
    let factor = axis
        .iter()
        .zip(caps)
        .filter(|(a, c)| **a != 0.0 && *c != 0.0)
        .fold(1.0f64, |f, (a, c)| f.min(c / a.abs()));
    if factor < 1.0 {
        for a in axis.iter_mut() {
            *a *= factor;
        }
        top * factor
    } else {
        top
    }
}

/// `from`, lowered to the jerk of each axis whose speed is above it.
fn rest_speed(from: f64, axis: &[f64; 4], jerk: [f64; 4]) -> f64 {
    axis.iter()
        .zip(jerk)
        .filter(|(a, j)| a.abs() > *j)
        .fold(from, |v, (_, j)| v.min(j))
}

/// Plans the queue: the forward check, the backward pass, then each move's profile.
#[allow(
    clippy::float_cmp,
    reason = "an entry left at its maximum is compared exactly, as the rules do"
)]
fn plan(blocks: &mut [Block]) {
    for i in 1..blocks.len() {
        if let Some((head, tail)) = blocks.split_at_mut_checked(i)
            && let (Some(p), Some(c)) = (head.last(), tail.first_mut())
            && !p.nominal_length
            && p.entry < c.entry
        {
            c.entry = c
                .entry
                .min(super::speed_from_distance(p.entry, p.distance, p.acceleration));
        }
    }
    for i in (1..blocks.len()).rev() {
        if let Some((head, tail)) = blocks.split_at_mut_checked(i)
            && let (Some(b), Some(n)) = (head.last_mut(), tail.first())
            && b.entry != b.max_entry
        {
            b.entry = if !b.nominal_length && b.max_entry > n.entry {
                b.max_entry
                    .min(super::speed_from_distance(n.entry, b.distance, b.acceleration))
            } else {
                b.max_entry
            };
        }
    }
    let mut exit = blocks.last().map_or(0.0, |b| b.safe);
    for b in blocks.iter_mut().rev() {
        b.exit = exit;
        b.calculate_trapezoid();
        b.recalculate = false;
        exit = b.entry;
    }
}

impl Machine {
    /// Queues a wait and empties the queue (when it holds two moves or more).
    pub(super) fn wait(&mut self, t: f64, kind: Kind, book: Book) {
        if t > 0.0 {
            self.waits.push(Wait { kind, time: t, book });
        }
        self.bbl_calculate(0);
    }

    /// Plans the queue and times all but its newest `keep` moves; a queue of fewer than two moves waits.
    fn bbl_calculate(&mut self, keep: usize) {
        let n = self.blocks.len();
        if n < 2 {
            return;
        }
        plan(&mut self.blocks);
        let process = n.saturating_sub(keep);
        let mut w = 0usize;
        for i in 0..process {
            let Some(b) = self.blocks.get(i).copied() else {
                break;
            };
            let motion = b.time();
            let mut t = motion;
            // The oldest wait, with the ones of its kind right after it, lands on the first move it may.
            if let Some(kind) = self
                .waits
                .get(w)
                .map(|x| x.kind)
                .filter(|k| *k == Kind::Noop || *k == b.kind)
            {
                while let Some(x) = self.waits.get(w).filter(|x| x.kind == kind) {
                    t += x.time;
                    w += 1;
                }
            }
            self.account(&b, motion, t);
        }
        self.waits.drain(..w);
        if keep > 0 {
            self.blocks.drain(..process);
        } else {
            self.blocks.clear();
        }
    }

    /// The end of the file: the last plan, and the waits no move carries, in the total when `count_end_wait`.
    pub(super) fn bbl_finish(&mut self, count_end_wait: bool) {
        self.bbl_calculate(0);
        for x in std::mem::take(&mut self.waits) {
            self.end_wait += x.time;
            if count_end_wait {
                self.time += x.time;
            } else {
                // Booked where it was read; take it back out.
                if let Some(s) = self.segments.get_mut(x.book.segment) {
                    *s -= x.time;
                }
                if let Some(slot) = self.lines.as_mut().and_then(|l| l.get_mut(x.book.line)) {
                    *slot -= x.time;
                }
                if x.book.first {
                    self.first_layer -= x.time;
                }
            }
        }
    }

    /// The highest speed through the junction into a move with motion `curr`.
    fn junction(&self, curr: &Motion) -> f64 {
        let prev = self.prev;
        if self.blocks.is_empty() || prev.feedrate <= 0.0001 {
            return curr.safe;
        }
        let (a, b) = (unit(prev.dir), unit(curr.dir));
        let mut limit = f64::INFINITY;
        for ((x, y), j) in a.iter().zip(b).zip(self.env.jerk) {
            let diff = (y - x).abs();
            if diff > 0.0 {
                limit = limit.min(j / diff);
            }
        }
        let mut v = if limit.is_finite() {
            limit.min(JUNCTION_CAP)
        } else {
            prev.feedrate.min(curr.feedrate)
        };
        if prev.safe > 0.99 * v && curr.safe > 0.99 * v {
            v = curr.safe;
        }
        v
    }

    /// Queues a move with motion `curr` (its direction the one it starts in), `accel` its acceleration and
    /// `allow_accel` the one for its allowed entry speed; `exit_dir` is the direction it ends in.
    #[allow(clippy::too_many_arguments, reason = "one move's values")]
    fn push(
        &mut self,
        kind: Kind,
        distance: f64,
        (accel, allow_accel): (f64, f64),
        curr: Motion,
        exit_dir: [f64; 3],
        (role, prepare): (u16, bool),
        (layer, segment, line): (u32, usize, usize),
    ) {
        let junction = self.junction(&curr);
        let allowed = super::speed_from_distance(curr.safe, distance, allow_accel);
        let mut block = Block {
            kind,
            distance,
            acceleration: accel,
            entry: junction.min(allowed),
            cruise: curr.feedrate,
            exit: curr.safe,
            max_entry: junction,
            safe: curr.safe,
            nominal_length: curr.feedrate <= allowed,
            recalculate: true,
            trap: Trapezoid::default(),
            layer,
            segment,
            line,
            limit: curr.feedrate,
            smooth: 0.0,
            smooth_entry: 0.0,
            smooth_max: f64::INFINITY,
            role,
            prepare,
        };
        block.calculate_trapezoid();
        self.prev = Motion {
            dir: exit_dir,
            ..curr
        };
        self.blocks.push(block);
        if self.blocks.len() > REFRESH {
            self.bbl_calculate(QUEUE);
        }
    }
}

impl Reader {
    fn bbl_place(&self, kind: Kind) -> ((u16, bool), (u32, usize, usize)) {
        (
            (self.role_of(kind), self.prepare),
            (self.layer.max(1), self.segment, self.line),
        )
    }

    /// A `G0`, `G1` or `G28` move of `kind` by `d` (X, Y, Z, E), `distance` long (the E length for an extruder-only
    /// move).
    pub(super) fn bbl_move(&mut self, kind: Kind, d: [f64; 4], distance: f64) {
        let place = self.bbl_place(kind);
        let feed = self.feedrate;
        let m = &mut self.m;
        let xyz = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        let extruder_only = xyz == 0.0;
        let mut top = feed.max(if d[3] == 0.0 {
            m.env.min_travel
        } else {
            m.env.min_extruding
        });
        let requested = if kind == Kind::Travel {
            m.travel
        } else if extruder_only {
            m.retract
        } else {
            m.acceleration
        };
        let dir = if extruder_only {
            [0.0; 3]
        } else {
            [d[0] / xyz, d[1] / xyz, d[2] / xyz]
        };
        // The corner cap on gentle turns: the radius of the turn this move's length makes.
        if !extruder_only
            && let Some(c) = turn(m.prev.dir, dir)
            && c > 0.00001
            && c < 0.5
        {
            top = top.min((requested * d[0].m_hypot(d[1]) / c).sqrt());
        }
        let mut axis = [0.0; 4];
        for (a, dv) in axis.iter_mut().zip(d) {
            *a = top * dv / distance;
        }
        axis[3] *= m.e_factor;
        let top = cap_speed(&mut axis, top, m.env.speed);
        let mut accel = requested;
        for (dv, cap) in d.iter().zip(m.env.accel) {
            let share = dv.abs() / distance;
            if accel * share > cap {
                accel = cap / share;
            }
        }
        let curr = Motion {
            feedrate: top,
            safe: rest_speed(top, &axis, m.env.jerk),
            axis,
            dir,
            ..Motion::default()
        };
        m.push(kind, distance, (accel, accel), curr, dir, place.0, place.1);
    }

    /// `G2` (clockwise) or `G3`: one move along the arc.
    pub(super) fn bbl_arc(&mut self, words: &[&str], clockwise: bool) {
        let mut end = [0.0; 4];
        for (i, (t, k)) in end.iter_mut().zip(super::AXES).enumerate() {
            *t = self.axis_target(i, value(words, k));
        }
        let start = self.start;
        self.end = end;
        if let Some(f) = value(words, b'F') {
            self.feedrate = f / 60.0;
        }
        let closed = (end[0] - start[0]).m_hypot(end[1] - start[1]) <= 1e-6;
        if has(words, b'P') && !(closed && value(words, b'P') == Some(1.0)) {
            return;
        }
        let s = self.scale();
        let (i, j) = (value(words, b'I'), value(words, b'J'));
        let center = if i.is_some() || j.is_some() {
            (start[0] + i.unwrap_or(0.0) * s, start[1] + j.unwrap_or(0.0) * s)
        } else {
            // The radius form, which Bambu Studio does not time: the center from the radius and the chord. A
            // positive R is the short way round, a negative one the long way; a closed arc has no center.
            let Some(r) = value(words, b'R').filter(|r| *r != 0.0 && !closed) else {
                return;
            };
            let r = r * s;
            let (vx, vy) = (end[0] - start[0], end[1] - start[1]);
            let chord = vx.m_hypot(vy);
            // A radius under half the chord cannot reach the end: the arc becomes the half circle on the chord.
            let h = (r * r - chord * chord / 4.0).max(0.0).sqrt();
            // The short way round, the center sits right of the chord for G2 and left of it for G3.
            let side = if (r > 0.0) == clockwise { -1.0 } else { 1.0 };
            (
                f64::midpoint(start[0], end[0]) - side * h * vy / chord,
                f64::midpoint(start[1], end[1]) + side * h * vx / chord,
            )
        };
        let rs = (start[0] - center.0, start[1] - center.1);
        let re = (end[0] - center.0, end[1] - center.1);
        let radius = rs.0.m_hypot(rs.1);
        let angle = if closed {
            std::f64::consts::TAU
        } else {
            let ccw = (rs.0 * re.1 - rs.1 * re.0).m_atan2(rs.0 * re.0 + rs.1 * re.1);
            let a = if clockwise { -ccw } else { ccw };
            if a < 0.0 { a + std::f64::consts::TAU } else { a }
        };
        let plane = radius * angle;
        let dz = end[2] - start[2];
        if plane == 0.0 && dz == 0.0 {
            return;
        }
        let kind = if end[3] - start[3] == 0.0 {
            Kind::Travel
        } else {
            Kind::Extrude
        };
        let distance = plane.m_hypot(dz);
        let place = self.bbl_place(kind);
        let feed = self.feedrate;
        let m = &mut self.m;
        let mut top = feed.max(if kind == Kind::Travel {
            m.env.min_travel
        } else {
            m.env.min_extruding
        });
        if plane > 0.0 {
            top = top.min((m.acceleration * radius).sqrt() * distance / plane);
        }
        let mut axis = [
            top * plane / distance,
            top * plane / distance,
            top * dz / distance,
            m.prev.axis[3] * m.e_factor,
        ];
        let top = cap_speed(&mut axis, top, m.env.speed);
        let requested = if kind == Kind::Travel {
            m.travel
        } else {
            m.acceleration
        };
        let mut accel = requested;
        for (share, cap) in [plane / distance, plane / distance, dz.abs() / distance]
            .into_iter()
            .zip(m.env.accel)
        {
            if accel * share > cap {
                accel = cap / share;
            }
        }
        // The unit tangent in XY at a point `r` from the center.
        let sense = if clockwise { -1.0 } else { 1.0 };
        let tangent = |r: (f64, f64)| {
            let l = r.0.m_hypot(r.1);
            if l > 0.0 {
                [-sense * r.1 / l, sense * r.0 / l, 0.0]
            } else {
                [0.0; 3]
            }
        };
        let curr = Motion {
            feedrate: top,
            safe: rest_speed(m.prev.safe, &axis, m.env.jerk),
            axis,
            dir: tangent(rs),
            ..Motion::default()
        };
        m.push(
            kind,
            distance,
            (accel, requested),
            curr,
            tangent(re),
            place.0,
            place.1,
        );
    }

    /// A filament change to filament `id`: the switch time when the nozzle changes, and the load time when that
    /// nozzle's filament changes, with the unload time too when it held another one. A switch back to a nozzle
    /// that still holds `id` takes the switch time only.
    pub(super) fn bbl_filament_change(&mut self, id: usize) {
        let next = self.filament_map.get(id).copied().unwrap_or(0);
        let active = self
            .extruder
            .and_then(|e| self.filament_of.get(e).copied().flatten());
        if active == Some(id) {
            return;
        }
        let mut extra = 0.0;
        if self.extruder.is_some_and(|e| e != next) {
            extra += self.change_time;
        }
        if let Some(slot) = self.filament_of.get_mut(next) {
            match *slot {
                Some(f) if f == id => {}
                Some(_) => extra += self.unload_time + self.load_time,
                None => extra += self.load_time,
            }
            *slot = Some(id);
        }
        self.extruder = Some(next);
        self.change_stop(extra);
    }

    /// The commands these rules read differently; false for the rest.
    pub(super) fn bbl_line(&mut self, cmd: &str, words: &[&str]) -> bool {
        match cmd {
            "G2" | "G3" => self.bbl_arc(words, cmd == "G2"),
            "G4" | "M400" => {
                let (s, p) = (value(words, b'S'), value(words, b'P'));
                if s.is_some() || p.is_some() {
                    self.sync(s.unwrap_or(0.0) + p.unwrap_or(0.0) * 0.001);
                }
            }
            "M221" => {
                if has(words, b'S') && !has(words, b'T') {
                    self.m.e_factor = value(words, b'S').unwrap_or(0.0) * 0.01;
                }
            }
            "M702" => {
                if has(words, b'C') {
                    self.sync(self.unload_time);
                }
            }
            "M1020" => {
                if let Some(n) = value(words, b'S').filter(|n| (0.0..=254.0).contains(n) && n.fract() == 0.0)
                {
                    #[allow(
                        clippy::cast_possible_truncation,
                        clippy::cast_sign_loss,
                        reason = "a filament number from 0 to 254"
                    )]
                    let id = n as usize;
                    if id < self.filaments {
                        self.filament_change(id);
                    }
                }
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::estimate;
    use crate::config::{GcodeFlavor, PrintConfig};
    use crate::fm::Fm as _;
    use std::fmt::Write as _;

    /// The H2D's settings as its preset has them.
    fn h2d() -> PrintConfig {
        let mut c = PrintConfig::default();
        for (k, v) in [
            ("printer_model", serde_json::json!("Bambu Lab H2D")),
            ("machine_max_speed_x", serde_json::json!(["1000", "1000"])),
            ("machine_max_speed_y", serde_json::json!(["1000", "1000"])),
            ("machine_max_speed_z", serde_json::json!(["30", "30"])),
            ("machine_max_speed_e", serde_json::json!(["50", "50"])),
            (
                "machine_max_acceleration_x",
                serde_json::json!(["20000", "20000"]),
            ),
            (
                "machine_max_acceleration_y",
                serde_json::json!(["20000", "20000"]),
            ),
            ("machine_max_acceleration_z", serde_json::json!(["500", "500"])),
            ("machine_max_acceleration_e", serde_json::json!(["5000", "5000"])),
            (
                "machine_max_acceleration_extruding",
                serde_json::json!(["20000", "20000"]),
            ),
            (
                "machine_max_acceleration_retracting",
                serde_json::json!(["5000", "5000"]),
            ),
            (
                "machine_max_acceleration_travel",
                serde_json::json!(["9000", "9000"]),
            ),
            ("machine_max_jerk_x", serde_json::json!(["9", "9"])),
            ("machine_max_jerk_y", serde_json::json!(["9", "9"])),
            ("machine_max_jerk_z", serde_json::json!(["3", "3"])),
            ("machine_max_jerk_e", serde_json::json!(["2.5", "2.5"])),
            ("machine_min_extruding_rate", serde_json::json!(["0", "0"])),
            ("machine_min_travel_rate", serde_json::json!(["0", "0"])),
            ("machine_load_filament_time", serde_json::json!("26")),
            ("machine_unload_filament_time", serde_json::json!("26")),
            ("machine_switch_extruder_time", serde_json::json!("5.6")),
            ("filament_map", serde_json::json!(["1"])),
        ] {
            c.raw.insert(k.to_owned(), v);
        }
        c.gcode_flavor = GcodeFlavor::Marlin;
        c
    }

    const START: &str =
        "M201 X20000 Y20000 Z500 E5000\nM203 X1000 Y1000 Z30 E50\nM205 X9.00 Y9.00 Z3.00 E2.50\nM221 S100\n";
    const PRE: &str = "G4 S0\nG90\nM83\nM204 S8000\nG1 X100 Y100 Z20 F60000\nG1 X100 Y101 F60000\nG4 S0\n";
    const POST: &str = "G4 S0\nG1 X90 Y90 Z20 F60000\nG1 X90 Y91 F60000\nG4 S0\n";

    fn total(text: &str) -> f64 {
        estimate(text.as_bytes(), &h2d(), false).total
    }

    /// The time `block` adds between the micro test's lead-in and lead-out.
    fn block_time(block: &str) -> f64 {
        total(&format!("{START}{PRE}{block}{POST}")) - total(&format!("{START}{PRE}{POST}"))
    }

    fn start(x: f64, y: f64) -> String {
        format!("G1 X{x} Y{y} F60000\nG4 S0\n")
    }

    /// `n` moves of `step` mm along X from (100, 100), extruding `e` per move when given.
    fn line(n: usize, step: f64, e: Option<f64>, feed: u32) -> String {
        let mut s = start(100.0, 100.0);
        for i in 1..=n {
            #[allow(clippy::cast_precision_loss, reason = "a move count")]
            let x = 100.0 + step * i as f64;
            let _ = write!(s, "G1 X{x:.4} Y100");
            if let Some(e) = e {
                let _ = write!(s, " E{e:.5}");
            }
            let _ = writeln!(s, " F{feed}");
        }
        s
    }

    /// `laps` laps of a regular `sides`-gon of `radius` around (100, 100), counterclockwise from angle 0, with
    /// 0.04 mm of filament per mm when `extrude`.
    fn polygon(sides: usize, radius: f64, laps: usize, feed: u32, extrude: bool) -> String {
        let mut s = start(100.0 + radius, 100.0);
        #[allow(clippy::cast_precision_loss, reason = "a side count")]
        let step = std::f64::consts::TAU / sides as f64;
        let side = 2.0 * radius * (step / 2.0).m_sin();
        for k in 1..=sides * laps {
            #[allow(clippy::cast_precision_loss, reason = "a side count")]
            let a = step * (k % sides) as f64;
            let _ = write!(
                s,
                "G1 X{:.4} Y{:.4}",
                100.0 + radius * a.m_cos(),
                100.0 + radius * a.m_sin()
            );
            if extrude {
                let _ = write!(s, " E{:.5}", side * 0.04);
            }
            let _ = writeln!(s, " F{feed}");
        }
        s
    }

    fn lift(helix: bool) -> String {
        let mut s = start(100.0, 100.0);
        for k in 0..50 {
            s += "G1 E-.8 F1800\nG17\nG91\n";
            s += if helix {
                "G3 Z0.4 I1.217 J0 P1 F60000\n"
            } else {
                "G1 Z0.4 F60000\n"
            };
            let x = if k % 2 == 0 { 105 } else { 100 };
            let _ = write!(s, "G90\nG1 X{x} Y100 F60000\nG91\nG1 Z-0.4\nG90\nG1 E.8 F1800\n");
        }
        s
    }

    fn close(test: &str, actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.002,
            "{test}: {actual:.4} against {expected:.4}"
        );
    }

    #[test]
    fn straight_lines_match_the_reference_blocks() {
        close(
            "line-1x100-travel",
            block_time(&line(1, 100.0, None, 12000)),
            0.6918,
        );
        close(
            "line-1000x0.1-travel",
            block_time(&line(1000, 0.1, None, 12000)),
            0.6839,
        );
        close(
            "line-1x100-extrude",
            block_time(&line(1, 100.0, Some(4.0), 12000)),
            0.6926,
        );
        close(
            "line-1000x0.1-extrude",
            block_time(&line(1000, 0.1, Some(0.004), 12000)),
            0.6847,
        );
        close(
            "line-100x1-extrude",
            block_time(&line(100, 1.0, Some(0.04), 12000)),
            0.6909,
        );
        close(
            "line-1x100-travel-F60000",
            block_time(&line(1, 100.0, None, 60000)),
            0.3904,
        );
        close(
            "line-200x0.5-travel-F60000",
            block_time(&line(200, 0.5, None, 60000)),
            0.3400,
        );
        close(
            "line-250x0.4-travel-F60000",
            block_time(&line(250, 0.4, None, 60000)),
            0.3389,
        );
        // Past 256 queued moves the oldest are timed as if the newest stops: the window caps the cruise speed.
        close(
            "line-1000x0.1-travel-F60000",
            block_time(&line(1000, 0.1, None, 60000)),
            0.4078,
        );
        // A bare `M221 S` is zero flow, so the extruding line times like the travel.
        let bare = format!("M221 S\n{}M221 S100\n", line(1000, 0.1, Some(0.004), 12000));
        close("line-1000x0.1-extrude-M221S", block_time(&bare), 0.6839);
    }

    #[test]
    fn polygons_and_circles_match_the_reference_blocks() {
        close(
            "circle-r5-g1-360x10",
            block_time(&polygon(360, 5.0, 10, 18000, true)),
            1.6432,
        );
        close(
            "circle-r5-g1-72x10",
            block_time(&polygon(72, 5.0, 10, 18000, true)),
            2.6484,
        );
        close(
            "poly-r10-12-x10",
            block_time(&polygon(12, 10.0, 10, 12000, true)),
            5.6495,
        );
        close(
            "poly-r10-13-x10",
            block_time(&polygon(13, 10.0, 10, 12000, true)),
            5.8033,
        );
        close(
            "poly-r10-12-x10-travel",
            block_time(&polygon(12, 10.0, 10, 12000, false)),
            5.6483,
        );
        // 30 degree turns get no corner cap; 27.7 degree turns are capped at sqrt(8000 * 2) mm/s.
        close(
            "poly-r2-12-x10",
            block_time(&polygon(12, 2.0, 10, 18000, true)),
            2.2517,
        );
        close(
            "poly-r2-13-x10",
            block_time(&polygon(13, 2.0, 10, 18000, true)),
            2.2780,
        );
        close(
            "square-r10-x10",
            block_time(&polygon(4, 10.0, 10, 12000, true)),
            3.8550,
        );
    }

    #[test]
    fn arcs_are_single_moves() {
        let quarter = std::f64::consts::FRAC_PI_2 * 5.0 * 0.04;
        let mut quarters = start(105.0, 100.0);
        let mut full = start(105.0, 100.0);
        for _ in 0..10 {
            for (x, y, i, j) in [
                (100, 105, -5, 0),
                (95, 100, 0, -5),
                (100, 95, 5, 0),
                (105, 100, 0, 5),
            ] {
                let _ = writeln!(quarters, "G3 X{x} Y{y} I{i} J{j} E{quarter:.5} F18000");
            }
            let _ = writeln!(full, "G3 X105 Y100 I-5 J0 E{:.5} F18000", quarter * 4.0);
        }
        close("circle-r5-g3-quarters-x10", block_time(&quarters), 1.6506);
        close("circle-r5-g3-full-x10", block_time(&full), 1.6506);
        // The travel lift is one full turn of a helix, not chords.
        close("helix-lift-x50", block_time(&lift(true)), 11.9865);
        close("straight-lift-x50", block_time(&lift(false)), 9.5800);
    }

    #[test]
    fn reversals_and_speed_steps_match_the_reference_blocks() {
        let mut zigzag = start(100.0, 100.0);
        for k in 0..200 {
            let x = if k % 2 == 0 { "100.5000" } else { "100.0000" };
            let _ = writeln!(zigzag, "G1 X{x} Y100 F12000");
        }
        close("zigzag-200x0.5", block_time(&zigzag), 2.7622);
        let step = format!(
            "{}G1 X150 Y100 E2 F18000\nG1 X200 Y100 E2 F6000\nG1 X250 Y100 E2 F18000\n",
            start(100.0, 100.0)
        );
        close("speed-step", block_time(&step), 1.1054);
    }

    /// The top speed of a move `length` long at 1000 mm/s after a move along X, turned so that the two unit
    /// directions differ by `c`.
    fn capped_top(c: f64, length: f64) -> f64 {
        let mut r = super::super::Reader::new(&h2d(), None);
        for l in START
            .lines()
            .chain(["G90", "M204 S8000", "G1 X100 Y100 F60000", "G1 X110 Y100"])
        {
            r.line(l);
        }
        let a = 2.0 * (c / 2.0).m_asin();
        r.line(&format!(
            "G1 X{:.12} Y{:.12}",
            110.0 + length * a.m_cos(),
            100.0 + length * a.m_sin()
        ));
        r.m.blocks.last().map(|b| b.cruise).unwrap_or_default()
    }

    #[test]
    fn the_corner_cap_window_edges() {
        // Inside the window the cap is sqrt(acceleration * length / c).
        let inside = capped_top(0.49, 1.0);
        assert!((inside - (8000.0 / 0.49f64).sqrt()).abs() < 1e-3, "{inside}");
        assert!((capped_top(0.501, 1.0) - 1000.0).abs() < 1e-9);
        let tiny = capped_top(0.000_02, 0.001);
        assert!(
            (tiny - (8000.0 * 0.001 / 0.000_02f64).sqrt()).abs() < 1.0,
            "{tiny}"
        );
        assert!((capped_top(0.000_005, 0.001) - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn a_reversal_runs_at_the_rest_speed() {
        // Travels reversing on X: the axis difference is 2, so 9 / 2 = 4.5 mm/s, but both rest speeds (9) are above
        // 99 % of it, so the junction runs at the rest speed.
        let mut r = super::super::Reader::new(&h2d(), None);
        for l in START
            .lines()
            .chain(["G90", "M83", "M204 S8000", "G1 X100 Y100 F12000", "G1 X110 Y100"])
        {
            r.line(l);
        }
        r.line("G1 X100 Y100");
        let b = r.m.blocks.last().copied().expect("a queued move");
        assert!((b.max_entry - 9.0).abs() < 1e-9, "{}", b.max_entry);
    }

    #[test]
    fn extruder_only_moves_have_no_direction() {
        let mut r = super::super::Reader::new(&h2d(), None);
        for l in START.lines().chain([
            "G90",
            "M83",
            "M204 S8000",
            "G1 X100 Y100 F12000",
            "G1 E-0.8 F1800",
        ]) {
            r.line(l);
        }
        assert!(r.m.prev.dir.iter().all(|v| *v == 0.0));
        // A travel along X after the retract has a junction of 9 mm/s, a diagonal one 9 / 0.707.
        r.line("G1 X120 Y100 F12000");
        let along = r.m.blocks.last().map(|b| b.max_entry).unwrap_or_default();
        assert!((along - 9.0).abs() < 1e-9, "{along}");
        r.line("G1 E-0.8 F1800");
        r.line("G1 X130 Y110 F12000");
        let diagonal = r.m.blocks.last().map(|b| b.max_entry).unwrap_or_default();
        assert!(
            (diagonal - 9.0 * std::f64::consts::SQRT_2).abs() < 1e-9,
            "{diagonal}"
        );
    }

    #[test]
    fn the_queue_times_all_but_the_newest_64_past_256() {
        let mut r = super::super::Reader::new(&h2d(), None);
        for l in START.lines().chain(["G90", "G1 X0 Y0 F12000"]) {
            r.line(l);
        }
        for i in 1..=257 {
            r.line(&format!("G1 X{i}"));
        }
        assert_eq!(r.m.blocks.len(), 64);
        assert!(r.m.time > 0.0);
    }

    #[test]
    fn a_lone_move_waits_and_end_waits_are_reported() {
        // One move then a wait: the queue of one is not timed, so the wait stays pending to the end of the file.
        let e = estimate(b"G1 X100 F6000\nM400 S180\n", &h2d(), false);
        assert!((e.end_wait - 180.0).abs() < 1e-9, "{e:?}");
        assert!((e.total - if super::COUNT_END_WAIT { 180.0 } else { 0.0 }).abs() < 1e-9);
        // A wait lands on the oldest queued move: here the first, so its feature carries it.
        let text = "; FEATURE: Outer wall\nM83\nG1 X10 E1 F6000\n; FEATURE: Inner wall\nG1 X20 E1\nG1 X30 E1\nG4 S5\n";
        let e = estimate(text.as_bytes(), &h2d(), false);
        let outer = e
            .features
            .iter()
            .find(|f| f.0 == "Outer wall")
            .map_or(0.0, |f| f.1);
        assert!(outer > 5.0, "{e:?}");
        assert!(e.end_wait.abs() < 1e-12);
        let sum: f64 = e.features.iter().map(|f| f.1).sum();
        assert!((sum - e.total).abs() < 1e-9);
    }

    #[test]
    fn arcs_with_a_turn_count_are_full_turns_only() {
        let base = total("G1 X10 Y10 F6000\nG1 X20 Y10\nG4 S0\n");
        // P1 back to the start is a full turn; P2 or P1 to another point is not timed but still moves.
        let one = total("G1 X10 Y10 F6000\nG3 X10 Y10 I2 J0 P1\nG1 X20 Y10\nG4 S0\n");
        let two = total("G1 X10 Y10 F6000\nG3 X10 Y10 I2 J0 P2\nG1 X20 Y10\nG4 S0\n");
        let other = total("G1 X10 Y10 F6000\nG3 X14 Y10 I2 J0 P1\nG1 X20 Y10\nG4 S0\n");
        let plain = total("G1 X10 Y10 F6000\nG1 X14 Y10\nG1 X20 Y10\nG4 S0\n");
        assert!(one > base + 0.1, "{one} {base}");
        assert!((two - base).abs() < 1e-9, "{two} {base}");
        // The untimed arc still moves the head to X14, so the travel after it starts there.
        assert!(other < plain, "{other} {plain}");
    }

    #[test]
    fn radius_arcs_take_the_time_of_the_same_arc_with_a_center() {
        // From (10, 0) to (0, 10) on a circle of radius 10: the short way round has its center at (0, 0) for G3 and
        // at (10, 10) for G2; the long way round (negative R) the other way.
        let lead = "M83\nG1 X10 Y0 F6000\n";
        let tail = "G1 X0 Y20\nG4 S0\n";
        for (arc, center) in [
            ("G3 X0 Y10 R10", "G3 X0 Y10 I-10 J0"),
            ("G2 X0 Y10 R10", "G2 X0 Y10 I0 J10"),
            ("G3 X0 Y10 R-10", "G3 X0 Y10 I0 J10"),
            ("G2 X0 Y10 R-10", "G2 X0 Y10 I-10 J0"),
        ] {
            let r = total(&format!("{lead}{arc} E2\n{tail}"));
            let c = total(&format!("{lead}{center} E2\n{tail}"));
            assert!((r - c).abs() < 1e-9, "{arc}: {r} against {c}");
            assert!(r > total(&format!("{lead}G1 X0 Y10 E2\n{tail}")), "{arc}");
        }
        // A radius under half the chord (14.14 mm here) is the half circle on the chord, either sign.
        let half = total(&format!("{lead}G3 X0 Y10 I-5 J5 E2\n{tail}"));
        for short in ["R5", "R-5"] {
            let r = total(&format!("{lead}G3 X0 Y10 {short} E2\n{tail}"));
            assert!((r - half).abs() < 1e-9, "{short}: {r} against {half}");
        }
        // No center to find: zero R, or an arc back to its start.
        let plain = total(&format!("{lead}G1 X0 Y10 E2\n{tail}"));
        let skipped = total(&format!("{lead}G3 X10 Y0 R5 E2\nG1 X0 Y10 E2\n{tail}"));
        let zero = total(&format!("{lead}G3 X10 Y0 R0 E2\nG1 X0 Y10 E2\n{tail}"));
        assert!((skipped - plain).abs() < 1e-9 && (zero - plain).abs() < 1e-9);
    }

    #[test]
    fn the_travel_acceleration_tops_out_at_the_extruding_limit() {
        // After `M204 S10000` a travel uses 10000, not the 9000 travel limit (the `marlin` flavor).
        let travel = |accel: &str| {
            total(&format!(
                "{START}G90\nM204 S{accel}\nG1 X100 Y100 F60000\nG4 S0\nG1 X165 Y100\nG1 X165 Y101\nG4 S0\n"
            ))
        };
        let (ten, nine) = (travel("10000"), travel("9000"));
        assert!(ten < nine - 0.001, "{ten} {nine}");
        // `M204 S` above the limit stops at it.
        assert!((travel("20000") - travel("40000")).abs() < 1e-12);
    }

    #[test]
    fn filament_changes_take_load_switch_and_unload_time() {
        let mut c = h2d();
        c.raw
            .insert("filament_diameter".into(), serde_json::json!([1.75, 1.75, 1.75]));
        c.raw
            .insert("filament_map".into(), serde_json::json!(["1", "2", "1"]));
        let with = |text: &str| estimate(text.as_bytes(), &c, false);
        // The first load: 26 s, as `Flush`.
        let e = with("G1 X10 F6000\nT0\nG1 X20\nG1 X30\nG4 S0\n");
        let flush = e.features.iter().find(|f| f.0 == "Flush").map_or(0.0, |f| f.1);
        assert!((flush - 26.0).abs() < 1e-9, "{e:?}");
        // To the other nozzle: switch and load. Back to the first nozzle with a new filament: switch, unload, load.
        let e = with("G1 X10 F6000\nT0\nG1 X20\nT1\nG1 X30\nT2\nG1 X40\nG1 X50\nG4 S0\n");
        let flush = e.features.iter().find(|f| f.0 == "Flush").map_or(0.0, |f| f.1);
        assert!((flush - (26.0 + 31.6 + 57.6)).abs() < 1e-9, "{e:?}");
        // `M1020 S` changes filament as `T` does.
        let m = with("G1 X10 F6000\nM1020 S0\nG1 X20\nG1 X30\nG4 S0\n");
        assert!((m.total - with("G1 X10 F6000\nT0\nG1 X20\nG1 X30\nG4 S0\n").total).abs() < 1e-9);
    }

    /// The `Flush` time of `text` on the H2D with filaments mapped to the nozzles of `map`.
    fn flush_with_map(map: serde_json::Value, text: &str) -> f64 {
        let mut c = h2d();
        c.raw
            .insert("filament_diameter".into(), serde_json::json!([1.75, 1.75]));
        c.raw.insert("filament_map".into(), map);
        let e = estimate(text.as_bytes(), &c, false);
        e.features.iter().find(|f| f.0 == "Flush").map_or(0.0, |f| f.1)
    }

    const BACK_AND_FORTH: &str =
        "G1 X10 F6000\nT0\nG1 X20\nT1\nG1 X30\nT0\nG1 X40\nT1\nG1 X50\nG1 X60\nG4 S0\n";

    #[test]
    fn a_switch_back_to_a_nozzle_that_holds_the_filament_takes_the_switch_time_only() {
        // One filament per nozzle: each nozzle loads once (26 s), every switch takes 5.6 s.
        let flush = flush_with_map(serde_json::json!(["1", "2"]), BACK_AND_FORTH);
        assert!(
            (flush - (26.0 + (5.6 + 26.0) + 5.6 + 5.6)).abs() < 1e-9,
            "{flush}"
        );
    }

    #[test]
    fn filaments_sharing_a_nozzle_unload_and_load_on_each_change() {
        // Both filaments on one nozzle: no switch, and each change unloads and loads (26 s each).
        let flush = flush_with_map(serde_json::json!(["1", "1"]), BACK_AND_FORTH);
        assert!((flush - (26.0 + 3.0 * 52.0)).abs() < 1e-9, "{flush}");
    }

    #[test]
    fn end_waits_are_reported_and_counted_only_when_set() {
        // The H2D end G-code's two 180 s waits and 1 s, with no move after them.
        let body = "M83\nG1 X10 F6000\nG1 X20 E1\nG1 X30 E1\nG4 S0\n";
        let text = format!("{body}M400 S180\nM400 S180\nG4 S1\n");
        let base = super::super::estimate_counting(body.as_bytes(), &h2d(), false, true).total;
        for count in [true, false] {
            let e = super::super::estimate_counting(text.as_bytes(), &h2d(), true, count);
            assert!((e.end_wait - 361.0).abs() < 1e-9, "{count}: {e:?}");
            let want = if count { base + 361.0 } else { base };
            assert!(
                (e.total - want).abs() < 1e-9,
                "{count}: {} against {want}",
                e.total
            );
            // The time at the last line agrees with the total either way.
            let last = e.lines.last().copied().unwrap_or(0.0);
            assert!(
                (last - e.total).abs() < 1e-9,
                "{count}: {last} against {}",
                e.total
            );
        }
    }

    #[test]
    fn travel_counts_apart_and_the_start_sequence_is_prepare() {
        let text = "; FEATURE: Custom\nG1 X10 F6000\nG1 X20\n; FEATURE: Outer wall\nM83\nG1 X30 E1\nG1 X40\nG1 X50 E1\nG4 S0\n";
        let e = estimate(text.as_bytes(), &h2d(), false);
        assert!(e.prepare > 0.0 && e.travel > 0.0, "{e:?}");
        let undefined = e
            .features
            .iter()
            .find(|f| f.0 == "Undefined")
            .map_or(0.0, |f| f.1);
        assert!((undefined - e.travel).abs() < 1e-9, "{e:?}");
        let custom = e.features.iter().find(|f| f.0 == "Custom").map_or(0.0, |f| f.1);
        assert!((custom - e.prepare).abs() < 1e-9, "{e:?}");
        // Printers of other makers keep their planner.
        let mut other = h2d();
        other
            .raw
            .insert("printer_model".into(), serde_json::json!("Generic Marlin"));
        assert!((estimate(text.as_bytes(), &other, false).total - e.total).abs() > 1e-6);
    }
}
