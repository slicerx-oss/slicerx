// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! What the filament units of a Klipper printer hold, from its `printer/objects/query` status: a
//! Happy Hare MMU (`mmu`), a QIDI Box (`save_variables` and `box_stepper slot<N>`, read as
//! OrcaSlicer's QidiPrinterAgent reads them) and the Snapmaker U1's four toolheads
//! (`print_task_config`, read as OrcaSlicer's SnapmakerPrinterAgent reads it).
use std::collections::BTreeMap;

use serde_json::Value;

use crate::types::{FilamentSlot, FilamentUnit};

/// The most QIDI Box slots asked for, as OrcaSlicer asks (`box_stepper slot0` to `slot15`).
pub(crate) const QIDI_SLOTS: usize = 16;

/// `#rrggbb` from a color the printer sends as `RRGGBB`, `RRGGBBAA` or `#0RRGGBB`.
pub(crate) fn hex_color(c: &str) -> Option<String> {
    let h = c.trim().trim_start_matches('#');
    // Creality's `#0RRGGBB` has a leading zero before the six digits.
    let h = if h.len() == 7 { h.get(1..)? } else { h };
    let six = h.get(..6)?;
    six.bytes()
        .all(|b| b.is_ascii_hexdigit())
        .then(|| format!("#{}", six.to_ascii_lowercase()))
}

fn slot(id: String, material: Option<String>, color: Option<String>) -> FilamentSlot {
    FilamentSlot {
        id,
        material,
        color,
        ..FilamentSlot::default()
    }
}

fn text_at(v: Option<&Value>, i: usize) -> Option<String> {
    v.and_then(Value::as_array)
        .and_then(|a| a.get(i))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("none"))
        .map(str::to_owned)
}

/// The gates of a Happy Hare MMU, numbered from 1.
pub(crate) fn mmu_unit(mmu: &Value) -> Option<FilamentUnit> {
    let gates = usize::try_from(mmu.get("num_gates").and_then(Value::as_u64)?).ok()?;
    let slots: Vec<FilamentSlot> = (0..gates)
        .map(|g| {
            slot(
                format!("{}", g + 1),
                text_at(mmu.get("gate_material"), g),
                text_at(mmu.get("gate_color"), g).and_then(|c| hex_color(&c)),
            )
        })
        .collect();
    (!slots.is_empty()).then(|| FilamentUnit {
        id: "mmu".to_owned(),
        kind: "mmu".to_owned(),
        tool: None,
        slots,
    })
}

/// The color and filament names of a QIDI printer's `officiall_filas_list.cfg`: `[colordict]` lines
/// `index = color` and `[filaN]` sections with a `filament = name` line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct QidiDict {
    pub colors: BTreeMap<i64, String>,
    pub filaments: BTreeMap<i64, String>,
}

pub(crate) fn parse_qidi_dict(text: &str) -> QidiDict {
    let mut d = QidiDict::default();
    let mut section = String::new();
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            line.trim_matches(['[', ']']).clone_into(&mut section);
            continue;
        }
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim().to_owned());
        if section == "colordict" {
            if let Ok(i) = k.parse() {
                d.colors.insert(i, v);
            }
        } else if let Some(n) = section.strip_prefix("fila").and_then(|n| n.parse::<i64>().ok())
            && n > 0
            && k == "filament"
        {
            d.filaments.insert(n, v);
        }
    }
    d
}

/// QIDI Box slots: `box_count` boxes of four from `save_variables`, a slot loaded when its
/// `box_stepper slot<N>` runout button reads 0, its material and color by index from the dictionary.
/// Ids run A1 to A4 for the first box, B1 for the next.
pub(crate) fn qidi_units(status: &Value, dict: &QidiDict) -> Vec<FilamentUnit> {
    let Some(vars) = status.get("save_variables").and_then(|s| s.get("variables")) else {
        return Vec::new();
    };
    let has_box = (0..QIDI_SLOTS).any(|i| status.get(format!("box_stepper slot{i}")).is_some());
    if !has_box {
        return Vec::new();
    }
    let boxes = vars
        .get("box_count")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(0, 4);
    let int = |k: String, default: i64| vars.get(k).and_then(Value::as_i64).unwrap_or(default);
    (0..boxes)
        .filter_map(|b| {
            let letter = char::from(b"ABCD".get(usize::try_from(b).ok()?).copied()?);
            let slots = (0..4)
                .map(|s| {
                    let i = b * 4 + s;
                    let loaded = status
                        .get(format!("box_stepper slot{i}"))
                        .and_then(|x| x.get("runout_button"))
                        .and_then(Value::as_i64)
                        == Some(0);
                    let material = loaded.then(|| {
                        dict.filaments
                            .get(&int(format!("filament_slot{i}"), 1))
                            .cloned()
                            .unwrap_or_else(|| "PLA".to_owned())
                    });
                    let color = loaded
                        .then(|| dict.colors.get(&int(format!("color_slot{i}"), 1)))
                        .flatten()
                        .and_then(|c| hex_color(c));
                    slot(format!("{letter}{}", s + 1), material, color)
                })
                .collect();
            Some(FilamentUnit {
                id: letter.to_string(),
                kind: "qidi-box".to_owned(),
                tool: None,
                slots,
            })
        })
        .collect()
}

/// The Snapmaker U1's toolheads, one spool each, from `print_task_config`: `filament_exist`,
/// `filament_type` with `filament_sub_type`, and `filament_color_rgba` (`RRGGBBAA`). Ids run 1 to 4.
pub(crate) fn u1_unit(status: &Value) -> Option<FilamentUnit> {
    let ptc = status.get("print_task_config")?;
    let exist = ptc.get("filament_exist").and_then(Value::as_array)?;
    let slots: Vec<FilamentSlot> = exist
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let loaded = e.as_bool().unwrap_or(false);
            let material = loaded.then(|| {
                let base = text_at(ptc.get("filament_type"), i).unwrap_or_else(|| "PLA".to_owned());
                match text_at(ptc.get("filament_sub_type"), i) {
                    Some(sub) => combine_type(&base, &sub),
                    None => base.to_ascii_uppercase(),
                }
            });
            let color = loaded
                .then(|| text_at(ptc.get("filament_color_rgba"), i))
                .flatten()
                .and_then(|c| hex_color(&c));
            slot(format!("{}", i + 1), material, color)
        })
        .collect();
    (!slots.is_empty()).then(|| FilamentUnit {
        id: "T".to_owned(),
        kind: "toolchanger".to_owned(),
        tool: None,
        slots,
    })
}

/// A U1 material and its sub type as one name, the way OrcaSlicer's `combine_filament_type` joins
/// them: CF and GF as suffixes, SnapSpeed as high speed, other brand words dropped.
fn combine_type(base: &str, sub: &str) -> String {
    let base = base.trim().to_ascii_uppercase();
    match sub.trim().to_ascii_uppercase().as_str() {
        "CF" => format!("{base}-CF"),
        "GF" => format!("{base}-GF"),
        "SNAPSPEED" | "HS" => format!("{base} HIGH SPEED"),
        s @ ("SILK" | "WOOD" | "MATTE" | "MARBLE") => format!("{base} {s}"),
        _ => base,
    }
}

/// Every filament unit a status names, in the order their slots are listed.
pub(crate) fn units(status: &Value, dict: &QidiDict) -> Vec<FilamentUnit> {
    let mut out: Vec<FilamentUnit> = status.get("mmu").and_then(mmu_unit).into_iter().collect();
    out.extend(qidi_units(status, dict));
    out.extend(u1_unit(status));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn colors_read_in_every_form_printers_send() {
        assert_eq!(hex_color("FF8800FF").as_deref(), Some("#ff8800"));
        assert_eq!(hex_color("#0A1B2C3").as_deref(), Some("#a1b2c3"));
        assert_eq!(hex_color("ff8800").as_deref(), Some("#ff8800"));
        assert_eq!(hex_color("blue"), None);
    }

    #[test]
    fn a_qidi_box_reads_loaded_slots_from_the_dictionary() {
        let dict = parse_qidi_dict(
            "[colordict]\n1 = FFFFFFFF\n2 = FF0000FF\n\n[fila1]\nfilament = PLA Rapido\n[fila3]\nfilament = PETG Tough\n",
        );
        assert_eq!(dict.colors.get(&2).map(String::as_str), Some("FF0000FF"));
        let status = json!({
            "save_variables": { "variables": { "box_count": 1, "filament_slot0": 3, "color_slot0": 2, "filament_slot2": 1 } },
            "box_stepper slot0": { "runout_button": 0 },
            "box_stepper slot1": { "runout_button": 1 },
            "box_stepper slot2": { "runout_button": 0 },
            "box_stepper slot3": { "runout_button": null }
        });
        let u = qidi_units(&status, &dict);
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].kind, "qidi-box");
        let s = &u[0].slots;
        assert_eq!(
            s.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["A1", "A2", "A3", "A4"]
        );
        assert_eq!(
            (s[0].material.as_deref(), s[0].color.as_deref()),
            (Some("PETG Tough"), Some("#ff0000"))
        );
        assert_eq!((s[1].material.as_deref(), s[1].color.as_deref()), (None, None));
        assert_eq!(
            (s[2].material.as_deref(), s[2].color.as_deref()),
            (Some("PLA Rapido"), Some("#ffffff"))
        );
        assert!(qidi_units(&json!({ "save_variables": { "variables": {} } }), &dict).is_empty());
    }

    #[test]
    fn the_u1_reads_its_four_toolheads() {
        let status = json!({ "print_task_config": {
            "filament_exist": [true, false, true, true],
            "filament_type": ["PLA", "", "PETG", "PLA"],
            "filament_sub_type": ["SnapSpeed", "", "NONE", "Polylite"],
            "filament_color_rgba": ["FF0000FF", "", "00FF00FF", "0000FFFF"],
            "filament_vendor": ["Snapmaker", "", "Generic", "Polymaker"]
        }});
        let u = u1_unit(&status).unwrap();
        assert_eq!(u.kind, "toolchanger");
        let got: Vec<(&str, Option<&str>, Option<&str>)> = u
            .slots
            .iter()
            .map(|s| (s.id.as_str(), s.material.as_deref(), s.color.as_deref()))
            .collect();
        assert_eq!(
            got,
            [
                ("1", Some("PLA HIGH SPEED"), Some("#ff0000")),
                ("2", None, None),
                ("3", Some("PETG"), Some("#00ff00")),
                ("4", Some("PLA"), Some("#0000ff")),
            ]
        );
    }

    #[test]
    fn mmu_gates_number_from_one() {
        let u =
            mmu_unit(&json!({ "num_gates": 2, "gate_material": ["PLA", ""], "gate_color": ["ff0000", ""] }))
                .unwrap();
        assert_eq!(u.slots[0].color.as_deref(), Some("#ff0000"));
        assert_eq!(u.slots[1].material, None);
        assert!(mmu_unit(&json!({})).is_none());
    }
}
