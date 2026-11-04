// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The slicing worker: claims queued jobs, fetches and checks their meshes,
//! slices with `sx-core` and stores the G-code and preview. A 3MF project is
//! split into one object per build item, and a job that names its plates
//! (`options.plates`) slices each of them on its own.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sx_core::api::{self, ProjectFiles, ProjectPlate, SliceRequest, SliceRun, VolumeSpec};
use sx_core::{Mesh, Progress, Stage};
use tokio::sync::watch;

use crate::backend::{
    Backend, Bucket, Job, MAX_PLATE_NUMBER, Outcome, mesh_path, plate_result_paths, result_paths,
};
use crate::error::{Error, Result};
use crate::gzip::{inflate, is_gzip};
use crate::http::MAX_INFLATED_MESH_BYTES;

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    /// Stored on claimed jobs; must be unique per worker.
    pub id: String,
    /// Wait between claims when the queue is empty.
    pub idle_poll: Duration,
    /// Progress is re-sent this often during a slice, as the heartbeat that
    /// keeps the job from being reclaimed (the database waits 120 s).
    pub heartbeat: Duration,
}

/// Claims and runs jobs until `stop` turns true.
pub async fn run(backend: Arc<dyn Backend>, cfg: WorkerConfig, mut stop: watch::Receiver<bool>) {
    while !*stop.borrow() {
        match backend.claim_job(&cfg.id).await {
            Ok(Some(job)) => {
                let _busy = crate::idle::busy();
                if let Err(e) = process(backend.as_ref(), &cfg, job).await {
                    eprintln!("sx-cloud worker {}: {e}", cfg.id);
                }
                continue;
            }
            Ok(None) => {}
            Err(e) => eprintln!("sx-cloud worker {}: claim failed: {e}", cfg.id),
        }
        tokio::select! {
            () = tokio::time::sleep(cfg.idle_poll) => {}
            _ = stop.changed() => {}
        }
    }
}

/// The largest file the results bucket stores (`cloud-results` in `0004_cloud.sql`): a G-code or preview past it is
/// refused with the size, instead of failing the upload.
pub const MAX_RESULT_BYTES: usize = 200 * 1024 * 1024;

/// Runs one claimed job to the end. Errors are backend failures; a job that
/// cannot be sliced is finished as failed and returns `Ok`.
pub async fn process(backend: &dyn Backend, cfg: &WorkerConfig, job: Job) -> Result<()> {
    let failed = |error: String| Outcome::Failed { error };
    let req: SliceRequest = match serde_json::from_value(job.request.clone()) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("the request is not valid: {e}");
            backend.finish_job(&job.id, &cfg.id, failed(msg)).await?;
            return Ok(());
        }
    };
    if !backend
        .report_progress(&job.id, &cfg.id, 0.02, "fetching", None)
        .await?
    {
        return Ok(());
    }
    let inputs = match fetch_inputs(backend, &job, &req).await? {
        Ok(m) => Arc::new(m),
        Err(e) => {
            backend.finish_job(&job.id, &cfg.id, failed(e)).await?;
            return Ok(());
        }
    };
    match req.options.plates.clone() {
        None => one_slice(backend, cfg, &job, req, inputs).await,
        Some(plates) => plate_slices(backend, cfg, &job, req, inputs, plates).await,
    }
}

/// A request without `options.plates`: one slice, stored at the job's own paths. A 3MF project slices its first plate,
/// one object per build item, and the result names the project's other plates (`projectPlates`).
async fn one_slice(
    backend: &dyn Backend,
    cfg: &WorkerConfig,
    job: &Job,
    req: SliceRequest,
    inputs: Arc<Inputs>,
) -> Result<()> {
    let failed = |error: String| Outcome::Failed { error };
    if !backend
        .report_progress(&job.id, &cfg.id, 0.1, "slicing", None)
        .await?
    {
        return Ok(());
    }
    let span = Span {
        start: 0.1,
        width: 0.8,
        plate: None,
    };
    let (run, notes) = match slice(backend, cfg, &job.id, req, inputs, span).await? {
        None => return Ok(()),
        Some(Err(e)) => {
            backend.finish_job(&job.id, &cfg.id, failed(e)).await?;
            return Ok(());
        }
        Some(Ok(done)) => done,
    };
    if let Some(e) = too_big(&run, None) {
        backend.finish_job(&job.id, &cfg.id, failed(e)).await?;
        return Ok(());
    }
    if !backend
        .report_progress(&job.id, &cfg.id, 0.9, "uploading", None)
        .await?
    {
        return Ok(());
    }
    let (gcode_path, preview_path) = result_paths(&job.user_id, &job.id);
    backend
        .put_object(Bucket::Results, &gcode_path, run.gcode, "text/x-gcode")
        .await?;
    backend
        .put_object(
            Bucket::Results,
            &preview_path,
            run.preview,
            "application/octet-stream",
        )
        .await?;
    let mut result = serde_json::to_value(&run.report).map_err(|e| Error::Backend(e.to_string()))?;
    if !notes.is_empty()
        && let Some(o) = result.as_object_mut()
    {
        let notes = serde_json::to_value(&notes).map_err(|e| Error::Backend(e.to_string()))?;
        o.insert("projectPlates".to_owned(), notes);
    }
    let outcome = Outcome::Succeeded {
        result,
        gcode_path,
        preview_path,
    };
    backend.finish_job(&job.id, &cfg.id, outcome).await?;
    Ok(())
}

/// A request with `options.plates`: each plate named is a slice of its own, in the order named, stored at the plate's
/// own paths (`plate-<n>.gcode`). Only those plates are sliced. A plate that cannot be sliced fails alone, with the
/// engine's words; the job succeeds when one plate did, and its result is the first such plate's report with every
/// plate's under `plates`. A job canceled between or during plates keeps none of them.
async fn plate_slices(
    backend: &dyn Backend,
    cfg: &WorkerConfig,
    job: &Job,
    req: SliceRequest,
    inputs: Arc<Inputs>,
    plates: Vec<u32>,
) -> Result<()> {
    if inputs.projects.is_empty() {
        let error =
            "options.plates names plates of a 3MF project, and this request has no project".to_owned();
        backend
            .finish_job(&job.id, &cfg.id, Outcome::Failed { error })
            .await?;
        return Ok(());
    }
    #[allow(clippy::cast_precision_loss, reason = "at most MAX_PLATES plates")]
    let width = 0.88 / plates.len() as f32;
    let mut entries: Vec<Value> = Vec::with_capacity(plates.len());
    let mut first: Option<(Value, String, String)> = None;
    let mut first_error: Option<String> = None;
    for (k, &plate) in plates.iter().enumerate() {
        #[allow(clippy::cast_precision_loss, reason = "at most MAX_PLATES plates")]
        let start = 0.1 + width * k as f32;
        // The service refuses a plate past the cap. One queued before it did fails alone, as a plate the project
        // lacks, and is never written to plate_index, which cannot hold a plate past 2147483647.
        if plate > MAX_PLATE_NUMBER {
            let error =
                format!("the project has no plate {plate}; plate numbers go up to {MAX_PLATE_NUMBER}");
            first_error.get_or_insert_with(|| format!("plate {plate}: {error}"));
            entries.push(json!({ "plate": plate, "status": "failed", "error": error }));
            continue;
        }
        if !backend
            .report_progress(&job.id, &cfg.id, start, "slicing", Some(plate))
            .await?
        {
            return Ok(());
        }
        let span = Span {
            start,
            width: width * 0.9,
            plate: Some(plate),
        };
        let sliced = match slice(backend, cfg, &job.id, req.clone(), inputs.clone(), span).await? {
            None => return Ok(()),
            Some(r) => r.and_then(|(run, _)| too_big(&run, Some(plate)).map_or(Ok(run), Err)),
        };
        let run = match sliced {
            Ok(run) => run,
            Err(error) => {
                first_error.get_or_insert_with(|| format!("plate {plate}: {error}"));
                entries.push(json!({ "plate": plate, "status": "failed", "error": error }));
                continue;
            }
        };
        if !backend
            .report_progress(&job.id, &cfg.id, start + width * 0.9, "uploading", Some(plate))
            .await?
        {
            return Ok(());
        }
        let (gcode_path, preview_path) = plate_result_paths(&job.user_id, &job.id, plate);
        backend
            .put_object(Bucket::Results, &gcode_path, run.gcode, "text/x-gcode")
            .await?;
        backend
            .put_object(
                Bucket::Results,
                &preview_path,
                run.preview,
                "application/octet-stream",
            )
            .await?;
        let report = serde_json::to_value(&run.report).map_err(|e| Error::Backend(e.to_string()))?;
        let mut entry = report.clone();
        if let Some(o) = entry.as_object_mut() {
            o.insert("plate".to_owned(), json!(plate));
            o.insert("status".to_owned(), json!("succeeded"));
        }
        entries.push(entry);
        if first.is_none() {
            first = Some((report, gcode_path, preview_path));
        }
    }
    let outcome = match first {
        None => Outcome::Failed {
            error: first_error.unwrap_or_else(|| "no plate was sliced".to_owned()),
        },
        Some((mut result, gcode_path, preview_path)) => {
            if let Some(o) = result.as_object_mut() {
                o.insert("plates".to_owned(), Value::Array(entries));
            }
            Outcome::Succeeded {
                result,
                gcode_path,
                preview_path,
            }
        }
    };
    backend.finish_job(&job.id, &cfg.id, outcome).await?;
    Ok(())
}

/// Why a slice's files cannot be stored: a G-code or preview over [`MAX_RESULT_BYTES`].
fn too_big(run: &SliceRun, plate: Option<u32>) -> Option<String> {
    let what = plate.map_or_else(|| "the".to_owned(), |n| format!("plate {n}'s"));
    let limit = MAX_RESULT_BYTES / (1024 * 1024);
    #[allow(clippy::cast_precision_loss, reason = "a size in MB for a message")]
    let mb = |n: usize| n as f64 / (1024.0 * 1024.0);
    if run.gcode.len() > MAX_RESULT_BYTES {
        return Some(format!(
            "{what} G-code is {:.1} MB, over the cloud result limit of {limit} MB",
            mb(run.gcode.len())
        ));
    }
    (run.preview.len() > MAX_RESULT_BYTES).then(|| {
        format!(
            "{what} preview is {:.1} MB, over the cloud result limit of {limit} MB",
            mb(run.preview.len())
        )
    })
}

/// A volume's mesh reference as a string, as `ObjectSpec::mesh_ref` reads an object's.
pub fn volume_mesh_ref(v: &VolumeSpec) -> String {
    match &v.mesh {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A job's uploads, checked against their hashes: 3MF projects as their bytes, split into plates and items by each
/// slice ([`api::split_projects`]), and every other mesh loaded.
struct Inputs {
    projects: HashMap<String, Arc<Vec<u8>>>,
    meshes: HashMap<String, Arc<Mesh>>,
}

/// The projects of a job's uploads as [`api::split_projects`] reads them, with the plate one slice takes (`None`: each
/// project's first).
struct CloudFiles<'a> {
    inputs: &'a Inputs,
    plate: Option<u32>,
}

impl ProjectFiles for CloudFiles<'_> {
    fn project(&self, key: &str) -> Option<(String, Option<u32>)> {
        self.inputs
            .projects
            .contains_key(key)
            .then(|| (key.to_owned(), self.plate))
    }

    fn bytes(&self, file: &str) -> sx_core::Result<Arc<Vec<u8>>> {
        self.inputs
            .projects
            .get(file)
            .cloned()
            .ok_or_else(|| sx_core::Error::Mesh {
                name: file.to_owned(),
                reason: "not in the request".to_owned(),
            })
    }

    fn plates_note(&self, _file: &str, plates: usize, sliced: u32) -> String {
        format!("This project has {plates} plates; slicing plate {sliced} (options.plates picks others)")
    }
}

impl Inputs {
    /// Mesh `id` for the engine: an item split from a project, an uploaded mesh, or a project loaded whole (an object
    /// with a transform, volumes or brim ears), at the slice's plate.
    fn mesh(
        &self,
        split: &HashMap<String, Arc<Mesh>>,
        id: &str,
        plate: Option<u32>,
    ) -> sx_core::Result<Arc<Mesh>> {
        if let Some(m) = split.get(id).or_else(|| self.meshes.get(id)) {
            return Ok(m.clone());
        }
        let Some(bytes) = self.projects.get(id) else {
            return Err(sx_core::Error::Mesh {
                name: id.to_owned(),
                reason: "not in the request".to_owned(),
            });
        };
        let mesh = match plate {
            None => api::load_mesh(bytes, id)?,
            Some(n) => api::load_3mf_plates(bytes, id)?
                .into_iter()
                .find(|(p, _)| *p == n)
                .map(|(_, m)| m)
                .ok_or_else(|| sx_core::Error::Mesh {
                    name: NO_PLATE.to_owned(),
                    reason: format!("the project has no plate {n}"),
                })?,
        };
        Ok(Arc::new(mesh))
    }
}

/// The name [`Inputs::mesh`] gives a project that lacks the plate asked for, so the reason reads on its own.
const NO_PLATE: &str = "(no such plate)";

/// One slice of a request: its projects split for `plate` (each project's first when `None`), then sliced. Returns
/// the run, with each tool change a project keeps that does not apply among its warnings, and the notes on projects
/// with more plates than the one sliced; or why it did not slice.
fn slice_once(
    mut req: SliceRequest,
    inputs: &Inputs,
    plate: Option<u32>,
    progress: &dyn Progress,
) -> Result<(SliceRun, Vec<ProjectPlate>), String> {
    let words = |e: sx_core::Error| match e {
        sx_core::Error::Mesh { name, reason } if name == NO_PLATE => reason,
        e => e.to_string(),
    };
    req.options.plates = None;
    let split = api::split_projects(&mut req, &CloudFiles { inputs, plate }).map_err(words)?;
    let resolve = |id: &str| inputs.mesh(&split.meshes, id, plate);
    let mut run = api::run_request_with(&req, &resolve, progress).map_err(words)?;
    for w in split.skipped {
        if !run.report.warnings.contains(&w) {
            run.report.warnings.push(w);
        }
    }
    Ok((run, split.plates))
}

/// Downloads each distinct mesh once (objects and their volumes) and checks it against its hash. A 3MF project is kept
/// as its bytes; every other mesh is loaded. The inner error is a reason to fail the job.
async fn fetch_inputs(
    backend: &dyn Backend,
    job: &Job,
    req: &SliceRequest,
) -> Result<Result<Inputs, String>> {
    let mut inputs = Inputs {
        projects: HashMap::new(),
        meshes: HashMap::new(),
    };
    // Each object's mesh and its volumes' meshes.
    let refs: Vec<String> = req
        .plate
        .objects
        .iter()
        .flat_map(|object| {
            std::iter::once(object.mesh_ref()).chain(object.volumes.iter().map(volume_mesh_ref))
        })
        .collect();
    for sha in refs {
        if inputs.meshes.contains_key(&sha) || inputs.projects.contains_key(&sha) {
            continue;
        }
        let path = mesh_path(&job.user_id, &sha);
        let Some(bytes) = backend.get_object(Bucket::Inputs, &path).await? else {
            return Ok(Err(format!("mesh {sha} was not uploaded")));
        };
        let loaded = tokio::task::spawn_blocking(move || {
            let bytes = stored_mesh(bytes, &sha)?;
            if api::is_3mf(&bytes, &sha) {
                return Ok((sha, Upload::Project(Arc::new(bytes))));
            }
            api::load_mesh(&bytes, &sha)
                .map(|m| (sha, Upload::Mesh(Arc::new(m))))
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| Error::Backend(e.to_string()))?;
        match loaded {
            Ok((sha, Upload::Project(bytes))) => {
                inputs.projects.insert(sha, bytes);
            }
            Ok((sha, Upload::Mesh(mesh))) => {
                inputs.meshes.insert(sha, mesh);
            }
            Err(e) => return Ok(Err(e)),
        }
    }
    Ok(Ok(inputs))
}

/// One upload as [`fetch_inputs`] keeps it.
enum Upload {
    Project(Arc<Vec<u8>>),
    Mesh(Arc<Mesh>),
}

/// A stored mesh as the engine reads it: the bytes themselves when they match the hash, else a gzip upload inflated
/// (with the same output limit as the upload) and checked against the hash.
fn stored_mesh(bytes: Vec<u8>, sha: &str) -> Result<Vec<u8>, String> {
    if sha256_hex(&bytes) == sha {
        return Ok(bytes);
    }
    let mismatch = || format!("mesh {sha} does not match its hash");
    if !is_gzip(&bytes) {
        return Err(mismatch());
    }
    let mesh = inflate(&bytes, MAX_INFLATED_MESH_BYTES).map_err(|_| mismatch())?;
    if sha256_hex(&mesh) == sha {
        Ok(mesh)
    } else {
        Err(mismatch())
    }
}

/// Turns the core's per-range stage reports into one fraction for the plate.
/// For each layer range the core reports contours, paths, G-code and (unless
/// switched off) the preview, each from 0 to 1; a range counts as done when
/// its last stage reaches 1. Reports can come from rayon threads.
pub struct PlateProgress {
    ranges: f32,
    last: Stage,
    state: Mutex<(f32, f32)>,
    bits: AtomicU32,
}

impl PlateProgress {
    pub fn new(ranges: u32, emit_preview: bool) -> Self {
        #[allow(clippy::cast_precision_loss, reason = "shard counts are at most 64")]
        let ranges = ranges.max(1) as f32;
        Self {
            ranges,
            last: if emit_preview {
                Stage::Preview
            } else {
                Stage::Gcode
            },
            state: Mutex::new((0.0, 0.0)),
            bits: AtomicU32::new(0),
        }
    }

    /// 0 to 1 for the whole plate; never goes down.
    pub fn fraction(&self) -> f32 {
        f32::from_bits(self.bits.load(Ordering::Relaxed))
    }
}

impl Progress for PlateProgress {
    fn report(&self, stage: Stage, fraction: f32) {
        let f = fraction.clamp(0.0, 1.0);
        let gcode_share = if self.last == Stage::Preview { 0.2 } else { 0.3 };
        let within = match stage {
            Stage::Contours => 0.5 * f,
            Stage::Paths => 0.5 + 0.2 * f,
            Stage::Gcode => 0.7 + gcode_share * f,
            Stage::Preview => 0.9 + 0.1 * f,
            _ => return,
        };
        let Ok(mut st) = self.state.lock() else {
            return;
        };
        if stage == self.last && f >= 1.0 {
            st.0 += 1.0;
            st.1 = 0.0;
        } else {
            st.1 = st.1.max(within);
        }
        let overall = ((st.0 + st.1) / self.ranges).min(1.0);
        if overall > self.fraction() {
            self.bits.store(overall.to_bits(), Ordering::Relaxed);
        }
    }
}

/// Where one slice's progress lands in the job's: from `start`, over `width`, with the plate it slices.
#[derive(Debug, Clone, Copy)]
struct Span {
    start: f32,
    width: f32,
    plate: Option<u32>,
}

/// Slices on a blocking thread, sending progress as it moves and at least
/// every heartbeat. Returns `None` when the job was canceled or reclaimed.
async fn slice(
    backend: &dyn Backend,
    cfg: &WorkerConfig,
    job_id: &str,
    req: SliceRequest,
    inputs: Arc<Inputs>,
    span: Span,
) -> Result<Option<Result<(SliceRun, Vec<ProjectPlate>), String>>> {
    let progress = Arc::new(PlateProgress::new(
        req.options.shards.unwrap_or(1),
        req.options.emit_preview.unwrap_or(true),
    ));
    let reporter = progress.clone();
    let slicing =
        tokio::task::spawn_blocking(move || slice_once(req, &inputs, span.plate, reporter.as_ref()));
    tokio::pin!(slicing);
    let mut tick = tokio::time::interval(cfg.heartbeat.min(Duration::from_secs(1)));
    tick.tick().await;
    let (mut sent, mut sent_at) = (0.0_f32, tokio::time::Instant::now());
    let mut canceled = false;
    let run = loop {
        tokio::select! {
            r = &mut slicing => break r,
            _ = tick.tick() => {
                let now = progress.fraction();
                if canceled || (now - sent < 0.02 && sent_at.elapsed() < cfg.heartbeat) {
                    continue;
                }
                // The core cannot stop mid-slice, so a canceled job finishes
                // slicing and its output is dropped.
                let at = span.start + span.width * now;
                if backend.report_progress(job_id, &cfg.id, at, "slicing", span.plate).await? {
                    (sent, sent_at) = (now, tokio::time::Instant::now());
                } else {
                    canceled = true;
                }
            }
        }
    };
    if canceled {
        return Ok(None);
    }
    Ok(Some(match run {
        Ok(Ok(run)) => Ok(run),
        Ok(Err(e)) => Err(e),
        Err(e) if e.is_panic() => Err("the slicer stopped unexpectedly".to_owned()),
        Err(e) => Err(e.to_string()),
    }))
}

/// Every `interval`, purges accounts whose deletion grace period has ended and
/// deletes their files. Run one of these per deployment.
pub async fn run_purge(
    backend: Arc<dyn Backend>,
    interval: Duration,
    retention_days: u32,
    mut stop: watch::Receiver<bool>,
) {
    while !*stop.borrow() {
        if let Err(e) = purge_once(backend.as_ref()).await {
            eprintln!("sx-cloud purge: {e}");
        }
        if retention_days > 0 {
            match backend.expire_cloud_files(retention_days).await {
                Ok(0) => {}
                Ok(n) => {
                    eprintln!("sx-cloud purge: deleted {n} cloud files older than {retention_days} days");
                }
                Err(e) => eprintln!("sx-cloud purge: expiring cloud files failed: {e}"),
            }
        }
        tokio::select! {
            () = tokio::time::sleep(interval) => {}
            _ = stop.changed() => {}
        }
    }
}

/// One purge pass; returns how many accounts it purged.
pub async fn purge_once(backend: &dyn Backend) -> Result<usize> {
    let ids = backend.purge_due_accounts().await?;
    for id in &ids {
        // The rows are gone already; a failure here leaves files to remove by
        // hand, so name the account in the log (ids only, never paths).
        if let Err(e) = backend.delete_user_files(id).await {
            eprintln!("sx-cloud purge: files of account {id} were not deleted: {e}");
        }
    }
    Ok(ids.len())
}

/// Lowercase hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plate_progress_counts_ranges_and_never_goes_back() {
        let p = PlateProgress::new(2, true);
        let mut seen = Vec::new();
        for _ in 0..2 {
            for (stage, f) in [
                (Stage::Contours, 0.0),
                (Stage::Contours, 1.0),
                (Stage::Paths, 1.0),
                (Stage::Gcode, 0.0),
                (Stage::Gcode, 1.0),
                (Stage::Preview, 0.0),
                (Stage::Preview, 1.0),
            ] {
                p.report(stage, f);
                seen.push(p.fraction());
            }
        }
        assert!(seen.windows(2).all(|w| w[0] <= w[1]));
        assert!((seen[6] - 0.5).abs() < 1e-6, "one of two ranges done");
        assert!((p.fraction() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn without_a_preview_gcode_ends_the_range() {
        let p = PlateProgress::new(1, false);
        p.report(Stage::Contours, 1.0);
        p.report(Stage::Paths, 1.0);
        p.report(Stage::Gcode, 1.0);
        assert!((p.fraction() - 1.0).abs() < 1e-6);
    }
}
