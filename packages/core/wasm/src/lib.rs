// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-wasm: `sx-core` for one browser Web Worker.
//!
//! A plain C ABI rather than wasm-bindgen, so the build needs only cargo and
//! the JS side stays a few lines (`packages/core/web/src/wasm.ts`). Byte
//! buffers cross through one input buffer the module owns: JS asks for it with
//! `sx_input(len)`, writes into linear memory, then calls the function that
//! reads it. Results stay in the module until the next call and JS copies them
//! out through `sx_out_ptr` and `sx_out_len`. The worker is single-threaded, so
//! the state lives in a thread local. The unsafe items are the `no_mangle` export
//! attribute and the random source `getrandom` asks for (see the end of the file).
//!
//! Status codes: 0 is success; anything else means `sx_error_ptr` and
//! `sx_error_len` describe the failure.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use sx_core::api::{self, Mesh, PrintConfig, SliceSession};

#[derive(Default)]
struct State {
    input: Vec<u8>,
    meshes: HashMap<u32, Arc<Mesh>>,
    next_mesh: u32,
    session: Option<(u64, api::SliceRequest, PrintConfig, SliceSession)>,
    /// The settings of the request being finished, set by `sx_set_request`.
    finish_config: Option<PrintConfig>,
    /// What `filename_format` reads from that request besides the settings.
    finish_names: sx_core::outname::NameInfo,
    /// The image for the next `sx_finalize`, set by `sx_set_thumbnail`.
    thumb: Option<sx_core::thumbnail::Thumb>,
    /// The collision model's facts and every shard's hits for the next `sx_finalize`, set by `sx_set_collisions`.
    collide: Option<(sx_core::collide::Meta, sx_core::collide::Hits)>,
    /// What the safety preflight lowered in the request's settings, reported with shard 0.
    config_issues: Vec<String>,
    /// 0: G-code, 1: SXPV, 2: JSON info, 3: mesh parts in the raw format.
    out: [Vec<u8>; 4],
    error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State { next_mesh: 1, ..State::default() });
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

fn fail(msg: String) -> u32 {
    with(|s| s.error = msg.into_bytes());
    1
}

fn ptr(v: &[u8]) -> u32 {
    // wasm32 addresses are 32 bits.
    u32::try_from(v.as_ptr() as usize).unwrap_or(0)
}

/// Resizes the input buffer to `len` bytes and returns its address.
#[unsafe(no_mangle)]
pub extern "C" fn sx_input(len: u32) -> u32 {
    with(|s| {
        s.input.clear();
        s.input.resize(len as usize, 0);
        ptr(&s.input)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn sx_error_ptr() -> u32 {
    with(|s| ptr(&s.error))
}

#[unsafe(no_mangle)]
pub extern "C" fn sx_error_len() -> u32 {
    with(|s| u32::try_from(s.error.len()).unwrap_or(0))
}

/// Address of output `which` (0 G-code, 1 SXPV, 2 JSON info, 3 mesh parts).
#[unsafe(no_mangle)]
pub extern "C" fn sx_out_ptr(which: u32) -> u32 {
    with(|s| s.out.get(which as usize).map_or(0, |v| ptr(v)))
}

#[unsafe(no_mangle)]
pub extern "C" fn sx_out_len(which: u32) -> u32 {
    with(|s| {
        s.out
            .get(which as usize)
            .map_or(0, |v| u32::try_from(v.len()).unwrap_or(0))
    })
}

/// Loads a model from the input buffer. The input holds the file name, a zero
/// byte, then the file bytes. Returns the mesh id (at least 1) or 0 on error;
/// output 2 holds `{"id","triangles","parts":[...],"bbox":[...]}`.
#[unsafe(no_mangle)]
pub extern "C" fn sx_load_mesh() -> u32 {
    let result = with(|s| {
        let split = s.input.iter().position(|&b| b == 0).ok_or("missing file name")?;
        let name = String::from_utf8_lossy(s.input.get(..split).unwrap_or(&[])).into_owned();
        let bytes = s.input.get(split + 1..).unwrap_or(&[]);
        let mesh = Mesh::load(bytes, &name).map_err(|e| e.to_string())?;
        let id = s.next_mesh;
        s.next_mesh += 1;
        let (lo, hi) = mesh.bounds().unwrap_or(([0.0; 3], [0.0; 3]));
        let parts: Vec<serde_json::Value> = mesh
            .parts
            .iter()
            .map(|p| serde_json::json!({"name": p.name, "slot": p.slot, "color": p.color, "triangles": p.triangles.len()}))
            .collect();
        let info = serde_json::json!({
            "id": id, "name": mesh.name, "triangles": mesh.triangle_count(),
            "hash": format!("{:016x}", mesh.content_hash()),
            "bboxMm": [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], "min": lo, "max": hi, "parts": parts,
        });
        s.out[2] = serde_json::to_vec(&info).map_err(|e| e.to_string())?;
        s.meshes.insert(id, Arc::new(mesh));
        Ok::<u32, String>(id)
    });
    result.unwrap_or_else(|e| {
        fail(e);
        0
    })
}

/// Reads the settings of a 3MF project from the input buffer (the file name,
/// a zero byte, the file bytes) without loading geometry. Output 2 holds
/// `{"projectSettings"?, "modelSettings"?, "layerRanges"?}`, the request shape
/// of `import_project_json`. Returns 0 on success.
#[unsafe(no_mangle)]
pub extern "C" fn sx_project_metadata() -> u32 {
    let result = with(|s| {
        let split = s.input.iter().position(|&b| b == 0).ok_or("missing file name")?;
        let name = String::from_utf8_lossy(s.input.get(..split).unwrap_or(&[])).into_owned();
        let bytes = s.input.get(split + 1..).unwrap_or(&[]);
        let meta = api::project_metadata(bytes, &name).map_err(|e| e.to_string())?;
        s.out[2] = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    });
    match result {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

/// Writes a loaded mesh's parts to output 3 in the raw parts format (`SXMP`),
/// positions in the file's build space. Returns 0, or 1 for an unknown id.
#[unsafe(no_mangle)]
pub extern "C" fn sx_mesh_parts(id: u32) -> u32 {
    let bytes = with(|s| s.meshes.get(&id).map(|m| m.to_raw()));
    match bytes {
        Some(b) => {
            with(|s| s.out[3] = b);
            0
        }
        None => fail(format!("unknown mesh id {id}")),
    }
}

/// Drops a mesh.
#[unsafe(no_mangle)]
pub extern "C" fn sx_release_mesh(id: u32) {
    with(|s| {
        s.meshes.remove(&id);
    });
}

/// Slices shard `shard` of `shards` equal layer ranges for the request JSON
/// in the input buffer. Outputs: 0 G-code chunk, 1 SXPV chunk, 2 JSON with
/// layer range, layer z and times, stats, stage timings and warnings. The
/// prepared session is reused while the request stays the same.
#[unsafe(no_mangle)]
pub extern "C" fn sx_slice_shard(shard: u32, shards: u32) -> u32 {
    let result = with(|s| -> Result<(), String> {
        let key = fnv(&s.input);
        let cached = s.session.as_ref().is_some_and(|(k, ..)| *k == key);
        if !cached {
            let req: api::SliceRequest =
                serde_json::from_slice(&s.input).map_err(|e| format!("request: {e}"))?;
            let (config, issues) = api::request_config_checked(&req).map_err(|e| e.to_string())?;
            s.config_issues = issues.into_iter().map(|i| i.message).collect();
            let meshes = &s.meshes;
            let resolve = |id: &str| -> api::Result<Arc<Mesh>> {
                id.trim()
                    .parse::<u32>()
                    .ok()
                    .and_then(|k| meshes.get(&k).cloned())
                    .ok_or_else(|| api::Error::Mesh {
                        name: id.to_owned(),
                        reason: "unknown mesh id".to_owned(),
                    })
            };
            let plate = api::build_plate(&req, &resolve).map_err(|e| e.to_string())?;
            let session = api::build_session(&req, &plate, &config).map_err(|e| e.to_string())?;
            s.session = Some((key, req, config, session));
        }
        let (_, req, config, session) = s.session.as_ref().ok_or("no session")?;
        let n = session.layer_count();
        let shards = shards.max(1);
        let lo = u32::try_from(u64::from(n) * u64::from(shard) / u64::from(shards)).unwrap_or(n);
        let hi = u32::try_from(u64::from(n) * u64::from(shard + 1) / u64::from(shards)).unwrap_or(n);
        let mut gcode = Vec::new();
        let (out, stats) = api::slice_shard(
            req,
            session,
            config,
            lo..hi.min(n),
            &sx_core::NoProgress,
            &mut gcode,
        )
        .map_err(|e| e.to_string())?;
        // The preview's extras (fan, temperature, retraction, seam, G-code line), the lines counted from each
        // layer's marker until the stitch knows where the layers land in the finished file.
        let sxpv = if sx_core::firmware::truthy(config, "binary_gcode") {
            sx_core::preview_buffers(&out)
        } else {
            let resume_at = req.options.resume_from_layer.filter(|&r| r > 0).unwrap_or(0);
            let parsed = sx_core::extras::parse(&out, config, resume_at, &String::from_utf8_lossy(&gcode));
            let layers: Vec<(u32, sx_core::extras::LayerExtras)> =
                out.layers.iter().map(|l| l.index).zip(parsed).collect();
            sx_core::preview::with_layer_extras(sx_core::preview_buffers(&out), &layers)
        };
        let mut warnings = serde_json::to_value(&out.warnings).map_err(|e| e.to_string())?;
        if shard == 0
            && let Some(list) = warnings.as_array_mut()
        {
            list.extend(
                s.config_issues
                    .iter()
                    .map(|m| serde_json::json!({"code": "safety_limit", "message": m})),
            );
        }
        let info = serde_json::json!({
            "layerCount": n, "first": lo, "last": hi,
            "layerZ": out.layers.iter().map(|l| l.z).collect::<Vec<_>>(),
            "layerTimeS": out.layers.iter().map(|l| l.time_s).collect::<Vec<_>>(),
            "stats": stats, "stageMicros": out.stage_micros, "warnings": warnings,
            "toolCount": out.tool_count,
            "primeTower": out.prime_tower,
            "varyLayerCost": out.vary_layer_cost,
            "filamentMap": out.filament_map.as_ref().map(api::FilamentMapReport::from),
            "collide": session.collide_meta().map(|m| serde_json::json!({"meta": if shard == 0 { m.to_json() } else { serde_json::Value::Null }, "hits": out.collisions.to_numbers()})),
        });
        s.out = [
            gcode,
            sxpv,
            serde_json::to_vec(&info).map_err(|e| e.to_string())?,
            Vec::new(),
        ];
        Ok(())
    });
    match result {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

/// Turns the markers in the whole G-code file in the input buffer (the shards
/// joined in order) into `M73` progress and the statistics footer. Output 0
/// holds the finished file; output 2 is JSON with its format, time, the start before the first layer and each
/// layer's own seconds (`prepareS`, `layerTimeS`), file name and
/// `layerLines`, the 1-based line of each layer marker (`extras::layer_lines`), and `progressLines`, those of the progress lines
/// written after moves, for `preview::stitch_lines`. Returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn sx_finalize() -> u32 {
    with(|s| {
        let thumb = s.thumb.take();
        let cfg = s.finish_config.take();
        let (text, timing) = sx_core::firmware::finalize_timed(&s.input, thumb.as_ref(), cfg.as_ref());
        // The collisions at the times the finished file reads.
        let collisions = s.collide.take().map(|(meta, hits)| {
            #[allow(clippy::cast_possible_truncation, reason = "seconds of a layer")]
            let layer_s: Vec<f32> = timing.layer_s.iter().map(|&t| t as f32).collect();
            api::collision_report(Some(&meta), &hits, &layer_s, timing.prepare_s)
        });
        // The finished file's time (the footer's), which the shards' own sums cannot know.
        let time_s = sx_core::firmware::footer_time(&text);
        let binary = cfg
            .as_ref()
            .is_some_and(|c| sx_core::firmware::truthy(c, "binary_gcode"));
        let names = std::mem::take(&mut s.finish_names);
        let file_name = cfg
            .as_ref()
            .and_then(|c| sx_core::outname::file_name(c, &names, &text, binary).ok());
        let text = match cfg
            .as_ref()
            .map(|c| sx_core::firmware::substitute(text.clone(), c))
        {
            Some(Ok((t, _))) => t,
            _ => text,
        };
        // Where each layer starts in the finished file, so the stitch can make the preview's G-code lines absolute.
        let (layer_lines, progress_lines) = if binary {
            (Vec::new(), Vec::new())
        } else {
            let t = String::from_utf8_lossy(&text);
            (
                sx_core::extras::layer_lines(&t),
                sx_core::extras::progress_lines(&t),
            )
        };
        let numbered = !binary
            && cfg
                .as_ref()
                .is_some_and(|c| sx_core::firmware::truthy(c, "gcode_add_line_number"));
        let text = if numbered {
            sx_core::firmware::number_lines(&text)
        } else {
            text
        };
        s.out[0] = match cfg {
            Some(c) if binary => sx_core::bgcode::encode(&String::from_utf8_lossy(&text), &c),
            _ => text,
        };
        let (list, fixes) = collisions.map(|r| (r.collisions, r.fixes)).unwrap_or_default();
        s.out[2] = serde_json::to_vec(&serde_json::json!({"format": if binary { "bgcode" } else { "gcode" }, "timeS": time_s, "prepareS": timing.prepare_s, "layerTimeS": timing.layer_s, "fileName": file_name, "layerLines": layer_lines, "progressLines": progress_lines, "collisions": list, "collisionFixes": fixes})).unwrap_or_default();
    });
    0
}

/// Keeps the settings of the request in the input buffer (request JSON, meshes not needed)
/// for the next `sx_finalize`, which writes binary G-code when they ask for it. Returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn sx_set_request() -> u32 {
    let result = with(|s| -> Result<(), String> {
        let req: api::SliceRequest = serde_json::from_slice(&s.input).map_err(|e| format!("request: {e}"))?;
        s.finish_config = Some(api::request_config(&req).map_err(|e| e.to_string())?);
        s.finish_names = api::name_info(&req);
        Ok(())
    });
    match result {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

/// Keeps the collision model's facts and the shards' hits in the input buffer (`{"meta": ..., "hits": [...]}`: the
/// `collide` of shard 0's JSON with every shard's hit numbers joined) for the next `sx_finalize`, which reports them at
/// the finished file's times.
/// Returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn sx_set_collisions() -> u32 {
    let result = with(|s| -> Result<(), String> {
        let v: serde_json::Value =
            serde_json::from_slice(&s.input).map_err(|e| format!("collisions: {e}"))?;
        let meta = sx_core::collide::Meta::from_json(v.get("meta").unwrap_or(&serde_json::Value::Null));
        let numbers: Vec<f64> = v
            .get("hits")
            .and_then(serde_json::Value::as_array)
            .map(|a| a.iter().filter_map(serde_json::Value::as_f64).collect())
            .unwrap_or_default();
        s.collide = Some((meta, sx_core::collide::Hits::from_numbers(&numbers)));
        Ok(())
    });
    match result {
        Ok(()) => 0,
        Err(e) => fail(e),
    }
}

/// Keeps the image in the input buffer (raw RGBA, `width` by `height`) for the next
/// `sx_finalize`, which writes it as the thumbnails the profile asks for. Returns 0,
/// or 1 when the bytes do not match the size.
#[unsafe(no_mangle)]
pub extern "C" fn sx_set_thumbnail(width: u32, height: u32) -> u32 {
    let result = with(|s| {
        s.thumb = sx_core::thumbnail::Thumb::new(width, height, std::mem::take(&mut s.input));
        s.thumb.is_some()
    });
    if result {
        0
    } else {
        fail("thumbnail: the bytes do not match the size".to_owned())
    }
}

fn fnv(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The random source the `getrandom` crate looks for when its backend is `custom` (set for this target in
/// `.cargo/config.toml`). A dependency of the wall generator, the skip list of the Voronoi builder, asks for
/// random numbers to balance itself; the results do not depend on them, so a fixed sequence keeps every run
/// the same.
///
/// # Safety
/// `dest` points to `len` writable bytes, as `getrandom` guarantees when it calls this.
#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(dest: *mut u8, len: usize) -> Result<(), getrandom::Error> {
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    // SAFETY: the caller hands over `len` bytes it owns.
    let out = unsafe { std::slice::from_raw_parts_mut(dest, len) };
    for b in out {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        #[allow(clippy::cast_possible_truncation, reason = "a byte of the state")]
        {
            *b = x as u8;
        }
    }
    Ok(())
}
