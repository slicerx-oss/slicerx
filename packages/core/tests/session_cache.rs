// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A prepared session a host keeps ([`api::prepare`], [`api::run_prepared`]) slices any request with the same
//! [`api::session_key`] to the bytes a fresh session gives: G-code, preview and report.

mod common;

use serde_json::{Value, json};
use std::sync::Arc;

use sx_core::api::{self, Mesh, SliceRequest, SliceRun};

/// A binary STL of a wedge: `len` x `wide` mm, `low` mm tall at x = 0 rising to `high` mm at x = `len`.
fn wedge(len: f32, wide: f32, low: f32, high: f32) -> Arc<Mesh> {
    let profile = [(0.0, 0.0), (len, 0.0), (len, high), (0.0, low)];
    let front: Vec<[f32; 3]> = profile.iter().map(|&(x, z)| [x, 0.0, z]).collect();
    let back: Vec<[f32; 3]> = profile.iter().map(|&(x, z)| [x, wide, z]).collect();
    let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
    let mut quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| {
        tris.push([a, b, c]);
        tris.push([a, c, d]);
    };
    quad(front[0], front[1], front[2], front[3]);
    quad(back[3], back[2], back[1], back[0]);
    for i in 0..4 {
        let j = (i + 1) % 4;
        quad(front[j], front[i], back[i], back[j]);
    }
    let mut bytes = vec![0u8; 80];
    bytes.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in &tris {
        bytes.extend_from_slice(&[0u8; 12]);
        for p in t {
            for v in p {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0, 0]);
    }
    Arc::new(Mesh::load(&bytes, "wedge.stl").unwrap())
}

/// An object of a synthetic plate: its id, mesh and transform (None: placed in a row).
type Object = (&'static str, Arc<Mesh>, Option<Vec<f32>>);

/// A plate to slice: its request and its meshes by id.
struct Case {
    name: String,
    req: SliceRequest,
    meshes: Vec<(String, Arc<Mesh>)>,
}

impl Case {
    fn new(name: &'static str, objects: Vec<Object>, config: &Value) -> Self {
        let specs: Vec<Value> = objects
            .iter()
            .enumerate()
            .map(|(k, (id, _, t))| {
                #[allow(clippy::cast_precision_loss, reason = "a few objects")]
                let x = 70.0 + 90.0 * k as f32;
                let t = t.clone().unwrap_or_else(|| {
                    vec![
                        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, 110.0, 0.0, 1.0,
                    ]
                });
                json!({"id": id, "name": id, "mesh": id, "transform": t})
            })
            .collect();
        let req = serde_json::from_value(json!({
            "plate": {"objects": specs},
            "config": common::with_base(config),
            "options": {"flavor": "marlin2", "nowUnix": 1_790_000_000, "nowOffsetMinutes": 0},
        }))
        .unwrap();
        Self {
            name: name.to_owned(),
            req,
            meshes: objects.into_iter().map(|(id, m, _)| (id.to_owned(), m)).collect(),
        }
    }

    /// A CLI request fixture (`packages/core/cli/tests/fixtures`), its meshes loaded whole.
    fn fixture(path: &std::path::Path) -> Option<Self> {
        let raw: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        let req: SliceRequest = serde_json::from_value(raw.clone()).ok()?;
        let dir = path.parent()?;
        let mut meshes = Vec::new();
        for o in &req.plate.objects {
            let id = match &o.mesh {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if meshes.iter().any(|(k, _)| *k == id) {
                continue;
            }
            let file = raw["meshes"][&id].as_str().unwrap_or(&id).to_owned();
            let file = file.split('#').next()?.to_owned();
            let bytes = std::fs::read(dir.join(&file)).ok()?;
            let name = std::path::Path::new(&file).file_name()?.to_str()?.to_owned();
            meshes.push((id, Arc::new(Mesh::load(&bytes, &name).ok()?)));
        }
        Some(Self {
            name: path.file_name()?.to_str()?.to_owned(),
            req,
            meshes,
        })
    }

    fn mesh(&self, id: &str) -> sx_core::Result<Arc<Mesh>> {
        self.meshes
            .iter()
            .find(|(k, _)| *k == id)
            .map(|(_, m)| m.clone())
            .ok_or_else(|| sx_core::Error::Config {
                key: "plate.objects.mesh",
                reason: format!("unknown mesh {id}"),
            })
    }

    fn key(&self, req: &SliceRequest) -> Option<u64> {
        api::session_key(req, &|id| self.mesh(id).ok().map(|m| m.content_hash()))
    }
}

/// The synthetic plates and every CLI request fixture that slices.
fn all_cases(only: Option<&str>) -> Vec<Case> {
    let keep = |name: &str| only.is_none_or(|o| name.contains(o));
    let mut out: Vec<Case> = cases().into_iter().filter(|c| keep(&c.name)).collect();
    let dir = format!("{}/cli/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.to_string_lossy().ends_with("-request.json"))
        .collect();
    files.sort();
    for f in files {
        if !keep(&f.to_string_lossy()) {
            continue;
        }
        if let Some(c) = Case::fixture(&f) {
            let load = |id: &str| c.mesh(id);
            if api::run_request(&c.req, &load).is_ok() {
                out.push(c);
            }
        }
    }
    out
}

fn cases() -> Vec<Case> {
    let overhang = Some(vec![
        1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 128.0, 128.0, 12.0, 1.0,
    ]);
    vec![
        Case::new(
            "bridge wedge",
            vec![("w", wedge(40.0, 30.0, 2.0, 4.0), None)],
            &json!({"layer_height": 0.12, "initial_layer_print_height": 0.12}),
        ),
        Case::new(
            "painted tile",
            vec![("t", Arc::new(common::painted_tile()), None)],
            &json!({"filament_colour": ["#FFFFFF", "#000000", "#FF0000"], "enable_prime_tower": false, "layer_height": 0.1}),
        ),
        Case::new(
            "tree support",
            vec![("s", wedge(30.0, 20.0, 1.0, 12.0), overhang)],
            &json!({"enable_support": true, "support_type": "tree(auto)", "support_threshold_angle": 45}),
        ),
        Case::new(
            "by object",
            vec![
                ("tall", wedge(20.0, 20.0, 6.0, 6.0), None),
                ("short", wedge(20.0, 20.0, 2.0, 2.0), None),
            ],
            &json!({"print_sequence": "by object"}),
        ),
    ]
}

/// What a run gives that a person or host reads: the G-code, the preview and the report without its wall time.
fn output(run: &SliceRun) -> (Vec<u8>, Vec<u8>, Value) {
    let mut report = serde_json::to_value(&run.report).unwrap();
    if let Some(m) = report.as_object_mut() {
        m.remove("wallMs");
        m.remove("stageMicros");
    }
    (run.gcode.clone(), run.preview.clone(), report)
}

/// A value of the setting other than `now`, from its schema entry; None when the type is not swept.
fn other_value(def: &Value, now: &Value) -> Option<Value> {
    let ty = def["type"].as_str()?;
    let num = |v: &Value| -> Option<f64> {
        match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim_end_matches('%').trim().parse().ok(),
            Value::Array(a) => a.first().and_then(|x| match x {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.trim_end_matches('%').trim().parse().ok(),
                _ => None,
            }),
            _ => None,
        }
    };
    let bump = |x: f64| -> f64 {
        let max = def["max"].as_f64().unwrap_or(f64::MAX);
        let min = def["min"].as_f64().unwrap_or(f64::MIN);
        let up = if x == 0.0 { 1.0 } else { x * 1.5 };
        if up <= max { up } else { (x * 0.5).max(min) }
    };
    let base = if now.is_null() {
        def["default"].clone()
    } else {
        now.clone()
    };
    let many = |v: Value| Value::Array(vec![v.clone(), v.clone(), v.clone(), v]);
    Some(match ty {
        "bool" | "bools" => {
            let b = match &base {
                Value::Bool(b) => *b,
                Value::Array(a) => a
                    .first()
                    .is_some_and(|x| x == &json!(true) || x == &json!("1") || x == &json!(1)),
                Value::String(s) => s == "1" || s == "true",
                Value::Number(n) => n.as_f64() != Some(0.0),
                _ => false,
            };
            if ty == "bools" { many(json!(!b)) } else { json!(!b) }
        }
        "float" | "int" => json!(bump(num(&base).unwrap_or(0.0))),
        "floats" | "ints" => many(json!(bump(num(&base).unwrap_or(0.0)))),
        "percent" | "floatOrPercent" => json!(format!("{}%", bump(num(&base).unwrap_or(0.0)))),
        "percents" | "floatsOrPercents" => many(json!(format!("{}%", bump(num(&base).unwrap_or(0.0))))),
        "enum" | "enums" => {
            let values = def["enumValues"].as_array()?;
            let cur = match &base {
                Value::Array(a) => a.first().cloned().unwrap_or(Value::Null),
                v => v.clone(),
            };
            let pick = values.iter().find(|v| **v != cur)?.clone();
            if ty == "enums" { many(pick) } else { pick }
        }
        "gcode" => json!(format!("{}\n; a sweep comment\n", base.as_str().unwrap_or(""))),
        _ => return None,
    })
}

fn schema() -> Vec<Value> {
    let path = format!("{}/../settings/schema.json", env!("CARGO_MANIFEST_DIR"));
    let s: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    s["settings"].as_array().unwrap().clone()
}

/// For every setting in `keys`: the same session key, and a kept session gives a fresh one's output. Returns the
/// settings that failed, and how many runs it compared.
fn sweep(keys: &[&str]) -> (Vec<String>, usize) {
    let defs = schema();
    let mut failed = Vec::new();
    let mut compared = 0;
    // SX_SWEEP_CASE (a part of a plate's name) and SX_SWEEP_PART (`i/n`, the i-th of n slices of the settings) run a
    // piece of the sweep, so a long one goes in short runs.
    let only = std::env::var("SX_SWEEP_CASE").ok();
    let part = std::env::var("SX_SWEEP_PART").ok().and_then(|p| {
        p.split_once('/')
            .and_then(|(i, n)| Some((i.parse::<usize>().ok()?, n.parse::<usize>().ok()?)))
    });
    let keys: Vec<&str> = match part {
        Some((i, n)) if n > 0 => keys
            .iter()
            .enumerate()
            .filter(|(k, _)| k % n == i)
            .map(|(_, k)| *k)
            .collect(),
        _ => keys.to_vec(),
    };
    for case in all_cases(only.as_deref()) {
        let load = |id: &str| case.mesh(id);
        let prepared = api::prepare(&case.req, &load).unwrap();
        let key_a = case.key(&case.req);
        // A kept session has sliced before.
        api::run_prepared(&case.req, &prepared, &sx_core::NoProgress).unwrap();
        for k in &keys {
            let Some(def) = defs.iter().find(|d| d["key"] == json!(k)) else {
                failed.push(format!("{k}: not in the settings schema"));
                continue;
            };
            let mut req = case.req.clone();
            let now = req.config.get(*k).cloned().unwrap_or(Value::Null);
            let Some(v) = other_value(def, &now) else { continue };
            req.config[*k] = v;
            if case.key(&req) != key_a {
                failed.push(format!("{k} ({}): the session key changed", case.name));
                continue;
            }
            let Ok(fresh) = api::run_request(&req, &load) else {
                continue;
            };
            let kept = api::run_prepared(&req, &prepared, &sx_core::NoProgress);
            compared += 1;
            match kept {
                Ok(kept) if output(&kept) == output(&fresh) => {}
                Ok(_) => failed.push(format!("{k} ({}): a kept session gives other output", case.name)),
                Err(e) => failed.push(format!("{k} ({}): a kept session fails: {e}", case.name)),
            }
        }
    }
    (failed, compared)
}

/// Every setting the key leaves out, one at a time on every plate. Long: run it after changing the list.
#[test]
#[ignore = "about every setting on every plate; run by hand after changing SESSION_FREE_KEYS"]
fn every_free_setting_keeps_the_session() {
    let (failed, compared) = sweep(api::SESSION_FREE_KEYS);
    assert!(
        failed.is_empty(),
        "{} of {compared} failed:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

/// The plates the CI checks run on: the synthetic ones and two multi-filament fixtures.
fn ci_cases() -> Vec<Case> {
    let mut out = cases();
    for name in ["colors-request.json", "features-request.json"] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("cli/tests/fixtures")
            .join(name);
        out.push(Case::fixture(&path).unwrap());
    }
    out
}

/// A kept session (that has sliced once) against a fresh one for `req`.
fn kept_is_fresh(case: &Case, prepared: &api::Prepared, req: &SliceRequest) -> Result<(), String> {
    let load = |id: &str| case.mesh(id);
    let fresh = api::run_request(req, &load).map_err(|e| format!("fresh: {e}"))?;
    let kept = api::run_prepared(req, prepared, &sx_core::NoProgress).map_err(|e| format!("kept: {e}"))?;
    if output(&kept) == output(&fresh) {
        Ok(())
    } else {
        Err("a kept session gives other output".to_owned())
    }
}

#[test]
fn a_repeat_and_any_layer_ranges_on_a_kept_session_give_a_fresh_ones_bytes() {
    for case in ci_cases() {
        let load = |id: &str| case.mesh(id);
        let prepared = api::prepare(&case.req, &load).unwrap();
        api::run_prepared(&case.req, &prepared, &sx_core::NoProgress).unwrap();
        // The same plate a second later: the same key (the clock is not part of it).
        let mut later = case.req.clone();
        later.options.now_unix = Some(1_790_000_001);
        assert_eq!(case.key(&later), case.key(&case.req), "{}", case.name);
        kept_is_fresh(&case, &prepared, &later)
            .unwrap_or_else(|e| panic!("{} a second later: {e}", case.name));
        for shards in [1, 4, 8] {
            let mut req = case.req.clone();
            req.options.shards = Some(shards);
            assert_eq!(case.key(&req), case.key(&case.req), "{}", case.name);
            kept_is_fresh(&case, &prepared, &req)
                .unwrap_or_else(|e| panic!("{} in {shards} ranges: {e}", case.name));
        }
    }
}

#[test]
fn a_setting_of_each_class_keeps_or_replaces_the_session_as_it_should() {
    let defs = schema();
    // One setting of each class the schema names (`invalidates`): the G-code and preview ones keep the session (and
    // slice as a fresh one), the others give another key.
    let picks = [
        ("layers", "layer_height"),
        ("contours", "slice_closing_radius"),
        ("surfaces", "top_shell_layers"),
        ("perimeters", "wall_loops"),
        ("infill", "sparse_infill_density"),
        ("paths", "seam_position"),
        ("gcode", "close_fan_the_first_x_layers"),
        ("preview", "thumbnails_format"),
    ];
    for case in ci_cases() {
        let load = |id: &str| case.mesh(id);
        let prepared = api::prepare(&case.req, &load).unwrap();
        api::run_prepared(&case.req, &prepared, &sx_core::NoProgress).unwrap();
        for (class, key) in picks {
            let def = defs.iter().find(|d| d["key"] == json!(key)).unwrap();
            assert_eq!(def["invalidates"], json!(class), "{key} is a {class} setting");
            let mut req = case.req.clone();
            let now = req.config.get(key).cloned().unwrap_or(Value::Null);
            req.config[key] = other_value(def, &now).unwrap();
            let free = api::SESSION_FREE_KEYS.contains(&key);
            assert_eq!(free, matches!(class, "gcode" | "preview"), "{key}");
            if free {
                assert_eq!(case.key(&req), case.key(&case.req), "{key} ({})", case.name);
                kept_is_fresh(&case, &prepared, &req)
                    .unwrap_or_else(|e| panic!("{key} ({}): {e}", case.name));
            } else {
                assert_ne!(case.key(&req), case.key(&case.req), "{key} ({})", case.name);
            }
        }
    }
}

/// Every setting the key leaves out, changed together in groups: a kept session still slices as a fresh one. The
/// setting by setting sweep (`every_free_setting_keeps_the_session`, by hand) says which one when a group fails.
#[test]
fn the_free_settings_changed_in_groups_keep_the_session() {
    let defs = schema();
    for case in ci_cases() {
        let load = |id: &str| case.mesh(id);
        let prepared = api::prepare(&case.req, &load).unwrap();
        api::run_prepared(&case.req, &prepared, &sx_core::NoProgress).unwrap();
        for group in api::SESSION_FREE_KEYS.chunks(60) {
            let mut req = case.req.clone();
            for key in group {
                let Some(def) = defs.iter().find(|d| d["key"] == json!(key)) else {
                    continue;
                };
                let now = req.config.get(*key).cloned().unwrap_or(Value::Null);
                if let Some(v) = other_value(def, &now) {
                    req.config[*key] = v;
                }
            }
            assert_eq!(case.key(&req), case.key(&case.req), "{}", case.name);
            // A group whose values do not slice together is no test of the session.
            if api::run_request(&req, &load).is_err() {
                continue;
            }
            kept_is_fresh(&case, &prepared, &req).unwrap_or_else(|e| {
                panic!(
                    "{} with {} to {}: {e}",
                    case.name,
                    group[0],
                    group[group.len() - 1]
                )
            });
        }
    }
}

/// The process's resident memory in MB (`ps`).
/// The host keys kept meshes on [`Mesh::content_hash`], which reads the paint texts: the painted tile and the same
/// tile with no paint must hash apart, or a kept session of one would slice the other.
#[test]
fn the_painted_tile_and_the_plain_tile_hash_apart() {
    let painted = common::painted_tile();
    let mut plain = painted.clone();
    for p in &mut plain.parts {
        p.paint.clear();
        p.paint_texts.clear();
    }
    assert!(painted.parts.iter().any(|p| !p.paint_texts.is_empty()));
    assert_ne!(painted.content_hash(), plain.content_hash());
}

fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(0.0)
        / 1024.0
}

/// Memory with and without a kept session, on request files given by hand: `SX_MEM_REQUESTS` lists CLI request
/// files (comma-separated), `SX_MEM_KEEP=1` keeps each one's session. Run once with each and compare the resident
/// memory it prints (a process's allocator keeps freed pages, so the two runs go in separate processes).
#[test]
#[ignore = "measures memory on request files given by hand"]
fn memory_of_kept_sessions() {
    let Ok(list) = std::env::var("SX_MEM_REQUESTS") else {
        return;
    };
    let keep = std::env::var("SX_MEM_KEEP").is_ok_and(|v| v == "1");
    let cases: Vec<Case> = list
        .split(',')
        .filter_map(|p| Case::fixture(std::path::Path::new(p)))
        .collect();
    eprintln!("MEM meshes loaded: {:.0} MB", rss_mb());
    let mut kept = Vec::new();
    for case in &cases {
        let load = |id: &str| case.mesh(id);
        if keep {
            let prepared = api::prepare(&case.req, &load).unwrap();
            api::run_prepared(&case.req, &prepared, &sx_core::NoProgress).unwrap();
            kept.push(prepared);
        } else {
            api::run_request(&case.req, &load).unwrap();
        }
        eprintln!(
            "MEM {} sliced, {}: {:.0} MB",
            case.name,
            if keep { "session kept" } else { "nothing kept" },
            rss_mb()
        );
    }
    drop(kept);
}
