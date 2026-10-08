// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Post-slice identity stamp, applied to the library upload only.
//!
//! BamBuddy accepts a bridged printer as the Bambu model that printer is
//! presented as (goBamKlipper's card is an A1 Mini, `printer_model_id` `N1`).
//! The motion G-code stays the machine that was sliced. A real Bambu profile
//! is left alone when it already matches that model, and also when BamBuddy
//! does not say which model the printer is.
//!
//! When `GET /api/v1/printers/{id}` has no model, a non-Bambu profile is
//! stamped `Bambu Lab A1 Mini` / `N1` / `printer_agent` `bambu`, the same
//! default `gobamklipper wrap` writes.
use std::io::{Cursor, Read, Write};

use serde_json::{Value, json};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

/// A Bambu model BamBuddy stores, and the identity strings a 3mf has to carry.
struct Model {
    short: &'static str,
    display: &'static str,
    id: &'static str,
    /// Extra spellings of `Printer.model` or `printer_model_id`, compared after
    /// letters and digits are folded together.
    extra: &'static [&'static str],
}

/// goBamKlipper's default card. Also the stamp used when BamBuddy does not say.
const A1_MINI: Model = Model {
    short: "A1 Mini",
    display: "Bambu Lab A1 Mini",
    id: "N1",
    extra: &["A1M", "A12", "A04"],
};

const MODELS: &[Model] = &[
    A1_MINI,
    Model {
        short: "A1",
        display: "Bambu Lab A1",
        id: "N2S",
        extra: &["A11"],
    },
    Model {
        short: "X1C",
        display: "Bambu Lab X1 Carbon",
        id: "BL-P001",
        extra: &["X1 Carbon"],
    },
    Model {
        short: "X1",
        display: "Bambu Lab X1",
        id: "BL-P002",
        extra: &[],
    },
    Model {
        short: "X1E",
        display: "Bambu Lab X1E",
        id: "C13",
        extra: &[],
    },
    Model {
        short: "P1P",
        display: "Bambu Lab P1P",
        id: "C11",
        extra: &[],
    },
    Model {
        short: "P1S",
        display: "Bambu Lab P1S",
        id: "C12",
        extra: &[],
    },
    Model {
        short: "P2S",
        display: "Bambu Lab P2S",
        id: "N7",
        extra: &[],
    },
    Model {
        short: "H2D",
        display: "Bambu Lab H2D",
        id: "O1D",
        extra: &[],
    },
    Model {
        short: "H2D Pro",
        display: "Bambu Lab H2D Pro",
        id: "O1E",
        extra: &["O2D"],
    },
    Model {
        short: "H2C",
        display: "Bambu Lab H2C",
        id: "O1C",
        extra: &["O1C2"],
    },
    Model {
        short: "H2S",
        display: "Bambu Lab H2S",
        id: "O1S",
        extra: &[],
    },
    Model {
        short: "X2D",
        display: "Bambu Lab X2D",
        id: "N6",
        extra: &[],
    },
    Model {
        short: "A2L",
        display: "Bambu Lab A2L",
        id: "N9",
        extra: &[],
    },
];

/// What BamBuddy will record as `sliced_for_model` from this file.
struct Identity {
    /// `project_settings` `printer_model` when the file has one. BamBuddy's
    /// parser writes this after `slice_info`, so it wins.
    project_model: Option<String>,
    /// `slice_info` `printer_model_id`, when a plate declares one.
    model_id: Option<String>,
    /// `; printer_model` in the plate G-code, the fallback BamBuddy uses.
    gcode_model: Option<String>,
}

impl Identity {
    /// The string BamBuddy keeps, in the order its parser applies them.
    fn effective(&self) -> Option<&str> {
        self.project_model
            .as_deref()
            .or(self.model_id.as_deref())
            .or(self.gcode_model.as_deref())
    }

    fn matches(&self, model: &Model) -> bool {
        self.effective().is_some_and(|raw| model_matches(model, raw))
    }

    fn is_known_bambu(&self) -> bool {
        self.effective()
            .is_some_and(|raw| MODELS.iter().any(|m| model_matches(m, raw)))
    }
}

pub(crate) fn is_zip(data: &[u8]) -> bool {
    data.get(..4).is_some_and(|magic| magic == b"PK\x03\x04")
}

/// The bytes to upload. A file that already matches the printer's Bambu model
/// is returned unchanged. `api_model` is `Printer.model` from
/// `GET /api/v1/printers/{id}`, or `None` when that call does not say.
pub(crate) fn prepare_library_file(data: &[u8], api_model: Option<&str>) -> Result<Vec<u8>, String> {
    if !is_zip(data) {
        return Ok(data.to_vec());
    }
    let identity = read_identity(data)?;
    let Some(model) = stamp_target(&identity, api_model) else {
        return Ok(data.to_vec());
    };
    rewrite(data, model)
}

/// Stamp toward the model BamBuddy has for this printer. With no usable model,
/// stamp a non-Bambu profile as an A1 Mini and leave a Bambu profile as sliced.
fn stamp_target<'a>(identity: &Identity, api_model: Option<&str>) -> Option<&'a Model> {
    let told = api_model.map(str::trim).filter(|s| !s.is_empty());
    if let Some(wanted) = told.and_then(find_model) {
        if identity.matches(wanted) {
            return None;
        }
        return Some(wanted);
    }
    if identity.is_known_bambu() {
        return None;
    }
    Some(&A1_MINI)
}

fn find_model(raw: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| model_matches(m, raw))
}

fn model_matches(model: &Model, raw: &str) -> bool {
    let n = norm(raw);
    if n.is_empty() {
        return false;
    }
    n == norm(model.short)
        || n == norm(model.display)
        || n == norm(model.id)
        || model.extra.iter().any(|a| n == norm(a))
}

/// Letters and digits only, uppercased, so `A1 Mini`, `A1-MINI` and `Bambu Lab A1 mini` compare equal.
fn norm(raw: &str) -> String {
    raw.chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_uppercase)
        .collect()
}

fn read_identity(data: &[u8]) -> Result<Identity, String> {
    let mut zip =
        ZipArchive::new(Cursor::new(data)).map_err(|e| format!("cannot read the sliced file: {e}"))?;
    let mut identity = Identity {
        project_model: None,
        model_id: None,
        gcode_model: None,
    };
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|e| format!("cannot read the sliced file: {e}"))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_owned();
        let kind = entry_kind(&name);
        if kind == Kind::Other {
            continue;
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("cannot read {name}: {e}"))?;
        let Ok(text) = String::from_utf8(buf) else {
            continue;
        };
        match kind {
            Kind::SliceInfo => {
                if identity.model_id.is_none() {
                    identity.model_id = first_model_id(&text);
                }
            }
            Kind::Project => identity.project_model = identity.project_model.or_else(|| project_model(&text)),
            Kind::Gcode => {
                if identity.gcode_model.is_none() {
                    identity.gcode_model = gcode_model(&text);
                }
            }
            Kind::Other => {}
        }
    }
    Ok(identity)
}

fn rewrite(data: &[u8], model: &Model) -> Result<Vec<u8>, String> {
    let mut zip =
        ZipArchive::new(Cursor::new(data)).map_err(|e| format!("cannot read the sliced file: {e}"))?;
    let mut parts = Vec::new();
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|e| format!("cannot read the sliced file: {e}"))?;
        let name = file.name().to_owned();
        let dir = file.is_dir();
        let mut buf = Vec::new();
        if !dir {
            file.read_to_end(&mut buf)
                .map_err(|e| format!("cannot read {name}: {e}"))?;
        }
        let data = if dir { buf } else { stamp_bytes(&name, buf, model) };
        parts.push((name, dir, data));
    }
    write_zip(&parts)
}

/// Stamp a text entry. Binary entries are copied through unchanged.
fn stamp_bytes(name: &str, buf: Vec<u8>, model: &Model) -> Vec<u8> {
    match entry_kind(name) {
        Kind::Other => buf,
        Kind::Gcode => {
            let Ok(text) = std::str::from_utf8(&buf) else {
                return buf;
            };
            rewrite_gcode(text, model.display).into_bytes()
        }
        Kind::SliceInfo => {
            let Ok(text) = std::str::from_utf8(&buf) else {
                return buf;
            };
            stamp_slice_info(text, model.id).into_bytes()
        }
        Kind::Project => {
            let Ok(text) = std::str::from_utf8(&buf) else {
                return buf;
            };
            stamp_project_settings(text, model.display).into_bytes()
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Gcode,
    SliceInfo,
    Project,
    Other,
}

fn entry_kind(name: &str) -> Kind {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if ends_with_ignore_ascii(base, ".gcode") {
        Kind::Gcode
    } else if base.eq_ignore_ascii_case("slice_info.config") {
        Kind::SliceInfo
    } else if base.eq_ignore_ascii_case("project_settings.config") {
        Kind::Project
    } else {
        Kind::Other
    }
}

fn ends_with_ignore_ascii(name: &str, suffix: &str) -> bool {
    name.len() >= suffix.len()
        && name
            .get(name.len() - suffix.len()..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
}

fn write_zip(parts: &[(String, bool, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut out = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, dir, data) in parts {
        if *dir {
            out.add_directory(name.as_str(), dir_options())
                .map_err(|e| format!("cannot write {name}: {e}"))?;
            continue;
        }
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .last_modified_time(DateTime::default())
            .unix_permissions(0o644)
            .large_file(u64::try_from(data.len()).unwrap_or(u64::MAX) >= u64::from(u32::MAX));
        out.start_file(name.as_str(), options)
            .map_err(|e| format!("cannot write {name}: {e}"))?;
        out.write_all(data)
            .map_err(|e| format!("cannot write {name}: {e}"))?;
    }
    let cursor = out
        .finish()
        .map_err(|e| format!("cannot write the sliced file: {e}"))?;
    Ok(cursor.into_inner())
}

fn dir_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .last_modified_time(DateTime::default())
        .unix_permissions(0o755)
}

/// Replace the identity comments. Every other line, including start G-code and
/// moves, is copied unchanged. `printer_model` is added when the file has none.
fn rewrite_gcode(text: &str, display: &str) -> String {
    let mut out = String::with_capacity(text.len().saturating_add(display.len()).saturating_add(32));
    let mut seen_model = false;
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        let ending = line_ending(line);
        if comment_key(body, "printer_model") {
            out.push_str("; printer_model = ");
            out.push_str(display);
            out.push_str(ending);
            seen_model = true;
        } else if comment_key(body, "printer_settings_id") {
            out.push_str("; printer_settings_id = ");
            out.push_str(display);
            out.push_str(ending);
        } else if comment_key(body, "printer_agent") {
            out.push_str("; printer_agent = bambu");
            out.push_str(ending);
        } else {
            out.push_str(line);
        }
    }
    if seen_model {
        return out;
    }
    let mut prefixed = String::with_capacity(out.len().saturating_add(display.len()).saturating_add(24));
    prefixed.push_str("; printer_model = ");
    prefixed.push_str(display);
    prefixed.push('\n');
    prefixed.push_str(&out);
    prefixed
}

fn line_ending(line: &str) -> &str {
    if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}

fn comment_key(line: &str, key: &str) -> bool {
    let Some(rest) = line.trim().strip_prefix(';') else {
        return false;
    };
    let rest = rest.trim_start();
    if !rest
        .get(..key.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(key))
    {
        return false;
    }
    match rest.get(key.len()..) {
        Some(tail) => tail.is_empty() || tail.starts_with([' ', '=']),
        None => false,
    }
}

fn stamp_slice_info(xml: &str, model_id: &str) -> String {
    if !xml.to_ascii_lowercase().contains("printer_model_id") {
        return insert_model_id(xml, model_id);
    }
    let mut out = String::with_capacity(xml.len().saturating_add(model_id.len()));
    let mut rest = xml;
    while let Some(rel) = rest.to_ascii_lowercase().find("printer_model_id") {
        let key_end = rel.saturating_add("printer_model_id".len());
        out.push_str(rest.get(..key_end).unwrap_or(rest));
        let after = rest.get(key_end..).unwrap_or("");
        let lower_after = after.to_ascii_lowercase();
        let Some(vrel) = lower_after.find("value=\"") else {
            rest = after;
            continue;
        };
        let gap = lower_after.get(..vrel).unwrap_or("");
        if gap.contains('>') {
            rest = after;
            continue;
        }
        let value_start = vrel.saturating_add("value=\"".len());
        out.push_str(after.get(..value_start).unwrap_or(after));
        out.push_str(model_id);
        let value_tail = after.get(value_start..).unwrap_or("");
        let Some(end) = value_tail.find('"') else {
            rest = value_tail;
            continue;
        };
        rest = value_tail.get(end..).unwrap_or("");
    }
    out.push_str(rest);
    out
}

fn insert_model_id(xml: &str, model_id: &str) -> String {
    let line = format!("<plate>\n    <metadata key=\"printer_model_id\" value=\"{model_id}\"/>");
    if xml.contains("<plate>") {
        return xml.replace("<plate>", &line);
    }
    xml.to_owned()
}

fn stamp_project_settings(raw: &str, display: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return raw.to_owned();
    };
    let Some(obj) = value.as_object_mut() else {
        return raw.to_owned();
    };
    obj.insert("printer_model".to_owned(), json!(display));
    obj.insert("printer_settings_id".to_owned(), json!(display));
    obj.insert("printer_agent".to_owned(), json!("bambu"));
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| raw.to_owned())
}

fn first_model_id(xml: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let rel = lower.find("printer_model_id")?;
    let after = xml.get(rel.saturating_add("printer_model_id".len())..)?;
    let lower_after = after.to_ascii_lowercase();
    let vrel = lower_after.find("value=\"")?;
    if lower_after.get(..vrel).unwrap_or("").contains('>') {
        return None;
    }
    let value = after.get(vrel.saturating_add("value=\"".len())..)?;
    let end = value.find('"')?;
    let id = value.get(..end).unwrap_or("").trim();
    if id.is_empty() { None } else { Some(id.to_owned()) }
}

fn project_model(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    json_string(value.get("printer_model")?)
}

fn json_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() { None } else { Some(s.to_owned()) }
        }
        Value::Array(items) => items.iter().find_map(json_string),
        _ => None,
    }
}

fn gcode_model(text: &str) -> Option<String> {
    for line in text.lines() {
        if !comment_key(line, "printer_model") {
            continue;
        }
        let Some(rest) = line.trim().strip_prefix(';') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(after) = rest.get("printer_model".len()..) else {
            continue;
        };
        let value = after.trim_start().trim_start_matches('=').trim();
        if !value.is_empty() {
            return Some(value.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voron_3mf() -> Vec<u8> {
        let gcode = "\
; generated by SlicerX sx-core\n\
; flavor: Marlin\n\
; printer_model = Voron 2.4 350\n\
; printer_settings_id = Voron 2.4 350 0.4 nozzle\n\
; printer_agent = orca\n\
G28 ;home\n\
G1 X300 Y300 F6000 ; Voron bed\n";
        let slice_info = "\
<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<config>\n\
  <plate>\n\
    <metadata key=\"index\" value=\"1\"/>\n\
    <metadata key=\"printer_model_id\" value=\"\"/>\n\
  </plate>\n\
</config>\n";
        let project =
            "{\"printer_model\":\"Voron 2.4 350\",\"printable_area\":[[0,0],[350,0],[350,350],[0,350]]}";
        zip_with(&[
            ("Metadata/plate_1.gcode", gcode.as_bytes()),
            ("Metadata/slice_info.config", slice_info.as_bytes()),
            ("Metadata/project_settings.config", project.as_bytes()),
        ])
    }

    fn bambu_3mf(model: &str, model_id: &str) -> Vec<u8> {
        let gcode = format!("; printer_model = {model}\nG28 ;home\nG1 X90 Y90\n");
        let slice_info = format!(
            "<config><plate><metadata key=\"printer_model_id\" value=\"{model_id}\"/></plate></config>"
        );
        let project = format!("{{\"printer_model\":\"{model}\"}}");
        zip_with(&[
            ("Metadata/plate_1.gcode", gcode.as_bytes()),
            ("Metadata/slice_info.config", slice_info.as_bytes()),
            ("Metadata/project_settings.config", project.as_bytes()),
        ])
    }

    fn zip_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, data) in files {
            out.start_file(*name, options).unwrap();
            out.write_all(data).unwrap();
        }
        out.finish().unwrap().into_inner()
    }

    fn entry(zip: &[u8], name: &str) -> String {
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let mut file = archive.by_name(name).unwrap();
        let mut buf = String::new();
        file.read_to_string(&mut buf).unwrap();
        buf
    }

    #[test]
    fn voron_slice_uploaded_through_bambuddy_carries_n1_and_keeps_voron_gcode() {
        // The printer BamBuddy has for this id is the A1 Mini a bridge presents.
        let stamped = prepare_library_file(&voron_3mf(), Some("A1 Mini")).unwrap();
        let gcode = entry(&stamped, "Metadata/plate_1.gcode");
        let info = entry(&stamped, "Metadata/slice_info.config");
        let project = entry(&stamped, "Metadata/project_settings.config");
        assert!(info.contains("printer_model_id\" value=\"N1\""), "{info}");
        assert!(
            project.contains("\"printer_model\": \"Bambu Lab A1 Mini\""),
            "{project}"
        );
        assert!(project.contains("\"printer_agent\": \"bambu\""), "{project}");
        assert!(project.contains("350"), "{project}");
        assert!(gcode.contains("; printer_model = Bambu Lab A1 Mini\n"), "{gcode}");
        assert!(
            gcode.contains("; printer_settings_id = Bambu Lab A1 Mini\n"),
            "{gcode}"
        );
        assert!(gcode.contains("; printer_agent = bambu\n"), "{gcode}");
        assert!(gcode.contains("G28 ;home\n"), "{gcode}");
        assert!(gcode.contains("G1 X300 Y300 F6000 ; Voron bed\n"), "{gcode}");
        assert!(!gcode.contains("Voron 2.4"), "{gcode}");
    }

    #[test]
    fn an_unknown_printer_model_stamps_a_voron_as_an_a1_mini_and_leaves_a_bambu_slice() {
        let voron = prepare_library_file(&voron_3mf(), None).unwrap();
        assert!(entry(&voron, "Metadata/slice_info.config").contains("value=\"N1\""));
        assert!(entry(&voron, "Metadata/plate_1.gcode").contains("G1 X300 Y300 F6000 ; Voron bed"));

        let p1s = bambu_3mf("Bambu Lab P1S", "C12");
        let kept = prepare_library_file(&p1s, None).unwrap();
        assert_eq!(kept, p1s);
    }

    #[test]
    fn a_slice_that_already_matches_the_printer_is_not_rewritten() {
        let mini = bambu_3mf("Bambu Lab A1 mini", "N1");
        let kept = prepare_library_file(&mini, Some("A1 Mini")).unwrap();
        assert_eq!(kept, mini);
    }

    #[test]
    fn a_printer_bambuddy_calls_a_p1s_stamps_the_voron_file_as_a_p1s() {
        let stamped = prepare_library_file(&voron_3mf(), Some("P1S")).unwrap();
        let info = entry(&stamped, "Metadata/slice_info.config");
        assert!(info.contains("value=\"C12\""), "{info}");
        assert!(entry(&stamped, "Metadata/project_settings.config").contains("Bambu Lab P1S"));
        assert!(entry(&stamped, "Metadata/plate_1.gcode").contains("G1 X300 Y300 F6000 ; Voron bed"));
    }
}
