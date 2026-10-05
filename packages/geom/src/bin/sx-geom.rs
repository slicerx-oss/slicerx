// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-geom <operation> [--out-dir DIR] < request.json > response.json`

use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use sx_geom::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
        return Ok(Value::from(json::OPERATIONS.to_vec()));
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
    }
    let loader = |p: &str| -> sx_geom::Result<Vec<u8>> {
        std::fs::read(p).map_err(|e| sx_geom::Error::invalid_arg(format!("{p}: {e}")))
    };
    let mut out = json::call_value(op, &req, &loader)?;
    if let Some(dir) = out_dir {
        std::fs::create_dir_all(&dir)
            .map_err(|e| sx_geom::Error::invalid_arg(format!("{}: {e}", dir.display())))?;
        let mut n = 0usize;
        write_meshes(&mut out, &dir, op, &mut n)?;
    }
    Ok(out)
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
