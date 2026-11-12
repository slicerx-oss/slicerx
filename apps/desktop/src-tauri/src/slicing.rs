// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Native slicing with sx-core on every core (rayon). The request and result
//! JSON match what the WASM worker speaks, so the TypeScript side of both
//! hosts builds the same `SliceResult`. Preview and G-code bytes return raw
//! (`tauri::ipc::Response`), never as JSON arrays.
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sx_core::api::{
    Cancellable, Prepared, Progress, SliceRequest, Stage, prepare_with, run_prepared, session_key,
};
use sx_core::{Error, Mesh};
use tauri::State;
use tauri::ipc::{Channel, InvokeBody, Request, Response};

#[tauri::command]
pub async fn review_scripts(
    inputs: Vec<sx_core::script_review::ReviewInput>,
) -> Result<Vec<sx_core::script_review::Review>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inputs.iter().map(sx_core::script_review::review_known).collect()
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Gives the engine the memory Windows has available, before the first slice; Linux and macOS
/// read their own figure inside the engine, so there it changes nothing.
pub fn give_available_memory() {
    #[cfg(windows)]
    sx_core::api::set_available_memory(windows_memory().map(|(avail, _)| avail));
}

/// The physical memory available and in total, bytes, from `GlobalMemoryStatusEx`.
#[cfg(windows)]
fn windows_memory() -> Option<(u64, u64)> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: `status` is a valid MEMORYSTATUSEX with its length set.
    unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
    Some((status.ullAvailPhys, status.ullTotalPhys))
}

#[derive(Default)]
pub struct Slicer {
    meshes: Mutex<HashMap<u32, Arc<Mesh>>>,
    results: Mutex<HashMap<u32, Output>>,
    /// The cancel flag of each slice running, by the job number the page gave it.
    jobs: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    next: AtomicU32,
    /// The page load the meshes and results belong to. [`Slicer::page_start`] moves it on, and a load or slice the page
    /// before asked for that ends after that is let go instead of kept: no page could name it.
    page: AtomicU32,
    kept: Kept,
    checks: Checks,
}

/// The sessions of the last slices, newest first, by `session_key` (at most [`KEPT_SESSIONS`]): slicing the same
/// plate again, or after a change only to G-code or preview settings, starts from the session it left. Shared with
/// the slice running off the main thread.
#[derive(Default, Clone)]
struct Kept {
    sessions: Arc<Mutex<VecDeque<KeptSession>>>,
    /// Each mesh's content hash, worked out when a slice first needs it.
    hashes: Arc<Mutex<HashMap<u32, u64>>>,
}

/// A kept session and its `session_key`.
type KeptSession = (u64, Arc<Prepared>);

/// How many prepared sessions the desktop keeps. Each holds its plate's sliced layers, so the count is small; two
/// cover going back and forth between two plates or two settings.
const KEPT_SESSIONS: usize = 2;

struct Output {
    gcode: Vec<u8>,
    sxpv: Vec<u8>,
}

impl Slicer {
    fn id(&self) -> u32 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// A slice's G-code, for the agent bridge's export (agent_bridge::export_gcode).
    #[cfg(feature = "agent-bridge")]
    pub fn gcode(&self, id: u32) -> Option<Vec<u8>> {
        lock(&self.results).get(&id).map(|o| o.gcode.clone())
    }

    /// What the slicer holds now, for the agent bridge's health (agent_bridge::health).
    #[cfg(feature = "agent-bridge")]
    pub fn held(&self) -> Held {
        let (meshes_len, meshes_bytes) = {
            let meshes = lock(&self.meshes);
            (meshes.len(), meshes.values().map(|m| mesh_bytes(m)).sum())
        };
        let (results_len, results_bytes) = {
            let results = lock(&self.results);
            (
                results.len(),
                results.values().map(|o| o.gcode.len() + o.sxpv.len()).sum(),
            )
        };
        Held {
            meshes_len,
            meshes_bytes,
            results_len,
            results_bytes,
            kept_sessions: lock(&self.kept.sessions).len(),
        }
    }

    /// Keeps a loaded mesh, unless the page reloaded since it asked ([`Slicer::page_start`]).
    fn keep_mesh(&self, page: u32, id: u32, mesh: Mesh) -> bool {
        let mut meshes = lock(&self.meshes);
        if self.page.load(Ordering::SeqCst) != page {
            return false;
        }
        meshes.insert(id, Arc::new(mesh));
        true
    }

    /// Keeps a slice's G-code and preview, unless the page reloaded since it asked ([`Slicer::page_start`]).
    fn keep_result(&self, page: u32, id: u32, output: Output) -> bool {
        let mut results = lock(&self.results);
        if self.page.load(Ordering::SeqCst) != page {
            return false;
        }
        results.insert(id, output);
        true
    }

    /// A page starting: a launch, or a reload that forgot every id the page before it held. Everything that page loaded
    /// or sliced goes (meshes, results, the kept sessions made from its meshes), its slices still running stop, and a
    /// load or slice it asked for that ends after this is not kept. The id counter goes on, so no id comes back.
    fn page_start(&self) {
        self.page.fetch_add(1, Ordering::SeqCst);
        for (_, flag) in lock(&self.jobs).drain() {
            flag.store(true, Ordering::Relaxed);
        }
        lock(&self.meshes).clear();
        lock(&self.results).clear();
        lock(&self.kept.hashes).clear();
        lock(&self.kept.sessions).clear();
    }
}

/// What the slicer holds, for the agent bridge's health: meshes and slice results by count and bytes (geometry and
/// paint for a mesh, G-code and the preview not yet sent for a result), and the prepared sessions kept.
#[cfg(feature = "agent-bridge")]
pub struct Held {
    pub meshes_len: usize,
    pub meshes_bytes: usize,
    pub results_len: usize,
    pub results_bytes: usize,
    pub kept_sessions: usize,
}

/// About how many bytes a mesh's parts and volumes take: positions, triangles and paint, by capacity.
#[cfg(feature = "agent-bridge")]
fn mesh_bytes(mesh: &Mesh) -> usize {
    fn vec<T>(v: &Vec<T>) -> usize {
        v.capacity() * size_of::<T>()
    }
    let part = |p: &sx_core::MeshPart| {
        vec(&p.positions)
            + vec(&p.triangles)
            + vec(&p.paint)
            + vec(&p.support_paint)
            + vec(&p.seam_paint)
            + vec(&p.fuzzy_paint)
    };
    mesh.parts.iter().map(part).sum::<usize>() + mesh.volumes.iter().map(|v| part(&v.part)).sum::<usize>()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A panic while holding the lock leaves plain data behind; keep serving.
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Loads a model from the raw request body. The file name comes in the
/// `x-sx-name` header. Returns the same info JSON as `sx_load_mesh`.
///
/// Async, with the parse on the blocking pool: a sync command runs on the main thread, and a model of millions of
/// triangles held it for seconds, so the window could not close or quit while a file opened.
#[tauri::command]
pub async fn load_mesh(request: Request<'_>, state: State<'_, Slicer>) -> Result<serde_json::Value, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("load_mesh expects raw bytes".into());
    };
    let name = crate::header::text(&request, "x-sx-name").unwrap_or_else(|| "model.stl".to_owned());
    let bytes = bytes.clone();
    let page = state.page.load(Ordering::SeqCst);
    let (mesh, info) = tauri::async_runtime::spawn_blocking(move || mesh_info(&bytes, &name))
        .await
        .map_err(|e| e.to_string())??;
    let id = state.id();
    let mut info = info;
    if let Some(map) = info.as_object_mut() {
        map.insert("id".into(), id.into());
    }
    if !state.keep_mesh(page, id, mesh) {
        return Err(PAGE_GONE.into());
    }
    Ok(info)
}

/// Parses a model and describes it: the info JSON of `load_mesh`, without the id.
fn mesh_info(bytes: &[u8], name: &str) -> Result<(Mesh, serde_json::Value), String> {
    let mesh = Mesh::load(bytes, name).map_err(|e| e.to_string())?;
    let (lo, hi) = mesh.bounds().unwrap_or(([0.0; 3], [0.0; 3]));
    let parts: Vec<serde_json::Value> = mesh
        .parts
        .iter()
        .map(|p| serde_json::json!({"name": p.name, "slot": p.slot, "color": p.color, "triangles": p.triangles.len()}))
        .collect();
    let info = serde_json::json!({
        "name": mesh.name, "triangles": mesh.triangle_count(),
        "hash": format!("{:016x}", mesh.content_hash()),
        "bboxMm": [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], "parts": parts,
    });
    Ok((mesh, info))
}

/// One progress report for the page: the engine's stage (`SLICE_STAGES` in packages/contracts) and how far into it.
#[derive(Clone, serde::Serialize)]
pub struct SliceStep {
    stage: &'static str,
    fraction: f32,
}

fn stage_name(stage: Stage) -> &'static str {
    match stage {
        Stage::Layers => "layers",
        Stage::Contours => "contours",
        Stage::Perimeters => "perimeters",
        Stage::Surfaces => "surfaces",
        Stage::Infill => "infill",
        Stage::Paths => "paths",
        Stage::Gcode => "gcode",
        Stage::Preview => "preview",
    }
}

/// How often progress goes to the page at most, besides each new stage and each stage's end.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// Sends the engine's progress to the page, a few times a second: a new stage and the end of one always go, the
/// reports in between at most every [`PROGRESS_EVERY`]. Layers finish on several threads, so a report can come in
/// behind a later one; within a stage only a larger fraction goes.
pub struct SendProgress<F: Fn(SliceStep) + Sync> {
    send: F,
    last: Mutex<Option<(Instant, Stage, f32)>>,
}

impl<F: Fn(SliceStep) + Sync> SendProgress<F> {
    pub fn new(send: F) -> Self {
        Self {
            send,
            last: Mutex::new(None),
        }
    }
}

impl<F: Fn(SliceStep) + Sync> Progress for SendProgress<F> {
    fn report(&self, stage: Stage, fraction: f32) {
        let now = Instant::now();
        {
            let mut last = lock(&self.last);
            let due = match *last {
                Some((_, s, f)) if s == stage && fraction <= f => false,
                Some((at, s, _)) => s != stage || fraction >= 1.0 || now.duration_since(at) >= PROGRESS_EVERY,
                None => true,
            };
            if !due {
                return;
            }
            *last = Some((now, stage, fraction));
        }
        (self.send)(SliceStep {
            stage: stage_name(stage),
            fraction: fraction.clamp(0.0, 1.0),
        });
    }
}

/// Runs a request through the engine's own request path (the one the CLI, MCP and WebAssembly builds use), so
/// sleipnir plans, height ranges, safety limits, object settings, volumes, thumbnails and G-code
/// substitution all behave the same here. Meshes are named by their numeric id. The slice command runs it on a kept
/// session ([`run_slice_kept`]); this fresh run is what the tests compare that with.
#[cfg(test)]
fn run_slice(
    req: &SliceRequest,
    meshes: &HashMap<u32, Arc<Mesh>>,
    cancel: &AtomicBool,
    progress: &dyn Progress,
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
    let progress = Cancellable {
        progress,
        flag: cancel,
    };
    let run = sx_core::api::run_request_with(req, &lookup, &progress).map_err(|e| e.to_string())?;
    let info = serde_json::to_value(&run.report).map_err(|e| e.to_string())?;
    Ok((
        info,
        Output {
            gcode: run.gcode,
            sxpv: run.preview,
        },
    ))
}

/// [`run_slice`] on a session the slicer kept when the request's [`session_key`] matches one, else on a new one it
/// keeps after a run that finishes (a canceled or failed run keeps none). The same bytes either way.
fn run_slice_kept(
    req: &SliceRequest,
    meshes: &HashMap<u32, Arc<Mesh>>,
    kept: &Kept,
    cancel: &AtomicBool,
    progress: &dyn Progress,
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
    let hash = |r: &str| -> Option<u64> {
        let k = r.parse::<u32>().ok()?;
        if let Some(h) = lock(&kept.hashes).get(&k) {
            return Some(*h);
        }
        let h = meshes.get(&k)?.content_hash();
        lock(&kept.hashes).insert(k, h);
        Some(h)
    };
    let key = session_key(req, &hash);
    let hit = key.and_then(|k| {
        let mut list = lock(&kept.sessions);
        let at = list.iter().position(|(have, _)| *have == k)?;
        let hit = list.remove(at)?;
        let p = hit.1.clone();
        list.push_front(hit);
        Some(p)
    });
    let fresh = hit.is_none();
    // A new session is prepared beside the ones kept, which then wait for a later slice: each lets go of what such a
    // slice works out again first, so the new one slices with room. One a slice still runs on is left whole.
    if fresh {
        for (_, p) in lock(&kept.sessions).iter_mut() {
            if let Some(p) = Arc::get_mut(p) {
                p.lighten();
            }
        }
    }
    let progress = Cancellable {
        progress,
        flag: cancel,
    };
    // A new session reports its own progress (the layers stage) and stops on a cancel, so a big plate's bar moves
    // and Cancel works before the first contour.
    let prepared = match hit {
        Some(p) => p,
        None => Arc::new(prepare_with(req, &lookup, &progress).map_err(|e| e.to_string())?),
    };
    let run = run_prepared(req, &prepared, &progress).map_err(|e| e.to_string())?;
    if let (true, Some(k)) = (fresh, key) {
        let mut list = lock(&kept.sessions);
        list.retain(|(have, _)| *have != k);
        list.push_front((k, prepared));
        list.truncate(KEPT_SESSIONS);
    }
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
/// With `job`, `cancel_slice` with the same number stops it between stages, and it returns an error. The engine's
/// progress goes to the page on `on_progress`, a few times a second.
#[tauri::command]
pub async fn slice(
    request: String,
    job: Option<u32>,
    on_progress: Channel<SliceStep>,
    state: State<'_, Slicer>,
) -> Result<serde_json::Value, String> {
    let req: SliceRequest = serde_json::from_str(&request).map_err(|e| format!("request: {e}"))?;
    let page = state.page.load(Ordering::SeqCst);
    let meshes = lock(&state.meshes).clone();
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(j) = job {
        lock(&state.jobs).insert(j, flag.clone());
    }
    let run_flag = flag.clone();
    let kept = state.kept.clone();
    let ran = tauri::async_runtime::spawn_blocking(move || {
        let progress = SendProgress::new(move |step| {
            let _ = on_progress.send(step);
        });
        run_slice_kept(&req, &meshes, &kept, &run_flag, &progress)
    })
    .await
    .map_err(|e| e.to_string());
    if let Some(j) = job {
        // Only this slice's own entry: a page that reloaded counts its jobs from 1 again.
        let mut jobs = lock(&state.jobs);
        if jobs.get(&j).is_some_and(|f| Arc::ptr_eq(f, &flag)) {
            jobs.remove(&j);
        }
    }
    let (info, output) = ran??;
    let id = state.id();
    if !state.keep_result(page, id, output) {
        return Err(PAGE_GONE.into());
    }
    let mut info = info;
    if let Some(map) = info.as_object_mut() {
        map.insert("id".into(), id.into());
    }
    Ok(info)
}

/// What a load or slice answers when the page that asked for it reloaded before it ended; nothing is kept.
const PAGE_GONE: &str = "the page reloaded; nothing was kept";

/// Called by the page once as it starts, before its first model loads: lets go of every mesh and result an earlier page
/// left behind, since a reload forgets their ids and nothing would release them until the app quits.
#[tauri::command]
pub fn slicer_page_start(state: State<'_, Slicer>) {
    state.page_start();
}

/// Stops the slice running as `job`, if it still is. Its result is not kept.
#[tauri::command]
pub fn cancel_slice(job: u32, state: State<'_, Slicer>) {
    if let Some(flag) = lock(&state.jobs).get(&job) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// What a plate check a newer one overtook answers.
const CHECK_SKIPPED: &str = "plate check skipped: a newer one was asked for";
/// What a plate check an arrange started after it stopped answers.
const CHECK_CANCELED: &str = "plate check canceled: the plate is being arranged";

/// heimdall's check of a by-object plate before a slice ([`sx_core::api::check_plate`]), on the blocking pool, so the
/// window never waits on it. The shell numbers the checks as they are asked for (a page that reloads keeps counting
/// up): they run one at a time, and one a newer check or an arrange overtakes stops with an error, waiting or running,
/// so it never holds the pool for a plate nobody waits on. It slices nothing and keeps or touches no session.
#[tauri::command]
pub async fn check_plate(request: String, state: State<'_, Slicer>) -> Result<serde_json::Value, String> {
    let req: SliceRequest = serde_json::from_str(&request).map_err(|e| format!("request: {e}"))?;
    let (meshes, checks, job, arranges) = begin_check(&state);
    tauri::async_runtime::spawn_blocking(move || run_check(&req, &meshes, &checks, job, arranges))
        .await
        .map_err(|e| e.to_string())?
}

/// The checks asked for: the newest one's number, how many arranges have started, and a lock held while one runs.
#[derive(Default, Clone)]
struct Checks {
    newest: Arc<AtomicU32>,
    arranges: Arc<AtomicU32>,
    running: Arc<Mutex<()>>,
    /// How the checks read their stop, for the tests.
    #[cfg(test)]
    reads: Arc<tests::StopReads>,
}

/// A check asked for: the meshes it checks, the checks, its number (one past the newest so far) and the arranges
/// started so far.
fn begin_check(state: &Slicer) -> (HashMap<u32, Arc<Mesh>>, Checks, u32, u32) {
    let meshes = lock(&state.meshes).clone();
    let checks = state.checks.clone();
    let job = checks.newest.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    let arranges = checks.arranges.load(Ordering::Relaxed);
    (meshes, checks, job, arranges)
}

/// An arrange starting: every check asked for before it stops, and the meshes it lays out.
fn begin_arrange(state: &Slicer) -> HashMap<u32, Arc<Mesh>> {
    state.checks.arranges.fetch_add(1, Ordering::Relaxed);
    lock(&state.meshes).clone()
}

/// Runs check `job` once the one before it is done. A newer check asked for, or an arrange started after `arranges`
/// of them, stops it, before it starts or as it runs (between objects, bands of layers and moves), with an error and
/// no answer.
fn run_check(
    req: &SliceRequest,
    meshes: &HashMap<u32, Arc<Mesh>>,
    checks: &Checks,
    job: u32,
    arranges: u32,
) -> Result<serde_json::Value, String> {
    let newer = || checks.newest.load(Ordering::Relaxed) > job;
    let arranged = || checks.arranges.load(Ordering::Relaxed) != arranges;
    let stopped = || {
        if newer() {
            CHECK_SKIPPED.to_string()
        } else {
            CHECK_CANCELED.to_string()
        }
    };
    let _one = lock(&checks.running);
    if newer() || arranged() {
        return Err(stopped());
    }
    let lookup = |r: &str| -> sx_core::Result<Arc<Mesh>> {
        r.parse::<u32>()
            .ok()
            .and_then(|k| meshes.get(&k).cloned())
            .ok_or_else(|| Error::Config {
                key: "plate.objects.mesh",
                reason: format!("unknown mesh {r}"),
            })
    };
    let stop = || {
        let now = newer() || arranged();
        #[cfg(test)]
        checks.reads.note(now);
        now
    };
    let check = match sx_core::api::check_plate_until(req, &lookup, &stop) {
        Err(Error::Cancelled) => return Err(stopped()),
        other => other.map_err(|e| e.to_string())?,
    };
    serde_json::to_value(&check).map_err(|e| e.to_string())
}

/// Lays the plate out on the bed ([`sx_core::api::arrange_request`], `plate.placement` `arrange`), on the blocking pool,
/// so the window never waits on it: the layout sx and the MCP server give the same plate, from the meshes the page
/// loaded (by id, nothing sent again). The answer is the engine's report: each placed object's new transform, the
/// objects with no room, and with `newPlates` their layouts on new plates. `on_layout` gets the plate's first layout
/// before the plate check runs on it, so the page shows it at once. A page check asked for before it stops, so the
/// arrange never waits on the pool behind it. It slices nothing and keeps or touches no session.
#[tauri::command]
pub async fn arrange_plate(
    request: String,
    on_layout: Channel<serde_json::Value>,
    state: State<'_, Slicer>,
) -> Result<serde_json::Value, String> {
    let req: SliceRequest = serde_json::from_str(&request).map_err(|e| format!("request: {e}"))?;
    let meshes = begin_arrange(&state);
    tauri::async_runtime::spawn_blocking(move || {
        run_arrange(req, &meshes, &mut |v| {
            // A page that went away is not an error: the layout still comes back.
            let _ = on_layout.send(v.clone());
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The arrange of `req` with the meshes the shell holds, `first` getting the plate's first layout before the plate
/// check ([`sx_core::api::arrange_request_with`]).
fn run_arrange(
    mut req: SliceRequest,
    meshes: &HashMap<u32, Arc<Mesh>>,
    first: &mut dyn FnMut(&serde_json::Value),
) -> Result<serde_json::Value, String> {
    let lookup = |r: &str| -> sx_core::Result<Arc<Mesh>> {
        r.parse::<u32>()
            .ok()
            .and_then(|k| meshes.get(&k).cloned())
            .ok_or_else(|| Error::Config {
                key: "plate.objects.mesh",
                reason: format!("unknown mesh {r}"),
            })
    };
    req.plate.placement = sx_core::api::PlatePlacement::Arrange;
    let layout = sx_core::api::arrange_request_with(&mut req, &lookup, &mut |a| {
        if let Ok(v) = serde_json::to_value(a) {
            first(&v);
        }
    })
    .map_err(|e| e.to_string())?;
    serde_json::to_value(&layout).map_err(|e| e.to_string())
}

/// Hands the page a slice's preview, once: the bytes move to the response instead of being copied, and the slice keeps
/// none. The page reads each slice's preview once and keeps it; a second ask is an error.
#[tauri::command]
pub async fn get_preview(id: u32, state: State<'_, Slicer>) -> Result<Response, String> {
    take_preview(&state, id).map(Response::new)
}

fn take_preview(state: &Slicer, id: u32) -> Result<Vec<u8>, String> {
    let mut results = lock(&state.results);
    let out = results
        .get_mut(&id)
        .ok_or_else(|| format!("unknown slice {id}"))?;
    if out.sxpv.is_empty() {
        return Err(format!("the preview of slice {id} was already sent"));
    }
    Ok(std::mem::take(&mut out.sxpv))
}

#[tauri::command]
pub async fn get_gcode(id: u32, state: State<'_, Slicer>) -> Result<Response, String> {
    lock(&state.results)
        .get(&id)
        .map(|o| Response::new(o.gcode.clone()))
        .ok_or_else(|| format!("unknown slice {id}"))
}

/// Where each line of a slice's G-code starts, as little-endian u32 byte offsets, then one past the end. The G-code
/// stays here: the page's line view reads the lines it shows with `get_gcode_bytes`.
#[tauri::command]
pub async fn get_gcode_line_starts(id: u32, state: State<'_, Slicer>) -> Result<Response, String> {
    state.gcode_line_starts(id).map(Response::new)
}

/// Bytes `[start, end)` of a slice's G-code, clamped to its length.
#[tauri::command]
pub async fn get_gcode_bytes(
    id: u32,
    start: u64,
    end: u64,
    state: State<'_, Slicer>,
) -> Result<Response, String> {
    state.gcode_bytes(id, start, end).map(Response::new)
}

impl Slicer {
    /// The line starts of a result this map holds; an unknown id is an error. The page names a result by its id
    /// only: no path or other source reaches here.
    fn gcode_line_starts(&self, id: u32) -> Result<Vec<u8>, String> {
        let results = lock(&self.results);
        let o = results.get(&id).ok_or_else(|| format!("unknown slice {id}"))?;
        Ok(line_starts(&o.gcode))
    }

    /// Bytes `[start, end)` of a result this map holds, clamped to its G-code: a range past the end is cut there,
    /// and one that ends before it starts is empty.
    fn gcode_bytes(&self, id: u32, start: u64, end: u64) -> Result<Vec<u8>, String> {
        let results = lock(&self.results);
        let o = results.get(&id).ok_or_else(|| format!("unknown slice {id}"))?;
        let len = o.gcode.len();
        let a = usize::try_from(start).unwrap_or(len).min(len);
        let b = usize::try_from(end).unwrap_or(len).clamp(a, len);
        Ok(o.gcode[a..b].to_vec())
    }
}

/// Line starts of `text` as little-endian u32s: 0, the byte after each line break, then the length, with no empty
/// last line after a final break. An empty text has the one start 0.
fn line_starts(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 6 + 8);
    out.extend_from_slice(&0u32.to_le_bytes());
    if text.is_empty() {
        return out;
    }
    for (i, b) in text.iter().enumerate() {
        if *b == b'\n' {
            out.extend_from_slice(&u32::try_from(i + 1).unwrap_or(u32::MAX).to_le_bytes());
        }
    }
    if text.last() != Some(&b'\n') {
        out.extend_from_slice(&u32::try_from(text.len()).unwrap_or(u32::MAX).to_le_bytes());
    }
    out
}

/// Drops a mesh or a slice result. Dropping a mesh drops the kept sessions too, which may hold its layers.
#[tauri::command]
pub fn release(id: u32, state: State<'_, Slicer>) {
    state.release(id);
}

impl Slicer {
    fn release(&self, id: u32) {
        if lock(&self.meshes).remove(&id).is_some() {
            lock(&self.kept.hashes).remove(&id);
            lock(&self.kept.sessions).clear();
        }
        lock(&self.results).remove(&id);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_available_memory_is_below_total() {
        let (avail, total) = super::windows_memory().expect("GlobalMemoryStatusEx");
        assert!(avail > 0, "available {avail}");
        assert!(avail < total, "available {avail} of {total}");
    }

    use super::*;

    fn starts(text: &[u8]) -> Vec<u32> {
        line_starts(text)
            .chunks(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    #[test]
    fn gcode_reads_take_only_a_known_result_and_clamp_the_range() {
        let state = Slicer::default();
        lock(&state.results).insert(
            7,
            Output {
                gcode: b"G1\nG2\n".to_vec(),
                sxpv: Vec::new(),
            },
        );
        assert!(state.gcode_line_starts(8).is_err());
        assert!(state.gcode_bytes(8, 0, 1).is_err());
        assert_eq!(state.gcode_line_starts(7).unwrap().len(), 3 * 4);
        assert_eq!(state.gcode_bytes(7, 3, 6).unwrap(), b"G2\n");
        assert_eq!(state.gcode_bytes(7, 3, 600).unwrap(), b"G2\n");
        assert_eq!(state.gcode_bytes(7, 600, 900).unwrap(), b"");
        assert_eq!(state.gcode_bytes(7, 5, 2).unwrap(), b"");
        assert_eq!(state.gcode_bytes(7, 0, u64::MAX).unwrap(), b"G1\nG2\n");
        // Released, it is gone.
        lock(&state.results).remove(&7);
        assert!(state.gcode_bytes(7, 0, 1).is_err());
    }

    #[test]
    fn line_starts_end_past_the_last_line() {
        assert_eq!(starts(b""), vec![0]);
        assert_eq!(starts(b"G1\nG2\n"), vec![0, 3, 6]);
        assert_eq!(starts(b"G1\nG2"), vec![0, 3, 5]);
        assert_eq!(starts(b"\n\nM1"), vec![0, 1, 2, 4]);
    }
    use sx_core::api::NoProgress;

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
        run_slice(&req, &meshes, &AtomicBool::new(false), &NoProgress)
    }

    /// [`run`] through the kept sessions, as the slice command runs.
    fn run_kept(
        state: &Slicer,
        request: &serde_json::Value,
        cancel: bool,
    ) -> Result<(serde_json::Value, Output), String> {
        let req: SliceRequest =
            serde_json::from_str(&request.to_string()).map_err(|e| format!("request: {e}"))?;
        let meshes = lock(&state.meshes).clone();
        run_slice_kept(&req, &meshes, &state.kept, &AtomicBool::new(cancel), &NoProgress)
    }

    fn kept_count(state: &Slicer) -> usize {
        lock(&state.kept.sessions).len()
    }

    /// Two 20 mm cubes printed by object on a P1S, the second `gap` mm to the right of the first.
    fn by_object_pair(state: &Slicer, gap: f32) -> serde_json::Value {
        let a = add(state, "a.stl", &cube_stl(20.0, 20.0, 10.0));
        let b = add(state, "b.stl", &cube_stl(20.0, 20.0, 10.0));
        serde_json::json!({
            "plate": { "bed": { "widthMm": 256, "depthMm": 256, "heightMm": 250 }, "objects": [
                { "id": "a", "name": "a", "mesh": a, "transform": at(100.0, 100.0, 0.0) },
                { "id": "b", "name": "b", "mesh": b, "transform": at(120.0 + gap, 100.0, 0.0) },
            ] },
            "config": {
                "print_sequence": "by object", "printer_model": "Bambu Lab P1S", "printable_area": ["0x0", "256x0", "256x256"],
                "printable_height": 250, "extruder_clearance_max_radius": 68, "extruder_clearance_height_to_rod": 34,
                "extruder_clearance_dist_to_rod": 33, "extruder_clearance_height_to_lid": 90, "nozzle_height": 4.2,
                "brim_type": "no_brim", "skirt_loops": 0, "layer_height": 0.3, "initial_layer_print_height": 0.3,
            },
            "options": { "printerId": "bambu-p1s" },
        })
    }

    /// A check of `request` asked for now, to run with [`Asked::run`].
    struct Asked {
        req: SliceRequest,
        meshes: HashMap<u32, Arc<Mesh>>,
        checks: Checks,
        job: u32,
        arranges: u32,
    }

    impl Asked {
        fn run(&self) -> Result<serde_json::Value, String> {
            run_check(&self.req, &self.meshes, &self.checks, self.job, self.arranges)
        }
    }

    fn ask(state: &Slicer, request: &serde_json::Value) -> Asked {
        let req: SliceRequest = serde_json::from_str(&request.to_string()).expect("the request reads");
        let (meshes, checks, job, arranges) = begin_check(state);
        Asked {
            req,
            meshes,
            checks,
            job,
            arranges,
        }
    }

    /// Asks for a check of `request` as the check command does, and runs it.
    fn check(state: &Slicer, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        ask(state, request).run()
    }

    /// Stops every check of `state` asked for so far when dropped, so a failed test leaves no long check running.
    struct StopChecks(Arc<Slicer>);

    impl Drop for StopChecks {
        fn drop(&mut self) {
            self.0.checks.newest.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn a_plate_check_says_how_sure_each_strike_is_and_keeps_no_session() {
        let state = Slicer::default();
        let close = check(&state, &by_object_pair(&state, 3.0)).expect("the close pair checks");
        let hits = close["collisions"].as_array().expect("collisions");
        let sure = close["certainty"].as_array().expect("certainty");
        assert_eq!(hits.len(), sure.len(), "{close}");
        assert!(
            hits.iter()
                .zip(sure)
                .any(|(c, s)| c["severity"] == "hit" && s == "sure"),
            "the head comes down on the first cube: {close}"
        );
        assert!(
            close["unchecked"].as_array().is_some_and(Vec::is_empty),
            "{close}"
        );
        assert_eq!(close["order"], serde_json::json!(["a", "b"]));
        // Far apart, nothing the slice would refuse.
        let apart = check(&state, &by_object_pair(&state, 120.0)).expect("the far pair checks");
        assert!(
            !apart["collisions"]
                .as_array()
                .expect("collisions")
                .iter()
                .any(|c| c["severity"] == "hit"),
            "{apart}"
        );
        // It slices nothing, so it keeps no session for the slice.
        assert_eq!(kept_count(&state), 0);
    }

    #[test]
    fn a_plate_check_a_newer_one_overtook_is_skipped() {
        let state = Slicer::default();
        let request = by_object_pair(&state, 3.0);
        let older = ask(&state, &request);
        assert!(check(&state, &request).is_ok());
        assert_eq!(older.run(), Err(CHECK_SKIPPED.to_string()));
        // An unknown mesh is an error, not a clean plate.
        let mut lost = request.clone();
        lost["plate"]["objects"][0]["mesh"] = serde_json::json!(999);
        assert!(check(&state, &lost).is_err());
    }

    #[test]
    fn a_reloaded_page_gets_its_first_check_answered() {
        let state = Slicer::default();
        let request = by_object_pair(&state, 3.0);
        // The page before the reload asked for 40 checks; the shell keeps counting, so the new page's first is newest.
        state.checks.newest.store(40, Ordering::Relaxed);
        assert!(check(&state, &request).is_ok());
    }

    #[test]
    fn a_check_waiting_its_turn_when_an_arrange_starts_never_runs() {
        let state = Slicer::default();
        let request = by_object_pair(&state, 3.0);
        // A check runs; the next one waits for it.
        let running = lock(&state.checks.running);
        let waiting = ask(&state, &request);
        let answer = std::thread::scope(|s| {
            let answer = s.spawn(|| waiting.run());
            let _ = begin_arrange(&state);
            drop(running);
            answer.join().expect("the check thread")
        });
        assert_eq!(answer, Err(CHECK_CANCELED.to_string()));
        // A check asked for after the arrange started runs.
        assert!(check(&state, &request).is_ok());
    }

    /// `n` copies of one 20 mm cube `h` mm tall, all on one spot of the P1S bed, printed by object: every band of each
    /// copy meets every other copy, so its plate check runs a long time (8 copies 200 mm tall: about 20 s in a test
    /// build; 50 copies: minutes).
    fn stacked(state: &Slicer, n: usize, h: f32) -> serde_json::Value {
        let mut request = by_object_pair(state, 3.0);
        let mesh = add(state, "tall.stl", &cube_stl(20.0, 20.0, h));
        let objects: Vec<serde_json::Value> = (0..n)
            .map(|k| serde_json::json!({ "id": format!("c{k}"), "name": format!("c{k}"), "mesh": mesh, "transform": at(118.0, 118.0, 0.0) }))
            .collect();
        request["plate"]["objects"] = objects.into();
        request
    }

    /// How the checks of a [`Slicer`] read their stop: every read, and the read that first said stop (from 1; 0 while
    /// none has).
    #[derive(Default)]
    pub(super) struct StopReads {
        reads: std::sync::atomic::AtomicUsize,
        first: std::sync::atomic::AtomicUsize,
    }

    impl StopReads {
        pub(super) fn note(&self, stop: bool) {
            let k = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
            if stop {
                let _ = self
                    .first
                    .compare_exchange(0, k, Ordering::SeqCst, Ordering::SeqCst);
            }
        }

        fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }

        /// The reads after the one that first said stop, once one has.
        fn after_stop(&self) -> Option<usize> {
            let first = self.first.load(Ordering::SeqCst);
            (first > 0).then(|| self.reads() - first)
        }
    }

    /// Runs `f` on a thread of its own and waits at most `limit` for its answer. The limit only keeps a broken build
    /// from hanging the run; no test reads speed from it.
    fn within<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(limit).ok()
    }

    /// Waits until a running check has read its stop `reads` times: it is walking the plate, past its setup.
    fn while_walking(checks: &Checks, reads: usize) {
        let t = Instant::now();
        while checks.reads.reads() < reads {
            assert!(t.elapsed() < Duration::from_secs(120), "no check walked");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// How many more times a stopped check of `objects` objects may read its stop: once more in each walk and once per
    /// pass for each object, and once at the end of each pass.
    fn slack(objects: usize) -> usize {
        4 * objects + 8
    }

    /// How long a test waits before it calls a run hung. It is no speed bound: the tests check how many times a stopped
    /// check reads its stop, not how long anything takes.
    const HANG: Duration = Duration::from_secs(600);

    #[test]
    fn an_arrange_stops_a_stale_plate_check_instead_of_waiting_behind_it() {
        let state = Arc::new(Slicer::default());
        let request = stacked(&state, 8, 200.0);
        let t = Instant::now();
        arrange_now(&state, &request).expect("the copies arrange");
        let alone = t.elapsed();
        // The check of the plate as it opened is walking when Arrange starts.
        let stale = {
            let (state, request) = (state.clone(), request.clone());
            std::thread::spawn(move || check(&state, &request))
        };
        let _stop = StopChecks(state.clone());
        while_walking(&state.checks, 1000);
        let t = Instant::now();
        let arranged = {
            let (state, request) = (state.clone(), request.clone());
            within(HANG, move || arrange_now(&state, &request))
        };
        eprintln!("arrange alone {alone:?}, beside a stale check {:?}", t.elapsed());
        assert!(arranged.is_some_and(|a| a.is_ok()), "Arrange answers");
        let answer = within(HANG, move || stale.join().expect("the check thread"));
        assert_eq!(
            answer,
            Some(Err(CHECK_CANCELED.to_string())),
            "the stale check stops with no answer"
        );
        // It let go of the pool at once: a few more reads of its stop, not the rest of its walk.
        let after = state
            .checks
            .reads
            .after_stop()
            .expect("the stale check read its stop");
        assert!(
            after <= slack(8),
            "the stale check read its stop {after} more times"
        );
    }

    #[test]
    fn a_newer_plate_check_stops_the_one_running() {
        let state = Arc::new(Slicer::default());
        let stale = stacked(&state, 50, 40.0);
        let pair = by_object_pair(&state, 3.0);
        let alone = check(&state, &pair).expect("the pair checks");
        let older = {
            let (state, stale) = (state.clone(), stale.clone());
            std::thread::spawn(move || check(&state, &stale))
        };
        let _stop = StopChecks(state.clone());
        while_walking(&state.checks, state.checks.reads.reads() + 1000);
        let t = Instant::now();
        let newer = {
            let state = state.clone();
            within(HANG, move || check(&state, &pair))
        };
        eprintln!("the newer check answered in {:?}", t.elapsed());
        let newer = newer.expect("the newer check answers").expect("the pair checks");
        // Its answer is the one it gives alone (the timing aside).
        assert_eq!(newer["collisions"], alone["collisions"]);
        assert_eq!(newer["certainty"], alone["certainty"]);
        let older = within(HANG, move || older.join().expect("the check thread"));
        assert_eq!(older, Some(Err(CHECK_SKIPPED.to_string())));
        // The older check let go at once; the newer one's own reads come after, so they are counted out.
        let after = state
            .checks
            .reads
            .after_stop()
            .expect("the older check read its stop");
        let newer_reads = check_reads(&state, &by_object_pair(&state, 3.0));
        assert!(
            after <= slack(50) + newer_reads,
            "the older check read its stop {after} more times ({newer_reads} are the newer check's)"
        );
    }

    /// How many times a check of `request` reads its stop, run alone.
    fn check_reads(state: &Slicer, request: &serde_json::Value) -> usize {
        let before = state.checks.reads.reads();
        check(state, request).expect("the check answers");
        state.checks.reads.reads() - before
    }

    /// Arranges `request` as the arrange command does, with its first layout let go.
    fn arrange_now(state: &Slicer, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        let req: SliceRequest =
            serde_json::from_str(&request.to_string()).map_err(|e| format!("request: {e}"))?;
        let meshes = begin_arrange(state);
        run_arrange(req, &meshes, &mut |_| {})
    }

    fn arrange(state: &Slicer, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        let req: SliceRequest =
            serde_json::from_str(&request.to_string()).map_err(|e| format!("request: {e}"))?;
        let meshes = lock(&state.meshes).clone();
        let mut first = Vec::new();
        let layout = run_arrange(req, &meshes, &mut |v| first.push(v.clone()))?;
        // The page gets the first layout once, before the plate check, to show at once.
        assert_eq!(first.len(), 1, "one first layout");
        assert!(
            first[0].get("check").is_none(),
            "the first layout comes before the check"
        );
        assert!(
            first[0]["objects"].as_array().is_some_and(|o| !o.is_empty()),
            "{}",
            first[0]
        );
        Ok(layout)
    }

    #[test]
    fn an_arrange_spaces_a_by_object_pair_by_the_clearance_and_keeps_no_session() {
        let state = Slicer::default();
        let request = by_object_pair(&state, 3.0);
        let layout = arrange(&state, &request).expect("the pair arranges");
        assert_eq!(layout["byObject"], true, "{layout}");
        assert_eq!(layout["clearanceMm"], 68.0, "{layout}");
        let objects = layout["objects"].as_array().expect("objects");
        assert_eq!(objects.len(), 2, "{layout}");
        assert!(layout["notFit"].as_array().is_some_and(Vec::is_empty), "{layout}");
        let center = |o: &serde_json::Value| {
            [
                o["centerMm"][0].as_f64().unwrap_or(0.0),
                o["centerMm"][1].as_f64().unwrap_or(0.0),
            ]
        };
        let (a, b) = (center(&objects[0]), center(&objects[1]));
        assert!(
            (a[0] - b[0]).hypot(a[1] - b[1]) >= 68.0 + 20.0,
            "the cubes keep the clearance apart: {layout}"
        );
        // The same plate gives the same layout (the check's own timing aside), and the request keeps the meshes it
        // named.
        let again = arrange(&state, &request).expect("again");
        assert_eq!(again["objects"], layout["objects"]);
        assert_eq!(again["check"]["collisions"], layout["check"]["collisions"]);
        // A kept object stays where it is; an unknown mesh is an error, not an empty plate.
        let mut keep = request.clone();
        keep["plate"]["arrange"] = serde_json::json!({ "keep": ["a"] });
        let kept = arrange(&state, &keep).expect("arranges round a");
        let moved = kept["objects"].as_array().expect("objects");
        assert_eq!(moved.len(), 1, "{kept}");
        assert_eq!(moved[0]["id"], "b", "{kept}");
        let mut lost = request.clone();
        lost["plate"]["objects"][0]["mesh"] = serde_json::json!(999);
        assert!(arrange(&state, &lost).is_err());
        assert_eq!(kept_count(&state), 0);
    }

    #[test]
    fn a_kept_session_slices_again_to_the_same_bytes_and_stays_small() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let object = serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) });
        let with = |config: serde_json::Value, now: i64| {
            serde_json::json!({ "plate": { "bed": { "widthMm": 256, "depthMm": 256, "heightMm": 256 }, "objects": [object.clone()] },
                "config": config, "options": { "nowUnix": now, "nowOffsetMinutes": 0 } })
        };
        let base = serde_json::json!({});
        let same = |a: &(serde_json::Value, Output), b: &(serde_json::Value, Output)| {
            let strip = |v: &serde_json::Value| {
                let mut v = v.clone();
                if let Some(m) = v.as_object_mut() {
                    m.remove("wallMs");
                    m.remove("stageMicros");
                }
                v
            };
            a.1.gcode == b.1.gcode && a.1.sxpv == b.1.sxpv && strip(&a.0) == strip(&b.0)
        };
        // A canceled slice keeps no session.
        assert!(run_kept(&state, &with(base.clone(), 1), true).is_err());
        assert_eq!(kept_count(&state), 0);
        let first = run_kept(&state, &with(base.clone(), 1), false).expect("it slices");
        assert_eq!(kept_count(&state), 1);
        // Again a second later: the kept session, the bytes of a fresh one.
        let again = run_kept(&state, &with(base.clone(), 2), false).expect("it slices");
        assert_eq!(kept_count(&state), 1);
        assert!(same(
            &again,
            &run(&state, with(base.clone(), 2)).expect("it slices")
        ));
        assert!(same(&again, &first) || first.1.gcode != again.1.gcode);
        // A fan setting is G-code only: the same session.
        let fan = serde_json::json!({ "close_fan_the_first_x_layers": [3] });
        assert!(sx_core::api::SESSION_FREE_KEYS.contains(&"close_fan_the_first_x_layers"));
        let fanned = run_kept(&state, &with(fan.clone(), 3), false).expect("it slices");
        assert_eq!(kept_count(&state), 1);
        assert!(same(&fanned, &run(&state, with(fan, 3)).expect("it slices")));
        // Another layer height is another session; a third pushes out the oldest.
        run_kept(
            &state,
            &with(serde_json::json!({ "layer_height": 0.12 }), 4),
            false,
        )
        .expect("it slices");
        assert_eq!(kept_count(&state), 2);
        // Back to the first settings: their session, lightened while the other was prepared, gives a fresh one's bytes.
        let back = run_kept(&state, &with(base.clone(), 6), false).expect("it slices");
        assert_eq!(kept_count(&state), 2);
        assert!(same(
            &back,
            &run(&state, with(base.clone(), 6)).expect("it slices")
        ));
        run_kept(
            &state,
            &with(serde_json::json!({ "layer_height": 0.28 }), 5),
            false,
        )
        .expect("it slices");
        assert_eq!(kept_count(&state), KEPT_SESSIONS);
        // Releasing a mesh lets go of the sessions.
        state.release(cube);
        assert_eq!(kept_count(&state), 0);
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
    fn a_slice_reports_its_progress_a_few_times_a_second_and_ends_each_stage() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 30.0));
        let request = plate(
            serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) }),
        );
        let req: SliceRequest = serde_json::from_str(&request.to_string()).expect("the request reads");
        let meshes = lock(&state.meshes).clone();
        let got = Mutex::new(Vec::<(String, f32)>::new());
        let progress = SendProgress::new(|s: SliceStep| lock(&got).push((s.stage.to_owned(), s.fraction)));
        run_slice(&req, &meshes, &AtomicBool::new(false), &progress).expect("it slices");
        let got = got.into_inner().unwrap_or_default();
        // Every pass the engine reports reaches its end, and within a stage the fraction only grows.
        for stage in ["contours", "paths", "gcode"] {
            let of: Vec<f32> = got.iter().filter(|(s, _)| s == stage).map(|(_, f)| *f).collect();
            assert!(
                of.last().is_some_and(|f| (*f - 1.0).abs() < 1e-6),
                "{stage}: {of:?}"
            );
            assert!(of.windows(2).all(|w| w[0] <= w[1]), "{stage}: {of:?}");
        }
        // A 150-layer cube slices in well under a second here: the throttle keeps it to a few dozen reports.
        assert!(got.len() < 60, "{} reports", got.len());
    }

    #[test]
    fn progress_in_between_waits_for_the_throttle() {
        let sent = Mutex::new(Vec::<f32>::new());
        let p = SendProgress::new(|s: SliceStep| lock(&sent).push(s.fraction));
        for k in 0..100u8 {
            p.report(Stage::Paths, f32::from(k) / 100.0);
        }
        p.report(Stage::Paths, 1.0);
        // The first report, then the end; the 98 between came within the throttle.
        assert_eq!(sent.into_inner().unwrap_or_default(), vec![0.0, 1.0]);
    }

    #[test]
    fn a_canceled_slice_stops_with_an_error_and_keeps_nothing() {
        let state = Slicer::default();
        let cube = add(&state, "cube.stl", &cube_stl(20.0, 20.0, 10.0));
        let request = plate(
            serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) }),
        );
        let req: SliceRequest = serde_json::from_str(&request.to_string()).expect("the request reads");
        let meshes = lock(&state.meshes).clone();
        let err = run_slice(&req, &meshes, &AtomicBool::new(true), &NoProgress)
            .err()
            .expect("a canceled slice fails");
        assert!(err.to_lowercase().contains("cancel"), "{err}");
        assert!(lock(&state.results).is_empty());
        assert!(run_slice(&req, &meshes, &AtomicBool::new(false), &NoProgress).is_ok());
    }

    #[test]
    fn mesh_info_describes_the_model_without_an_id() {
        let (mesh, info) = mesh_info(&cube_stl(20.0, 30.0, 10.0), "cube.stl").expect("the cube loads");
        assert_eq!(info["triangles"].as_u64(), Some(12));
        assert_eq!(mesh.triangle_count(), 12);
        let bbox: Vec<f64> = info["bboxMm"]
            .as_array()
            .expect("a box")
            .iter()
            .filter_map(serde_json::Value::as_f64)
            .collect();
        assert_eq!(bbox, vec![20.0, 30.0, 10.0]);
        assert_eq!(info["hash"].as_str().map(str::len), Some(16));
        // load_mesh adds the id once the mesh is stored.
        assert!(info.get("id").is_none());
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

    /// A model loaded the way `load_mesh` keeps it, for the page load `page`.
    fn load_for(state: &Slicer, page: u32, name: &str) -> (u32, std::sync::Weak<Mesh>) {
        let id = state.id();
        let mesh = Mesh::load(&cube_stl(20.0, 20.0, 10.0), name).expect("the test mesh loads");
        assert!(state.keep_mesh(page, id, mesh));
        let weak = Arc::downgrade(lock(&state.meshes).get(&id).expect("kept"));
        (id, weak)
    }

    #[test]
    fn a_page_reload_lets_go_of_the_meshes_and_slices_the_page_before_it_held() {
        let state = Slicer::default();
        let page = state.page.load(Ordering::SeqCst);
        let (cube, mesh) = load_for(&state, page, "cube.stl");
        // A slice of it, kept as the slice command keeps one, with its session.
        let request = plate(
            serde_json::json!({ "id": "a", "name": "cube", "mesh": cube, "transform": at(100.0, 100.0, 0.0) }),
        );
        let (_, output) = run_kept(&state, &request, false).expect("it slices");
        let slice = state.id();
        assert!(state.keep_result(page, slice, output));
        assert_eq!(kept_count(&state), 1);
        assert!(state.gcode_bytes(slice, 0, 2).is_ok());
        // The page reloads and starts again: it no longer knows either id, so the shell lets go of both, and of the
        // session made from the mesh. Nothing else holds the mesh: it is freed.
        state.page_start();
        assert!(lock(&state.meshes).is_empty());
        assert!(lock(&state.results).is_empty());
        assert!(lock(&state.kept.hashes).is_empty());
        assert_eq!(kept_count(&state), 0);
        assert!(mesh.upgrade().is_none(), "the mesh is still held somewhere");
        assert!(state.gcode_bytes(slice, 0, 2).is_err());
        // The new page's ids never repeat the old ones.
        assert!(state.id() > slice);
    }

    #[test]
    fn a_load_or_slice_the_page_before_a_reload_asked_for_is_not_kept() {
        let state = Slicer::default();
        let before = state.page.load(Ordering::SeqCst);
        state.page_start();
        // Both end after the reload: neither is kept, so nothing is left that no page can name.
        let mesh = Mesh::load(&cube_stl(20.0, 20.0, 10.0), "late.stl").expect("the test mesh loads");
        assert!(!state.keep_mesh(before, state.id(), mesh));
        let late = Output {
            gcode: b"G1".to_vec(),
            sxpv: vec![1, 2, 3],
        };
        assert!(!state.keep_result(before, state.id(), late));
        assert!(lock(&state.meshes).is_empty());
        assert!(lock(&state.results).is_empty());
        // The new page's own are kept.
        let now = state.page.load(Ordering::SeqCst);
        let (id, _) = load_for(&state, now, "cube.stl");
        assert!(lock(&state.meshes).contains_key(&id));
    }

    #[test]
    fn a_reload_stops_the_slices_the_page_before_it_started() {
        let state = Slicer::default();
        let running = Arc::new(AtomicBool::new(false));
        lock(&state.jobs).insert(1, running.clone());
        state.page_start();
        assert!(running.load(Ordering::Relaxed));
        assert!(lock(&state.jobs).is_empty());
    }

    #[test]
    fn the_preview_moves_to_the_page_once() {
        let state = Slicer::default();
        let preview = vec![1_u8, 2, 3];
        lock(&state.results).insert(
            7,
            Output {
                gcode: b"G1".to_vec(),
                sxpv: preview.clone(),
            },
        );
        assert_eq!(take_preview(&state, 7), Ok(preview));
        // The slice keeps no copy: a second ask is an error, and the G-code stays.
        assert!(take_preview(&state, 7).is_err());
        assert!(take_preview(&state, 8).is_err());
        assert_eq!(
            lock(&state.results).get(&7).map(|o| o.gcode.clone()),
            Some(b"G1".to_vec())
        );
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
            ..Mesh::default()
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
