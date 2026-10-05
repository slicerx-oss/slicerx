// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Printer catalog model id to knowledge printer id. The catalog (`packages/connect/catalog`) names
//! models like `bambu-x1-carbon`; settings knowledge and `SetupRef.printer` use `bambu_x1c`. The table is
//! `printer-models.json`. `js/printermodels.ts` does the same.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::knowledge::knowledge;
use crate::plan::SetupRef;

#[derive(Deserialize, Default)]
struct Table {
    #[serde(default)]
    models: BTreeMap<String, String>,
}

fn table() -> &'static Table {
    static T: OnceLock<Table> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("../printer-models.json")).unwrap_or_default())
}

/// The knowledge printer id for a catalog model id, or `None` when settings knowledge has no entry for it.
#[must_use]
pub fn printer_for_model(model_id: &str) -> Option<&'static str> {
    let id = table().models.get(model_id)?;
    knowledge().printers.contains_key(id).then_some(id.as_str())
}

/// Every catalog model id that maps to a knowledge printer, in id order.
#[must_use]
pub fn models_for_printer(printer_id: &str) -> Vec<&'static str> {
    table()
        .models
        .iter()
        .filter(|(_, p)| p.as_str() == printer_id)
        .map(|(m, _)| m.as_str())
        .collect()
}

/// Every catalog model id the table maps, in id order.
#[must_use]
pub fn mapped_models() -> Vec<&'static str> {
    table().models.keys().map(String::as_str).collect()
}

/// A setup for a catalog model and a filament: the knowledge printer, the nozzle (the given one, else the
/// printer's stock nozzle, else 0.4 mm). `None` when the model has no knowledge entry.
#[must_use]
pub fn setup_for_model(model_id: &str, filament: &str, nozzle_diameter: Option<f64>) -> Option<SetupRef> {
    let printer = printer_for_model(model_id)?;
    let nozzle = nozzle_diameter
        .or_else(|| {
            knowledge()
                .printers
                .get(printer)
                .and_then(|p| p.hotend.stock_nozzle.as_ref())
                .and_then(|s| s.diameter)
        })
        .unwrap_or(0.4);
    Some(SetupRef {
        printer: printer.to_owned(),
        nozzle_diameter: nozzle,
        filament: filament.to_owned(),
        process: None,
        hotend: None,
        nozzle_material: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_points_at_a_knowledge_printer() {
        for m in mapped_models() {
            assert!(printer_for_model(m).is_some(), "{m}");
        }
        assert_eq!(printer_for_model("bambu-x1-carbon"), Some("bambu_x1c"));
        assert_eq!(printer_for_model("bambu-x1"), None);
        assert_eq!(models_for_printer("voron_2_4").len(), 3);
    }

    #[test]
    fn a_setup_uses_the_stock_nozzle_unless_told() {
        let s = setup_for_model("prusa-mk4s", "pla", None);
        assert_eq!(s.as_ref().map(|s| s.printer.as_str()), Some("prusa_mk4s"));
        assert_eq!(
            setup_for_model("prusa-mk4s", "pla", Some(0.6)).map(|s| s.nozzle_diameter),
            Some(0.6)
        );
        assert!(setup_for_model("generic-klipper", "pla", None).is_none());
    }
}
