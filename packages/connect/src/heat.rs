// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The highest heater targets a print file asks for: nozzle, bed and chamber, in degrees Celsius.
//! A remote start reads them before it lets a phone approve a print nobody is next to.
//!
//! It reads the standard heater commands (`M104`, `M109`, `M140`, `M190`, `M141`, `M191`), Klipper's
//! `SET_HEATER_TEMPERATURE` and the temperature arguments of a start macro (`PRINT_START BED=60
//! EXTRUDER=215`). A `.gcode.3mf` is read through every G-code file inside it. A heater the file never
//! names reads as `None`, which a caller should treat as unknown, never as cold.
use std::io::Read;

/// The highest target of each heater a file sets, in degrees Celsius. `None` when the file never
/// sets that heater. `chamber` of `Some(0.0)` means the file turns a chamber heater off only.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct JobHeat {
    pub nozzle: Option<f64>,
    pub bed: Option<f64>,
    pub chamber: Option<f64>,
}

/// Largest G-code entry read from a `.gcode.3mf`, so a hostile archive cannot fill memory.
const MAX_ENTRY: u64 = 512 * 1024 * 1024;

impl JobHeat {
    fn raise(slot: &mut Option<f64>, v: f64) {
        if v.is_finite() && v >= 0.0 && slot.is_none_or(|cur| v > cur) {
            *slot = Some(v);
        }
    }

    fn merge(&mut self, other: JobHeat) {
        for (mine, theirs) in [
            (&mut self.nozzle, other.nozzle),
            (&mut self.bed, other.bed),
            (&mut self.chamber, other.chamber),
        ] {
            if let Some(v) = theirs {
                Self::raise(mine, v);
            }
        }
    }
}

/// The heater targets of a print file: plain G-code, or a `.gcode.3mf` (a zip with G-code inside).
/// `None` when the bytes are neither (an archive that does not open, text that is not UTF-8 enough
/// to read).
pub fn job_heat(data: &[u8]) -> Option<JobHeat> {
    if data.starts_with(b"PK\x03\x04") {
        return zip_heat(data);
    }
    Some(gcode_heat(&String::from_utf8_lossy(data)))
}

fn zip_heat(data: &[u8]) -> Option<JobHeat> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data)).ok()?;
    let mut heat = JobHeat::default();
    let mut any = false;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else { continue };
        if !entry
            .name()
            .is_ok_and(|n| n.to_ascii_lowercase().ends_with(".gcode"))
        {
            continue;
        }
        let mut text = Vec::new();
        if entry.take(MAX_ENTRY).read_to_end(&mut text).is_err() {
            return None;
        }
        heat.merge(gcode_heat(&String::from_utf8_lossy(&text)));
        any = true;
    }
    any.then_some(heat)
}

/// The heater targets of G-code text.
pub fn gcode_heat(text: &str) -> JobHeat {
    let mut heat = JobHeat::default();
    for raw in text.lines() {
        let line = raw.split(';').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        let mut words = line.split_ascii_whitespace();
        let Some(cmd) = words.next() else { continue };
        let cmd = cmd.to_ascii_uppercase();
        let slot = match cmd.as_str() {
            "M104" | "M109" => Some(&mut heat.nozzle),
            "M140" | "M190" => Some(&mut heat.bed),
            "M141" | "M191" => Some(&mut heat.chamber),
            _ => None,
        };
        if let Some(slot) = slot {
            // `S` sets the target; Marlin's `M109 R` waits for it too.
            for w in words {
                if let Some(v) = w
                    .strip_prefix(['S', 's', 'R', 'r'])
                    .and_then(|v| v.parse::<f64>().ok())
                {
                    JobHeat::raise(slot, v);
                }
            }
            continue;
        }
        if cmd.starts_with(['G', 'M', 'T']) && cmd.chars().skip(1).all(|c| c.is_ascii_digit() || c == '.') {
            continue;
        }
        // A macro: Klipper's own heater command, or a start macro's temperature arguments.
        let heater = if cmd == "SET_HEATER_TEMPERATURE" {
            line.split_ascii_whitespace()
                .find_map(|w| w.to_ascii_uppercase().strip_prefix("HEATER=").map(str::to_owned))
        } else {
            None
        };
        for w in line.split_ascii_whitespace().skip(1) {
            let Some((k, v)) = w.split_once('=') else { continue };
            let Ok(v) = v.parse::<f64>() else { continue };
            let k = k.to_ascii_uppercase();
            let name = if k == "TARGET" {
                heater.clone().unwrap_or_default()
            } else {
                k
            };
            let slot = if name.contains("CHAMBER") {
                &mut heat.chamber
            } else if name.contains("BED") {
                &mut heat.bed
            } else if ["EXTRUDER", "HOTEND", "NOZZLE"].iter().any(|n| name.contains(n)) {
                &mut heat.nozzle
            } else {
                continue;
            };
            JobHeat::raise(slot, v);
        }
    }
    heat
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_highest_target_of_each_heater() {
        let g = "M140 S60 ; bed\nM104 S200\nM190 S65\nM109 S215\nG1 X10 S900\nM104 S0\nM107\n";
        assert_eq!(
            gcode_heat(g),
            JobHeat {
                nozzle: Some(215.0),
                bed: Some(65.0),
                chamber: None
            }
        );
        assert_eq!(gcode_heat("; M104 S300\nG28\n"), JobHeat::default());
        assert_eq!(gcode_heat("M141 S45\nM104 S220\n").chamber, Some(45.0));
        assert_eq!(gcode_heat("M109 R230\n").nozzle, Some(230.0));
    }

    #[test]
    fn reads_klipper_macros() {
        let g = "PRINT_START BED=100 EXTRUDER=250 CHAMBER=50\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=255\n";
        assert_eq!(
            gcode_heat(g),
            JobHeat {
                nozzle: Some(255.0),
                bed: Some(100.0),
                chamber: Some(50.0)
            }
        );
        assert_eq!(
            gcode_heat("SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=70\n").bed,
            Some(70.0)
        );
    }

    #[test]
    fn reads_the_gcode_inside_a_3mf() {
        use std::io::Write as _;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("Metadata/plate_1.gcode", o).unwrap();
            z.write_all(b"M140 S55\nM104 S220\n").unwrap();
            z.start_file("3D/3dmodel.model", o).unwrap();
            z.write_all(b"M104 S400").unwrap();
            z.finish().unwrap();
        }
        let h = job_heat(buf.get_ref()).unwrap();
        assert_eq!((h.nozzle, h.bed, h.chamber), (Some(220.0), Some(55.0), None));
        assert!(job_heat(b"PK\x03\x04 not a zip").is_none());
    }
}
