// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx: slice from the command line and run the slicing benchmark.
//!
//! sx slice <model> [--plate N] [--config <json>] [-o out.gcode | -o -] [--preview out.sxpv]
//! sx time <file.gcode> --config <json> [--trace [--at <line prefix>]]
//! sx slice --request <req.json | -> [--out-dir <dir>] [--allow-collisions]
//! sx schema [request | result]
//! sx metadata <project.3mf>
//! sx bench --config <bench.json> [--runs 15] [--warmup 3] [--threads N]
//!          [--append <results.jsonl>] [--change <text>] [--ab <baseline sx>]
//!          [--write-baseline] [--json]
//!
//! `sx slice <model>` writes the G-code to `-o`, or to stdout without it; the
//! one-line summary and warnings go to stderr.
//!
//! `sx slice --request` reads a `SliceRequest` JSON (`sx schema request`) from
//! a file or stdin and prints a result JSON (`sx schema result`) with
//! `schemaVersion` on stdout. Object `mesh` values are keys of an optional
//! top-level `meshes` map (reference to file path) or file paths themselves,
//! relative to the request file; `file.3mf#2` picks plate 2 of a project.
//! With `--out-dir`, the G-code and SXPV are
//! written there as `slice.gcode` and `slice.sxpv`. A by-object plate where the head, gantry or tool changer would meet
//! a printed part (the result's `collisions`) is refused with exit code 3, unless `--allow-collisions` asks for it
//! anyway; close calls inside the profile's clearance radius pass with the result listing them.
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

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;
use sx_core::validate::validate_gcode;
use sx_core::{Mesh, Plate, PrintConfig, SliceOptions, SliceOutput, SliceSession, preview};

type Res<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("slice") if has(&args, "--request") => return cmd_request(&args[1..]),
        Some("slice") => cmd_slice(&args[1..]),
        Some("schema") => return cmd_schema(&args[1..]),
        Some("metadata") => cmd_metadata(&args[1..]),
        Some("bench") => cmd_bench(&args[1..]),
        Some("time") => cmd_time(&args[1..]),
        _ => {
            eprintln!(
                "usage: sx metadata <project.3mf>\n       sx slice <model> [--plate N] [--config <json>] [-o out.gcode] [--preview out.sxpv]\n       sx slice --request <req.json | -> [--out-dir <dir>] [--allow-collisions]\n       sx schema [request | result]\n       sx bench --config <bench.json> [--runs N] [--warmup N] [--threads N] [--append file] [--change text] [--ab <baseline sx>] [--write-baseline] [--json]\n       sx time <file.gcode> --config <json> [--trace [--at <line prefix>]]"
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

const EXIT_SLICE: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_INPUT: u8 = 3;

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
fn mesh_paths(raw: &Value) -> std::collections::HashMap<String, String> {
    raw.get("meshes")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
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

/// A 3MF plate given without a transform becomes one object per build item, each where the file
/// puts it with the plate centered on the bed, so print by object and its clearance checks see the
/// objects and not one merged mesh. Returns their meshes under the new keys.
fn split_projects(
    req: &mut sx_core::api::SliceRequest,
    base: &Path,
    paths: &std::collections::HashMap<String, String>,
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
        let plain = o.transform.is_none() && o.volumes.is_empty() && o.brim_points.is_empty();
        if !plain || !rel.to_ascii_lowercase().ends_with(".3mf") {
            out.push(o);
            continue;
        }
        let path = base.join(rel);
        let bytes = std::fs::read(&path).map_err(|e| sx_core::Error::Mesh {
            name: path.display().to_string(),
            reason: e.to_string(),
        })?;
        let plates = api::load_3mf_plate_objects(&bytes, rel)?;
        let items = match plate {
            Some(n) => plates.into_iter().find(|(p, _)| *p == n),
            None => plates.into_iter().next(),
        }
        .map(|(_, items)| items)
        .unwrap_or_default();
        if items.len() < 2 {
            out.push(o);
            continue;
        }
        // the plate is centered as a whole, as the merged mesh would be
        let merged = Mesh {
            name: rel.to_owned(),
            parts: items.iter().flat_map(|m| m.parts.iter().cloned()).collect(),
        };
        let at = sx_core::plate::centered_transform(&merged, bed);
        for (k, mesh) in items.into_iter().enumerate() {
            let id = format!("{key}@{}", k + 1);
            let mut one = o.clone();
            one.id = format!("{}-{}", if o.id.is_empty() { "object" } else { &o.id }, k + 1);
            one.name.clone_from(&mesh.name);
            one.mesh = Value::String(id.clone());
            one.transform = Some(at.to_vec());
            cache.insert(id, std::sync::Arc::new(mesh));
            out.push(one);
        }
    }
    req.plate.objects = out;
    Ok(cache)
}

fn cmd_request(args: &[String]) -> ExitCode {
    use std::sync::Arc;
    use sx_core::api;
    let fail = |code: u8, msg: String| {
        eprintln!("sx slice: {msg}");
        ExitCode::from(code)
    };
    let Some(src) = flag(args, "--request") else {
        return fail(EXIT_USAGE, "--request needs a path or -".into());
    };
    let (text, base) = if src == "-" {
        let mut buf = String::new();
        if let Err(e) = std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf) {
            return fail(EXIT_INPUT, format!("reading stdin: {e}"));
        }
        (buf, PathBuf::from("."))
    } else {
        match std::fs::read_to_string(src) {
            Ok(t) => (
                t,
                Path::new(src)
                    .parent()
                    .map_or_else(|| PathBuf::from("."), Path::to_path_buf),
            ),
            Err(e) => return fail(EXIT_INPUT, format!("reading {src}: {e}")),
        }
    };
    let raw: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return fail(EXIT_INPUT, format!("request JSON: {e}")),
    };
    let mut req: api::SliceRequest = match serde_json::from_value(raw.clone()) {
        Ok(r) => r,
        Err(e) => return fail(EXIT_INPUT, format!("request: {e}")),
    };
    #[cfg(feature = "stock-gcode")]
    if let Some(config) = req.config.as_object() {
        req.options.stock_gcode_keys = stock::stock_keys(config);
    }
    let paths = mesh_paths(&raw);
    let cache = match split_projects(&mut req, &base, &paths) {
        Ok(split) => std::sync::Mutex::new(split),
        Err(e) => return fail(EXIT_INPUT, e.to_string()),
    };
    let resolve = |id: &str| -> sx_core::Result<Arc<Mesh>> {
        if let Some(m) = cache.lock().ok().and_then(|c| c.get(id).cloned()) {
            return Ok(m);
        }
        let mesh = load_ref(&base, paths.get(id).map_or(id, String::as_str))?;
        if let Ok(mut c) = cache.lock() {
            c.insert(id.to_owned(), mesh.clone());
        }
        Ok(mesh)
    };
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
        Err(e) => return fail(EXIT_SLICE, e.to_string()),
    };
    if let Some(why) = collision_refusal(&run.report, args) {
        return fail(EXIT_INPUT, why);
    }
    let mut out = match serde_json::to_value(&run.report) {
        Ok(v) => v,
        Err(e) => return fail(EXIT_SLICE, e.to_string()),
    };
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

/// Why a slice is refused when its head, gantry or tool changer would meet a printed part, unless
/// `--allow-collisions` asks for it anyway.
fn collision_refusal(report: &sx_core::api::SliceReport, args: &[String]) -> Option<String> {
    let hits: Vec<String> = report
        .collisions
        .iter()
        .filter(|c| c.severity == sx_core::collide::Severity::Hit)
        .map(|c| format!("{}. {}", c.title, c.detail))
        .collect();
    (!hits.is_empty() && !args.iter().any(|a| a == "--allow-collisions"))
        .then(|| sx_core::Error::Clearance(hits.join(" ")).to_string())
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
    let trace = has(args, "--trace");
    let e = sx_core::printtime::estimate(&text, &config, trace);
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

fn cmd_slice(args: &[String]) -> Res<ExitCode> {
    let model = args
        .first()
        .filter(|a| !a.starts_with('-'))
        .ok_or("missing model path")?;
    let mut config = match flag(args, "--config") {
        Some(p) => PrintConfig::from_json(&std::fs::read(p)?)?,
        None => PrintConfig::default(),
    };
    #[cfg(feature = "stock-gcode")]
    {
        config.trusted_gcode_keys = stock::stock_keys(&config.raw);
    }
    // The same limits every entry point applies: settings past the nozzle and machine limits are lowered.
    let issues = sx_core::preflight::clamp_config(&mut config, &sx_core::gcode_lint::Limits::default());
    if sx_core::preflight::blocks(&issues) {
        return Err(sx_core::preflight::blocking_text(&issues).into());
    }
    for i in &issues {
        eprintln!("warning: {}", i.message);
    }
    let bytes = std::fs::read(model)?;
    let mesh = match flag(args, "--plate") {
        Some(n) => {
            let want: u32 = n.parse()?;
            sx_core::api::load_3mf_plates(&bytes, model)?
                .into_iter()
                .find(|(p, _)| *p == want)
                .map(|(_, m)| m)
                .ok_or_else(|| format!("{model} has no plate {want}"))?
        }
        None => Mesh::load(&bytes, model)?,
    };
    // The mesh goes to the middle of the profile's bed, as the desktop slicers do.
    let plate = Plate::single_on(mesh, config.bed_rect(), config.printable_height);
    let t = Instant::now();
    let out = sx_core::slice(&plate, &config, &SliceOptions::default())?;
    let mut gcode = Vec::new();
    let stats = sx_core::emit_gcode(&out, &config, config.gcode_flavor, &mut gcode)?;
    let gcode = sx_core::firmware::finalize_with_config(&gcode, None, Some(&config));
    // The name `filename_format` gives the file, from the model's file name.
    let names = sx_core::outname::NameInfo {
        objects: vec![
            Path::new(model)
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        ],
        ..Default::default()
    };
    let file_name = sx_core::outname::file_name(
        &config,
        &names,
        &gcode,
        sx_core::firmware::truthy(&config, "binary_gcode"),
    )?;
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
    let sxpv = sx_core::preview_buffers(&out);
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
    if let Some(i) = sx_core::preflight::nozzle_hardness(&config, &stats.filament_mm) {
        eprintln!("warning: {}", i.message);
    }
    eprintln!(
        "{} layers, {:.1} ms, {} bytes of G-code, {:.0} s estimated, filament {:?} mm, {} tool changes, file name {file_name}",
        out.layer_count,
        ms,
        gcode.len(),
        stats.time_s,
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
