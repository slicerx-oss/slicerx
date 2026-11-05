// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The texture side of a 3MF (the materials extension): `texture2d` images, `texture2dgroup` coordinates, and each
//! triangle's `pid` with `p1`, `p2` and `p3` (or its object's `pid` and `pindex`). The parts come from the project
//! reader, so their triangles and positions are the ones a project open gives.

use super::threemf::read_3mf;
use super::xml::{self, Tag};
use super::zip::Zip;
use crate::error::Result;
use crate::texture::image::{self, Wrap};
use crate::texture::{Look, SourcePart, TextureSource};
use std::collections::HashMap;

const NONE: u32 = u32::MAX;

struct Texture {
    path: String,
    wrap: (Wrap, Wrap),
}

/// A resource by its model file and its id there: each model file of a package numbers its own resources.
type Key = (String, u32);

#[derive(Default)]
struct Scan {
    textures: HashMap<Key, Texture>,
    /// group: (texture id in the same model file, coordinates)
    groups: HashMap<Key, (u32, Vec<[f64; 2]>)>,
    /// mesh object: per triangle (pid, p1, p2, p3), `NONE` where the triangle has no property
    props: HashMap<Key, Vec<[u32; 4]>>,
}

struct Open {
    id: u32,
    pid: u32,
    pindex: u32,
    tris: Vec<[u32; 4]>,
    any: bool,
}

fn num(t: &Tag<'_>, key: &str) -> Option<u32> {
    t.attr(key).and_then(|v| v.trim().parse().ok())
}

fn scan_model(model: &str, text: &str, into: &mut Scan) {
    let mut open: Option<Open> = None;
    let mut group: Option<(u32, u32, Vec<[f64; 2]>)> = None;
    let _ = xml::scan(text, |t: Tag<'_>| -> std::result::Result<(), ()> {
        match t.name {
            "texture2d" if t.opens() => {
                if let (Some(id), Some(path)) = (num(&t, "id"), t.attr("path")) {
                    into.textures.insert(
                        (model.to_owned(), id),
                        Texture {
                            path: xml::unescape(path).trim_start_matches('/').to_owned(),
                            wrap: (
                                Wrap::of_3mf(t.attr("tilestyleu")),
                                Wrap::of_3mf(t.attr("tilestylev")),
                            ),
                        },
                    );
                }
            }
            "texture2dgroup" => {
                if t.opens()
                    && let (Some(id), Some(tex)) = (num(&t, "id"), num(&t, "texid"))
                {
                    group = Some((id, tex, Vec::new()));
                }
                if t.closes()
                    && let Some((id, tex, coords)) = group.take()
                {
                    into.groups.insert((model.to_owned(), id), (tex, coords));
                }
            }
            "tex2coord" if t.opens() => {
                if let Some((_, _, coords)) = group.as_mut() {
                    let f = |k: &str| t.attr(k).and_then(xml::f32_of).map_or(0.0, f64::from);
                    coords.push([f("u"), f("v")]);
                }
            }
            "object" => {
                if t.opens() {
                    open = num(&t, "id").map(|id| Open {
                        id,
                        pid: num(&t, "pid").unwrap_or(NONE),
                        pindex: num(&t, "pindex").unwrap_or(0),
                        tris: Vec::new(),
                        any: false,
                    });
                }
                if t.closes()
                    && let Some(o) = open.take()
                    && o.any
                {
                    into.props.insert((model.to_owned(), o.id), o.tris);
                }
            }
            "triangle" if t.opens() => {
                if let Some(o) = open.as_mut() {
                    let row = match num(&t, "pid") {
                        Some(pid) => {
                            let p1 = num(&t, "p1").unwrap_or(o.pindex);
                            [pid, p1, num(&t, "p2").unwrap_or(p1), num(&t, "p3").unwrap_or(p1)]
                        }
                        None if o.pid != NONE => [o.pid, o.pindex, o.pindex, o.pindex],
                        None => [NONE; 4],
                    };
                    o.any |= row[0] != NONE;
                    o.tris.push(row);
                }
            }
            _ => {}
        }
        Ok(())
    });
}

/// The textured surface of a 3MF: one source part per part the project reader gives, in its order.
pub fn read(bytes: &[u8]) -> Result<TextureSource> {
    let zip = Zip::open(bytes)?;
    let mut scan = Scan::default();
    let names: Vec<String> = zip
        .names()
        .filter(|n| {
            std::path::Path::new(n)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("model"))
        })
        .map(str::to_owned)
        .collect();
    for n in &names {
        if let Ok(b) = zip.read(n) {
            scan_model(n, &String::from_utf8_lossy(&b), &mut scan);
        }
    }
    let mut out = TextureSource::default();
    if scan.props.is_empty() || scan.groups.is_empty() {
        return Ok(out);
    }
    // texture: image index, decoded once and only when a group uses it
    let mut image_of: HashMap<Key, Option<u32>> = HashMap::new();
    let mut image_for = |tex: &Key, out: &mut TextureSource| -> Option<u32> {
        *image_of.entry(tex.clone()).or_insert_with(|| {
            let t = scan.textures.get(tex)?;
            let Ok(bytes) = zip.read(&t.path) else {
                out.notes.push(format!(
                    "The texture {} was not found, so it is left out.",
                    t.path
                ));
                return None;
            };
            match image::decode(&bytes) {
                Ok(img) => {
                    out.images.push(img);
                    out.image_names.push(t.path.clone());
                    u32::try_from(out.images.len() - 1).ok()
                }
                Err(why) => {
                    out.notes.push(why.note(&t.path));
                    None
                }
            }
        })
    };
    let project = read_3mf(bytes)?;
    let scale = project.unit_scale;
    for o in &project.objects {
        for p in &o.parts {
            let key = |id: u32| (p.model.clone(), id);
            let rows = scan.props.get(&key(p.id));
            let first = p.range.map_or(0, |r| r.0) as usize;
            let mut looks = Vec::with_capacity(p.triangles.len());
            for k in 0..p.triangles.len() {
                let look = rows
                    .and_then(|r| r.get(first + k))
                    .and_then(|row| {
                        let (tex, coords) = scan.groups.get(&key(row[0]))?;
                        let uv = |i: u32| coords.get(i as usize).copied();
                        let uv = [uv(row[1])?, uv(row[2])?, uv(row[3])?];
                        let tex = key(*tex);
                        let wrap = scan.textures.get(&tex)?.wrap;
                        let image = image_for(&tex, &mut out)?;
                        Some(Look::Texture { image, uv, wrap })
                    })
                    .unwrap_or(Look::None);
                looks.push(look);
            }
            out.parts.push(SourcePart {
                positions: p.in_object(scale).into_iter().map(|q| q.map(f64::from)).collect(),
                triangles: p.triangles.clone(),
                looks,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::texture::tests::{crc32, png_rgb};
    use std::fmt::Write as _;

    /// A ZIP of stored entries.
    fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut dir = Vec::new();
        for (name, data) in files {
            let at = u32::try_from(out.len()).unwrap();
            let crc = crc32(data);
            let n = u16::try_from(name.len()).unwrap();
            let len = u32::try_from(data.len()).unwrap();
            let head = |sig: u32, central: bool| {
                let mut h = sig.to_le_bytes().to_vec();
                if central {
                    h.extend(20u16.to_le_bytes());
                }
                for v in [20u16, 0, 0, 0, 0] {
                    h.extend(v.to_le_bytes());
                }
                h.extend(crc.to_le_bytes());
                h.extend(len.to_le_bytes());
                h.extend(len.to_le_bytes());
                h.extend(n.to_le_bytes());
                h.extend(0u16.to_le_bytes());
                if central {
                    for v in [0u16, 0, 0] {
                        h.extend(v.to_le_bytes());
                    }
                    h.extend(0u32.to_le_bytes());
                    h.extend(at.to_le_bytes());
                }
                h.extend(name.as_bytes());
                h
            };
            out.extend(head(0x0403_4b50, false));
            out.extend_from_slice(data);
            dir.extend(head(0x0201_4b50, true));
        }
        let start = u32::try_from(out.len()).unwrap();
        let count = u16::try_from(files.len()).unwrap();
        let size = u32::try_from(dir.len()).unwrap();
        out.extend(dir);
        out.extend(0x0605_4b50u32.to_le_bytes());
        for v in [0u16, 0, count, count] {
            out.extend(v.to_le_bytes());
        }
        out.extend(size.to_le_bytes());
        out.extend(start.to_le_bytes());
        out.extend(0u16.to_le_bytes());
        out
    }

    const NS: &str = r#"xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06""#;

    /// A model file with texture 1 (`image`), group 2 and a one-triangle object 3 that uses it.
    fn object_file(image: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><model unit="millimeter" {NS}><resources><m:texture2d id="1" path="/{image}" contenttype="image/png"/><m:texture2dgroup id="2" texid="1"><m:tex2coord u="0.5" v="0.5"/><m:tex2coord u="0.5" v="0.5"/><m:tex2coord u="0.5" v="0.5"/></m:texture2dgroup><object id="3" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/></triangles></mesh></object></resources></model>"#
        )
    }

    /// A package whose root model places object 3 of each of `objects` (path, text).
    fn package(objects: &[(&str, String)], images: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut comps = String::new();
        let mut items = String::new();
        for (i, (path, _)) in objects.iter().enumerate() {
            let id = 10 + i;
            write!(
                comps,
                r#"<object id="{id}" type="model"><components><component objectid="3" p:path="/{path}"/></components></object>"#
            )
            .unwrap();
            write!(items, r#"<item objectid="{id}"/>"#).unwrap();
        }
        let root = format!(
            r#"<?xml version="1.0"?><model unit="millimeter" {NS}><resources>{comps}</resources><build>{items}</build></model>"#
        );
        let rels = r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#;
        let mut files: Vec<(&str, &[u8])> = vec![
            ("_rels/.rels", rels.as_bytes()),
            ("3D/3dmodel.model", root.as_bytes()),
        ];
        for (p, t) in objects {
            files.push((p, t.as_bytes()));
        }
        for (p, b) in images {
            files.push((p, b));
        }
        zip(&files)
    }

    #[test]
    fn each_model_file_keeps_its_own_ids() {
        // two object files, each with texture 1, group 2 and object 3: one on a red image, one on a blue
        let bytes = package(
            &[
                ("3D/Objects/a.model", object_file("3D/Texture/red.png")),
                ("3D/Objects/b.model", object_file("3D/Texture/blue.png")),
            ],
            &[
                ("3D/Texture/red.png", png_rgb(1, 1, &[230, 20, 30])),
                ("3D/Texture/blue.png", png_rgb(1, 1, &[20, 40, 220])),
            ],
        );
        let src = read(&bytes).unwrap();
        assert_eq!(src.parts.len(), 2);
        let image_of = |p: &SourcePart| match p.looks[0] {
            Look::Texture { image, .. } => src.image_names[image as usize].clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(image_of(&src.parts[0]), "3D/Texture/red.png");
        assert_eq!(image_of(&src.parts[1]), "3D/Texture/blue.png");
    }

    #[test]
    fn a_damaged_or_missing_texture_is_left_out_in_a_sentence() {
        let bytes = package(
            &[
                ("3D/Objects/a.model", object_file("3D/Texture/bad.png")),
                ("3D/Objects/b.model", object_file("3D/Texture/gone.png")),
            ],
            &[("3D/Texture/bad.png", b"\x89PNG broken".to_vec())],
        );
        let src = read(&bytes).unwrap();
        assert_eq!(
            src.notes,
            vec![
                "The texture 3D/Texture/bad.png is damaged, so it is left out.".to_owned(),
                "The texture 3D/Texture/gone.png was not found, so it is left out.".to_owned(),
            ]
        );
    }
}
