// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx: slice from the command line and run the slicing benchmark.
//!
//! sx slice <model> [--plate N] [--config <json>] [--no-project-settings] [-o out.gcode | -o -] [--preview out.sxpv]
//!          [--allow-collisions] [--strict]
//! sx time <file.gcode> --config <json> [--trace [--at <line prefix>] | --json]
//! sx slice --request <req.json | -> [--out-dir <dir>] [--allow-collisions] [--strict]
//! sx schema [request | result]
//! script recognition: --script-printer <model-id> --script-firmware <flavor>
//! sx --version
//! sx metadata <project.3mf>
//! sx call [server options] <tool> [json] [<tool> [json] ...]
//! sx canonical-script <file | -> [--batch]
//! sx review-script <request.json | -> [--batch]
//! sx bench --config <bench.json> [--runs 15] [--warmup 3] [--threads N]
//!          [--append <results.jsonl>] [--change <text>] [--ab <baseline sx>]
//!          [--write-baseline] [--json]
//!
//! `sx slice <model>` writes the G-code to `-o`, or to stdout without it; the
//! one-line summary and warnings go to stderr. A Bambu Studio or `OrcaSlicer`
//! project slices with its own settings (`Metadata/project_settings.config`,
//! and each object's own), except our engine choices the project did not
//! change (`packages/settings/engine-choices.json`); `--config` goes over them,
//! and `--no-project-settings` leaves them out. What the settings set that the
//! engine does not use is listed on stderr, and `--strict` refuses the slice
//! over it (exit code 3). A 3MF slices as the build items of its first plate (`--plate N` picks another), each an
//! object of its own with its own label, as a request and the app slice it; the same collision and clearance check
//! as `--request` refuses the slice where it finds a collision (exit code 3), unless `--allow-collisions` asks for it
//! anyway.
//!
//! `sx slice --request` reads a `SliceRequest` JSON (`sx schema request`) from
//! a file or stdin and prints a result JSON (`sx schema result`) with
//! `schemaVersion` on stdout. Object `mesh` values are keys of an optional
//! top-level `meshes` map (reference to file path) or file paths themselves,
//! relative to the request file; `file.3mf#2` picks plate 2 of a project.
//! With `--out-dir`, the G-code and SXPV are
//! written there as `slice.gcode` and `slice.sxpv`. A by-object plate where the head, gantry or tool changer would meet
//! a printed part, and any plate where two objects' paths cross or a path enters an exclusion area (the result's
//! `collisions`), is refused with exit code 3, unless `--allow-collisions` asks for it anyway; close calls inside the
//! profile's clearance radius pass with the result listing them.
//!
//! Exit codes: 0 success, 1 slicing failed, 2 usage error, 3 invalid input
//! (unreadable request or mesh, bad JSON or config).
//!
//! Custom G-code in the settings is linted as untrusted unless the request sets
//! `trustedGcode`. Text that is the printer maker's stock text, unchanged, for
//! the printer the settings name runs as trusted either way (stock.rs).

#[cfg(feature = "stock-gcode")]
mod fingerprint;
#[cfg(feature = "stock-gcode")]
mod stock;
mod tool_call;

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;
use sx_core::validate::validate_gcode;
use sx_core::{Mesh, Plate, PrintConfig, SliceOutput, SliceSession, preview};

// jemalloc on every target it builds for, with its page decay per operating system: it gives the pages a slice frees
// back to the system.
use sx_alloc as _;

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// A white-label edition's name for the text sx prints, from the resolved edition config `SLICERX_CONFIG` names (the
/// file the MCP server and the cloud service read too). Without one it says `SlicerX`.
fn edition_name() -> Option<String> {
    let path = std::env::var_os("SLICERX_CONFIG")?;
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let name = config.pointer("/brand/name")?.as_str()?.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

fn main() -> ExitCode {
    if let Some(name) = edition_name() {
        sx_core::api::set_app_name(&name);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("slice") if has(&args, "--request") => return cmd_request(&args[1..]),
        Some("slice") => cmd_slice(&args[1..]),
        Some("schema") => return cmd_schema(&args[1..]),
        Some("metadata") => cmd_metadata(&args[1..]),
        Some("bench") => cmd_bench(&args[1..]),
        Some("time") => cmd_time(&args[1..]),
        Some("call") => tool_call::run(&args[1..]),
        Some("canonical-script") => cmd_canonical_script(&args[1..]),
        Some("review-script") => cmd_review_script(&args[1..]),
        Some("prepare-script-replacement") => cmd_prepare_script_replacement(&args[1..]),
        // Which engine this is, for a host checking the binary it ships or finds.
        Some("--version" | "-V") => {
            println!("sx {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        _ => {
            eprintln!(
                "usage: sx --version\n       sx call [server options] <tool> [json] [<tool> [json] ...]\n       sx metadata <project.3mf>\n       sx canonical-script <file | -> [--batch]\n       sx review-script <request.json | -> [--batch]\n       sx prepare-script-replacement <request.json | -> [--batch]\n       sx slice <model> [--plate N] [--config <json>] [--no-project-settings] [-o out.gcode] [--preview out.sxpv] [--allow-collisions] [--strict]\n       sx slice --request <req.json | -> [--out-dir <dir>] [--allow-collisions] [--strict]\n       sx schema [request | result]\n       sx bench --config <bench.json> [--runs N] [--warmup N] [--threads N] [--append file] [--change text] [--ab <baseline sx>] [--write-baseline] [--json]\n       sx time <file.gcode> --config <json> [--trace [--at <line prefix>] | --json]\n       script recognition: --script-printer <model-id> --script-firmware <flavor>"
            );
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("sx: {e}");
            ExitCode::FAILURE
        }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn script_target(args: &[String]) -> Res<Option<sx_core::script_review::Identity>> {
    match (flag(args, "--script-printer"), flag(args, "--script-firmware")) {
        (None, None) if !has(args, "--script-printer") && !has(args, "--script-firmware") => Ok(None),
        (Some(model), Some(firmware)) if !model.trim().is_empty() && !firmware.trim().is_empty() => {
            Ok(Some(sx_core::script_review::Identity {
                model: model.into(),
                firmware: firmware.into(),
            }))
        }
        _ => Err(
            "script review requires both --script-printer <model-id> and --script-firmware <flavor>".into(),
        ),
    }
}

const EXIT_SLICE: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_INPUT: u8 = 3;

fn cmd_review_script(args: &[String]) -> Res<ExitCode> {
    let batch = args.len() == 2 && args.get(1).is_some_and(|s| s == "--batch");
    let Some(path) = args.first().filter(|_| args.len() == 1 || batch) else {
        return Err("usage: sx review-script <request.json | -> [--batch]".into());
    };
    let text = if path == "-" {
        std::io::read_to_string(std::io::stdin())?
    } else {
        std::fs::read_to_string(path)?
    };
    if batch {
        let inputs: Vec<sx_core::script_review::ReviewInput> = serde_json::from_str(&text)?;
        let results = inputs
            .iter()
            .map(sx_core::script_review::review_known)
            .collect::<Result<Vec<_>, _>>()?;
        println!("{}", serde_json::to_string(&results)?);
        return Ok(ExitCode::SUCCESS);
    }
    let input: sx_core::script_review::ReviewInput = serde_json::from_str(&text)?;
    let result = sx_core::script_review::review_known(&input)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(ExitCode::SUCCESS)
}

fn cmd_prepare_script_replacement(args: &[String]) -> Res<ExitCode> {
    let batch = args.len() == 2 && args.get(1).is_some_and(|s| s == "--batch");
    let Some(path) = args.first().filter(|_| args.len() == 1 || batch) else {
        return Err("usage: sx prepare-script-replacement <request.json | -> [--batch]".into());
    };
    let text = if path == "-" {
        std::io::read_to_string(std::io::stdin())?
    } else {
        std::fs::read_to_string(path)?
    };
    if batch {
        let inputs: Vec<sx_core::script_replacement::ReplacementInput> = serde_json::from_str(&text)?;
        let results = inputs
            .iter()
            .map(sx_core::script_replacement::prepare_known)
            .collect::<Result<Vec<_>, _>>()?;
        println!("{}", serde_json::to_string(&results)?);
    } else {
        let input = serde_json::from_str(&text)?;
        let result = sx_core::script_replacement::prepare_known(&input)?;
        println!("{}", serde_json::to_string(&result)?);
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_canonical_script(args: &[String]) -> Res<ExitCode> {
    let batch = args.len() == 2 && args.get(1).is_some_and(|s| s == "--batch");
    let Some(path) = args.first().filter(|_| args.len() == 1 || batch) else {
        return Err("usage: sx canonical-script <file | -> [--batch]".into());
    };
    let text = if path == "-" {
        std::io::read_to_string(std::io::stdin())?
    } else {
        std::fs::read_to_string(path)?
    };
    if batch {
        let texts: Vec<String> = serde_json::from_str(&text)?;
        let results: Vec<Value> = texts
            .iter()
            .map(|text| match sx_core::script_canonical::canonicalize(text) {
                Ok(result) => serde_json::to_value(result).unwrap_or(Value::Null),
                Err(reason) => json!({"version": 1, "error": "script_review_required", "reason": reason}),
            })
            .collect();
        println!("{}", serde_json::to_string(&results)?);
        return Ok(ExitCode::SUCCESS);
    }
    match sx_core::script_canonical::canonicalize(&text) {
        Ok(result) => {
            println!("{}", serde_json::to_string(&result)?);
            Ok(ExitCode::SUCCESS)
        }
        Err(reason) => {
            println!(
                "{}",
                json!({"version": 1, "error": "script_review_required", "reason": reason})
            );
            Ok(ExitCode::from(EXIT_INPUT))
        }
    }
}

fn cmd_schema(args: &[String]) -> ExitCode {
    match args.first().map_or("request", String::as_str) {
        "request" => print!("{}", sx_core::api::REQUEST_SCHEMA),
        "result" => print!("{}", sx_core::api::RESULT_SCHEMA),
        other => {
            eprintln!("sx schema: unknown schema {other}; use request or result");
            return ExitCode::from(EXIT_USAGE);
        }
    }
    ExitCode::SUCCESS
}

/// Loads a mesh reference from a request: a path relative to `base`, where
/// `file.3mf#2` picks plate 2 of a 3MF project.
fn load_ref(base: &Path, full: &str) -> sx_core::Result<std::sync::Arc<Mesh>> {
    use sx_core::api;
    let (rel, plate) = split_ref(full);
    let path = base.join(rel);
    let bytes = std::fs::read(&path).map_err(|e| sx_core::Error::Mesh {
        name: path.display().to_string(),
        reason: e.to_string(),
    })?;
    let mesh = match plate {
        Some(n) => api::load_3mf_plates(&bytes, rel)?
            .into_iter()
            .find(|(p, _)| *p == n)
            .map(|(_, m)| m)
            .ok_or_else(|| sx_core::Error::Mesh {
                name: rel.to_owned(),
                reason: format!("no plate {n}"),
            })?,
        None => api::load_mesh(&bytes, rel)?,
    };
    Ok(std::sync::Arc::new(mesh))
}

/// The request's `meshes` map: reference to file path.
/// The request's `meshes`: each key's file, given as a path or as `{ "file": path, "paint": ... }`.
fn mesh_paths(raw: &Value) -> std::collections::HashMap<String, String> {
    raw.get("meshes")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    let file = v.as_str().or_else(|| v.get("file").and_then(Value::as_str))?;
                    Some((k.clone(), file.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A `meshes` entry's mesh: its file, with the entry's paint written over the file's own.
fn load_entry(base: &Path, full: &str, paint: Option<&Value>) -> sx_core::Result<std::sync::Arc<Mesh>> {
    let mesh = load_ref(base, full)?;
    let Some(paint) = paint else { return Ok(mesh) };
    let mut m = (*mesh).clone();
    m.apply_paint(paint)?;
    Ok(std::sync::Arc::new(m))
}

/// The paint a `meshes` entry writes over its file's, by key (`sx_core::Mesh::apply_paint` reads it).
fn mesh_paint(raw: &Value) -> std::collections::HashMap<String, Value> {
    raw.get("meshes")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.get("paint")?.clone())))
                .collect()
        })
        .unwrap_or_default()
}

/// `file.3mf#2` as the file and the plate number.
fn split_ref(full: &str) -> (&str, Option<u32>) {
    match full.rsplit_once('#') {
        Some((p, n)) if n.parse::<u32>().is_ok() => (p, n.parse::<u32>().ok()),
        _ => (full, None),
    }
}

/// A 3MF plate given without a transform becomes one object per build item ([`sx_core::api::load_3mf_items`]), each
/// where the file puts it with the plate centered on the bed, so print by object, its clearance checks and the object
/// labels see the objects and not one merged mesh. Returns their meshes under the new keys (a plate of one item keeps
/// its key, with the item's mesh).
fn split_projects(
    req: &mut sx_core::api::SliceRequest,
    base: &Path,
    paths: &std::collections::HashMap<String, String>,
    painted: &std::collections::HashMap<String, Value>,
) -> sx_core::Result<std::collections::HashMap<String, std::sync::Arc<Mesh>>> {
    use sx_core::api;
    let mut cache = std::collections::HashMap::new();
    let bed = req.plate.bed.map_or_else(api::Bed::default, |b| api::Bed {
        width_mm: b.width_mm,
        depth_mm: b.depth_mm,
        height_mm: b.height_mm,
    });
    let mut out = Vec::with_capacity(req.plate.objects.len());
    for o in std::mem::take(&mut req.plate.objects) {
        let key = o.mesh_ref();
        let full = paths.get(&key).map_or(key.as_str(), String::as_str);
        let (rel, plate) = split_ref(full);
        // A mesh given paint stays one object, so the paint's part indices are those of the mesh as loaded.
        let plain = o.transform.is_none()
            && o.volumes.is_empty()
            && o.brim_points.is_empty()
            && !painted.contains_key(&key);
        if !plain || !rel.to_ascii_lowercase().ends_with(".3mf") {
            out.push(o);
            continue;
        }
        let path = base.join(rel);
        let bytes = std::fs::read(&path).map_err(|e| sx_core::Error::Mesh {
            name: path.display().to_string(),
            reason: e.to_string(),
        })?;
        let Some((plate_no, items)) = api::load_3mf_items(&bytes, rel, plate)? else {
            // loading it names the plate the file does not have
            out.push(o);
            continue;
        };
        // The marks the project sets on this plate's layers go in unless the request brings its own.
        if req.options.layer_gcode.is_none() {
            let marks = api::load_3mf_layer_gcode(&bytes, plate_no);
            if !marks.is_empty() {
                req.options.layer_gcode = Some(marks);
            }
        }
        if items.len() < 2 {
            // One object keeps its key and is centered as the plate; the ears the file paints on it go with it, and
            // its mesh is named after its object, not the file.
            let mut o = o;
            if let Some(one) = items.into_iter().next() {
                o.brim_points.clone_from(&one.brim_points);
                cache.insert(key, std::sync::Arc::new(one));
            }
            out.push(o);
            continue;
        }
        let at = sx_core::plate::items_transform(&items, bed, None);
        for (k, mesh) in items.into_iter().enumerate() {
            let id = format!("{key}@{}", k + 1);
            let mut one = o.clone();
            one.id = format!("{}-{}", if o.id.is_empty() { "object" } else { &o.id }, k + 1);
            one.name.clone_from(&mesh.name);
            one.mesh = Value::String(id.clone());
            one.transform = Some(at.to_vec());
            one.brim_points.clone_from(&mesh.brim_points);
            cache.insert(id, std::sync::Arc::new(mesh));
            out.push(one);
        }
    }
    req.plate.objects = out;
    Ok(cache)
}

/// The meshes of a request as the engine asks for them. A mesh is let go once the last object or volume naming it
/// has it: the engine keeps what it needs of each mesh, and a painted model's own copy would otherwise stay in memory
/// for the whole slice.
struct Meshes<'a> {
    /// Loaded meshes still to be asked for (the plates split from projects, and meshes named more than once).
    cache: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<Mesh>>>,
    /// How many more times each mesh will be asked for.
    uses: std::sync::Mutex<std::collections::HashMap<String, usize>>,
    base: &'a Path,
    paths: &'a std::collections::HashMap<String, String>,
    painted: &'a std::collections::HashMap<String, Value>,
}

impl Meshes<'_> {
    fn get(&self, id: &str) -> sx_core::Result<std::sync::Arc<Mesh>> {
        let last = self.uses.lock().is_ok_and(|mut u| match u.get_mut(id) {
            Some(n) if *n > 1 => {
                *n -= 1;
                false
            }
            _ => true,
        });
        let kept = self
            .cache
            .lock()
            .ok()
            .and_then(|mut c| if last { c.remove(id) } else { c.get(id).cloned() });
        if let Some(m) = kept {
            return Ok(m);
        }
        let mesh = load_entry(
            self.base,
            self.paths.get(id).map_or(id, String::as_str),
            self.painted.get(id),
        )?;
        if !last && let Ok(mut c) = self.cache.lock() {
            c.insert(id.to_owned(), mesh.clone());
        }
        Ok(mesh)
    }
}

/// How many times the request asks for each mesh: once per object and once per volume naming it.
fn mesh_uses(req: &sx_core::api::SliceRequest) -> std::collections::HashMap<String, usize> {
    let mut uses: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for o in &req.plate.objects {
        *uses.entry(o.mesh_ref()).or_default() += 1;
        for v in &o.volumes {
            let id = match &v.mesh {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            *uses.entry(id).or_default() += 1;
        }
    }
    uses
}

/// The request's text, from a file or stdin (`-`), and the folder its mesh paths are relative to.
fn read_request(src: &str) -> Result<(String, PathBuf), String> {
    if src == "-" {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
            .map_err(|e| format!("reading stdin: {e}"))?;
        return Ok((buf, PathBuf::from(".")));
    }
    let text = std::fs::read_to_string(src).map_err(|e| format!("reading {src}: {e}"))?;
    let base = Path::new(src)
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    Ok((text, base))
}

/// The command line lists the keys the engine does not use unless the request says not to; `--strict` refuses the
/// slice over them.
fn report_options(req: &mut sx_core::api::SliceRequest, args: &[String]) {
    if req.options.config_report.is_none() {
        req.options.config_report = Some(true);
    }
    if has(args, "--strict") {
        req.options.strict = Some(true);
    }
}

fn review_config_scripts(
    config: &serde_json::Map<String, Value>,
    selected: Option<&sx_core::script_review::Identity>,
    effective_flavor: Option<&str>,
) -> Res<(Vec<String>, Vec<Value>)> {
    #[cfg(feature = "stock-gcode")]
    {
        let result = if let Some(selected) = selected {
            let checked = if let Some(flavor) = effective_flavor.filter(|flavor| *flavor != selected.firmware)
            {
                let mut checked = config.clone();
                checked.insert("gcode_flavor".into(), Value::String(flavor.into()));
                std::borrow::Cow::Owned(checked)
            } else {
                std::borrow::Cow::Borrowed(config)
            };
            stock::reviewed_keys(checked.as_ref(), selected)?
        } else {
            (stock::stock_keys(config), Vec::new())
        };
        if !result.1.is_empty() {
            eprintln!("sx: script_reviews: {}", serde_json::json!(result.1));
        }
        Ok(result)
    }
    #[cfg(not(feature = "stock-gcode"))]
    {
        let _ = (config, effective_flavor);
        if selected.is_some() {
            return Err("stock script review is unavailable in this build".into());
        }
        Ok((Vec::new(), Vec::new()))
    }
}

/// A custom G-code refusal, with one more line when `sx` doesn't know the printer the settings name: then even the
/// maker's own text is checked as custom G-code, which is the real reason for the refusal.
fn with_printer_note(why: String, config: Option<&serde_json::Map<String, Value>>) -> String {
    #[cfg(feature = "stock-gcode")]
    {
        if why.contains("safety preflight: custom G-code")
            && let Some(name) = config.and_then(stock::unknown_printer)
        {
            return format!(
                "{why}\nsx doesn't know the printer this project names ({name}), so its G-code is checked as custom G-code."
            );
        }
    }
    #[cfg(not(feature = "stock-gcode"))]
    let _ = config;
    why
}

/// `with_printer_note` for a request: only the stock check can trust its text, not a request a person already
/// approved nor an explicit script target.
fn request_refusal(why: String, req: &sx_core::api::SliceRequest, args: &[String]) -> String {
    let stock_checked = !req.options.trusted_gcode.unwrap_or(false) && !has(args, "--script-printer");
    with_printer_note(why, stock_checked.then(|| req.config.as_object()).flatten())
}

fn review_request_scripts(
    req: &mut sx_core::api::SliceRequest,
    selected: Option<&sx_core::script_review::Identity>,
) -> Res<Vec<Value>> {
    let Some(config) = req.config.as_object() else {
        return Ok(Vec::new());
    };
    let (keys, reviews) = review_config_scripts(config, selected, req.options.flavor.as_deref())?;
    req.options.stock_gcode_keys = keys;
    Ok(reviews)
}

fn apply_request_replacements(
    req: &mut sx_core::api::SliceRequest,
    raw: &Value,
    selected: Option<&sx_core::script_review::Identity>,
) -> Res<Vec<sx_core::script_replacement::AppliedReplacement>> {
    let Some(choices) = raw.get("script_replacements") else {
        return Ok(Vec::new());
    };
    #[cfg(feature = "stock-gcode")]
    {
        let selected = selected.ok_or("script replacements require an explicit printer and firmware")?;
        let choices = serde_json::from_value::<Vec<sx_core::script_replacement::Choice>>(choices.clone())?;
        let config = req
            .config
            .as_object_mut()
            .ok_or("script replacements require object settings")?;
        let mut declared = stock::declarations(config, selected);
        if let Some(flavor) = &req.options.flavor {
            declared.push(sx_core::script_review::Identity {
                model: selected.model.clone(),
                firmware: flavor.clone(),
            });
        }
        Ok(sx_core::script_replacement::apply_known(
            config,
            Some(selected),
            &declared,
            &choices,
        )?)
    }
    #[cfg(not(feature = "stock-gcode"))]
    {
        let _ = (req, choices, selected);
        Err("stock script replacement is unavailable in this build".into())
    }
}

fn request_script_changes(
    req: &mut sx_core::api::SliceRequest,
    raw: &Value,
    args: &[String],
) -> Res<(Vec<sx_core::script_replacement::AppliedReplacement>, Vec<Value>)> {
    let selected = script_target(args)?;
    let replacements = apply_request_replacements(req, raw, selected.as_ref())?;
    let reviews = review_request_scripts(req, selected.as_ref())?;
    Ok((replacements, reviews))
}

fn cmd_request(args: &[String]) -> ExitCode {
    use sx_core::api;
    let fail = |code: u8, msg: String| {
        eprintln!("sx slice: {msg}");
        ExitCode::from(code)
    };
    let Some(src) = flag(args, "--request") else {
        return fail(EXIT_USAGE, "--request needs a path or -".into());
    };
    let (text, base) = match read_request(src) {
        Ok(r) => r,
        Err(e) => return fail(EXIT_INPUT, e),
    };
    let raw: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return fail(EXIT_INPUT, format!("request JSON: {e}")),
    };
    let mut req: api::SliceRequest = match serde_json::from_value(raw.clone()) {
        Ok(r) => r,
        Err(e) => return fail(EXIT_INPUT, format!("request: {e}")),
    };
    let (script_replacements, script_reviews) = match request_script_changes(&mut req, &raw, args) {
        Ok(result) => result,
        Err(e) => return fail(EXIT_INPUT, e.to_string()),
    };
    report_options(&mut req, args);
    let (paths, painted) = (mesh_paths(&raw), mesh_paint(&raw));
    let cache = match split_projects(&mut req, &base, &paths, &painted) {
        Ok(split) => split,
        Err(e) => return fail(EXIT_INPUT, e.to_string()),
    };
    let meshes = Meshes {
        cache: std::sync::Mutex::new(cache),
        uses: std::sync::Mutex::new(mesh_uses(&req)),
        base: &base,
        paths: &paths,
        painted: &painted,
    };
    let resolve = |id: &str| meshes.get(id);
    let run = match api::run_request(&req, &resolve) {
        Ok(r) => r,
        Err(
            e @ (sx_core::Error::Mesh { .. }
            | sx_core::Error::Config { .. }
            | sx_core::Error::EmptyPlate
            | sx_core::Error::Clearance(_)),
        ) => {
            return fail(EXIT_INPUT, e.to_string());
        }
        Err(e) => return fail(EXIT_SLICE, request_refusal(e.to_string(), &req, args)),
    };
    if let Some(why) = request_collision_refusal(&run.report, &req.plate.objects, args) {
        return fail(EXIT_INPUT, why);
    }
    print_chamber(run.report.chamber_cooling.as_ref(), None);
    // The settings the slice did not use, as one block on stderr (stdout carries only the result).
    if let Some(r) = &run.report.config_report {
        if let Some(w) = &r.walls {
            eprintln!("sx: walls: {}", w.text);
        }
        if !r.is_empty() {
            print_config_report(r);
        }
    }
    let mut out = match serde_json::to_value(&run.report) {
        Ok(v) => v,
        Err(e) => return fail(EXIT_SLICE, e.to_string()),
    };
    if !script_reviews.is_empty() {
        out["script_reviews"] = serde_json::json!(script_reviews);
    }
    if !script_replacements.is_empty() {
        out["script_replacements"] = serde_json::json!(script_replacements);
    }
    if let Some(dir) = flag(args, "--out-dir") {
        let dir = Path::new(dir);
        let files = [
            (
                "gcode",
                if run.report.gcode_format.as_deref() == Some("bgcode") {
                    "slice.bgcode"
                } else {
                    "slice.gcode"
                },
                &run.gcode,
            ),
            ("preview", "slice.sxpv", &run.preview),
        ];
        let mut written = serde_json::Map::new();
        for (key, name, bytes) in files {
            let p = dir.join(name);
            if let Err(e) = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&p, bytes)) {
                return fail(EXIT_SLICE, format!("writing {}: {e}", p.display()));
            }
            written.insert(key.to_owned(), Value::String(p.display().to_string()));
        }
        if let Some(o) = out.as_object_mut() {
            o.insert("files".to_owned(), Value::Object(written));
        }
    }
    println!("{out}");
    ExitCode::SUCCESS
}

/// The config report as one block on stderr: a line per kind, then every key, so a script can read the whole list.
fn print_config_report(r: &sx_core::api::ConfigReport) {
    eprintln!("sx: settings not used:");
    for line in r.lines() {
        eprintln!("  {line}");
    }
    let all: Vec<String> = r
        .invalid
        .iter()
        .map(|i| format!("invalid {} = {} ({})", i.key, i.value, i.reason))
        .chain(r.not_applied.iter().map(|k| format!("not used {k}")))
        .collect();
    for line in all.iter().take(REPORT_LINES) {
        eprintln!("  {line}");
    }
    if all.len() > REPORT_LINES {
        eprintln!(
            "  and {} more (the result's configReport lists them all)",
            all.len() - REPORT_LINES
        );
    }
}

/// How many keys the stderr block lists one per line.
const REPORT_LINES: usize = 50;

/// [`collision_refusal`] of a request's slice, with its objects' names.
fn request_collision_refusal(
    report: &sx_core::api::SliceReport,
    objects: &[sx_core::api::ObjectSpec],
    args: &[String],
) -> Option<String> {
    let names: Vec<(&str, &str)> = objects.iter().map(|o| (o.id.as_str(), o.name.as_str())).collect();
    collision_refusal(&report.collisions, &report.collision_fixes, &names, args)
}

/// Why a slice is refused when its head, gantry or tool changer would meet a printed part, two objects' paths cross,
/// or a path enters a zone the printer keeps clear, unless `--allow-collisions` asks for it anyway: the same rule for
/// `sx slice <model>` and `sx slice --request`. `names` are the objects' ids and names (the id stands in for an empty
/// name). The engine reports codes and numbers; the words are the command line's.
fn collision_refusal(
    collisions: &[sx_core::collide::Collision],
    collision_fixes: &[sx_core::collide::CollisionFix],
    names: &[(&str, &str)],
    args: &[String],
) -> Option<String> {
    use sx_core::collide::{Kind, Part, Severity};
    let name = |id: &str| match id {
        "prime-tower" => "the prime tower".to_owned(),
        "exclusion-area" => "the exclusion area".to_owned(),
        "wrap-check-zone" => "the nozzle wrap check corner".to_owned(),
        _ => names
            .iter()
            .find(|(i, n)| *i == id && !n.is_empty())
            .map_or(id, |(_, n)| n)
            .to_owned(),
    };
    // The machine's clearance holds for a plate printed by object; crossing paths and keep-out zones are the plate's
    // own, in either order, so they get their own words.
    let mut machine = Vec::new();
    let mut plate = Vec::new();
    for c in collisions.iter().filter(|c| c.severity == Severity::Hit) {
        let a = name(&c.object_id);
        let b = name(&c.hit_id);
        let layers = if c.last_layer > c.layer {
            format!("layers {} to {}", c.layer + 1, c.last_layer + 1)
        } else {
            format!("layer {}", c.layer + 1)
        };
        let (what, piece) = match (c.kind, c.part) {
            (Kind::PathConflict, _) => {
                plate.push(format!("Paths cross: {a} and {b} on {layers}."));
                continue;
            }
            (Kind::KeepOut, _) => {
                plate.push(format!("A print path or travel enters {b}: {a} on {layers}."));
                continue;
            }
            (Kind::Hotend, Part::Clearance) => {
                machine.push(format!(
                    "While {a} prints, the toolhead comes within {:.1} mm of {b}, inside the {:.0} mm the printer profile asks for around the nozzle, \
                     from layer {}; this printer's head is not measured, so the profile's rule holds.",
                    (c.limit_mm - c.depth_mm).max(0.0),
                    c.limit_mm,
                    c.layer + 1,
                ));
                continue;
            }
            (Kind::Gantry, Part::Lid) => ("The frame hits", "frame"),
            (Kind::Gantry, _) => ("The gantry hits", "gantry"),
            (Kind::NozzleTravelThroughPart, _) => ("A travel runs through", ""),
            (Kind::Hotend, Part::Nozzle) => ("The nozzle prints into", ""),
            (Kind::Hotend, _) => ("The toolhead hits", ""),
            (Kind::ToolChange, _) => ("A tool change crosses", ""),
            (Kind::Dock, _) => ("The tool changer meets", ""),
        };
        let clears = if piece.is_empty() {
            String::new()
        } else {
            format!(", over the {:.1} mm the {piece} clears", c.limit_mm)
        };
        machine.push(format!(
            "{what} {b}. {b} is {:.1} mm tall{clears}, from layer {} while {a} prints.",
            c.hit_height_mm,
            c.layer + 1,
        ));
    }
    if args.iter().any(|a| a == "--allow-collisions") || (machine.is_empty() && plate.is_empty()) {
        return None;
    }
    let mut why = Vec::new();
    if !machine.is_empty() {
        why.push(sx_core::Error::Clearance(machine.join(" ")).to_string());
    }
    why.extend(plate);
    // The fixes the engine offers, in the command line's words, and the way past the refusal.
    let mut fixes = Vec::new();
    for f in collision_fixes {
        use sx_core::collide::report::FixKind;
        let mm = f.mm.unwrap_or(0.0);
        fixes.push(match f.kind {
            FixKind::Reorder => format!(
                "print in the order {}",
                f.order.iter().map(|id| name(id)).collect::<Vec<_>>().join(", ")
            ),
            FixKind::ByLayer => "print by layer".to_owned(),
            FixKind::Spread => format!("space the objects {mm:.0} mm wider"),
            FixKind::RaiseLift => format!("set Z hop to {mm:.1} mm"),
            FixKind::Arrange => "arrange the plate".to_owned(),
            FixKind::MoveObject => format!("move {}", name(f.object_id.as_deref().unwrap_or(""))),
        });
    }
    if !fixes.is_empty() {
        why.push(format!("To fix it: {}.", fixes.join("; or ")));
    }
    why.push("To slice it anyway, add --allow-collisions.".to_owned());
    Some(why.join(" "))
}

/// Prints a 3MF project's settings entries as JSON (`projectSettings`,
/// `modelSettings`, `layerRanges`), the request shape of the settings crate's
/// project import.
fn cmd_metadata(args: &[String]) -> Res<ExitCode> {
    let path = args
        .first()
        .filter(|a| !a.starts_with('-'))
        .ok_or("missing 3MF path")?;
    let meta = sx_core::api::project_metadata(&std::fs::read(path)?, path)?;
    println!("{}", serde_json::to_string(&meta)?);
    Ok(ExitCode::SUCCESS)
}

/// The print time of a G-code file as the engine estimates it (Orca's G-code processor model), in
/// seconds: total and first layer.
fn cmd_time(args: &[String]) -> Res<ExitCode> {
    let file = args
        .first()
        .filter(|a| !a.starts_with('-'))
        .ok_or("missing G-code path")?;
    let config = match flag(args, "--config") {
        Some(p) => PrintConfig::from_json(&std::fs::read(p)?)?,
        None => PrintConfig::default(),
    };
    let text = std::fs::read(file)?;
    // A file sliced for two nozzles says in its configuration block which nozzle each filament went to.
    let config = sx_core::firmware::map_from_gcode(&text, &config).unwrap_or(config);
    let trace = has(args, "--trace");
    let e = sx_core::printtime::estimate(&text, &config, trace);
    if has(args, "--json") {
        // The whole estimate for clients: total, first layer, start sequence, travel, end waits and each feature.
        let features: serde_json::Map<String, Value> = e
            .features
            .iter()
            .filter(|f| f.1 != 0.0)
            .map(|(name, t)| (name.clone(), Value::from(*t)))
            .collect();
        println!(
            "{}",
            serde_json::json!({
                "total_s": e.total,
                "first_layer_s": e.first_layer,
                "prepare_s": e.prepare,
                "travel_s": e.travel,
                "end_wait_s": e.end_wait,
                "features_s": features,
            })
        );
        return Ok(ExitCode::SUCCESS);
    }
    println!(
        "total {:.1} s ({}), first layer {:.1} s",
        e.total,
        sx_core::firmware::format_time(e.total),
        e.first_layer
    );
    if trace {
        // The time at each progress line and layer change, to compare against the remaining time the
        // file states or another file's layers.
        for (i, line) in text.split(|&b| b == b'\n').enumerate() {
            let at = flag(args, "--at").map(str::as_bytes);
            let marked = match at {
                Some(prefix) => line.starts_with(prefix),
                None => line.starts_with(b"M73 ") || sx_core::extras::is_layer_mark(line),
            };
            if marked {
                let t = e.lines.get(i).copied().unwrap_or(0.0);
                println!(
                    "{} {:.1} {:.1} {}",
                    i + 1,
                    t,
                    (e.total - t) / 60.0,
                    String::from_utf8_lossy(line)
                );
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// The chamber cooling mode the G-code read, on stderr: with `from` (the settings layer that set it, for `sx slice
/// <model>`) the source too.
fn print_chamber(c: Option<&sx_core::chamber::ChamberCooling>, from: Option<&str>) {
    let Some(c) = c else { return };
    match (c.source, from) {
        (_, None) => eprintln!("sx: chamber: {}", c.text),
        (sx_core::chamber::ChamberSource::Derived, Some(_)) => {
            eprintln!("sx: chamber: {} (source derived)", c.text);
        }
        (sx_core::chamber::ChamberSource::Config, Some(from)) => {
            eprintln!("sx: chamber: {} (source {from})", c.text);
        }
    }
}

/// Reads `value` over `config` a key at a time, and what it set that the engine does not use.
fn read_config_value(config: &mut PrintConfig, value: &Value) -> Res<sx_core::api::ConfigReport> {
    let mut report = sx_core::api::ConfigReport {
        invalid: config.apply_value_lenient(value)?,
        ..Default::default()
    };
    if let Some(map) = value.as_object() {
        let placeholders = sx_core::config::placeholder_keys(map);
        report.not_applied = map
            .keys()
            .filter(|k| !sx_core::config::is_used_key(k) && !placeholders.contains(k.as_str()))
            .cloned()
            .collect();
        report.not_applied.sort();
    }
    Ok(report)
}

/// The settings `sx slice <model>` prints with ([`layered_config`]) and what came with them.
struct Layered {
    config: PrintConfig,
    /// What the settings set that the engine does not use.
    report: sx_core::api::ConfigReport,
    /// Which layer set `chamber_cooling_mode` last: `project` for the project's or the object's settings, `preset` for
    /// `--config`.
    chamber_from: Option<&'static str>,
    /// Why a project's settings were left out, when they could not be read.
    skipped: Option<String>,
    /// The `--config` settings, which go over an object's own as over the plate's.
    preset: Option<Value>,
}

/// The settings `sx slice <model>` prints with, lowest first: the engine's defaults, a project's own settings (our
/// engine choices kept where it did not change them), the object settings every object of the plate shares
/// (`object`), then `--config`.
fn layered_config(args: &[String], model: &str, bytes: &[u8], object: &Value) -> Res<Layered> {
    let mut config = PrintConfig::default();
    let mut report = sx_core::api::ConfigReport::default();
    let mut chamber_from = None;
    let mut skipped = None;
    let mut preset = None;
    let sets_chamber = |v: &Value| v.get(sx_core::chamber::KEY).is_some();
    let is_3mf = Path::new(model)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("3mf"));
    if is_3mf
        && !has(args, "--no-project-settings")
        && let Some(project) = sx_core::api::project_config(bytes, model)?
    {
        skipped = project.skipped;
        let settings = Value::Object(project.settings);
        if sets_chamber(&settings) {
            chamber_from = Some("project");
        }
        report.merge(read_config_value(&mut config, &settings)?);
        report.not_applied.extend(project.dropped);
        report.not_applied.sort();
        report.kept = project.kept;
        report.walls = project.walls;
    }
    if let Some(m) = object.as_object().filter(|m| !m.is_empty()) {
        if sets_chamber(object) {
            chamber_from = Some("project");
        }
        let own = sx_core::api::with_bambu_tower_keys(object);
        report.merge(read_config_value(&mut config, &own)?);
        if let Some(g) = sx_core::api::WallsNote::named(m) {
            report.walls = Some(sx_core::api::WallsNote {
                text: format!("{g} walls, set by the object's own settings"),
                generator: g,
                source: "project".to_owned(),
            });
        }
    }
    if let Some(p) = flag(args, "--config") {
        let mut value: Value = serde_json::from_slice(&std::fs::read(p)?)?;
        // A Bambu Studio preset names its prime tower keys its own way.
        if let Some(m) = value.as_object_mut() {
            sx_core::api::bambu_tower_keys(m);
        }
        if sets_chamber(&value) {
            chamber_from = Some("preset");
        }
        // A preset for the whole plate: the per-feature filament names a plate's settings leave unread go.
        report.merge(read_config_value(
            &mut config,
            &sx_core::config::plate_value(&value),
        )?);
        if let Some(g) = value.as_object().and_then(sx_core::api::WallsNote::named) {
            report.walls = Some(sx_core::api::WallsNote {
                text: format!("{g} walls, set by --config"),
                generator: g,
                source: "config".to_owned(),
            });
        }
        preset = Some(value);
    }
    if report.walls.is_none() {
        report.walls = Some(sx_core::api::WallsNote::of_request(
            &serde_json::Map::new(),
            "the settings",
        ));
    }
    Ok(Layered {
        config,
        report,
        chamber_from,
        skipped,
        preset,
    })
}

/// Prints why a project's settings were left out, the walls the slice runs and what the settings set that the engine
/// does not use. With `--strict`, either of the first and last refuses the slice: the exit code to stop with.
fn settings_notes(
    args: &[String],
    report: &sx_core::api::ConfigReport,
    skipped: Option<String>,
) -> Option<ExitCode> {
    if let Some(why) = &skipped {
        eprintln!("sx: {why}");
    }
    if let Some(w) = &report.walls {
        eprintln!("sx: walls: {}", w.text);
    }
    if !report.is_empty() || !report.kept.is_empty() {
        print_config_report(report);
    }
    if has(args, "--strict") && (!report.is_empty() || skipped.is_some()) {
        let why: Vec<String> = skipped.into_iter().chain(report.lines()).collect();
        eprintln!("sx slice: --strict: {}", why.join("; "));
        return Some(ExitCode::from(EXIT_INPUT));
    }
    None
}

/// What [`slice_checked`] gives: the paths, what the collision report reads besides the hits, the hits, and the layer
/// marks on the sliced layers.
type Checked = (
    SliceOutput,
    Option<sx_core::collide::Meta>,
    sx_core::collide::Hits,
    Vec<sx_core::gcode::LayerGcode>,
);

/// The slice a request makes of `plate`, with its collision check and the layer marks `marks` placed on its layers as
/// a request's are.
fn slice_checked(
    plate: &Plate,
    config: &PrintConfig,
    marks: &[sx_core::api::LayerGcodeSpec],
) -> Result<Checked, sx_core::Error> {
    let mut session = SliceSession::new(plate, config)?;
    sx_core::api::set_collision_check(&mut session, plate, config, None);
    let mut out = session.slice_range_with(config, 0..session.layer_count(), &sx_core::NoProgress)?;
    sx_core::api::check_paths(&session, config, &mut out);
    let meta = session.collide_meta().cloned();
    let hits = std::mem::take(&mut out.collisions);
    let layer_gcode = sx_core::api::layer_gcode(marks, &session)?;
    Ok((out, meta, hits, layer_gcode))
}

/// The collision check's refusal of the plate `sx slice <model>` sliced, in the words and by the rule of `--request`
/// ([`collision_refusal`]): the hits read with the layers' times of the finished file (`file_times`, seconds per layer
/// and before the first) as a request reads them.
fn plate_refusal(
    meta: Option<&sx_core::collide::Meta>,
    hits: &sx_core::collide::Hits,
    file_times: (&[f64], f64),
    out: &SliceOutput,
    plate: &Plate,
    args: &[String],
) -> Option<String> {
    let (file_s, prepare_s) = file_times;
    #[allow(clippy::cast_possible_truncation, reason = "seconds of a layer")]
    let layer_s: Vec<f32> = if file_s.len() == out.layers.len() && !file_s.is_empty() {
        file_s.iter().map(|&t| t as f32).collect()
    } else {
        out.layers.iter().map(|l| l.time_s).collect()
    };
    let found = sx_core::api::collision_report(meta, hits, &layer_s, prepare_s);
    let names: Vec<(&str, &str)> = plate
        .objects
        .iter()
        .map(|o| (o.id.as_str(), o.name.as_str()))
        .collect();
    collision_refusal(&found.collisions, &found.fixes, &names, args)
}

/// What `sx slice <model>` slices: a 3MF plate's build items, or one mesh of any other format.
enum Model {
    /// The build items of a 3MF plate, and the pause, color change and custom G-code marks the project sets on the
    /// plate's layers.
    Items(Vec<Mesh>, Vec<sx_core::api::LayerGcodeSpec>),
    One(Box<Mesh>),
}

impl Model {
    /// A 3MF slices as the build items of a plate (`--plate N`, else its first), each an object of its own, as a
    /// request and the app slice it.
    fn load(args: &[String], model: &str, bytes: &[u8]) -> Res<Self> {
        let want = flag(args, "--plate").map(str::parse::<u32>).transpose()?;
        if want.is_none() && !sx_core::api::is_3mf(bytes, model) {
            return Ok(Model::One(Box::new(Mesh::load(bytes, model)?)));
        }
        let (plate, items) = sx_core::api::load_3mf_items(bytes, model, want)?
            .ok_or_else(|| format!("{model} has no plate {}", want.unwrap_or(1)))?;
        Ok(Model::Items(
            items,
            sx_core::api::load_3mf_layer_gcode(bytes, plate),
        ))
    }

    /// The marks the project sets on the plate's layers, which a request slicing the same plate takes too unless it
    /// brings its own (see [`split_projects`]). None for other files.
    fn layer_marks(&self) -> &[sx_core::api::LayerGcodeSpec] {
        match self {
            Model::Items(_, marks) => marks,
            Model::One(_) => &[],
        }
    }

    /// The object settings that go in with the plate's ([`layered_config`]): the mesh's own, or those every build item
    /// shares, `Null` when the items' differ (each object then slices with its own, see [`Model::plate`]).
    fn shared_settings(&self) -> Value {
        match self {
            Model::One(mesh) => mesh.settings.clone(),
            Model::Items(items, _) => {
                let first = items.first().map_or(Value::Null, |m| m.settings.clone());
                if items.iter().all(|m| m.settings == first) {
                    first
                } else {
                    Value::Null
                }
            }
        }
    }

    /// The plate, centered on the profile's bed: one object per build item, each printing with its own object settings
    /// and `preset` (`--config`) over them when the items' settings differ.
    fn plate(self, config: &PrintConfig, preset: Option<&Value>) -> Plate {
        let differ = self.shared_settings().is_null();
        match self {
            Model::One(mesh) => Plate::single_on(*mesh, config.bed_rect(), config.printable_height),
            Model::Items(items, _) => {
                let mut plate = Plate::items_on(items, config.bed_rect(), config.printable_height);
                for o in plate.objects.iter_mut().filter(|_| differ) {
                    if let Some(own) = o.mesh.settings.as_object().filter(|m| !m.is_empty()) {
                        let mut m = own.clone();
                        if let Some(p) = preset.and_then(Value::as_object) {
                            m.extend(p.iter().map(|(k, v)| (k.clone(), v.clone())));
                        }
                        o.settings = Value::Object(m);
                    }
                }
                plate
            }
        }
    }
}

/// The name `filename_format` gives the G-code of `sx slice <model>`, from the model's file name.
fn slice_file_name(config: &PrintConfig, model: &str, gcode: &[u8]) -> Res<String> {
    let names = sx_core::outname::NameInfo {
        objects: vec![
            Path::new(model)
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        ],
        ..Default::default()
    };
    Ok(sx_core::outname::file_name(
        config,
        &names,
        gcode,
        sx_core::firmware::truthy(config, "binary_gcode"),
    )?)
}

fn cmd_slice(args: &[String]) -> Res<ExitCode> {
    let model = args
        .first()
        .filter(|a| !a.starts_with('-'))
        .ok_or("missing model path")?;
    let bytes = std::fs::read(model)?;
    let model_file = Model::load(args, model, &bytes)?;
    let Layered {
        mut config,
        report,
        chamber_from,
        skipped,
        preset,
    } = layered_config(args, model, &bytes, &model_file.shared_settings())?;
    if let Some(code) = settings_notes(args, &report, skipped) {
        return Ok(code);
    }
    let target = script_target(args)?;
    config.trusted_gcode_keys = review_config_scripts(&config.raw, target.as_ref(), None)?.0;
    // With no explicit script target, only the stock check can trust the project's text.
    let stock_checked = target.is_none();
    // The same limits every entry point applies: settings past the nozzle and machine limits are lowered.
    let issues = sx_core::preflight::clamp_config(&mut config, &sx_core::gcode_lint::Limits::default());
    if sx_core::preflight::blocks(&issues) {
        return Err(sx_core::preflight::blocking_text(&issues).into());
    }
    for i in &issues {
        eprintln!("warning: {}", i.message);
    }
    // The model goes to the middle of the profile's bed, as the desktop slicers do.
    let marks = model_file.layer_marks().to_vec();
    let plate = model_file.plate(&config, preset.as_ref());
    let t = Instant::now();
    let refused = |e: sx_core::Error| with_printer_note(e.to_string(), stock_checked.then_some(&config.raw));
    let (out, meta, hits, layer_gcode) = slice_checked(&plate, &config, &marks).map_err(refused)?;
    let mut gcode = Vec::new();
    let opts = sx_core::EmitOptions {
        layer_gcode,
        ..Default::default()
    };
    let stats =
        sx_core::emit_gcode_with(&out, &config, config.gcode_flavor, &opts, &mut gcode).map_err(refused)?;
    let (gcode, timing) = sx_core::firmware::finalize_timed(&gcode, None, Some(&config));
    let time_s = sx_core::firmware::footer_time(&gcode).unwrap_or(stats.time_s);
    if let Some(why) = plate_refusal(
        meta.as_ref(),
        &hits,
        (&timing.layer_s, timing.prepare_s),
        &out,
        &plate,
        args,
    ) {
        eprintln!("sx slice: {why}");
        return Ok(ExitCode::from(EXIT_INPUT));
    }
    let file_name = slice_file_name(&config, model, &gcode)?;
    let (gcode, failed) = sx_core::firmware::substitute(gcode, &config)?;
    for f in failed {
        eprintln!("warning: G-code substitution {f} was skipped");
    }
    let gcode = if sx_core::firmware::truthy(&config, "gcode_add_line_number")
        && !sx_core::firmware::truthy(&config, "binary_gcode")
    {
        sx_core::firmware::number_lines(&gcode)
    } else {
        gcode
    };
    let mut sxpv = sx_core::preview_buffers(&out);
    if !timing.layer_s.is_empty() {
        #[allow(clippy::cast_possible_truncation, reason = "seconds of a layer")]
        let layer_s: Vec<f32> = timing.layer_s.iter().map(|&t| t as f32).collect();
        sx_core::preview::set_layer_times(&mut sxpv, &layer_s);
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    // G-code goes to the file, or to stdout without `-o` (`-o -` too), so stdout
    // never carries anything else; the summary below goes to stderr.
    match flag(args, "-o") {
        Some(p) if p != "-" => std::fs::write(p, &gcode)?,
        _ => std::io::Write::write_all(&mut std::io::stdout().lock(), &gcode)?,
    }
    if let Some(p) = flag(args, "--preview") {
        std::fs::write(p, &sxpv)?;
    }
    for w in &out.warnings {
        eprintln!("warning: {}", w.message);
    }
    print_chamber(out.chamber.as_ref(), Some(chamber_from.unwrap_or("config")));
    if let Some(i) = sx_core::preflight::nozzle_hardness(&config, &stats.filament_mm) {
        eprintln!("warning: {}", i.message);
    }
    eprintln!(
        "{} layers, {:.1} ms, {} bytes of G-code, {:.0} s estimated, filament {:?} mm, {} tool changes, file name {file_name}",
        out.layer_count,
        ms,
        gcode.len(),
        time_s,
        stats.filament_mm.iter().map(|v| v.round()).collect::<Vec<_>>(),
        stats.tool_changes
    );
    Ok(ExitCode::SUCCESS)
}

struct Bench {
    name: String,
    model_path: PathBuf,
    expect_layers: u32,
    config: PrintConfig,
    plate: Plate,
}

fn load_bench(path: &str) -> Res<Bench> {
    let v: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let model = v
        .get("model")
        .and_then(Value::as_str)
        .ok_or("bench config needs \"model\"")?;
    let model_path = PathBuf::from(model);
    let config = PrintConfig::from_value(v.get("config").ok_or("bench config needs \"config\"")?)?;
    let mesh = Mesh::load(&std::fs::read(&model_path)?, model)?;
    let expect_layers = v
        .get("expect_layers")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0);
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("bench")
        .to_owned();
    Ok(Bench {
        name,
        model_path,
        expect_layers,
        config,
        plate: Plate::single(mesh),
    })
}

/// One full pipeline run: prepare, slice, G-code, preview.
/// Wall ms, slice output, G-code, SXPV and G-code stats of one run.
type RunResult = (f64, SliceOutput, Vec<u8>, Vec<u8>, sx_core::GcodeStats);

fn run_once(b: &Bench) -> Res<RunResult> {
    let t = Instant::now();
    let session = SliceSession::new(&b.plate, &b.config)?;
    let mut out = session.slice_range_with(&b.config, 0..session.layer_count(), &sx_core::NoProgress)?;
    let tg = Instant::now();
    let mut gcode = Vec::with_capacity(32 << 20);
    let stats = sx_core::emit_gcode(&out, &b.config, b.config.gcode_flavor, &mut gcode)?;
    let tp = Instant::now();
    let sxpv = sx_core::preview_buffers(&out);
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    out.stage_micros.gcode = u64::try_from(tp.duration_since(tg).as_micros()).unwrap_or(0);
    out.stage_micros.preview = u64::try_from(tp.elapsed().as_micros()).unwrap_or(0);
    Ok((ms, out, gcode, sxpv, stats))
}

/// Re-slice timing after a settings change: the session (mesh preparation
/// and layer buckets) is kept, and every run slices, emits G-code and SXPV
/// with `key` switched between its value and a second one. Only
/// `sparse_infill_density` is supported.
fn incremental(b: &Bench, key: &str, runs: usize, warmup: usize) -> Res<ExitCode> {
    if key != "sparse_infill_density" {
        return Err(format!("--incremental supports sparse_infill_density, not {key}").into());
    }
    let session = SliceSession::new(&b.plate, &b.config)?;
    let mut alt = b.config.clone();
    alt.sparse_infill_density = if b.config.sparse_infill_density > 50.0 {
        15.0
    } else {
        b.config.sparse_infill_density + 5.0
    };
    let mut times = Vec::with_capacity(runs);
    for i in 0..warmup + runs.max(1) {
        let config = if i % 2 == 0 { &alt } else { &b.config };
        let t = Instant::now();
        let out = session.slice_range_with(config, 0..session.layer_count(), &sx_core::NoProgress)?;
        let mut gcode = Vec::with_capacity(32 << 20);
        sx_core::emit_gcode(&out, config, config.gcode_flavor, &mut gcode)?;
        let sxpv = sx_core::preview_buffers(&out);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if i >= warmup {
            times.push(ms);
        }
        drop((gcode, sxpv));
    }
    times.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({"incremental": key, "runs": times.len(), "median_ms": round2(percentile(&times, 0.5)), "p90_ms": round2(percentile(&times, 0.9)), "threads": rayon::current_num_threads()})
    );
    Ok(ExitCode::SUCCESS)
}

fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Slices in `shards` equal layer ranges and returns the hashes of the
/// concatenated G-code and the stitched preview.
fn shard_hashes(b: &Bench, shards: u32) -> Res<(String, String)> {
    let session = SliceSession::new(&b.plate, &b.config)?;
    let n = session.layer_count();
    let mut gcode = Vec::new();
    let mut chunks = Vec::new();
    for s in 0..shards {
        let lo = n * s / shards;
        let hi = n * (s + 1) / shards;
        let out = session.slice_range_with(&b.config, lo..hi, &sx_core::NoProgress)?;
        sx_core::emit_gcode(&out, &b.config, b.config.gcode_flavor, &mut gcode)?;
        chunks.push(sx_core::preview_buffers(&out));
    }
    let refs: Vec<&[u8]> = chunks.iter().map(Vec::as_slice).collect();
    let sxpv = preview::stitch(&refs)?;
    Ok((fnv(&gcode), fnv(&sxpv)))
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted.get(i).copied().unwrap_or(0.0)
}

fn rss_mb() -> Option<f64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    let kb: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some((kb / 1024.0).round())
}

/// The accepted extrusion baseline sits next to the bench config.
fn baseline_path(bench_path: &str) -> PathBuf {
    let p = Path::new(bench_path);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("bench");
    p.parent()
        .unwrap_or(Path::new("."))
        .join(format!("baseline-{stem}.json"))
}

#[allow(clippy::too_many_lines, reason = "one report, built in one place")]
fn cmd_bench(args: &[String]) -> Res<ExitCode> {
    let cfg_path = flag(args, "--config").ok_or("missing --config")?;
    let runs: usize = flag(args, "--runs").map_or(Ok(15), str::parse)?;
    let warmup: usize = flag(args, "--warmup").map_or(Ok(3), str::parse)?;
    let threads: usize = flag(args, "--threads").map_or(Ok(0), str::parse)?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build()?;
    if let Some(base) = flag(args, "--ab") {
        return ab(args, cfg_path, base, runs);
    }
    let bench = load_bench(cfg_path)?;
    if let Some(key) = flag(args, "--incremental") {
        return pool.install(|| incremental(&bench, key, runs, warmup));
    }
    let quiet = has(args, "--json");
    let result = pool.install(|| -> Res<Value> {
        for _ in 0..warmup {
            run_once(&bench)?;
        }
        let mut times = Vec::with_capacity(runs);
        let mut last = None;
        for _ in 0..runs.max(1) {
            let r = run_once(&bench)?;
            times.push(r.0);
            last = Some(r);
        }
        let (_, out, gcode, sxpv, stats) = last.ok_or("no runs")?;
        let mut sorted = times.clone();
        sorted.sort_by(f64::total_cmp);
        let bed = bench.config.bed_rect();
        let report = validate_gcode(
            &gcode,
            bed,
            bench.config.printable_height,
            sx_core::validate::deepest_retraction(&bench.config) + 0.001,
        );
        let total_e: f64 = stats.filament_mm.iter().sum();
        let bpath = baseline_path(cfg_path);
        if has(args, "--write-baseline") {
            let doc = json!({"extrusion_mm": total_e, "layers": out.layer_count, "gcode_bytes": gcode.len()});
            std::fs::write(&bpath, serde_json::to_vec_pretty(&doc)?)?;
        }
        let baseline_e = std::fs::read(&bpath)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("extrusion_mm").and_then(Value::as_f64));
        let delta_pct = baseline_e.map(|b| (total_e - b) / b * 100.0);
        let full = (fnv(&gcode), fnv(&sxpv));
        let shard_equal = if has(args, "--no-shards") {
            None
        } else {
            let mut eq = true;
            for s in [1, 4, 11] {
                eq &= shard_hashes(&bench, s)? == full;
            }
            Some(eq)
        };
        let segments = preview::read_info(&sxpv).map_or(0, |i| i.segments);
        let sm = out.stage_micros;
        #[allow(
            clippy::cast_precision_loss,
            reason = "stage times are far below 2^52 microseconds"
        )]
        let ms = |us: u64| us as f64 / 1000.0;
        Ok(json!({
            "bench": bench.name,
            "model": bench.model_path.display().to_string(),
            "threads": if threads == 0 { rayon::current_num_threads() } else { threads },
            "runs": runs,
            "median_ms": round2(percentile(&sorted, 0.5)),
            "p90_ms": round2(percentile(&sorted, 0.9)),
            "min_ms": round2(sorted.first().copied().unwrap_or(0.0)),
            "times_ms": times.iter().map(|t| round2(*t)).collect::<Vec<_>>(),
            "rss_mb": rss_mb(),
            "stage_ms": {
                "prepare": ms(sm.layers), "contours": ms(sm.contours),
                "perimeters": ms(sm.perimeters), "surfaces": ms(sm.surfaces),
                "infill": ms(sm.infill), "paths": ms(sm.paths),
                "gcode_wall": ms(sm.gcode), "preview_wall": ms(sm.preview),
            },
            "gcode_bytes": gcode.len(),
            "gcode_hash": full.0,
            "sxpv_hash": full.1,
            "segments": segments,
            "est_time_s": stats.time_s.round(),
            "filament_mm": stats.filament_mm.iter().map(|v| round2(*v)).collect::<Vec<_>>(),
            "tool_changes": stats.tool_changes,
            "warnings": out.warnings.iter().map(|w| w.message.clone()).collect::<Vec<_>>(),
            "gates": {
                "layers": out.layer_count,
                "layers_ok": bench.expect_layers == 0 || out.layer_count == bench.expect_layers,
                "gcode_valid": report.ok(),
                "gcode_errors": report.errors,
                "extrusion_mm": round2(total_e),
                "extrusion_delta_pct": delta_pct.map(round3),
                "shard_hash_equal": shard_equal,
            }
        }))
    })?;
    let gates_ok = gates_pass(&result);
    if let Some(path) = flag(args, "--append") {
        use std::io::Write as _;
        let mut line = serde_json::to_vec(&json!({
            "ts": flag(args, "--ts").unwrap_or(""),
            "loop": "native-slice",
            "change": flag(args, "--change").unwrap_or(""),
            "result": result,
        }))?;
        line.push(b'\n');
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
            .write_all(&line)?;
    }
    if quiet {
        println!("{}", serde_json::to_string(&result)?);
    } else {
        println!("{}", serde_json::to_string_pretty(&result)?);
        println!(
            "reference result: median {} ms, p90 {} ms, gates {}",
            result["median_ms"],
            result["p90_ms"],
            if gates_ok { "pass" } else { "FAIL" }
        );
    }
    Ok(if gates_ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn gates_pass(r: &Value) -> bool {
    let g = &r["gates"];
    g["layers_ok"].as_bool() == Some(true)
        && g["gcode_valid"].as_bool() == Some(true)
        && g["extrusion_delta_pct"].as_f64().is_none_or(|d| d.abs() <= 1.0)
        && g["shard_hash_equal"].as_bool() != Some(false)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// Interleaved A/B: alternates `rounds` single-run invocations of the
/// baseline binary and this binary, so background load hits both equally.
fn ab(args: &[String], cfg_path: &str, base: &str, rounds: usize) -> Res<ExitCode> {
    let me = std::env::current_exe()?;
    let threads = flag(args, "--threads").unwrap_or("0");
    let run = |bin: &Path| -> Res<f64> {
        let out = std::process::Command::new(bin)
            .args([
                "bench",
                "--config",
                cfg_path,
                "--runs",
                "3",
                "--warmup",
                "2",
                "--threads",
                threads,
                "--json",
                "--no-shards",
            ])
            .output()?;
        let v: Value = serde_json::from_slice(&out.stdout)
            .map_err(|e| format!("{}: {e}: {}", bin.display(), String::from_utf8_lossy(&out.stderr)))?;
        Ok(v["median_ms"].as_f64().ok_or("no median")?)
    };
    let mut a = Vec::new();
    let mut b = Vec::new();
    for _ in 0..rounds {
        a.push(run(Path::new(base))?);
        b.push(run(&me)?);
    }
    a.sort_by(f64::total_cmp);
    b.sort_by(f64::total_cmp);
    let (ma, mb) = (percentile(&a, 0.5), percentile(&b, 0.5));
    let gain = (ma - mb) / ma * 100.0;
    println!(
        "{}",
        json!({"baseline_ms": round2(ma), "candidate_ms": round2(mb), "gain_pct": round2(gain), "baseline_runs": a, "candidate_runs": b, "keep": gain >= 2.0})
    );
    Ok(ExitCode::SUCCESS)
}
