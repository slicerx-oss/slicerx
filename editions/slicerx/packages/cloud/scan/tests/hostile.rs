// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The pipeline against crafted hostile inputs. Every fixture is generated
//! here. The only "malware" is the EICAR test string, which every scanner
//! flags and which does nothing.
#![allow(
    clippy::format_push_string,
    clippy::type_complexity,
    clippy::cast_precision_loss,
    reason = "fixture builders"
)]

use std::io::{Cursor, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use sx_upload_scan::{
    AntiVirus, AvError, AvVerdict, Clamd, ClamdAddr, HashBlocklist, Limits, ListingMeta, ScanOutcome,
    Scanner, Upload, Verdict, sha256_hex,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// The standard EICAR antivirus test string, split so this file is not
/// flagged by the scanners it tests.
fn eicar() -> Vec<u8> {
    [
        "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
        "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!",
        "$H+H*",
    ]
    .concat()
    .into_bytes()
}

// ------------------------------------------------------------ fixtures

const CUBE_VERTS: [[f32; 3]; 8] = [
    [0.0, 0.0, 0.0],
    [10.0, 0.0, 0.0],
    [10.0, 10.0, 0.0],
    [0.0, 10.0, 0.0],
    [0.0, 0.0, 10.0],
    [10.0, 0.0, 10.0],
    [10.0, 10.0, 10.0],
    [0.0, 10.0, 10.0],
];
const CUBE_TRIS: [[u32; 3]; 12] = [
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
    [3, 4, 7],
];

fn binary_stl_with(header: &[u8], tris: &[[[f32; 3]; 3]]) -> Vec<u8> {
    let mut out = vec![0u8; 80];
    out[..header.len().min(80)].copy_from_slice(&header[..header.len().min(80)]);
    out.extend_from_slice(&u32::try_from(tris.len()).unwrap().to_le_bytes());
    for t in tris {
        out.extend_from_slice(&[0u8; 12]);
        for v in t {
            for c in v {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    out
}

fn cube_soup() -> Vec<[[f32; 3]; 3]> {
    CUBE_TRIS
        .iter()
        .map(|t| t.map(|i| CUBE_VERTS[i as usize]))
        .collect()
}

fn cube_stl() -> Vec<u8> {
    binary_stl_with(b"cube", &cube_soup())
}

fn cube_ascii_stl() -> Vec<u8> {
    let mut s = String::from("solid cube\n");
    for t in cube_soup() {
        s.push_str("  facet normal 0 0 0\n    outer loop\n");
        for v in t {
            s.push_str(&format!("      vertex {} {} {}\n", v[0], v[1], v[2]));
        }
        s.push_str("    endloop\n  endfacet\n");
    }
    s.push_str("endsolid cube\n");
    s.into_bytes()
}

fn model_xml(verts: &[[f32; 3]], tris: &[[u32; 3]]) -> String {
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model unit=\"millimeter\" \
xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources><object id=\"1\" type=\"model\"><mesh><vertices>",
    );
    for v in verts {
        s.push_str(&format!("<vertex x=\"{}\" y=\"{}\" z=\"{}\"/>", v[0], v[1], v[2]));
    }
    s.push_str("</vertices><triangles>");
    for t in tris {
        s.push_str(&format!(
            "<triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>",
            t[0], t[1], t[2]
        ));
    }
    s.push_str("</triangles></mesh></object></resources><build><item objectid=\"1\"/></build></model>");
    s
}

fn cube_model() -> String {
    model_xml(&CUBE_VERTS, &CUBE_TRIS)
}

const CONTENT_TYPES: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\
<Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"gcode\" ContentType=\"text/x.gcode\"/></Types>";

const RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\" Target=\"/3D/3dmodel.model\"/>\
<Relationship Id=\"rel1\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail\" Target=\"/Metadata/plate_1.png\"/>\
<Relationship Id=\"rel2\" Type=\"http://example.com/track\" Target=\"http://evil.example/beacon\" TargetMode=\"External\"/>\
</Relationships>";

/// A zip with the given entries, deflated unless the name is listed in `stored`.
fn make_zip(entries: &[(&str, &[u8])], stored: &[&str]) -> Vec<u8> {
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        let method = if stored.contains(name) {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        w.start_file(*name, SimpleFileOptions::default().compression_method(method))
            .unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn plain_3mf(extra: &[(&str, &[u8])]) -> Vec<u8> {
    let model = cube_model();
    let mut entries: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", RELS.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
    ];
    entries.extend_from_slice(extra);
    make_zip(&entries, &[])
}

fn listing() -> ListingMeta {
    ListingMeta {
        listing_id: "lst_test".into(),
        listing_slug: "test-model".into(),
        version_id: "ver_test".into(),
        creator_id: "crt_test".into(),
        version_number: "1.0.0".into(),
        creator_slug: "tester".into(),
        creator_name: "Tester".into(),
        title: "Test model".into(),
    }
}

// ------------------------------------------------------- scanner doubles

/// A scanner that answers from a closure and counts calls.
struct Mock {
    calls: AtomicUsize,
    answer: Box<dyn Fn(&[u8]) -> Result<AvVerdict, AvError> + Send + Sync>,
}

impl Mock {
    fn clean() -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            answer: Box::new(|_| Ok(AvVerdict::Clean)),
        })
    }

    /// Flags any buffer that contains the EICAR string, like a real engine.
    fn eicar() -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            answer: Box::new(|b| {
                let e = eicar();
                if b.windows(e.len()).any(|w| w == e) {
                    Ok(AvVerdict::Infected("Eicar-Test-Signature".into()))
                } else {
                    Ok(AvVerdict::Clean)
                }
            }),
        })
    }
}

#[async_trait]
impl AntiVirus for Mock {
    fn engine(&self) -> &'static str {
        "mock"
    }
    async fn scan(&self, bytes: &[u8]) -> Result<AvVerdict, AvError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        (self.answer)(bytes)
    }
    async fn version(&self) -> Option<String> {
        Some("mock/1".into())
    }
}

fn scanner_with(limits: Limits, av: Arc<dyn AntiVirus>, blocklist: HashBlocklist) -> Scanner {
    Scanner::new(limits, Arc::new(blocklist), av)
}

fn scanner() -> Scanner {
    scanner_with(Limits::default(), Mock::eicar(), HashBlocklist::default())
}

async fn scan_with(s: &Scanner, name: &str, bytes: Vec<u8>) -> ScanOutcome {
    s.scan(Upload {
        file_name: name.into(),
        bytes,
        listing: listing(),
    })
    .await
}

async fn scan(name: &str, bytes: Vec<u8>) -> ScanOutcome {
    scan_with(&scanner(), name, bytes).await
}

fn rejected(o: &ScanOutcome, code: &str) {
    assert_eq!(
        o.report.verdict,
        Verdict::Rejected,
        "expected rejection {code}, got {:?} {:?}",
        o.report.verdict,
        o.report.reasons
    );
    assert_eq!(
        o.report.reason_codes,
        vec![code_of(code)],
        "{:?}",
        o.report.reasons
    );
    assert!(o.library_file.is_none());
    assert!(o.preview_png.is_none());
}

fn code_of(code: &str) -> &'static str {
    // Report codes are 'static; leak the expected one for the comparison.
    Box::leak(code.to_owned().into_boxed_str())
}

fn assert_clean(o: &ScanOutcome) {
    assert_eq!(
        o.report.verdict,
        Verdict::Clean,
        "{:?} {:?}",
        o.report.reason_codes,
        o.report.reasons
    );
    assert!(o.library_file.is_some());
}

fn zip_names(bytes: &[u8]) -> Vec<String> {
    ZipArchive::new(Cursor::new(bytes))
        .unwrap()
        .file_names()
        .map(str::to_owned)
        .collect()
}

fn read_entry(bytes: &[u8], name: &str) -> Vec<u8> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = Vec::new();
    z.by_name(name).unwrap().read_to_end(&mut out).unwrap();
    out
}

// -------------------------------------------------------- happy paths

#[tokio::test]
async fn binary_stl_becomes_an_sx3mf() {
    let o = scan("cube.stl", cube_stl()).await;
    assert_clean(&o);
    let r = &o.report;
    assert_eq!(r.triangle_count, Some(12));
    let b = r.bounds_mm.unwrap();
    assert_eq!((b.min, b.max), ([0.0; 3], [10.0; 3]));
    assert_eq!(r.original_sha256, sha256_hex(&cube_stl()));
    assert_eq!(
        r.library_file_sha256.as_deref(),
        Some(sha256_hex(o.library_file.as_ref().unwrap()).as_str())
    );
    assert_eq!(r.scanner.result, "clean");
    assert_eq!(r.scanner.signature_version.as_deref(), Some("mock/1"));

    let file = o.library_file.unwrap();
    let info = sx3mf::inspect(&file).unwrap();
    assert!(info.is_sx3mf);
    assert_eq!(info.metadata.listing.as_deref(), Some("lst_test"));
    assert_eq!(info.metadata.version_id.as_deref(), Some("ver_test"));
    assert_eq!(info.metadata.creator.as_deref(), Some("crt_test"));
    assert!(info.thumbnail_png.unwrap().starts_with(b"\x89PNG\r\n\x1a\n"));
    // The library file is itself the 3MF: sx-core reads the same triangles.
    let mesh = sx_core::mesh::Mesh::load(&file, "x.3mf").unwrap();
    assert_eq!(mesh.triangle_count(), 12);
}

#[tokio::test]
async fn ascii_stl_is_accepted() {
    let o = scan("cube.stl", cube_ascii_stl()).await;
    assert_clean(&o);
    assert_eq!(o.report.triangle_count, Some(12));
}

#[tokio::test]
async fn reference_x_mark_stl_is_accepted() {
    let bytes = include_bytes!("../../../../../../packages/core/bench/models/x-mark.stl").to_vec();
    let o = scan("x-mark.stl", bytes).await;
    assert_clean(&o);
    assert!(o.report.triangle_count.unwrap() > 1000);
}

#[tokio::test]
async fn reference_two_color_3mf_is_accepted() {
    let bytes = include_bytes!("../../../../../../packages/core/bench/models/x-mark-2color.3mf").to_vec();
    let o = scan("x-mark-2color.3mf", bytes).await;
    assert_clean(&o);
    let file = o.library_file.unwrap();
    let names = zip_names(&file);
    assert!(names.contains(&"3D/3dmodel.model".to_owned()));
    assert!(names.contains(&"Metadata/model_settings.config".to_owned()));
}

#[tokio::test]
async fn output_is_deterministic_and_survives_a_second_upload() {
    let a = scan("cube.stl", cube_stl()).await;
    let b = scan("cube.stl", cube_stl()).await;
    assert_eq!(a.library_file, b.library_file);
    // Uploading the produced sx3mf again works and yields the same model.
    let again = scan("library.sx3mf", a.library_file.clone().unwrap()).await;
    assert_clean(&again);
    assert_eq!(again.report.triangle_count, Some(12));
    assert_eq!(
        serde_json::to_value(again.report.detected_type).unwrap(),
        serde_json::json!("sx3mf")
    );
}

#[tokio::test]
async fn report_json_is_camel_case() {
    let o = scan("cube.stl", cube_stl()).await;
    let v = serde_json::to_value(&o.report).unwrap();
    for key in [
        "verdict",
        "reasonCodes",
        "originalName",
        "detectedType",
        "originalSha256",
        "libraryFileSha256",
        "sizeBytes",
        "triangleCount",
        "boundsMm",
        "stripped",
        "scanner",
        "blocklistHit",
    ] {
        assert!(v.get(key).is_some(), "missing {key}");
    }
    assert_eq!(v["verdict"], "clean");
    assert_eq!(v["detectedType"], "stl");
}

// ------------------------------------------- detection by content

#[tokio::test]
async fn executables_are_refused_whatever_the_name() {
    let mut pe = b"MZ\x90\x00\x03\x00\x00\x00".to_vec();
    pe.extend_from_slice(&[0u8; 200]);
    for (name, bytes) in [
        ("model.stl", pe.clone()),
        ("model.3mf", pe),
        ("model.stl", b"\x7fELF\x02\x01\x01\x00rest".to_vec()),
        ("model.stl", b"\xcf\xfa\xed\xfe\x07\x00\x00\x01".to_vec()),
        ("model.stl", b"#!/bin/sh\nrm -rf ~\n".to_vec()),
        ("model.stl", b"<?php system($_GET['c']); ?>".to_vec()),
        ("model.stl", b"<script>alert(1)</script>".to_vec()),
        ("model.stl", b"%PDF-1.7\n".to_vec()),
        ("model.stl", b"\x1f\x8b\x08\x00 gzip".to_vec()),
    ] {
        let o = scan(name, bytes).await;
        rejected(&o, "forbidden_type");
    }
}

#[tokio::test]
async fn unknown_and_empty_content_is_refused() {
    rejected(&scan("a.stl", Vec::new()).await, "empty_file");
    rejected(
        &scan("a.stl", b"hello world, not a model".to_vec()).await,
        "unsupported_type",
    );
    rejected(&scan("a.stl", vec![0xAB; 5000]).await, "unsupported_type");
    // ASCII that starts like an STL but hides other text.
    let mut sneaky = cube_ascii_stl();
    sneaky.splice(12..12, b"import os; os.system('id')\n".iter().copied());
    rejected(&scan("a.stl", sneaky).await, "unsupported_type");
}

#[tokio::test]
async fn a_renamed_3mf_is_accepted_with_a_warning() {
    let o = scan("looks-like.stl", plain_3mf(&[])).await;
    assert_clean(&o);
    assert!(
        o.report.warnings.iter().any(|w| w.contains(".stl")),
        "{:?}",
        o.report.warnings
    );
}

#[tokio::test]
async fn file_names_do_not_reach_the_report_raw() {
    let o = scan("..\\..\\etc\\pass\x00wd\n<b>.stl", cube_stl()).await;
    assert_clean(&o);
    assert!(!o.report.original_name.contains(['\\', '/', '\0', '\n']));
}

// -------------------------------------------------------------- sizes

#[tokio::test]
async fn size_caps_apply_per_file_and_per_upload() {
    let limits = Limits {
        max_file_bytes: 1000,
        max_upload_bytes: 1500,
        ..Limits::default()
    };
    let s = scanner_with(limits.clone(), Mock::clean(), HashBlocklist::default());
    let o = scan_with(&s, "big.stl", vec![0u8; 1001]).await;
    rejected(&o, "file_too_large");
    assert_eq!(
        limits.check_upload(&[900, 900]).unwrap_err().code,
        "upload_too_large"
    );
    assert_eq!(limits.check_upload(&[1001]).unwrap_err().code, "file_too_large");
    assert!(limits.check_upload(&[700, 700]).is_ok());
}

#[tokio::test]
async fn too_many_triangles_is_refused_for_both_stl_kinds() {
    let limits = Limits {
        max_triangles: 10,
        ..Limits::default()
    };
    let s = scanner_with(limits, Mock::clean(), HashBlocklist::default());
    rejected(
        &scan_with(&s, "a.stl", cube_ascii_stl()).await,
        "too_many_triangles",
    );
    rejected(&scan_with(&s, "a.stl", cube_stl()).await, "too_many_triangles");
    rejected(
        &scan_with(&s, "a.3mf", plain_3mf(&[])).await,
        "too_many_triangles",
    );
}

// --------------------------------------------------------- archives

#[tokio::test]
async fn zip_bombs_are_refused() {
    // 40 MB of zeros deflates to about 40 KB.
    let zeros = vec![0u8; 40 * 1024 * 1024];
    let model = cube_model();
    let bomb = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
            ("Metadata/filler.txt", &zeros),
        ],
        &[],
    );
    assert!(bomb.len() < 200_000);
    rejected(&scan("bomb.3mf", bomb).await, "zip_bomb");

    // The same, with the ratio check off, still trips the size limits.
    let limits = Limits {
        max_ratio: u64::MAX / 4,
        max_entry_bytes: 8 * 1024 * 1024,
        ..Limits::default()
    };
    let s = scanner_with(limits, Mock::clean(), HashBlocklist::default());
    let bomb = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
            ("Metadata/filler.txt", &zeros),
        ],
        &[],
    );
    rejected(&scan_with(&s, "bomb.3mf", bomb).await, "zip_entry_too_large");
}

#[tokio::test]
async fn a_model_that_lies_about_its_size_is_refused() {
    // Patch the declared uncompressed size of the model entry (central
    // directory and local header) to be smaller than the real content.
    let mut z = plain_3mf(&[]);
    let real = u32::try_from(cube_model().len()).unwrap().to_le_bytes();
    let fake = 100u32.to_le_bytes();
    let mut patched = 0;
    for i in 0..z.len().saturating_sub(4) {
        if z[i..i + 4] == real {
            z[i..i + 4].copy_from_slice(&fake);
            patched += 1;
        }
    }
    assert!(patched >= 2);
    let o = scan("lie.3mf", z).await;
    assert_eq!(o.report.verdict, Verdict::Rejected);
    assert!(o.library_file.is_none());
    assert_eq!(o.report.reason_codes, vec!["zip_size_mismatch"]);
}

#[tokio::test]
async fn too_many_entries_are_refused() {
    let names: Vec<String> = (0..300).map(|i| format!("Metadata/a{i}.txt")).collect();
    let mut entries: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", RELS.as_bytes()),
    ];
    for n in &names {
        entries.push((n.as_str(), b"x"));
    }
    rejected(
        &scan("many.3mf", make_zip(&entries, &[])).await,
        "zip_too_many_entries",
    );
}

#[tokio::test]
async fn path_traversal_names_are_refused() {
    for name in [
        "../evil.model",
        "3D/../../evil.model",
        "/etc/passwd",
        "3D\\..\\evil.model",
        "C:/Windows/evil.model",
        "3D/./x.model",
        "3D//x.model",
        "Metadata/trailing.txt.",
    ] {
        let z = plain_3mf(&[(name, b"data")]);
        let o = scan("t.3mf", z).await;
        assert_eq!(o.report.verdict, Verdict::Rejected, "{name}");
        assert!(
            o.report.reason_codes[0] == "zip_path_traversal" || o.report.reason_codes[0] == "zip_bad_name",
            "{name}: {:?}",
            o.report.reason_codes
        );
    }
}

#[tokio::test]
async fn symlinks_are_refused() {
    let model = cube_model();
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();
    for (n, d) in [
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", RELS.as_bytes()),
        ("3D/3dmodel.model", model.as_bytes()),
    ] {
        w.start_file(n, opts).unwrap();
        w.write_all(d).unwrap();
    }
    w.add_symlink("Metadata/link.txt", "/etc/passwd", opts).unwrap();
    let z = w.finish().unwrap().into_inner();
    rejected(&scan("link.3mf", z).await, "zip_symlink");
}

#[tokio::test]
async fn executables_scripts_and_macros_inside_archives_are_refused() {
    for name in [
        "Metadata/setup.exe",
        "Metadata/lib.dll",
        "Metadata/run.sh",
        "Metadata/run.bat",
        "Metadata/run.ps1",
        "Metadata/x.js",
        "Metadata/x.py",
        "Metadata/x.jar",
        "Metadata/page.html",
        "Metadata/pic.svg",
        "xl/vbaProject.bin",
        "Metadata/Macros/thing.txt",
        "Metadata/payload.PE.EXE",
    ] {
        let o = scan("t.3mf", plain_3mf(&[(name, b"data")])).await;
        assert_eq!(o.report.verdict, Verdict::Rejected, "{name}");
        assert!(
            ["zip_executable", "zip_macro"].contains(&o.report.reason_codes[0]),
            "{name}: {:?}",
            o.report.reason_codes
        );
    }
}

#[tokio::test]
async fn disguised_executables_are_found_by_content() {
    for (name, data) in [
        ("3D/extra.model", &b"MZ\x90\x00\x03\x00"[..]),
        ("Metadata/notes.txt", b"#!/bin/sh\nid\n"),
        ("Metadata/icon.png", b"\x7fELF\x02\x01"),
        ("Metadata/data.config", b"PK\x03\x04\x14\x00"),
        ("Metadata/ole.config", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1rest"),
    ] {
        let o = scan("t.3mf", plain_3mf(&[(name, data)])).await;
        assert_eq!(o.report.verdict, Verdict::Rejected, "{name}");
        assert!(
            ["zip_forbidden_content", "zip_nested_archive"].contains(&o.report.reason_codes[0]),
            "{name}: {:?}",
            o.report.reason_codes
        );
    }
}

#[tokio::test]
async fn unexpected_entries_and_content_types_are_refused() {
    rejected(
        &scan("t.3mf", plain_3mf(&[("payload/stage2.dat", b"data")])).await,
        "zip_unexpected_entry",
    );
    rejected(
        &scan("t.3mf", plain_3mf(&[("README", b"hello")])).await,
        "zip_unexpected_entry",
    );
    let model = cube_model();
    let types = CONTENT_TYPES.replace(
        "</Types>",
        "<Default Extension=\"txt\" ContentType=\"application/x-msdownload\"/></Types>",
    );
    let z = make_zip(
        &[
            ("[Content_Types].xml", types.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
        ],
        &[],
    );
    rejected(&scan("t.3mf", z).await, "zip_content_type");
}

#[tokio::test]
async fn encrypted_and_duplicate_entries_are_refused() {
    let mut z = plain_3mf(&[]);
    // Set the "encrypted" bit in every central directory header.
    for i in 0..z.len().saturating_sub(10) {
        if z[i..i + 4] == *b"PK\x01\x02" {
            z[i + 8] |= 1;
        }
    }
    rejected(&scan("enc.3mf", z).await, "zip_encrypted");

    // Two entries whose names differ only by case, written as distinct names
    // and then patched to collide.
    let model = cube_model();
    let mut z = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
            ("3D/3DMODEL.model", model.as_bytes()),
        ],
        &[],
    );
    let _ = &mut z;
    let o = scan("dup.3mf", z).await;
    rejected(&o, "zip_duplicate_entry");
}

#[tokio::test]
async fn data_after_the_zip_end_is_refused() {
    let mut z = plain_3mf(&[]);
    z.extend_from_slice(b"\x7fELF hidden second stage");
    rejected(&scan("poly.3mf", z).await, "zip_trailing_data");
    // A PE header in front of an archive fails on its first bytes.
    let mut z = b"MZ\x90\x00".to_vec();
    z.extend_from_slice(&plain_3mf(&[]));
    rejected(&scan("poly.3mf", z).await, "forbidden_type");
}

#[tokio::test]
async fn xml_entities_and_doctypes_are_refused() {
    let evil = [
        "<?xml version=\"1.0\"?><!DOCTYPE model [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><model>&x;</model>",
        "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;\">]><model>&b;</model>",
        "<?xml version=\"1.0\"?><model>&custom;</model>",
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?><model/>",
    ];
    for xml in evil {
        let z = make_zip(
            &[
                ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
                ("_rels/.rels", RELS.as_bytes()),
                ("3D/3dmodel.model", xml.as_bytes()),
            ],
            &[],
        );
        rejected(&scan("xxe.3mf", z).await, "xml_invalid");
    }
    let deep = format!("{}{}", "<a>".repeat(5000), "</a>".repeat(5000));
    let z = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", deep.as_bytes()),
        ],
        &[],
    );
    rejected(&scan("deep.3mf", z).await, "xml_invalid");
}

#[tokio::test]
async fn archive_without_a_model_is_refused() {
    let z = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
        ],
        &[],
    );
    rejected(&scan("nomodel.3mf", z).await, "zip_no_model");
}

// ----------------------------------------------------------- stripping

#[tokio::test]
async fn gcode_settings_and_broken_thumbnails_are_stripped() {
    // A real, valid PNG to keep: the preview of another upload.
    let png = scan("cube.stl", cube_stl()).await.preview_png.unwrap();
    let z = plain_3mf(&[
        ("Metadata/plate_1.gcode", b"M104 S999\nG28\n"),
        ("Metadata/plate_1.gcode.md5", b"abcd"),
        (
            "Metadata/project_settings.config",
            br#"{"machine_start_gcode":"M999"}"#,
        ),
        ("Metadata/slice_info.config", b"<config/>"),
        ("Metadata/plate_1.png", b"\x89PNG\r\n\x1a\nnot really a png"),
        ("Metadata/top_1.png", &png),
        (
            "Metadata/model_settings.config",
            b"<config><object id=\"1\"/></config>",
        ),
    ]);
    let o = scan("t.3mf", z).await;
    assert_clean(&o);
    let stripped = o.report.stripped.join("\n");
    assert!(stripped.contains("plate_1.gcode: embedded G-code"), "{stripped}");
    assert!(stripped.contains("project_settings.config"), "{stripped}");
    assert!(
        stripped.contains("plate_1.png: thumbnail does not decode"),
        "{stripped}"
    );
    assert!(!stripped.contains("top_1.png"));

    let inner = o.library_file.unwrap();
    let names = zip_names(&inner);
    assert!(names.contains(&"Metadata/top_1.png".to_owned()), "{names:?}");
    assert!(names.contains(&"Metadata/model_settings.config".to_owned()));
    for gone in ["gcode", "project_settings", "slice_info", "plate_1.png"] {
        assert!(
            !names.iter().any(|n| n.contains(gone)),
            "{gone} survived: {names:?}"
        );
    }
    // Relationships to removed parts and external targets are gone too.
    let rels = String::from_utf8(read_entry(&inner, "_rels/.rels")).unwrap();
    assert!(rels.contains("/3D/3dmodel.model"));
    assert!(!rels.contains("plate_1.png"), "{rels}");
    assert!(!rels.contains("evil.example"), "{rels}");
}

#[tokio::test]
async fn a_bad_texture_is_a_rejection_not_a_strip() {
    let z = plain_3mf(&[("3D/Textures/skin.png", b"\x89PNG\r\n\x1a\ngarbage")]);
    rejected(&scan("t.3mf", z).await, "png_invalid");
}

// ---------------------------------------------------------------- mesh

fn stl_of(tris: &[[[f32; 3]; 3]]) -> Vec<u8> {
    binary_stl_with(b"x", tris)
}

#[tokio::test]
async fn unparseable_and_empty_geometry_is_refused() {
    // Zip of the right shape whose model is not a mesh.
    let z = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", b"<model><resources/><build/></model>"),
        ],
        &[],
    );
    rejected(&scan("a.3mf", z).await, "mesh_parse");
    // A binary STL with zero triangles is 84 bytes.
    rejected(&scan("a.stl", stl_of(&[])).await, "mesh_empty");
    // Triangles with no area.
    let flat = [[[1.0, 1.0, 1.0]; 3]; 4];
    rejected(&scan("a.stl", stl_of(&flat)).await, "mesh_empty");
    let line = [[[0.0, 0.0, 0.0], [5.0, 0.0, 0.0], [10.0, 0.0, 0.0]]];
    rejected(&scan("a.stl", stl_of(&line)).await, "mesh_empty");
}

#[tokio::test]
async fn non_finite_and_absurd_coordinates_are_refused() {
    let nan = [[[0.0, 0.0, 0.0], [f32::NAN, 0.0, 0.0], [0.0, 10.0, 0.0]]];
    rejected(&scan("a.stl", stl_of(&nan)).await, "mesh_not_finite");
    let inf = [[[0.0, 0.0, 0.0], [f32::INFINITY, 0.0, 0.0], [0.0, 10.0, 0.0]]];
    rejected(&scan("a.stl", stl_of(&inf)).await, "mesh_not_finite");
    let huge = [[[0.0, 0.0, 0.0], [1.0e9, 0.0, 0.0], [0.0, 10.0, 0.0]]];
    rejected(&scan("a.stl", stl_of(&huge)).await, "mesh_too_large");
}

#[tokio::test]
async fn out_of_range_indices_in_a_3mf_are_refused() {
    let model = model_xml(&CUBE_VERTS, &[[0, 1, 99]]);
    let z = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
        ],
        &[],
    );
    // sx-core refuses a triangle that points at a missing vertex: the file is malformed.
    rejected(&scan("a.3mf", z).await, "mesh_parse");
}

#[tokio::test]
async fn a_hostile_pile_of_huge_triangles_previews_in_bounded_time() {
    // 200,000 triangles that each cover the whole view.
    let mut tris = Vec::new();
    for i in 0..200_000u32 {
        let j = (i % 50) as f32 * 0.01;
        tris.push([[0.0, 0.0, j], [100.0, 0.0, j], [0.0, 100.0, 100.0 - j]]);
    }
    let started = std::time::Instant::now();
    let o = scan("a.stl", stl_of(&tris)).await;
    assert_clean(&o);
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
}

// ---------------------------------------------------------- sx3mf input

/// A 3MF stamped as an sx3mf by someone's own export.
fn exported_sx3mf(extra: &[(&str, &[u8])]) -> Vec<u8> {
    let meta = sx3mf::Sx3mfMetadata {
        listing: Some("lst_someone_else".into()),
        creator: Some("crt_someone_else".into()),
        exported_by: Some("usr_private".into()),
        ..Default::default()
    };
    sx3mf::stamp(&plain_3mf(extra), &meta, None).unwrap()
}

#[tokio::test]
async fn sx3mf_uploads_are_checked_like_3mf() {
    // A script inside is refused exactly as in a 3MF.
    let bad = exported_sx3mf(&[("Metadata/run.sh", b"id")]);
    rejected(&scan("a.sx3mf", bad).await, "zip_executable");
    // So is a nested archive.
    let nested = exported_sx3mf(&[("Metadata/inner.bin", &plain_3mf(&[]))]);
    let o = scan("a.sx3mf", nested).await;
    assert_eq!(o.report.verdict, Verdict::Rejected, "{:?}", o.report);
}

#[tokio::test]
async fn sx3mf_metadata_is_replaced_by_the_listing() {
    let o = scan("a.sx3mf", exported_sx3mf(&[])).await;
    assert_clean(&o);
    assert_eq!(
        serde_json::to_value(o.report.detected_type).unwrap(),
        serde_json::json!("sx3mf")
    );
    let info = sx3mf::inspect(&o.library_file.unwrap()).unwrap();
    assert_eq!(info.metadata.listing.as_deref(), Some("lst_test"));
    assert_eq!(info.metadata.creator.as_deref(), Some("crt_test"));
    // The uploader's account id never reaches the library.
    assert_eq!(info.metadata.exported_by, None);
}

// -------------------------------------------------------------- malware

#[tokio::test]
async fn eicar_in_an_stl_header_is_flagged() {
    let bytes = binary_stl_with(&eicar(), &cube_soup());
    let o = scan("model.stl", bytes).await;
    rejected(&o, "malware");
    assert_eq!(o.report.scanner.result, "infected");
    assert_eq!(
        o.report.scanner.signature.as_deref(),
        Some("Eicar-Test-Signature")
    );
    assert!(
        o.report.triangle_count.is_none(),
        "an infected file is not parsed"
    );
}

#[tokio::test]
async fn eicar_inside_an_archive_is_flagged_even_when_the_entry_would_be_stripped() {
    let e = eicar();
    let model = cube_model();
    let z = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
            ("Metadata/notes.txt", &e),
        ],
        &["Metadata/notes.txt"],
    );
    let o = scan("a.3mf", z).await;
    rejected(&o, "malware");
}

#[tokio::test]
async fn an_unreachable_scanner_leaves_the_upload_unapproved() {
    let av = Arc::new(Mock {
        calls: AtomicUsize::new(0),
        answer: Box::new(|_| Err(AvError("clamd is down".into()))),
    });
    let s = scanner_with(Limits::default(), av, HashBlocklist::default());
    let o = scan_with(&s, "a.stl", cube_stl()).await;
    assert_eq!(o.report.verdict, Verdict::ScanUnavailable);
    assert_eq!(o.report.reason_codes, vec!["scan_unavailable"]);
    assert!(o.library_file.is_none() && o.preview_png.is_none());
    assert_eq!(o.report.scanner.result, "unavailable");
}

#[tokio::test]
async fn the_blocklist_stops_a_file_before_the_scanner_and_after_conversion() {
    let av = Mock::clean();
    let bl = HashBlocklist::parse(&format!(
        "# comment\n\n{} reuploaded ransomware\n",
        sha256_hex(&cube_stl())
    ))
    .unwrap();
    let s = scanner_with(Limits::default(), av.clone(), bl);
    let o = scan_with(&s, "a.stl", cube_stl()).await;
    rejected(&o, "blocklisted");
    assert!(o.report.blocklist_hit);
    assert_eq!(av.calls.load(Ordering::SeqCst), 0);

    // Block the converted library file instead.
    let clean = scan("a.stl", cube_stl()).await;
    let lib_sha = clean.report.library_file_sha256.unwrap();
    let bl = HashBlocklist::parse(&format!("{}\n", lib_sha.to_ascii_uppercase())).unwrap();
    let s = scanner_with(Limits::default(), Mock::clean(), bl);
    let o = scan_with(&s, "a.stl", cube_stl()).await;
    rejected(&o, "blocklisted");
}

#[test]
fn blocklist_parsing_is_strict() {
    assert!(HashBlocklist::parse("nothex\n").is_err());
    assert!(HashBlocklist::parse(&format!("{}x\n", "a".repeat(64))).is_err());
    let bl = HashBlocklist::parse(&format!("{}\n", "A".repeat(64))).unwrap();
    assert_eq!(bl.len(), 1);
    assert!(!bl.is_empty());
}

// --------------------------------------------------- clamd protocol

#[derive(Clone, Copy)]
enum Fake {
    Normal,
    RefuseLarge,
    Hang,
}

/// A stand-in for clamd that speaks `INSTREAM` and flags EICAR.
async fn fake_clamd(mode: Fake) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut cmd = Vec::new();
                loop {
                    let mut b = [0u8; 1];
                    if s.read_exact(&mut b).await.is_err() {
                        return;
                    }
                    if b[0] == 0 {
                        break;
                    }
                    cmd.push(b[0]);
                }
                if cmd == b"zVERSION" {
                    let _ = s.write_all(b"ClamAV 1.4.0/27000/test\0").await;
                    return;
                }
                if matches!(mode, Fake::Hang) {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    return;
                }
                let mut body = Vec::new();
                loop {
                    let mut len = [0u8; 4];
                    if s.read_exact(&mut len).await.is_err() {
                        return;
                    }
                    let n = u32::from_be_bytes(len) as usize;
                    if n == 0 {
                        break;
                    }
                    if matches!(mode, Fake::RefuseLarge) && body.len() > 1000 {
                        let _ = s.write_all(b"INSTREAM size limit exceeded. ERROR\0").await;
                        // Read what the client still sends before closing: closing with unread data
                        // resets the connection, and Windows then drops the reply the client has not read.
                        let _ = s.shutdown().await;
                        let _ = tokio::io::copy(&mut s, &mut tokio::io::sink()).await;
                        return;
                    }
                    let mut chunk = vec![0u8; n];
                    if s.read_exact(&mut chunk).await.is_err() {
                        return;
                    }
                    body.extend_from_slice(&chunk);
                }
                let e = eicar();
                let reply: &[u8] = if body.windows(e.len()).any(|w| w == e) {
                    b"stream: Eicar-Test-Signature FOUND\0"
                } else {
                    b"stream: OK\0"
                };
                let _ = s.write_all(reply).await;
            });
        }
    });
    addr
}

#[tokio::test]
async fn clamd_client_speaks_instream() {
    let addr = fake_clamd(Fake::Normal).await;
    let av = Clamd::new(ClamdAddr::parse(&addr).unwrap());
    assert_eq!(av.scan(b"just some bytes").await.unwrap(), AvVerdict::Clean);
    // Larger than one 64 KiB chunk.
    let mut big = vec![7u8; 300_000];
    assert_eq!(av.scan(&big).await.unwrap(), AvVerdict::Clean);
    big.extend_from_slice(&eicar());
    assert_eq!(
        av.scan(&big).await.unwrap(),
        AvVerdict::Infected("Eicar-Test-Signature".into())
    );
    assert_eq!(av.version().await.as_deref(), Some("ClamAV 1.4.0/27000/test"));
}

#[tokio::test]
async fn clamd_errors_are_unavailable_not_clean() {
    let addr = fake_clamd(Fake::RefuseLarge).await;
    let av = Clamd::new(ClamdAddr::parse(&addr).unwrap());
    let err = av.scan(&vec![1u8; 500_000]).await.unwrap_err();
    assert!(err.0.contains("size limit"), "{err}");

    let addr = fake_clamd(Fake::Hang).await;
    let av = Clamd::new(ClamdAddr::parse(&addr).unwrap()).with_timeout(Duration::from_millis(300));
    assert!(av.scan(b"x").await.is_err());

    // Nothing listens on this port.
    let free = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap();
    let av = Clamd::new(ClamdAddr::parse(&free.to_string()).unwrap());
    assert!(av.scan(b"x").await.is_err());
    assert!(av.version().await.is_none());
    assert!(ClamdAddr::parse("no-port").is_err());
    // A Unix socket address is only for Unix; elsewhere it is refused with the reason.
    assert_eq!(
        ClamdAddr::parse("unix:/var/run/clamav/clamd.sock").is_ok(),
        cfg!(unix)
    );
}

#[tokio::test]
async fn the_whole_pipeline_works_through_the_clamd_client() {
    let addr = fake_clamd(Fake::Normal).await;
    let av: Arc<dyn AntiVirus> = Arc::new(Clamd::new(ClamdAddr::parse(&addr).unwrap()));
    let s = scanner_with(Limits::default(), av, HashBlocklist::default());
    assert_clean(&scan_with(&s, "a.stl", cube_stl()).await);
    let o = scan_with(&s, "a.stl", binary_stl_with(&eicar(), &cube_soup())).await;
    rejected(&o, "malware");
}

/// Runs against a real clamd when `SX_CLAMD_ADDR` is set (for example
/// `127.0.0.1:3310` through an SSH tunnel to another machine). Skipped otherwise.
#[tokio::test]
async fn real_clamd_flags_eicar() {
    let Ok(addr) = std::env::var("SX_CLAMD_ADDR") else {
        eprintln!("SX_CLAMD_ADDR is not set; skipping the real clamd test");
        return;
    };
    let av: Arc<dyn AntiVirus> = Arc::new(Clamd::new(ClamdAddr::parse(&addr).unwrap()));
    let s = scanner_with(Limits::default(), av.clone(), HashBlocklist::default());
    assert!(av.version().await.unwrap().starts_with("ClamAV"));
    assert_clean(&scan_with(&s, "a.stl", cube_stl()).await);
    // The EICAR file itself. ClamAV matches it as a whole file only, so it is
    // not hidden in an STL header here (the mock tests cover that).
    let o = scan_with(&s, "eicar.stl", eicar()).await;
    rejected(&o, "malware");
    assert!(o.report.scanner.signature.as_deref().unwrap().contains("Eicar"));
    let mut with_newline = eicar();
    with_newline.push(b'\n');
    rejected(&scan_with(&s, "eicar.txt", with_newline).await, "malware");
    // EICAR stored inside a 3MF, which clamd has to unpack.
    let model = cube_model();
    let e = eicar();
    let z = make_zip(
        &[
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("3D/3dmodel.model", model.as_bytes()),
            ("Metadata/notes.txt", &e),
        ],
        &["Metadata/notes.txt"],
    );
    rejected(&scan_with(&s, "a.3mf", z).await, "malware");
}

/// Writes the preview of the reference X to `SX_PREVIEW_OUT` so a person can
/// look at it. Skipped otherwise.
#[tokio::test]
async fn preview_of_the_reference_model_can_be_written_out() {
    let Ok(path) = std::env::var("SX_PREVIEW_OUT") else {
        return;
    };
    let bytes = include_bytes!("../../../../../../packages/core/bench/models/x-mark.stl").to_vec();
    let o = scan("x-mark.stl", bytes).await;
    std::fs::write(path, o.preview_png.unwrap()).unwrap();
}
