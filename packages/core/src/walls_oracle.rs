// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Test-only check of the walls a layer's own region takes from the shared per-layer memo: while a check runs,
//! every region that reaches the shared walls branch also works its walls out from scratch with the top context, as
//! they were built before the memo was shared (`arachne::reference` for variable-width walls, `walls_for_top` for
//! classic ones), and the two must match bit for bit (points, widths, loops, gaps and the infill area).

use crate::shells::Walls;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

static ON: AtomicBool = AtomicBool::new(false);
static STATS: Mutex<Stats> = Mutex::new(Stats::new());
/// One check at a time: the counters are shared by the whole process.
static SERIAL: Mutex<()> = Mutex::new(());

/// What one check saw, by region of a layer.
#[derive(Debug, Clone, Default)]
pub(crate) struct Stats {
    /// Regions compared.
    pub(crate) compared: usize,
    /// Regions that read the memo while a top context was there (the walls shared since this check was added).
    pub(crate) shared_top: usize,
    /// Regions that read the memo with no top context.
    pub(crate) shared_plain: usize,
    /// Regions worked out on their own with a top context.
    pub(crate) own_top: usize,
    /// Regions worked out on their own with none.
    pub(crate) own_plain: usize,
    /// Layers of the regions that did not match.
    pub(crate) mismatched: Vec<u32>,
    /// Distinct layers compared.
    pub(crate) layers: std::collections::BTreeSet<u32>,
}

impl Stats {
    const fn new() -> Self {
        Self {
            compared: 0,
            shared_top: 0,
            shared_plain: 0,
            own_top: 0,
            own_plain: 0,
            mismatched: Vec::new(),
            layers: std::collections::BTreeSet::new(),
        }
    }
}

fn stats() -> std::sync::MutexGuard<'static, Stats> {
    STATS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Called for each region of the shared walls branch: `walls` is what the layer prints, `shared` whether it came from
/// the memo, `with_top` whether a top context was there, `fresh` the walls worked out with it from scratch as before.
pub(crate) fn check(layer: u32, walls: &Walls, shared: bool, with_top: bool, fresh: impl FnOnce() -> Walls) {
    if !ON.load(Ordering::SeqCst) {
        return;
    }
    let same = format!("{walls:?}") == format!("{:?}", fresh());
    let mut s = stats();
    s.compared += 1;
    let _ = s.layers.insert(layer);
    match (shared, with_top) {
        (true, true) => s.shared_top += 1,
        (true, false) => s.shared_plain += 1,
        (false, true) => s.own_top += 1,
        (false, false) => s.own_plain += 1,
    }
    if !same {
        s.mismatched.push(layer);
    }
}

/// Runs `f` with the check on, and what it saw.
pub(crate) fn run<R>(f: impl FnOnce() -> R) -> (R, Stats) {
    let _serial = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *stats() = Stats::new();
    ON.store(true, Ordering::SeqCst);
    let r = f();
    ON.store(false, Ordering::SeqCst);
    let s = std::mem::take(&mut *stats());
    (r, s)
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::api::{self, Mesh, SliceRequest};
    use serde_json::{Value, json};
    use std::fmt::Write as _;
    use std::sync::Arc;

    /// Facets of a closed box over the square of half size `half` around the origin, from `z0` to `z1`.
    fn block(half: f64, z0: f64, z1: f64, out: &mut String) {
        let poly = [(-half, -half), (half, -half), (half, half), (-half, half)];
        let mut facet = |a: (f64, f64, f64), b: (f64, f64, f64), d: (f64, f64, f64)| {
            let _ = writeln!(out, "facet normal 0 0 0\n outer loop");
            for v in [a, b, d] {
                let _ = writeln!(out, "  vertex {} {} {}", v.0, v.1, v.2);
            }
            let _ = writeln!(out, " endloop\nendfacet");
        };
        for i in 0..4 {
            let (a, b) = (poly[i], poly[(i + 1) % 4]);
            facet((0.0, 0.0, z0), (b.0, b.1, z0), (a.0, a.1, z0));
            facet((0.0, 0.0, z1), (a.0, a.1, z1), (b.0, b.1, z1));
            facet((a.0, a.1, z0), (b.0, b.1, z0), (b.0, b.1, z1));
            facet((a.0, a.1, z0), (b.0, b.1, z1), (a.0, a.1, z1));
        }
    }

    /// A 12 mm block 2 mm tall with a 6 mm block on it to 4 mm: the ledge at 2 mm is a top surface inside the part,
    /// and the layers under it and under the top are covered by the layer above.
    fn stepped() -> Arc<Mesh> {
        let mut stl = String::from("solid stepped\n");
        block(6.0, 0.0, 2.0, &mut stl);
        block(3.0, 2.0, 4.0, &mut stl);
        stl.push_str("endsolid stepped\n");
        Arc::new(Mesh::load(stl.as_bytes(), "stepped.stl").unwrap())
    }

    fn slice_stepped(generator: &str) -> super::Stats {
        let m = stepped();
        let config = json!({
            "wall_generator": generator,
            "wall_loops": 3,
            "only_one_wall_top": true,
            "top_shell_layers": 3,
            "bottom_shell_layers": 3,
            "sparse_infill_density": "15%",
            "layer_height": 0.2,
            "initial_layer_print_height": 0.2,
            "brim_type": "no_brim",
            "skirt_loops": 0,
        });
        let req: SliceRequest =
            serde_json::from_value(json!({"plate": {"objects": [{"mesh": "m"}]}, "config": config})).unwrap();
        let (r, s) = run(|| api::run_request(&req, &|_: &str| Ok(m.clone())));
        assert!(r.is_ok(), "slice failed");
        s
    }

    /// The memo is shared under the top context on covered layers, the ledge layer keeps its own walls, and every
    /// region matches its walls worked out from scratch.
    #[test]
    fn shared_walls_match_their_own_on_a_stepped_part() {
        for generator in ["arachne", "aegis"] {
            let s = slice_stepped(generator);
            println!("walls-oracle stepped {generator}: {s:?}");
            assert!(
                s.mismatched.is_empty(),
                "{generator}: walls differ on layers {:?}",
                s.mismatched
            );
            assert!(
                s.shared_top > 0,
                "{generator}: no covered layer shared its walls: {s:?}"
            );
            assert!(
                s.own_top > 0,
                "{generator}: the ledge did not keep its own walls: {s:?}"
            );
        }
    }

    /// A request file as `sx slice --request` reads one whose meshes are plain files.
    fn request_run(path: &str) -> crate::Result<api::SliceRun> {
        let text = std::fs::read_to_string(path).expect("request");
        let raw: Value = serde_json::from_str(&text).expect("request JSON");
        let req: SliceRequest = serde_json::from_value(raw.clone()).expect("request");
        let base = std::path::Path::new(path)
            .parent()
            .unwrap_or(std::path::Path::new("."));
        let meshes: std::collections::HashMap<String, String> = raw
            .get("meshes")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| {
                        let file = v.as_str().or_else(|| v.get("file").and_then(Value::as_str))?;
                        Some((k.clone(), file.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let resolve = |id: &str| -> crate::Result<Arc<Mesh>> {
            let file = meshes.get(id).map_or(id, String::as_str);
            let path = base.join(file);
            let bytes = std::fs::read(&path).expect("mesh file");
            Ok(Arc::new(api::load_mesh(&bytes, file)?))
        };
        api::run_request(&req, &resolve)
    }

    /// A 3MF plate as `sx slice <file.3mf> --plate N` slices it: the engine's defaults, the project's settings, the
    /// object settings the items share, the machine limits, the items where the file puts them.
    fn project_run(path: &str, plate: u32) -> crate::Result<crate::SliceOutput> {
        let bytes = std::fs::read(path).expect("3MF");
        let (found, _) = api::load_3mf_items_counted(&bytes, path, Some(plate))?;
        let (plate_no, items) = found.expect("plate");
        let mut config = crate::config::PrintConfig::default();
        if let Some(project) = api::project_config(&bytes, path)? {
            let _ = config.apply_value_lenient(&Value::Object(project.settings))?;
        }
        let first = items.first().map_or(Value::Null, |m| m.settings.clone());
        let shared = items.iter().all(|m| m.settings == first);
        if shared && first.as_object().is_some_and(|m| !m.is_empty()) {
            let _ = config.apply_value_lenient(&api::with_bambu_tower_keys(&first))?;
        }
        let issues = crate::preflight::clamp_config(&mut config, &crate::gcode_lint::Limits::default());
        assert!(!crate::preflight::blocks(&issues), "blocked settings");
        let area = config.bed_rect();
        #[allow(clippy::cast_possible_truncation, reason = "bed sizes in mm fit f32")]
        let layout = [(area[2] - area[0]) as f32, (area[3] - area[1]) as f32];
        let placement = api::load_3mf_placement(&bytes, path, plate_no, layout)?;
        let mut plate = crate::plate::Plate::items_on(items, area, config.printable_height, placement);
        for o in plate.objects.iter_mut().filter(|_| !shared) {
            if let Some(own) = o.mesh.settings.as_object().filter(|m| !m.is_empty()) {
                o.settings = Value::Object(own.clone());
            }
        }
        let mut session = crate::session::SliceSession::new(&plate, &config)?;
        api::set_collision_check(&mut session, &plate, &config, None);
        session.slice_range_with(&config, 0..session.layer_count(), &crate::NoProgress)
    }

    /// Real inputs: the request files and 3MF plates named in `SX_WALLS_ORACLE` (separated by `:`; a 3MF as
    /// `file.3mf#N` for plate N, plate 1 without), sliced with the check on. Every region of every layer that reaches
    /// the shared walls branch must match its walls worked out from scratch.
    #[test]
    #[ignore = "slices the files named in SX_WALLS_ORACLE"]
    fn shared_walls_match_their_own_on_real_inputs() {
        let list = std::env::var("SX_WALLS_ORACLE").expect("SX_WALLS_ORACLE");
        let mut bad = Vec::new();
        for item in list.split(':').filter(|s| !s.is_empty()) {
            let (path, plate) = match item.rsplit_once('#') {
                Some((p, n)) if n.parse::<u32>().is_ok() => (p, n.parse().unwrap_or(1)),
                _ => (item, 1),
            };
            let (ok, s) = if std::path::Path::new(path)
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("3mf"))
            {
                let (r, s) = run(|| project_run(path, plate));
                (r.is_ok(), s)
            } else {
                let (r, s) = run(|| request_run(path));
                (r.is_ok(), s)
            };
            let name = std::path::Path::new(path)
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            println!(
                "walls-oracle {name}#{plate}: ok={ok} layers={} regions={} shared_top={} shared_plain={} own_top={} \
                 own_plain={} mismatched={:?}",
                s.layers.len(),
                s.compared,
                s.shared_top,
                s.shared_plain,
                s.own_top,
                s.own_plain,
                s.mismatched
            );
            if !ok || s.compared == 0 || !s.mismatched.is_empty() {
                bad.push(name);
            }
        }
        assert!(bad.is_empty(), "walls differ or nothing compared: {bad:?}");
    }
}
