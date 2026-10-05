// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The slicing worker: claims queued jobs, fetches and checks their meshes,
//! slices with `sx-core` and stores the G-code and preview.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};
use sx_core::api::{self, SliceRequest, SliceRun};
use sx_core::{Mesh, Progress, Stage};
use tokio::sync::watch;

use crate::backend::{Backend, Bucket, Job, Outcome, mesh_path, result_paths};
use crate::error::{Error, Result};

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
        .report_progress(&job.id, &cfg.id, 0.02, "fetching")
        .await?
    {
        return Ok(());
    }
    let meshes = match fetch_meshes(backend, &job, &req).await? {
        Ok(m) => m,
        Err(e) => {
            backend.finish_job(&job.id, &cfg.id, failed(e)).await?;
            return Ok(());
        }
    };
    if !backend.report_progress(&job.id, &cfg.id, 0.1, "slicing").await? {
        return Ok(());
    }
    let run = match slice(backend, cfg, &job.id, req, meshes).await? {
        None => return Ok(()),
        Some(Err(e)) => {
            backend.finish_job(&job.id, &cfg.id, failed(e)).await?;
            return Ok(());
        }
        Some(Ok(run)) => run,
    };
    if !backend
        .report_progress(&job.id, &cfg.id, 0.9, "uploading")
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
    let result = serde_json::to_value(&run.report).map_err(|e| Error::Backend(e.to_string()))?;
    let outcome = Outcome::Succeeded {
        result,
        gcode_path,
        preview_path,
    };
    backend.finish_job(&job.id, &cfg.id, outcome).await?;
    Ok(())
}

/// Downloads each distinct mesh once, checks it against its hash and loads it.
/// The inner error is a reason to fail the job.
async fn fetch_meshes(
    backend: &dyn Backend,
    job: &Job,
    req: &SliceRequest,
) -> Result<Result<HashMap<String, Arc<Mesh>>, String>> {
    let mut meshes = HashMap::new();
    for object in &req.plate.objects {
        let sha = object.mesh_ref();
        if meshes.contains_key(&sha) {
            continue;
        }
        let path = mesh_path(&job.user_id, &sha);
        let Some(bytes) = backend.get_object(Bucket::Inputs, &path).await? else {
            return Ok(Err(format!("mesh {sha} was not uploaded")));
        };
        let loaded = tokio::task::spawn_blocking(move || {
            if sha256_hex(&bytes) != sha {
                return Err(format!("mesh {sha} does not match its hash"));
            }
            api::load_mesh(&bytes, &sha)
                .map(|m| (sha, Arc::new(m)))
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| Error::Backend(e.to_string()))?;
        match loaded {
            Ok((sha, mesh)) => {
                meshes.insert(sha, mesh);
            }
            Err(e) => return Ok(Err(e)),
        }
    }
    Ok(Ok(meshes))
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

/// Slices on a blocking thread, sending progress as it moves and at least
/// every heartbeat. Returns `None` when the job was canceled or reclaimed.
async fn slice(
    backend: &dyn Backend,
    cfg: &WorkerConfig,
    job_id: &str,
    req: SliceRequest,
    meshes: HashMap<String, Arc<Mesh>>,
) -> Result<Option<Result<SliceRun, String>>> {
    let progress = Arc::new(PlateProgress::new(
        req.options.shards.unwrap_or(1),
        req.options.emit_preview.unwrap_or(true),
    ));
    let reporter = progress.clone();
    let slicing = tokio::task::spawn_blocking(move || {
        let resolve = |id: &str| {
            meshes.get(id).cloned().ok_or_else(|| sx_core::Error::Mesh {
                name: id.to_owned(),
                reason: "not in the request".to_owned(),
            })
        };
        api::run_request_with(&req, &resolve, reporter.as_ref())
    });
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
                if backend.report_progress(job_id, &cfg.id, 0.1 + 0.8 * now, "slicing").await? {
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
        Ok(Err(e)) => Err(e.to_string()),
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
