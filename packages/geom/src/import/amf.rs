// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! AMF, plain XML or a ZIP holding one `.amf`

use super::container::{self, Ev, attr};
use super::{ImportOptions, ImportedModel, RawBody, RawGroup, RawModel, Unit, mean_color};
use crate::error::{Error, Result};
use std::collections::HashMap;

fn color8(c: [f64; 3]) -> [u8; 3] {
    c.map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8)
}

#[allow(clippy::too_many_lines, reason = "one pass over the element stream")]
pub fn import_amf(bytes: &[u8], name: &str, opts: &ImportOptions) -> Result<ImportedModel> {
    let unzipped;
    let data: &[u8] = if container::is_zip(bytes) {
        unzipped = container::read_entry(bytes, ".amf")?;
        &unzipped
    } else {
        bytes
    };
    let xml = std::str::from_utf8(data).map_err(|_| Error::mesh(name, "AMF is not UTF-8 text"))?;
    let mut raw = RawModel::new(name, "amf");
    let mut scale = 1.0;
    let mut materials: HashMap<String, [u8; 3]> = HashMap::new();
    let mut path: Vec<&str> = Vec::new();
    let mut coord = [0.0f64; 3];
    let mut vertex_colors: Vec<Option<[u8; 3]>> = Vec::new();
    let mut vertex_color: Option<[u8; 3]> = None;
    let mut rgba = [0.0f64; 4];
    let mut tri = [0u32; 3];
    let mut tri_color: Option<[u8; 3]> = None;
    let mut mat_id = String::new();
    let mut object_name = String::new();
    let mut volume_name = String::new();
    let mut volume_material: Option<String> = None;
    let mut group_material: HashMap<(usize, usize), String> = HashMap::new();
    let mut faces: Vec<([u32; 3], Option<[u8; 3]>)> = Vec::new();
    let mut groups: Vec<RawGroup> = Vec::new();
    let mut base = 0usize; // first vertex of the current object
    let mut constellation = false;
    let mut meta_type = String::new();
    let mut objects = 0usize;

    let fail = |what: &str| Error::mesh(name, format!("AMF: {what}"));
    for ev in container::events(xml) {
        match ev {
            Ev::Start {
                name: tag,
                attrs,
                empty,
            } => {
                match tag {
                    "amf" => {
                        if let Some(u) = attr(attrs, "unit") {
                            let unit = Unit::parse(u).ok_or_else(|| fail("unknown unit"))?;
                            scale = unit.mm();
                            raw.declared = Some(unit);
                        } else {
                            raw.declared = Some(Unit::Millimeter);
                        }
                    }
                    "object" => {
                        objects += 1;
                        object_name = format!("object {objects}");
                        base = raw.positions.len();
                        groups.clear();
                    }
                    "volume" => {
                        volume_name = format!("volume {}", groups.len() + 1);
                        volume_material = attr(attrs, "materialid").map(str::to_owned);
                        faces.clear();
                    }
                    "material" => {
                        mat_id = attr(attrs, "id").unwrap_or("").to_owned();
                        rgba = [0.0; 4];
                    }
                    "vertex" => vertex_color = None,
                    "triangle" => tri_color = None,
                    "color" => rgba = [0.0, 0.0, 0.0, 1.0],
                    "metadata" => meta_type = attr(attrs, "type").unwrap_or("").to_owned(),
                    "constellation" => constellation = true,
                    _ => {}
                }
                if empty {
                    continue;
                }
                path.push(tag);
            }
            Ev::Text(t) => {
                let leaf = path.last().copied().unwrap_or("");
                let parent = path
                    .len()
                    .checked_sub(2)
                    .and_then(|i| path.get(i))
                    .copied()
                    .unwrap_or("");
                let num = || t.parse::<f64>().ok().filter(|v| v.is_finite());
                match (parent, leaf) {
                    ("coordinates", "x") => coord[0] = num().ok_or_else(|| fail("bad x"))?,
                    ("coordinates", "y") => coord[1] = num().ok_or_else(|| fail("bad y"))?,
                    ("coordinates", "z") => coord[2] = num().ok_or_else(|| fail("bad z"))?,
                    ("triangle", "v1") => tri[0] = t.parse().map_err(|_| fail("bad v1"))?,
                    ("triangle", "v2") => tri[1] = t.parse().map_err(|_| fail("bad v2"))?,
                    ("triangle", "v3") => tri[2] = t.parse().map_err(|_| fail("bad v3"))?,
                    ("color", "r") => rgba[0] = num().unwrap_or(0.0),
                    ("color", "g") => rgba[1] = num().unwrap_or(0.0),
                    ("color", "b") => rgba[2] = num().unwrap_or(0.0),
                    ("color", "a") => rgba[3] = num().unwrap_or(1.0),
                    (_, "metadata") => match (meta_type.as_str(), path.iter().rev().nth(1).copied()) {
                        ("name", Some("volume")) => volume_name = t.to_owned(),
                        ("name", Some("object")) => object_name = t.to_owned(),
                        _ => {}
                    },
                    _ => {}
                }
            }
            Ev::End(tag) => {
                path.pop();
                match tag {
                    "vertex" => {
                        raw.positions.push(coord.map(|c| c * scale));
                        vertex_colors.push(vertex_color);
                    }
                    "color" => {
                        let c = color8([rgba[0], rgba[1], rgba[2]]);
                        match path.last().copied() {
                            Some("material") => {
                                materials.insert(mat_id.clone(), c);
                            }
                            Some("vertex") => vertex_color = Some(c),
                            Some("triangle") => tri_color = Some(c),
                            _ => {}
                        }
                    }
                    "triangle" => {
                        let t = tri.map(|i| i + u32::try_from(base).unwrap_or(0));
                        let color = tri_color.or_else(|| {
                            let vc = t.map(|i| vertex_colors.get(i as usize).copied().flatten());
                            if let [Some(a), Some(b), Some(c)] = vc {
                                Some(mean_color(a, b, c))
                            } else {
                                None
                            }
                        });
                        faces.push((t, color));
                    }
                    "volume" => {
                        if let Some(m) = volume_material.take() {
                            group_material.insert((raw.bodies.len(), groups.len()), m);
                        }
                        groups.push(RawGroup {
                            name: volume_name.clone(),
                            faces: std::mem::take(&mut faces),
                        });
                    }
                    "object" => raw.bodies.push(RawBody {
                        name: object_name.clone(),
                        groups: std::mem::take(&mut groups),
                    }),
                    _ => {}
                }
            }
        }
    }
    for ((b, g), id) in &group_material {
        let Some(color) = materials.get(id) else { continue };
        if let Some(group) = raw.bodies.get_mut(*b).and_then(|body| body.groups.get_mut(*g)) {
            for f in &mut group.faces {
                f.1 = f.1.or(Some(*color));
            }
        }
    }
    if constellation {
        raw.warnings
            .push("the file has a constellation (placed instances), which is not applied".to_owned());
    }
    raw.bodies
        .retain(|b| b.groups.iter().any(|g| !g.faces.is_empty()));
    let n = u32::try_from(raw.positions.len()).unwrap_or(u32::MAX);
    if raw
        .bodies
        .iter()
        .flat_map(|b| &b.groups)
        .flat_map(|g| &g.faces)
        .any(|f| f.0.iter().any(|&i| i >= n))
    {
        return Err(fail("a triangle points past the vertex list"));
    }
    raw.finish(opts)
}
