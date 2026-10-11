// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Sets `SX_BUILD_DATE` (`yyyy-mm-dd`, from `SOURCE_DATE_EPOCH` when set, else the build day in UTC), the
//! build date Ultimaker's G-code header carries.
//!
//! Writes the keys whose type is a percent (`percent` and `percents` in `packages/settings/schema.json`,
//! Orca's `coPercent` and `coPercents`), one per line, so the configuration block writes them with their `%`,
//! and the whole number keys (`int` and `ints`, Orca's `coInt` and `coInts`), which the placeholder language
//! reads as integers, and copies `packages/settings/defaults.json` next to them, with the `PrusaSlicer` key map
//! (`packages/settings/prusa-map.json`) and the head shapes the collision check uses
//! (`packages/ui/viewport/data/head-shapes.json`).
//!
//! The published crate has neither folder, so it reads the copies in `data/` instead.
//! `tests/published_data.rs` checks that they match; `SX_UPDATE_CORE_DATA=1` rewrites them.

use std::path::Path;

fn main() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    let out = Path::new(&std::env::var("OUT_DIR").unwrap_or_default()).to_path_buf();
    let settings = here.join("../settings");
    let schema = settings.join("schema.json");
    if schema.exists() {
        println!("cargo:rerun-if-changed={}", schema.display());
        let text =
            std::fs::read_to_string(&schema).unwrap_or_else(|e| panic!("reading {}: {e}", schema.display()));
        let parsed: serde_json::Value =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parsing {}: {e}", schema.display()));
        for (types, file) in [
            (["percent", "percents"], "percent_keys.txt"),
            (["int", "ints"], "int_keys.txt"),
        ] {
            let mut keys: Vec<&str> = parsed["settings"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter(|d| d["type"].as_str().is_some_and(|t| types.contains(&t)))
                .filter_map(|d| d["key"].as_str())
                .collect();
            keys.sort_unstable();
            keys.dedup();
            write(&out.join(file), keys.join("\n").as_bytes());
        }
        copy(&settings.join("defaults.json"), &out.join("defaults.json"));
        copy(&settings.join("prusa-map.json"), &out.join("prusa-map.json"));
    } else {
        for file in [
            "percent_keys.txt",
            "int_keys.txt",
            "defaults.json",
            "prusa-map.json",
        ] {
            copy(&here.join("data").join(file), &out.join(file));
        }
    }
    // The setting keys the engine's own code names (every string that looks like one), for the report of the keys a
    // config sets that the engine does not use: a key the code never names is not read. Test code is left out.
    let src = here.join("src");
    println!("cargo:rerun-if-changed={}", src.display());
    let mut keys = std::collections::BTreeSet::new();
    let mut templates = std::collections::BTreeSet::new();
    scan_keys(&src, &mut keys, &mut templates);
    write(
        &out.join("engine_keys.txt"),
        keys.into_iter().collect::<Vec<_>>().join("\n").as_bytes(),
    );
    // Keys the code builds with `format!`: `filament_{key}` as `filament_*`, `{key}_initial_layer` as `*_initial_layer`.
    write(
        &out.join("engine_key_templates.txt"),
        templates.into_iter().collect::<Vec<_>>().join("\n").as_bytes(),
    );

    // heimdall's heads, racks and docks, generated from the ones Preview draws.
    let shapes = here.join("../ui/viewport/data/head-shapes.json");
    if shapes.exists() {
        copy(&shapes, &out.join("head-shapes.json"));
    } else {
        copy(&here.join("data/head-shapes.json"), &out.join("head-shapes.json"));
    }

    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let secs = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
        });
    let (y, m, d) = civil(secs.div_euclid(86_400));
    println!("cargo:rustc-env=SX_BUILD_DATE={y:04}-{m:02}-{d:02}");
}

/// Collects the quoted words of 3 or more letters, digits and underscores that start lowercase (`required_nozzle_HRC`
/// too) in the `.rs` files under `dir`, up to each file's test module, and the key templates among the `format!`
/// strings (`filament_{key}`, `{key}_initial_layer`).
fn scan_keys(
    dir: &Path,
    keys: &mut std::collections::BTreeSet<String>,
    templates: &mut std::collections::BTreeSet<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            scan_keys(&path, keys, templates);
            continue;
        }
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        // Up to the test module: a `#[cfg(test)]` followed by `mod` (other test-only items stay in, harmlessly).
        let code = text
            .match_indices("#[cfg(test)]")
            .find(|(i, m)| text[i + m.len()..].trim_start().starts_with("mod "))
            .map_or(text.as_str(), |(i, _)| &text[..i]);
        let key_char = |c: char| c.is_ascii_alphanumeric() || c == '_';
        for piece in string_literals(code) {
            let word = piece.len() >= 3
                && piece.starts_with(|c: char| c.is_ascii_lowercase())
                && piece.chars().all(key_char);
            if word {
                keys.insert(piece);
                continue;
            }
            // One placeholder at the start or the end, the rest key characters: `filament_{key}`, `{key}_initial_layer`.
            if let Some(rest) = piece.strip_prefix('{')
                && let Some((inner, tail)) = rest.split_once('}')
                && inner.chars().all(key_char)
                && tail.starts_with('_')
                && tail.len() > 1
                && tail.chars().all(key_char)
            {
                templates.insert(format!("*{tail}"));
            } else if let Some(head) = piece.strip_suffix('}')
                && let Some((lead, inner)) = head.rsplit_once('{')
                && inner.chars().all(key_char)
                && lead.ends_with('_')
                && lead.len() > 1
                && lead.starts_with(|c: char| c.is_ascii_lowercase())
                && lead.chars().all(key_char)
            {
                templates.insert(format!("{lead}*"));
            }
        }
    }
}

/// The contents of the string literals in Rust source, past comments, char literals and lifetimes; raw strings
/// included.
fn string_literals(code: &str) -> Vec<String> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let ch = chars[at];
        let next = chars.get(at + 1).copied();
        if ch == '/' && next == Some('/') {
            while at < chars.len() && chars[at] != '\n' {
                at += 1;
            }
        } else if ch == '/' && next == Some('*') {
            at += 2;
            while at + 1 < chars.len() && !(chars[at] == '*' && chars[at + 1] == '/') {
                at += 1;
            }
            at += 2;
        } else if ch == '\'' {
            // A char literal ('x', '\n', '\'') or a lifetime ('a).
            if next == Some('\\') {
                at += 3;
                while at < chars.len() && chars[at] != '\'' {
                    at += 1;
                }
                at += 1;
            } else if chars.get(at + 2) == Some(&'\'') {
                at += 3;
            } else {
                at += 1;
            }
        } else if ch == 'r'
            && (next == Some('"') || next == Some('#'))
            && (at == 0 || !chars[at - 1].is_alphanumeric() && chars[at - 1] != '_')
        {
            let mut end = at + 1;
            let mut hashes = 0;
            while chars.get(end) == Some(&'#') {
                hashes += 1;
                end += 1;
            }
            if chars.get(end) != Some(&'"') {
                at += 1;
                continue;
            }
            end += 1;
            let start = end;
            while end < chars.len()
                && !(chars[end] == '"' && (0..hashes).all(|h| chars.get(end + 1 + h) == Some(&'#')))
            {
                end += 1;
            }
            out.push(chars[start..end.min(chars.len())].iter().collect());
            at = end + 1 + hashes;
        } else if ch == '"' {
            let mut end = at + 1;
            let mut text = String::new();
            while end < chars.len() && chars[end] != '"' {
                if chars[end] == '\\' {
                    end += 1;
                }
                if let Some(&ch) = chars.get(end) {
                    text.push(ch);
                }
                end += 1;
            }
            out.push(text);
            at = end + 1;
        } else {
            at += 1;
        }
    }
    out
}

fn copy(from: &Path, to: &Path) {
    println!("cargo:rerun-if-changed={}", from.display());
    let bytes = std::fs::read(from).unwrap_or_else(|e| panic!("reading {}: {e}", from.display()));
    write(to, &bytes);
}

fn write(to: &Path, bytes: &[u8]) {
    std::fs::write(to, bytes).unwrap_or_else(|e| panic!("writing {}: {e}", to.display()));
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
