// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `format.read3mf` for the json api: the project as json, each part's positions and triangles as output buffers

use super::threemf::{Paint, PartKind, read_3mf};
use crate::error::{Error, Result};
use crate::json::{FileLoader, OutFile, base64_decode, push_out_file};
use serde_json::{Value, json};

fn pairs(list: &[(String, String)]) -> Value {
    Value::Array(list.iter().map(|(k, v)| json!([k, v])).collect())
}

/// the paint codes as one output buffer: for each layer (color, seam, support, fuzzy) a count, then per painted
/// triangle its number, the code's length and the code; `null` when nothing is painted
fn paint(p: &Paint) -> Value {
    if p.is_empty() {
        return Value::Null;
    }
    let mut out = Vec::new();
    let u32le = |out: &mut Vec<u8>, n: usize| {
        out.extend_from_slice(&u32::try_from(n).unwrap_or(u32::MAX).to_le_bytes());
    };
    for layer in [&p.color, &p.seam, &p.support, &p.fuzzy] {
        u32le(&mut out, layer.len());
        for (t, code) in layer {
            out.extend_from_slice(&t.to_le_bytes());
            u32le(&mut out, code.len());
            out.extend_from_slice(code.as_bytes());
        }
    }
    json!({ "rawBytes": push_out_file(OutFile::Bytes(out)) })
}

/// `{ data: { path } | { base64 } }`: parts in their object's space in millimeters, with `positionsOut` and
/// `trianglesOut`
pub fn read(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let data = req.get("data").ok_or_else(|| Error::invalid("data", "missing"))?;
    let bytes = if let Some(p) = data.get("path").and_then(Value::as_str) {
        files(p)?
    } else if let Some(b) = data.get("base64").and_then(Value::as_str) {
        base64_decode(b).ok_or_else(|| Error::invalid("data", "bad base64"))?
    } else {
        return Err(Error::invalid("data", "a path or base64"));
    };
    let project = read_3mf(&bytes)?;
    drop(bytes);
    let scale = project.unit_scale;
    let mut objects = Vec::with_capacity(project.objects.len());
    for o in project.objects {
        let mut parts = Vec::with_capacity(o.parts.len());
        for mut p in o.parts {
            let kind = match p.kind {
                PartKind::Normal => "normal",
                PartKind::Negative => "negative",
                PartKind::Modifier => "modifier",
                PartKind::SupportBlocker => "support_blocker",
                PartKind::SupportEnforcer => "support_enforcer",
            };
            // a part no component moves, in millimeters already, goes out as read
            let positions = if p.chain.is_empty() && (scale - 1.0).abs() <= f32::EPSILON {
                std::mem::take(&mut p.positions)
            } else {
                p.in_object(scale)
            };
            let triangles = std::mem::take(&mut p.triangles);
            parts.push(json!({
                "id": p.id,
                "name": p.name,
                "meshName": p.mesh_name,
                "range": p.range.map(|(a, b)| json!([a, b])),
                "kind": kind,
                "kindText": p.kind_text,
                "slot": p.slot,
                "settings": pairs(&p.settings),
                "paint": paint(&p.paint),
                "transformed": p.transformed,
                "positionsOut": push_out_file(OutFile::Positions(positions)),
                "trianglesOut": push_out_file(OutFile::Triangles(triangles)),
            }));
        }
        objects.push(json!({
            "id": o.id,
            "name": o.name,
            "transform": o.transform,
            "printable": o.printable,
            "plate": o.plate,
            "slot": o.slot,
            "settings": pairs(&o.settings),
            "metadata": pairs(&o.metadata),
            "parts": parts,
        }));
    }
    let plates: Vec<Value> = project
        .plates
        .iter()
        .map(|p| json!({ "id": p.id, "name": p.name, "objects": p.objects, "settings": pairs(&p.settings) }))
        .collect();
    let layout = match project.layout {
        super::Layout::Plain => "plain",
        super::Layout::Bambu => "bambu",
        super::Layout::Prusa => "prusa",
    };
    Ok(json!({
        "layout": layout,
        "unitScale": scale,
        "doctype": project.doctype,
        "metadata": pairs(&project.metadata),
        "plates": plates,
        "objects": objects,
        "notes": project.notes,
    }))
}
