// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! One reader of the format corpus on one file, for scripts/format-corpus/run.mjs:
//!
//! ```text
//! cargo run --release -p sx-core --example format_read -- <core|geom|sx3mf|none> <file> [repeats]
//! ```
//!
//! Prints one JSON summary (plates, objects, parts with their type, slot, triangles and painted triangles, and the
//! file's metadata) with the time of the first read and the fastest of `repeats`. `none` reads nothing, so the
//! script can take the process's own memory off the peak it measures.
use serde_json::{Value, json};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(reader), Some(file)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: format_read <core|geom|sx3mf|none> <file> [repeats]");
        std::process::exit(2);
    };
    let repeats: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3).max(1);
    let bytes = std::fs::read(file).unwrap_or_else(|e| {
        eprintln!("format_read: {file}: {e}");
        std::process::exit(2);
    });
    let name = std::path::Path::new(file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file);
    let mut times = Vec::with_capacity(repeats);
    let mut out = Ok(Value::Null);
    for _ in 0..repeats {
        let t = Instant::now();
        out = read(reader, &bytes, name);
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        if out.is_err() {
            break;
        }
    }
    let first = times.first().copied().unwrap_or(0.0);
    let min = times.iter().copied().fold(f64::INFINITY, f64::min);
    let summary = match out {
        Ok(v) => json!({ "reader": reader, "ok": true, "firstMs": first, "minMs": min, "model": v }),
        Err(e) => json!({ "reader": reader, "ok": false, "error": e, "firstMs": first, "minMs": min }),
    };
    println!("{summary}");
}

fn read(reader: &str, bytes: &[u8], name: &str) -> Result<Value, String> {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match reader {
        "none" => Ok(Value::Null),
        "core" => core(bytes, name, &ext),
        "geom" => geom(bytes, name, &ext),
        "sx3mf" => sx3mf(bytes, &ext),
        _ => Err(format!("unknown reader {reader}")),
    }
}

fn core(bytes: &[u8], name: &str, ext: &str) -> Result<Value, String> {
    if ext == "3mf" || ext == "sx3mf" {
        let plates = sx_core::api::load_3mf_plate_objects(bytes, name).map_err(|e| e.to_string())?;
        let settings = sx_core::threemf::metadata(bytes, name)
            .ok()
            .and_then(|m| m.project_settings)
            .and_then(|s| s.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()))
            .unwrap_or_default();
        let plates: Vec<Value> = plates
            .iter()
            .map(|(plate, objects)| json!({ "plate": plate, "objects": objects.iter().map(core_object).collect::<Vec<_>>() }))
            .collect();
        return Ok(json!({ "plates": plates, "meta": { "settingsKeys": settings } }));
    }
    let mesh = sx_core::api::load_mesh(bytes, name).map_err(|e| e.to_string())?;
    Ok(json!({ "plates": [{ "plate": 1, "objects": [core_object(&mesh)] }], "meta": {} }))
}

/// Painted triangles of a part by layer, from the paint texts the core keeps (0 color, 1 seam, 2 support, 3 fuzzy).
fn core_paint(part: &sx_core::MeshPart) -> Value {
    let mut n = [0usize; 4];
    for (layer, _, _) in &part.paint_texts {
        if let Some(c) = n.get_mut(usize::from(*layer)) {
            *c += 1;
        }
    }
    json!({ "color": n[0], "seam": n[1], "support": n[2], "fuzzy": n[3] })
}

fn core_object(mesh: &sx_core::Mesh) -> Value {
    use sx_core::plate::VolumeRole;
    let mut ext = Extent::default();
    let mut parts: Vec<Value> = mesh
        .parts
        .iter()
        .map(|p| {
            for v in &p.positions {
                ext.add(f64::from(v[0]), f64::from(v[1]), f64::from(v[2]));
            }
            json!({ "name": p.name, "type": "normal", "slot": p.slot, "triangles": p.triangles.len(), "paint": core_paint(p) })
        })
        .collect();
    // volumes print nothing, so they stay out of the object's size
    parts.extend(mesh.volumes.iter().map(|v| {
        let kind = match v.role {
            VolumeRole::Negative => "negative",
            VolumeRole::SupportBlocker => "support_blocker",
            VolumeRole::SupportEnforcer => "support_enforcer",
            VolumeRole::Modifier => "modifier",
        };
        let p = &v.part;
        json!({ "name": p.name, "type": kind, "slot": p.slot, "triangles": p.triangles.len(), "paint": core_paint(p) })
    }));
    json!({ "name": mesh.name, "extent": ext.size(), "parts": parts })
}

fn geom(bytes: &[u8], name: &str, ext: &str) -> Result<Value, String> {
    use sx_geom::import::{ImportOptions, import_amf, import_obj, import_stl};
    let opts = ImportOptions::default();
    let model = match ext {
        "3mf" | "sx3mf" => return geom_3mf(bytes),
        "stl" => import_stl(bytes, name, &opts),
        "obj" => import_obj(bytes, name, None, &opts),
        "amf" => import_amf(bytes, name, &opts),
        _ => return Err(format!("sx-geom reads no .{ext} files")),
    }
    .map_err(|e| e.to_string())?;
    let mut ext = Extent::default();
    let parts: Vec<Value> = model
        .parts
        .iter()
        .map(|p| {
            for v in &p.mesh.positions {
                ext.add(v[0], v[1], v[2]);
            }
            json!({ "name": p.name, "type": "normal", "slot": p.slot, "triangles": p.mesh.triangles.len(),
                    "paint": { "color": 0, "seam": 0, "support": 0, "fuzzy": 0 } })
        })
        .collect();
    let object = json!({ "name": model.name, "extent": ext.size(), "parts": parts });
    Ok(
        json!({ "plates": [{ "plate": 1, "objects": [object] }], "meta": { "bodies": model.bodies.len(), "unit": format!("{:?}", model.unit.declared) } }),
    )
}

/// what prints of each object, as the core and the app read it: printable items with a printed part, slots and names
/// falling back the way they do
fn geom_3mf(bytes: &[u8]) -> Result<Value, String> {
    use sx_geom::format::{Part, PartKind, read_3mf};
    let project = read_3mf(bytes).map_err(|e| e.to_string())?;
    let scale = project.unit_scale;
    let mut plates: std::collections::BTreeMap<u32, Vec<Value>> = std::collections::BTreeMap::new();
    for o in &project.objects {
        if !o.printable || !o.parts.iter().any(Part::prints) {
            continue;
        }
        let mut ext = Extent::default();
        let parts: Vec<Value> = o
            .parts
            .iter()
            .map(|p| {
                if p.prints() {
                    for v in p.placed(&o.transform, scale) {
                        ext.add(f64::from(v[0]), f64::from(v[1]), f64::from(v[2]));
                    }
                }
                let kind = match p.kind {
                    PartKind::Normal => "normal",
                    PartKind::Negative => "negative",
                    PartKind::Modifier => "modifier",
                    PartKind::SupportBlocker => "support_blocker",
                    PartKind::SupportEnforcer => "support_enforcer",
                };
                let name = if p.name.is_empty() { if o.name.is_empty() { "Part" } else { &o.name } } else { &p.name };
                let paint = &p.paint;
                json!({ "name": name, "type": kind, "slot": p.slot.or(o.slot).unwrap_or(1),
                        "triangles": p.triangles.len(),
                        "paint": { "color": paint.color.len(), "seam": paint.seam.len(), "support": paint.support.len(), "fuzzy": paint.fuzzy.len() } })
            })
            .collect();
        let first = o.parts.first().map_or("", |p| p.name.as_str());
        let name = if !o.name.is_empty() {
            o.name.as_str()
        } else if first.is_empty() {
            "Part"
        } else {
            first
        };
        plates
            .entry(o.plate.unwrap_or(1))
            .or_default()
            .push(json!({ "name": name, "extent": ext.size(), "parts": parts }));
    }
    let settings = project
        .files
        .project_settings
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()))
        .unwrap_or_default();
    let sx = |k: &str| {
        project
            .metadata
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.is_empty())
    };
    let plates: Vec<Value> = plates
        .into_iter()
        .map(|(plate, objects)| json!({ "plate": plate, "objects": objects }))
        .collect();
    Ok(
        json!({ "plates": plates, "meta": { "settingsKeys": settings, "sx": { "listing": sx("sx:Listing"), "creator": sx("sx:Creator") } } }),
    )
}

fn sx3mf(bytes: &[u8], ext: &str) -> Result<Value, String> {
    if ext != "3mf" && ext != "sx3mf" {
        return Err(format!("sx3mf reads no .{ext} files"));
    }
    let info = sx3mf::inspect(bytes).map_err(|e| e.to_string())?;
    let m = &info.metadata;
    Ok(
        json!({ "meta": { "sx": { "listing": m.listing, "version": m.version, "creator": m.creator }, "title": info.title, "application": info.application } }),
    )
}

/// The size of everything added, to the hundredth of a millimeter.
#[derive(Default)]
struct Extent(Option<([f64; 3], [f64; 3])>);

impl Extent {
    fn add(&mut self, x: f64, y: f64, z: f64) {
        let p = [x, y, z];
        let (lo, hi) = self.0.get_or_insert((p, p));
        for (i, v) in p.into_iter().enumerate() {
            if let (Some(l), Some(h)) = (lo.get_mut(i), hi.get_mut(i)) {
                *l = l.min(v);
                *h = h.max(v);
            }
        }
    }

    fn size(&self) -> Vec<f64> {
        let Some((lo, hi)) = self.0 else {
            return vec![0.0; 3];
        };
        lo.iter()
            .zip(hi)
            .map(|(l, h)| ((h - l) * 100.0).round() / 100.0)
            .collect()
    }
}
