// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Preview extras: for every preview segment, the fan speed, nozzle temperature, G-code line, and
//! whether a retraction, a lift or a seam comes with it. They are read back from the G-code that was
//! written (so they always describe the file) and matched to the toolpaths by position, since
//! the toolpaths are what the preview draws.
//!
//! The extras are appended to the SXPV buffer behind the `extras` flag; see `preview.rs`.

use crate::config::PrintConfig;
use crate::geom::Point;
use crate::output::{Feature, LayerPaths, SliceOutput};

/// Bits in [`SegExtra::flags`].
pub const FLAG_RETRACT: u8 = 1;
pub const FLAG_LIFT: u8 = 2;
pub const FLAG_SEAM: u8 = 4;
pub const FLAG_PATH_START: u8 = 8;

/// What goes with one preview segment.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SegExtra {
    /// Part cooling fan, 0 to 255.
    pub fan: u8,
    pub flags: u8,
    pub temp_c: u16,
    /// G-code line: an offset from the layer's `;LAYER_CHANGE` line until [`finish`] makes it absolute.
    pub line: u32,
}

/// Extras of one layer: one per segment, and a flag byte per travel.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LayerExtras {
    pub segs: Vec<SegExtra>,
    pub travels: Vec<u8>,
    /// False when the G-code of the layer could not be matched to its paths.
    pub matched: bool,
}

struct Move {
    line: u32,
    end: (f64, f64),
    /// A retraction and a lift came since the previous extruding move.
    retract: bool,
    lift: bool,
    /// Fan speed when the move runs.
    fan: u8,
}

fn word<'a>(words: &[&'a str], letter: char) -> Option<&'a str> {
    words.iter().find_map(|w| w.strip_prefix(letter))
}

/// The extruding moves of a layer in order, each with what happened since the one before.
fn moves(layer: &str, z: f64) -> Vec<Move> {
    let mut out: Vec<Move> = Vec::new();
    let (mut fan, mut e_last, mut relative) = (0u8, 0.0f64, true);
    let (mut retract, mut lift) = (false, false);
    for (line_no, raw) in layer.lines().enumerate() {
        let text = raw.split(';').next().unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let words: Vec<&str> = text.split_whitespace().collect();
        let Some(&cmd) = words.first() else { continue };
        let args = words.get(1..).unwrap_or(&[]);
        let line = u32::try_from(line_no).unwrap_or(u32::MAX);
        match cmd {
            "M106" => {
                fan = word(args, 'S')
                    .and_then(|v| v.parse::<f64>().ok())
                    .map_or(255, |v| {
                        #[allow(
                            clippy::cast_possible_truncation,
                            clippy::cast_sign_loss,
                            reason = "a fan value is 0 to 255"
                        )]
                        {
                            v.clamp(0.0, 255.0).round() as u8
                        }
                    });
            }
            "M107" => fan = 0,
            "M82" => relative = false,
            "M83" => relative = true,
            "G92" => {
                if let Some(e) = word(args, 'E').and_then(|v| v.parse().ok()) {
                    e_last = e;
                }
            }
            "G0" | "G1" | "G2" | "G3" => {
                let e = word(args, 'E').and_then(|v| v.parse::<f64>().ok());
                let x = word(args, 'X').and_then(|v| v.parse::<f64>().ok());
                let y = word(args, 'Y').and_then(|v| v.parse::<f64>().ok());
                let de = e.map(|v| if relative { v } else { v - e_last });
                if let Some(v) = e {
                    e_last = if relative { 0.0 } else { v };
                }
                if de.is_some_and(|d| d > 1e-9)
                    && let (Some(x), Some(y)) = (x, y)
                {
                    out.push(Move {
                        line,
                        end: (x, y),
                        retract,
                        lift,
                        fan,
                    });
                    retract = false;
                    lift = false;
                } else {
                    if de.is_some_and(|d| d < -1e-9) {
                        retract = true;
                    }
                    if let Some(zz) = word(args, 'Z').and_then(|v| v.parse::<f64>().ok())
                        && zz > z + 1e-6
                    {
                        lift = true;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn near(p: Point, end: (f64, f64)) -> bool {
    let (x, y) = (
        f64::from(p.x) / crate::geom::SCALE,
        f64::from(p.y) / crate::geom::SCALE,
    );
    (x - end.0).abs() < 0.0025 && (y - end.1).abs() < 0.0025
}

/// Extras for the layers of `out`, read from the G-code text `gcode` of those layers (from the first
/// `;LAYER_CHANGE` on). Layers below `first_emitted` have no G-code (a resume) and get none.
pub fn parse(out: &SliceOutput, base: &PrintConfig, first_emitted: u32, gcode: &str) -> Vec<LayerExtras> {
    let mut chunks = gcode.split(";LAYER_CHANGE");
    chunks.next();
    let mut texts = chunks;
    // Each layer's text is found in order, then the layers are read in parallel.
    let pairs: Vec<(&LayerPaths, Option<&str>)> = out
        .layers
        .iter()
        .map(|l| {
            (
                l,
                if l.index < first_emitted {
                    None
                } else {
                    texts.next()
                },
            )
        })
        .collect();
    crate::par::map(&pairs, |&(l, text)| match text {
        Some(text) => layer_extras(l, out, base, text),
        None => blank(l),
    })
}

fn blank(l: &LayerPaths) -> LayerExtras {
    let segs: usize = l
        .paths
        .iter()
        .map(|p| (p.end - p.start).saturating_sub(1) as usize)
        .sum();
    LayerExtras {
        segs: vec![SegExtra::default(); segs],
        travels: vec![0; l.paths.len().saturating_sub(1)],
        matched: false,
    }
}

fn layer_extras(l: &LayerPaths, out: &SliceOutput, base: &PrintConfig, text: &str) -> LayerExtras {
    let c = out.config_at(base, l.cfg);
    let found = moves(text, f64::from(l.z));
    let mut res = LayerExtras::default();
    let mut at = 0usize; // next move to place
    let mut matched_paths = 0usize;
    for (index, path) in l.paths.iter().enumerate() {
        let pts = l.path_points(path);
        let slot = path.tool.max(1);
        let list = if l.index == 0 && !c.nozzle_temperature_initial_layer.is_empty() {
            &c.nozzle_temperature_initial_layer
        } else {
            &c.nozzle_temperature
        };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "temperatures are small"
        )]
        let temp = PrintConfig::per_slot(list, slot, 220.0)
            .round()
            .clamp(0.0, 65535.0) as u16;
        let segs = pts.len().saturating_sub(1);
        // Walk the moves along the path: each one ends on a later point than the one before.
        let mut lines: Vec<Option<u32>> = vec![None; segs];
        let (mut first, mut j) = (None::<usize>, 0usize);
        let mut scan = at;
        while j < segs {
            // The first move of a path may come a few moves later than expected (arcs are not followed).
            let reach = if first.is_none() { 6 } else { 1 };
            let hit = (scan..scan + reach).find_map(|s| {
                let m = found.get(s)?;
                (j + 1..pts.len())
                    .find(|&k| pts.get(k).is_some_and(|p| near(*p, m.end)))
                    .map(|k| (s, k))
            });
            let Some((s, k)) = hit else { break };
            let Some(m) = found.get(s) else { break };
            first.get_or_insert(s);
            for slot in lines.get_mut(j..k).unwrap_or(&mut []) {
                *slot = Some(m.line);
            }
            j = k;
            scan = s + 1;
        }
        let closed = crate::gcode::is_loop(pts);
        let wall = matches!(
            path.feature,
            Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall
        );
        let head = first.and_then(|k| found.get(k));
        let mut first_flags = FLAG_PATH_START;
        if head.is_some_and(|m| m.retract) {
            first_flags |= FLAG_RETRACT;
        }
        if head.is_some_and(|m| m.lift) {
            first_flags |= FLAG_LIFT;
        }
        if closed && wall {
            first_flags |= FLAG_SEAM;
        }
        if first.is_some() {
            matched_paths += 1;
            at = scan;
        }
        if index > 0 {
            res.travels.push(first_flags & (FLAG_RETRACT | FLAG_LIFT));
        }
        let fan = head.map_or(0, |m| m.fan);
        let mut last = 0;
        for (i, line) in lines.into_iter().enumerate() {
            last = line.unwrap_or(last);
            res.segs.push(SegExtra {
                fan,
                flags: if i == 0 { first_flags } else { 0 },
                temp_c: temp,
                line: if first.is_some() { last } else { 0 },
            });
        }
    }
    res.matched = matched_paths * 100 >= l.paths.len() * 95;
    if std::env::var("SX_EXTRAS_DEBUG").is_ok() && !res.matched {
        eprintln!(
            "layer {}: matched {matched_paths} of {} paths",
            l.index,
            l.paths.len()
        );
    }
    res
}

/// The comments that start a layer: `;LAYER_CHANGE`, or `; CHANGE_LAYER` in a finished Bambu Lab file
/// (orca's processor tag, written by `firmware::finalize`).
pub const LAYER_MARKS: [&str; 2] = [";LAYER_CHANGE", "; CHANGE_LAYER"];

/// True for a line that starts a layer, in either form.
pub fn is_layer_mark(line: impl AsRef<[u8]>) -> bool {
    let line = line.as_ref();
    LAYER_MARKS.iter().any(|m| line.starts_with(m.as_bytes()))
}

/// The layer marker `gcode` uses: `; CHANGE_LAYER` in a finished Bambu Lab file, `;LAYER_CHANGE` otherwise.
pub fn layer_mark(gcode: &str) -> &'static str {
    if gcode.starts_with(LAYER_MARKS[1]) || gcode.contains("\n; CHANGE_LAYER\n") {
        LAYER_MARKS[1]
    } else {
        LAYER_MARKS[0]
    }
}

/// The 1-based line of every layer marker in `gcode` ([`layer_mark`]), in order.
pub fn layer_lines(gcode: &str) -> Vec<u32> {
    let mark = layer_mark(gcode);
    let bytes = gcode.as_bytes();
    let mut marker_lines: Vec<u32> = Vec::new();
    if gcode.starts_with(mark) {
        marker_lines.push(1);
    }
    // Find the markers at line starts, counting the newlines between them in bulk.
    let (mut line, mut counted) = (1usize, 0usize);
    for (at, _) in gcode.match_indices(&format!("\n{mark}")) {
        #[allow(
            clippy::naive_bytecount,
            reason = "the compiler vectorizes this count; no crate for it"
        )]
        let between = bytes
            .get(counted..at)
            .map_or(0, |b| b.iter().filter(|&&c| c == b'\n').count());
        line += between + 1;
        counted = at + 1;
        marker_lines.push(u32::try_from(line).unwrap_or(u32::MAX));
    }
    marker_lines
}

/// The 1-based lines of the progress lines finalize writes after moves (`M73 P<n> R<n>`, as Orca's G-code
/// processor writes them), in order. Inside a layer they are lines its own G-code did not have, so a line
/// counted from the layer's marker skips them ([`file_line`]).
pub fn progress_lines(gcode: &str) -> Vec<u32> {
    let is_progress = |l: &str| {
        l.strip_prefix("M73 P")
            .and_then(|r| r.split_once(" R"))
            .is_some_and(|(p, r)| {
                !p.is_empty()
                    && !r.is_empty()
                    && p.bytes().all(|c| c.is_ascii_digit())
                    && r.bytes().all(|c| c.is_ascii_digit())
            })
    };
    gcode
        .lines()
        .enumerate()
        .filter(|(_, l)| is_progress(l))
        .filter_map(|(i, _)| u32::try_from(i + 1).ok())
        .collect()
}

/// The finished file's line `rel` lines after the layer marker on line `base`, not counting the progress
/// lines ([`progress_lines`]) in between.
pub fn file_line(base: u32, rel: u32, progress: &[u32]) -> u32 {
    let from = progress.partition_point(|&p| p <= base);
    let rest = progress.get(from..).unwrap_or(&[]);
    let mut line = base.saturating_add(rel);
    loop {
        let skipped = u32::try_from(rest.partition_point(|&p| p <= line)).unwrap_or(u32::MAX);
        let next = base.saturating_add(rel).saturating_add(skipped);
        if next == line {
            return line;
        }
        line = next;
    }
}

/// Line offsets that are not known: the layer's G-code did not match its paths.
pub const LINE_UNKNOWN: u32 = u32::MAX;

/// The extras of some layers as two tables, the lines left as offsets from each layer's `;LAYER_CHANGE`
/// ([`LINE_UNKNOWN`] when the layer did not match). A shard sliced on its own cannot know where its layers
/// land in the finished file; the stitch makes the lines absolute (`preview::stitch_lines`).
pub fn relative(layers: &[(u32, LayerExtras)]) -> (Vec<SegExtra>, Vec<u8>) {
    let mut segs = Vec::new();
    let mut travels = Vec::new();
    for (_, extras) in layers {
        segs.extend(extras.segs.iter().map(|s| SegExtra {
            line: if extras.matched { s.line } else { LINE_UNKNOWN },
            ..*s
        }));
        travels.extend_from_slice(&extras.travels);
    }
    (segs, travels)
}

/// The extras of the whole file as two tables, the lines made absolute. `gcode` is the final text and
/// `first_emitted` the index of the first layer that has G-code (0, or the resume layer).
pub fn finish(layers: &[(u32, LayerExtras)], first_emitted: u32, gcode: &str) -> (Vec<SegExtra>, Vec<u8>) {
    let marker_lines = layer_lines(gcode);
    let progress = progress_lines(gcode);
    let mut segs = Vec::new();
    let mut travels = Vec::new();
    for (index, extras) in layers {
        let base = index
            .checked_sub(first_emitted)
            .and_then(|k| marker_lines.get(k as usize))
            .copied();
        for s in &extras.segs {
            let mut s = *s;
            s.line = match base {
                Some(b) if extras.matched => file_line(b, s.line, &progress),
                _ => 0,
            };
            segs.push(s);
        }
        travels.extend_from_slice(&extras.travels);
    }
    (segs, travels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_carry_retract_lift_fan_and_their_line() {
        let layer = "\n;Z:0.2\nM106 S128\nG1 X1 Y1 E.5\nG1 X2 Y1 E.5\nG1 E-.8 F1800\nG1 Z.6\nG0 X9 Y9\nG1 Z.2\nG1 E.8\nM106 S255\nG1 X10 Y9 E.5\n";
        let m = moves(layer, 0.2);
        assert_eq!(m.len(), 3);
        assert!(!m[0].retract && !m[1].retract && m[2].retract && m[2].lift);
        assert_eq!((m[0].fan, m[2].fan), (128, 255));
        // Line offsets count from the marker line, which is line 0.
        assert_eq!(m[0].line, 3);
    }

    #[test]
    fn lines_from_a_marker_skip_the_progress_lines() {
        let g = ";LAYER_CHANGE\nG1 X1 E1\nM73 P1 R5\nG1 X2 E1\nG1 X3 E1\nM73 P2 R4\nG1 X4 E1\n";
        let p = progress_lines(g);
        assert_eq!(p, vec![3, 6]);
        // The layer's own lines 1 to 4 after the marker on line 1.
        let lines: Vec<u32> = (1..=4).map(|r| file_line(1, r, &p)).collect();
        assert_eq!(lines, vec![2, 4, 5, 7]);
        assert_eq!(file_line(1, 2, &[]), 3);
    }

    #[test]
    fn absolute_extrusion_counts_decreases_as_retractions() {
        let layer = "\nM82\nG1 X1 Y1 E1\nG1 X2 Y1 E2\nG1 E1.2\nG0 X5 Y5\nG1 E2\nG1 X6 Y5 E2.5\n";
        let m = moves(layer, 0.2);
        assert_eq!(m.len(), 3);
        assert!(m[2].retract);
    }
}
