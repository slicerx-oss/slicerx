// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The Supabase backend: `PostgREST` for rows and functions, the Storage API
//! for files and the Auth API to check session tokens. It holds the service
//! role key, so every query filters by user id itself.

use async_trait::async_trait;
use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::backend::{
    Backend, Bucket, CloudQuota, Delivery, DeliveryRow, DeliveryState, Device, DeviceKind, Job, LinkPrinter,
    NewJob, Outcome, ScanFinish, ScanJob, SyncPrinter, TokenGrant, delivery_from_parts,
};
use crate::error::{Error, Result};

pub struct SupabaseBackend {
    http: reqwest::Client,
    url: String,
    key: String,
}

/// Columns the bridge needs from a delivery and its job and printer.
const DELIVERY_SELECT: &str = "id,job_id,printer_id,device_id,state,message,created_at,expires_at,\
job:cloud_jobs(name,result),printer:sync_printers(local_id)";
const OPEN_STATES: &str = "(offered,downloaded,awaiting_approval,approved,uploaded)";

#[derive(Deserialize)]
struct DeliveryJoin {
    #[serde(flatten)]
    row: DeliveryRow,
    job: Option<JobPart>,
    printer: Option<PrinterPart>,
}

#[derive(Deserialize)]
struct JobPart {
    name: String,
    result: Option<Value>,
}

#[derive(Deserialize)]
struct PrinterPart {
    local_id: Option<String>,
}

impl DeliveryJoin {
    fn into_delivery(self) -> Delivery {
        let (name, result) = self.job.map_or((String::new(), None), |j| (j.name, j.result));
        delivery_from_parts(
            self.row,
            &name,
            result.as_ref(),
            self.printer.and_then(|p| p.local_id),
        )
    }
}

impl SupabaseBackend {
    /// `url` is the project URL (for the local stack `http://127.0.0.1:54321`)
    /// and `service_key` the service role key.
    pub fn new(url: &str, service_key: &str) -> Result<Self> {
        Self::with_user_agent(url, service_key, concat!("sx-cloud/", env!("CARGO_PKG_VERSION")))
    }

    /// Like [`Self::new`], naming the service in the `User-Agent` header.
    pub fn with_user_agent(url: &str, service_key: &str, user_agent: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .user_agent(user_agent)
            .build()?;
        Ok(Self {
            http,
            url: url.trim_end_matches('/').to_owned(),
            key: service_key.to_owned(),
        })
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        let rb = self
            .http
            .request(method, format!("{}{path}", self.url))
            .header("apikey", &self.key);
        // A hosted project's secret key (`sb_secret_...`) is not a JWT and goes
        // on the apikey header only; the gateway then acts as the service role.
        // The legacy service role JWT (and the local stack's) also goes in
        // Authorization.
        if is_secret_key(&self.key) {
            rb
        } else {
            rb.bearer_auth(&self.key)
        }
    }

    fn rest(&self, method: Method, table: &str) -> RequestBuilder {
        self.req(method, &format!("/rest/v1/{table}"))
    }

    fn object_url(bucket: Bucket, path: &str) -> String {
        format!("/storage/v1/object/{}/{}", bucket.id(), path)
    }

    async fn rows<T: DeserializeOwned>(&self, rb: RequestBuilder) -> Result<Vec<T>> {
        let res = rb.send().await?;
        let res = check(res).await?;
        Ok(res.json().await?)
    }

    async fn first<T: DeserializeOwned>(&self, rb: RequestBuilder) -> Result<Option<T>> {
        Ok(self.rows(rb).await?.into_iter().next())
    }

    async fn deliveries(&self, query: &[(&str, String)]) -> Result<Vec<Delivery>> {
        let mut q: Vec<(&str, String)> = vec![("select", DELIVERY_SELECT.to_owned())];
        q.extend_from_slice(query);
        let rows: Vec<DeliveryJoin> = self
            .rows(self.rest(Method::GET, "cloud_deliveries").query(&q))
            .await?;
        Ok(rows.into_iter().map(DeliveryJoin::into_delivery).collect())
    }
}

/// Turns `PostgREST` and Storage errors into [`Error`], keeping the database's
/// own message for rule violations, which are written for people.
async fn check(res: Response) -> Result<Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let code = body.get("code").and_then(Value::as_str).unwrap_or_default();
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("request failed")
        .to_owned();
    Err(match code {
        "P0001" => Error::Limit(message),
        "23503" | "23514" | "22023" | "22P02" => Error::BadRequest(message),
        "42501" => Error::Forbidden(message),
        _ => Error::Backend(format!("{status} {code} {message}")),
    })
}

/// A hosted project's secret API key, as opposed to a service role JWT.
fn is_secret_key(key: &str) -> bool {
    key.starts_with("sb_secret_")
}

fn eq(v: &str) -> String {
    format!("eq.{v}")
}

/// Quotes a value for a `PostgREST` `in.(...)` list.
fn quoted(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

#[async_trait]
impl Backend for SupabaseBackend {
    async fn resolve_token(&self, token: &str, ip: Option<&str>) -> Result<Option<TokenGrant>> {
        self.first(
            self.rest(Method::POST, "rpc/resolve_api_token")
                .json(&json!({ "p_token": token, "p_ip": ip, "p_report_limit": true })),
        )
        .await
    }

    async fn session_user(&self, access_token: &str) -> Result<Option<String>> {
        let res = self
            .http
            .get(format!("{}/auth/v1/user", self.url))
            .header("apikey", &self.key)
            .bearer_auth(access_token)
            .send()
            .await?;
        if matches!(
            res.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::BAD_REQUEST
        ) {
            return Ok(None);
        }
        let user: Value = check(res).await?.json().await?;
        Ok(user.get("id").and_then(Value::as_str).map(str::to_owned))
    }

    async fn cloud_quota(&self, user_id: &str) -> Result<Option<CloudQuota>> {
        self.first(
            self.rest(Method::POST, "rpc/cloud_quota")
                .json(&json!({ "p_user": user_id })),
        )
        .await
    }

    async fn put_object(&self, bucket: Bucket, path: &str, bytes: Vec<u8>, content_type: &str) -> Result<()> {
        let res = self
            .req(Method::POST, &Self::object_url(bucket, path))
            .header("x-upsert", "true")
            .header("content-type", content_type)
            .body(bytes)
            .send()
            .await?;
        check(res).await.map(drop)
    }

    async fn get_object(&self, bucket: Bucket, path: &str) -> Result<Option<Vec<u8>>> {
        let res = self
            .req(Method::GET, &Self::object_url(bucket, path))
            .send()
            .await?;
        // Storage answers a missing object with 404, or 400 and a not_found body.
        if matches!(res.status(), StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST) {
            return Ok(None);
        }
        Ok(Some(check(res).await?.bytes().await?.to_vec()))
    }

    async fn object_exists(&self, bucket: Bucket, path: &str) -> Result<bool> {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
        let found: Vec<Value> = self
            .rows(
                self.req(Method::POST, &format!("/storage/v1/object/list/{}", bucket.id()))
                    .json(&json!({ "prefix": dir, "search": name, "limit": 10 })),
            )
            .await?;
        Ok(found
            .iter()
            .any(|o| o.get("name").and_then(Value::as_str) == Some(name)))
    }

    async fn delete_object(&self, bucket: Bucket, path: &str) -> Result<()> {
        let res = self
            .req(Method::DELETE, &format!("/storage/v1/object/{}", bucket.id()))
            .json(&json!({ "prefixes": [path] }))
            .send()
            .await?;
        check(res).await.map(drop)
    }

    async fn claim_scan(&self, worker: &str) -> Result<Option<ScanJob>> {
        #[derive(Deserialize)]
        struct Version {
            id: String,
            listing_id: String,
            #[serde(rename = "version")]
            number: String,
            storage_path: String,
        }
        #[derive(Deserialize)]
        struct Creator {
            id: String,
            handle: String,
            display_name: String,
        }
        #[derive(Deserialize)]
        struct Listing {
            slug: String,
            title: String,
            creator: Creator,
        }
        let Some(v): Option<Version> = self
            .first(
                self.rest(Method::POST, "rpc/claim_scan")
                    .json(&json!({ "p_worker": worker })),
            )
            .await?
        else {
            return Ok(None);
        };
        let listing: Option<Listing> = self
            .first(self.rest(Method::GET, "listings").query(&[
                ("id", eq(&v.listing_id)),
                (
                    "select",
                    "slug,title,creator:creators(id,handle,display_name)".to_owned(),
                ),
            ]))
            .await?;
        let listing = listing.ok_or_else(|| Error::Backend("a version has no listing".into()))?;
        Ok(Some(ScanJob {
            version_id: v.id,
            listing_id: v.listing_id,
            storage_path: v.storage_path,
            version: v.number,
            title: listing.title,
            slug: listing.slug,
            creator_id: listing.creator.id,
            creator_handle: listing.creator.handle,
            creator_name: listing.creator.display_name,
        }))
    }

    async fn finish_scan(&self, version_id: &str, f: ScanFinish) -> Result<bool> {
        let mut args = json!({
            "p_version": version_id,
            "p_ok": f.ok,
            "p_report": f.report,
            "p_sha256": f.sha256,
            "p_size_bytes": f.size_bytes,
            "p_parts": f.parts,
        });
        if let (Some(path), Some(o)) = (&f.storage_path, args.as_object_mut()) {
            o.insert("p_storage_path".into(), json!(path));
        }
        if let (Some(format), Some(o)) = (&f.format, args.as_object_mut()) {
            o.insert("p_format".into(), json!(format));
        }
        let res = self
            .rest(Method::POST, "rpc/finish_scan")
            .json(&args)
            .send()
            .await?;
        match check(res).await {
            Ok(_) => Ok(true),
            // P0001: "this version is not being scanned".
            Err(Error::Limit(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn requeue_stale_scans(&self) -> Result<usize> {
        let res = self
            .rest(Method::POST, "rpc/requeue_stale_scans")
            .json(&json!({}))
            .send()
            .await?;
        let n: Option<i64> = check(res).await?.json().await?;
        Ok(usize::try_from(n.unwrap_or(0)).unwrap_or(0))
    }

    async fn insert_job(&self, job: NewJob) -> Result<Job> {
        self.first(
            self.rest(Method::POST, "cloud_jobs")
                .header("prefer", "return=representation")
                .json(&json!({
                    "user_id": job.user_id,
                    "token_id": job.token_id,
                    "name": job.name,
                    "request": job.request,
                    "target_printer_id": job.target_printer_id,
                })),
        )
        .await?
        .ok_or_else(|| Error::Backend("insert returned no row".into()))
    }

    async fn job(&self, user_id: &str, id: &str) -> Result<Option<Job>> {
        self.first(
            self.rest(Method::GET, "cloud_jobs")
                .query(&[("id", eq(id)), ("user_id", eq(user_id))]),
        )
        .await
    }

    async fn jobs(&self, user_id: &str, limit: u32) -> Result<Vec<Job>> {
        self.rows(self.rest(Method::GET, "cloud_jobs").query(&[
            ("user_id", eq(user_id)),
            ("order", "created_at.desc".to_owned()),
            ("limit", limit.to_string()),
        ]))
        .await
    }

    async fn cancel_job(&self, user_id: &str, id: &str) -> Result<bool> {
        let rows: Vec<Value> = self
            .rows(
                self.rest(Method::PATCH, "cloud_jobs")
                    .query(&[
                        ("id", eq(id)),
                        ("user_id", eq(user_id)),
                        ("status", "in.(queued,running)".to_owned()),
                    ])
                    .header("prefer", "return=representation")
                    .json(&json!({ "status": "canceled", "finished_at": "now" })),
            )
            .await?;
        Ok(!rows.is_empty())
    }

    async fn claim_job(&self, worker: &str) -> Result<Option<Job>> {
        self.first(
            self.rest(Method::POST, "rpc/claim_cloud_job")
                .json(&json!({ "p_worker": worker })),
        )
        .await
    }

    async fn report_progress(&self, id: &str, worker: &str, progress: f32, stage: &str) -> Result<bool> {
        let rows: Vec<Value> = self
            .rows(
                self.rest(Method::PATCH, "cloud_jobs")
                    .query(&[
                        ("id", eq(id)),
                        ("worker", eq(worker)),
                        ("status", eq("running")),
                        ("select", "id".to_owned()),
                    ])
                    .header("prefer", "return=representation")
                    .json(&json!({
                        "progress": progress.clamp(0.0, 1.0),
                        "stage": stage,
                        "heartbeat_at": "now",
                    })),
            )
            .await?;
        Ok(!rows.is_empty())
    }

    async fn finish_job(&self, id: &str, worker: &str, outcome: Outcome) -> Result<bool> {
        let body = match outcome {
            Outcome::Succeeded {
                result,
                gcode_path,
                preview_path,
            } => json!({
                "status": "succeeded",
                "progress": 1,
                "stage": null,
                "result": result,
                "gcode_path": gcode_path,
                "preview_path": preview_path,
                "finished_at": "now",
            }),
            Outcome::Failed { error } => json!({
                "status": "failed",
                "stage": null,
                "error": error.chars().take(1000).collect::<String>(),
                "finished_at": "now",
            }),
        };
        let rows: Vec<Value> = self
            .rows(
                self.rest(Method::PATCH, "cloud_jobs")
                    .query(&[
                        ("id", eq(id)),
                        ("worker", eq(worker)),
                        ("status", eq("running")),
                        ("select", "id".to_owned()),
                    ])
                    .header("prefer", "return=representation")
                    .json(&body),
            )
            .await?;
        Ok(!rows.is_empty())
    }

    async fn register_device(&self, user_id: &str, kind: DeviceKind, name: &str) -> Result<Device> {
        self.first(
            self.rest(Method::POST, "cloud_devices")
                .header("prefer", "return=representation")
                .json(&json!({ "user_id": user_id, "kind": kind, "name": name, "last_seen_at": "now" })),
        )
        .await?
        .ok_or_else(|| Error::Backend("insert returned no row".into()))
    }

    async fn device(&self, user_id: &str, id: &str) -> Result<Option<Device>> {
        // Looking a device up is what a bridge does on every poll, so it doubles as last seen.
        self.first(
            self.rest(Method::PATCH, "cloud_devices")
                .query(&[("id", eq(id)), ("user_id", eq(user_id))])
                .header("prefer", "return=representation")
                .json(&json!({ "last_seen_at": "now" })),
        )
        .await
    }

    async fn set_device_printers(
        &self,
        user_id: &str,
        device_id: &str,
        printers: &[LinkPrinter],
    ) -> Result<Vec<SyncPrinter>> {
        if !printers.is_empty() {
            let rows: Vec<Value> = printers
                .iter()
                .map(|p| {
                    json!({
                        "user_id": user_id,
                        "device_id": device_id,
                        "local_id": p.local_id,
                        "name": p.name,
                        "driver": p.driver,
                        "model": p.model,
                        "deleted": false,
                        "updated_by": device_id,
                    })
                })
                .collect();
            let res = self
                .rest(Method::POST, "sync_printers")
                .query(&[("on_conflict", "device_id,local_id")])
                .header("prefer", "resolution=merge-duplicates,return=minimal")
                .json(&rows)
                .send()
                .await?;
            check(res).await?;
        }
        let keep = printers
            .iter()
            .map(|p| quoted(&p.local_id))
            .collect::<Vec<_>>()
            .join(",");
        let mut q = vec![
            ("user_id", eq(user_id)),
            ("device_id", eq(device_id)),
            ("deleted", eq("false")),
        ];
        if !keep.is_empty() {
            q.push(("local_id", format!("not.in.({keep})")));
        }
        let res = self
            .rest(Method::PATCH, "sync_printers")
            .query(&q)
            .header("prefer", "return=minimal")
            .json(&json!({ "deleted": true, "updated_by": device_id }))
            .send()
            .await?;
        check(res).await?;
        self.rows(
            self.rest(Method::GET, "sync_printers")
                .query(&[("user_id", eq(user_id)), ("device_id", eq(device_id))]),
        )
        .await
    }

    async fn open_deliveries(&self, user_id: &str, device_id: &str) -> Result<Vec<Delivery>> {
        self.deliveries(&[
            ("user_id", eq(user_id)),
            ("device_id", eq(device_id)),
            ("state", format!("in.{OPEN_STATES}")),
            ("expires_at", "gt.now".to_owned()),
            ("order", "created_at".to_owned()),
        ])
        .await
    }

    async fn purge_due_accounts(&self) -> Result<Vec<String>> {
        let res = self
            .rest(Method::POST, "rpc/purge_due_accounts")
            .json(&json!({}))
            .send()
            .await?;
        let ids: Option<Vec<String>> = check(res).await?.json().await?;
        Ok(ids.unwrap_or_default())
    }

    async fn delete_user_files(&self, user_id: &str) -> Result<usize> {
        let mut deleted = 0;
        for bucket in [Bucket::Inputs, Bucket::Results] {
            // Storage lists one folder level at a time: inputs are <user>/<sha>,
            // results are <user>/<job>/<file>.
            let mut paths = Vec::new();
            let mut folders = vec![user_id.to_owned()];
            while let Some(dir) = folders.pop() {
                let found: Vec<Value> = self
                    .rows(
                        self.req(Method::POST, &format!("/storage/v1/object/list/{}", bucket.id()))
                            .json(&json!({ "prefix": dir, "limit": 1000 })),
                    )
                    .await?;
                for o in found {
                    let Some(name) = o.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let path = format!("{dir}/{name}");
                    // Folders come back without an id.
                    if o.get("id").is_some_and(|v| !v.is_null()) {
                        paths.push(path);
                    } else {
                        folders.push(path);
                    }
                }
            }
            for chunk in paths.chunks(500) {
                let res = self
                    .req(Method::DELETE, &format!("/storage/v1/object/{}", bucket.id()))
                    .json(&json!({ "prefixes": chunk }))
                    .send()
                    .await?;
                check(res).await?;
                deleted += chunk.len();
            }
        }
        Ok(deleted)
    }

    async fn expire_cloud_files(&self, days: u32) -> Result<usize> {
        #[derive(Deserialize)]
        struct Expired {
            bucket: String,
            path: String,
        }
        let mut deleted = 0;
        // Batches of 500 until nothing is left, so a backlog clears in one
        // pass; at most 20 batches, in case storage keeps refusing a file.
        for _ in 0..20 {
            let rows: Vec<Expired> = self
                .rows(
                    self.rest(Method::POST, "rpc/expire_cloud_files")
                        .json(&json!({ "p_days": days, "p_limit": 500 })),
                )
                .await?;
            if rows.is_empty() {
                return Ok(deleted);
            }
            for bucket in [Bucket::Inputs, Bucket::Results] {
                let paths: Vec<&str> = rows
                    .iter()
                    .filter(|r| r.bucket == bucket.id())
                    .map(|r| r.path.as_str())
                    .collect();
                if paths.is_empty() {
                    continue;
                }
                let res = self
                    .req(Method::DELETE, &format!("/storage/v1/object/{}", bucket.id()))
                    .json(&json!({ "prefixes": paths }))
                    .send()
                    .await?;
                check(res).await?;
                deleted += paths.len();
            }
            if rows.len() < 500 {
                break;
            }
        }
        Ok(deleted)
    }

    async fn delivery(&self, user_id: &str, device_id: &str, id: &str) -> Result<Option<Delivery>> {
        Ok(self
            .deliveries(&[
                ("id", eq(id)),
                ("user_id", eq(user_id)),
                ("device_id", eq(device_id)),
            ])
            .await?
            .into_iter()
            .next())
    }

    async fn set_delivery_state(
        &self,
        user_id: &str,
        device_id: &str,
        id: &str,
        state: DeliveryState,
        message: Option<&str>,
    ) -> Result<Option<Delivery>> {
        let filter = [
            ("id", eq(id)),
            ("user_id", eq(user_id)),
            ("device_id", eq(device_id)),
        ];
        let res = self
            .rest(Method::PATCH, "cloud_deliveries")
            .query(&filter)
            .header("prefer", "return=minimal")
            .json(&json!({ "state": state, "message": message }))
            .send()
            .await?;
        match check(res).await {
            Ok(_) => {}
            Err(Error::BadRequest(m)) => return Err(Error::Conflict(m)),
            Err(e) => return Err(e),
        }
        Ok(self.deliveries(&filter).await?.into_iter().next())
    }
}

#[cfg(test)]
mod tests {
    use super::{SupabaseBackend, is_secret_key, quoted};

    #[test]
    fn secret_keys_go_on_the_apikey_header_only() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let jwt = "eyJhbGciOiJIUzI1NiJ9.e30.x";
        assert!(is_secret_key("sb_secret_abc"));
        assert!(!is_secret_key(jwt));
        for (key, bearer) in [("sb_secret_abc", false), (jwt, true)] {
            let b = SupabaseBackend::new("https://example.supabase.co", key).unwrap();
            let req = b.req(reqwest::Method::GET, "/rest/v1/x").build().unwrap();
            assert_eq!(req.headers().get("apikey").unwrap(), key);
            assert_eq!(req.headers().contains_key("authorization"), bearer, "{key}");
        }
    }

    #[test]
    fn quotes_in_list_values() {
        assert_eq!(quoted("bay-1"), "\"bay-1\"");
        assert_eq!(quoted("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }
}
