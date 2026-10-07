// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The storage and queue the service runs on: Supabase in production
//! ([`crate::supabase`]) and an in-memory copy of the same rules for tests and
//! offline development ([`crate::memory`]).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;

/// The API token scope for uploading meshes and running jobs.
pub const CLOUD_SLICE_SCOPE: &str = "cloud_slice";

/// The API token scope for a bridge: its device, printer list and deliveries.
pub const LINK_SCOPE: &str = "link";

/// A member can have this many jobs queued or running at once.
pub const MAX_ACTIVE_JOBS: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bucket {
    /// Uploaded meshes at `<user id>/<sha256>`.
    Inputs,
    /// Results at `<user id>/<job id>/slice.gcode` and `slice.sxpv`.
    Results,
    /// Library uploads waiting for the scan, at `<listing>/<version>/<file name>`.
    /// Members write their own version's path; only the service role reads it.
    Quarantine,
    /// Scanned library files at `<listing>/<version>/<file name>.sx3mf` and
    /// `<listing>/<version>/preview.png`. Only the service role writes it;
    /// members read what the store policies allow.
    Library,
}

impl Bucket {
    pub fn id(self) -> &'static str {
        match self {
            Self::Inputs => "cloud-inputs",
            Self::Results => "cloud-results",
            Self::Quarantine => "uploads-quarantine",
            Self::Library => "listing-files",
        }
    }
}

/// A resolved `sxk_` token. `allowed` is false when the token has used up its
/// requests for the current minute; `retry_after_s` then says when to retry.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenGrant {
    pub user_id: String,
    pub token_id: String,
    pub scopes: Vec<String>,
    #[serde(default = "granted")]
    pub allowed: bool,
    #[serde(default)]
    pub retry_after_s: Option<i64>,
}

fn granted() -> bool {
    true
}

/// Who is calling: a member, through an API token or a signed-in session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub user_id: String,
    pub token_id: Option<String>,
}

/// An invited account's cloud limits and today's use (`cloud_quota` in
/// `0006_cloud_access.sql`). Hosted cloud slicing is invite only: an account
/// without a quota cannot upload, queue jobs or read results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudQuota {
    /// Jobs allowed in any 24 hours, canceled ones included.
    #[serde(alias = "jobs_per_day")]
    pub jobs_per_day: u32,
    /// Jobs created in the last 24 hours.
    #[serde(alias = "jobs_today")]
    pub jobs_today: u32,
    /// The largest mesh this account may upload.
    #[serde(alias = "max_upload_bytes")]
    pub max_upload_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

impl JobStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

/// A cloud slicing job. Rows arrive in snake case and leave the API in camel case.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Job {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub status: JobStatus,
    pub progress: f32,
    pub stage: Option<String>,
    pub request: Value,
    pub target_printer_id: Option<String>,
    /// The `sx slice` result JSON (`sx schema result`) once the job succeeds.
    pub result: Option<Value>,
    pub gcode_path: Option<String>,
    pub preview_path: Option<String>,
    pub error: Option<String>,
    pub attempts: i32,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewJob {
    pub user_id: String,
    pub token_id: Option<String>,
    pub name: String,
    pub request: Value,
    pub target_printer_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum Outcome {
    Succeeded {
        result: Value,
        gcode_path: String,
        preview_path: String,
    },
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Link,
    Desktop,
    Web,
    Mobile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct Device {
    pub id: String,
    pub user_id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub created_at: String,
}

/// A printer as a bridge reports it: its id on the bridge and what to show.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPrinter {
    pub local_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct SyncPrinter {
    pub id: String,
    pub name: String,
    pub driver: Option<String>,
    pub model: Option<String>,
    pub device_id: Option<String>,
    pub local_id: Option<String>,
    pub printer_profile_id: Option<String>,
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Offered,
    Downloaded,
    AwaitingApproval,
    Approved,
    Declined,
    Uploaded,
    Printing,
    Failed,
    Expired,
    Canceled,
}

impl DeliveryState {
    /// The transitions `guard_delivery_state` allows in the database. A bridge
    /// cannot reach `approved` without passing through `awaiting_approval`.
    pub fn can_move_to(self, next: Self) -> bool {
        use DeliveryState::{
            Approved, AwaitingApproval, Canceled, Declined, Downloaded, Expired, Failed, Offered, Printing,
            Uploaded,
        };
        self == next
            || matches!(
                (self, next),
                (Offered, Downloaded | Declined | Failed | Expired | Canceled)
                    | (
                        Downloaded,
                        AwaitingApproval | Declined | Failed | Expired | Canceled
                    )
                    | (
                        AwaitingApproval,
                        Approved | Declined | Failed | Expired | Canceled
                    )
                    | (Approved, Uploaded | Failed)
                    | (Uploaded, Printing | Failed)
            )
    }

    /// States a bridge still has work for.
    pub fn is_open(self) -> bool {
        matches!(
            self,
            Self::Offered | Self::Downloaded | Self::AwaitingApproval | Self::Approved | Self::Uploaded
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Offered => "offered",
            Self::Downloaded => "downloaded",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Approved => "approved",
            Self::Declined => "declined",
            Self::Uploaded => "uploaded",
            Self::Printing => "printing",
            Self::Failed => "failed",
            Self::Expired => "expired",
            Self::Canceled => "canceled",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryStats {
    pub time_s: f64,
    pub filament_g: f64,
}

/// A delivery as the bridge sees it: enough to download the file, check it
/// and describe it in the local approval prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    pub id: String,
    pub job_id: String,
    pub printer_id: String,
    pub printer_local_id: Option<String>,
    pub state: DeliveryState,
    pub message: Option<String>,
    /// A plain file name derived from the job name; bridges still sanitize it.
    pub file_name: String,
    /// Lowercase hex SHA-256 of the G-code; the bridge checks it after download.
    pub sha256: String,
    pub bytes: u64,
    /// Path on this service to download the G-code with the bridge's token.
    pub gcode_path: String,
    pub stats: DeliveryStats,
    pub created_at: String,
    pub expires_at: String,
}

/// A library version claimed for scanning: the row from `listing_versions`
/// plus what the sx3mf needs to name (`listings` and `creators`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanJob {
    pub version_id: String,
    pub listing_id: String,
    /// Object name in the quarantine bucket: `<listing>/<version>/<file name>`.
    pub storage_path: String,
    /// The version number, for example `1.0.0`.
    pub version: String,
    pub title: String,
    pub slug: String,
    /// `creators.id`, written into the sx3mf as `sx:Creator`.
    pub creator_id: String,
    pub creator_handle: String,
    pub creator_name: String,
}

/// The result of one scan, as `finish_scan` records it.
#[derive(Debug, Clone, PartialEq)]
pub struct ScanFinish {
    /// The file passed every check and is in the `listing-files` bucket.
    pub ok: bool,
    /// The `sx_upload_scan::ScanReport` as JSON, plus a `reason` line when refused.
    pub report: Value,
    /// SHA-256 of the file in `listing-files`, on success.
    pub sha256: Option<String>,
    pub size_bytes: Option<i64>,
    /// The verified manifest: `{name, role, format, size_bytes, sha256}` per file.
    pub parts: Vec<Value>,
    /// New object name and format when the stored file differs from the upload
    /// (a converted sx3mf under the upload's name).
    pub storage_path: Option<String>,
    pub format: Option<String>,
}

#[async_trait]
pub trait Backend: Send + Sync {
    /// Resolves a token and counts one request against its per-minute limit.
    /// `ip` is the caller's address, recorded as the token's last use.
    async fn resolve_token(&self, token: &str, ip: Option<&str>) -> Result<Option<TokenGrant>>;
    /// The user id behind a Supabase access token, or `None` when it is not valid.
    async fn session_user(&self, access_token: &str) -> Result<Option<String>>;
    /// The account's cloud limits, or `None` when it is not invited or is banned.
    async fn cloud_quota(&self, user_id: &str) -> Result<Option<CloudQuota>>;

    async fn put_object(&self, bucket: Bucket, path: &str, bytes: Vec<u8>, content_type: &str) -> Result<()>;
    async fn get_object(&self, bucket: Bucket, path: &str) -> Result<Option<Vec<u8>>>;
    async fn object_exists(&self, bucket: Bucket, path: &str) -> Result<bool>;
    /// Deletes one file. A missing file is not an error.
    async fn delete_object(&self, bucket: Bucket, path: &str) -> Result<()>;

    /// Claims the next queued library version for scanning.
    async fn claim_scan(&self, worker: &str) -> Result<Option<ScanJob>>;
    /// Records a scan result. Returns false when the version is not being
    /// scanned (someone else finished it, or it was requeued).
    async fn finish_scan(&self, version_id: &str, finish: ScanFinish) -> Result<bool>;
    /// Puts scans that a dead worker left behind back in the queue.
    async fn requeue_stale_scans(&self) -> Result<usize>;

    async fn insert_job(&self, job: NewJob) -> Result<Job>;
    async fn job(&self, user_id: &str, id: &str) -> Result<Option<Job>>;
    async fn jobs(&self, user_id: &str, limit: u32) -> Result<Vec<Job>>;
    async fn cancel_job(&self, user_id: &str, id: &str) -> Result<bool>;
    async fn claim_job(&self, worker: &str) -> Result<Option<Job>>;
    /// Records progress; this is also the worker's heartbeat. Returns false
    /// when the job is no longer running on this worker (canceled or reclaimed).
    async fn report_progress(&self, id: &str, worker: &str, progress: f32, stage: &str) -> Result<bool>;
    async fn finish_job(&self, id: &str, worker: &str, outcome: Outcome) -> Result<bool>;

    async fn register_device(&self, user_id: &str, kind: DeviceKind, name: &str) -> Result<Device>;
    async fn device(&self, user_id: &str, id: &str) -> Result<Option<Device>>;
    /// Makes `printers` the device's printer list: adds and renames the listed
    /// printers and marks the device's other printers deleted.
    async fn set_device_printers(
        &self,
        user_id: &str,
        device_id: &str,
        printers: &[LinkPrinter],
    ) -> Result<Vec<SyncPrinter>>;
    async fn open_deliveries(&self, user_id: &str, device_id: &str) -> Result<Vec<Delivery>>;

    /// Purges accounts whose deletion grace period has ended and returns their
    /// ids. Their rows go by cascade; their files are left to `delete_user_files`.
    async fn purge_due_accounts(&self) -> Result<Vec<String>>;
    /// Deletes every file a user has in both buckets; returns how many.
    async fn delete_user_files(&self, user_id: &str) -> Result<usize>;
    /// Clears the download paths of jobs finished more than `days` ago and
    /// deletes cloud files older than that (`expire_cloud_files`), except
    /// meshes a queued or running job still needs. Returns how many files.
    async fn expire_cloud_files(&self, days: u32) -> Result<usize>;
    async fn delivery(&self, user_id: &str, device_id: &str, id: &str) -> Result<Option<Delivery>>;
    async fn set_delivery_state(
        &self,
        user_id: &str,
        device_id: &str,
        id: &str,
        state: DeliveryState,
        message: Option<&str>,
    ) -> Result<Option<Delivery>>;
}

/// Storage path of an uploaded mesh.
pub fn mesh_path(user_id: &str, sha256: &str) -> String {
    format!("{user_id}/{sha256}")
}

/// Storage paths of a job's G-code and preview.
pub fn result_paths(user_id: &str, job_id: &str) -> (String, String) {
    (
        format!("{user_id}/{job_id}/slice.gcode"),
        format!("{user_id}/{job_id}/slice.sxpv"),
    )
}

/// A file name for the printer, in the form sx-link accepts unchanged: at
/// most 100 characters of `A-Za-z0-9._-`, no leading dot, ending in `.gcode`.
/// Printers rename other names on upload, which would break the approval hash.
pub fn gcode_file_name(job_name: &str) -> String {
    let mapped: String = job_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .take(94)
        .collect();
    let s = mapped.trim_start_matches(['.', '_']).trim_end_matches('.');
    if s.is_empty() {
        "cloud-job.gcode".to_owned()
    } else {
        format!("{s}.gcode")
    }
}

/// Builds a [`Delivery`] from its parts; both backends share it.
pub(crate) fn delivery_from_parts(
    d: DeliveryRow,
    job_name: &str,
    job_result: Option<&Value>,
    printer_local_id: Option<String>,
) -> Delivery {
    let num = |k: &str| job_result.and_then(|r| r.get(k));
    let stats = num("stats");
    let filament_g = stats
        .and_then(|s| s.get("filamentG"))
        .and_then(Value::as_array)
        .map_or(0.0, |a| a.iter().filter_map(Value::as_f64).sum());
    Delivery {
        gcode_path: format!("/v1/devices/{}/deliveries/{}/gcode", d.device_id, d.id),
        id: d.id,
        job_id: d.job_id,
        printer_id: d.printer_id,
        printer_local_id,
        state: d.state,
        message: d.message,
        file_name: gcode_file_name(job_name),
        sha256: num("gcodeSha256")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        bytes: num("gcodeBytes").and_then(Value::as_u64).unwrap_or(0),
        stats: DeliveryStats {
            time_s: stats
                .and_then(|s| s.get("timeS"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            filament_g,
        },
        created_at: d.created_at,
        expires_at: d.expires_at,
    }
}

/// A `cloud_deliveries` row.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DeliveryRow {
    pub id: String,
    pub job_id: String,
    pub printer_id: String,
    pub device_id: String,
    pub state: DeliveryState,
    pub message: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_cannot_be_skipped() {
        use DeliveryState::*;
        assert!(Offered.can_move_to(Downloaded));
        assert!(Downloaded.can_move_to(AwaitingApproval));
        assert!(AwaitingApproval.can_move_to(Approved));
        for s in [Offered, Downloaded] {
            assert!(!s.can_move_to(Approved));
            assert!(!s.can_move_to(Uploaded));
            assert!(!s.can_move_to(Printing));
        }
        for s in [Declined, Failed, Expired, Canceled, Printing] {
            assert!(!s.can_move_to(Offered));
            assert!(!s.can_move_to(Approved));
        }
    }

    #[test]
    fn file_names_are_plain() {
        assert_eq!(gcode_file_name("Bracket v2"), "Bracket_v2.gcode");
        assert_eq!(gcode_file_name("../../etc/passwd"), "etc_passwd.gcode");
        assert_eq!(gcode_file_name("..."), "cloud-job.gcode");
        assert_eq!(gcode_file_name("a;rm -rf /"), "a_rm_-rf__.gcode");
        let long = gcode_file_name(&"x".repeat(300));
        assert_eq!(long.len(), 100);
        for name in ["Bracket v2", "../x", ".hidden", "a b c", &"y".repeat(500)] {
            let n = gcode_file_name(name);
            assert!(n.len() <= 100 && !n.starts_with('.') && n.to_ascii_lowercase().ends_with(".gcode"));
            assert!(
                n.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            );
        }
    }
}
