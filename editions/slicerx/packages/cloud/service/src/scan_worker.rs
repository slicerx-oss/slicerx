// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The upload scan worker for the free library.
//!
//! A creator makes a listing and a version, uploads the file to the
//! `quarantine` bucket and calls `submit_version`. This worker claims queued
//! versions (`claim_scan`), reads the file from quarantine and runs it through
//! `sx-upload-scan`. A clean file is converted to an sx3mf and written to the
//! `listing-files` bucket together with a preview, and `finish_scan` records
//! the report and the verified file manifest. A refused file is recorded as
//! rejected and deleted from quarantine. Approval is a moderator decision in
//! the database (`approve_listing`); this worker never approves anything.
//!
//! When the malware scanner cannot answer, the version stays claimed and is
//! not approved. `requeue_stale_scans` returns it to the queue later.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sx_upload_scan::{ListingMeta, Scanner, Upload, Verdict, sha256_hex};
use tokio::sync::watch;

use crate::backend::{Backend, Bucket, ScanFinish, ScanJob};
use crate::error::Result;

/// The longest file name `listing_versions.storage_path` allows.
const MAX_NAME: usize = 200;

#[derive(Debug, Clone)]
pub struct ScanWorkerConfig {
    /// Stored on claimed versions; unique per worker.
    pub id: String,
    /// Wait between claims when the queue is empty.
    pub idle_poll: Duration,
    /// Wait after the malware scanner could not answer.
    pub unavailable_backoff: Duration,
    /// How often stale claims go back in the queue.
    pub requeue_every: Duration,
}

impl ScanWorkerConfig {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            idle_poll: Duration::from_secs(3),
            unavailable_backoff: Duration::from_secs(30),
            requeue_every: Duration::from_secs(60),
        }
    }
}

/// What happened to one claimed version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Processed {
    /// Passed and stored.
    Clean,
    /// Refused and recorded.
    Rejected,
    /// The malware scanner could not answer; the version stays claimed.
    Unavailable,
}

/// Claims and scans versions until `stop` turns true.
pub async fn run(
    backend: Arc<dyn Backend>,
    scanner: Scanner,
    cfg: ScanWorkerConfig,
    mut stop: watch::Receiver<bool>,
) {
    let mut last_requeue = tokio::time::Instant::now();
    while !*stop.borrow() {
        if last_requeue.elapsed() >= cfg.requeue_every {
            last_requeue = tokio::time::Instant::now();
            match backend.requeue_stale_scans().await {
                Ok(0) => {}
                Ok(n) => eprintln!("sx-cloud scan {}: requeued {n} stale scans", cfg.id),
                Err(e) => eprintln!("sx-cloud scan {}: requeue failed: {e}", cfg.id),
            }
        }
        let wait = match backend.claim_scan(&cfg.id).await {
            Ok(Some(job)) => match process(backend.as_ref(), &scanner, &job).await {
                Ok(Processed::Unavailable) => cfg.unavailable_backoff,
                Ok(_) => continue,
                Err(e) => {
                    eprintln!("sx-cloud scan {}: {e}", cfg.id);
                    cfg.unavailable_backoff
                }
            },
            Ok(None) => cfg.idle_poll,
            Err(e) => {
                eprintln!("sx-cloud scan {}: claim failed: {e}", cfg.id);
                cfg.idle_poll
            }
        };
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = stop.changed() => {}
        }
    }
}

/// The last path segment.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `<listing>/<version>/<name without extension>.sx3mf`, within the length
/// the database allows.
fn library_path(storage_path: &str) -> String {
    let dir = storage_path.rsplit_once('/').map_or("", |(d, _)| d);
    let name = file_name(storage_path);
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    let stem: String = stem.chars().take(MAX_NAME - ".sx3mf".len()).collect();
    format!("{dir}/{stem}.sx3mf")
}

fn preview_path(storage_path: &str) -> String {
    let dir = storage_path.rsplit_once('/').map_or("", |(d, _)| d);
    format!("{dir}/preview.png")
}

fn refusal(report: Value, reason: &str) -> ScanFinish {
    let mut report = report;
    report["reason"] = Value::String(reason.to_owned());
    ScanFinish {
        ok: false,
        report,
        sha256: None,
        size_bytes: None,
        parts: Vec::new(),
        storage_path: None,
        format: None,
    }
}

/// Scans one claimed version. Errors are backend failures; a file that fails
/// its checks is recorded as rejected and returns `Ok`.
pub async fn process(backend: &dyn Backend, scanner: &Scanner, job: &ScanJob) -> Result<Processed> {
    let Some(bytes) = backend.get_object(Bucket::Quarantine, &job.storage_path).await? else {
        let report = json!({ "verdict": "rejected", "reasonCodes": ["missing_file"] });
        let done = backend
            .finish_scan(
                &job.version_id,
                refusal(report, "the uploaded file is missing from quarantine"),
            )
            .await?;
        let _ = done;
        return Ok(Processed::Rejected);
    };
    let outcome = scanner
        .scan(Upload {
            file_name: file_name(&job.storage_path).to_owned(),
            bytes,
            listing: ListingMeta {
                listing_id: job.listing_id.clone(),
                listing_slug: job.slug.clone(),
                version_id: job.version_id.clone(),
                creator_id: job.creator_id.clone(),
                version_number: job.version.clone(),
                creator_slug: job.creator_handle.clone(),
                creator_name: job.creator_name.clone(),
                title: job.title.clone(),
            },
        })
        .await;
    let report =
        serde_json::to_value(&outcome.report).map_err(|e| crate::error::Error::Backend(e.to_string()))?;
    match (outcome.report.verdict, outcome.library_file, outcome.preview_png) {
        (Verdict::ScanUnavailable, ..) => {
            eprintln!(
                "sx-cloud scan: the malware scanner did not answer for version {}",
                job.version_id
            );
            Ok(Processed::Unavailable)
        }
        (Verdict::Clean, Some(file), Some(png)) => {
            let library = library_path(&job.storage_path);
            let preview = preview_path(&job.storage_path);
            let sha = sha256_hex(&file);
            let parts = vec![
                json!({ "name": file_name(&library), "role": "model", "format": "sx3mf",
                        "size_bytes": file.len(), "sha256": sha }),
                json!({ "name": "preview.png", "role": "image", "format": null,
                        "size_bytes": png.len(), "sha256": sha256_hex(&png) }),
            ];
            let size = i64::try_from(file.len()).unwrap_or(i64::MAX);
            backend
                .put_object(Bucket::Library, &library, file, "application/octet-stream")
                .await?;
            backend
                .put_object(Bucket::Library, &preview, png, "image/png")
                .await?;
            let recorded = backend
                .finish_scan(
                    &job.version_id,
                    ScanFinish {
                        ok: true,
                        report,
                        sha256: Some(sha),
                        size_bytes: Some(size),
                        parts,
                        storage_path: Some(library),
                        format: Some("sx3mf".to_owned()),
                    },
                )
                .await?;
            if recorded {
                // The raw upload has done its job; hostile bytes do not stay.
                let _ = backend.delete_object(Bucket::Quarantine, &job.storage_path).await;
            }
            Ok(Processed::Clean)
        }
        _ => {
            let reason = outcome
                .report
                .reasons
                .first()
                .cloned()
                .unwrap_or_else(|| "the file failed the upload checks".to_owned());
            let recorded = backend
                .finish_scan(&job.version_id, refusal(report, &reason))
                .await?;
            if recorded {
                let _ = backend.delete_object(Bucket::Quarantine, &job.storage_path).await;
            }
            Ok(Processed::Rejected)
        }
    }
}
