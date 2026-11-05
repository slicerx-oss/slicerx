// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Partner app tokens on the in-memory backend: an `sxk_` token a person
//! issued to a named partner app, with the `cloud_slice` scope only. It
//! slices on the person's account and daily limits, sees only the jobs it
//! queued, never names a printer, and stops working once revoked.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sx_cloud::backend::Backend;
use sx_cloud::http::About;
use sx_cloud::{App, MemoryBackend, WorkerConfig, router, sha256_hex, worker};
use tower::ServiceExt;

const RV: &str = "00000000-0000-4000-8000-0000000000a1";
const ASH: &str = "00000000-0000-4000-8000-0000000000a2";
/// rv's own token, made for the person's tools.
const RV_TOKEN: &str = "sxk_rv_cloud";
/// rv's token for a partner phone app.
const RV_PARTNER: &str = "sxk_rv_partner";
/// A second partner app on rv's account.
const RV_OTHER_PARTNER: &str = "sxk_rv_other_partner";
const ASH_PARTNER: &str = "sxk_ash_partner";
const MB: u64 = 1024 * 1024;

struct Harness {
    backend: Arc<MemoryBackend>,
    app: Router,
}

fn harness() -> Harness {
    let backend = Arc::new(MemoryBackend::new());
    backend.add_token(RV_TOKEN, RV, &["cloud_slice", "link"]);
    backend.add_partner_token(RV_PARTNER, RV, "Example Phone");
    backend.add_partner_token(RV_OTHER_PARTNER, RV, "Other App");
    backend.add_partner_token(ASH_PARTNER, ASH, "Example Phone");
    backend.add_session("session-rv", RV);
    backend.grant_access(RV, 3, 50 * MB);
    backend.grant_access(ASH, 1000, 50 * MB);
    let app = router(Arc::new(App {
        backend: backend.clone(),
        poll_step: Duration::from_millis(20),
        about: About {
            name: "Example Slicer".into(),
            version: "0.1.0".into(),
            source_url: None,
        },
        trust_forwarded: false,
    }));
    Harness { backend, app }
}

impl Harness {
    async fn call(
        &self,
        method: Method,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Vec<u8>) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let body = match body {
            Some(v) => {
                req = req.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let res = self.app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let status = res.status();
        (
            status,
            res.into_body().collect().await.unwrap().to_bytes().to_vec(),
        )
    }

    async fn json(&self, method: Method, uri: &str, token: &str, body: Option<Value>) -> (StatusCode, Value) {
        let (s, b) = self.call(method, uri, token, body).await;
        (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    async fn upload(&self, token: &str, bytes: &[u8]) -> String {
        let sha = sha256_hex(bytes);
        let req = Request::builder()
            .method(Method::PUT)
            .uri(format!("/v1/meshes/{sha}"))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        sha
    }

    async fn queue(&self, token: &str, sha: &str, name: &str) -> String {
        let (s, job) = self
            .json(
                Method::POST,
                "/v1/jobs",
                token,
                Some(json!({ "name": name, "request": plate(sha) })),
            )
            .await;
        assert_eq!(s, StatusCode::ACCEPTED, "{job}");
        job["id"].as_str().unwrap().to_owned()
    }

    async fn work(&self) {
        let cfg = WorkerConfig {
            id: "test-worker".into(),
            idle_poll: Duration::from_millis(10),
            heartbeat: Duration::from_secs(5),
        };
        let job = self
            .backend
            .claim_job(&cfg.id)
            .await
            .unwrap()
            .expect("a queued job");
        worker::process(self.backend.as_ref(), &cfg, job).await.unwrap();
    }
}

/// A 10 mm cube as binary STL.
fn cube_stl() -> Vec<u8> {
    let s = 10.0f32;
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

fn plate(sha: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "plate": { "objects": [{ "id": "cube", "name": "Cube", "mesh": sha }] },
        "config": { "layer_height": 0.2 },
    })
}

#[tokio::test]
async fn access_names_the_partner_app_and_the_account_limits() {
    let h = harness();
    let (s, a) = h.json(Method::GET, "/v1/access", RV_PARTNER, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(a["invited"], true);
    assert_eq!(a["jobsPerDay"], 3, "the person's own daily limit");
    assert_eq!(a["partnerApp"], "Example Phone");
    let (_, own) = h.json(Method::GET, "/v1/access", RV_TOKEN, None).await;
    assert!(
        own.get("partnerApp").is_none(),
        "the person's own token is not a partner token: {own}"
    );
}

#[tokio::test]
async fn a_partner_token_slices_on_the_account_and_downloads_its_result() {
    let h = harness();
    let sha = h.upload(RV_PARTNER, &cube_stl()).await;
    let id = h.queue(RV_PARTNER, &sha, "From the phone").await;
    h.work().await;
    let (s, job) = h
        .json(Method::GET, &format!("/v1/jobs/{id}"), RV_PARTNER, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(job["status"], "succeeded", "{job}");
    assert!(
        job.get("tokenId").is_none() && job.get("token_id").is_none(),
        "token ids stay inside the service: {job}"
    );
    let (s, gcode) = h
        .call(Method::GET, &format!("/v1/jobs/{id}/gcode"), RV_PARTNER, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(sha256_hex(&gcode), job["result"]["gcodeSha256"].as_str().unwrap());
    // The person sees the partner's job with their own token and session: it is their account.
    let (s, _) = h
        .json(Method::GET, &format!("/v1/jobs/{id}"), RV_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = h
        .json(Method::GET, &format!("/v1/jobs/{id}"), "session-rv", None)
        .await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn a_partner_token_sees_only_the_jobs_it_queued() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, &cube_stl()).await;
    let mine = h.queue(RV_TOKEN, &sha, "Desk job").await;
    let partner = h.queue(RV_PARTNER, &sha, "Phone job").await;
    let other = h.queue(RV_OTHER_PARTNER, &sha, "Other app job").await;

    let (s, list) = h.json(Method::GET, "/v1/jobs", RV_PARTNER, None).await;
    assert_eq!(s, StatusCode::OK);
    let ids: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![partner.as_str()],
        "only its own job, not the person's or another app's"
    );
    let (_, all) = h.json(Method::GET, "/v1/jobs", RV_TOKEN, None).await;
    assert_eq!(
        all.as_array().unwrap().len(),
        3,
        "the person's own token sees every job"
    );

    for id in [&mine, &other] {
        for path in [
            format!("/v1/jobs/{id}"),
            format!("/v1/jobs/{id}/gcode"),
            format!("/v1/jobs/{id}/preview"),
        ] {
            let (s, _) = h.call(Method::GET, &path, RV_PARTNER, None).await;
            assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
        }
        let (s, _) = h
            .call(Method::POST, &format!("/v1/jobs/{id}/cancel"), RV_PARTNER, None)
            .await;
        assert_eq!(
            s,
            StatusCode::NOT_FOUND,
            "a partner cannot cancel a job it did not queue"
        );
    }
    let (_, job) = h
        .json(Method::GET, &format!("/v1/jobs/{mine}"), RV_TOKEN, None)
        .await;
    assert_eq!(job["status"], "queued", "the person's job was left alone");
    let (s, job) = h
        .json(
            Method::POST,
            &format!("/v1/jobs/{partner}/cancel"),
            RV_PARTNER,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(job["status"], "canceled");
}

#[tokio::test]
async fn partner_jobs_count_against_the_account_daily_limit() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, &cube_stl()).await;
    h.queue(RV_TOKEN, &sha, "one").await;
    h.queue(RV_PARTNER, &sha, "two").await;
    h.queue(RV_OTHER_PARTNER, &sha, "three").await;
    let (s, err) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_PARTNER,
            Some(json!({ "request": plate(&sha) })),
        )
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS, "{err}");
    assert_eq!(err["error"]["code"], "limit");
    let (_, a) = h.json(Method::GET, "/v1/access", RV_PARTNER, None).await;
    assert_eq!(a["jobsToday"], 3);
}

#[tokio::test]
async fn a_partner_token_never_sends_a_job_to_a_printer() {
    let h = harness();
    let sha = h.upload(RV_PARTNER, &cube_stl()).await;
    let (s, err) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_PARTNER,
            Some(
                json!({ "request": plate(&sha), "targetPrinterId": "00000000-0000-4000-8000-00000000ffff" }),
            ),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "{err}");
    assert_eq!(err["error"]["code"], "forbidden");
    let (_, list) = h.json(Method::GET, "/v1/jobs", RV_TOKEN, None).await;
    assert!(list.as_array().unwrap().is_empty(), "nothing was queued");
}

#[tokio::test]
async fn a_partner_token_has_no_bridge_routes() {
    let h = harness();
    let (s, err) = h
        .json(
            Method::POST,
            "/v1/devices",
            RV_PARTNER,
            Some(json!({ "name": "Phone", "kind": "mobile" })),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(err["error"]["code"], "forbidden");
}

#[tokio::test]
async fn a_revoked_partner_token_stops_at_once_and_others_keep_working() {
    let h = harness();
    let sha = h.upload(RV_PARTNER, &cube_stl()).await;
    let id = h.queue(RV_PARTNER, &sha, "Phone job").await;
    h.backend.revoke_token(RV_PARTNER);
    for (m, path) in [
        (Method::GET, "/v1/access".to_owned()),
        (Method::GET, "/v1/jobs".to_owned()),
        (Method::GET, format!("/v1/jobs/{id}")),
        (Method::GET, format!("/v1/meshes/{sha}")),
    ] {
        let (s, err) = h.json(m, &path, RV_PARTNER, None).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(err["error"]["code"], "unauthorized");
    }
    let (s, _) = h.json(Method::GET, "/v1/access", RV_OTHER_PARTNER, None).await;
    assert_eq!(s, StatusCode::OK, "another partner app keeps its token");
    let (s, _) = h.json(Method::GET, "/v1/access", ASH_PARTNER, None).await;
    assert_eq!(
        s,
        StatusCode::OK,
        "the same app on another account keeps its token"
    );
    let (s, job) = h
        .json(Method::GET, &format!("/v1/jobs/{id}"), RV_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::OK, "the job stays on the person's account");
    assert_eq!(job["status"], "queued");
}

#[tokio::test]
async fn a_partner_token_in_the_query_string_is_not_read() {
    let h = harness();
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/v1/access?token={RV_PARTNER}&access_token={RV_PARTNER}"))
        .body(Body::empty())
        .unwrap();
    let res = h.app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        res.status(),
        StatusCode::UNAUTHORIZED,
        "only the Authorization header carries a token"
    );
}
