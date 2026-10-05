// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Replaces "automatic" values (0 on keys flagged `auto` in the schema) with concrete ones, so an
//! engine that does not know the convention can slice the config. `js/auto.ts` does the same.

use crate::config::number_of;
use crate::schema::settings;
use crate::value::{PrintConfig, Value, parse_percent_or_number};

/// Line width as a multiple of the nozzle diameter when nothing else says.
#[must_use]
pub fn auto_width_ratio(key: &str) -> Option<f64> {
    Some(match key {
        "line_width" | "outer_wall_line_width" | "inner_wall_line_width" | "top_surface_line_width" => 1.05,
        "initial_layer_line_width" => 1.2,
        "sparse_infill_line_width" | "internal_solid_infill_line_width" => 1.125,
        _ => return None,
    })
}

fn round4(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

fn text(v: f64) -> String {
    if v.fract() == 0.0 {
        #[allow(clippy::cast_possible_truncation)]
        return (v as i64).to_string();
    }
    v.to_string()
}

fn zero_str(s: &str) -> bool {
    parse_percent_or_number(s).is_some_and(|n| n == 0.0)
}

fn is_zero(v: &Value) -> bool {
    match v {
        Value::Int(i) => *i == 0,
        Value::Float(f) => *f == 0.0,
        Value::Str(s) => zero_str(s),
        Value::Ints(x) => !x.is_empty() && x.iter().all(|i| *i == 0),
        Value::Floats(x) => !x.is_empty() && x.iter().all(|f| *f == 0.0),
        Value::Strs(x) => !x.is_empty() && x.iter().all(|s| zero_str(s)),
        _ => false,
    }
}

/// A copy of `config` with every `auto` key that is 0 replaced by a concrete value. Line widths come
/// from the nozzle diameter (1.05x for line width, walls and top surface, 1.2x for the first layer,
/// 1.125x for infill); when the default `line_width` is set, the other automatic widths take it, as
/// Orca does. `filament_ironing_speed` takes the process ironing speed. Keys the config does not
/// have are left alone. The nozzle is `nozzle_diameter` if given, else the config's first nozzle,
/// else 0.4 mm.
#[must_use]
pub fn resolve_auto(config: &PrintConfig, nozzle_diameter: Option<f64>) -> PrintConfig {
    let nozzle = nozzle_diameter
        .or_else(|| number_of(config, "nozzle_diameter", false))
        .unwrap_or(0.4);
    let mut out = config.clone();
    let set_line_width = config.get("line_width").filter(|v| !is_zero(v));
    let mut line_width = round4(nozzle * auto_width_ratio("line_width").unwrap_or(1.05));
    if let Some(v) = set_line_width {
        match v.first_f64() {
            Some(n) if matches!(v, Value::Str(s) if s.ends_with('%')) => {
                line_width = round4(n / 100.0 * nozzle);
            }
            Some(n) => line_width = n,
            None => {}
        }
    }
    let explicit = set_line_width.is_some();
    for def in settings().iter().filter(|d| d.auto) {
        let Some(cur) = config.get(&def.key) else {
            continue;
        };
        if !is_zero(cur) {
            continue;
        }
        let value = if def.key == "filament_ironing_speed" {
            number_of(config, "ironing_speed", false).unwrap_or(20.0)
        } else if def.key == "line_width" || explicit {
            line_width
        } else {
            round4(nozzle * auto_width_ratio(&def.key).unwrap_or(1.05))
        };
        let as_text = matches!(cur, Value::Str(_) | Value::Strs(_));
        let new = match cur {
            Value::Strs(x) => Value::Strs(x.iter().map(|_| text(value)).collect()),
            Value::Floats(x) => Value::Floats(x.iter().map(|_| value).collect()),
            Value::Ints(x) => Value::Floats(x.iter().map(|_| value).collect()),
            _ if as_text => Value::Str(text(value)),
            _ => Value::Float(value),
        };
        out.set(def.key.clone(), new);
    }
    out
}
