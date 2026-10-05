// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! An in-memory backend with the same rules as the `0004_cloud.sql` module:
//! the invite list and its limits, the active job limit, target printer ownership, delivery offers when a job
//! succeeds and the delivery state machine. Used by the tests and by
//! `SX_CLOUD_BACKEND=memory` for local development without a database.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

use crate::backend::{
    Backend, Bucket, CloudQuota, Delivery, DeliveryRow, DeliveryState, Device, DeviceKind, Job, JobStatus,
    LinkPrinter, MAX_ACTIVE_JOBS, NewJob, Outcome, ScanFinish, ScanJob, SyncPrinter, TokenGrant,
    delivery_from_parts,
};
use crate::error::{Error, Result};

/// A library version in the scan queue.
struct MemoryScan {
    job: ScanJob,
    /// `queued`, `scanning`, `clean` or `rejected`.
    status: &'static str,
    result: Option<ScanFinish>,
}

#[derive(Default)]
struct State {
    seq: u64,
    tokens: HashMap<String, TokenGrant>,
    /// Requests left per token, for tests of the rate limit.
    token_budget: HashMap<String, u32>,
    sessions: HashMap<String, String>,
    /// Invited accounts: jobs per day and the largest upload in bytes.
    access: HashMap<String, (u32, u64)>,
    objects: HashMap<(&'static str, String), Vec<u8>>,
    jobs: Vec<(Job, Option<String>)>,
    devices: Vec<Device>,
    printers: Vec<(String, SyncPrinter)>,
    deliveries: Vec<DeliveryRow>,
    due: Vec<String>,
    scans: Vec<MemoryScan>,
}

impl State {
    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("00000000-0000-4000-8000-{:012x}", self.seq)
    }

    /// A fixed clock: each call moves one second, so tests are deterministic.
    fn now(&mut self) -> String {
        self.seq += 1;
        let s = self.seq;
        format!(
            "2026-01-01T{:02}:{:02}:{:02}Z",
            (s / 3600) % 24,
            (s / 60) % 60,
            s % 60
        )
    }

    fn quota(&self, user_id: &str) -> Option<CloudQuota> {
        let &(jobs_per_day, max_upload_bytes) = self.access.get(user_id)?;
        let jobs_today = self.jobs.iter().filter(|(j, _)| j.user_id == user_id).count();
        Some(CloudQuota {
            jobs_per_day,
            jobs_today: u32::try_from(jobs_today).unwrap_or(u32::MAX),
            max_upload_bytes,
        })
    }

    fn delivery(&self, row: &DeliveryRow) -> Delivery {
        let job = self.jobs.iter().find(|(j, _)| j.id == row.job_id).map(|(j, _)| j);
        let local = self
            .printers
            .iter()
            .find(|(_, p)| p.id == row.printer_id)
            .and_then(|(_, p)| p.local_id.clone());
        delivery_from_parts(
            row.clone(),
            job.map_or("", |j| j.name.as_str()),
            job.and_then(|j| j.result.as_ref()),
            local,
        )
    }
}

#[derive(Default)]
pub struct MemoryBackend {
    state: Mutex<State>,
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers an API token for a user.
    pub fn add_token(&self, token: &str, user_id: &str, scopes: &[&str]) {
        let mut s = self.lock();
        let token_id = s.next_id();
        s.tokens.insert(
            token.to_owned(),
            TokenGrant {
                user_id: user_id.to_owned(),
                token_id,
                scopes: scopes.iter().map(|&x| x.to_owned()).collect(),
                allowed: true,
                retry_after_s: None,
            },
        );
    }

    /// Invites an account to cloud slicing with its limits. The memory clock
    /// does not move by days, so every job the account has counts as today's.
    pub fn grant_access(&self, user_id: &str, jobs_per_day: u32, max_upload_bytes: u64) {
        self.lock()
            .access
            .insert(user_id.to_owned(), (jobs_per_day, max_upload_bytes));
    }

    /// Removes an account from the invite list.
    pub fn revoke_access(&self, user_id: &str) {
        self.lock().access.remove(user_id);
    }

    /// Lets `token` make `requests` more calls before it is rate limited.
    pub fn limit_token(&self, token: &str, requests: u32) {
        self.lock().token_budget.insert(token.to_owned(), requests);
    }

    /// Stores a file directly (tests).
    pub fn put_file(&self, bucket: Bucket, path: &str, bytes: &[u8]) {
        self.lock()
            .objects
            .insert((bucket.id(), path.to_owned()), bytes.to_vec());
    }

    /// Marks a user as due for purging (tests).
    pub fn schedule_purge(&self, user_id: &str) {
        self.lock().due.push(user_id.to_owned());
    }

    /// Paths stored in a bucket (tests).
    pub fn paths(&self, bucket: Bucket) -> Vec<String> {
        let mut v: Vec<String> = self
            .lock()
            .objects
            .keys()
            .filter(|(b, _)| *b == bucket.id())
            .map(|(_, p)| p.clone())
            .collect();
        v.sort();
        v
    }

    /// Registers a signed-in session's access token for a user.
    pub fn add_session(&self, access_token: &str, user_id: &str) {
        self.lock()
            .sessions
            .insert(access_token.to_owned(), user_id.to_owned());
    }

    /// Queues a library version for scanning (tests). Its file goes in the
    /// quarantine bucket at `job.storage_path` with `put_file`.
    pub fn queue_scan(&self, job: ScanJob) {
        self.lock().scans.push(MemoryScan {
            job,
            status: "queued",
            result: None,
        });
    }

    /// The scan state of a version: `queued`, `scanning`, `clean` or `rejected` (tests).
    pub fn scan_status(&self, version_id: &str) -> Option<&'static str> {
        self.lock()
            .scans
            .iter()
            .find(|s| s.job.version_id == version_id)
            .map(|s| s.status)
    }

    /// What `finish_scan` recorded for a version (tests).
    pub fn scan_result(&self, version_id: &str) -> Option<ScanFinish> {
        self.lock()
            .scans
            .iter()
            .find(|s| s.job.version_id == version_id)
            .and_then(|s| s.result.clone())
    }

    /// Adds a printer the user owns but that no bridge reaches (tests).
    pub fn add_unbridged_printer(&self, user_id: &str, name: &str) -> String {
        let mut s = self.lock();
        let id = s.next_id();
        s.printers.push((
            user_id.to_owned(),
            SyncPrinter {
                id: id.clone(),
                name: name.to_owned(),
                driver: None,
                model: None,
                device_id: None,
                local_id: None,
                printer_profile_id: None,
                deleted: false,
            },
        ));
        id
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A poisoned lock only means a test thread panicked; the data is still usable.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl Backend for MemoryBackend {
    async fn resolve_token(&self, token: &str, _ip: Option<&str>) -> Result<Option<TokenGrant>> {
        let mut s = self.lock();
        let Some(mut grant) = s.tokens.get(token).cloned() else {
            return Ok(None);
        };
        if let Some(left) = s.token_budget.get_mut(token) {
            if *left == 0 {
                grant.allowed = false;
                grant.retry_after_s = Some(42);
            } else {
                *left -= 1;
            }
        }
        Ok(Some(grant))
    }

    async fn session_user(&self, access_token: &str) -> Result<Option<String>> {
        Ok(self.lock().sessions.get(access_token).cloned())
    }

    async fn put_object(
        &self,
        bucket: Bucket,
        path: &str,
        bytes: Vec<u8>,
        _content_type: &str,
    ) -> Result<()> {
        self.lock().objects.insert((bucket.id(), path.to_owned()), bytes);
        Ok(())
    }

    async fn get_object(&self, bucket: Bucket, path: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.lock().objects.get(&(bucket.id(), path.to_owned())).cloned())
    }

    async fn delete_object(&self, bucket: Bucket, path: &str) -> Result<()> {
        self.lock().objects.remove(&(bucket.id(), path.to_owned()));
        Ok(())
    }

    async fn object_exists(&self, bucket: Bucket, path: &str) -> Result<bool> {
        Ok(self.lock().objects.contains_key(&(bucket.id(), path.to_owned())))
    }

    async fn claim_scan(&self, _worker: &str) -> Result<Option<ScanJob>> {
        let mut s = self.lock();
        Ok(s.scans.iter_mut().find(|x| x.status == "queued").map(|x| {
            x.status = "scanning";
            x.job.clone()
        }))
    }

    async fn finish_scan(&self, version_id: &str, finish: ScanFinish) -> Result<bool> {
        let mut s = self.lock();
        let Some(row) = s
            .scans
            .iter_mut()
            .find(|x| x.job.version_id == version_id && x.status == "scanning")
        else {
            return Ok(false);
        };
        row.status = if finish.ok { "clean" } else { "rejected" };
        if let Some(path) = &finish.storage_path {
            row.job.storage_path.clone_from(path);
        }
        row.result = Some(finish);
        Ok(true)
    }

    async fn requeue_stale_scans(&self) -> Result<usize> {
        let mut s = self.lock();
        let mut n = 0;
        for x in s.scans.iter_mut().filter(|x| x.status == "scanning") {
            x.status = "queued";
            n += 1;
        }
        Ok(n)
    }

    async fn cloud_quota(&self, user_id: &str) -> Result<Option<CloudQuota>> {
        let s = self.lock();
        Ok(s.quota(user_id))
    }

    async fn insert_job(&self, new: NewJob) -> Result<Job> {
        let mut s = self.lock();
        let quota = s.quota(&new.user_id).ok_or_else(|| {
            Error::Forbidden("cloud slicing is invite only, and this account is not on the list".into())
        })?;
        if quota.jobs_today >= quota.jobs_per_day {
            return Err(Error::Limit(format!(
                "this account has used its {} cloud slices for the last 24 hours",
                quota.jobs_per_day
            )));
        }
        let active = s
            .jobs
            .iter()
            .filter(|(j, _)| j.user_id == new.user_id && j.status.is_active())
            .count();
        if active >= MAX_ACTIVE_JOBS {
            return Err(Error::Limit(
                "five jobs are already queued or running; wait for one to finish".into(),
            ));
        }
        if let Some(target) = &new.target_printer_id {
            let ok = s.printers.iter().any(|(owner, p)| {
                &p.id == target && owner == &new.user_id && !p.deleted && p.device_id.is_some()
            });
            if !ok {
                return Err(Error::BadRequest(
                    "the target printer must be one of the owner's printers on a bridge".into(),
                ));
            }
        }
        let id = s.next_id();
        let created_at = s.now();
        let job = Job {
            id,
            user_id: new.user_id,
            name: new.name,
            status: JobStatus::Queued,
            progress: 0.0,
            stage: None,
            request: new.request,
            target_printer_id: new.target_printer_id,
            result: None,
            gcode_path: None,
            preview_path: None,
            error: None,
            attempts: 0,
            created_at,
            started_at: None,
            finished_at: None,
        };
        s.jobs.push((job.clone(), None));
        Ok(job)
    }

    async fn job(&self, user_id: &str, id: &str) -> Result<Option<Job>> {
        Ok(self
            .lock()
            .jobs
            .iter()
            .find(|(j, _)| j.id == id && j.user_id == user_id)
            .map(|(j, _)| j.clone()))
    }

    async fn jobs(&self, user_id: &str, limit: u32) -> Result<Vec<Job>> {
        Ok(self
            .lock()
            .jobs
            .iter()
            .rev()
            .filter(|(j, _)| j.user_id == user_id)
            .take(limit as usize)
            .map(|(j, _)| j.clone())
            .collect())
    }

    async fn cancel_job(&self, user_id: &str, id: &str) -> Result<bool> {
        let mut s = self.lock();
        let now = s.now();
        let Some((job, _)) = s
            .jobs
            .iter_mut()
            .find(|(j, _)| j.id == id && j.user_id == user_id && j.status.is_active())
        else {
            return Ok(false);
        };
        job.status = JobStatus::Canceled;
        job.finished_at = Some(now);
        Ok(true)
    }

    async fn claim_job(&self, worker: &str) -> Result<Option<Job>> {
        let mut s = self.lock();
        let now = s.now();
        let Some((job, owner)) = s.jobs.iter_mut().find(|(j, _)| j.status == JobStatus::Queued) else {
            return Ok(None);
        };
        job.status = JobStatus::Running;
        job.attempts += 1;
        job.started_at.get_or_insert(now);
        *owner = Some(worker.to_owned());
        Ok(Some(job.clone()))
    }

    async fn report_progress(&self, id: &str, worker: &str, progress: f32, stage: &str) -> Result<bool> {
        let mut s = self.lock();
        let Some((job, _)) = s
            .jobs
            .iter_mut()
            .find(|(j, w)| j.id == id && j.status == JobStatus::Running && w.as_deref() == Some(worker))
        else {
            return Ok(false);
        };
        job.progress = progress.clamp(0.0, 1.0);
        job.stage = Some(stage.to_owned());
        Ok(true)
    }

    async fn finish_job(&self, id: &str, worker: &str, outcome: Outcome) -> Result<bool> {
        let mut s = self.lock();
        let now = s.now();
        let Some((job, _)) = s
            .jobs
            .iter_mut()
            .find(|(j, w)| j.id == id && j.status == JobStatus::Running && w.as_deref() == Some(worker))
        else {
            return Ok(false);
        };
        job.finished_at = Some(now);
        job.stage = None;
        match outcome {
            Outcome::Succeeded {
                result,
                gcode_path,
                preview_path,
            } => {
                job.status = JobStatus::Succeeded;
                job.progress = 1.0;
                job.result = Some(result);
                job.gcode_path = Some(gcode_path);
                job.preview_path = Some(preview_path);
            }
            Outcome::Failed { error } => {
                job.status = JobStatus::Failed;
                job.error = Some(error);
            }
        }
        let job = job.clone();
        if job.status == JobStatus::Succeeded
            && let Some(target) = &job.target_printer_id
        {
            let printer = s
                .printers
                .iter()
                .find(|(owner, p)| &p.id == target && owner == &job.user_id && !p.deleted)
                .and_then(|(_, p)| p.device_id.clone().map(|d| (p.id.clone(), d)));
            if let Some((printer_id, device_id)) = printer {
                let id = s.next_id();
                let created_at = s.now();
                s.deliveries.push(DeliveryRow {
                    id,
                    job_id: job.id.clone(),
                    printer_id,
                    device_id,
                    state: DeliveryState::Offered,
                    message: None,
                    created_at,
                    expires_at: "2026-01-02T00:00:00Z".to_owned(),
                });
            }
        }
        Ok(true)
    }

    async fn register_device(&self, user_id: &str, kind: DeviceKind, name: &str) -> Result<Device> {
        let mut s = self.lock();
        let id = s.next_id();
        let created_at = s.now();
        let d = Device {
            id,
            user_id: user_id.to_owned(),
            kind,
            name: name.to_owned(),
            created_at,
        };
        s.devices.push(d.clone());
        Ok(d)
    }

    async fn device(&self, user_id: &str, id: &str) -> Result<Option<Device>> {
        Ok(self
            .lock()
            .devices
            .iter()
            .find(|d| d.id == id && d.user_id == user_id)
            .cloned())
    }

    async fn set_device_printers(
        &self,
        user_id: &str,
        device_id: &str,
        printers: &[LinkPrinter],
    ) -> Result<Vec<SyncPrinter>> {
        let mut s = self.lock();
        for lp in printers {
            let existing = s.printers.iter_mut().find(|(owner, p)| {
                owner == user_id
                    && p.device_id.as_deref() == Some(device_id)
                    && p.local_id.as_deref() == Some(lp.local_id.as_str())
            });
            if let Some((_, p)) = existing {
                p.name.clone_from(&lp.name);
                p.driver.clone_from(&lp.driver);
                p.model.clone_from(&lp.model);
                p.deleted = false;
            } else {
                let id = s.next_id();
                s.printers.push((
                    user_id.to_owned(),
                    SyncPrinter {
                        id,
                        name: lp.name.clone(),
                        driver: lp.driver.clone(),
                        model: lp.model.clone(),
                        device_id: Some(device_id.to_owned()),
                        local_id: Some(lp.local_id.clone()),
                        printer_profile_id: None,
                        deleted: false,
                    },
                ));
            }
        }
        for (owner, p) in &mut s.printers {
            if owner == user_id
                && p.device_id.as_deref() == Some(device_id)
                && !printers
                    .iter()
                    .any(|lp| p.local_id.as_deref() == Some(lp.local_id.as_str()))
            {
                p.deleted = true;
            }
        }
        Ok(s.printers
            .iter()
            .filter(|(owner, p)| owner == user_id && p.device_id.as_deref() == Some(device_id))
            .map(|(_, p)| p.clone())
            .collect())
    }

    async fn open_deliveries(&self, user_id: &str, device_id: &str) -> Result<Vec<Delivery>> {
        let s = self.lock();
        let owned: Vec<&str> = s
            .jobs
            .iter()
            .filter(|(j, _)| j.user_id == user_id)
            .map(|(j, _)| j.id.as_str())
            .collect();
        Ok(s.deliveries
            .iter()
            .filter(|d| d.device_id == device_id && d.state.is_open() && owned.contains(&d.job_id.as_str()))
            .map(|d| s.delivery(d))
            .collect())
    }

    async fn purge_due_accounts(&self) -> Result<Vec<String>> {
        let mut s = self.lock();
        let due = std::mem::take(&mut s.due);
        s.jobs.retain(|(j, _)| !due.contains(&j.user_id));
        s.devices.retain(|d| !due.contains(&d.user_id));
        s.printers.retain(|(owner, _)| !due.contains(owner));
        s.access.retain(|user, _| !due.contains(user));
        Ok(due)
    }

    async fn delete_user_files(&self, user_id: &str) -> Result<usize> {
        let prefix = format!("{user_id}/");
        let mut s = self.lock();
        let before = s.objects.len();
        s.objects.retain(|(_, path), _| !path.starts_with(&prefix));
        Ok(before - s.objects.len())
    }

    async fn expire_cloud_files(&self, days: u32) -> Result<usize> {
        // The memory clock moves one second per call, so nothing here is ever
        // days old; files live until the process ends.
        let _ = days;
        Ok(0)
    }

    async fn delivery(&self, user_id: &str, device_id: &str, id: &str) -> Result<Option<Delivery>> {
        let s = self.lock();
        Ok(s.deliveries
            .iter()
            .find(|d| {
                d.id == id
                    && d.device_id == device_id
                    && s.jobs
                        .iter()
                        .any(|(j, _)| j.id == d.job_id && j.user_id == user_id)
            })
            .map(|d| s.delivery(d)))
    }

    async fn set_delivery_state(
        &self,
        user_id: &str,
        device_id: &str,
        id: &str,
        state: DeliveryState,
        message: Option<&str>,
    ) -> Result<Option<Delivery>> {
        let mut s = self.lock();
        let owned: Vec<String> = s
            .jobs
            .iter()
            .filter(|(j, _)| j.user_id == user_id)
            .map(|(j, _)| j.id.clone())
            .collect();
        let Some(row) = s
            .deliveries
            .iter_mut()
            .find(|d| d.id == id && d.device_id == device_id && owned.contains(&d.job_id))
        else {
            return Ok(None);
        };
        if !row.state.can_move_to(state) {
            return Err(Error::Conflict(format!(
                "a delivery cannot go from {} to {}",
                row.state.as_str(),
                state.as_str()
            )));
        }
        row.state = state;
        row.message = message.map(str::to_owned);
        let row = row.clone();
        Ok(Some(s.delivery(&row)))
    }
}
