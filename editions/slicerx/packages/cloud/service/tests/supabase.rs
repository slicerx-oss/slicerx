// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The service end to end on a local or LAN Supabase stack. Skipped unless
//! `SLICERX_SUPABASE_URL` (loopback or a private address) and
//! `SX_CLOUD_SERVICE_KEY` are set. It creates a throwaway user and API token,
//! runs a job with a target printer through the delivery states, and deletes
//! the user and its files at the end.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sx_cloud::backend::{Backend, Bucket};
use sx_cloud::{App, SupabaseBackend, WorkerConfig, router, sha256_hex, worker};
use tower::ServiceExt;

fn stack() -> Option<(String, String)> {
    let url = std::env::var("SLICERX_SUPABASE_URL")
        .or_else(|_| std::env::var("SX_CLOUD_SUPABASE_URL"))
        .ok()?;
    let key = std::env::var("SX_CLOUD_SERVICE_KEY").ok()?;
    let host = url.strip_prefix("http://")?.split(':').next()?.to_owned();
    let private = host == "127.0.0.1"
        || host == "localhost"
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || (host.starts_with("172.")
            && host
                .split('.')
                .nth(1)
                .and_then(|o| o.parse::<u8>().ok())
                .is_some_and(|o| (16..=31).contains(&o)));
    private.then_some((url, key))
}

struct Admin {
    http: reqwest::Client,
    url: String,
    key: String,
}

impl Admin {
    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.url))
            .header("apikey", &self.key)
            .bearer_auth(&self.key)
    }

    async fn create_user(&self, email: &str) -> String {
        let res: Value = self
            .req(reqwest::Method::POST, "/auth/v1/admin/users")
            .json(&json!({ "email": email, "email_confirm": true }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        res["id"].as_str().expect("user id").to_owned()
    }

    async fn create_token(&self, user_id: &str, token: &str, scopes: &[&str]) {
        let res = self
            .req(reqwest::Method::POST, "/rest/v1/api_tokens")
            .json(&json!({
                "user_id": user_id,
                "name": "cloud test",
                "prefix": &token[..12],
                "token_hash": sha256_hex(token.as_bytes()),
                "scopes": scopes,
            }))
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{}", res.text().await.unwrap());
    }

    /// Invites the account to cloud slicing with the default limits.
    async fn grant_access(&self, email: &str) {
        let res = self
            .req(reqwest::Method::POST, "/rest/v1/rpc/grant_cloud_access")
            .json(&json!({ "p_email": email }))
            .send()
            .await
            .unwrap();
        assert!(res.status().is_success(), "{}", res.text().await.unwrap());
    }

    async fn remove_user(&self, user_id: &str, files: &[(Bucket, String)]) {
        for (bucket, path) in files {
            let _ = self
                .req(
                    reqwest::Method::DELETE,
                    &format!("/storage/v1/object/{}", bucket.id()),
                )
                .json(&json!({ "prefixes": [path] }))
                .send()
                .await;
        }
        let _ = self
            .req(
                reqwest::Method::DELETE,
                &format!("/auth/v1/admin/users/{user_id}"),
            )
            .send()
            .await;
    }
}

fn cube_stl() -> Vec<u8> {
    let s = 20.0_f32;
    let v = [
        [0.0, 0.0, 0.0],
        [s, 0.0, 0.0],
        [s, s, 0.0],
        [0.0, s, 0.0],
        [0.0, 0.0, s],
        [s, 0.0, s],
        [s, s, s],
        [0.0, s, s],
    ];
    let tris: [[usize; 3]; 12] = [
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
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&12u32.to_le_bytes());
    for t in tris {
        out.extend_from_slice(&[0u8; 12]);
        for i in t {
            for c in v[i] {
                out.extend_from_slice(&f32::to_le_bytes(c));
            }
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    out
}

async fn call(
    app: &axum::Router,
    method: Method,
    uri: &str,
    token: &str,
    body: Body,
) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    (
        status,
        res.into_body().collect().await.unwrap().to_bytes().to_vec(),
    )
}

async fn call_json(
    app: &axum::Router,
    method: Method,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let body = body.map_or_else(Body::empty, |v| Body::from(v.to_string()));
    let (s, b) = call(app, method, uri, token, body).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one job walked from upload to printing")]
async fn slices_and_delivers_on_the_stack() {
    let Some((url, key)) = stack() else {
        eprintln!("skipped: set SLICERX_SUPABASE_URL and SX_CLOUD_SERVICE_KEY for a local stack");
        return;
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let admin = Admin {
        http: reqwest::Client::new(),
        url: url.clone(),
        key: key.clone(),
    };
    let run = format!("{:08x}", std::process::id());
    let email = format!("cloud-test-{run}@example.com");
    let user = admin.create_user(&email).await;
    let token = format!("sxk_{}", sha256_hex(run.as_bytes()));
    let read_only = format!("sxk_{}", sha256_hex(format!("{run}-read").as_bytes()));
    admin.create_token(&user, &token, &["cloud_slice", "link"]).await;
    admin.create_token(&user, &read_only, &["read"]).await;

    let backend = Arc::new(SupabaseBackend::new(&url, &key).unwrap());
    let cleaner = backend.clone();
    let app = router(Arc::new(App {
        backend: backend.clone(),
        poll_step: Duration::from_millis(200),
        about: sx_cloud::http::About::default(),
        trust_forwarded: false,
    }));
    let files = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (tracked, user_id) = (files.clone(), user.clone());

    // Cloud slicing is invite only.
    let (s, body) = call_json(&app, Method::GET, "/v1/jobs", &token, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "not invited yet");
    assert_eq!(body["error"]["code"], "not_invited");
    admin.grant_access(&email).await;
    let (s, body) = call_json(&app, Method::GET, "/v1/access", &token, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["invited"], true);

    let outcome = async move {
        let user = user_id;
        let (s, _) = call_json(&app, Method::GET, "/v1/jobs", &read_only, None).await;
        assert_eq!(s, StatusCode::FORBIDDEN);
        let (s, _) = call_json(&app, Method::GET, "/v1/jobs", "sxk_not_a_token", None).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);

        let stl = cube_stl();
        let sha = sha256_hex(&stl);
        tracked
            .lock()
            .unwrap()
            .push((Bucket::Inputs, format!("{user}/{sha}")));
        let (s, _) = call(
            &app,
            Method::PUT,
            &format!("/v1/meshes/{sha}"),
            &token,
            Body::from(stl),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED);
        let (s, _) = call_json(&app, Method::GET, &format!("/v1/meshes/{sha}"), &token, None).await;
        assert_eq!(s, StatusCode::OK);

        let (s, device) = call_json(
            &app,
            Method::POST,
            "/v1/devices",
            &token,
            Some(json!({ "name": "Test bridge", "kind": "link" })),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED, "{device}");
        let device = device["id"].as_str().unwrap().to_owned();
        let (s, printers) = call_json(
            &app,
            Method::PUT,
            &format!("/v1/devices/{device}/printers"),
            &token,
            Some(json!([{ "localId": "bay-1", "name": "Bay 1", "driver": "moonraker" }])),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{printers}");
        let printer = printers[0]["id"].as_str().unwrap().to_owned();

        let request = json!({
            "schemaVersion": 1,
            "plate": { "objects": [{ "id": "cube", "mesh": sha }] },
            "config": { "layer_height": 0.2 },
        });
        let (s, job) = call_json(
            &app,
            Method::POST,
            "/v1/jobs",
            &token,
            Some(json!({ "name": "Stack cube", "request": request, "targetPrinterId": printer })),
        )
        .await;
        assert_eq!(s, StatusCode::ACCEPTED, "{job}");
        let job_id = job["id"].as_str().unwrap().to_owned();
        let (gcode_path, preview_path) = sx_cloud::backend::result_paths(&user, &job_id);
        tracked
            .lock()
            .unwrap()
            .extend([(Bucket::Results, gcode_path), (Bucket::Results, preview_path)]);

        let cfg = WorkerConfig {
            id: format!("test-{run}"),
            idle_poll: Duration::from_millis(100),
            heartbeat: Duration::from_secs(5),
        };
        // Other jobs may be queued on a shared stack; run claims until ours is done.
        for _ in 0..20 {
            let Some(claimed) = backend.claim_job(&cfg.id).await.unwrap() else {
                break;
            };
            let mine = claimed.id == job_id;
            worker::process(backend.as_ref(), &cfg, claimed).await.unwrap();
            if mine {
                break;
            }
        }
        let (_, job) = call_json(&app, Method::GET, &format!("/v1/jobs/{job_id}"), &token, None).await;
        assert_eq!(job["status"], "succeeded", "{job}");
        assert_eq!(job["result"]["layerCount"], 100);

        let (s, gcode) = call(
            &app,
            Method::GET,
            &format!("/v1/jobs/{job_id}/gcode"),
            &token,
            Body::empty(),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(sha256_hex(&gcode), job["result"]["gcodeSha256"].as_str().unwrap());

        let (_, open) = call_json(
            &app,
            Method::GET,
            &format!("/v1/devices/{device}/deliveries?wait=5"),
            &token,
            None,
        )
        .await;
        let d = &open[0];
        assert_eq!(d["state"], "offered", "{open}");
        assert_eq!(d["printerLocalId"], "bay-1");
        assert_eq!(d["sha256"], job["result"]["gcodeSha256"]);
        let uri = format!(
            "/v1/devices/{device}/deliveries/{}/state",
            d["id"].as_str().unwrap()
        );
        let (s, _) = call_json(
            &app,
            Method::POST,
            &uri,
            &token,
            Some(json!({ "state": "approved" })),
        )
        .await;
        assert_eq!(s, StatusCode::CONFLICT, "the database refuses to skip approval");
        for next in [
            "downloaded",
            "awaiting_approval",
            "approved",
            "uploaded",
            "printing",
        ] {
            let (s, body) = call_json(&app, Method::POST, &uri, &token, Some(json!({ "state": next }))).await;
            assert_eq!(s, StatusCode::OK, "{next}: {body}");
            assert_eq!(body["state"], next);
        }

        let (_, cancel) = call_json(
            &app,
            Method::POST,
            &format!("/v1/jobs/{job_id}/cancel"),
            &token,
            None,
        )
        .await;
        assert_eq!(cancel["error"]["code"], "conflict", "{cancel}");
    };
    // Clean up even when an assertion fails.
    let result = tokio::spawn(outcome).await;
    // The purge path deletes the files; the admin calls are the fallback.
    let deleted = cleaner.delete_user_files(&user).await;
    let files = files.lock().unwrap().clone();
    admin.remove_user(&user, &files).await;
    if let Err(e) = result {
        std::panic::resume_unwind(e.into_panic());
    }
    assert_eq!(deleted.unwrap(), 3, "the mesh, the G-code and the preview");
}
