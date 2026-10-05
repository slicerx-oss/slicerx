// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The library scan worker against a local or LAN Supabase stack and a real
//! clamd. Skipped unless `SLICERX_SUPABASE_URL` (loopback or a private
//! address), `SX_CLOUD_SERVICE_KEY` and `SX_CLAMD_ADDR` are set. It makes a
//! throwaway member with a creator page, a listing and two versions (a clean
//! STL and a 3MF that holds the EICAR test string), runs the worker on each
//! and checks the rows and the files, then deletes the user (which cascades)
//! and the files. It needs the `finish_scan` that takes `p_storage_path` and
//! `p_format` (`supabase/migrations/0002_store.sql`).

use std::fmt::Write as _;
use std::io::{Cursor, Read, Write};
use std::sync::Arc;

use serde_json::{Value, json};
use sx_cloud::backend::{Backend, Bucket};
use sx_cloud::scan_worker::{self, Processed};
use sx_cloud::{SupabaseBackend, sha256_hex};
use sx_upload_scan::{Clamd, ClamdAddr, HashBlocklist, Limits, Scanner};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

fn stack() -> Option<(String, String, String)> {
    let url = std::env::var("SLICERX_SUPABASE_URL")
        .or_else(|_| std::env::var("SX_CLOUD_SUPABASE_URL"))
        .ok()?;
    let key = std::env::var("SX_CLOUD_SERVICE_KEY").ok()?;
    let clamd = std::env::var("SX_CLAMD_ADDR").ok()?;
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
    private.then_some((url, key, clamd))
}

fn eicar() -> Vec<u8> {
    [
        "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
        "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!",
        "$H+H*",
    ]
    .concat()
    .into_bytes()
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut b)
        .unwrap();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = b.iter().fold(String::with_capacity(32), |mut h, x| {
        let _ = write!(h, "{x:02x}");
        h
    });
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
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
    let t: [[usize; 3]; 12] = [
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
    for tri in t {
        out.extend_from_slice(&[0u8; 12]);
        for i in tri {
            for c in v[i] {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    out
}

/// A 3MF-shaped zip with the EICAR string stored (not deflated) in a note.
fn eicar_3mf() -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (n, d) in [
        (
            "[Content_Types].xml",
            b"<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>".to_vec(),
        ),
        ("3D/3dmodel.model", b"<model/>".to_vec()),
        ("Metadata/notes.txt", eicar()),
    ] {
        w.start_file(n, stored).unwrap();
        w.write_all(&d).unwrap();
    }
    w.finish().unwrap().into_inner()
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

    async fn ok(&self, rb: reqwest::RequestBuilder) -> Value {
        let res = rb.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        assert!(status.is_success(), "{status} {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    async fn insert(&self, table: &str, row: Value) -> Value {
        let v = self
            .ok(self
                .req(reqwest::Method::POST, &format!("/rest/v1/{table}"))
                .header("prefer", "return=representation")
                .json(&row))
            .await;
        v[0].clone()
    }

    async fn version(&self, id: &str) -> Value {
        let v = self
            .ok(self.req(
                reqwest::Method::GET,
                &format!("/rest/v1/listing_versions?id=eq.{id}&select=scan_status,review_status,storage_path,format,sha256,size_bytes,scan_report"),
            ))
            .await;
        v[0].clone()
    }

    async fn files(&self, id: &str) -> Vec<Value> {
        self.ok(self.req(
            reqwest::Method::GET,
            &format!("/rest/v1/listing_files?version_id=eq.{id}&select=name,role,format,size_bytes,sha256&order=name"),
        ))
        .await
        .as_array()
        .cloned()
        .unwrap_or_default()
    }

    async fn queue_version(
        &self,
        backend: &SupabaseBackend,
        listing: &str,
        name: &str,
        bytes: &[u8],
    ) -> String {
        let id = uuid();
        let path = format!("{listing}/{id}/{name}");
        let format = name.rsplit('.').next().unwrap();
        self.insert(
            "listing_versions",
            json!({ "id": id, "listing_id": listing, "version": "1.0.0", "storage_path": path,
                    "sha256": sha256_hex(bytes), "format": format, "size_bytes": bytes.len() }),
        )
        .await;
        backend
            .put_object(
                Bucket::Quarantine,
                &path,
                bytes.to_vec(),
                "application/octet-stream",
            )
            .await
            .unwrap();
        self.ok(self
            .req(
                reqwest::Method::PATCH,
                &format!("/rest/v1/listing_versions?id=eq.{id}"),
            )
            .json(&json!({ "scan_status": "queued" })))
            .await;
        id
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // One end to end scenario against the local stack, read top to bottom.
async fn scans_library_uploads_on_the_stack() {
    let Some((url, key, clamd)) = stack() else {
        eprintln!("no local stack or clamd configured; skipping");
        return;
    };
    let _ = rustls::crypto::ring::default_provider().install_default();
    let admin = Arc::new(Admin {
        http: reqwest::Client::new(),
        url: url.clone(),
        key: key.clone(),
    });
    let backend = Arc::new(SupabaseBackend::with_user_agent(&url, &key, "sx-cloud scan test").unwrap());
    let scanner = Scanner::new(
        Limits::default(),
        Arc::new(HashBlocklist::default()),
        Arc::new(Clamd::new(ClamdAddr::parse(&clamd).unwrap())),
    );

    let suffix = uuid()[..8].to_owned();
    let user: Value = admin
        .ok(admin
            .req(reqwest::Method::POST, "/auth/v1/admin/users")
            .json(&json!({ "email": format!("scan-e2e-{suffix}@example.test"), "email_confirm": true })))
        .await;
    let user_id = user["id"].as_str().unwrap().to_owned();
    let cleanup: Arc<std::sync::Mutex<Vec<(Bucket, String)>>> = Arc::default();

    // The checks run in a task so a failed assertion still cleans up.
    let task = tokio::spawn({
        let (admin, backend, cleanup, user_id) =
            (admin.clone(), backend.clone(), cleanup.clone(), user_id.clone());
        async move {
            let (admin, backend) = (admin.as_ref(), backend.as_ref());
            let creator = admin
            .insert(
                "creators",
                json!({ "owner_id": user_id, "handle": format!("scan-e2e-{suffix}"), "display_name": "Scan E2E" }),
            )
            .await;
            let listing = admin
            .insert(
                "listings",
                json!({ "creator_id": creator["id"], "slug": format!("scan-e2e-{suffix}"), "title": "Scan test owl" }),
            )
            .await;
            let listing_id = listing["id"].as_str().unwrap().to_owned();

            // A clean STL.
            let good = admin
                .queue_version(backend, &listing_id, "owl.stl", &cube_stl())
                .await;
            let job = backend
                .claim_scan("scan-e2e")
                .await
                .unwrap()
                .expect("a queued version");
            assert_eq!(
                job.version_id, good,
                "the queue held someone else's version first"
            );
            assert_eq!(job.title, "Scan test owl");
            assert_eq!(job.creator_handle, format!("scan-e2e-{suffix}"));
            assert_eq!(job.creator_name, "Scan E2E");
            assert_eq!(job.version, "1.0.0");
            cleanup
                .lock()
                .unwrap()
                .push((Bucket::Quarantine, job.storage_path.clone()));
            let done = scan_worker::process(backend, &scanner, &job).await.unwrap();
            assert_eq!(done, Processed::Clean);
            let row = admin.version(&good).await;
            assert_eq!(row["scan_status"], "clean", "{row}");
            assert_eq!(row["review_status"], "pending", "the scan never approves");
            assert_eq!(row["format"], "sx3mf");
            assert_eq!(row["storage_path"], format!("{listing_id}/{good}/owl.sx3mf"));
            assert_eq!(row["scan_report"]["verdict"], "clean");
            assert_eq!(row["scan_report"]["scanner"]["engine"], "clamav");
            assert!(
                row["scan_report"]["scanner"]["signatureVersion"]
                    .as_str()
                    .unwrap()
                    .starts_with("ClamAV")
            );
            let files = admin.files(&good).await;
            assert_eq!(files.len(), 2, "{files:?}");
            assert_eq!(
                (files[0]["name"].as_str(), files[0]["role"].as_str()),
                (Some("owl.sx3mf"), Some("model"))
            );
            assert_eq!(
                (files[1]["name"].as_str(), files[1]["role"].as_str()),
                (Some("preview.png"), Some("image"))
            );
            let stored = format!("{listing_id}/{good}/owl.sx3mf");
            cleanup.lock().unwrap().push((Bucket::Library, stored.clone()));
            cleanup
                .lock()
                .unwrap()
                .push((Bucket::Library, format!("{listing_id}/{good}/preview.png")));
            let file = backend
                .get_object(Bucket::Library, &stored)
                .await
                .unwrap()
                .expect("library file");
            assert_eq!(row["sha256"], sha256_hex(&file));
            let meta = sx3mf::inspect(&file).unwrap().metadata;
            assert_eq!(meta.creator.as_deref(), Some(job.creator_id.as_str()));
            assert!(
                !backend
                    .object_exists(Bucket::Quarantine, &job.storage_path)
                    .await
                    .unwrap()
            );

            // A 3MF with the EICAR string in it.
            let bad = admin
                .queue_version(backend, &listing_id, "bad.3mf", &eicar_3mf())
                .await;
            let job = backend
                .claim_scan("scan-e2e")
                .await
                .unwrap()
                .expect("a queued version");
            assert_eq!(job.version_id, bad);
            cleanup
                .lock()
                .unwrap()
                .push((Bucket::Quarantine, job.storage_path.clone()));
            let done = scan_worker::process(backend, &scanner, &job).await.unwrap();
            assert_eq!(done, Processed::Rejected);
            let row = admin.version(&bad).await;
            assert_eq!(row["scan_status"], "rejected", "{row}");
            assert_eq!(row["review_status"], "rejected");
            assert_eq!(row["scan_report"]["reasonCodes"][0], "malware");
            assert!(
                row["scan_report"]["scanner"]["signature"]
                    .as_str()
                    .unwrap()
                    .contains("Eicar")
            );
            assert!(admin.files(&bad).await.is_empty());
            assert!(
                !backend
                    .object_exists(Bucket::Quarantine, &job.storage_path)
                    .await
                    .unwrap()
            );
            assert!(
                !backend
                    .object_exists(Bucket::Library, &format!("{listing_id}/{bad}/bad.sx3mf"))
                    .await
                    .unwrap()
            );
        }
    });
    let outcome = task.await;
    let files = cleanup.lock().unwrap().clone();
    admin.remove_user(&user_id, &files).await;
    if let Err(e) = outcome {
        std::panic::resume_unwind(e.into_panic());
    }
}

impl Admin {
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
