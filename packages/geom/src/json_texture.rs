// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `paint.texture` for the json api: color paint for parts from the texture of the model they came from.
//!
//! Request: `source` is `{ obj: { base64 | text | path }, files: { name: base64 } }` (the MTL and images by the names
//! the OBJ and MTL give them; with a path they are read beside the OBJ) or `{ threemf: { base64 | path } }`; `parts`
//! the meshes on the plate, in the file's coordinates; `filaments` the slot colors (`#rrggbb`, slot 1 first);
//! optional `mode` (`nearest` or `palette`), `minEdgeMm`, `maxDepth`, `maxLeaves`, `scale` and `paintEvery` (part
//! indices whose paint keeps every filament, the one with the most area too).
//! Reply: per part its `slot` (the filament with the most area) and `paint` (texts by triangle), area per slot,
//! the slots used, the palette in palette mode, and notes.

use crate::error::{Error, Result};
use crate::json::{FileLoader, base64_decode, field, field_or, mesh_value};
use crate::mesh::TriMesh;
use crate::texture::{self, Mode, Options, TextureSource};
use serde_json::{Value, json};
use std::collections::HashMap;

fn hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

fn color_of(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let byte = |i: usize| h.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok());
    Some([byte(0)?, byte(2)?, byte(4)?])
}

/// A file name an OBJ or MTL gives, safe to read beside it: no parent steps and no absolute path.
fn plain_name(n: &str) -> Option<String> {
    let n = n.trim().replace('\\', "/");
    let bad = n.is_empty() || n.starts_with('/') || n.contains(':') || n.split('/').any(|s| s == "..");
    (!bad).then_some(n)
}

fn bytes_of(v: &Value, key: &'static str, files: FileLoader<'_>) -> Result<(Vec<u8>, Option<String>)> {
    if let Some(p) = v.get("path").and_then(Value::as_str) {
        return Ok((files(p)?, Some(p.to_owned())));
    }
    if let Some(b) = v.get("base64").and_then(Value::as_str) {
        return Ok((
            base64_decode(b).ok_or_else(|| Error::invalid(key, "bad base64"))?,
            None,
        ));
    }
    if let Some(t) = v.get("text").and_then(Value::as_str) {
        return Ok((t.as_bytes().to_vec(), None));
    }
    Err(Error::invalid(key, "give a path, base64 or text"))
}

fn source(req: &Value, files: FileLoader<'_>) -> Result<TextureSource> {
    let s = req
        .get("source")
        .ok_or_else(|| Error::invalid("source", "missing"))?;
    if let Some(o) = s.get("obj") {
        let (bytes, path) = bytes_of(o, "obj", files)?;
        let given: HashMap<String, Vec<u8>> = match s.get("files").and_then(Value::as_object) {
            Some(m) => m
                .iter()
                .filter_map(|(k, v)| Some((k.replace('\\', "/"), base64_decode(v.as_str()?)?)))
                .collect(),
            None => HashMap::new(),
        };
        // the OBJ's own folder when it came by path ("" for a bare name)
        let dir = path.as_deref().map(|p| {
            p.replace('\\', "/")
                .rsplit_once('/')
                .map_or_else(String::new, |(d, _)| d.to_owned())
        });
        let loader = |n: &str| -> Option<Vec<u8>> {
            let n = plain_name(n)?;
            if let Some(b) = given.get(&n) {
                return Some(b.clone());
            }
            // a file picked beside the OBJ is known by its own name only
            let base = n.rsplit('/').next().unwrap_or(&n);
            if let Some(b) = given.get(base) {
                return Some(b.clone());
            }
            let d = dir.as_ref()?;
            files(&if d.is_empty() { n } else { format!("{d}/{n}") }).ok()
        };
        let name = path.as_deref().unwrap_or("model.obj");
        return texture::obj::read(&bytes, name, &loader);
    }
    if let Some(t) = s.get("threemf") {
        #[cfg(feature = "formats")]
        {
            let (bytes, _) = bytes_of(t, "threemf", files)?;
            return crate::format::texture3mf::read(&bytes);
        }
        #[cfg(not(feature = "formats"))]
        {
            let _ = t;
            return Err(Error::invalid("threemf", "this build leaves out 3MF projects"));
        }
    }
    Err(Error::invalid("source", "give obj or threemf"))
}

/// `paint.texture`
pub(crate) fn paint_texture_op(req: &Value, files: FileLoader<'_>) -> Result<Value> {
    let src = source(req, files)?;
    let parts: Vec<TriMesh> = req
        .get("parts")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::invalid("parts", "a list of meshes"))?
        .iter()
        .map(|v| mesh_value(v, "parts", files))
        .collect::<Result<_>>()?;
    let filaments: Vec<String> = field(req, "filaments")?;
    let filaments = filaments
        .iter()
        .map(|c| color_of(c).ok_or_else(|| Error::invalid("filaments", format!("{c} is not #rrggbb"))))
        .collect::<Result<Vec<_>>>()?;
    if filaments.is_empty() || filaments.len() > usize::from(crate::paint_tree::MAX_STATE) {
        return Err(Error::invalid("filaments", "1 to 32 colors"));
    }
    let mode: String = field_or(req, "mode", "nearest".to_owned())?;
    let mode = match mode.as_str() {
        "nearest" => Mode::Nearest,
        "palette" => Mode::Palette,
        other => {
            return Err(Error::invalid(
                "mode",
                format!("{other} is not nearest or palette"),
            ));
        }
    };
    let d = Options::default();
    let opts = Options {
        filaments,
        mode,
        min_edge_mm: field_or(req, "minEdgeMm", d.min_edge_mm)?.clamp(0.05, 50.0),
        max_depth: field_or(req, "maxDepth", d.max_depth)?.min(10),
        max_leaves: field_or(req, "maxLeaves", d.max_leaves)?.clamp(1, 8_000_000),
        scale: field_or(req, "scale", d.scale)?,
        paint_every: field_or(req, "paintEvery", Vec::new())?,
    };
    if !(opts.scale.is_finite() && opts.scale > 0.0) {
        return Err(Error::invalid("scale", "a positive number"));
    }
    let images: Vec<Value> = src
        .images
        .iter()
        .zip(&src.image_names)
        .map(|(img, n)| {
            let (w, h) = img.size();
            json!({ "name": n, "width": w, "height": h, "fileWidth": img.file_size.0, "fileHeight": img.file_size.1 })
        })
        .collect();
    if !src.has_looks() {
        return Ok(json!({
            "textured": false,
            "parts": parts.iter().map(|_| json!({ "slot": Value::Null, "paint": {}, "painted": 0 })).collect::<Vec<_>>(),
            "slots": [],
            "colors": [],
            "palette": [],
            "leaves": 0,
            "images": images,
            "notes": src.notes,
        }));
    }
    let out = texture::paint(&src, &parts, &opts)?;
    let used: Vec<usize> = out
        .area_mm2
        .iter()
        .enumerate()
        .filter(|(_, a)| **a > 1e-9)
        .map(|(i, _)| i + 1)
        .collect();
    Ok(json!({
        "textured": true,
        "parts": out.parts.iter().map(|p| json!({
            "slot": p.slot,
            "paint": p.paint.iter().map(|(k, v)| (k.to_string(), Value::from(v.clone()))).collect::<serde_json::Map<_, _>>(),
            "painted": p.paint.len(),
        })).collect::<Vec<_>>(),
        "slots": out.area_mm2.iter().enumerate().filter(|(_, a)| **a > 1e-9).map(|(i, a)| json!({ "slot": i + 1, "areaMm2": (a * 100.0).round() / 100.0 })).collect::<Vec<_>>(),
        "colors": used,
        "palette": out.palette.iter().map(|c| hex(*c)).collect::<Vec<_>>(),
        "leaves": out.leaves,
        "minEdgeMm": out.min_edge_mm,
        "matched": { "same": out.matched.same, "nearest": out.matched.nearest },
        "images": images,
        "notes": out.notes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::base64_encode;

    fn no_files(p: &str) -> Result<Vec<u8>> {
        Err(Error::invalid("path", p.to_owned()))
    }

    /// A 10 mm square in z = 0, uv 0 to 1, with the quadrant PNG.
    fn obj() -> (&'static str, &'static str, Vec<u8>) {
        let obj = "mtllib q.mtl\nv 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl tex\nf 1/1 2/2 3/3 4/4\n";
        let mtl = "newmtl tex\nKd 1 1 1\nmap_Kd q.png\n";
        // 2 x 2: red, green on top; blue, white below
        let png =
            crate::texture::tests::png_rgb(2, 2, &[230, 20, 30, 20, 200, 40, 20, 40, 220, 245, 245, 245]);
        (obj, mtl, png)
    }

    fn square() -> Value {
        json!({ "positions": [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], "indices": [0, 1, 2, 0, 2, 3] })
    }

    #[test]
    fn an_obj_with_its_mtl_and_png_paints_four_quarters() {
        let (o, mtl, png) = obj();
        let req = json!({
            "source": { "obj": { "text": o }, "files": { "q.mtl": base64_encode(mtl.as_bytes()), "q.png": base64_encode(&png) } },
            "parts": [square()],
            "filaments": ["#f5f5f5", "#e6141e", "#14c828", "#1428dc"],
        });
        let out = paint_texture_op(&req, &no_files).unwrap();
        assert_eq!(out["textured"], true);
        assert_eq!(out["colors"], json!([1, 2, 3, 4]));
        for s in out["slots"].as_array().unwrap() {
            assert!((s["areaMm2"].as_f64().unwrap() - 25.0).abs() < 1.0, "{s}");
        }
        assert_eq!(out["parts"][0]["painted"], 2);
        assert_eq!(out["images"][0]["name"], "q.png");
    }

    #[test]
    fn a_missing_png_says_so_and_paints_the_material_color() {
        let (o, mtl, _) = obj();
        let req = json!({
            "source": { "obj": { "text": o }, "files": { "q.mtl": base64_encode(mtl.as_bytes()) } },
            "parts": [square()],
            "filaments": ["#000000", "#ffffff"],
        });
        let out = paint_texture_op(&req, &no_files).unwrap();
        assert_eq!(out["colors"], json!([2]));
        assert_eq!(out["parts"][0]["slot"], 2);
        assert!(out["notes"][0].as_str().unwrap().contains("q.png"));
    }

    #[test]
    fn an_obj_without_materials_is_not_textured_and_bad_input_is_refused() {
        let req = json!({ "source": { "obj": { "text": "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n" } }, "parts": [square()], "filaments": ["#ffffff"] });
        assert_eq!(paint_texture_op(&req, &no_files).unwrap()["textured"], false);
        let (o, mtl, png) = obj();
        let files = json!({ "q.mtl": base64_encode(mtl.as_bytes()), "q.png": base64_encode(&png) });
        let base = |extra: Value| {
            let mut r = json!({ "source": { "obj": { "text": o }, "files": files }, "parts": [square()], "filaments": ["#ffffff"] });
            for (k, v) in extra.as_object().unwrap() {
                r[k] = v.clone();
            }
            r
        };
        assert!(paint_texture_op(&base(json!({ "filaments": [] })), &no_files).is_err());
        assert!(paint_texture_op(&base(json!({ "filaments": ["red"] })), &no_files).is_err());
        assert!(paint_texture_op(&base(json!({ "mode": "dither" })), &no_files).is_err());
        assert!(paint_texture_op(&base(json!({ "scale": 0 })), &no_files).is_err());
    }

    #[test]
    fn filaments_above_16_paint_and_write_18_as_0fc() {
        fn states(n: &crate::paint_tree::Node, out: &mut Vec<u8>) {
            match n {
                crate::paint_tree::Node::Leaf(s) => out.push(*s),
                crate::paint_tree::Node::Split { kids, .. } => kids.iter().for_each(|k| states(k, out)),
            }
        }
        let (o, mtl, png) = obj();
        // 1 to 16 gray, the quadrants' colors on 17 to 20
        let mut filaments = vec!["#808080"; 16];
        filaments.extend(["#e6141e", "#14c828", "#1428dc", "#f5f5f5"]);
        let req = json!({
            "source": { "obj": { "text": o }, "files": { "q.mtl": base64_encode(mtl.as_bytes()), "q.png": base64_encode(&png) } },
            "parts": [square()],
            "filaments": filaments,
        });
        let out = paint_texture_op(&req, &no_files).unwrap();
        assert_eq!(out["colors"], json!([17, 18, 19, 20]));
        let slot = out["parts"][0]["slot"].as_u64().unwrap();
        let texts: Vec<&str> = out["parts"][0]["paint"]
            .as_object()
            .unwrap()
            .values()
            .filter_map(Value::as_str)
            .collect();
        let mut got = vec![u8::try_from(slot).unwrap()];
        for t in &texts {
            states(&crate::paint_tree::parse(t).unwrap(), &mut got);
        }
        got.retain(|&s| s != 0);
        got.sort_unstable();
        got.dedup();
        assert_eq!(got, [17, 18, 19, 20], "{texts:?}");
        if slot != 18 {
            assert!(texts.iter().any(|t| t.contains("0FC")), "{texts:?}");
        }
        let mut too_many = req;
        too_many["filaments"] = json!(vec!["#808080"; 33]);
        assert!(paint_texture_op(&too_many, &no_files).is_err());
    }

    #[test]
    fn an_image_that_is_not_one_is_left_out_in_a_sentence() {
        let (o, mtl, _) = obj();
        let req = json!({
            "source": { "obj": { "text": o }, "files": { "q.mtl": base64_encode(mtl.as_bytes()), "q.png": base64_encode(b"not an image") } },
            "parts": [square()],
            "filaments": ["#000000", "#ffffff"],
        });
        let out = paint_texture_op(&req, &no_files).unwrap();
        assert_eq!(
            out["notes"],
            json!(["The texture q.png is not a PNG or JPEG image, so it is left out."])
        );
    }

    #[test]
    fn names_with_parent_steps_or_drives_are_never_read() {
        assert_eq!(plain_name("tex/a.png").as_deref(), Some("tex/a.png"));
        assert_eq!(plain_name("tex\\a.png").as_deref(), Some("tex/a.png"));
        assert!(plain_name("../secret.png").is_none());
        assert!(plain_name("/etc/x.png").is_none());
        assert!(plain_name("C:/x.png").is_none());
    }
}
