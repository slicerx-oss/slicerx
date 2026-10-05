// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Ultimaker's G-code for the S series, Griffin (S3, S5, S7) and Cheetah (S6, S8), written the way
//! `CuraEngine` 5.13 writes it (`GCodeExport::getFileHeader`, `initializeExtruderTrains`,
//! `switchExtruder`, `writePrimeTrain`).
//!
//! The printer reads a header before it starts and checks the material, print core and build plate
//! temperature against what it holds. The firmware does the rest itself: `T` lifts the inactive print
//! core with the lift switch, lowers the active one and applies its Z offset, and `G280` primes. The
//! slicer retracts by the switch length, brings the head to the switching position, hops, waits for the
//! new core's temperature and parks the old one at standby.
//!
//! The firmware applies no X/Y offset of its own, so the second core's moves are written shifted by its
//! nozzle offset (`extruder_offset`), as Cura and Orca write them.

use crate::config::{GcodeFlavor, PrintConfig};
use crate::geom::Point;
use std::cell::Cell;
use std::fmt::Write as _;

/// Header values only the whole file knows; finalize writes them in.
pub(crate) const MARK: &str = "_SX_GRIFFIN_";
/// The end of a line that belongs to one extruder (`;@U` and the slot): finalize keeps it, without the
/// mark, when the print uses that extruder, and drops it when it does not.
pub(crate) const USED: &str = ";@U";

thread_local! {
    /// The nozzle offset of the tool whose moves the current layer chunk is writing, in the engine's units.
    static OFFSET: Cell<(i32, i32)> = const { Cell::new((0, 0)) };
}

/// `p` as the G-code writes it: less the active tool's nozzle offset.
pub(crate) fn shifted(p: Point) -> Point {
    let (dx, dy) = OFFSET.with(Cell::get);
    if dx == 0 && dy == 0 {
        return p;
    }
    Point {
        x: p.x - dx,
        y: p.y - dy,
    }
}

/// Sets the offset the writer subtracts for tool `slot` (1-based); slot 0 or a printer without offsets
/// clears it.
pub(crate) fn set_tool(c: &PrintConfig, slot: u8) {
    let off = if slot == 0 {
        [0.0, 0.0]
    } else {
        point(c, "extruder_offset", slot).unwrap_or([0.0, 0.0])
    };
    let p = Point::from_mm(off[0], off[1]);
    OFFSET.with(|o| o.set((p.x, p.y)));
}

/// One point of a per-extruder list of points (`"22x0"` or `[22, 0]`).
pub(crate) fn point(c: &PrintConfig, key: &str, slot: u8) -> Option<[f64; 2]> {
    let list = c.raw.get(key)?.as_array()?;
    let v = list.get(usize::from(slot.max(1) - 1)).or_else(|| list.first())?;
    match v {
        serde_json::Value::String(s) => {
            let (x, y) = s.split_once(['x', 'X'])?;
            Some([x.trim().parse().ok()?, y.trim().parse().ok()?])
        }
        serde_json::Value::Array(a) => Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?]),
        _ => None,
    }
}

/// One text of a per-extruder list of texts.
fn text(c: &PrintConfig, key: &str, slot: u8) -> Option<String> {
    let v = c.raw.get(key)?;
    let s = match v {
        serde_json::Value::Array(a) => a
            .get(usize::from(slot.max(1) - 1))
            .or_else(|| a.first())?
            .as_str()?,
        serde_json::Value::String(s) => s.as_str(),
        _ => return None,
    };
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

/// The GUID Ultimaker's own generic material profiles carry for a filament type (from Ultimaker's
/// `fdm_materials`, CC0), which the printer matches against the spool it reads. None for types it has no
/// generic profile for.
pub(crate) fn material_guid(kind: &str) -> Option<&'static str> {
    Some(match kind.trim().to_ascii_uppercase().as_str() {
        "PLA" => "506c9f0d-e3aa-4bd4-b2d2-23e2425b1aa9",
        "ABS" => "60636bb4-518f-42e7-8237-fe77b194ebe0",
        "ASA" => "50361850-7d30-404d-943e-a3166dc11be2",
        "PETG" => "1cbfaeb3-1906-4b26-b2e7-6f777a8c197a",
        "CPE" => "12f41353-1a33-415e-8b4f-a775a6c70cc6",
        "PA" | "NYLON" => "28fb4162-db74-49e1-9008-d05f1e8bef5c",
        "PC" => "98c05714-bf4e-4455-ba27-57d74fe331e4",
        "PP" => "aa22e9c7-421f-4745-afc2-81851694394a",
        "PVA" => "86a89ceb-4159-47f6-ab97-e9953803d70f",
        "TPU" => "1d52b2be-a3a2-41de-a8b1-3bcdb5618695",
        "HIPS" => "b6f76172-bb0f-4326-bdbc-ee8f0e84b283",
        "BVOH" => "9d9527bf-7087-4f67-9fac-c79bb5816795",
        _ => return None,
    })
}

/// A temperature the way `CuraEngine`'s header writes a double: `205`, `102.5`.
fn num(v: f64) -> String {
    crate::firmware::fmt_g((v * 10.0).round() / 10.0)
}

/// The build date the header carries (`yyyy-mm-dd`), from the build script.
const BUILD_DATE: &str = env!("SX_BUILD_DATE");

/// What the header and the start need per extruder.
pub(crate) struct Train {
    /// 1-based slot.
    pub slot: u8,
    /// The temperature it starts at: the first layer's for the extruder that prints first, standby for the others.
    pub initial: f64,
}

/// The header block, first in the file.
pub(crate) fn header(c: &PrintConfig, flavor: GcodeFlavor, trains: &[Train], bed: f64) -> String {
    let mut s = String::with_capacity(1024);
    s.push_str(";START_OF_HEADER\n;HEADER_VERSION:0.1\n");
    let _ = writeln!(
        s,
        ";FLAVOR:{}",
        if flavor == GcodeFlavor::Cheetah {
            "Cheetah"
        } else {
            "Griffin"
        }
    );
    s.push_str(";GENERATOR.NAME:SlicerX\n");
    let _ = writeln!(s, ";GENERATOR.VERSION:{}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(s, ";GENERATOR.BUILD_DATE:{BUILD_DATE}");
    let machine = c
        .raw
        .get("printer_model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let machine: String = machine
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let _ = writeln!(s, ";TARGET_MACHINE.NAME:{machine}");
    for t in trains {
        let n = t.slot - 1;
        let u = format!("{USED}{}", t.slot);
        let _ = writeln!(s, ";EXTRUDER_TRAIN.{n}.INITIAL_TEMPERATURE:{}{u}", num(t.initial));
        let _ = writeln!(
            s,
            ";EXTRUDER_TRAIN.{n}.MATERIAL.VOLUME_USED:{MARK}VOLUME_{}{u}",
            t.slot
        );
        if let Some(g) = text(c, "filament_type", t.slot)
            .as_deref()
            .and_then(material_guid)
        {
            let _ = writeln!(s, ";EXTRUDER_TRAIN.{n}.MATERIAL.GUID:{g}{u}");
        }
        let d = crate::tower::per_slot_raw(c, "nozzle_diameter", t.slot, 0.4);
        let _ = writeln!(
            s,
            ";EXTRUDER_TRAIN.{n}.NOZZLE.DIAMETER:{}{u}",
            crate::firmware::fmt_g(d)
        );
        if let Some(core) = text(c, "print_core", t.slot) {
            let core: String = core
                .chars()
                .map(|ch| if ch.is_control() { ' ' } else { ch })
                .collect();
            let _ = writeln!(s, ";EXTRUDER_TRAIN.{n}.NOZZLE.NAME:{core}{u}");
        }
    }
    let _ = writeln!(s, ";BUILD_PLATE.INITIAL_TEMPERATURE:{}", num(bed));
    // A build volume the printer controls (the S5's and S7's air manager): the coolest any filament wants.
    if crate::tower::flag_or(c, "support_chamber_temp_control", false) {
        let chamber = trains
            .iter()
            .map(|t| crate::tower::per_slot_raw(c, "chamber_temperature", t.slot, 0.0))
            .fold(f64::INFINITY, f64::min);
        if chamber.is_finite() && chamber > 0.0 {
            let _ = writeln!(s, ";BUILD_VOLUME.TEMPERATURE:{}", num(chamber));
        }
    }
    let _ = writeln!(s, ";PRINT.TIME:{MARK}TIME");
    s.push_str(";PRINT.GROUPS:1\n");
    for k in ["MIN.X", "MIN.Y", "MIN.Z", "MAX.X", "MAX.Y", "MAX.Z"] {
        let _ = writeln!(s, ";PRINT.SIZE.{k}:{MARK}{}", k.replace('.', ""));
    }
    let _ = writeln!(s, ";SLICE_UUID:{MARK}UUID");
    s.push_str(";END_OF_HEADER\n");
    s
}

/// The temperature a print core waits for at a switch before it prints: Cura's initial printing
/// temperature (`material_initial_print_temperature`), `toolchange_temperature_drop` under the printing
/// temperature, after which it goes on heating to the printing temperature.
pub(crate) fn initial_temp(c: &PrintConfig, slot: u8, print: f64) -> f64 {
    let drop = crate::tower::per_slot_raw(c, "toolchange_temperature_drop", slot, 0.0).max(0.0);
    (print - drop).max(0.0)
}

/// A tool's standby temperature: its filament's idle temperature, else 100 degrees under the printing
/// temperature, the rule of Cura's `UltiMaker` definition (`material_standby_temperature` in `ultimaker.def.json`).
pub(crate) fn standby(c: &PrintConfig, slot: u8, print: f64) -> f64 {
    let idle = crate::tower::per_slot_raw(c, "idle_temperature", slot, 0.0);
    if idle > 0.0 {
        idle
    } else {
        (print - 100.0).max(0.0)
    }
}

/// `M104`/`M109` the way `CuraEngine` writes them: the tool before the temperature, no tool for the active one.
pub(crate) fn temp_line(s: &mut String, temp: f64, wait: bool, tool: Option<u8>) {
    s.push_str(if wait { "M109" } else { "M104" });
    if let Some(t) = tool {
        let _ = write!(s, " T{t}");
    }
    let _ = writeln!(s, " S{}", num(temp));
}

/// `extruder_start_gcode` as rendered for the tool just selected (Cura's `machine_extruder_start_code`: the
/// S6's and S8's pressure advance).
fn tool_start(s: &mut String, text: &str) {
    if !text.trim().is_empty() {
        s.push_str(text);
        if !text.ends_with('\n') {
            s.push('\n');
        }
    }
}

/// The start: select the first extruder, heat bed and nozzles, let the firmware prime, and lift.
/// `start` is the machine's own start G-code (Cura writes it after the first `T`). The first layer's
/// retraction follows in the layer itself.
pub(crate) fn start(
    trains: &[Train],
    start: &str,
    tool_start_text: &str,
    bed: f64,
    absolute_e: bool,
) -> String {
    let mut s = String::with_capacity(256);
    let first = trains.first().map_or(1, |t| t.slot);
    let _ = writeln!(s, "T{}", first - 1);
    if !start.trim().is_empty() {
        s.push_str(start);
        if !start.ends_with('\n') {
            s.push('\n');
        }
    }
    s.push_str(if absolute_e {
        "M82 ;absolute extrusion mode\n"
    } else {
        "M83 ;relative extrusion mode\n"
    });
    s.push_str("G92 E0\n");
    tool_start(&mut s, tool_start_text);
    let _ = writeln!(s, "M190 S{}", num(bed));
    if let Some(t) = trains.first() {
        temp_line(&mut s, t.initial, false, None);
    }
    for t in trains.iter().skip(1) {
        temp_line(&mut s, t.initial, false, Some(t.slot - 1));
        // Only an extruder the print uses heats up; finalize drops the line otherwise.
        s.pop();
        let _ = writeln!(s, "{USED}{}", t.slot);
    }
    if let Some(t) = trains.first() {
        temp_line(&mut s, t.initial, true, None);
    }
    // `S1`: prime without the blob; firmware that read S1 as a material move only is corrected by the lift.
    s.push_str("G280 S1\nG0 Z20.001\n");
    s
}

/// Everything a print core switch needs from the writer.
pub(crate) struct Switch<'a> {
    /// `extruder_start_gcode` rendered for the new tool.
    pub tool_start: &'a str,
    /// Settings of the filament leaving and the one coming, with their retraction values.
    pub from: &'a PrintConfig,
    pub to: &'a PrintConfig,
    pub from_slot: u8,
    pub to_slot: u8,
    /// The layer's height and the hop, in thousandths of a mm.
    pub z: i64,
    pub hop: i64,
    /// How far the leaving filament is already retracted, mm (0 when not).
    pub retracted_mm: f64,
    /// True when the new core has printed before in this file (no prime then).
    pub primed: bool,
    pub travel_feed: i64,
    pub z_feed: i64,
    /// Printing temperatures of the two filaments on this layer.
    pub from_print: f64,
    pub to_print: f64,
}

fn fixed(v: f64, decimals: usize) -> String {
    let s = format!("{v:.decimals$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s
    }
}

#[allow(
    clippy::cast_precision_loss,
    reason = "heights in thousandths of a mm are small"
)]
/// The switch, with relative extrusion (the layer's absolute pass rewrites it). The new filament is left
/// retracted by its own retraction length and the head lifted by `hop`; the writer's next travel comes
/// down and unretracts. Returns the text and the retraction left, mm.
pub(crate) fn switch(w: &Switch<'_>) -> (String, f64) {
    let mut s = String::with_capacity(320);
    let feed = |mm_s: f64| (mm_s * 60.0).round();
    let length = |c: &PrintConfig| c.retraction_length.max(0.0);
    let switch_len = |c: &PrintConfig, slot: u8| {
        crate::tower::per_slot_raw(c, "retract_length_toolchange", slot, length(c)).max(length(c))
    };
    // Retract by the switch length: the usual retraction first, the rest at the switch speed.
    let total = switch_len(w.from, w.from_slot);
    let mut done = w.retracted_mm;
    if done <= 0.0 && length(w.from) > 0.0 {
        let _ = writeln!(
            s,
            "G1 F{} E-{}",
            feed(w.from.retraction_speed),
            fixed(length(w.from), 5)
        );
        done = length(w.from);
    }
    if total > done {
        let speed = crate::tower::per_slot_raw(
            w.from,
            "retract_speed_toolchange",
            w.from_slot,
            w.from.retraction_speed,
        );
        let _ = writeln!(s, "G1 F{} E-{}", feed(speed), fixed(total - done, 5));
    }
    // To the switching position, where the head works the lift switch, and up.
    if let Some([x, y]) = point(w.from, "toolchange_park_position", w.from_slot) {
        let _ = writeln!(s, "G0 F{} X{} Y{}", w.travel_feed, fixed(x, 3), fixed(y, 3));
    }
    let up = w.z + w.hop;
    let _ = writeln!(s, "G1 F{} Z{}", w.z_feed, fixed(up as f64 / 1000.0, 3));
    s.push_str("G92 E0\n");
    let _ = writeln!(s, "T{}", w.to_slot - 1);
    s.push_str("G92 E0\n");
    tool_start(&mut s, w.tool_start);
    temp_line(&mut s, initial_temp(w.to, w.to_slot, w.to_print), true, None);
    let mut idle = String::new();
    temp_line(
        &mut idle,
        standby(w.from, w.from_slot, w.from_print),
        false,
        Some(w.from_slot - 1),
    );
    // The preheat pass (preheat.rs) drops a cooldown inside the window before this tool's next use.
    s.push_str(idle.trim_end());
    s.push_str(" ;cooldown\n");
    let left = length(w.to);
    if w.primed {
        // Prime back what the switch took beyond the usual retraction.
        let back = switch_len(w.to, w.to_slot) - left;
        if back > 0.0 {
            let speed = crate::tower::per_slot_raw(w.to, "deretract_speed_extruder_change", w.to_slot, 0.0);
            let speed = if speed > 0.0 { speed } else { w.to.retraction_speed };
            let _ = writeln!(s, "G1 F{} E{}", feed(speed), fixed(back, 5));
        }
    } else {
        // The first time this core prints: the firmware primes it, then it retracts like any other travel.
        let _ = writeln!(s, "G280 S1\nG0 Z{}", fixed((up + 1) as f64 / 1000.0, 3));
        if left > 0.0 {
            let _ = writeln!(s, "G1 F{} E-{}", feed(w.to.retraction_speed), fixed(left, 5));
        }
        if let Some([x, y]) = point(w.to, "toolchange_park_position", w.to_slot) {
            let _ = writeln!(
                s,
                "G0 F{} X{} Y{} Z{}",
                w.travel_feed,
                fixed(x, 3),
                fixed(y, 3),
                fixed(up as f64 / 1000.0, 3)
            );
        }
    }
    temp_line(&mut s, w.to_print, false, None);
    (s, left)
}

/// The end: the bed off, the part fan off, the nozzles off (Cura's end for an empty end G-code).
pub(crate) fn end(end: &str, absolute_e: bool) -> String {
    let mut s = String::from("M140 S0\nM107\n");
    if !end.trim().is_empty() {
        s.push_str(end);
        if !end.ends_with('\n') {
            s.push('\n');
        }
    }
    s.push_str(if absolute_e {
        "M82 ;absolute extrusion mode\n"
    } else {
        "M83 ;relative extrusion mode\n"
    });
    s.push_str("M104 S0\n;End of Gcode\n");
    s
}

/// The values finalize writes into the header.
pub(crate) struct Totals {
    pub time_s: f64,
    /// Filament volume per slot, mm3.
    pub volume: Vec<f64>,
    /// The slots the paths print with.
    pub used: std::collections::BTreeSet<u8>,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub uuid: String,
}

/// A line of the file with the header's marks filled in, or `None` when the line belongs to an
/// extruder the print does not use.
pub(crate) fn fill(line: &[u8], t: &Totals) -> Option<Vec<u8>> {
    let mut text = String::from_utf8_lossy(line).into_owned();
    if let Some(at) = text.rfind(USED) {
        let slot: u8 = text
            .get(at + USED.len()..)
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        if !t.used.is_empty() && !t.used.contains(&slot) {
            return None;
        }
        text.truncate(at);
    }
    if text.contains(MARK) {
        let size = |v: f64| fixed(v, 3);
        let mut pairs: Vec<(String, String)> = vec![
            (format!("{MARK}TIME"), format!("{}", t.time_s.round().max(0.0))),
            (format!("{MARK}UUID"), t.uuid.clone()),
            (format!("{MARK}MINX"), size(t.min[0])),
            (format!("{MARK}MINY"), size(t.min[1])),
            (format!("{MARK}MINZ"), size(t.min[2])),
            (format!("{MARK}MAXX"), size(t.max[0])),
            (format!("{MARK}MAXY"), size(t.max[1])),
            (format!("{MARK}MAXZ"), size(t.max[2])),
        ];
        for (i, v) in t.volume.iter().enumerate() {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a volume in mm3"
            )]
            pairs.push((
                format!("{MARK}VOLUME_{}", i + 1),
                format!("{}", v.max(0.0) as u64),
            ));
        }
        for (k, v) in pairs {
            text = text.replace(&k, &v);
        }
        // A slot with no extrusion recorded used nothing.
        if let Some(at) = text.find(&format!("{MARK}VOLUME_")) {
            text.truncate(at);
            text.push('0');
        }
    }
    Some(text.into_bytes())
}

/// True when the file starts with a header this module wrote.
pub(crate) fn has_header(gcode: &[u8]) -> bool {
    gcode.starts_with(b";START_OF_HEADER")
        && gcode.windows(MARK.len()).take(4096).any(|w| w == MARK.as_bytes())
}

/// The extent of every move of the file, from the origin where the firmware starts, as `CuraEngine`
/// counts its bounding box (`total_bounding_box_`): travels, the prime lift and the switching position
/// included.
pub(crate) fn extent(gcode: &[u8]) -> ([f64; 3], [f64; 3]) {
    let mut pos = [0.0f64; 3];
    let (mut lo, mut hi) = ([0.0f64; 3], [0.0f64; 3]);
    for line in gcode.split(|&b| b == b'\n') {
        if !(line.starts_with(b"G0 ")
            || line.starts_with(b"G1 ")
            || line.starts_with(b"G2 ")
            || line.starts_with(b"G3 "))
        {
            continue;
        }
        let code = line.split(|&b| b == b';').next().unwrap_or(&[]);
        let mut moved = false;
        for word in code.split(|&b| b == b' ').skip(1) {
            let Some((&axis, rest)) = word.split_first() else {
                continue;
            };
            let slot = match axis {
                b'X' => pos.get_mut(0),
                b'Y' => pos.get_mut(1),
                b'Z' => pos.get_mut(2),
                _ => None,
            };
            if let (Some(slot), Some(v)) = (
                slot,
                std::str::from_utf8(rest).ok().and_then(|t| t.parse::<f64>().ok()),
            ) {
                *slot = v;
                moved = true;
            }
        }
        if moved {
            for ((l, h), p) in lo.iter_mut().zip(hi.iter_mut()).zip(pos) {
                *l = l.min(p);
                *h = h.max(p);
            }
        }
    }
    (lo, hi)
}

/// A UUID (version 4 layout) from the file's own hash, so the same print always gets the same one.
pub(crate) fn uuid(gcode: &[u8]) -> String {
    let h = crate::sha256::hex(gcode);
    let h = h.as_bytes();
    let part = |a: usize, b: usize| String::from_utf8_lossy(h.get(a..b).unwrap_or_default()).into_owned();
    let variant = h
        .get(16)
        .and_then(|c| ["8", "9", "a", "b"].get(usize::from(*c) % 4))
        .copied()
        .unwrap_or("8");
    format!(
        "{}-{}-4{}-{}{}-{}",
        part(0, 8),
        part(8, 12),
        part(13, 16),
        variant,
        part(17, 20),
        part(20, 32)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(v: &serde_json::Value) -> PrintConfig {
        PrintConfig::from_value(v).expect("config")
    }

    #[test]
    fn the_header_names_the_machine_cores_and_materials() {
        let c = cfg(&serde_json::json!({
            "printer_model": "Ultimaker S5", "print_core": ["AA 0.4", "BB 0.4"], "nozzle_diameter": [0.4, 0.4],
            "filament_type": ["PLA", "PVA"], "support_chamber_temp_control": true, "chamber_temperature": [28, 35],
        }));
        let h = header(
            &c,
            GcodeFlavor::Griffin,
            &[
                Train {
                    slot: 1,
                    initial: 205.0,
                },
                Train {
                    slot: 2,
                    initial: 102.5,
                },
            ],
            60.0,
        );
        assert!(h.starts_with(
            ";START_OF_HEADER\n;HEADER_VERSION:0.1\n;FLAVOR:Griffin\n;GENERATOR.NAME:SlicerX\n"
        ));
        assert!(h.contains(";TARGET_MACHINE.NAME:Ultimaker S5\n"));
        assert!(h.contains(";EXTRUDER_TRAIN.0.INITIAL_TEMPERATURE:205;@U1\n"));
        assert!(h.contains(";EXTRUDER_TRAIN.1.INITIAL_TEMPERATURE:102.5;@U2\n"));
        assert!(h.contains(";EXTRUDER_TRAIN.0.MATERIAL.GUID:506c9f0d-e3aa-4bd4-b2d2-23e2425b1aa9;@U1\n"));
        assert!(h.contains(";EXTRUDER_TRAIN.1.NOZZLE.NAME:BB 0.4;@U2\n"));
        assert!(
            h.contains(";BUILD_PLATE.INITIAL_TEMPERATURE:60\n;BUILD_VOLUME.TEMPERATURE:28\n;PRINT.TIME:")
        );
        assert!(h.ends_with(";END_OF_HEADER\n"));
        let version = env!("CARGO_PKG_VERSION");
        assert!(
            version.split('.').count() >= 3,
            "the firmware reads a two-part version as a number"
        );
        assert_eq!(BUILD_DATE.len(), 10);
    }

    #[test]
    fn finalize_fills_the_marks_and_drops_unused_extruders() {
        let t = Totals {
            time_s: 2961.6,
            volume: vec![2887.9, 0.0],
            used: [1u8].into_iter().collect(),
            min: [0.0, 0.0, 0.0],
            max: [330.0, 237.0, 20.001],
            uuid: "u".into(),
        };
        assert_eq!(
            fill(b";PRINT.TIME:_SX_GRIFFIN_TIME", &t).unwrap(),
            b";PRINT.TIME:2962"
        );
        assert_eq!(
            fill(
                b";EXTRUDER_TRAIN.0.MATERIAL.VOLUME_USED:_SX_GRIFFIN_VOLUME_1;@U1",
                &t
            )
            .unwrap(),
            b";EXTRUDER_TRAIN.0.MATERIAL.VOLUME_USED:2887"
        );
        assert!(fill(b";EXTRUDER_TRAIN.1.NOZZLE.NAME:BB 0.4;@U2", &t).is_none());
        assert!(fill(b"M104 T1 S100;@U2", &t).is_none());
        assert_eq!(
            fill(b";PRINT.SIZE.MAX.Z:_SX_GRIFFIN_MAXZ", &t).unwrap(),
            b";PRINT.SIZE.MAX.Z:20.001"
        );
    }

    #[test]
    fn a_switch_retracts_parks_hops_and_primes_like_cura() {
        let from = cfg(&serde_json::json!({
            "retraction_length": [6.5], "retraction_speed": [45], "retract_length_toolchange": [16, 16],
            "retract_speed_toolchange": [20, 20], "deretract_speed_extruder_change": [20, 20],
            "toolchange_park_position": ["330x237", "330x219"], "idle_temperature": [100, 100], "toolchange_temperature_drop": [10, 10],
        }));
        let w = Switch {
            tool_start: "",
            from: &from,
            to: &from,
            from_slot: 1,
            to_slot: 2,
            z: 200,
            hop: 2000,
            retracted_mm: 0.0,
            primed: false,
            travel_feed: 9000,
            z_feed: 600,
            from_print: 205.0,
            to_print: 205.0,
        };
        let (s, left) = switch(&w);
        assert_eq!(
            s,
            "G1 F2700 E-6.5\nG1 F1200 E-9.5\nG0 F9000 X330 Y237\nG1 F600 Z2.2\nG92 E0\nT1\nG92 E0\nM109 S195\nM104 T0 S100 ;cooldown\nG280 S1\nG0 Z2.201\nG1 F2700 E-6.5\nG0 F9000 X330 Y219 Z2.2\nM104 S205\n"
        );
        assert!((left - 6.5).abs() < 1e-9);
        let back = Switch {
            primed: true,
            from_slot: 2,
            to_slot: 1,
            retracted_mm: 6.5,
            ..w
        };
        let (s, _) = switch(&back);
        assert_eq!(
            s,
            "G1 F1200 E-9.5\nG0 F9000 X330 Y219\nG1 F600 Z2.2\nG92 E0\nT0\nG92 E0\nM109 S195\nM104 T1 S100 ;cooldown\nG1 F1200 E9.5\nM104 S205\n"
        );
    }

    #[test]
    fn the_uuid_is_stable_and_shaped() {
        let u = uuid(b"G1 X1\n");
        assert_eq!(u, uuid(b"G1 X1\n"));
        assert_eq!(u.len(), 36);
        assert_eq!(u.as_bytes().get(14), Some(&b'4'));
    }

    #[test]
    fn the_extent_counts_every_move_from_the_origin() {
        let (lo, hi) = extent(b"G0 Z20.001\nG0 F9000 X330 Y237\nG1 X10 Y-2 E1\n; G1 X999\n");
        for (got, want) in lo.iter().chain(&hi).zip([0.0, -2.0, 0.0, 330.0, 237.0, 20.001]) {
            assert!((got - want).abs() < 1e-9, "{lo:?} {hi:?}");
        }
    }
}
