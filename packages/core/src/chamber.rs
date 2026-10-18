// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The chamber airflow a printer's start G-code reads as `chamber_cooling_mode`.
//!
//! The Snapmaker U1's Top Cover has two airflow modes and no manual switch: the slicer picks one from the
//! filament and writes it into the G-code (<https://wiki.snapmaker.com/en/snapmaker_u1/top_cover>). Internal
//! circulation keeps the heat in and filters the air, for ABS, ASA, PC, PA, PEBA and PETG. External circulation
//! exhausts it, for PLA, TPU, PVA and PLA support. The U1's own start G-code branches on the value with the
//! comments "keep warm" for 0, "strong cooling" for 2 and "weak cooling" for anything else, so internal
//! circulation is read as 0 and external as 2 from those comments; the page itself names no numbers. Weak
//! cooling (1) is not documented and is the fallback here.
//!
//! A value the settings carry (a project's, a preset's) always wins. Otherwise the mode comes from the
//! `filament_type` of the filaments the plate prints: all internal 0, all external 2. The page says slicing a
//! plate whose filaments need different modes is generally refused, except PETG with PLA, which uses external
//! circulation (the more heat-sensitive filament wins); here PETG with external types only is 2, and any other
//! mix, an unknown type or an empty one is 1 with a warning, so the slice goes ahead.
//!
//! Types match on their base, case-insensitively: the text before the first `-` (`PLA-CF` and `PLA-AERO` are
//! PLA, `PETG-HF` is PETG, `PA-S` is PA), with the numbered and high-temperature nylons (`PA6`, `PA11`, `PA12`,
//! `PAHT`) counted as PA. A `PLA-S` or similar PLA support is PLA by its base. Everything else (`PET`, `PCTG`,
//! `HIPS`, `FLEX` and the rest) is not named by the page and counts as unknown.

use crate::config::PrintConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// The setting the start G-code reads.
pub const KEY: &str = "chamber_cooling_mode";

/// Internal circulation: the chamber keeps its heat ("keep warm").
pub const KEEP_WARM: i64 = 0;
/// The fallback: not documented, the start G-code's "weak cooling".
pub const WEAK_COOLING: i64 = 1;
/// External circulation: the chamber exhausts ("strong cooling").
pub const STRONG_COOLING: i64 = 2;

/// Where a plate's chamber cooling mode came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChamberSource {
    /// The settings sent with the slice set it (a project or a preset; the host knows which).
    Config,
    /// Worked out from the filaments the plate prints.
    Derived,
}

/// The chamber cooling mode a slice uses, for the result's read-back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChamberCooling {
    /// 0 keep warm (internal circulation), 1 weak cooling, 2 strong cooling (external circulation).
    pub mode: i64,
    pub source: ChamberSource,
    /// With `derived`: the `filament_type` of each filament the plate prints, in slot order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub filaments: Vec<String>,
    /// The sentence that says what was picked and why.
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Airflow {
    Internal,
    External,
}

/// The airflow a filament type needs, by its base type; None for a type the vendor names no mode for.
fn airflow(filament_type: &str) -> Option<Airflow> {
    let upper = filament_type.trim().to_ascii_uppercase();
    let base = upper.split('-').next().unwrap_or_default().trim();
    let nylon = base == "PAHT"
        || base
            .strip_prefix("PA")
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()));
    match base {
        "ABS" | "ASA" | "PC" | "PA" | "PEBA" | "PETG" => Some(Airflow::Internal),
        _ if nylon => Some(Airflow::Internal),
        "PLA" | "TPU" | "PVA" => Some(Airflow::External),
        _ => None,
    }
}

/// Whether any of the printer's or filaments' G-code reads `chamber_cooling_mode`.
pub(crate) fn read_by_gcode(cfg: &PrintConfig) -> bool {
    let mentions = |v: &Json| match v {
        Json::String(s) => s.contains(KEY),
        Json::Array(a) => a.iter().any(|x| x.as_str().is_some_and(|s| s.contains(KEY))),
        _ => false,
    };
    cfg.raw.iter().any(|(k, v)| k.ends_with("gcode") && mentions(v))
}

/// The mode the settings set, when they hold a whole number (a lone value or a list's first entry).
fn configured(cfg: &PrintConfig) -> Option<i64> {
    let v = cfg.raw.get(KEY)?;
    let v = v.as_array().and_then(|a| a.first()).unwrap_or(v);
    #[allow(clippy::cast_possible_truncation, reason = "a small mode number")]
    let n = v
        .as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()));
    n
}

/// The `filament_type` of a slot (1-based), empty when the settings name none.
fn type_of(cfg: &PrintConfig, slot: u8) -> String {
    let v = match cfg.raw.get("filament_type") {
        Some(Json::Array(a)) => a.get(usize::from(slot.max(1) - 1)).or_else(|| a.last()),
        v => v,
    };
    v.and_then(Json::as_str).unwrap_or_default().trim().to_owned()
}

/// Names joined for a sentence: `A`, `A and B`, `A, B and C`.
fn joined(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [head @ .., last] => format!("{} and {last}", head.join(", ")),
    }
}

fn unique(v: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in v {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// The plate's chamber cooling mode from the settings and the filament slots it prints (1-based), and the
/// warning to give when the filaments do not agree on one. None when no G-code reads the setting.
pub fn resolve(cfg: &PrintConfig, slots: &[u8]) -> Option<(ChamberCooling, Option<String>)> {
    if !read_by_gcode(cfg) {
        return None;
    }
    if let Some(mode) = configured(cfg) {
        return Some((
            ChamberCooling {
                mode,
                source: ChamberSource::Config,
                filaments: Vec::new(),
                text: format!("chamber cooling mode {mode}, set by the settings"),
            },
            None,
        ));
    }
    let mut slots = slots.to_vec();
    if slots.is_empty() {
        slots.push(1);
    }
    let types: Vec<String> = slots.iter().map(|&s| type_of(cfg, s)).collect();
    let airflows: Vec<Option<Airflow>> = types.iter().map(|t| airflow(t)).collect();
    let named = |want: Airflow| -> Vec<String> {
        unique(
            types
                .iter()
                .zip(&airflows)
                .filter(|(_, a)| **a == Some(want))
                .map(|(t, _)| t.clone()),
        )
    };
    let unknown = unique(
        types
            .iter()
            .zip(&airflows)
            .filter(|(_, a)| a.is_none())
            .map(|(t, _)| {
                if t.is_empty() {
                    "a filament with no type".to_owned()
                } else {
                    t.clone()
                }
            }),
    );
    let (internal, external) = (named(Airflow::Internal), named(Airflow::External));
    let is_petg = |t: &String| t.to_ascii_uppercase().split('-').next() == Some("PETG");
    let (mode, why, warning) = if !unknown.is_empty() {
        (
            WEAK_COOLING,
            "weak cooling".to_owned(),
            Some(format!(
                "The chamber airflow for {} is not known; using weak cooling",
                joined(&unknown)
            )),
        )
    } else if external.is_empty() {
        (KEEP_WARM, "keep warm (internal circulation)".to_owned(), None)
    } else if internal.is_empty() || internal.iter().all(is_petg) {
        (
            STRONG_COOLING,
            "strong cooling (external circulation)".to_owned(),
            None,
        )
    } else {
        (
            WEAK_COOLING,
            "weak cooling".to_owned(),
            Some(format!(
                "{} need different chamber airflow; using weak cooling",
                joined(&[internal, external].concat())
            )),
        )
    };
    let shown: Vec<String> = unique(types.iter().map(|t| {
        if t.is_empty() {
            "no type".to_owned()
        } else {
            t.clone()
        }
    }));
    Some((
        ChamberCooling {
            mode,
            source: ChamberSource::Derived,
            text: format!(
                "chamber cooling mode {mode}, {why}, from the filaments: {}",
                joined(&shown)
            ),
            filaments: types,
        },
        warning,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(
        clippy::needless_pass_by_value,
        reason = "configs are built with json! at each call"
    )]
    fn cfg(types: &[&str], extra: Json) -> PrintConfig {
        let mut v = serde_json::json!({
            "machine_start_gcode": "{if chamber_cooling_mode==0}WARM{elsif chamber_cooling_mode==2}STRONG{else}WEAK{endif}",
            "filament_type": types,
        });
        if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            m.extend(e.clone());
        }
        PrintConfig::from_value(&v).unwrap()
    }

    fn mode(types: &[&str], slots: &[u8]) -> (i64, ChamberSource, Option<String>) {
        let (c, w) = resolve(&cfg(types, Json::Null), slots).unwrap();
        (c.mode, c.source, w)
    }

    #[test]
    fn a_value_in_the_settings_wins() {
        for v in [
            serde_json::json!(0),
            serde_json::json!("0"),
            serde_json::json!(["0"]),
        ] {
            let c = cfg(&["PLA"], serde_json::json!({ KEY: v }));
            let (r, w) = resolve(&c, &[1]).unwrap();
            assert_eq!((r.mode, r.source, w), (0, ChamberSource::Config, None));
        }
    }

    #[test]
    fn the_filaments_pick_the_mode() {
        assert_eq!(
            mode(&["PLA", "PLA", "PLA"], &[1, 2, 3]),
            (2, ChamberSource::Derived, None)
        );
        assert_eq!(mode(&["ABS"], &[1]), (0, ChamberSource::Derived, None));
        assert_eq!(
            mode(&["ABS", "asa", "PC"], &[1, 2, 3]),
            (0, ChamberSource::Derived, None)
        );
        assert_eq!(mode(&["PETG", "PLA"], &[1, 2]), (2, ChamberSource::Derived, None));
        assert_eq!(
            mode(&["PETG-HF", "TPU", "PVA"], &[1, 2, 3]),
            (2, ChamberSource::Derived, None)
        );
        assert_eq!(mode(&["PETG"], &[1]), (0, ChamberSource::Derived, None));
    }

    #[test]
    fn variants_follow_their_base_type() {
        assert_eq!(airflow("pla-cf"), Some(Airflow::External));
        assert_eq!(airflow("PLA-AERO"), Some(Airflow::External));
        assert_eq!(airflow("TPU-AMS"), Some(Airflow::External));
        assert_eq!(airflow("PETG-HF"), Some(Airflow::Internal));
        assert_eq!(airflow("PA-S"), Some(Airflow::Internal));
        for nylon in ["PA6", "PA6-CF", "PA11-CF", "PA12-CF", "PAHT-CF"] {
            assert_eq!(airflow(nylon), Some(Airflow::Internal), "{nylon}");
        }
        for unknown in ["PET", "PCTG", "HIPS", "FLEX", "PAX", "UltraPA", ""] {
            assert_eq!(airflow(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn only_the_slots_that_print_count() {
        // ABS is loaded in slot 2, but only slot 1 prints.
        assert_eq!(mode(&["PLA", "ABS"], &[1]), (2, ChamberSource::Derived, None));
    }

    #[test]
    fn a_conflict_or_an_unknown_type_falls_back_with_a_warning() {
        let (m, s, w) = mode(&["ABS", "PLA"], &[1, 2]);
        assert_eq!((m, s), (1, ChamberSource::Derived));
        assert_eq!(
            w.as_deref(),
            Some("ABS and PLA need different chamber airflow; using weak cooling")
        );
        let (m, _, w) = mode(&["PETG", "ABS", "PLA"], &[1, 2, 3]);
        assert_eq!(m, 1);
        assert_eq!(
            w.as_deref(),
            Some("PETG, ABS and PLA need different chamber airflow; using weak cooling")
        );
        let (m, _, w) = mode(&["PLA", "FLEX"], &[1, 2]);
        assert_eq!(m, 1);
        assert_eq!(
            w.as_deref(),
            Some("The chamber airflow for FLEX is not known; using weak cooling")
        );
        let (m, _, w) = mode(&[""], &[1]);
        assert_eq!(m, 1);
        assert_eq!(
            w.as_deref(),
            Some("The chamber airflow for a filament with no type is not known; using weak cooling")
        );
    }

    #[test]
    fn nothing_is_worked_out_when_no_gcode_reads_it() {
        let c = PrintConfig::from_value(&serde_json::json!({"filament_type": ["ABS", "PLA"]})).unwrap();
        assert!(resolve(&c, &[1, 2]).is_none());
    }
}
