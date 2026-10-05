// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Where a layer's timelapse and wrapping detection G-code go (Orca's `GCode::process_layer`:
//! `insert_timelapse_gcode` and `insert_wrapping_detection_gcode`).
//!
//! - Other printers: `time_lapse_gcode` right after the layer change, before `layer_change_gcode`.
//! - Bambu Lab printers: at the start of the layer, except the "traditional" timelapse of a bed slinger
//!   (`printer_structure` i3, not in spiral mode) and of a printer with two nozzles, which waits for a
//!   moment the head can leave: before the prime tower, else on a bed slinger once the first island with
//!   infill has its walls, else at the end of the layer.
//! - `wrapping_detection_gcode` (with `enable_wrapping_detection`): before the layer's first filament,
//!   which is before the prime tower when the layer has one.
//!
//! Orca also renders the timelapse G-code of other bed slingers a second time in the traditional spot;
//! that copy is left out.

use crate::config::{GcodeFlavor, PrintConfig};
use crate::output::{Feature, LayerPaths};

/// Where in a layer a block goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Spot {
    /// Between the layer change retraction and `layer_change_gcode`.
    LayerChange,
    /// Before the layer's first path.
    Start,
    /// Before path `i` of the layer.
    Before(usize),
    /// After the layer's last path.
    End,
}

fn has_text(cfg: &PrintConfig, key: &str) -> bool {
    crate::customgcode::text(cfg, key).is_some_and(|t| !t.trim().is_empty())
}

fn infill(f: Feature) -> bool {
    matches!(
        f,
        Feature::SparseInfill
            | Feature::InternalSolid
            | Feature::TopSurface
            | Feature::BottomSurface
            | Feature::Bridge
            | Feature::InternalBridge
            | Feature::Ironing
    )
}

fn first_tower(l: &LayerPaths) -> Option<usize> {
    l.paths.iter().position(|p| p.feature == Feature::PrimeTower)
}

/// Where the timelapse block of layer `l` goes, or None when there is none. On a Bambu Lab printer the block
/// exists even without `time_lapse_gcode`: it carries the layer's object mask.
pub(crate) fn timelapse_spot(
    cfg: &PrintConfig,
    flavor: GcodeFlavor,
    l: &LayerPaths,
    tower: bool,
) -> Option<Spot> {
    if !crate::firmware::bambu_printer(cfg, flavor) {
        return has_text(cfg, "time_lapse_gcode").then_some(Spot::LayerChange);
    }
    let i3 = cfg.raw.get("printer_structure").and_then(|v| v.as_str()) == Some("i3");
    let two_nozzles =
        matches!(cfg.raw.get("nozzle_diameter"), Some(serde_json::Value::Array(a)) if a.len() > 1);
    // A smooth timelapse (type 1) shoots at the prime tower, which Orca's tower writer handles.
    let tower_shot = tower && (cfg.raw_number("timelapse_type", 0.0) - 1.0).abs() < 0.5;
    let traditional = !tower_shot && ((i3 && !crate::firmware::truthy(cfg, "spiral_mode")) || two_nozzles);
    if !traditional {
        return Some(Spot::Start);
    }
    Some(match first_tower(l) {
        Some(i) => Spot::Before(i),
        None if i3 => l
            .paths
            .iter()
            .position(|p| infill(p.feature))
            .map_or(Spot::End, Spot::Before),
        None => Spot::End,
    })
}

/// Where the wrapping detection block of layer `l` goes, or None when the profile has none.
pub(crate) fn wrapping_spot(cfg: &PrintConfig, l: &LayerPaths) -> Option<Spot> {
    if !crate::firmware::truthy(cfg, "enable_wrapping_detection")
        || !has_text(cfg, "wrapping_detection_gcode")
    {
        return None;
    }
    Some(first_tower(l).map_or(Spot::Start, Spot::Before))
}

/// True when custom G-code moves the nozzle up or down, so the layer height has to be set again after it.
pub(crate) fn moves_z(text: &str) -> bool {
    text.lines().any(|line| {
        let code = line.split(';').next().unwrap_or("").trim();
        let mut words = code.split_ascii_whitespace();
        match words.next() {
            Some("G0" | "G1" | "G2" | "G3") => words.any(|w| w.starts_with('Z') || w.starts_with('z')),
            Some("G28") => true,
            _ => false,
        }
    })
}

/// True when custom G-code moves the head at all, so the next travel cannot start from where it was.
pub(crate) fn moves_head(text: &str) -> bool {
    text.lines().any(|line| {
        let code = line.split(';').next().unwrap_or("").trim();
        matches!(
            code.split_ascii_whitespace().next(),
            Some("G0" | "G1" | "G2" | "G3" | "G28")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::PathInfo;
    use serde_json::json;

    fn layer(features: &[Feature]) -> LayerPaths {
        LayerPaths {
            paths: features
                .iter()
                .map(|&feature| PathInfo {
                    start: 0,
                    end: 0,
                    tool: 1,
                    feature,
                    speed_mm_s: 50.0,
                    width_mm: 0.4,
                    flow: 1.0,
                    dz: 0.0,
                    overhang_fan: false,
                })
                .collect(),
            ..LayerPaths::default()
        }
    }

    fn cfg(pairs: &[(&str, serde_json::Value)]) -> PrintConfig {
        let mut c = PrintConfig::default();
        for (k, v) in pairs {
            c.raw.insert((*k).to_owned(), v.clone());
        }
        c
    }

    #[test]
    fn spots_follow_the_printer() {
        let l = layer(&[
            Feature::OuterWall,
            Feature::InnerWall,
            Feature::SparseInfill,
            Feature::OuterWall,
        ]);

        // Other printers: at the layer change, and only with a template.
        assert_eq!(
            timelapse_spot(&PrintConfig::default(), GcodeFlavor::Marlin2, &l, false),
            None
        );
        let other = cfg(&[("time_lapse_gcode", json!("M240"))]);
        assert_eq!(
            timelapse_spot(&other, GcodeFlavor::Marlin2, &l, false),
            Some(Spot::LayerChange)
        );
        // A Bambu Lab CoreXY printer: the start of the layer, template or not.
        let x1 = cfg(&[("printer_model", json!("Bambu Lab X1 Carbon"))]);
        assert_eq!(
            timelapse_spot(&x1, GcodeFlavor::Marlin, &l, false),
            Some(Spot::Start)
        );
        // A bed slinger: after the walls of the first island with infill, at the end without infill,
        // before the prime tower when the layer has one; in spiral mode at the start.
        let a1 = cfg(&[
            ("printer_model", json!("Bambu Lab A1")),
            ("printer_structure", json!("i3")),
        ]);
        assert_eq!(
            timelapse_spot(&a1, GcodeFlavor::Marlin, &l, false),
            Some(Spot::Before(2))
        );
        assert_eq!(
            timelapse_spot(&a1, GcodeFlavor::Marlin, &layer(&[Feature::OuterWall]), false),
            Some(Spot::End)
        );
        let towered = layer(&[Feature::OuterWall, Feature::PrimeTower, Feature::SparseInfill]);
        assert_eq!(
            timelapse_spot(&a1, GcodeFlavor::Marlin, &towered, true),
            Some(Spot::Before(1))
        );
        let vase = cfg(&[
            ("printer_model", json!("Bambu Lab A1")),
            ("printer_structure", json!("i3")),
            ("spiral_mode", json!(true)),
        ]);
        assert_eq!(
            timelapse_spot(&vase, GcodeFlavor::Marlin, &l, false),
            Some(Spot::Start)
        );
        // Wrapping detection: before the first filament.
        let wrap = cfg(&[
            ("enable_wrapping_detection", json!(true)),
            ("wrapping_detection_gcode", json!("G39.4")),
        ]);
        assert_eq!(wrapping_spot(&wrap, &l), Some(Spot::Start));
        assert_eq!(wrapping_spot(&wrap, &towered), Some(Spot::Before(1)));
        assert_eq!(
            wrapping_spot(&cfg(&[("wrapping_detection_gcode", json!("G39.4"))]), &l),
            None
        );
    }

    #[test]
    fn z_moves_are_found() {
        assert!(moves_z("M400\nG1 Z{max_layer_z + 0.4}\n"));
        assert!(moves_z("G2 Z0.6 I0.86 J0.86 P1 F20000"));
        assert!(!moves_z(
            "G1 X65 Y245 F20000 ; move to Z safe pos\nM971 S11 C10 O0"
        ));
    }
}
