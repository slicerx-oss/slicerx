// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Fan lead time (`pre_start_fan_time`, a filament setting in seconds, 0 to 5): a part fan raise inside a layer
//! (an overhang wall, a bridge, an internal bridge, a support interface) moves earlier by about that much print
//! time, so the fan is already spinning faster when the nozzle reaches the path that needs it.
//!
//! The layer writer marks each movable raise; [`apply`] then walks back from it through the layer's moves:
//!
//! - Time is move length over the commanded feedrate (arcs by their arc length, a move of the extruder alone by its
//!   length of filament). Dwells and acceleration count nothing.
//! - A run of extruding moves is one unit: the raise goes before the whole run or after it, never inside, and no move
//!   is split. Every other move (a travel, a lift, a wipe, a retraction or a priming) is a unit of its own.
//! - The raise lands before the first unit, counting back, that starts at least the lead time before it.
//! - It never crosses another part fan command of the layer (it lands right after it), a tool change (right after
//!   the change), or the start of the layer. Clamped at the start, it goes before the layer's own fan line, and that
//!   line takes the raised value, so the fan does not dip during the layer change.
//!
//! Drops, fan off, the layer's own fan, the fan after a tool change, custom G-code fans and the ironing raise never
//! move, and no fan command is added or removed. With no lead on any filament nothing here runs, so the G-code is
//! byte for byte what it was without the setting.

use crate::config::{GcodeFlavor, PrintConfig};
use crate::fm::Fm as _;

/// The end of a movable raise's line, followed by the lead in thousandths of a second (`M106 S255 ;@R2000`).
/// [`apply`] moves the line and removes the mark.
const RAISE_MARK: &[u8] = b" ;@R";

/// A line the writer puts right after a tool change: no raise moves across it. [`apply`] removes it.
pub(crate) const WALL: &[u8] = b";@W\n";

/// [`WALL`] without its line break, as a line.
const WALL_LINE: &[u8] = b";@W";

/// The longest lead the setting takes, in seconds.
pub const MAX_LEAD_S: f64 = 5.0;

/// The lead of a filament slot in seconds: `pre_start_fan_time`, 0 when the profile has none.
pub(crate) fn lead_s(c: &PrintConfig, slot: u8) -> f64 {
    let v = crate::tower::per_slot_raw(c, "pre_start_fan_time", slot, 0.0);
    if v.is_finite() {
        v.clamp(0.0, MAX_LEAD_S)
    } else {
        0.0
    }
}

/// Whether any of a layer's filaments has a lead: only then does the writer mark raises and tool changes.
pub(crate) fn any_lead(c: &PrintConfig, tools: u8) -> bool {
    (1..=tools.max(1)).any(|s| lead_s(c, s) > 0.0)
}

/// `cmd` (a fan command and its line break) marked as a raise that may move `lead` seconds earlier.
pub(crate) fn raise_line(cmd: &str, lead: f64) -> String {
    #[allow(clippy::cast_possible_truncation, reason = "the lead is at most 5 seconds")]
    let ms = (lead * 1000.0).round() as i64;
    format!("{} ;@R{ms}\n", cmd.trim_end())
}

/// What a line of the layer is to the walk.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    /// A move and its print time in seconds. `run` when it extrudes while moving in XY.
    Move { time: f64, run: bool },
    /// A part fan command the walk stops at, or a tool change.
    Stop,
    /// The layer's own fan line (`;@N`): the walk passes it.
    LayerFan,
    /// A raise still to place, with its lead in seconds.
    Raise(f64),
    /// Anything else: comments, temperatures, dwells, feed rate lines.
    Other,
}

/// Where the nozzle is and how moves read, while the lines are classified.
struct State {
    pos: [Option<f64>; 3],
    feed: Option<f64>,
    relative_xyz: bool,
    relative_e: bool,
    e: f64,
}

/// The value of an axis word (`X1.5`, `E-.8`) in a line's code, if there is one.
fn word(code: &str, axis: u8) -> Option<f64> {
    code.split_ascii_whitespace()
        .skip(1)
        .find_map(|w| {
            w.as_bytes()
                .first()
                .filter(|&&c| c.eq_ignore_ascii_case(&axis))
                .and(w.get(1..))
        })
        .and_then(|v| v.parse().ok())
}

/// Whether a fan command drives the part fan. `M106 P2` and `P3` are the auxiliary and chamber fans; `P0` and `P1`
/// are the part fan on printers with numbered fans. Mach3 and Machinekit write the speed in `P`.
fn part_fan(code: &str, flavor: GcodeFlavor) -> bool {
    let mut words = code.split_ascii_whitespace();
    match words.next() {
        Some("M107" | "M126" | "M127") => true,
        Some("M106") => {
            matches!(flavor, GcodeFlavor::Mach3 | GcodeFlavor::Machinekit)
                || !words.any(|w| matches!(w, "P2" | "P3"))
        }
        _ => false,
    }
}

/// The time of one move from `s`, updating `s`. None when the line is no move.
fn move_time(code: &str, s: &mut State) -> Option<(f64, bool)> {
    let g = code.split_ascii_whitespace().next()?;
    let arc = match g {
        "G0" | "G1" | "G00" | "G01" => None,
        "G2" | "G02" => Some(false),
        "G3" | "G03" => Some(true),
        _ => return None,
    };
    if let Some(f) = word(code, b'F') {
        s.feed = Some(f);
    }
    let [px, py, pz] = s.pos;
    // Where each axis goes: None when the line leaves it, Some(None) when it moves by an amount from an unknown place.
    let target = |axis: u8, from: Option<f64>| {
        word(code, axis).map(|v| {
            if s.relative_xyz {
                from.map(|p| p + v)
            } else {
                Some(v)
            }
        })
    };
    let (tx, ty, tz) = (target(b'X', px), target(b'Y', py), target(b'Z', pz));
    let e = word(code, b'E');
    let turns = word(code, b'P').unwrap_or(0.0);
    if tx.is_none() && ty.is_none() && tz.is_none() && e.is_none() && arc.is_none() {
        // a feed rate line
        return None;
    }
    let moves_xy = tx.is_some() || ty.is_some() || arc.is_some() && turns > 0.0;
    let delta = |to: Option<Option<f64>>, from: Option<f64>| match (to, from) {
        (None, _) => Some(0.0),
        (Some(Some(to)), Some(from)) => Some(to - from),
        _ => None,
    };
    // A height not known yet (the layer change lifts before any Z is written) counts as no climb: the lift is a
    // fraction of a millimeter beside the move.
    let (dx, dy, dz) = (delta(tx, px), delta(ty, py), delta(tz, pz).unwrap_or(0.0));
    let xy = match (arc, dx, dy) {
        (Some(ccw), Some(dx), Some(dy)) => {
            let (i, j) = (word(code, b'I').unwrap_or(0.0), word(code, b'J').unwrap_or(0.0));
            let tau = std::f64::consts::TAU;
            let a0 = (-j).m_atan2(-i);
            let a1 = (dy - j).m_atan2(dx - i);
            let mut sweep = (if ccw { a1 - a0 } else { a0 - a1 }).rem_euclid(tau);
            if sweep <= 1e-9 && dx.abs() < 1e-9 && dy.abs() < 1e-9 {
                // back where it started: whole turns, at least one
                sweep = tau * turns.max(1.0);
            } else {
                sweep += tau * turns.max(0.0);
            }
            Some(i.m_hypot(j) * sweep)
        }
        (None, Some(dx), Some(dy)) => Some(dx.m_hypot(dy)),
        _ => None,
    };
    let de = e.map(|v| if s.relative_e { v } else { v - s.e });
    if let Some(v) = e {
        s.e = if s.relative_e { s.e + v } else { v };
    }
    let length = xy.map(|xy| {
        if xy > 0.0 || dz.abs() > 0.0 {
            xy.m_hypot(dz)
        } else {
            de.map_or(0.0, f64::abs)
        }
    });
    for (pos, to) in s.pos.iter_mut().zip([tx, ty, tz]) {
        if let Some(to) = to {
            *pos = to;
        }
    }
    // An unknown start (the layer's first move) or feed rate counts no time: the walk then reaches the layer
    // start, which is where a raise before that move would land anyway.
    let time = match (length, s.feed) {
        (Some(l), Some(f)) if f > 0.0 => l / (f / 60.0),
        _ => 0.0,
    };
    let run = moves_xy && de.is_some_and(|d| d > 0.0);
    Some((time, run))
}

fn classify(lines: &[&[u8]], flavor: GcodeFlavor) -> Vec<Kind> {
    let mut s = State {
        pos: [None; 3],
        feed: None,
        relative_xyz: false,
        relative_e: true,
        e: 0.0,
    };
    lines
        .iter()
        .map(|&line| {
            if line == WALL_LINE {
                return Kind::Stop;
            }
            let text = std::str::from_utf8(line).unwrap_or("");
            if let Some(at) = line.windows(RAISE_MARK.len()).position(|w| w == RAISE_MARK) {
                let ms: f64 = text
                    .get(at + RAISE_MARK.len()..)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.0);
                return Kind::Raise(ms / 1000.0);
            }
            let layer_fan = line.ends_with(crate::firmware::FAN_MARK);
            let code = text.split(';').next().unwrap_or("").trim();
            match code.split_ascii_whitespace().next() {
                Some("G90") => s.relative_xyz = false,
                Some("G91") => s.relative_xyz = true,
                Some("M82") => s.relative_e = false,
                Some("M83") => s.relative_e = true,
                Some("G92") => {
                    if let Some(v) = word(code, b'E') {
                        s.e = v;
                    }
                    for (pos, &axis) in s.pos.iter_mut().zip(b"XYZ") {
                        if let Some(v) = word(code, axis) {
                            *pos = Some(v);
                        }
                    }
                }
                _ => {}
            }
            if part_fan(code, flavor) {
                return if layer_fan { Kind::LayerFan } else { Kind::Stop };
            }
            match move_time(code, &mut s) {
                Some((time, run)) => Kind::Move { time, run },
                None => Kind::Other,
            }
        })
        .collect()
}

/// Where a raise at `at` lands: the index it goes before, and whether it lands ahead of the layer's own fan line.
fn landing(kinds: &[Kind], at: usize, lead: f64) -> (usize, bool) {
    let mut spent = 0.0;
    // The extruding run being walked: where it starts and its time so far.
    let mut run: Option<(usize, f64)> = None;
    let mut passed_layer_fan = false;
    for (i, kind) in kinds.get(..at).unwrap_or_default().iter().enumerate().rev() {
        match *kind {
            Kind::Move { time, run: true } => run = Some((i, run.map_or(0.0, |r| r.1) + time)),
            Kind::Move { time, run: false } => {
                if let Some((start, t)) = run.take() {
                    spent += t;
                    if spent >= lead {
                        return (start, passed_layer_fan);
                    }
                }
                spent += time;
                if spent >= lead {
                    return (i, passed_layer_fan);
                }
            }
            Kind::Stop | Kind::Raise(_) => {
                if let Some((start, t)) = run.take()
                    && spent + t >= lead
                {
                    return (start, passed_layer_fan);
                }
                return (i + 1, passed_layer_fan);
            }
            Kind::LayerFan => passed_layer_fan = true,
            Kind::Other => {}
        }
    }
    if let Some((start, t)) = run
        && spent + t >= lead
    {
        return (start, passed_layer_fan);
    }
    // The layer start: before the layer's own fan line, which then takes the raise's value.
    match kinds.iter().position(|k| *k == Kind::LayerFan) {
        Some(f) if f < at => (f, true),
        _ => (0, false),
    }
}

/// Moves each marked raise of a layer's G-code earlier by its lead, and removes the marks and tool change walls.
/// A chunk without marks comes back unchanged.
pub(crate) fn apply(chunk: &[u8], flavor: GcodeFlavor) -> Vec<u8> {
    let has_raise = chunk.windows(RAISE_MARK.len()).any(|w| w == RAISE_MARK);
    let has_wall = chunk.windows(WALL.len()).any(|w| w == WALL);
    if !has_raise && !has_wall {
        return chunk.to_vec();
    }
    let body = chunk.strip_suffix(b"\n").unwrap_or(chunk);
    let raw: Vec<&[u8]> = body.split(|&c| c == b'\n').collect();
    let mut kinds = classify(&raw, flavor);
    let mut lines: Vec<Vec<u8>> = raw.iter().map(|l| l.to_vec()).collect();
    let mut i = 0;
    while i < lines.len() {
        let Some(&Kind::Raise(lead)) = kinds.get(i) else {
            i += 1;
            continue;
        };
        if let Some(line) = lines.get_mut(i)
            && let Some(at) = line.windows(RAISE_MARK.len()).position(|w| w == RAISE_MARK)
        {
            line.truncate(at);
        }
        if let Some(k) = kinds.get_mut(i) {
            *k = Kind::Stop;
        }
        let (to, ahead_of_layer_fan) = landing(&kinds, i, lead);
        if ahead_of_layer_fan
            && let Some(f) = kinds.iter().take(i).position(|k| *k == Kind::LayerFan)
            && let Some(mut rewritten) = lines.get(i).cloned()
        {
            // The layer's own fan line runs at the raised value: the raise's command, the mark kept for finalize.
            rewritten.extend_from_slice(crate::firmware::FAN_MARK);
            if let Some(l) = lines.get_mut(f) {
                *l = rewritten;
            }
        }
        if to < i {
            let l = lines.remove(i);
            lines.insert(to, l);
            let k = kinds.remove(i);
            kinds.insert(to, k);
        }
        i += 1;
    }
    let mut out = Vec::with_capacity(chunk.len());
    for line in lines.iter().filter(|l| l.as_slice() != WALL_LINE) {
        out.extend_from_slice(line);
        out.push(b'\n');
    }
    if !chunk.ends_with(b"\n") {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str) -> String {
        String::from_utf8(apply(text.as_bytes(), GcodeFlavor::Marlin2)).unwrap()
    }

    /// The fan value in force at each move of `g`.
    fn fans(g: &str) -> Vec<(String, f64)> {
        let mut fan = 0.0;
        let mut out = Vec::new();
        for line in g.lines() {
            let code = line.split(';').next().unwrap_or("").trim();
            if part_fan(code, GcodeFlavor::Marlin2) {
                fan = word(code, b'S').unwrap_or(0.0);
            } else if code.starts_with('G')
                && code.split_ascii_whitespace().count() > 1
                && !code.starts_with("G1 F")
            {
                out.push((code.to_owned(), fan));
            }
        }
        out
    }

    /// The first move that runs at `value`.
    fn first_at(g: &str, value: f64) -> String {
        fans(g)
            .into_iter()
            .find(|(_, f)| (*f - value).abs() < 1e-9)
            .map(|(m, _)| m)
            .unwrap_or_default()
    }

    fn raise(ms: u32) -> String {
        format!("M106 S255 ;@R{ms}")
    }

    /// The cube's bridge layer as the spec's sweep table lays it out, on times of our own (at 100 mm/s unless noted):
    /// two wipes (the first from an unknown place counts nothing, the second 0.001 s), a retraction (0.002 s), the
    /// spiral lift (0.011 s), a travel (0.012 s) and the priming (0.027 s) of the layer change, an inner wall run
    /// (0.291 s), a travel (0.01 s), the outer wall run (0.442 s), then the bridge and its raise. Counted back from
    /// the raise the units start at 0.442, 0.452, 0.743, 0.7697, 0.7817, 0.7927, 0.7947 and 0.7957 s.
    fn bridge_layer(lead_ms: u32) -> String {
        [
            "M106 S196 ;@N",
            ";LAYER_CHANGE",
            "G1 X100 Y100 E-.5 F6000",
            "G1 X100.1 Y100 E-.1",
            "G1 E-.06 F1800",
            "G3 Z.6 I.17507 J0 P1 F6000",
            "G1 X101.3 Y100",
            "G1 E.8 F1800",
            ";TYPE:Inner wall",
            "G1 F6000",
            "G1 X111.3 Y100 E.5",
            "G1 X111.3 Y110 E.5",
            "G1 X102.2 Y110 E.45",
            "G1 X102.2 Y111",
            ";TYPE:Outer wall",
            "G1 X112.2 Y111 E.5",
            "G1 X112.2 Y121 E.5",
            "G1 X102.2 Y121 E.5",
            "G1 X102.2 Y106.8 E.7",
            ";TYPE:Bridge",
            &raise(lead_ms),
            "G1 X120 Y106.8 E1",
            "",
        ]
        .join("\n")
    }

    #[test]
    fn the_bridge_raise_lands_before_the_first_whole_unit_that_reaches_the_lead() {
        // Spec section 4.2's sweep: a short lead lands before the whole outer wall run, never inside it, and each
        // longer one before the next unit back. (The reference's thresholds sit 0.006 to 0.011 s above ours.)
        for (ms, first) in [
            (100, "G1 X112.2 Y111 E.5"),
            (300, "G1 X112.2 Y111 E.5"),
            (442, "G1 X112.2 Y111 E.5"),
            (445, "G1 X102.2 Y111"),
            (452, "G1 X102.2 Y111"),
            (453, "G1 X111.3 Y100 E.5"),
            (743, "G1 X111.3 Y100 E.5"),
            (744, "G1 E.8 F1800"),
            (769, "G1 E.8 F1800"),
            (770, "G1 X101.3 Y100"),
            (781, "G1 X101.3 Y100"),
            (782, "G3 Z.6 I.17507 J0 P1 F6000"),
            (792, "G3 Z.6 I.17507 J0 P1 F6000"),
            (793, "G1 E-.06 F1800"),
            (795, "G1 X100.1 Y100 E-.1"),
        ] {
            let g = run(&bridge_layer(ms));
            assert_eq!(first_at(&g, 255.0), first, "lead {ms} ms:\n{g}");
            assert!(
                g.starts_with("M106 S196 ;@N\n"),
                "the layer's own fan line stays: {g}"
            );
            assert!(!g.contains(";@R"));
        }
    }

    #[test]
    fn a_lead_past_the_layer_start_raises_the_layers_own_fan_line() {
        // From 0.796 s the walk reaches the layer start. The raise goes before the layer's own fan line, which takes
        // its value, so the whole layer change runs raised and the fan never dips.
        for ms in [796, 800, 2000, 5000] {
            let g = run(&bridge_layer(ms));
            assert!(
                g.starts_with("M106 S255\nM106 S255 ;@N\n;LAYER_CHANGE\n"),
                "lead {ms} ms:\n{g}"
            );
            assert!(fans(&g).iter().all(|(_, f)| (*f - 255.0).abs() < 1e-9));
            assert_eq!(g.matches("M106").count(), 2, "no fan line added or removed");
        }
    }

    #[test]
    fn the_raise_crosses_a_timelapse_block_counting_its_moves_and_not_its_dwell() {
        // Custom G-code is no wall: each of its moves is a unit and its dwell counts nothing. 1.5 s back from the raise
        // the walk is inside the block: priming 0.027 s, the travel back 0.346 s, the return from the park 0.964 s
        // (1.337 s so far), then the move to the park position (0.964 s). Counting the 0.3 s dwell would stop it
        // after the dwell instead.
        let g = [
            "M106 S180 ;@N",
            ";LAYER_CHANGE",
            "G1 X100 Y100 F18000",
            ";TYPE:Outer wall",
            "G1 X120 Y100 E1 F6000",
            "G1 E-.8 F1800",
            "G1 X0 Y128 F18000 ; move to safe pos",
            "G1 X-48.2 F3000",
            "M400 P300",
            "G1 X0 F3000",
            "G1 X100 Y100 F18000",
            "G1 E.8 F1800",
            ";TYPE:Bridge",
            &raise(1500),
            "G1 X120 Y110 E1 F3000",
            "",
        ]
        .join("\n");
        assert_eq!(first_at(&run(&g), 255.0), "G1 X-48.2 F3000");
        assert_eq!(
            first_at(&run(&g.replace(";@R1500", ";@R500")), 255.0),
            "G1 X0 F3000"
        );
    }

    #[test]
    fn a_raise_stops_right_after_the_fan_command_before_it() {
        // A drop then a raise within the lead: the drop stays and the raise lands right after it. Later raises walk
        // back to the ones already placed. `M106 P1` (custom G-code's part fan) stops the walk; `P2` does not.
        let g = [
            "M106 S180 ;@N",
            ";LAYER_CHANGE",
            "G1 X100 Y100 F6000",
            ";TYPE:Overhang wall",
            &raise(2000),
            "G1 X120 Y100 E1",
            ";TYPE:Inner wall",
            "M106 S180",
            "G1 X120 Y110 E1",
            "G1 X100 Y110",
            ";TYPE:Overhang wall",
            &raise(2000),
            "G1 X100 Y130 E1",
            "M106 P1 S0",
            "M106 P2 S90",
            "G1 X90 Y130",
            &raise(2000),
            "G1 X90 Y100 E1",
            "",
        ]
        .join("\n");
        let out = run(&g);
        let f = fans(&out);
        // the first raise reaches the layer start, the second lands after the drop, the third after `M106 P1`
        assert!(out.starts_with("M106 S255\nM106 S255 ;@N\n"), "{out}");
        assert_eq!(f[1], ("G1 X120 Y100 E1".to_owned(), 255.0));
        assert_eq!(f[2], ("G1 X120 Y110 E1".to_owned(), 255.0));
        assert!(out.contains("M106 S180\nM106 S255\nG1 X120 Y110 E1"), "{out}");
        assert!(
            out.contains("M106 P1 S0\nM106 S255\nM106 P2 S90\nG1 X90 Y130")
                || out.contains("M106 P1 S0\nM106 P2 S90\nM106 S255\nG1 X90 Y130"),
            "{out}"
        );
        assert_eq!(out.matches("M106").count(), g.matches("M106").count());
    }

    #[test]
    fn a_tool_change_is_a_wall_even_without_a_fan_restore_after_it() {
        // Lead ruling 4: the raise never crosses the change, restore or not, and the wall mark goes.
        let g = [
            "M106 S180 ;@N",
            ";LAYER_CHANGE",
            "G1 X100 Y100 F6000",
            "G1 X120 Y100 E1",
            "T1",
            ";@W",
            "G1 X130 Y100",
            ";TYPE:Overhang wall",
            &raise(5000),
            "G1 X130 Y120 E1",
            "",
        ]
        .join("\n");
        let out = run(&g);
        assert_eq!(first_at(&out, 255.0), "G1 X130 Y100");
        assert!(out.contains("T1\nM106 S255\nG1 X130 Y100"), "{out}");
        assert!(!out.contains(";@W"));
    }

    #[test]
    fn a_layer_without_marks_is_unchanged() {
        let g = "M106 S100 ;@N\n;LAYER_CHANGE\nG1 X1 Y1 F600\nG1 X2 E.1\nM106 S255\nG1 X3 E.1\n";
        assert_eq!(run(g), g);
    }

    #[test]
    fn arcs_count_their_arc_length() {
        let mut s = State {
            pos: [Some(10.0), Some(0.0), Some(1.0)],
            feed: Some(60.0),
            relative_xyz: false,
            relative_e: true,
            e: 0.0,
        };
        // a half circle of radius 10 from (10, 0) round (0, 0) to (-10, 0): 31.4 mm at 1 mm/s
        let (t, run) = move_time("G3 X-10 Y0 I-10 J0 E1", &mut s).unwrap();
        assert!((t - std::f64::consts::PI * 10.0).abs() < 1e-6, "{t}");
        assert!(run);
        // a full turn of radius 1 that lifts 0.4 mm (the spiral lift)
        let (t, run) = move_time("G2 Z1.4 I1 J0 P1", &mut s).unwrap();
        assert!((t - std::f64::consts::TAU.m_hypot(0.4)).abs() < 1e-6, "{t}");
        assert!(!run);
    }

    #[test]
    fn extruder_only_moves_count_their_filament_length() {
        let mut s = State {
            pos: [Some(0.0); 3],
            feed: None,
            relative_xyz: false,
            relative_e: true,
            e: 0.0,
        };
        let (t, run) = move_time("G1 E-.8 F1800", &mut s).unwrap();
        assert!((t - 0.8 / 30.0).abs() < 1e-9 && !run);
        assert!(move_time("G1 F3000", &mut s).is_none());
        assert_eq!(s.feed, Some(3000.0));
    }
}
