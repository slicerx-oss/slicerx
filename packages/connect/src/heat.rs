// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The highest heater targets a print file asks for: nozzle, bed and chamber, in degrees Celsius.
//! A remote start reads them before it lets a phone approve a print nobody is next to, so the reader
//! fails closed: anything that could heat and that it cannot read for certain sets `unknown`.
//!
//! Lines are read the way firmware reads them: comments (`;` and parentheses), a leading line number
//! (`N123`) and a checksum (`*71`) are dropped, and a word is a letter and a number with or without
//! spaces (`M104S300`, `M104 S 300`). Heater commands: `M104`, `M109`, `M140` and `M190` with any
//! subcode (`M104.1`), RepRapFirmware's `G10` with `S` or `R` and `M568`, with values in
//! RepRapFirmware's colon lists (`S200:210`). Any `M141` or `M191` sets the chamber, even one that
//! turns it off. An autotune (`M303`), a heater value that is not a plain number (an unrendered
//! template), a Klipper `SET_HEATER_TEMPERATURE` for a heater other than an extruder or the bed, and a
//! macro argument naming a temperature or heater this reader does not know set `unknown`. Macro
//! arguments match by exact name, never by part of a name (`NOZZLE_DIAMETER=0.4` is no temperature).
//!
//! A `.gcode.3mf` is read through every G-code entry inside it, up to [`MAX_TOTAL`] bytes
//! uncompressed in all. An archive past that, one that does not open, and a read past its time set
//! `unknown`.
use std::io::Read;
use std::time::{Duration, Instant};

/// The highest target of each heater a file sets, in degrees Celsius; `None` when the file never
/// sets it. `chamber` is set by any chamber command. `unknown` names the first thing the reader could
/// not vouch for: a caller treats such a file as unreadable.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JobHeat {
    pub nozzle: Option<f64>,
    pub bed: Option<f64>,
    pub chamber: Option<f64>,
    pub unknown: Option<String>,
}

/// Largest total of uncompressed G-code read from a `.gcode.3mf`.
pub const MAX_TOTAL: u64 = 512 * 1024 * 1024;
/// How long a read may take before it gives up as unknown.
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(10);

/// Macro arguments that set the nozzle, the bed or a chamber, matched by exact name.
const NOZZLE_KEYS: &[&str] = &[
    "EXTRUDER",
    "EXTRUDER_TEMP",
    "EXTRUDER_TEMPERATURE",
    "HOTEND",
    "HOTEND_TEMP",
    "HOTEND_TEMPERATURE",
    "NOZZLE_TEMP",
    "NOZZLE_TEMPERATURE",
    "TOOL_TEMP",
    "PRINT_TEMP",
    "FIRST_LAYER_TEMP",
    "EXTRUDER_TEMP_0",
];
const BED_KEYS: &[&str] = &[
    "BED",
    "BED_TEMP",
    "BED_TEMPERATURE",
    "FIRST_LAYER_BED_TEMP",
    "BED_TEMP_0",
];
const CHAMBER_KEYS: &[&str] = &["CHAMBER", "CHAMBER_TEMP", "CHAMBER_TEMPERATURE"];

impl JobHeat {
    fn raise(slot: &mut Option<f64>, v: f64) {
        if slot.is_none_or(|cur| v > cur) {
            *slot = Some(v);
        }
    }

    fn unknown(&mut self, why: impl FnOnce() -> String) {
        if self.unknown.is_none() {
            self.unknown = Some(why());
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
        if let Some(u) = other.unknown {
            self.unknown(|| u);
        }
    }

    fn failed(why: &str) -> Self {
        JobHeat {
            unknown: Some(why.to_owned()),
            ..JobHeat::default()
        }
    }
}

/// The heater targets of a print file, plain G-code or a `.gcode.3mf`, within [`DEFAULT_BUDGET`].
pub fn job_heat(data: &[u8]) -> JobHeat {
    job_heat_capped(data, DEFAULT_BUDGET, MAX_TOTAL)
}

/// [`job_heat`] with its own time allowance and cap on the G-code read from an archive.
pub fn job_heat_capped(data: &[u8], budget: Duration, max_total: u64) -> JobHeat {
    let deadline = Instant::now() + budget;
    if data.starts_with(b"PK\x03\x04") {
        return zip_heat(data, deadline, max_total);
    }
    text_heat(&String::from_utf8_lossy(data), deadline)
}

fn zip_heat(data: &[u8], deadline: Instant, max_total: u64) -> JobHeat {
    let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(data)) else {
        return JobHeat::failed("the archive does not open");
    };
    let mut heat = JobHeat::default();
    let mut any = false;
    let mut left = max_total;
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index(i) else {
            return JobHeat::failed("an archive entry does not open");
        };
        if !entry
            .name()
            .is_ok_and(|n| n.to_ascii_lowercase().ends_with(".gcode"))
        {
            continue;
        }
        let mut text = Vec::new();
        // One byte past what is left tells a whole read from one that hit the cap.
        if entry.take(left.saturating_add(1)).read_to_end(&mut text).is_err() {
            return JobHeat::failed("an archive entry does not read");
        }
        let n = u64::try_from(text.len()).unwrap_or(u64::MAX);
        if n > left {
            return JobHeat::failed("the archive holds more G-code than is read");
        }
        left -= n;
        heat.merge(text_heat(&String::from_utf8_lossy(&text), deadline));
        any = true;
    }
    if !any {
        return JobHeat::failed("the archive holds no G-code");
    }
    heat
}

/// The heater targets of G-code text, within [`DEFAULT_BUDGET`].
pub fn gcode_heat(text: &str) -> JobHeat {
    text_heat(text, Instant::now() + DEFAULT_BUDGET)
}

fn text_heat(text: &str, deadline: Instant) -> JobHeat {
    let mut heat = JobHeat::default();
    for (i, raw) in text.lines().enumerate() {
        if i % 4096 == 0 && Instant::now() >= deadline {
            return JobHeat::failed("reading the file took too long");
        }
        line_heat(raw, &mut heat);
    }
    heat
}

/// The line as firmware reads it: no comments, no line number, no checksum.
fn clean(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth = 0_u32;
    for c in raw.chars() {
        match c {
            ';' if depth == 0 => break,
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let mut s = out.trim();
    if let Some(star) = s.find('*') {
        s = s[..star].trim_end();
    }
    let b = s.as_bytes();
    if b.first().is_some_and(|c| c.eq_ignore_ascii_case(&b'N')) && b.get(1).is_some_and(u8::is_ascii_digit) {
        return s[1..]
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .trim_start()
            .to_owned();
    }
    s.to_owned()
}

/// The words of a command line: each letter with its value text, empty when the letter stands alone.
fn words(s: &str) -> Vec<(char, String)> {
    let mut out = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        let letter = c.to_ascii_uppercase();
        while chars.peek().is_some_and(|c| *c == ' ' || *c == '\t') {
            chars.next();
        }
        let mut value = String::new();
        while let Some(&n) = chars.peek() {
            if n.is_whitespace() || (n.is_ascii_alphabetic() && !value.ends_with(':')) {
                break;
            }
            value.push(n);
            chars.next();
        }
        out.push((letter, value));
    }
    out
}

/// The highest number in a value (`210`, `200:215`), or `None` when it is not plain numbers.
fn value_max(v: &str) -> Option<f64> {
    let mut best: Option<f64> = None;
    for part in v.split(':') {
        let n = part.parse::<f64>().ok().filter(|n| n.is_finite())?;
        best = Some(best.map_or(n, |b: f64| b.max(n)));
    }
    best
}

fn line_heat(raw: &str, heat: &mut JobHeat) {
    let line = clean(raw);
    let b = line.as_bytes();
    let Some(first) = b.first().map(u8::to_ascii_uppercase) else {
        return;
    };
    let numbered = b.get(1).is_some_and(|c| c.is_ascii_digit() || *c == b' ');
    if matches!(first, b'G' | b'M' | b'T') && numbered {
        command_heat(&line, heat);
    } else {
        macro_heat(&line, heat);
    }
}

fn command_heat(line: &str, heat: &mut JobHeat) {
    let w = words(line);
    let Some((letter, code)) = w.first() else { return };
    let number: Option<u32> = code.split('.').next().and_then(|n| n.parse().ok());
    let has = |letters: &[char]| w.iter().skip(1).any(|(l, _)| letters.contains(l));
    let read = |heat: &mut JobHeat, letters: &[char]| -> Vec<f64> {
        let mut out = Vec::new();
        for (l, v) in w.iter().skip(1).filter(|(l, _)| letters.contains(l)) {
            match value_max(v) {
                Some(n) => out.push(n),
                None => heat.unknown(|| format!("`{line}` sets {l} to `{v}`, which is not a number")),
            }
        }
        out
    };
    match (letter, number) {
        ('M', Some(104 | 109 | 568)) => {
            for v in read(heat, &['S', 'R']) {
                JobHeat::raise(&mut heat.nozzle, v);
            }
        }
        ('M', Some(140 | 190)) => {
            for v in read(heat, &['S', 'R']) {
                JobHeat::raise(&mut heat.bed, v);
            }
        }
        ('M', Some(141 | 191)) => {
            let top = read(heat, &['S', 'R']).into_iter().fold(0.0, f64::max);
            JobHeat::raise(&mut heat.chamber, top);
        }
        ('M', Some(303)) => heat.unknown(|| format!("`{line}` tunes a heater")),
        // RepRapFirmware's tool temperatures; without S or R it is a retraction or an offset.
        ('G', Some(10)) if has(&['S', 'R']) => {
            for v in read(heat, &['S', 'R']) {
                JobHeat::raise(&mut heat.nozzle, v);
            }
        }
        ('M' | 'G', None) => heat.unknown(|| format!("`{line}` is not a command this reader knows")),
        _ => {}
    }
}

fn macro_heat(line: &str, heat: &mut JobHeat) {
    let mut parts = line.split_whitespace();
    let name = parts.next().unwrap_or_default().to_ascii_uppercase();
    let args: Vec<(String, &str)> = parts
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.to_ascii_uppercase(), v))
        .collect();
    if name == "SET_HEATER_TEMPERATURE" {
        let heater = args
            .iter()
            .find(|(k, _)| k == "HEATER")
            .map(|(_, v)| v.to_ascii_lowercase())
            .unwrap_or_default();
        let Some((_, target)) = args.iter().find(|(k, _)| k == "TARGET") else {
            return;
        };
        let Some(v) = value_max(target) else {
            return heat.unknown(|| format!("`{line}` sets a target that is not a number"));
        };
        let extruder = heater
            .strip_prefix("extruder")
            .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()));
        if extruder {
            JobHeat::raise(&mut heat.nozzle, v);
        } else if heater == "heater_bed" {
            JobHeat::raise(&mut heat.bed, v);
        } else {
            heat.unknown(|| format!("`{line}` heats `{heater}`"));
        }
        return;
    }
    for (k, v) in &args {
        // Klipper names extruders by object (`ACTIVATE_EXTRUDER EXTRUDER=extruder1`): not a temperature.
        if k == "EXTRUDER" && v.to_ascii_lowercase().starts_with("extruder") {
            continue;
        }
        let slot = if NOZZLE_KEYS.contains(&k.as_str()) {
            &mut heat.nozzle
        } else if BED_KEYS.contains(&k.as_str()) {
            &mut heat.bed
        } else if CHAMBER_KEYS.contains(&k.as_str()) {
            &mut heat.chamber
        } else {
            if ["TEMP", "HEAT", "CHAMBER"].iter().any(|w| k.contains(w)) {
                heat.unknown(|| format!("`{name}` takes `{k}`, a temperature this reader does not know"));
            }
            continue;
        };
        match value_max(v) {
            Some(n) => JobHeat::raise(slot, n),
            None => heat.unknown(|| format!("`{name}` sets {k} to `{v}`, which is not a number")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(nozzle: Option<f64>, bed: Option<f64>, chamber: Option<f64>) -> JobHeat {
        JobHeat {
            nozzle,
            bed,
            chamber,
            unknown: None,
        }
    }

    #[test]
    fn reads_the_highest_target_of_each_heater() {
        let g = "M140 S60 ; bed\nM104 S200\nM190 S65\nM109 S215\nG1 X10 S900\nM104 S0\nM107\n";
        assert_eq!(gcode_heat(g), h(Some(215.0), Some(65.0), None));
        assert_eq!(gcode_heat("; M104 S300\nG28\n"), JobHeat::default());
        assert_eq!(gcode_heat("M109 R230\n").nozzle, Some(230.0));
    }

    #[test]
    fn reads_words_as_firmware_does() {
        let n = |g: &str| gcode_heat(g).nozzle;
        assert_eq!(n("M104S300\n"), Some(300.0));
        assert_eq!(n("N12 M104 S290*71\n"), Some(290.0));
        assert_eq!(n("N12M109S295*3\n"), Some(295.0));
        assert_eq!(n("M104 S 280\n"), Some(280.0));
        assert_eq!(n("M104 (S100) S270\n"), Some(270.0));
        assert_eq!(gcode_heat("m140s100\n").bed, Some(100.0));
        assert_eq!(n("M104.1 S285\n"), Some(285.0));
        assert_eq!(n("M109.2 S286\n"), Some(286.0));
        assert_eq!(gcode_heat("M190.1 S105\n").bed, Some(105.0));
        assert_eq!(n("G10 P0 S260 R150\n"), Some(260.0));
        assert_eq!(n("G10 P0 S200:275\n"), Some(275.0));
        assert_eq!(n("M568 P0 S265\n"), Some(265.0));
        // A nozzle diameter is not a nozzle temperature.
        assert_eq!(
            n("PRINT_START NOZZLE_DIAMETER=0.4 NOZZLE_TEMP=215\n"),
            Some(215.0)
        );
        // G10 without temperatures is a retraction or an offset.
        assert_eq!(n("G10\nG10 L2 P1 X0 Y0\n"), None);
        assert_eq!(
            gcode_heat("ACTIVATE_EXTRUDER EXTRUDER=extruder1\n"),
            JobHeat::default()
        );
    }

    #[test]
    fn fails_closed_on_chambers_tuning_templates_and_unknown_heaters() {
        assert_eq!(gcode_heat("M141 S45\n").chamber, Some(45.0));
        assert_eq!(gcode_heat("M191 S0\n").chamber, Some(0.0));
        assert_eq!(gcode_heat("M141\n").chamber, Some(0.0));
        assert_eq!(gcode_heat("PRINT_START CHAMBER=50\n").chamber, Some(50.0));
        for g in [
            "M303 E0 S240 C8\n",
            "M104 S{first_layer_temperature[0]}\n",
            "M104 S[nozzle_temp]\n",
            "SET_HEATER_TEMPERATURE HEATER=enclosure TARGET=60\n",
            "SET_HEATER_TEMPERATURE HEATER=chamber_heater TARGET=50\n",
            "SET_HEATER_TEMPERATURE HEATER=extruder TARGET={params.T}\n",
            "PRINT_START EXTRUDER_TEMP={first_layer_temperature}\n",
            "PRINT_START KEEP_WARM_TEMP=60\n",
        ] {
            assert!(gcode_heat(g).unknown.is_some(), "{g}");
        }
    }

    #[test]
    fn reads_klipper_macros_by_exact_name() {
        let g = "PRINT_START BED=100 EXTRUDER=250\nSET_HEATER_TEMPERATURE HEATER=extruder TARGET=255\n";
        assert_eq!(gcode_heat(g), h(Some(255.0), Some(100.0), None));
        assert_eq!(
            gcode_heat("SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=70\n").bed,
            Some(70.0)
        );
        assert_eq!(
            gcode_heat("SET_HEATER_TEMPERATURE HEATER=extruder1 TARGET=230\n").nozzle,
            Some(230.0)
        );
        let d = gcode_heat("PRINT_START NOZZLE_DIAMETER=0.4 BED_TEMP=60 NOZZLE_TEMP=215\n");
        assert_eq!(d, h(Some(215.0), Some(60.0), None));
    }

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write as _;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                z.start_file(*name, o).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn reads_the_gcode_inside_a_3mf_and_refuses_what_it_cannot_open() {
        let a = archive(&[
            ("Metadata/plate_1.gcode", b"M140 S55\nM104 S220\n"),
            ("3D/3dmodel.model", b"M104 S400"),
        ]);
        assert_eq!(job_heat(&a), h(Some(220.0), Some(55.0), None));
        assert!(job_heat(b"PK\x03\x04 not a zip").unknown.is_some());
        assert!(
            job_heat(&archive(&[("3D/3dmodel.model", b"x")]))
                .unknown
                .is_some()
        );
    }

    #[test]
    fn caps_the_gcode_read_from_an_archive_and_the_time_spent() {
        let a = archive(&[
            ("Metadata/plate_1.gcode", b"M104 S220\n"),
            ("Metadata/plate_2.gcode", b"M104 S220\n"),
        ]);
        assert!(job_heat_capped(&a, DEFAULT_BUDGET, 15).unknown.is_some());
        assert!(job_heat_capped(&a, DEFAULT_BUDGET, 20).unknown.is_none());
        let big = "G1 X1 Y1\n".repeat(20_000);
        assert!(
            job_heat_capped(big.as_bytes(), Duration::ZERO, MAX_TOTAL)
                .unknown
                .is_some()
        );
    }
}
