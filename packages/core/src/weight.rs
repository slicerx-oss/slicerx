// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Layer G-code that reads how much filament has been used so far (`extruded_weight_total`,
//! `extruded_weight`, `extruded_volume_total`, `extruded_volume`): Prusa's `M74 W` and the
//! weight-based acceleration table of the MK4 profiles. A layer is written on its own (shards), so it
//! cannot know the layers before it. Such a layer writes one `;@D` line holding the templates and the
//! variables they see; [`crate::firmware::finalize_with_config`], which reads the whole file and the
//! extrusion of every layer, renders them with the totals and puts the result in place of the line.

use crate::config::PrintConfig;
use crate::template::{self, Context, Value};
use serde_json::{Map, Value as Json, json};

/// Line prefix of a deferred layer.
pub(crate) const MARKER: &[u8] = b";@D ";

/// True when a template reads the filament used so far.
pub(crate) fn wanted(text: &str) -> bool {
    text.contains("extruded_weight") || text.contains("extruded_volume")
}

fn to_json(v: &Value) -> Json {
    match v {
        Value::Num(n) => json!(n),
        Value::Int(i) => json!(i),
        Value::Str(s) => json!(s),
        Value::Bool(b) => json!(b),
        Value::List(l) => Json::Array(l.iter().map(to_json).collect()),
        Value::Nil => Json::Null,
    }
}

fn from_json(v: &Json) -> Value {
    match v {
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => n
            .as_i64()
            .map_or_else(|| Value::Num(n.as_f64().unwrap_or(0.0)), Value::Int),
        Json::String(s) => Value::Str(s.clone()),
        Json::Array(a) => Value::List(a.iter().map(from_json).collect()),
        _ => Value::Nil,
    }
}

/// The `;@D` line for a layer: the two templates and the variables of the layer, on one line.
pub(crate) fn marker(ctx: &Context<'_>, before: &str, after: &str) -> String {
    let vars: Map<String, Json> = ctx.vars.iter().map(|(k, v)| (k.clone(), to_json(v))).collect();
    let doc = json!({"b": before, "a": after, "v": vars, "x": ctx.extruder});
    format!(";@D {doc}\n")
}

/// Filament used before a layer: per extruder, weight in grams and volume in mm3.
pub(crate) struct Used {
    pub weight: Vec<f64>,
    pub volume: Vec<f64>,
}

/// Renders a deferred layer (the text of a `;@D` line after its prefix) with `used`. Text that does
/// not render is dropped, since a layer cannot fail a finished file.
pub(crate) fn render(doc: &str, used: &Used, cfg: Option<&PrintConfig>) -> String {
    let Ok(Json::Object(doc)) = serde_json::from_str::<Json>(doc) else {
        return String::new();
    };
    let mut ctx = Context {
        config: cfg.map(|c| &c.raw),
        extruder: doc
            .get("x")
            .and_then(Json::as_u64)
            .and_then(|x| usize::try_from(x).ok())
            .unwrap_or(0),
        ..Context::default()
    };
    if let Some(Json::Object(vars)) = doc.get("v") {
        for (k, v) in vars {
            ctx.vars.insert(k.clone(), from_json(v));
        }
    }
    let list = |v: &[f64]| Value::List(v.iter().map(|&n| Value::Num(n)).collect());
    ctx.vars.insert("extruded_weight".to_owned(), list(&used.weight));
    ctx.vars.insert(
        "extruded_weight_total".to_owned(),
        Value::Num(used.weight.iter().sum()),
    );
    ctx.vars.insert("extruded_volume".to_owned(), list(&used.volume));
    ctx.vars.insert(
        "extruded_volume_total".to_owned(),
        Value::Num(used.volume.iter().sum()),
    );
    let mut out = String::new();
    for key in ["b", "a"] {
        let Some(text) = doc.get(key).and_then(Json::as_str) else {
            continue;
        };
        if let Ok(t) = template::render(text, &ctx) {
            out.push_str(&t);
            if !t.is_empty() && !t.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}
