// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The HTTP API and the worker end to end, on the in-memory backend.

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
const RV_TOKEN: &str = "sxk_rv_cloud";
const ASH_TOKEN: &str = "sxk_ash_cloud";
const RV_LINK: &str = "sxk_rv_link";
const ASH_LINK: &str = "sxk_ash_link";
const READ_TOKEN: &str = "sxk_rv_read_only";
const CY: &str = "00000000-0000-4000-8000-0000000000a3";
const CY_TOKEN: &str = "sxk_cy_cloud";
const CY_LINK: &str = "sxk_cy_link";
const MB: u64 = 1024 * 1024;

struct Harness {
    backend: Arc<MemoryBackend>,
    app: Router,
}

fn harness() -> Harness {
    let backend = Arc::new(MemoryBackend::new());
    backend.add_token(RV_TOKEN, RV, &["cloud_slice", "mcp"]);
    backend.add_token(ASH_TOKEN, ASH, &["cloud_slice"]);
    backend.add_token(RV_LINK, RV, &["link"]);
    backend.add_token(ASH_LINK, ASH, &["link"]);
    backend.add_token(READ_TOKEN, RV, &["read"]);
    backend.add_session("session-rv", RV);
    // Cloud slicing is invite only; rv and ash are invited, cy is not.
    backend.grant_access(RV, 1000, 50 * MB);
    backend.grant_access(ASH, 1000, 50 * MB);
    backend.add_token(CY_TOKEN, CY, &["cloud_slice"]);
    backend.add_token(CY_LINK, CY, &["link"]);
    let app = router(Arc::new(App {
        backend: backend.clone(),
        poll_step: Duration::from_millis(20),
        about: About {
            name: "Example Slicer".into(),
            version: "0.1.0".into(),
            source_url: Some("https://example.com/source".into()),
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
        token: Option<&str>,
        body: Option<Body>,
    ) -> (StatusCode, Vec<u8>) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                b
            }
            None => Body::empty(),
        };
        let res = self.app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        (status, bytes)
    }

    async fn json(&self, method: Method, uri: &str, token: &str, body: Option<Value>) -> (StatusCode, Value) {
        let (s, b) = self
            .call(method, uri, Some(token), body.map(|v| Body::from(v.to_string())))
            .await;
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

    /// Claims and runs the next job the way a worker does.
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

/// A 20 mm cube as binary STL.
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

fn plate(sha: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "plate": { "objects": [{ "id": "cube", "name": "Cube", "mesh": sha }] },
        "config": { "layer_height": 0.2 },
    })
}

#[tokio::test]
async fn refuses_missing_and_wrong_tokens() {
    let h = harness();
    let (s, _) = h.call(Method::GET, "/v1/jobs", None, None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = h.json(Method::GET, "/v1/jobs", "sxk_unknown", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, body) = h.json(Method::GET, "/v1/jobs", READ_TOKEN, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "forbidden");
    let (s, _) = h.json(Method::GET, "/v1/jobs", "session-rv", None).await;
    assert_eq!(s, StatusCode::OK, "a signed-in session works without a token");
    let (s, _) = h.json(Method::GET, "/v1/jobs", "session-expired", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, body) = h.json(Method::GET, "/v1/jobs", RV_LINK, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "a link token cannot run jobs");
    assert!(body["error"]["message"].as_str().unwrap().contains("cloud_slice"));
    let (s, _) = h
        .json(
            Method::POST,
            "/v1/devices",
            RV_TOKEN,
            Some(json!({ "name": "x", "kind": "link" })),
        )
        .await;
    assert_eq!(
        s,
        StatusCode::FORBIDDEN,
        "a cloud_slice token cannot act as a bridge"
    );
    let (s, about) = h.call(Method::GET, "/v1/about", None, None).await;
    assert_eq!(s, StatusCode::OK);
    let about: Value = serde_json::from_slice(&about).unwrap();
    assert_eq!(about["sourceUrl"], "https://example.com/source");
    let (s, _) = h.call(Method::GET, "/healthz", None, None).await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn only_invited_accounts_can_slice() {
    let h = harness();
    let stl = cube_stl();
    let sha = sha256_hex(&stl);
    let (s, body) = h.json(Method::GET, "/v1/access", CY_TOKEN, None).await;
    assert_eq!(
        s,
        StatusCode::OK,
        "anyone signed in can ask whether they are invited"
    );
    assert_eq!(body, json!({ "invited": false }));
    let (s, _) = h.json(Method::GET, "/v1/access", CY_LINK, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "a link token has no cloud_slice scope");

    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/v1/meshes/{sha}"))
        .header("authorization", format!("Bearer {CY_TOKEN}"))
        .body(Body::from(stl.clone()))
        .unwrap();
    let res = h.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "no upload without an invite");
    for (method, uri, token, body) in [
        (Method::GET, format!("/v1/meshes/{sha}"), CY_TOKEN, None),
        (
            Method::POST,
            "/v1/jobs".to_owned(),
            CY_TOKEN,
            Some(json!({ "request": plate(&sha) })),
        ),
        (Method::GET, "/v1/jobs".to_owned(), CY_TOKEN, None),
        (Method::GET, format!("/v1/jobs/{RV}/gcode"), CY_TOKEN, None),
        (
            Method::POST,
            "/v1/devices".to_owned(),
            CY_LINK,
            Some(json!({ "name": "x", "kind": "link" })),
        ),
    ] {
        let (s, body) = h.json(method, &uri, token, body).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{uri}");
        assert_eq!(body["error"]["code"], "not_invited", "{uri}");
    }

    // Invited with tight limits: 1 MB uploads and two jobs a day.
    h.backend.grant_access(CY, 2, MB);
    let (s, body) = h.json(Method::GET, "/v1/access", CY_TOKEN, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "invited": true, "jobsPerDay": 2, "jobsToday": 0, "maxUploadBytes": MB })
    );
    let big = vec![7u8; usize::try_from(MB).unwrap() + 1];
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/v1/meshes/{}", sha256_hex(&big)))
        .header("authorization", format!("Bearer {CY_TOKEN}"))
        .body(Body::from(big))
        .unwrap();
    let res = h.app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        res.status(),
        StatusCode::PAYLOAD_TOO_LARGE,
        "uploads over the account limit are refused"
    );
    h.upload(CY_TOKEN, &stl).await;
    for _ in 0..2 {
        let (s, _) = h
            .json(
                Method::POST,
                "/v1/jobs",
                CY_TOKEN,
                Some(json!({ "request": plate(&sha) })),
            )
            .await;
        assert_eq!(s, StatusCode::ACCEPTED);
    }
    let (s, body) = h
        .json(
            Method::POST,
            "/v1/jobs",
            CY_TOKEN,
            Some(json!({ "request": plate(&sha) })),
        )
        .await;
    assert_eq!(
        s,
        StatusCode::TOO_MANY_REQUESTS,
        "the third job in a day is refused"
    );
    assert_eq!(body["error"]["code"], "limit");
    let (_, body) = h.json(Method::GET, "/v1/access", CY_TOKEN, None).await;
    assert_eq!(body["jobsToday"], 2);

    // Revoked: the jobs and their results are out of reach.
    h.backend.revoke_access(CY);
    let (s, body) = h.json(Method::GET, "/v1/jobs", CY_TOKEN, None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "not_invited");
}

#[tokio::test]
async fn uploads_are_checked_against_their_hash() {
    let h = harness();
    let stl = cube_stl();
    let wrong = "0".repeat(64);
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/v1/meshes/{wrong}"))
        .header("authorization", format!("Bearer {RV_TOKEN}"))
        .body(Body::from(stl.clone()))
        .unwrap();
    let res = h.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    let sha = h.upload(RV_TOKEN, &stl).await;
    let (s, _) = h
        .json(Method::GET, &format!("/v1/meshes/{sha}"), RV_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = h
        .json(Method::GET, &format!("/v1/meshes/{sha}"), ASH_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "uploads are per member");
}

#[tokio::test]
async fn rejects_requests_the_worker_cannot_run() {
    let h = harness();
    let sha = sha256_hex(&cube_stl());
    let (s, body) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": plate(&sha) })),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("has not been uploaded")
    );

    let mut with_paths = plate("cube");
    with_paths["meshes"] = json!({ "cube": "/etc/passwd" });
    let (s, _) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": with_paths })),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "file paths are never accepted");

    let (s, _) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": plate("../cube.stl") })),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let mut v2 = plate(&sha);
    v2["schemaVersion"] = json!(2);
    let (s, _) = h
        .json(Method::POST, "/v1/jobs", RV_TOKEN, Some(json!({ "request": v2 })))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let (s, _) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": plate(&sha), "extra": 1 })),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn slices_a_plate_and_stores_the_result() {
    let h = harness();
    let stl = cube_stl();
    let sha = h.upload(RV_TOKEN, &stl).await;
    let (s, job) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "name": "Cube", "request": plate(&sha) })),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(job["status"], "queued");
    let id = job["id"].as_str().unwrap().to_owned();

    h.work().await;

    let (s, job) = h
        .json(Method::GET, &format!("/v1/jobs/{id}"), RV_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(job["status"], "succeeded", "{job}");
    assert_eq!(job["progress"], 1.0);
    let result = &job["result"];
    assert_eq!(result["schemaVersion"], 1);
    assert_eq!(result["layerCount"], 100, "a 20 mm cube at 0.2 mm");
    assert_eq!(job["gcodeUrl"], format!("/v1/jobs/{id}/gcode"));

    let (s, gcode) = h
        .call(Method::GET, &format!("/v1/jobs/{id}/gcode"), Some(RV_TOKEN), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(sha256_hex(&gcode), result["gcodeSha256"].as_str().unwrap());
    let (s, preview) = h
        .call(
            Method::GET,
            &format!("/v1/jobs/{id}/preview"),
            Some(RV_TOKEN),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(&preview[..4], b"SXPV");

    let (s, _) = h
        .json(Method::GET, &format!("/v1/jobs/{id}"), ASH_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "another member cannot see the job");
    let (s, _) = h
        .call(
            Method::GET,
            &format!("/v1/jobs/{id}/gcode"),
            Some(ASH_TOKEN),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let (_, list) = h.json(Method::GET, "/v1/jobs", RV_TOKEN, None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_bad_mesh_fails_the_job_with_a_reason() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, b"solid nothing here").await;
    let (_, job) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": plate(&sha) })),
        )
        .await;
    let id = job["id"].as_str().unwrap().to_owned();
    h.work().await;
    let (_, job) = h
        .json(Method::GET, &format!("/v1/jobs/{id}"), RV_TOKEN, None)
        .await;
    assert_eq!(job["status"], "failed");
    assert!(!job["error"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn cancel_and_active_limit() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, &cube_stl()).await;
    let mut ids = Vec::new();
    for _ in 0..5 {
        let (s, job) = h
            .json(
                Method::POST,
                "/v1/jobs",
                RV_TOKEN,
                Some(json!({ "request": plate(&sha) })),
            )
            .await;
        assert_eq!(s, StatusCode::ACCEPTED);
        ids.push(job["id"].as_str().unwrap().to_owned());
    }
    let (s, body) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": plate(&sha) })),
        )
        .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "limit");

    let (s, _) = h
        .json(
            Method::POST,
            &format!("/v1/jobs/{}/cancel", ids[0]),
            ASH_TOKEN,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, job) = h
        .json(
            Method::POST,
            &format!("/v1/jobs/{}/cancel", ids[0]),
            RV_TOKEN,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(job["status"], "canceled");
    let (s, _) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": plate(&sha) })),
        )
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "canceling frees a slot");

    // A job canceled while running keeps its canceled state when the worker finishes.
    let job = h.backend.claim_job("w").await.unwrap().unwrap();
    assert!(h.backend.cancel_job(RV, &job.id).await.unwrap());
    let cfg = WorkerConfig {
        id: "w".into(),
        idle_poll: Duration::from_millis(10),
        heartbeat: Duration::from_secs(5),
    };
    worker::process(h.backend.as_ref(), &cfg, job.clone())
        .await
        .unwrap();
    let after = h.backend.job(RV, &job.id).await.unwrap().unwrap();
    assert_eq!(serde_json::to_value(after.status).unwrap(), "canceled");
    assert!(after.gcode_path.is_none());
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one delivery walked through every state")]
async fn delivers_to_a_bridge_printer_only_through_approval_states() {
    let h = harness();
    let (s, device) = h
        .json(
            Method::POST,
            "/v1/devices",
            RV_LINK,
            Some(json!({ "name": "Workshop bridge", "kind": "link" })),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let device = device["id"].as_str().unwrap().to_owned();

    let (s, printers) = h
        .json(
            Method::PUT,
            &format!("/v1/devices/{device}/printers"),
            RV_LINK,
            Some(json!([
                { "localId": "bay-1", "name": "Bay 1", "driver": "moonraker", "model": "Example Core XY" },
                { "localId": "bay-2", "name": "Bay 2" },
            ])),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let bay1 = printers
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["localId"] == "bay-1")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (s, _) = h
        .json(
            Method::PUT,
            &format!("/v1/devices/{device}/printers"),
            ASH_LINK,
            Some(json!([])),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "another member cannot touch the bridge");
    let (s, _) = h
        .json(
            Method::PUT,
            &format!("/v1/devices/{device}/printers"),
            RV_LINK,
            Some(json!([{ "localId": "bay 1; drop", "name": "x" }])),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let sha = h.upload(RV_TOKEN, &cube_stl()).await;
    let unbridged = h.backend.add_unbridged_printer(RV, "Shelf printer");
    let (s, _) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "request": plate(&sha), "targetPrinterId": unbridged })),
        )
        .await;
    assert_eq!(
        s,
        StatusCode::BAD_REQUEST,
        "a target must be reachable through a bridge"
    );
    let (s, _) = h
        .json(
            Method::POST,
            "/v1/jobs",
            ASH_TOKEN,
            Some(
                json!({ "request": plate(&h.upload(ASH_TOKEN, &cube_stl()).await), "targetPrinterId": bay1 }),
            ),
        )
        .await;
    assert_eq!(
        s,
        StatusCode::BAD_REQUEST,
        "a member cannot target another member's printer"
    );

    let (_, job) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({ "name": "Bracket", "request": plate(&sha), "targetPrinterId": bay1 })),
        )
        .await;
    let job_id = job["id"].as_str().unwrap().to_owned();

    let (s, open) = h
        .json(
            Method::GET,
            &format!("/v1/devices/{device}/deliveries?wait=1"),
            RV_LINK,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(open, json!([]), "nothing is offered before the job finishes");

    h.work().await;
    let (_, open) = h
        .json(
            Method::GET,
            &format!("/v1/devices/{device}/deliveries?wait=5"),
            RV_LINK,
            None,
        )
        .await;
    let d = &open[0];
    assert_eq!(d["state"], "offered");
    assert_eq!(d["jobId"], job_id);
    assert_eq!(d["printerLocalId"], "bay-1");
    assert_eq!(d["fileName"], "Bracket.gcode");
    assert_eq!(
        d["gcodePath"],
        format!(
            "/v1/devices/{device}/deliveries/{}/gcode",
            d["id"].as_str().unwrap()
        )
    );
    let (_, gcode) = h
        .call(Method::GET, d["gcodePath"].as_str().unwrap(), Some(RV_LINK), None)
        .await;
    assert_eq!(sha256_hex(&gcode), d["sha256"].as_str().unwrap());
    assert_eq!(d["bytes"].as_u64().unwrap(), gcode.len() as u64);
    let delivery = d["id"].as_str().unwrap().to_owned();
    let state_uri = format!("/v1/devices/{device}/deliveries/{delivery}/state");

    for skip in ["approved", "uploaded", "printing"] {
        let (s, _) = h
            .json(Method::POST, &state_uri, RV_LINK, Some(json!({ "state": skip })))
            .await;
        assert_eq!(s, StatusCode::CONFLICT, "offered cannot jump to {skip}");
    }
    let (s, _) = h
        .json(
            Method::POST,
            &state_uri,
            RV_LINK,
            Some(json!({ "state": "offered" })),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = h
        .json(
            Method::POST,
            &state_uri,
            ASH_LINK,
            Some(json!({ "state": "downloaded" })),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    for next in [
        "downloaded",
        "awaiting_approval",
        "approved",
        "uploaded",
        "printing",
    ] {
        let (s, body) = h
            .json(Method::POST, &state_uri, RV_LINK, Some(json!({ "state": next })))
            .await;
        assert_eq!(s, StatusCode::OK, "{next}: {body}");
        assert_eq!(body["state"], next);
    }
    let (_, open) = h
        .json(
            Method::GET,
            &format!("/v1/devices/{device}/deliveries"),
            RV_LINK,
            None,
        )
        .await;
    assert_eq!(open, json!([]), "a printing delivery is no longer open");

    // Dropping a printer from the bridge's list marks it deleted.
    let (_, printers) = h
        .json(
            Method::PUT,
            &format!("/v1/devices/{device}/printers"),
            RV_LINK,
            Some(json!([{ "localId": "bay-1", "name": "Bay 1" }])),
        )
        .await;
    let bay2 = printers
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["localId"] == "bay-2")
        .unwrap();
    assert_eq!(bay2["deleted"], true);
}

#[tokio::test]
async fn a_token_over_its_limit_gets_429_with_retry_after() {
    let h = harness();
    h.backend.limit_token(RV_TOKEN, 1);
    let (s, _) = h.json(Method::GET, "/v1/jobs", RV_TOKEN, None).await;
    assert_eq!(s, StatusCode::OK);
    let req = Request::builder()
        .uri("/v1/jobs")
        .header("authorization", format!("Bearer {RV_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let res = h.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.headers()["retry-after"], "42");
    let (s, _) = h.json(Method::GET, "/v1/jobs", "session-rv", None).await;
    assert_eq!(s, StatusCode::OK, "sessions are not token limited");
}

#[tokio::test]
async fn purging_an_account_removes_its_files_only() {
    use sx_cloud::backend::Bucket;
    let h = harness();
    h.backend
        .put_file(Bucket::Inputs, &format!("{RV}/{}", "a".repeat(64)), b"mesh");
    h.backend
        .put_file(Bucket::Results, &format!("{RV}/job/slice.gcode"), b"G28");
    h.backend
        .put_file(Bucket::Results, &format!("{ASH}/job/slice.gcode"), b"G28");
    h.backend.schedule_purge(RV);
    assert_eq!(worker::purge_once(h.backend.as_ref()).await.unwrap(), 1);
    assert!(h.backend.paths(Bucket::Inputs).is_empty());
    assert_eq!(
        h.backend.paths(Bucket::Results),
        vec![format!("{ASH}/job/slice.gcode")]
    );
    assert_eq!(worker::purge_once(h.backend.as_ref()).await.unwrap(), 0);
}

#[test]
fn plate_progress_reaches_the_end_with_the_real_slicer() {
    use sx_cloud::worker::PlateProgress;
    let stl = cube_stl();
    let mesh = Arc::new(sx_core::api::load_mesh(&stl, "cube.stl").unwrap());
    let mut req = plate("cube");
    req["options"] = json!({ "shards": 3 });
    let req: sx_core::api::SliceRequest = serde_json::from_value(req).unwrap();
    let progress = PlateProgress::new(3, true);
    let run = sx_core::api::run_request_with(&req, &|_| Ok(mesh.clone()), &progress).unwrap();
    assert_eq!(run.report.layer_count, 100);
    assert!(
        (progress.fraction() - 1.0).abs() < 1e-6,
        "{}",
        progress.fraction()
    );
}
