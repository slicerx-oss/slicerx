// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sleipnir, the automatic variable layer height: the window its layer heights may use. The window
//! is a share of the nozzle diameter (at least a quarter, at most three quarters) unless a material's
//! research says otherwise. Each mode has its own band inside that window: Quality 0.2 to 0.5 and
//! Strength 0.3 to 0.5 of the nozzle, intersected with the material's window for the mode, and never
//! above 0.75. `js/smartlayer.ts` does the same.

use crate::knowledge::MaterialKnowledge;

pub const SMART_LAYER_MIN_RATIO: f64 = 0.25;
pub const SMART_LAYER_MAX_RATIO: f64 = 0.75;
/// The share of the nozzle a mode may use, before the material narrows it: `(min, max)`.
#[must_use]
pub fn mode_band(mode: &str) -> Option<(f64, f64)> {
    match mode {
        "quality" => Some((0.2, 0.5)),
        "strength" => Some((0.3, 0.5)),
        _ => None,
    }
}

/// Layer heights move in steps of this many millimeters.
pub const LAYER_STEP: f64 = 0.02;

fn snap(v: f64) -> f64 {
    (v * 1e9 + 0.5).floor() / 1e9
}

/// The share of the nozzle sleipnir may use for a material: the material's safe layer height band
/// (never above 75 percent) when the knowledge base has one, unless sleipnir research says otherwise.
#[derive(Debug, Clone, PartialEq)]
pub struct SmartLayerLimits {
    pub min_ratio: f64,
    pub max_ratio: f64,
    /// The research behind a non default window, when there is one.
    pub note: Option<String>,
    pub src: Vec<String>,
}

/// With a mode, the mode's band is intersected with that window (the material's own window for the mode
/// when its research gives one); when the two do not overlap the material's window wins.
#[must_use]
pub fn smart_layer_limits(material: Option<&MaterialKnowledge>, mode: Option<&str>) -> SmartLayerLimits {
    let r = material.and_then(|m| m.smart_layer.as_ref());
    let band = material.and_then(|m| m.layer_band.as_ref());
    let mw = mode.and_then(|mode| {
        let modes = r?.modes.as_ref()?;
        match mode {
            "quality" => modes.quality.as_ref(),
            "strength" => modes.strength.as_ref(),
            _ => None,
        }
    });
    let mat_min = mw
        .and_then(|w| w.min_ratio)
        .or_else(|| r.and_then(|r| r.min_ratio))
        .or_else(|| band.and_then(|b| b.min));
    let mat_max = mw
        .and_then(|w| w.max_ratio)
        .or_else(|| r.and_then(|r| r.max_ratio))
        .or_else(|| band.and_then(|b| b.max).map(|m| m.min(SMART_LAYER_MAX_RATIO)));
    let mut min_ratio = mat_min.unwrap_or(SMART_LAYER_MIN_RATIO);
    let mut max_ratio = mat_max.unwrap_or(SMART_LAYER_MAX_RATIO);
    // Without material data the mode band stands alone.
    if let Some((bmin, bmax)) = mode.and_then(mode_band) {
        let lo = bmin.max(mat_min.unwrap_or(0.0));
        let hi = bmax
            .min(mat_max.unwrap_or(SMART_LAYER_MAX_RATIO))
            .min(SMART_LAYER_MAX_RATIO);
        if lo <= hi {
            min_ratio = lo;
            max_ratio = hi;
        } else {
            min_ratio = mat_min.unwrap_or(bmin);
            max_ratio = mat_max.unwrap_or(bmax);
        }
    }
    SmartLayerLimits {
        min_ratio,
        max_ratio,
        note: r.and_then(|r| r.note.clone()).filter(|n| !n.is_empty()),
        src: r.map_or_else(
            || band.map(|b| b.src.clone()).unwrap_or_default(),
            |r| r.src.clone(),
        ),
    }
}

/// The thinnest and thickest layer the window allows on a nozzle, on the layer step grid.
#[must_use]
pub fn smart_layer_window(
    nozzle_diameter: f64,
    material: Option<&MaterialKnowledge>,
    mode: Option<&str>,
) -> (f64, f64) {
    let l = smart_layer_limits(material, mode);
    (
        snap((snap(l.min_ratio * nozzle_diameter / LAYER_STEP) - 1e-9).ceil() * LAYER_STEP),
        snap((snap(l.max_ratio * nozzle_diameter / LAYER_STEP) + 1e-9).floor() * LAYER_STEP),
    )
}

/// Bounds for a nozzle. With `layer_height` (what the Detail slider gives) the bounds sit around it, at
/// about half to one and a half times, inside the window; without it they are the whole window. The
/// thickest layer is always at least one step above the thinnest.
#[must_use]
pub fn smart_layer_bounds(
    nozzle_diameter: f64,
    layer_height: Option<f64>,
    material: Option<&MaterialKnowledge>,
    mode: Option<&str>,
) -> (f64, f64) {
    let (wmin, wmax) = smart_layer_window(nozzle_diameter, material, mode);
    let step = |v: f64| snap((v / LAYER_STEP + 0.5).floor() * LAYER_STEP);
    let min = layer_height.map_or(wmin, |lh| wmin.max(step(0.5 * lh)));
    let max = layer_height
        .map_or(wmax, |lh| wmax.min(step(1.5 * lh)))
        .max(snap(min + LAYER_STEP));
    (snap(min), snap(max))
}

/// True for the sleipnir modes that change layer heights.
#[must_use]
pub fn is_smart_layer_on(mode: &str) -> bool {
    mode == "quality" || mode == "strength"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::{MaterialKnowledge, SmartLayerResearch};

    #[test]
    fn window_follows_the_nozzle() {
        assert_eq!(smart_layer_window(0.4, None, None), (0.1, 0.3));
        assert_eq!(smart_layer_window(0.6, None, None), (0.16, 0.44));
        assert_eq!(smart_layer_window(0.2, None, None), (0.06, 0.14));
    }

    #[test]
    fn material_research_moves_the_window() {
        let m = MaterialKnowledge {
            smart_layer: Some(SmartLayerResearch {
                min_ratio: Some(0.2),
                max_ratio: Some(0.6),
                modes: None,
                note: Some("silk shows steps".into()),
                src: vec!["x".into()],
            }),
            ..MaterialKnowledge::default()
        };
        assert_eq!(smart_layer_window(0.4, Some(&m), None), (0.08, 0.24));
        let l = smart_layer_limits(Some(&m), None);
        assert_eq!(
            (l.min_ratio, l.max_ratio, l.note.as_deref()),
            (0.2, 0.6, Some("silk shows steps"))
        );
    }

    #[test]
    fn bounds_sit_around_the_layer_height() {
        assert_eq!(smart_layer_bounds(0.4, None, None, None), (0.1, 0.3));
        assert_eq!(smart_layer_bounds(0.4, Some(0.12), None, None), (0.1, 0.18));
        assert_eq!(smart_layer_bounds(0.4, Some(0.2), None, None), (0.1, 0.3));
        assert_eq!(smart_layer_bounds(0.4, Some(0.08), None, None), (0.1, 0.12));
        assert_eq!(smart_layer_bounds(0.4, Some(0.28), None, None), (0.14, 0.3));
    }

    #[test]
    fn modes_have_their_own_bands() {
        assert_eq!(smart_layer_window(0.4, None, Some("quality")), (0.08, 0.2));
        assert_eq!(smart_layer_window(0.4, None, Some("strength")), (0.12, 0.2));
        assert_eq!(smart_layer_window(0.6, None, Some("quality")), (0.12, 0.3));
        assert_eq!(
            smart_layer_bounds(0.4, Some(0.12), None, Some("quality")),
            (0.08, 0.18)
        );
        assert_eq!(
            smart_layer_bounds(0.4, Some(0.28), None, Some("strength")),
            (0.14, 0.2)
        );
    }

    #[test]
    fn the_material_narrows_a_mode_band() {
        let m = MaterialKnowledge {
            smart_layer: Some(SmartLayerResearch {
                min_ratio: Some(0.4),
                max_ratio: Some(0.7),
                ..SmartLayerResearch::default()
            }),
            ..MaterialKnowledge::default()
        };
        let l = smart_layer_limits(Some(&m), Some("quality"));
        assert_eq!((l.min_ratio, l.max_ratio), (0.4, 0.5));
        let far = MaterialKnowledge {
            smart_layer: Some(SmartLayerResearch {
                min_ratio: Some(0.6),
                max_ratio: Some(0.7),
                ..SmartLayerResearch::default()
            }),
            ..MaterialKnowledge::default()
        };
        let l = smart_layer_limits(Some(&far), Some("strength"));
        assert_eq!((l.min_ratio, l.max_ratio), (0.6, 0.7));
    }
}
