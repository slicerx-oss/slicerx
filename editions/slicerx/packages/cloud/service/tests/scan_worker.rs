// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The library scan worker on the in-memory backend: quarantine in,
//! `listing-files` out, and the result recorded the way `finish_scan` takes it.

use std::io::{Cursor, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use sx_cloud::MemoryBackend;
use sx_cloud::backend::{Backend, Bucket, ScanJob};
use sx_cloud::scan_worker::{self, Processed, ScanWorkerConfig};
use sx_upload_scan::{AntiVirus, AvError, AvVerdict, HashBlocklist, Limits, Scanner};
use tokio::sync::watch;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

const LISTING: &str = "11111111-1111-4111-8111-111111111111";
const VERSION: &str = "22222222-2222-4222-8222-222222222222";

/// EICAR, split so this file is not flagged.
fn eicar() -> Vec<u8> {
    [
        "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
        "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!",
        "$H+H*",
    ]
    .concat()
    .into_bytes()
}

struct Av {
    down: AtomicBool,
}

#[async_trait]
impl AntiVirus for Av {
    fn engine(&self) -> &'static str {
        "test"
    }
    async fn scan(&self, bytes: &[u8]) -> Result<AvVerdict, AvError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(AvError("down".into()));
        }
        let e = eicar();
        Ok(if bytes.windows(e.len()).any(|w| w == e) {
            AvVerdict::Infected("Eicar-Test-Signature".into())
        } else {
            AvVerdict::Clean
        })
    }
    async fn version(&self) -> Option<String> {
        None
    }
}

struct Rig {
    backend: Arc<MemoryBackend>,
    av: Arc<Av>,
    scanner: Scanner,
}

fn rig() -> Rig {
    let av = Arc::new(Av {
        down: AtomicBool::new(false),
    });
    Rig {
        backend: Arc::new(MemoryBackend::new()),
        scanner: Scanner::new(Limits::default(), Arc::new(HashBlocklist::default()), av.clone()),
        av,
    }
}

fn cube_stl(header: &[u8]) -> Vec<u8> {
    let v = [
        [0.0, 0.0, 0.0],
        [10.0, 0.0, 0.0],
        [10.0, 10.0, 0.0],
        [0.0, 10.0, 0.0],
        [0.0, 0.0, 10.0],
        [10.0, 0.0, 10.0],
        [10.0, 10.0, 10.0],
        [0.0, 10.0, 10.0f32],
    ];
    let t = [
        [2, 1, 0],
        [3, 2, 0],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [1, 2, 6],
        [1, 6, 5],
        [2, 3, 7],
        [2, 7, 6],
        [3, 0, 4],
        [3, 4, 7usize],
    ];
    let mut out = vec![0u8; 80];
    out[..header.len()].copy_from_slice(header);
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

fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for (n, d) in entries {
        w.start_file(*n, SimpleFileOptions::default()).unwrap();
        w.write_all(d).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn job(name: &str) -> ScanJob {
    ScanJob {
        version_id: VERSION.into(),
        listing_id: LISTING.into(),
        storage_path: format!("{LISTING}/{VERSION}/{name}"),
        version: "1.0.0".into(),
        title: "Desk owl".into(),
        slug: "desk-owl".into(),
        creator_id: "crt_riverbend".into(),
        creator_handle: "riverbend".into(),
        creator_name: "Riverbend Studio".into(),
    }
}

impl Rig {
    fn queue(&self, name: &str, bytes: &[u8]) -> ScanJob {
        let j = job(name);
        self.backend.put_file(Bucket::Quarantine, &j.storage_path, bytes);
        self.backend.queue_scan(j.clone());
        j
    }

    async fn tick(&self) -> Option<Processed> {
        let j = self.backend.claim_scan("test").await.unwrap()?;
        Some(
            scan_worker::process(self.backend.as_ref(), &self.scanner, &j)
                .await
                .unwrap(),
        )
    }
}

#[tokio::test]
async fn a_clean_stl_is_converted_and_stored() {
    let r = rig();
    r.queue("owl.stl", &cube_stl(b"owl"));
    assert_eq!(r.tick().await, Some(Processed::Clean));

    let stored = format!("{LISTING}/{VERSION}/owl.sx3mf");
    assert_eq!(
        r.backend.paths(Bucket::Library),
        vec![stored.clone(), format!("{LISTING}/{VERSION}/preview.png")]
    );
    assert!(
        r.backend.paths(Bucket::Quarantine).is_empty(),
        "the raw upload is deleted"
    );
    assert_eq!(r.backend.scan_status(VERSION), Some("clean"));

    let done = r.backend.scan_result(VERSION).unwrap();
    assert!(done.ok);
    assert_eq!(done.storage_path.as_deref(), Some(stored.as_str()));
    assert_eq!(done.format.as_deref(), Some("sx3mf"));
    let file = r
        .backend
        .get_object(Bucket::Library, &stored)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(done.sha256.as_deref(), Some(sx_cloud::sha256_hex(&file).as_str()));
    assert_eq!(done.size_bytes, Some(i64::try_from(file.len()).unwrap()));
    assert_eq!(done.parts.len(), 2);
    assert_eq!(done.parts[0]["role"], "model");
    assert_eq!(done.parts[0]["name"], "owl.sx3mf");
    assert_eq!(done.parts[0]["format"], "sx3mf");
    assert_eq!(done.parts[1]["name"], "preview.png");
    assert_eq!(done.parts[1]["role"], "image");
    assert_eq!(done.report["verdict"], "clean");
    assert_eq!(done.report["triangleCount"], 12);
    assert_eq!(done.report["detectedType"], "stl");

    let info = sx3mf::inspect(&file).unwrap().metadata;
    assert_eq!(info.listing.as_deref(), Some(LISTING));
    assert_eq!(info.version_id.as_deref(), Some(VERSION));
    assert_eq!(info.creator.as_deref(), Some("crt_riverbend"));
    assert_eq!(info.version.as_deref(), Some("1.0.0"));
}

#[tokio::test]
async fn a_3mf_keeps_its_stripped_list_in_the_report() {
    let r = rig();
    let model = "<?xml version=\"1.0\"?><model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources><object id=\"1\" type=\"model\"><mesh><vertices><vertex x=\"0\" y=\"0\" z=\"0\"/><vertex x=\"5\" y=\"0\" z=\"0\"/><vertex x=\"0\" y=\"5\" z=\"0\"/><vertex x=\"0\" y=\"0\" z=\"5\"/></vertices><triangles><triangle v1=\"0\" v2=\"2\" v3=\"1\"/><triangle v1=\"0\" v2=\"1\" v3=\"3\"/><triangle v1=\"1\" v2=\"2\" v3=\"3\"/><triangle v1=\"2\" v2=\"0\" v3=\"3\"/></triangles></mesh></object></resources><build><item objectid=\"1\"/></build></model>";
    let types = "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/></Types>";
    let rels = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"r\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\" Target=\"/3D/3dmodel.model\"/></Relationships>";
    let bytes = zip(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
        ("Metadata/plate_1.gcode", b"M104 S300\n"),
    ]);
    r.queue("tetra.3mf", &bytes);
    assert_eq!(r.tick().await, Some(Processed::Clean));
    let done = r.backend.scan_result(VERSION).unwrap();
    assert_eq!(done.report["detectedType"], "3mf");
    assert!(
        done.report["stripped"][0]
            .as_str()
            .unwrap()
            .contains("plate_1.gcode")
    );
    assert_eq!(done.parts[0]["name"], "tetra.sx3mf");
}

#[tokio::test]
async fn a_flagged_file_is_rejected_and_never_reaches_listing_files() {
    let r = rig();
    r.queue("bad.stl", &cube_stl(&eicar()));
    assert_eq!(r.tick().await, Some(Processed::Rejected));
    assert!(r.backend.paths(Bucket::Library).is_empty());
    assert!(
        r.backend.paths(Bucket::Quarantine).is_empty(),
        "quarantine is emptied"
    );
    assert_eq!(r.backend.scan_status(VERSION), Some("rejected"));
    let done = r.backend.scan_result(VERSION).unwrap();
    assert!(!done.ok);
    assert_eq!(done.report["verdict"], "rejected");
    assert_eq!(done.report["reasonCodes"][0], "malware");
    assert_eq!(done.report["scanner"]["result"], "infected");
    assert!(done.report["reason"].as_str().unwrap().contains("malware"));
    assert!(done.parts.is_empty() && done.storage_path.is_none());
}

#[tokio::test]
async fn hostile_shapes_are_rejected_with_a_reason() {
    for (name, bytes, code) in [
        ("prog.stl", b"MZ\x90\x00 not a model".to_vec(), "forbidden_type"),
        ("notes.3mf", b"just text".to_vec(), "unsupported_type"),
        ("empty.stl", Vec::new(), "empty_file"),
    ] {
        let r = rig();
        r.queue(name, &bytes);
        assert_eq!(r.tick().await, Some(Processed::Rejected), "{name}");
        let done = r.backend.scan_result(VERSION).unwrap();
        assert_eq!(done.report["reasonCodes"][0], code, "{name}");
        assert!(r.backend.paths(Bucket::Library).is_empty());
    }
}

#[tokio::test]
async fn a_missing_file_is_rejected() {
    let r = rig();
    r.backend.queue_scan(job("gone.stl"));
    assert_eq!(r.tick().await, Some(Processed::Rejected));
    let done = r.backend.scan_result(VERSION).unwrap();
    assert_eq!(done.report["reasonCodes"][0], "missing_file");
}

#[tokio::test]
async fn a_down_scanner_leaves_the_version_claimed_and_unapproved() {
    let r = rig();
    r.queue("owl.stl", &cube_stl(b"owl"));
    r.av.down.store(true, Ordering::SeqCst);
    assert_eq!(r.tick().await, Some(Processed::Unavailable));
    assert_eq!(r.backend.scan_status(VERSION), Some("scanning"));
    assert!(r.backend.scan_result(VERSION).is_none());
    assert!(r.backend.paths(Bucket::Library).is_empty());
    assert_eq!(
        r.backend.paths(Bucket::Quarantine).len(),
        1,
        "the upload is kept for the retry"
    );
    assert_eq!(r.tick().await, None, "a claimed version is not offered again");

    // The stale claim goes back to the queue, and the scanner is back.
    assert_eq!(r.backend.requeue_stale_scans().await.unwrap(), 1);
    r.av.down.store(false, Ordering::SeqCst);
    assert_eq!(r.tick().await, Some(Processed::Clean));
}

#[tokio::test]
async fn a_released_claim_is_offered_again_at_once() {
    let r = rig();
    r.queue("owl.stl", &cube_stl(b"owl"));
    let j = r.backend.claim_scan("test").await.unwrap().unwrap();
    assert_eq!(r.backend.scan_status(VERSION), Some("scanning"));
    r.backend.release_scan(&j.version_id, "test").await.unwrap();
    assert_eq!(r.backend.scan_status(VERSION), Some("queued"));
    assert_eq!(r.tick().await, Some(Processed::Clean));
}

#[tokio::test]
async fn an_upload_that_always_fails_is_rejected_on_the_third_attempt() {
    let r = rig();
    r.queue("owl.stl", &cube_stl(b"owl"));
    r.backend.fail_library_writes(true);
    let (stop_tx, stop_rx) = watch::channel(false);
    let cfg = ScanWorkerConfig {
        idle_poll: Duration::from_millis(5),
        unavailable_backoff: Duration::from_millis(5),
        ..ScanWorkerConfig::new("t")
    };
    let task = tokio::spawn(scan_worker::run(
        r.backend.clone(),
        r.scanner.clone(),
        cfg,
        stop_rx,
    ));
    for _ in 0..200 {
        if r.backend.scan_status(VERSION) == Some("rejected") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Give a looping worker the chance to claim it again before checking it did not.
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.backend.scan_status(VERSION), Some("rejected"));
    assert_eq!(r.backend.scan_attempts(VERSION), Some(2));
    let done = r.backend.scan_result(VERSION).unwrap();
    assert!(!done.ok);
    let reason = done.report["reason"].as_str().unwrap();
    assert!(
        reason.starts_with("The scanner could not check this file:"),
        "{reason}"
    );
    assert!(r.backend.paths(Bucket::Library).is_empty());
}

#[tokio::test]
async fn long_names_stay_within_the_path_limit() {
    let r = rig();
    let long = format!("{}.stl", "a".repeat(196));
    r.queue(&long, &cube_stl(b"x"));
    assert_eq!(r.tick().await, Some(Processed::Clean));
    let done = r.backend.scan_result(VERSION).unwrap();
    let path = done.storage_path.unwrap();
    let name = path.rsplit('/').next().unwrap();
    assert!(
        name.len() <= 200 && name.rsplit('.').next() == Some("sx3mf"),
        "{}",
        name.len()
    );
}

#[tokio::test]
async fn the_loop_drains_the_queue_and_stops() {
    let r = rig();
    r.queue("owl.stl", &cube_stl(b"owl"));
    let (stop_tx, stop_rx) = watch::channel(false);
    let cfg = ScanWorkerConfig {
        idle_poll: Duration::from_millis(20),
        ..ScanWorkerConfig::new("t")
    };
    let task = tokio::spawn(scan_worker::run(
        r.backend.clone(),
        r.scanner.clone(),
        cfg,
        stop_rx,
    ));
    for _ in 0..200 {
        if r.backend.scan_status(VERSION) == Some("clean") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(r.backend.scan_status(VERSION), Some("clean"));
    stop_tx.send(true).unwrap();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
}
