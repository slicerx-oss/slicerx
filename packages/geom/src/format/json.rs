// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `format.read3mf` for the json api: the project as json, each part's mesh as a raw output buffer

use super::threemf::{Paint, PartKind, read_3mf};
use crate::error::{Error, Result};
use crate::json::{FileLoader, base64_decode, push_out_file};
use serde_json::{Value, json};

fn pairs(list: &[(String, String)]) -> Value {
    Value::Array(list.iter().map(|(k, v)| json!([k, v])).collect())
}

fn paint(p: &Paint) -> Value {
    let layer = |l: &[(u32, String)]| Value::Array(l.iter().map(|(t, c)| json!([t, c])).collect());
    json!({ "color": layer(&p.color), "seam": layer(&p.seam), "support": layer(&p.support), "fuzzy": layer(&p.fuzzy) })
}

/// the raw form of `TriMesh::from_raw`: counts, then f32 positions, then u32 triangles
fn raw(positions: &[[f32; 3]], triangles: &[[u32; 3]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + 12 * (positions.len() + triangles.len()));
    for n in [positions.len(), triangles.len()] {
        out.extend_from_slice(&u32::try_from(n).unwrap_or(u32::MAX).to_le_bytes());
    }
    for c in positions.iter().flatten() {
        out.extend_from_slice(&c.to_le_bytes());
    }
    for i in triangles.iter().flatten() {
        out.extend_from_slice(&i.to_le_bytes());
    }
    out
}

/// `{ data: { path } | { base64 } }`: parts in their object's space in millimeters, with `rawOut`
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
        for p in o.parts {
            let kind = match p.kind {
                PartKind::Normal => "normal",
                PartKind::Negative => "negative",
                PartKind::Modifier => "modifier",
                PartKind::SupportBlocker => "support_blocker",
                PartKind::SupportEnforcer => "support_enforcer",
            };
            let n = push_out_file(raw(&p.in_object(scale), &p.triangles));
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
                "rawOut": n,
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
