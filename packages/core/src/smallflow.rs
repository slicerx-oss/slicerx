// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Small area infill flow compensation (`small_area_infill_flow_compensation`): short solid infill lines
//! extrude less, by a factor read off the profile's model of line length against flow. Follows Orca 2.4.2
//! `GCode/SmallAreaInfillFlowCompensator.cpp` (the model and the roles), `GCode::_needSAFC` (the line
//! patterns it applies to) and `GCode/PchipInterpolatorHelper.cpp` (a monotone cubic through the points).

use crate::config::PrintConfig;
use crate::output::Feature;

/// The compensation of one config: the model and which solid surfaces it applies to.
#[derive(Debug, Clone)]
pub(crate) struct Compensator {
    x: Vec<f64>,
    y: Vec<f64>,
    d: Vec<f64>,
    top: bool,
    internal: bool,
    bottom_first: bool,
}

/// Orca's straight line patterns: the only ones whose lines the model was measured on.
fn line_pattern(cfg: &PrintConfig, key: &str, default: &str) -> bool {
    let name = match cfg.raw.get(key) {
        Some(serde_json::Value::String(s)) => s.as_str(),
        _ => default,
    };
    matches!(
        name,
        "rectilinear" | "alignedrectilinear" | "monotonic" | "monotonicline"
    )
}

/// The model points, "length,factor" per entry. Orca refuses a model whose first length is not 0, whose
/// lengths or factors do not rise, or whose last factor is not 1; here such a model turns the compensation off.
fn model(cfg: &PrintConfig) -> Option<(Vec<f64>, Vec<f64>)> {
    let lines: Vec<String> = match cfg.raw.get("small_area_infill_flow_compensation_model") {
        Some(serde_json::Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
        Some(serde_json::Value::String(s)) => s.split(['\n', ';']).map(str::to_owned).collect(),
        _ => return None,
    };
    let (mut x, mut y) = (Vec::new(), Vec::new());
    for line in &lines {
        let mut parts = line.split(',').map(str::trim);
        let (Some(a), Some(b)) = (parts.next().filter(|s| !s.is_empty()), parts.next()) else {
            continue;
        };
        x.push(a.parse::<f64>().ok()?);
        y.push(b.parse::<f64>().ok()?);
    }
    let rising = |v: &[f64]| v.windows(2).all(|w| matches!(w, [a, b] if b > a));
    let ok = x.len() >= 2
        && x.first().is_some_and(|v| v.abs() < 1e-9)
        && rising(&x)
        && rising(&y)
        && y.last().is_some_and(|v| (v - 1.0).abs() < 1e-9);
    ok.then_some((x, y))
}

impl Compensator {
    /// The compensation the config asks for, or none.
    pub(crate) fn of(cfg: &PrintConfig) -> Option<Self> {
        if !crate::firmware::truthy(cfg, "small_area_infill_flow_compensation") {
            return None;
        }
        let (x, y) = model(cfg)?;
        // Slopes at the points (PCHIP): the end slopes are the end secants, inner ones a weighted harmonic
        // mean of the secants on each side, 0 where the data turns.
        let n = x.len().saturating_sub(1);
        let h: Vec<f64> = x
            .windows(2)
            .map(|w| w.get(1).copied().unwrap_or(0.0) - w.first().copied().unwrap_or(0.0))
            .collect();
        let delta: Vec<f64> = y
            .windows(2)
            .zip(&h)
            .map(|(w, hi)| (w.get(1).copied().unwrap_or(0.0) - w.first().copied().unwrap_or(0.0)) / hi)
            .collect();
        let inner = (1..n).map(
            |i| match (delta.get(i - 1), delta.get(i), h.get(i - 1), h.get(i)) {
                (Some(&dl), Some(&dr), Some(&hl), Some(&hr)) if dl * dr > 0.0 => {
                    let (w1, w2) = (2.0 * hr + hl, hr + 2.0 * hl);
                    (w1 + w2) / (w1 / dl + w2 / dr)
                }
                _ => 0.0,
            },
        );
        let d: Vec<f64> = delta
            .first()
            .copied()
            .into_iter()
            .chain(inner)
            .chain(delta.last().copied())
            .collect();
        Some(Self {
            x,
            y,
            d,
            top: line_pattern(cfg, "top_surface_pattern", "monotonicline"),
            internal: line_pattern(cfg, "internal_solid_infill_pattern", "monotonic"),
            bottom_first: line_pattern(cfg, "bottom_surface_pattern", "monotonic"),
        })
    }

    /// True when lines of `feature` on this layer are compensated.
    pub(crate) fn applies(&self, feature: Feature, first_layer: bool) -> bool {
        match feature {
            Feature::TopSurface => self.top || (first_layer && self.bottom_first),
            Feature::InternalSolid => self.internal || (first_layer && self.bottom_first),
            Feature::BottomSurface => first_layer && self.bottom_first,
            _ => false,
        }
    }

    /// The flow factor for one line `len` mm long: 1 past the model's last length.
    pub(crate) fn factor(&self, len: f64) -> f64 {
        let (Some(&x0), Some(&xn)) = (self.x.first(), self.x.last()) else {
            return 1.0;
        };
        if len <= 0.0 || len > xn {
            return 1.0;
        }
        if len <= x0 {
            return self.y.first().copied().unwrap_or(1.0);
        }
        let i = self.x.partition_point(|&v| v < len).saturating_sub(1);
        let (Some(&xi), Some(&xj), Some(&yi), Some(&yj), Some(&di), Some(&dj)) = (
            self.x.get(i),
            self.x.get(i + 1),
            self.y.get(i),
            self.y.get(i + 1),
            self.d.get(i),
            self.d.get(i + 1),
        ) else {
            return 1.0;
        };
        let h = xj - xi;
        let t = (len - xi) / h;
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * yi
            + (t3 - 2.0 * t2 + t) * h * di
            + (-2.0 * t3 + 3.0 * t2) * yj
            + (t3 - t2) * h * dj
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(v: &serde_json::Value) -> PrintConfig {
        PrintConfig::from_value(v).unwrap()
    }

    #[test]
    fn short_lines_extrude_less_along_the_model() {
        let model = serde_json::json!([
            "0,0",
            "\n0.2,0.4444",
            "\n0.4,0.6145",
            "\n0.6,0.7059",
            "\n0.8,0.7619",
            "\n1.5,0.8571",
            "\n2,0.8889",
            "\n3,0.9231",
            "\n5,0.9520",
            "\n10,1"
        ]);
        assert!(
            Compensator::of(&cfg(
                &serde_json::json!({"small_area_infill_flow_compensation_model": model})
            ))
            .is_none()
        );
        let c = Compensator::of(&cfg(&serde_json::json!({"small_area_infill_flow_compensation": true, "small_area_infill_flow_compensation_model": model}))).unwrap();
        // On the points the curve is the data; between them it rises; past the last length it is 1.
        assert!((c.factor(0.2) - 0.4444).abs() < 1e-9);
        assert!((c.factor(2.0) - 0.8889).abs() < 1e-9);
        assert!(c.factor(0.3) > 0.4444 && c.factor(0.3) < 0.6145);
        assert!((c.factor(12.0) - 1.0).abs() < 1e-12);
        assert!(c.applies(Feature::TopSurface, false) && c.applies(Feature::InternalSolid, false));
        assert!(!c.applies(Feature::BottomSurface, false) && c.applies(Feature::BottomSurface, true));
        assert!(!c.applies(Feature::SparseInfill, true));
        // A model that does not end at 1 is refused.
        let bad = serde_json::json!(["0,0", "1,0.5"]);
        assert!(Compensator::of(&cfg(&serde_json::json!({"small_area_infill_flow_compensation": true, "small_area_infill_flow_compensation_model": bad}))).is_none());
    }
}
