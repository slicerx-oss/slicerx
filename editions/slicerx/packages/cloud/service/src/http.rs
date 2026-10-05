// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The HTTP API. Every route except `/healthz` and `/v1/about` needs
//! `Authorization: Bearer` with a Supabase access token from a signed-in
//! session or an `sxk_` API token: `cloud_slice` for meshes and jobs, `link`
//! for the device and delivery routes a bridge uses. The routes are listed in
//! the package README.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sx_core::api::{SCHEMA_VERSION, SliceRequest};

use crate::backend::{
    Backend, Bucket, CLOUD_SLICE_SCOPE, CloudQuota, DeliveryState, DeviceKind, Job, JobStatus, LINK_SCOPE,
    LinkPrinter, NewJob, Principal, mesh_path,
};
use crate::error::{Error, Result};
use crate::worker::sha256_hex;

/// Largest mesh upload, matching the cloud-inputs bucket limit.
pub const MAX_MESH_BYTES: usize = 50 * 1024 * 1024;
/// Largest job body (the request JSON without meshes).
pub const MAX_JOB_BYTES: usize = 256 * 1024;
pub const MAX_OBJECTS: usize = 64;
pub const MAX_PRINTERS_PER_DEVICE: usize = 200;
/// Longest a deliveries poll may wait.
pub const MAX_WAIT_S: u64 = 30;

pub struct App {
    pub backend: Arc<dyn Backend>,
    /// How often a waiting deliveries poll checks again.
    pub poll_step: Duration,
    /// Public facts about this deployment for `/v1/about`: the brand name and
    /// the source link the AGPL asks a hosted service to offer.
    pub about: About,
    /// Take the caller's address from `X-Forwarded-For`. Only for deployments
    /// behind a proxy that sets it; otherwise the socket address is used.
    pub trust_forwarded: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

/// The routes left when cloud slicing is off: health and
/// about only. The process still runs the library upload scan and the
/// account purge.
pub fn status_router(app: Arc<App>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/about", get(about))
        .with_state(app)
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/about", get(about))
        .route("/v1/access", get(access))
        .route(
            "/v1/meshes/{sha256}",
            get(mesh_exists)
                .put(upload_mesh)
                .layer(DefaultBodyLimit::max(MAX_MESH_BYTES)),
        )
        .route(
            "/v1/jobs",
            post(create_job)
                .get(list_jobs)
                .layer(DefaultBodyLimit::max(MAX_JOB_BYTES)),
        )
        .route("/v1/jobs/{id}", get(get_job))
        .route("/v1/jobs/{id}/cancel", post(cancel_job))
        .route("/v1/jobs/{id}/gcode", get(download_gcode))
        .route("/v1/jobs/{id}/preview", get(download_preview))
        .route("/v1/devices", post(register_device))
        .route("/v1/devices/{id}/printers", put(set_printers))
        .route("/v1/devices/{id}/deliveries", get(poll_deliveries))
        .route(
            "/v1/devices/{device}/deliveries/{id}/state",
            post(set_delivery_state),
        )
        .route(
            "/v1/devices/{device}/deliveries/{id}/gcode",
            get(download_delivery),
        )
        .with_state(app)
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) | Self::NotInvited => StatusCode::FORBIDDEN,
            Self::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Limit(_) | Self::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::Backend(_) => StatusCode::BAD_GATEWAY,
        };
        let message = match &self {
            Self::Backend(detail) => {
                eprintln!("sx-cloud: {detail}");
                "the service could not reach its storage; try again".to_owned()
            }
            other => other.to_string(),
        };
        let body = json!({ "error": { "code": self.code(), "message": message } });
        let mut res = (status, Json(body)).into_response();
        if let Self::RateLimited(s) = self {
            res.headers_mut().insert(header::RETRY_AFTER, s.into());
        }
        res
    }
}

/// Resolves the bearer credential. A token must carry `scope`; a signed-in
/// session may call every route.
async fn authenticate(parts: &Parts, app: &App, scope: &str) -> Result<Principal> {
    let token = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or(Error::Unauthorized)?;
    if token.starts_with("sxk_") {
        // Once per request: resolving a token counts against its per-minute
        // limit and stamps its last use.
        let ip = client_ip(parts, app);
        let grant = app
            .backend
            .resolve_token(token, ip.as_deref())
            .await?
            .ok_or(Error::Unauthorized)?;
        if !grant.allowed {
            let wait = grant
                .retry_after_s
                .and_then(|s| u64::try_from(s).ok())
                .unwrap_or(60);
            return Err(Error::RateLimited(wait.max(1)));
        }
        if !grant.scopes.iter().any(|s| s == scope) {
            return Err(Error::Forbidden(format!(
                "this token does not have the {scope} scope"
            )));
        }
        return Ok(Principal {
            user_id: grant.user_id,
            token_id: Some(grant.token_id),
        });
    }
    let user_id = app
        .backend
        .session_user(token)
        .await?
        .ok_or(Error::Unauthorized)?;
    Ok(Principal {
        user_id,
        token_id: None,
    })
}

/// The caller's address as text, or `None` when unknown.
fn client_ip(parts: &Parts, app: &App) -> Option<String> {
    // Fly-Client-IP is set by Fly's proxy; otherwise the last X-Forwarded-For entry, the one
    // the trusted proxy appended (a client can write the earlier entries itself).
    let header = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok());
    let forwarded = app
        .trust_forwarded
        .then(|| {
            header("fly-client-ip").or_else(|| header("x-forwarded-for").and_then(|v| v.rsplit(',').next()))
        })
        .flatten()
        .and_then(|v| v.trim().parse::<std::net::IpAddr>().ok());
    forwarded
        .or_else(|| {
            parts
                .extensions
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|c| c.0.ip())
        })
        .map(|ip| ip.to_string())
}

/// The caller's cloud limits, or `NotInvited`: hosted cloud slicing is invite
/// only, so every slicing and bridge route checks the list on each request.
async fn invited(app: &App, who: &Principal) -> Result<CloudQuota> {
    app.backend
        .cloud_quota(&who.user_id)
        .await?
        .ok_or(Error::NotInvited)
}

/// A caller allowed to upload meshes and run jobs (`cloud_slice`), with the
/// account's limits.
pub struct Slicer(pub Principal, pub CloudQuota);

/// A bridge: registers itself, lists printers and moves deliveries (`link`).
pub struct Bridge(pub Principal);

/// A signed-in member or `cloud_slice` token, invited or not (`/v1/access`).
pub struct Member(pub Principal);

impl FromRequestParts<Arc<App>> for Slicer {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self> {
        let who = authenticate(parts, app, CLOUD_SLICE_SCOPE).await?;
        let quota = invited(app, &who).await?;
        Ok(Self(who, quota))
    }
}

impl FromRequestParts<Arc<App>> for Bridge {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self> {
        let who = authenticate(parts, app, LINK_SCOPE).await?;
        invited(app, &who).await?;
        Ok(Self(who))
    }
}

impl FromRequestParts<Arc<App>> for Member {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self> {
        authenticate(parts, app, CLOUD_SLICE_SCOPE).await.map(Self)
    }
}

/// Whether the caller is invited, with the limits and today's use, so a
/// client can explain a refusal before it uploads anything.
async fn access(State(app): State<Arc<App>>, Member(who): Member) -> Result<Json<Value>> {
    Ok(Json(match app.backend.cloud_quota(&who.user_id).await? {
        Some(q) => json!({
            "invited": true,
            "jobsPerDay": q.jobs_per_day,
            "jobsToday": q.jobs_today,
            "maxUploadBytes": q.max_upload_bytes,
        }),
        None => json!({ "invited": false }),
    }))
}

async fn about(State(app): State<Arc<App>>) -> Json<About> {
    Json(app.about.clone())
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn uuid_param(s: &str, what: &'static str) -> Result<()> {
    if is_uuid(s) {
        Ok(())
    } else {
        Err(Error::NotFound(what))
    }
}

async fn mesh_exists(
    State(app): State<Arc<App>>,
    Slicer(who, _): Slicer,
    Path(sha): Path<String>,
) -> Result<Json<Value>> {
    if !is_sha256(&sha) {
        return Err(Error::BadRequest("mesh ids are lowercase hex SHA-256".into()));
    }
    if app
        .backend
        .object_exists(Bucket::Inputs, &mesh_path(&who.user_id, &sha))
        .await?
    {
        Ok(Json(json!({ "sha256": sha })))
    } else {
        Err(Error::NotFound("mesh"))
    }
}

async fn upload_mesh(
    State(app): State<Arc<App>>,
    Slicer(who, quota): Slicer,
    Path(sha): Path<String>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>)> {
    if !is_sha256(&sha) {
        return Err(Error::BadRequest("mesh ids are lowercase hex SHA-256".into()));
    }
    if body.is_empty() {
        return Err(Error::BadRequest("the mesh is empty".into()));
    }
    if body.len() as u64 > quota.max_upload_bytes {
        return Err(Error::TooLarge(format!(
            "this account can upload meshes up to {} MB",
            quota.max_upload_bytes / (1024 * 1024)
        )));
    }
    let bytes = body.to_vec();
    let actual = tokio::task::spawn_blocking({
        let b = body.clone();
        move || sha256_hex(&b)
    })
    .await
    .map_err(|e| Error::Backend(e.to_string()))?;
    if actual != sha {
        return Err(Error::BadRequest(format!(
            "the upload hashes to {actual}, not {sha}"
        )));
    }
    let len = bytes.len();
    app.backend
        .put_object(
            Bucket::Inputs,
            &mesh_path(&who.user_id, &sha),
            bytes,
            "application/octet-stream",
        )
        .await?;
    Ok((StatusCode::CREATED, Json(json!({ "sha256": sha, "bytes": len }))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateJob {
    #[serde(default)]
    name: Option<String>,
    /// A `SliceRequest` whose object `mesh` values are SHA-256 ids of uploaded meshes.
    request: Value,
    #[serde(default)]
    target_printer_id: Option<String>,
}

/// A job as the API returns it: the row plus download paths once it succeeds.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobView {
    #[serde(flatten)]
    job: Job,
    #[serde(skip_serializing_if = "Option::is_none")]
    gcode_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview_url: Option<String>,
}

impl From<Job> for JobView {
    fn from(job: Job) -> Self {
        // Paths are cleared when the files expire (SX_CLOUD_RETENTION_DAYS).
        let done = job.status == JobStatus::Succeeded;
        Self {
            gcode_url: (done && job.gcode_path.is_some()).then(|| format!("/v1/jobs/{}/gcode", job.id)),
            preview_url: (done && job.preview_path.is_some()).then(|| format!("/v1/jobs/{}/preview", job.id)),
            job,
        }
    }
}

/// Checks a request before it is queued, so the worker only sees requests it
/// can run. Mesh references must be hashes of the caller's uploads; paths are
/// never accepted.
async fn validate_request(app: &App, user_id: &str, raw: &Value) -> Result<()> {
    if raw.get("meshes").is_some() {
        return Err(Error::BadRequest(
            "upload meshes to /v1/meshes and reference them by SHA-256; a meshes map is not accepted".into(),
        ));
    }
    let req: SliceRequest =
        serde_json::from_value(raw.clone()).map_err(|e| Error::BadRequest(format!("request: {e}")))?;
    if let Some(v) = req.schema_version
        && v != SCHEMA_VERSION
    {
        return Err(Error::BadRequest(format!(
            "request schemaVersion {v} is not supported; this service reads {SCHEMA_VERSION}"
        )));
    }
    if req.plate.objects.is_empty() {
        return Err(Error::BadRequest("the plate has no objects".into()));
    }
    if req.plate.objects.len() > MAX_OBJECTS {
        return Err(Error::BadRequest(format!(
            "a plate can hold at most {MAX_OBJECTS} objects"
        )));
    }
    if !req.config.is_null() && !req.config.is_object() {
        return Err(Error::BadRequest("config must be an object".into()));
    }
    if let Some(engine) = &req.options.engine
        && engine != "sx"
    {
        return Err(Error::BadRequest(format!(
            "engine {engine} is not available in the cloud"
        )));
    }
    if req.options.shards.is_some_and(|n| n > 64) {
        return Err(Error::BadRequest("shards can be at most 64".into()));
    }
    let mut seen: Vec<String> = Vec::new();
    for object in &req.plate.objects {
        let sha = object.mesh_ref();
        if !is_sha256(&sha) {
            return Err(Error::BadRequest(format!(
                "object {} must reference its mesh by lowercase hex SHA-256",
                object.id
            )));
        }
        if seen.contains(&sha) {
            continue;
        }
        if !app
            .backend
            .object_exists(Bucket::Inputs, &mesh_path(user_id, &sha))
            .await?
        {
            return Err(Error::BadRequest(format!(
                "mesh {sha} has not been uploaded; PUT it to /v1/meshes/{sha} first"
            )));
        }
        seen.push(sha);
    }
    Ok(())
}

async fn create_job(
    State(app): State<Arc<App>>,
    Slicer(who, quota): Slicer,
    Json(body): Json<CreateJob>,
) -> Result<(StatusCode, Json<JobView>)> {
    // The database enforces this too; checking first saves the mesh lookups.
    if quota.jobs_today >= quota.jobs_per_day {
        return Err(Error::Limit(format!(
            "this account has used its {} cloud slices for the last 24 hours",
            quota.jobs_per_day
        )));
    }
    validate_request(&app, &who.user_id, &body.request).await?;
    let name = body
        .name
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Cloud slice".to_owned());
    if name.chars().count() > 200 {
        return Err(Error::BadRequest("names are at most 200 characters".into()));
    }
    if let Some(p) = &body.target_printer_id
        && !is_uuid(p)
    {
        return Err(Error::BadRequest("targetPrinterId must be a printer id".into()));
    }
    let job = app
        .backend
        .insert_job(NewJob {
            user_id: who.user_id,
            token_id: who.token_id,
            name,
            request: body.request,
            target_printer_id: body.target_printer_id,
        })
        .await?;
    Ok((StatusCode::ACCEPTED, Json(job.into())))
}

#[derive(Deserialize)]
struct ListQuery {
    limit: Option<u32>,
}

async fn list_jobs(
    State(app): State<Arc<App>>,
    Slicer(who, _): Slicer,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<JobView>>> {
    let limit = q.limit.unwrap_or(20).clamp(1, 100);
    let jobs = app.backend.jobs(&who.user_id, limit).await?;
    Ok(Json(jobs.into_iter().map(JobView::from).collect()))
}

async fn get_job(
    State(app): State<Arc<App>>,
    Slicer(who, _): Slicer,
    Path(id): Path<String>,
) -> Result<Json<JobView>> {
    uuid_param(&id, "job")?;
    let job = app
        .backend
        .job(&who.user_id, &id)
        .await?
        .ok_or(Error::NotFound("job"))?;
    Ok(Json(job.into()))
}

async fn cancel_job(
    State(app): State<Arc<App>>,
    Slicer(who, _): Slicer,
    Path(id): Path<String>,
) -> Result<Json<JobView>> {
    uuid_param(&id, "job")?;
    let canceled = app.backend.cancel_job(&who.user_id, &id).await?;
    let job = app
        .backend
        .job(&who.user_id, &id)
        .await?
        .ok_or(Error::NotFound("job"))?;
    if !canceled && job.status != JobStatus::Canceled {
        return Err(Error::Conflict("the job has already finished".into()));
    }
    Ok(Json(job.into()))
}

async fn download(app: &App, who: &Principal, id: &str, gcode: bool) -> Result<Response> {
    uuid_param(id, "job")?;
    let job = app
        .backend
        .job(&who.user_id, id)
        .await?
        .ok_or(Error::NotFound("job"))?;
    let path = if gcode { job.gcode_path } else { job.preview_path };
    let path = path.ok_or(Error::NotFound("result"))?;
    let bytes = app
        .backend
        .get_object(Bucket::Results, &path)
        .await?
        .ok_or(Error::NotFound("result"))?;
    let (ctype, name) = if gcode {
        ("text/x-gcode", "slice.gcode")
    } else {
        ("application/octet-stream", "slice.sxpv")
    };
    Ok((
        [
            (header::CONTENT_TYPE, ctype.to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

async fn download_gcode(
    State(app): State<Arc<App>>,
    Slicer(who, _): Slicer,
    Path(id): Path<String>,
) -> Result<Response> {
    download(&app, &who, &id, true).await
}

async fn download_preview(
    State(app): State<Arc<App>>,
    Slicer(who, _): Slicer,
    Path(id): Path<String>,
) -> Result<Response> {
    download(&app, &who, &id, false).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterDevice {
    name: String,
    kind: DeviceKind,
}

async fn register_device(
    State(app): State<Arc<App>>,
    Bridge(who): Bridge,
    Json(body): Json<RegisterDevice>,
) -> Result<(StatusCode, Json<Value>)> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(Error::BadRequest("device names are 1 to 80 characters".into()));
    }
    let device = app.backend.register_device(&who.user_id, body.kind, name).await?;
    Ok((StatusCode::CREATED, Json(json!(device))))
}

fn valid_local_id(s: &str) -> bool {
    (1..=120).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

async fn owned_device(app: &App, who: &Principal, id: &str) -> Result<()> {
    uuid_param(id, "device")?;
    app.backend
        .device(&who.user_id, id)
        .await?
        .map(drop)
        .ok_or(Error::NotFound("device"))
}

async fn set_printers(
    State(app): State<Arc<App>>,
    Bridge(who): Bridge,
    Path(id): Path<String>,
    Json(printers): Json<Vec<LinkPrinter>>,
) -> Result<Json<Value>> {
    owned_device(&app, &who, &id).await?;
    if printers.len() > MAX_PRINTERS_PER_DEVICE {
        return Err(Error::BadRequest(format!(
            "a bridge can list at most {MAX_PRINTERS_PER_DEVICE} printers"
        )));
    }
    for p in &printers {
        if !valid_local_id(&p.local_id) {
            return Err(Error::BadRequest(
                "localId is 1 to 120 letters, digits, dashes, underscores, dots or colons".into(),
            ));
        }
        if p.name.trim().is_empty() || p.name.chars().count() > 80 {
            return Err(Error::BadRequest("printer names are 1 to 80 characters".into()));
        }
        if p.driver.as_deref().is_some_and(|d| {
            d.is_empty()
                || d.len() > 40
                || !d
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
        }) {
            return Err(Error::BadRequest(
                "driver is a lowercase id such as moonraker".into(),
            ));
        }
        if p.model.as_deref().is_some_and(|m| m.chars().count() > 120) {
            return Err(Error::BadRequest("model names are at most 120 characters".into()));
        }
    }
    let rows = app
        .backend
        .set_device_printers(&who.user_id, &id, &printers)
        .await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct PollQuery {
    wait: Option<u64>,
}

/// Returns the device's open deliveries. With `wait`, holds the request until
/// a new offer arrives or `wait` seconds pass, so a bridge can poll in a loop
/// over one outbound connection without busy looping on deliveries that are
/// waiting for the user.
async fn poll_deliveries(
    State(app): State<Arc<App>>,
    Bridge(who): Bridge,
    Path(id): Path<String>,
    Query(q): Query<PollQuery>,
) -> Result<Json<Value>> {
    owned_device(&app, &who, &id).await?;
    let wait = Duration::from_secs(q.wait.unwrap_or(0).min(MAX_WAIT_S));
    let started = tokio::time::Instant::now();
    loop {
        let open = app.backend.open_deliveries(&who.user_id, &id).await?;
        let offered = open.iter().any(|d| d.state == DeliveryState::Offered);
        if offered || started.elapsed() >= wait {
            return Ok(Json(json!(open)));
        }
        tokio::time::sleep(app.poll_step.min(wait.saturating_sub(started.elapsed()))).await;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StateBody {
    state: DeliveryState,
    #[serde(default)]
    message: Option<String>,
}

async fn set_delivery_state(
    State(app): State<Arc<App>>,
    Bridge(who): Bridge,
    Path((device, id)): Path<(String, String)>,
    Json(body): Json<StateBody>,
) -> Result<Json<Value>> {
    owned_device(&app, &who, &device).await?;
    uuid_param(&id, "delivery")?;
    if matches!(
        body.state,
        DeliveryState::Offered | DeliveryState::Expired | DeliveryState::Canceled
    ) {
        return Err(Error::BadRequest(
            "a bridge reports downloaded, awaiting_approval, approved, declined, uploaded, printing or failed".into(),
        ));
    }
    let message = body.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    if message.is_some_and(|m| m.chars().count() > 500) {
        return Err(Error::BadRequest("messages are at most 500 characters".into()));
    }
    let d = app
        .backend
        .set_delivery_state(&who.user_id, &device, &id, body.state, message)
        .await?
        .ok_or(Error::NotFound("delivery"))?;
    Ok(Json(json!(d)))
}

/// The G-code of a delivery, for the bridge it was offered to.
async fn download_delivery(
    State(app): State<Arc<App>>,
    Bridge(who): Bridge,
    Path((device, id)): Path<(String, String)>,
) -> Result<Response> {
    owned_device(&app, &who, &device).await?;
    uuid_param(&id, "delivery")?;
    let d = app
        .backend
        .delivery(&who.user_id, &device, &id)
        .await?
        .filter(|d| d.state.is_open())
        .ok_or(Error::NotFound("delivery"))?;
    download(&app, &who, &d.job_id, true).await
}
