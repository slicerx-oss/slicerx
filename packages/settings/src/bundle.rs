// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The preset files of an Orca or Bambu Studio preset bundle: Orca's printer config bundle (`.orca_printer`,
//! `.orca_bundle`) and filament bundle (`.orca_filament`), Bambu Studio's printer and filament preset bundles
//! (`.bbscfg`, `.bbsflmt`), or a plain zip of preset files. A bundle is a zip with `bundle_structure.json` naming its
//! preset files. Unzipping is the caller's job; this reads the entries. `js/presetfile.ts` mirrors it.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value as Json;

use crate::error::Error;
use crate::schema::Section;

/// Largest preset file inside a bundle, in bytes.
pub const MAX_PRESET_BYTES: usize = 2 * 1024 * 1024;
/// Most presets read from one bundle.
pub const MAX_BUNDLE_PRESETS: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PresetFile {
    pub path: String,
    pub kind: Section,
    pub json: Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BundleType {
    Printer,
    Filament,
    Presets,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub path: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PresetBundle {
    #[serde(rename = "type")]
    pub kind: BundleType,
    /// A printer bundle's printer preset, which its filament and process presets belong to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub printer: Option<String>,
    pub files: Vec<PresetFile>,
    pub skipped: Vec<Skipped>,
}

/// The kind of an Orca or Bambu preset: its `type`, else the settings id it carries (user presets have no `type`).
#[must_use]
pub fn preset_kind(o: &serde_json::Map<String, Json>) -> Option<Section> {
    match o.get("type").and_then(Json::as_str) {
        Some("machine" | "printer") => return Some(Section::Printer),
        Some("filament") => return Some(Section::Filament),
        Some("process" | "print") => return Some(Section::Process),
        _ => {}
    }
    if o.contains_key("printer_settings_id") {
        Some(Section::Printer)
    } else if o.contains_key("print_settings_id") {
        Some(Section::Process)
    } else if o.contains_key("filament_settings_id") {
        Some(Section::Filament)
    } else {
        None
    }
}

fn safe_path(p: &str) -> bool {
    let drive =
        p.as_bytes().get(1) == Some(&b':') && p.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    !p.is_empty()
        && !p.starts_with('/')
        && !p.starts_with('\\')
        && !drive
        && !p.split(['/', '\\']).any(|s| s == "..")
}

fn strings(v: Option<&Json>) -> Vec<String> {
    v.and_then(Json::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn folder_kind(folder: &str) -> Option<Section> {
    match folder.to_lowercase().as_str() {
        "printer" | "machine" => Some(Section::Printer),
        "filament" => Some(Section::Filament),
        "process" | "print" => Some(Section::Process),
        _ => None,
    }
}

fn parse(bytes: &[u8]) -> Option<serde_json::Map<String, Json>> {
    // A text decoder drops a byte order mark; so does this.
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match serde_json::from_slice::<Json>(body).ok()? {
        Json::Object(o) => Some(o),
        _ => None,
    }
}

struct Reader<'a> {
    entries: &'a BTreeMap<String, Vec<u8>>,
    files: Vec<PresetFile>,
    skipped: Vec<Skipped>,
}

impl Reader<'_> {
    fn skip(&mut self, path: &str, why: &str) {
        self.skipped.push(Skipped {
            path: path.to_owned(),
            why: why.to_owned(),
        });
    }

    fn add(&mut self, path: &str, kind: Option<Section>) -> Result<(), Error> {
        if !safe_path(path) {
            self.skip(path, "The path is not safe.");
            return Ok(());
        }
        let Some(bytes) = self.entries.get(path) else {
            self.skip(path, "The bundle names this file but does not have it.");
            return Ok(());
        };
        if bytes.len() > MAX_PRESET_BYTES {
            self.skip(path, "The file is too large to be a preset.");
            return Ok(());
        }
        let Some(json) = parse(bytes) else {
            self.skip(path, "The file is not a preset.");
            return Ok(());
        };
        let own = preset_kind(&json);
        let Some(k) = kind.or(own) else {
            self.skip(path, "The file is not a preset.");
            return Ok(());
        };
        if own.is_some_and(|o| o != k) {
            self.skip(
                path,
                "The file is a different kind of preset than the bundle says.",
            );
            return Ok(());
        }
        if self.files.len() >= MAX_BUNDLE_PRESETS {
            return Err(Error::Bundle("The bundle has too many presets.".into()));
        }
        self.files.push(PresetFile {
            path: path.to_owned(),
            kind: k,
            json: Json::Object(json),
        });
        Ok(())
    }
}

/// Read the preset files of an unzipped bundle. Fails when the archive holds no presets.
pub fn read_preset_bundle(entries: &BTreeMap<String, Vec<u8>>) -> Result<PresetBundle, Error> {
    let manifest = match entries.get("bundle_structure.json") {
        Some(b) => Some(
            parse(b)
                .ok_or_else(|| Error::Bundle("The bundle description in this file is damaged.".into()))?,
        ),
        None => None,
    };
    let mut r = Reader {
        entries,
        files: Vec::new(),
        skipped: Vec::new(),
    };
    let bundle_type = manifest
        .as_ref()
        .and_then(|m| m.get("bundle_type"))
        .and_then(Json::as_str);
    let mut kind = BundleType::Presets;
    let mut printer = None;
    match (manifest.as_ref(), bundle_type) {
        (Some(m), Some("printer config bundle")) => {
            kind = BundleType::Printer;
            for p in strings(m.get("printer_config")) {
                r.add(&p, Some(Section::Printer))?;
            }
            for p in strings(m.get("filament_config")) {
                r.add(&p, Some(Section::Filament))?;
            }
            for p in strings(m.get("process_config")) {
                r.add(&p, Some(Section::Process))?;
            }
            let printers: Vec<&PresetFile> = r.files.iter().filter(|f| f.kind == Section::Printer).collect();
            let name_of = |f: &PresetFile| f.json.get("name").and_then(Json::as_str).map(str::to_owned);
            let named = m.get("printer_preset_name").and_then(Json::as_str);
            printer = match named {
                Some(n) if printers.iter().any(|f| name_of(f).as_deref() == Some(n)) => Some(n.to_owned()),
                _ if printers.len() == 1 => printers
                    .first()
                    .and_then(|f| name_of(f))
                    .filter(|n| !n.is_empty()),
                _ => None,
            };
        }
        (Some(m), Some("filament config bundle")) => {
            kind = BundleType::Filament;
            // Orca lists the files per printer vendor, Bambu Studio per filament vendor.
            let mut paths = Vec::new();
            for key in ["printer_vendor", "filament_vendor"] {
                for g in m.get(key).and_then(Json::as_array).into_iter().flatten() {
                    paths.extend(strings(g.get("filament_path")));
                }
            }
            for p in paths {
                r.add(&p, Some(Section::Filament))?;
            }
        }
        _ => {
            for path in entries.keys() {
                if path == "bundle_structure.json" || !path.to_lowercase().ends_with(".json") {
                    continue;
                }
                let kind = path.split_once('/').and_then(|(folder, _)| folder_kind(folder));
                r.add(path, kind)?;
            }
        }
    }
    if r.files.is_empty() {
        return Err(Error::Bundle(match r.skipped.first() {
            Some(s) => format!("No preset in the bundle could be read. {}", s.why),
            None => "The bundle has no presets in it.".into(),
        }));
    }
    Ok(PresetBundle {
        kind,
        printer,
        files: r.files,
        skipped: r.skipped,
    })
}
