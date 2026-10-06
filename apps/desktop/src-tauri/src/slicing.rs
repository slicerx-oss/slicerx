// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Native slicing with sx-core on every core (rayon). The request and result
//! JSON match what the WASM worker speaks, so the TypeScript side of both
//! hosts builds the same `SliceResult`. Preview and G-code bytes return raw
//! (`tauri::ipc::Response`), never as JSON arrays.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use sx_core::api::{SliceRequest, run_request};
use sx_core::{Error, Mesh};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

#[derive(Default)]
pub struct Slicer {
    meshes: Mutex<HashMap<u32, Arc<Mesh>>>,
    results: Mutex<HashMap<u32, Output>>,
    next: AtomicU32,
}

struct Output {
    gcode: Vec<u8>,
    sxpv: Vec<u8>,
}

impl Slicer {
    fn id(&self) -> u32 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A panic while holding the lock leaves plain data behind; keep serving.
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Loads a model from the raw request body. The file name comes in the
/// `x-sx-name` header. Returns the same info JSON as `sx_load_mesh`.
#[tauri::command]
pub fn load_mesh(request: Request<'_>, state: State<'_, Slicer>) -> Result<serde_json::Value, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("load_mesh expects raw bytes".into());
    };
    let name = crate::header::text(&request, "x-sx-name").unwrap_or_else(|| "model.stl".to_owned());
    let mesh = Mesh::load(bytes, &name).map_err(|e| e.to_string())?;
    let id = state.id();
    let (lo, hi) = mesh.bounds().unwrap_or(([0.0; 3], [0.0; 3]));
    let parts: Vec<serde_json::Value> = mesh
        .parts
        .iter()
        .map(|p| serde_json::json!({"name": p.name, "slot": p.slot, "color": p.color, "triangles": p.triangles.len()}))
        .collect();
    let info = serde_json::json!({
        "id": id, "name": mesh.name, "triangles": mesh.triangle_count(),
        "hash": format!("{:016x}", mesh.content_hash()),
        "bboxMm": [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], "parts": parts,
    });
    lock(&state.meshes).insert(id, Arc::new(mesh));
    Ok(info)
}

/// Runs a request through the engine's own request path (the one the CLI, MCP and WebAssembly builds use), so
/// sleipnir plans, height ranges, safety limits, object settings, volumes, thumbnails and G-code
/// substitution all behave the same here. Meshes are named by their numeric id.
fn run_slice(
    req: &SliceRequest,
    meshes: &HashMap<u32, Arc<Mesh>>,
) -> Result<(serde_json::Value, Output), String> {
    let lookup = |r: &str| -> sx_core::Result<Arc<Mesh>> {
        r.parse::<u32>()
            .ok()
            .and_then(|k| meshes.get(&k).cloned())
            .ok_or_else(|| Error::Config {
                key: "plate.objects.mesh",
                reason: format!("unknown mesh {r}"),
            })
    };
    let run = run_request(req, &lookup).map_err(|e| e.to_string())?;
    let info = serde_json::to_value(&run.report).map_err(|e| e.to_string())?;
    Ok((
        info,
        Output {
            gcode: run.gcode,
            sxpv: run.preview,
        },
    ))
}

/// Slices the whole plate off the main thread and keeps G-code and SXPV for
/// `get_gcode` and `get_preview`. Returns the report JSON with the result id.
#[tauri::command]
pub async fn slice(request: String, state: State<'_, Slicer>) -> Result<serde_json::Value, String> {
    let req: SliceRequest = serde_json::from_str(&request).map_err(|e| format!("request: {e}"))?;
    let meshes = lock(&state.meshes).clone();
    let (info, output) = tauri::async_runtime::spawn_blocking(move || run_slice(&req, &meshes))
        .await
        .map_err(|e| e.to_string())??;
    let id = state.id();
    lock(&state.results).insert(id, output);
    let mut info = info;
    if let Some(map) = info.as_object_mut() {
        map.insert("id".into(), id.into());
    }
    Ok(info)
}

#[tauri::command]
pub fn get_preview(id: u32, state: State<'_, Slicer>) -> Result<Response, String> {
    lock(&state.results)
        .get(&id)
        .map(|o| Response::new(o.sxpv.clone()))
        .ok_or_else(|| format!("unknown slice {id}"))
}

#[tauri::command]
pub fn get_gcode(id: u32, state: State<'_, Slicer>) -> Result<Response, String> {
    lock(&state.results)
        .get(&id)
        .map(|o| Response::new(o.gcode.clone()))
        .ok_or_else(|| format!("unknown slice {id}"))
}

/// Drops a mesh or a slice result.
#[tauri::command]
pub fn release(id: u32, state: State<'_, Slicer>) {
    lock(&state.meshes).remove(&id);
    lock(&state.results).remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A binary STL of an axis-aligned box from (0,0,0) to (x,y,z).
    fn cube_stl(x: f32, y: f32, z: f32) -> Vec<u8> {
        let v = [
            [0.0, 0.0, 0.0],
            [x, 0.0, 0.0],
            [x, y, 0.0],
            [0.0, y, 0.0],
            [0.0, 0.0, z],
            [x, 0.0, z],
            [x, y, z],
            [0.0, y, z],
        ];
        let f: [[usize; 3]; 12] = [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        let mut out = vec![0_u8; 80];
        out.extend_from_slice(&12_u32.to_le_bytes());
        for tri in f {
            for _ in 0..3 {
                out.extend_from_slice(&0.0_f32.to_le_bytes());
            }
            for i in tri {
                for c in v[i] {
                    out.extend_from_slice(&c.to_le_bytes());
                }
            }
            out.extend_from_slice(&[0, 0]);
        }
        out
    }

    fn add(state: &Slicer, name: &str, bytes: &[u8]) -> u32 {
        let id = state.id();
        let mesh = Mesh::load(bytes, name).expect("the test mesh loads");
        lock(&state.meshes).insert(id, Arc::new(mesh));
        id
    }

    fn at(x: f32, y: f32, z: f32) -> Vec<f32> {
        vec![
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0,
        ]
    }

    /// Runs the request the way the webview sends it: JSON text, then the code the command runs.
    fn run(state: &Slicer, request: serde_json::Value) -> Result<(serde_json::Value, Output), String> {
        let req: SliceRequest =
            serde_json::from_str(&request.to_string()).map_err(|e| format!("request: {e}"))?;
        let meshes = lock(&state.meshes).clone();
        run_slice(&req, &meshes)
    }

    fn plate(object: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "plate": { "bed": { "widthMm": 256, "depthMm": 256, "heightMm": 256 }, "objects": [object] }, "config": {} })
    }

    fn tools(info: &serde_json::Value) -> usize {
        info["stats"]["filamentMm"].as_array().map_or(0, Vec::len)
    }

    fn grams(info: &serde_json::Value) -> f64 {
        info["stats"]["filamentG"]
            .as_array()
            .map_or(0.0, |a| a.iter().filter_map(serde_json::Value::as_f64).sum())
    }

    #[test]
    fn slices_a_cube_to_gcode() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let (info, out) = run(&state, plate(serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) }))).expect("it slices");
        assert!(info["layerCount"].as_u64().unwrap_or(0) > 10);
        assert!(String::from_utf8_lossy(&out.gcode).contains("G1"));
        assert!(!out.sxpv.is_empty());
    }

    #[test]
    fn a_negative_volume_takes_material_out() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let cutter = add(&state, "cutter.stl", &cube_stl(8.0, 8.0, 20.0));
        let obj = |volumes: serde_json::Value| serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0), "volumes": volumes });
        // Solid infill, so the hole removes material instead of adding walls around itself.
        let solid = |mut r: serde_json::Value| {
            r["config"] = serde_json::json!({ "sparse_infill_density": "100%" });
            r
        };
        let (whole, _) = run(&state, solid(plate(obj(serde_json::json!([]))))).expect("whole slices");
        let cut = serde_json::json!([{ "name": "hole", "role": "negative", "mesh": cutter, "transform": at(106.0, 106.0, -5.0) }]);
        let (holed, _) = run(&state, solid(plate(obj(cut)))).expect("holed slices");
        assert!(
            grams(&holed) < grams(&whole),
            "{} should be under {}",
            grams(&holed),
            grams(&whole)
        );
    }

    #[test]
    fn object_settings_reach_the_engine() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let obj = |settings: serde_json::Value| serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0), "settings": settings });
        let (few, _) = run(
            &state,
            plate(obj(
                serde_json::json!({ "wall_loops": 1, "sparse_infill_density": "0%" }),
            )),
        )
        .expect("few walls slices");
        let (many, _) = run(
            &state,
            plate(obj(
                serde_json::json!({ "wall_loops": 6, "sparse_infill_density": "50%" }),
            )),
        )
        .expect("many walls slices");
        assert!(
            grams(&many) > grams(&few),
            "{} should be over {}",
            grams(&many),
            grams(&few)
        );
    }

    #[test]
    fn options_reach_the_engine_height_ranges_change_the_temperature() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let mut req = plate(
            serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) }),
        );
        req["options"] = serde_json::json!({ "heightRanges": [{ "zFromMm": 4.0, "zToMm": 9.0, "settings": { "nozzle_temperature": [243] } }] });
        let (_, out) = run(&state, req).expect("it slices with a height range");
        assert!(
            String::from_utf8_lossy(&out.gcode).contains("S243"),
            "the ranged temperature is in the G-code"
        );
    }

    /// Two cubes as two parts of one model, in filament slots 1 and 2, side by side.
    fn two_color_mesh() -> Mesh {
        let part = |name: &str, slot: u8, dx: f32| {
            let m = Mesh::load(&cube_stl(15.0, 15.0, 12.0), "c.stl").expect("cube loads");
            let mut p = m.parts.into_iter().next().expect("one part");
            p.name = name.to_owned();
            p.slot = slot;
            for v in &mut p.positions {
                v[0] += dx;
            }
            p
        };
        Mesh {
            name: "two".into(),
            parts: vec![part("left", 1, 0.0), part("right", 2, 20.0)],
        }
    }

    #[test]
    fn a_two_color_plate_changes_tools_and_uses_the_flush_matrix() {
        let state = Slicer::default();
        let id = state.id();
        lock(&state.meshes).insert(id, Arc::new(two_color_mesh()));
        let mut req = plate(
            serde_json::json!({ "id": "a", "name": "two", "mesh": id, "transform": at(90.0, 100.0, 0.0) }),
        );
        req["config"] = serde_json::json!({ "filament_colour": ["#ffffff", "#000000"], "flush_volumes_matrix": [0, 250, 250, 0], "flush_multiplier": 1.0, "enable_prime_tower": true });
        let (info, out) = run(&state, req.clone()).expect("a two color plate slices");
        assert_eq!(tools(&info), 2);
        assert!(
            info["stats"]["toolChanges"].as_u64().unwrap_or(0) > 0,
            "{}",
            info["stats"]
        );
        let first = grams(&info);
        assert!(String::from_utf8_lossy(&out.gcode).contains("T1"));
        // A bigger flush volume purges more filament.
        req["config"]["flush_volumes_matrix"] = serde_json::json!([0, 600, 600, 0]);
        let (more, _) = run(&state, req).expect("it slices with a bigger flush");
        assert!(grams(&more) > first, "{} should be over {}", grams(&more), first);
    }

    #[test]
    fn a_color_swap_moves_a_part_to_the_other_filament() {
        let state = Slicer::default();
        let id = state.id();
        lock(&state.meshes).insert(id, Arc::new(two_color_mesh()));
        let obj = |overrides: serde_json::Value| serde_json::json!({ "id": "a", "name": "two", "mesh": id, "transform": at(90.0, 100.0, 0.0), "slotOverrides": overrides });
        let (plain, _) = run(&state, plate(obj(serde_json::json!({})))).expect("plain");
        let (same, _) =
            run(&state, plate(obj(serde_json::json!({ "right": 1 })))).expect("both on one filament");
        assert_eq!(tools(&plain), 2);
        assert_eq!(tools(&same), 1);
    }

    /// What the app sends for a painted object: a one-object 3MF with paint_color on half of a cube's triangles.
    #[test]
    fn painted_color_from_a_3mf_makes_the_print_two_colors() {
        let state = Slicer::default();
        let mesh = Mesh::load(include_bytes!("testdata/painted-cube.3mf"), "painted-cube.3mf")
            .expect("the painted cube loads");
        assert!(
            mesh.parts.iter().any(|p| !p.paint.is_empty()),
            "the loader reads paint_color"
        );
        let id = state.id();
        lock(&state.meshes).insert(id, Arc::new(mesh));
        let mut req = plate(
            serde_json::json!({ "id": "a", "name": "painted", "mesh": id, "transform": at(100.0, 100.0, 0.0) }),
        );
        req["config"] = serde_json::json!({ "filament_colour": ["#ffffff", "#000000"] });
        let (info, _) = run(&state, req).expect("a painted object slices");
        assert_eq!(tools(&info), 2, "{}", info["stats"]);
    }

    #[test]
    fn a_modifier_volume_prints_the_object_inside_it_with_its_own_settings() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(30.0, 30.0, 10.0));
        let zone = add(&state, "zone.stl", &cube_stl(20.0, 20.0, 30.0));
        let obj = |volumes: serde_json::Value| serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0), "volumes": volumes });
        let mut base = plate(obj(serde_json::json!([])));
        base["config"] = serde_json::json!({ "sparse_infill_density": "5%" });
        let (plain, _) = run(&state, base).expect("plain slices");
        let modifier = serde_json::json!([{ "name": "dense", "role": "modifier", "mesh": zone, "transform": at(105.0, 105.0, -5.0), "settings": { "sparse_infill_density": "80%" } }]);
        let mut req = plate(obj(modifier));
        req["config"] = serde_json::json!({ "sparse_infill_density": "5%" });
        let (dense, _) = run(&state, req).expect("modifier slices");
        assert!(
            grams(&dense) > grams(&plain),
            "{} should be over {}",
            grams(&dense),
            grams(&plain)
        );
    }

    /// A cube with seam paint on one wall, against the same cube unpainted. The default seam sits at one corner, so
    /// enforcing it on the other walls moves it and changes the G-code; how many of the four walls do is checked below.
    #[test]
    fn seam_paint_from_a_3mf_moves_the_seam() {
        let state = Slicer::default();
        let walls: [(&str, &[u8]); 4] = [
            ("-x", include_bytes!("testdata/seam-cube-xn.3mf")),
            ("+x", include_bytes!("testdata/seam-cube-xp.3mf")),
            ("-y", include_bytes!("testdata/seam-cube-yn.3mf")),
            ("+y", include_bytes!("testdata/seam-cube-yp.3mf")),
        ];
        let mut moved = Vec::new();
        for (wall, bytes) in walls {
            let painted = Mesh::load(bytes, "seam-cube.3mf").expect("the seam cube loads");
            assert!(
                painted.parts.iter().any(|p| !p.seam_paint.is_empty()),
                "the loader reads paint_seam on the {wall} wall"
            );
            let mut plain = painted.clone();
            for p in &mut plain.parts {
                p.seam_paint.clear();
            }
            let a = state.id();
            lock(&state.meshes).insert(a, Arc::new(painted));
            let b = state.id();
            lock(&state.meshes).insert(b, Arc::new(plain));
            let req = |mesh: u32| {
                plate(
                    serde_json::json!({ "id": "a", "name": "cube", "mesh": mesh, "transform": at(100.0, 100.0, 0.0) }),
                )
            };
            let (painted_info, with_paint) = run(&state, req(a)).expect("painted slices");
            let (plain_info, without) = run(&state, req(b)).expect("plain slices");
            // Same shape, same layers: only where the loops start moves.
            assert_eq!(painted_info["layerCount"], plain_info["layerCount"]);
            if with_paint.gcode != without.gcode {
                moved.push(wall);
            }
        }
        assert!(
            moved.len() >= 2,
            "seam paint moved the seam on {moved:?} of the four walls"
        );
    }

    /// What the calibration towers send: custom G-code at a layer goes into the file at that layer, and the file has the
    /// markers the tool path tests use to swap in their own body.
    #[test]
    fn custom_layer_gcode_lands_at_its_layer_and_the_file_has_the_body_markers() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let mut req = plate(
            serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) }),
        );
        req["options"] = serde_json::json!({ "layerGcode": [{ "layer": 0, "kind": "custom", "gcode": "M593 F40.00 D0.15" }, { "layer": 10, "kind": "custom", "gcode": "SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=0" }] });
        let (_, out) = run(&state, req).expect("it slices with layer G-code");
        let text = String::from_utf8_lossy(&out.gcode).into_owned();
        let at_layer = |needle: &str| {
            text.find(needle)
                .map(|i| text[..i].matches(";LAYER_CHANGE").count())
        };
        assert_eq!(at_layer("M593 F40.00 D0.15"), Some(1), "first layer");
        assert_eq!(
            at_layer("SET_VELOCITY_LIMIT MINIMUM_CRUISE_RATIO=0"),
            Some(11),
            "eleventh layer"
        );
        assert!(text.contains(";LAYER_CHANGE\n"));
        assert!(text.contains("\n; end\n"));
        assert!(text.find(";LAYER_CHANGE\n") < text.rfind("\n; end\n"));
    }

    /// sleipnir sends the planned layer tops; the native slice uses exactly them.
    #[test]
    fn planned_layer_tops_set_the_layers() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let mut req = plate(
            serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) }),
        );
        req["options"] = serde_json::json!({ "layerTopsMm": [0.2, 0.4, 0.8, 1.2, 1.6, 2.2, 3.0, 3.8, 4.6, 5.4, 6.2, 7.0, 7.8, 8.6, 9.4, 10.0] });
        let (info, _) = run(&state, req).expect("it slices at the planned heights");
        assert_eq!(info["layerCount"], 16);
    }

    #[test]
    fn an_unknown_volume_role_or_mesh_is_an_error() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let obj = |volumes: serde_json::Value| serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0), "volumes": volumes });
        let e = run(
            &state,
            plate(obj(serde_json::json!([{ "role": "bogus", "mesh": cube }]))),
        )
        .err()
        .unwrap_or_default();
        assert!(e.contains("unknown role"), "{e}");
        let e = run(
            &state,
            plate(obj(serde_json::json!([{ "role": "negative", "mesh": 999 }]))),
        )
        .err()
        .unwrap_or_default();
        assert!(e.contains("unknown mesh"), "{e}");
    }
}
