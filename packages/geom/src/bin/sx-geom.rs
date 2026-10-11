// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-geom <operation> [--out-dir DIR] < request.json > response.json`; `sx-geom --version` prints the version.
//!
//! meshes come back as base64 stl (`stlBase64`), or with `--out-dir` as stl files (`stlPath`). `format.read3mf`
//! reads a 3mf named by `{"data":{"path":"file.3mf"}}` this way: each part's mesh in its object's space.

use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use sx_geom::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Which build this is, for a host checking the binary it ships or finds: a plain line, not JSON.
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        println!("sx-geom {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let code = match run(&args) {
        Ok(out) => {
            println!("{out}");
            0
        }
        Err(e) => {
            println!("{}", json::error_value(&e));
            1
        }
    };
    std::process::exit(code);
}

fn run(args: &[String]) -> sx_geom::Result<Value> {
    let Some(op) = args.first() else {
        return Err(sx_geom::Error::invalid_arg(
            "usage: sx-geom <operation> [--out-dir DIR] < request.json",
        ));
    };
    if op == "ops" || op == "--help" || op == "-h" {
        return Ok(Value::from(json::operations()));
    }
    let out_dir = args
        .iter()
        .position(|a| a == "--out-dir")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| sx_geom::Error::invalid_arg(format!("stdin: {e}")))?;
    let mut req: Value = serde_json::from_str(&input).map_err(|e| sx_geom::Error::Json(e.to_string()))?;
    if out_dir.is_some()
        && let Some(obj) = req.as_object_mut()
    {
        obj.insert("meshOutput".to_owned(), Value::from("stlBase64"));
        // A picture asked for with an output folder is written there as a PNG file.
        if op == "render" {
            obj.insert("image".to_owned(), Value::from(true));
        }
    }
    let loader = |p: &str| -> sx_geom::Result<Vec<u8>> {
        std::fs::read(p).map_err(|e| sx_geom::Error::invalid_arg(format!("{p}: {e}")))
    };
    let mut out = json::call_value(op, &req, &loader)?;
    // meshes the call wrote as buffers (`rawOut`, a 3mf's parts) leave as stl like the rest
    let mut files: Vec<Option<json::OutFile>> = json::take_out_files().into_iter().map(Some).collect();
    raw_meshes(&mut out, &mut files)?;
    if let Some(dir) = out_dir {
        std::fs::create_dir_all(&dir)
            .map_err(|e| sx_geom::Error::invalid_arg(format!("{}: {e}", dir.display())))?;
        let mut n = 0usize;
        write_meshes(&mut out, &dir, op, &mut n)?;
        if let Some(obj) = out.as_object_mut()
            && let Some(png) = obj.remove("pngBase64")
        {
            let bytes = png
                .as_str()
                .and_then(json::base64_decode)
                .ok_or_else(|| sx_geom::Error::invalid_arg("the picture did not decode"))?;
            let path = dir.join(format!("{}.png", op.replace('.', "-")));
            std::fs::write(&path, bytes)
                .map_err(|e| sx_geom::Error::invalid_arg(format!("{}: {e}", path.display())))?;
            obj.insert("pngPath".to_owned(), Value::from(path.display().to_string()));
        }
    }
    Ok(out)
}

fn stl(mesh: &sx_geom::TriMesh) -> Value {
    Value::from(json::base64_encode(&mesh.to_stl("sx-geom")))
}

/// the paint buffer (`format.read3mf`) as json: per layer, `[triangle, code]` pairs
fn paint(bytes: &[u8]) -> Value {
    let mut at = 0usize;
    let u32_at = |at: &mut usize| -> u32 {
        let v = bytes
            .get(*at..*at + 4)
            .and_then(|b| b.try_into().ok())
            .map_or(0, u32::from_le_bytes);
        *at += 4;
        v
    };
    let mut out = serde_json::Map::new();
    for layer in ["color", "seam", "support", "fuzzy"] {
        let n = u32_at(&mut at);
        let mut list = Vec::new();
        for _ in 0..n {
            let t = u32_at(&mut at);
            let len = usize::try_from(u32_at(&mut at)).unwrap_or(0);
            let code = bytes
                .get(at..at + len)
                .map(String::from_utf8_lossy)
                .unwrap_or_default();
            at += len;
            list.push(serde_json::json!([t, code]));
        }
        out.insert(layer.to_owned(), Value::Array(list));
    }
    Value::Object(out)
}

fn raw_meshes(v: &mut Value, files: &mut [Option<json::OutFile>]) -> sx_geom::Result<()> {
    let mut take = |n: Option<u64>| {
        n.and_then(|n| usize::try_from(n).ok())
            .and_then(|n| files.get_mut(n))
            .and_then(Option::take)
    };
    match v {
        Value::Object(map) => {
            if let Some(json::OutFile::Bytes(bytes)) = take(map.get("rawOut").and_then(Value::as_u64)) {
                let mesh = sx_geom::TriMesh::from_raw(&bytes, "out")?;
                map.remove("rawOut");
                map.insert("stlBase64".to_owned(), stl(&mesh));
                return Ok(());
            }
            if let Some(json::OutFile::Bytes(bytes)) = take(map.get("rawBytes").and_then(Value::as_u64)) {
                let decoded = paint(&bytes);
                *v = decoded;
                return Ok(());
            }
            let positions = take(map.get("positionsOut").and_then(Value::as_u64));
            let triangles = take(map.get("trianglesOut").and_then(Value::as_u64));
            if let (Some(json::OutFile::Positions(p)), Some(json::OutFile::Triangles(t))) =
                (positions, triangles)
            {
                let positions = p.iter().map(|c| c.map(f64::from)).collect();
                map.remove("positionsOut");
                map.remove("trianglesOut");
                map.insert("stlBase64".to_owned(), stl(&sx_geom::TriMesh::new(positions, t)));
            }
            for (_, child) in map.iter_mut() {
                raw_meshes(child, files)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                raw_meshes(child, files)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn write_meshes(v: &mut Value, dir: &Path, op: &str, n: &mut usize) -> sx_geom::Result<()> {
    match v {
        Value::Object(map) => {
            if let Some(Value::String(b64)) = map.get("stlBase64") {
                let bytes = json::base64_decode(b64).unwrap_or_default();
                *n += 1;
                let path = dir.join(format!("{}-{n}.stl", op.replace('.', "-")));
                std::fs::File::create(&path)
                    .and_then(|mut f| f.write_all(&bytes))
                    .map_err(|e| sx_geom::Error::invalid_arg(format!("{}: {e}", path.display())))?;
                map.remove("stlBase64");
                map.insert("stlPath".to_owned(), Value::from(path.display().to_string()));
                return Ok(());
            }
            for (_, child) in map.iter_mut() {
                write_meshes(child, dir, op, n)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                write_meshes(child, dir, op, n)?;
            }
        }
        _ => {}
    }
    Ok(())
}
