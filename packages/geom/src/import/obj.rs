// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Wavefront OBJ reader with vertex and material colors
// indices are resolved against the vertex list length before use
#![allow(clippy::indexing_slicing)]

use super::{ImportOptions, ImportedModel, RawBody, RawGroup, RawModel, mean_color};
use crate::error::{Error, Result};
use std::collections::HashMap;

pub type MtlLoader<'a> = &'a dyn Fn(&str) -> Option<Vec<u8>>;

fn color8(c: [f64; 3]) -> [u8; 3] {
    // colors are 0 to 1; a few exporters write 0 to 255
    let k = if c.iter().any(|v| *v > 1.0) { 1.0 } else { 255.0 };
    c.map(|v| (v * k).round().clamp(0.0, 255.0) as u8)
}

fn floats<'a>(it: impl Iterator<Item = &'a str>) -> Vec<f64> {
    it.map_while(|t| t.parse::<f64>().ok().filter(|v| v.is_finite()))
        .collect()
}

fn materials(text: &str) -> HashMap<String, [u8; 3]> {
    let mut out = HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        let mut it = line.split_whitespace();
        match it.next() {
            Some("newmtl") => current = Some(it.collect::<Vec<_>>().join(" ")),
            Some("Kd") => {
                let v = floats(it);
                if let (Some(name), [r, g, b, ..]) = (&current, v.as_slice()) {
                    out.insert(name.clone(), color8([*r, *g, *b]));
                }
            }
            _ => {}
        }
    }
    out
}

pub fn import_obj(
    bytes: &[u8],
    name: &str,
    mtl: Option<MtlLoader<'_>>,
    opts: &ImportOptions,
) -> Result<ImportedModel> {
    let text = String::from_utf8_lossy(bytes);
    let has_objects = text.lines().any(|l| l.starts_with("o ") || l == "o");
    let mut raw = RawModel::new(name, "obj");
    let mut colors: Vec<Option<[u8; 3]>> = Vec::new();
    let mut mats = HashMap::new();
    let mut mtl_missing = Vec::new();
    let mut mat: Option<[u8; 3]> = None;
    let mut body_name = name.to_owned();
    let mut group_name = String::new();
    let mut faces: Vec<([u32; 3], Option<[u8; 3]>)> = Vec::new();
    let mut groups: Vec<RawGroup> = Vec::new();
    let mut bodies: Vec<RawBody> = Vec::new();

    let flush_group = |groups: &mut Vec<RawGroup>, faces: &mut Vec<_>, group_name: &str| {
        if !faces.is_empty() {
            groups.push(RawGroup {
                name: group_name.to_owned(),
                faces: std::mem::take(faces),
            });
        }
    };
    let flush_body = |bodies: &mut Vec<RawBody>, groups: &mut Vec<RawGroup>, body_name: &str| {
        if !groups.is_empty() {
            bodies.push(RawBody {
                name: body_name.to_owned(),
                groups: std::mem::take(groups),
            });
        }
    };

    for (ln, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        let Some(tag) = it.next() else { continue };
        match tag {
            "v" => {
                let v = floats(it);
                if v.len() < 3 {
                    return Err(Error::mesh(
                        name,
                        format!("line {}: a vertex needs x y z", ln + 1),
                    ));
                }
                raw.positions.push([v[0], v[1], v[2]]);
                colors.push((v.len() >= 6).then(|| color8([v[3], v[4], v[5]])));
            }
            "f" => {
                let n = raw.positions.len();
                let mut idx = Vec::new();
                for tok in it {
                    let head = tok.split('/').next().unwrap_or("");
                    let i: i64 = head.parse().map_err(|_| {
                        Error::mesh(name, format!("line {}: bad face index {head:?}", ln + 1))
                    })?;
                    let r = if i > 0 { i - 1 } else { n as i64 + i };
                    if r < 0 || r as usize >= n {
                        return Err(Error::mesh(
                            name,
                            format!("line {}: face index {i} is out of range", ln + 1),
                        ));
                    }
                    idx.push(r as u32);
                }
                if idx.len() < 3 {
                    continue;
                }
                for k in 1..idx.len() - 1 {
                    let t = [idx[0], idx[k], idx[k + 1]];
                    let vc = t.map(|i| colors[i as usize]);
                    let color = if let [Some(a), Some(b), Some(c)] = vc {
                        Some(mean_color(a, b, c))
                    } else {
                        mat
                    };
                    faces.push((t, color));
                }
            }
            "o" | "g" => {
                let label = it.collect::<Vec<_>>().join(" ");
                if tag == "o" || !has_objects {
                    flush_group(&mut groups, &mut faces, &group_name);
                    flush_body(&mut bodies, &mut groups, &body_name);
                    body_name = if label.is_empty() {
                        format!("object {}", bodies.len() + 1)
                    } else {
                        label
                    };
                    group_name.clear();
                } else {
                    flush_group(&mut groups, &mut faces, &group_name);
                    group_name = label;
                }
            }
            "mtllib" => {
                let file = line[tag.len()..].trim();
                match mtl.and_then(|l| l(file)) {
                    Some(b) => mats.extend(materials(&String::from_utf8_lossy(&b))),
                    None => mtl_missing.push(file.to_owned()),
                }
            }
            "usemtl" => {
                let m = it.collect::<Vec<_>>().join(" ");
                mat = mats.get(&m).copied();
            }
            _ => {}
        }
    }
    flush_group(&mut groups, &mut faces, &group_name);
    flush_body(&mut bodies, &mut groups, &body_name);
    if !mtl_missing.is_empty() && mats.is_empty() {
        raw.warnings.push(format!(
            "material file {} was not found, so material colors are ignored",
            mtl_missing.join(", ")
        ));
    }
    raw.bodies = bodies;
    raw.finish(opts)
}
