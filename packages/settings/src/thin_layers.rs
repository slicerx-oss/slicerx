// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Thin layers and the cooling slowdown: the minimum layer time a material needs when sleipnir prints
//! thin layers, and the heat creep warning for layers slowed to a trickle. `js/thinlayers.ts` does the same.

use crate::knowledge::{CoolingGuard, MaterialKnowledge};

/// Heat creep warning threshold: a slowed layer that extrudes less than this share of the filament's
/// maximum volumetric speed. No maker publishes a threshold. 3.5 percent sits between the 0.32 to 0.64
/// mm3/s the research calls low (a 0.08 mm layer at the 10 to 20 mm/s minimum speed, 1.5 to 3 percent of
/// a 21 mm3/s limit) and the 0.84 mm3/s of an ordinary 0.2 mm layer at 10 mm/s (4 percent).
pub const HEAT_CREEP_SHARE: f64 = 0.035;

fn r2(n: f64) -> f64 {
    (n * 100.0 + 0.5).floor() / 100.0
}

fn r1(n: f64) -> f64 {
    (n * 10.0 + 0.5).floor() / 10.0
}

/// A number as JavaScript prints it: whole numbers without a fraction.
fn show(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        #[allow(clippy::cast_possible_truncation)]
        return (v as i64).to_string();
    }
    v.to_string()
}

/// The warning text when a slowed thin layer extrudes only a sliver of the filament's limit. `min_speed`
/// is the slowest speed the cooling slowdown may reach (mm/s), `width` the extrusion width (mm),
/// `thinnest` the thinnest layer that will print (mm) and `max_flow` the filament's maximum volumetric
/// speed (mm3/s).
#[must_use]
pub fn heat_creep_warning(min_speed: f64, width: f64, thinnest: f64, max_flow: f64) -> Option<String> {
    if min_speed.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
        || width.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
        || thinnest.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
        || max_flow.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
    {
        return None;
    }
    let flow = min_speed * width * thinnest;
    if flow >= max_flow * HEAT_CREEP_SHARE {
        return None;
    }
    Some(format!(
        "Layers of {} mm slowed to {} mm/s extrude only {} mm3/s, {} percent of the {} mm3/s filament limit. The filament can soften above the melt zone and clog (heat creep). Open the printer door or raise the minimum print speed. This is an expert rule, not a published limit.",
        show(thinnest),
        show(min_speed),
        show(r2(flow)),
        show(r1(flow / max_flow * 100.0)),
        show(max_flow)
    ))
}

/// The minimum layer time thin layers need for a material, when the research has one.
#[must_use]
pub fn layer_time_guard(material: Option<&MaterialKnowledge>) -> Option<&CoolingGuard> {
    material.and_then(|m| m.cooling_guard.as_ref())
}
