// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A whole 3MF project in the cloud, on the in-memory backend: its build items slice as objects of their own, a job
//! that names its plates (`options.plates`) slices only those, each with its own result and files, and every plate
//! counts against the account's daily slices.

use std::fmt::Write as _;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sx_cloud::backend::{Backend, Bucket};
use sx_cloud::http::About;
use sx_cloud::{App, MemoryBackend, WorkerConfig, router, sha256_hex, worker};
use tower::ServiceExt;

const RV: &str = "00000000-0000-4000-8000-0000000000a1";
const RV_TOKEN: &str = "sxk_rv_cloud";
const DEE: &str = "00000000-0000-4000-8000-0000000000a4";
const DEE_TOKEN: &str = "sxk_dee_cloud";
const MB: u64 = 1024 * 1024;

struct Harness {
    backend: Arc<MemoryBackend>,
    app: Router,
}

fn harness() -> Harness {
    let backend = Arc::new(MemoryBackend::new());
    backend.add_token(RV_TOKEN, RV, &["cloud_slice"]);
    backend.grant_access(RV, 1000, 50 * MB);
    // dee has five slices a day, for the daily limit.
    backend.add_token(DEE_TOKEN, DEE, &["cloud_slice"]);
    backend.grant_access(DEE, 5, 50 * MB);
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
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
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
        assert_eq!(
            self.app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::CREATED
        );
        sha
    }

    /// Queues `request` and answers the job's id, or the refusal.
    async fn queue(&self, token: &str, request: Value) -> Result<String, (StatusCode, Value)> {
        let (s, job) = self
            .json(
                Method::POST,
                "/v1/jobs",
                token,
                Some(json!({ "name": "Lantern", "request": request })),
            )
            .await;
        if s == StatusCode::ACCEPTED {
            Ok(job["id"].as_str().unwrap().to_owned())
        } else {
            Err((s, job))
        }
    }

    /// Claims and runs the next job the way a worker does, then reads it back.
    async fn work(&self, token: &str, id: &str) -> Value {
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
        let (s, job) = self
            .json(Method::GET, &format!("/v1/jobs/{id}"), token, None)
            .await;
        assert_eq!(s, StatusCode::OK);
        job
    }
}

/// A 20 mm cube as 3MF mesh XML.
fn cube_mesh() -> String {
    let v = [
        [0, 0, 0],
        [20, 0, 0],
        [20, 20, 0],
        [0, 20, 0],
        [0, 0, 20],
        [20, 0, 20],
        [20, 20, 20],
        [0, 20, 20],
    ];
    let t = [
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
    let mut s = String::from("<mesh><vertices>");
    for [x, y, z] in v {
        let _ = write!(s, r#"<vertex x="{x}" y="{y}" z="{z}"/>"#);
    }
    s.push_str("</vertices><triangles>");
    for [a, b, c] in t {
        let _ = write!(s, r#"<triangle v1="{a}" v2="{b}" v3="{c}"/>"#);
    }
    s.push_str("</triangles></mesh>");
    s
}

/// A project of `plates` plates (each a list of object ids, objects numbered from 1), every object a 20 mm cube.
fn project(plates: &[&[u32]]) -> Vec<u8> {
    let mesh = cube_mesh();
    let (mut objects, mut build, mut settings) = (String::new(), String::new(), String::from("<config>"));
    for (p, ids) in plates.iter().enumerate() {
        let _ = write!(
            settings,
            r#"<plate><metadata key="plater_id" value="{}"/>"#,
            p + 1
        );
        for &id in *ids {
            let _ = write!(
                objects,
                r#"<object id="{id}" name="Cube {id}" type="model">{mesh}</object>"#
            );
            let _ = write!(
                build,
                r#"<item objectid="{id}" transform="1 0 0 0 1 0 0 0 1 {} 100 0"/>"#,
                40 * id
            );
            let _ = write!(
                settings,
                r#"<model_instance><metadata key="object_id" value="{id}"/></model_instance>"#
            );
        }
        settings.push_str("</plate>");
    }
    settings.push_str("</config>");
    let model = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>{objects}</resources><build>{build}</build></model>"#
    );
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, text) in [
        ("3D/3dmodel.model", model),
        ("Metadata/model_settings.config", settings),
    ] {
        zip.start_file(name, opts).unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// The two plate project of these tests: two cubes on plate 1, one on plate 2.
fn lantern() -> Vec<u8> {
    project(&[&[1, 2], &[3]])
}

fn request(sha: &str, plates: Option<Value>) -> Value {
    let mut r = json!({
        "schemaVersion": 1,
        "plate": { "objects": [{ "id": "lantern", "name": "Lantern.3mf", "mesh": sha }] },
        "config": { "layer_height": 0.2, "skirt_loops": 0, "brim_width": 0 },
        "options": { "emitPreview": true },
    });
    if let Some(p) = plates {
        r["options"]["plates"] = p;
    }
    r
}

/// How many objects a report sliced (`featureFilaments` has one entry per plate object).
fn objects(report: &Value) -> usize {
    report["featureFilaments"].as_array().map_or(0, Vec::len)
}

#[tokio::test]
async fn a_project_without_plates_slices_its_first_plate_one_object_per_item() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, &lantern()).await;
    let id = h.queue(RV_TOKEN, request(&sha, None)).await.unwrap();
    let job = h.work(RV_TOKEN, &id).await;
    assert_eq!(job["status"], "succeeded", "{job}");
    assert_eq!(job["plateCount"], 1, "a job that names no plates is one slice");
    let result = &job["result"];
    assert_eq!(
        objects(result),
        2,
        "plate 1's two cubes are two objects: {result}"
    );
    assert!(result.get("plates").is_none());
    let notes = result["projectPlates"]
        .as_array()
        .expect("the project's other plates are named");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0]["plates"], 2);
    assert_eq!(notes[0]["sliced"], 1);
    assert!(
        notes[0]["text"].as_str().unwrap().contains("options.plates"),
        "{}",
        notes[0]
    );
    let (s, gcode) = h
        .call(Method::GET, &format!("/v1/jobs/{id}/gcode"), RV_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(sha256_hex(&gcode), result["gcodeSha256"].as_str().unwrap());
    assert!(job.get("plates").is_none(), "no per-plate links without plates");
}

#[tokio::test]
async fn a_job_naming_plates_slices_only_those_each_with_its_own_files() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, &lantern()).await;
    let id = h
        .queue(RV_TOKEN, request(&sha, Some(json!([2, 1, 9]))))
        .await
        .unwrap();
    let job = h.work(RV_TOKEN, &id).await;
    assert_eq!(job["status"], "succeeded", "{job}");
    assert_eq!(job["plateCount"], 3);
    assert_eq!(job["plateIndex"], 9, "the last plate the worker took up");
    let result = &job["result"];
    let plates = result["plates"].as_array().unwrap();
    let order: Vec<(u64, &str)> = plates
        .iter()
        .map(|p| (p["plate"].as_u64().unwrap(), p["status"].as_str().unwrap()))
        .collect();
    assert_eq!(
        order,
        [(2, "succeeded"), (1, "succeeded"), (9, "failed")],
        "in the order named"
    );
    assert_eq!(objects(&plates[0]), 1, "plate 2 holds one cube");
    assert_eq!(objects(&plates[1]), 2, "plate 1 holds two");
    assert!(
        plates[2]["error"].as_str().unwrap().contains("has no plate 9"),
        "{}",
        plates[2]
    );
    // The job's own report is its first plate that sliced, and its G-code that plate's.
    assert_eq!(result["gcodeSha256"], plates[0]["gcodeSha256"]);
    assert!(
        result.get("projectPlates").is_none(),
        "plates named leave nothing unsliced to note"
    );

    let links = job["plates"].as_array().unwrap();
    assert_eq!(links.len(), 2, "links for the plates that sliced: {job}");
    for p in &plates[..2] {
        let n = p["plate"].as_u64().unwrap();
        let (s, gcode) = h
            .call(
                Method::GET,
                &format!("/v1/jobs/{id}/plates/{n}/gcode"),
                RV_TOKEN,
                None,
            )
            .await;
        assert_eq!(s, StatusCode::OK, "plate {n}");
        assert_eq!(
            sha256_hex(&gcode),
            p["gcodeSha256"].as_str().unwrap(),
            "plate {n}"
        );
        let (s, preview) = h
            .call(
                Method::GET,
                &format!("/v1/jobs/{id}/plates/{n}/preview"),
                RV_TOKEN,
                None,
            )
            .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(&preview[..4], b"SXPV");
    }
    assert_ne!(plates[0]["gcodeSha256"], plates[1]["gcodeSha256"]);
    let (s, first) = h
        .call(Method::GET, &format!("/v1/jobs/{id}/gcode"), RV_TOKEN, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(sha256_hex(&first), plates[0]["gcodeSha256"].as_str().unwrap());
    for missing in ["9", "3", "0", "x"] {
        let (s, _) = h
            .call(
                Method::GET,
                &format!("/v1/jobs/{id}/plates/{missing}/gcode"),
                RV_TOKEN,
                None,
            )
            .await;
        assert!(
            s == StatusCode::NOT_FOUND || s == StatusCode::BAD_REQUEST,
            "plate {missing}: {s}"
        );
    }
    // Only the named plates were sliced and stored: no job-wide file beside them.
    let stored = h
        .backend
        .get_object(Bucket::Results, &format!("{RV}/{id}/slice.gcode"))
        .await
        .unwrap();
    assert!(stored.is_none());
}

#[tokio::test]
async fn a_job_whose_plates_all_fail_fails_with_the_first_plates_words() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, &lantern()).await;
    let id = h
        .queue(RV_TOKEN, request(&sha, Some(json!([7, 8]))))
        .await
        .unwrap();
    let job = h.work(RV_TOKEN, &id).await;
    assert_eq!(job["status"], "failed", "{job}");
    let error = job["error"].as_str().unwrap();
    assert!(
        error.starts_with("plate 7: ") && error.contains("has no plate 7"),
        "{error}"
    );
}

#[tokio::test]
async fn plates_of_a_request_with_no_project_fail_the_job() {
    let h = harness();
    let stl = sx_cube_stl();
    let sha = h.upload(RV_TOKEN, &stl).await;
    let id = h.queue(RV_TOKEN, request(&sha, Some(json!([1])))).await.unwrap();
    let job = h.work(RV_TOKEN, &id).await;
    assert_eq!(job["status"], "failed");
    assert!(job["error"].as_str().unwrap().contains("has no project"), "{job}");
}

#[tokio::test]
async fn every_plate_counts_against_the_daily_slices() {
    let h = harness();
    let sha = h.upload(DEE_TOKEN, &lantern()).await;
    h.queue(DEE_TOKEN, request(&sha, Some(json!([1, 2, 1 + 2]))))
        .await
        .unwrap();
    let (_, access) = h.json(Method::GET, "/v1/access", DEE_TOKEN, None).await;
    assert_eq!(access["jobsToday"], 3, "three plates are three slices");
    // Three more would cross the five a day: refused before it runs, saying what is left.
    let (s, err) = h
        .queue(DEE_TOKEN, request(&sha, Some(json!([1, 2, 3]))))
        .await
        .unwrap_err();
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        err["error"]["message"],
        "this job slices 3 plates, and this account can slice 2 more plates today"
    );
    assert_eq!(
        h.backend.jobs(DEE, 10).await.unwrap().len(),
        1,
        "nothing was queued"
    );
    h.queue(DEE_TOKEN, request(&sha, Some(json!([1, 2]))))
        .await
        .unwrap();
    let (s, err) = h.queue(DEE_TOKEN, request(&sha, None)).await.unwrap_err();
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        err["error"]["message"],
        "this account has used its 5 cloud slices for the last 24 hours"
    );
}

#[tokio::test]
async fn the_memory_backend_refuses_a_job_past_the_day_as_the_database_does() {
    // The service checks first; the backend checks again for a job that slips past (two at once).
    let h = harness();
    let job = |plates: Value| sx_cloud::backend::NewJob {
        user_id: DEE.into(),
        token_id: None,
        name: "Lantern".into(),
        request: json!({ "options": { "plates": plates } }),
        target_printer_id: None,
    };
    h.backend.insert_job(job(json!([1, 2, 3, 4]))).await.unwrap();
    let err = h.backend.insert_job(job(json!([1, 2]))).await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "this job slices 2 plates, and this account can slice 1 more plate today"
    );
    h.backend.insert_job(job(json!([5]))).await.unwrap();
}

#[tokio::test]
async fn plates_are_checked_before_a_job_is_queued() {
    let h = harness();
    let sha = h.upload(RV_TOKEN, &lantern()).await;
    let many: Vec<u32> = (1..=33).collect();
    for (plates, why) in [
        (json!([]), "names 1 to 32 plates"),
        (json!(many), "names 1 to 32 plates"),
        (json!([0]), "plate numbers from 1"),
        (json!(["2"]), "plate numbers from 1"),
        (json!([1, 1]), "names plate 1 twice"),
        (json!(2), "must be a list"),
    ] {
        let (s, err) = h
            .queue(RV_TOKEN, request(&sha, Some(plates.clone())))
            .await
            .unwrap_err();
        assert_eq!(s, StatusCode::BAD_REQUEST, "{plates}");
        assert!(
            err["error"]["message"].as_str().unwrap().contains(why),
            "{plates}: {err}"
        );
    }
    let thirty_two: Vec<u32> = (1..=32).collect();
    assert!(
        h.queue(RV_TOKEN, request(&sha, Some(json!(thirty_two))))
            .await
            .is_ok(),
        "32 plates is the most"
    );
    let (s, err) = h
        .json(
            Method::POST,
            "/v1/jobs",
            RV_TOKEN,
            Some(json!({
                "request": request(&sha, Some(json!([1, 2]))),
                "targetPrinterId": "00000000-0000-4000-8000-0000000000ff",
            })),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        err["error"]["message"]
            .as_str()
            .unwrap()
            .contains("slices one plate"),
        "{err}"
    );
}

/// A 20 mm cube as binary STL.
fn sx_cube_stl() -> Vec<u8> {
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
