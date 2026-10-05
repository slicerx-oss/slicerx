// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Slow down by height. Bambu Studio's version (`enable_height_slowdown`, `slowdown_start_height`,
//! `slowdown_start_speed`, `slowdown_end_height`, `slowdown_end_speed`; `GCode::slowDownByHeight`): from the
//! start height the speed cap of walls, infill, bridges and gap fill falls linearly from the start speed
//! to the end speed at the end height and stays at the end speed above it (the defaults, 1000 mm/s, cap
//! nothing). The acceleration caps (`slowdown_*_acc`) and the travel cap are not applied.
//!
//! The older throttling of this engine (`tall_print_speed_start`, `tall_print_speed_end`,
//! `tall_print_speed_percent`: a share of each path's speed) still works when the Bambu setting is off.

use crate::config::PrintConfig;
use crate::output::{Feature, LayerPaths};

/// The share of its speed a path keeps at `z`, or 1 when the throttling is off.
pub(crate) fn factor(cfg: &PrintConfig, z: f64) -> f64 {
    let start = cfg.raw_number("tall_print_speed_start", 0.0);
    let end = cfg.raw_number("tall_print_speed_end", 0.0);
    let floor = (cfg.raw_number("tall_print_speed_percent", 100.0) / 100.0).clamp(0.05, 1.0);
    if start <= 0.0 || end <= start || floor >= 1.0 || z <= start {
        return 1.0;
    }
    let t = ((z - start) / (end - start)).clamp(0.0, 1.0);
    1.0 + (floor - 1.0) * t
}

/// Bambu's speed cap at layer height `z`, mm/s, or None when the slowdown is off or not yet reached.
pub(crate) fn cap(cfg: &PrintConfig, z: f64) -> Option<f64> {
    if !crate::tower::flag(cfg, "enable_height_slowdown") {
        return None;
    }
    let h1 = cfg.raw_number("slowdown_start_height", 0.0);
    let h2 = cfg.raw_number("slowdown_end_height", 400.0);
    let s1 = cfg.raw_number("slowdown_start_speed", 1000.0);
    let s2 = cfg.raw_number("slowdown_end_speed", 1000.0);
    if h1 >= h2 || z < h1 {
        return None;
    }
    Some(if z > h2 {
        s2
    } else {
        (z - h1) / (h2 - h1) * (s2 - s1) + s1
    })
}

/// Slows the extrusions of a planned layer to what its height allows.
pub(crate) fn apply(out: &mut LayerPaths, cfg: &PrintConfig) {
    if let Some(cap) = cap(cfg, f64::from(out.z)) {
        #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
        for p in &mut out.paths {
            if !matches!(
                p.feature,
                Feature::OuterWall
                    | Feature::InnerWall
                    | Feature::OverhangWall
                    | Feature::TopSurface
                    | Feature::BottomSurface
                    | Feature::InternalSolid
                    | Feature::SparseInfill
                    | Feature::Bridge
                    | Feature::InternalBridge
                    | Feature::Ironing
                    | Feature::GapFill
            ) {
                continue;
            }
            p.speed_mm_s = p.speed_mm_s.min(cap as f32);
        }
        return;
    }
    if out.index == 0 {
        return;
    }
    let f = factor(cfg, f64::from(out.z));
    if f >= 1.0 {
        return;
    }
    #[allow(clippy::cast_possible_truncation, reason = "speeds are small")]
    for p in &mut out.paths {
        if matches!(p.feature, Feature::PrimeTower | Feature::Custom) {
            continue;
        }
        p.speed_mm_s = (f64::from(p.speed_mm_s) * f) as f32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(start: f64, end: f64, pct: f64) -> PrintConfig {
        let mut c = PrintConfig::default();
        c.raw
            .insert("tall_print_speed_start".into(), serde_json::json!(start));
        c.raw
            .insert("tall_print_speed_end".into(), serde_json::json!(end));
        c.raw
            .insert("tall_print_speed_percent".into(), serde_json::json!(pct));
        c
    }

    #[test]
    fn bambus_cap_falls_between_the_heights_and_holds_the_end_speed_above() {
        let mut c = PrintConfig::default();
        for (k, v) in [
            ("enable_height_slowdown", serde_json::json!(true)),
            ("slowdown_start_height", serde_json::json!(50.0)),
            ("slowdown_end_height", serde_json::json!(150.0)),
            ("slowdown_start_speed", serde_json::json!(200.0)),
            ("slowdown_end_speed", serde_json::json!(60.0)),
        ] {
            c.raw.insert(k.into(), v);
        }
        assert_eq!(cap(&c, 20.0), None);
        assert!((cap(&c, 100.0).unwrap() - 130.0).abs() < 1e-9);
        assert!((cap(&c, 300.0).unwrap() - 60.0).abs() < 1e-9);
        // Start at or past the end means off.
        c.raw
            .insert("slowdown_start_height".into(), serde_json::json!(200.0));
        assert_eq!(cap(&c, 300.0), None);
    }

    #[test]
    fn the_speed_falls_linearly_between_the_heights_and_holds_above() {
        let c = cfg(50.0, 150.0, 60.0);
        assert!((factor(&c, 20.0) - 1.0).abs() < 1e-9);
        assert!((factor(&c, 50.0) - 1.0).abs() < 1e-9);
        assert!((factor(&c, 100.0) - 0.8).abs() < 1e-9);
        assert!((factor(&c, 150.0) - 0.6).abs() < 1e-9);
        assert!((factor(&c, 300.0) - 0.6).abs() < 1e-9);
        assert!((factor(&cfg(0.0, 100.0, 50.0), 80.0) - 1.0).abs() < 1e-9);
    }
}
