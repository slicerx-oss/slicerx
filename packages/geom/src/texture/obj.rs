// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The texture side of an OBJ: positions, texture coordinates, faces and their materials, and from the MTL each
//! material's `Kd` and `map_Kd` (with `-clamp on`). Faces are split into triangles as the OBJ import splits them, so
//! a triangle here is the same surface as the import's.
// face corners are checked against the vertex list before use; a face has at least three
#![allow(clippy::indexing_slicing)]

use super::image::{self, Image, Wrap};
use super::{Look, SourcePart, TextureSource};
use crate::error::{Error, Result};
use std::collections::HashMap;

/// Reads a sibling file (an MTL or an image) by the name the OBJ or MTL gives it.
pub type Loader<'a> = &'a dyn Fn(&str) -> Option<Vec<u8>>;

#[derive(Default, Clone)]
struct Material {
    kd: Option<[u8; 3]>,
    map: Option<(String, bool)>,
}

fn floats<'a>(it: impl Iterator<Item = &'a str>) -> Vec<f64> {
    it.map_while(|t| t.parse::<f64>().ok().filter(|v| v.is_finite()))
        .collect()
}

fn color8(c: [f64; 3]) -> [u8; 3] {
    let k = if c.iter().any(|v| *v > 1.0) { 1.0 } else { 255.0 };
    // within 0 to 255 after the clamp
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    c.map(|v| (v * k).round().clamp(0.0, 255.0) as u8)
}

/// The file a `map_Kd` line names, and whether `-clamp on` is set. Options come before the name; the name may hold
/// spaces.
fn map_of(rest: &str) -> Option<(String, bool)> {
    let toks: Vec<&str> = rest.split_whitespace().collect();
    let mut clamp = false;
    let mut i = 0;
    while let Some(&t) = toks.get(i) {
        match t {
            "-clamp" => {
                clamp = toks.get(i + 1).is_some_and(|v| v.eq_ignore_ascii_case("on"));
                i += 2;
            }
            "-blendu" | "-blendv" | "-cc" | "-texres" | "-imfchan" | "-type" | "-boost" | "-bm" => i += 2,
            "-mm" => i += 3,
            // one to three numbers
            "-o" | "-s" | "-t" => {
                i += 1;
                let mut n = 0;
                while n < 3 && toks.get(i).is_some_and(|v| v.parse::<f64>().is_ok()) {
                    i += 1;
                    n += 1;
                }
            }
            _ => break,
        }
    }
    let name = toks.get(i..)?.join(" ");
    (!name.is_empty()).then_some((name.replace('\\', "/"), clamp))
}

fn materials(text: &str, into: &mut HashMap<String, Material>) {
    let mut current: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        let mut it = line.split_whitespace();
        match it.next() {
            Some("newmtl") => {
                let name = it.collect::<Vec<_>>().join(" ");
                into.entry(name.clone()).or_default();
                current = Some(name);
            }
            Some("Kd") => {
                if let (Some(m), [r, g, b, ..]) = (
                    current.as_ref().and_then(|n| into.get_mut(n)),
                    floats(it).as_slice(),
                ) {
                    m.kd = Some(color8([*r, *g, *b]));
                }
            }
            Some(tag) if tag.eq_ignore_ascii_case("map_Kd") => {
                if let Some(m) = current.as_ref().and_then(|n| into.get_mut(n)) {
                    m.map = map_of(line.get(tag.len()..).unwrap_or(""));
                }
            }
            _ => {}
        }
    }
}

/// The OBJ's surface with what each triangle shows. Missing MTL or image files leave their faces without a look and
/// add a note.
#[allow(
    clippy::too_many_lines,
    reason = "one arm per OBJ line kind reads best as one loop"
)]
pub fn read(bytes: &[u8], name: &str, files: Loader<'_>) -> Result<TextureSource> {
    let text = String::from_utf8_lossy(bytes);
    let mut positions: Vec<[f64; 3]> = Vec::new();
    let mut uvs: Vec<[f64; 2]> = Vec::new();
    let mut mats: HashMap<String, Material> = HashMap::new();
    let mut notes: Vec<String> = Vec::new();
    let mut images: Vec<Image> = Vec::new();
    let mut image_names: Vec<String> = Vec::new();
    let mut image_of: HashMap<String, Option<u32>> = HashMap::new();
    let mut current: Option<Material> = None;
    let mut part = SourcePart::default();
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
                if let [x, y, z, ..] = v.as_slice() {
                    positions.push([*x, *y, *z]);
                } else {
                    return Err(Error::mesh(
                        name,
                        format!("line {}: a vertex needs x y z", ln + 1),
                    ));
                }
            }
            "vt" => {
                let v = floats(it);
                uvs.push([
                    v.first().copied().unwrap_or(0.0),
                    v.get(1).copied().unwrap_or(0.0),
                ]);
            }
            "mtllib" => {
                let file = line.get(tag.len()..).unwrap_or("").trim().replace('\\', "/");
                match files(&file) {
                    Some(b) => materials(&String::from_utf8_lossy(&b), &mut mats),
                    None => notes.push(format!(
                        "The material file {file} was not found, so its texture is left out."
                    )),
                }
            }
            "usemtl" => {
                let m = it.collect::<Vec<_>>().join(" ");
                current = mats.get(&m).cloned();
            }
            "f" => {
                let (np, nt) = (positions.len(), uvs.len());
                let mut corners: Vec<(u32, Option<usize>)> = Vec::new();
                for tok in it {
                    let mut parts = tok.split('/');
                    let resolve = |s: Option<&str>, n: usize| -> Option<usize> {
                        let i: i64 = s?.parse().ok()?;
                        let r = if i > 0 { i - 1 } else { i64::try_from(n).ok()? + i };
                        usize::try_from(r).ok().filter(|&r| r < n)
                    };
                    let p = resolve(parts.next(), np).ok_or_else(|| {
                        Error::mesh(name, format!("line {}: bad face index {tok:?}", ln + 1))
                    })?;
                    let t = resolve(parts.next(), nt);
                    corners.push((u32::try_from(p).unwrap_or(u32::MAX), t));
                }
                if corners.len() < 3 {
                    continue;
                }
                let look_for = |c: &[(u32, Option<usize>); 3],
                                images: &mut Vec<Image>,
                                image_names: &mut Vec<String>,
                                notes: &mut Vec<String>,
                                image_of: &mut HashMap<String, Option<u32>>|
                 -> Look {
                    let Some(m) = &current else { return Look::None };
                    if let Some((file, clamp)) = &m.map
                        && let [Some(a), Some(b), Some(d)] = c.map(|x| x.1)
                    {
                        let idx = *image_of.entry(file.clone()).or_insert_with(|| {
                            let Some(bytes) = files(file) else {
                                notes.push(format!("The texture {file} was not found, so it is left out."));
                                return None;
                            };
                            match image::decode(&bytes) {
                                Ok(img) => {
                                    images.push(img);
                                    image_names.push(file.clone());
                                    u32::try_from(images.len() - 1).ok()
                                }
                                Err(why) => {
                                    notes.push(why.note(file));
                                    None
                                }
                            }
                        });
                        if let Some(image) = idx {
                            let uv = |k: usize| uvs.get(k).copied().unwrap_or([0.0, 0.0]);
                            let wrap = if *clamp { Wrap::Clamp } else { Wrap::Repeat };
                            return Look::Texture {
                                image,
                                uv: [uv(a), uv(b), uv(d)],
                                wrap: (wrap, wrap),
                            };
                        }
                    }
                    m.kd.map_or(Look::None, Look::Color)
                };
                for k in 1..corners.len() - 1 {
                    let tri = [corners[0], corners[k], corners[k + 1]];
                    let look = look_for(&tri, &mut images, &mut image_names, &mut notes, &mut image_of);
                    part.triangles.push(tri.map(|c| c.0));
                    part.looks.push(look);
                }
            }
            _ => {}
        }
    }
    part.positions = positions;
    Ok(TextureSource {
        parts: vec![part],
        images,
        image_names,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_kd_reads_its_options_and_a_name_with_spaces() {
        assert_eq!(map_of(" tex.png"), Some(("tex.png".into(), false)));
        assert_eq!(
            map_of(" -clamp on -s 1 1 1 my tex.png"),
            Some(("my tex.png".into(), true))
        );
        assert_eq!(
            map_of(" -o 0.5 0.5 -bm 0.2 maps\\a.jpg"),
            Some(("maps/a.jpg".into(), false))
        );
        assert_eq!(map_of(" -clamp off"), None);
    }
}
