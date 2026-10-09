// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! `sx-upload-scan`: the safety pipeline for files uploaded to the free
//! library. Every upload is treated as hostile.
//!
//! In order: size caps, SHA-256 and the hash blocklist, a malware scan of the
//! original bytes, type detection from content (STL, 3MF and sx3mf only),
//! zip audit and sanitizing, mesh parsing with `sx-core`, mesh checks,
//! conversion to an sx3mf with a preview, a second blocklist and malware
//! check on the converted file. The result is a [`ScanReport`] and, when every
//! step passed, the converted file and the preview PNG. The caller stores
//! those in quarantine and queues the report for a moderator; nothing here
//! publishes a file.

mod archive;
mod blocklist;
mod clamd;
mod convert;
mod limits;
mod model;
mod png;
mod preview;
mod reject;
mod report;
mod sniff;
mod xmlcheck;

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use sha2::{Digest, Sha256};
use sx_core::mesh::Mesh;

pub use blocklist::{Blocklist, HashBlocklist};
pub use clamd::{AntiVirus, AvError, AvVerdict, Clamd, ClamdAddr};
pub use convert::{ListingMeta, clean_text, is_sx3mf};
pub use limits::Limits;
pub use model::MeshFacts;
pub use reject::Reject;
pub use report::{Bounds, DetectedType, ScanReport, ScannerInfo, Verdict};
pub use sniff::Sniffed;

/// Side of the preview image, in pixels.
pub const PREVIEW_SIDE: u32 = 256;

/// One file to check.
pub struct Upload {
    /// The name the uploader gave the file. Only shown, never trusted.
    pub file_name: String,
    pub bytes: Vec<u8>,
    pub listing: ListingMeta,
}

/// The pipeline result.
#[derive(Debug)]
pub struct ScanOutcome {
    pub report: ScanReport,
    /// The converted sx3mf. `Some` only when the verdict is `Clean`.
    pub library_file: Option<Vec<u8>>,
    /// The preview PNG. `Some` only when the verdict is `Clean`.
    pub preview_png: Option<Vec<u8>>,
}

/// The pipeline and what it needs.
#[derive(Clone)]
pub struct Scanner {
    pub limits: Limits,
    pub blocklist: Arc<dyn Blocklist>,
    pub av: Arc<dyn AntiVirus>,
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// SHA-256 as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

struct Built {
    library_file: Vec<u8>,
    payload_sha256: String,
    facts: MeshFacts,
    stripped: Vec<String>,
    preview: Vec<u8>,
    detected: DetectedType,
}

fn parse_mesh(bytes: &[u8], name: &str) -> Result<Mesh, Reject> {
    std::panic::catch_unwind(AssertUnwindSafe(|| Mesh::load(bytes, name)))
        .map_err(|_| Reject::new("mesh_parse", "the model could not be parsed"))?
        .map_err(|e| {
            Reject::new(
                load_reject_code(&e),
                format!("the file does not parse as a mesh: {e}"),
            )
        })
}

/// The reject code for a model the engine refuses to load. Its refusals read "refused <code> <object> <element>
/// <value>": an empty STL is `mesh_empty` and a coordinate that is not a finite number `mesh_not_finite`, as when
/// the checks here find them; anything else malformed is `mesh_parse`.
fn load_reject_code(e: &sx_core::Error) -> &'static str {
    let sx_core::Error::Mesh { reason, .. } = e else {
        return "mesh_parse";
    };
    let mut words = reason.split(' ');
    if words.next() != Some("refused") {
        return "mesh_parse";
    }
    match (words.next(), words.nth(2)) {
        (Some("stl-empty"), _) => "mesh_empty",
        (Some("stl-number"), _) => "mesh_not_finite",
        (Some("vertex"), Some(v)) if v.parse::<f64>().is_ok_and(|v| !v.is_finite()) => "mesh_not_finite",
        _ => "mesh_parse",
    }
}

/// Parses, checks and converts. Synchronous and CPU bound.
fn build(bytes: &[u8], sniffed: Sniffed, limits: &Limits, listing: &ListingMeta) -> Result<Built, Reject> {
    // An sx3mf is a 3MF with `sx:` metadata, so both take the same path.
    let (mesh, kept_3mf, stripped, detected) = match sniffed {
        Sniffed::Stl { .. } => (
            parse_mesh(bytes, "upload.stl")?,
            None,
            Vec::new(),
            DetectedType::Stl,
        ),
        Sniffed::Zip => {
            let clean = archive::sanitize_3mf(bytes, limits)?;
            let mesh = parse_mesh(&clean.bytes, "upload.3mf")?;
            let detected = if convert::is_sx3mf(&clean.bytes) {
                DetectedType::Sx3mf
            } else {
                DetectedType::ThreeMf
            };
            (mesh, Some(clean.bytes), clean.stripped, detected)
        }
    };
    let facts = model::check_mesh(&mesh, limits)?;
    let payload = if let Some(b) = kept_3mf {
        b
    } else {
        let b = model::mesh_to_3mf(&mesh)?;
        let back = parse_mesh(&b, "converted.3mf")?;
        if back.triangle_count() != mesh.triangle_count() {
            return Err(Reject::new(
                "convert_failed",
                "the converted model lost triangles",
            ));
        }
        b
    };
    let preview = preview::preview_png(&mesh, PREVIEW_SIDE);
    let library_file = convert::build_library_file(&payload, listing, Some(&preview))?;
    Ok(Built {
        payload_sha256: sha256_hex(&payload),
        library_file,
        facts,
        stripped,
        preview,
        detected,
    })
}

/// The file name without any directory, cleaned for display.
fn display_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    clean_text(base, 120)
}

fn extension_warning(name: &str, detected: DetectedType) -> Option<String> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    let claimed = match ext.as_str() {
        "stl" => DetectedType::Stl,
        "3mf" => DetectedType::ThreeMf,
        "sx3mf" => DetectedType::Sx3mf,
        _ => return None,
    };
    (claimed != detected).then(|| {
        format!(
            "the file name ends in .{ext} but the content is {}; the content was used",
            detected.extension()
        )
    })
}

impl Scanner {
    pub fn new(limits: Limits, blocklist: Arc<dyn Blocklist>, av: Arc<dyn AntiVirus>) -> Self {
        Self {
            limits,
            blocklist,
            av,
        }
    }

    /// Runs the pipeline. It does not fail: every problem is a verdict.
    pub async fn scan(&self, upload: Upload) -> ScanOutcome {
        let Upload {
            file_name,
            bytes,
            listing,
        } = upload;
        let mut report = ScanReport {
            verdict: Verdict::Rejected,
            reason_codes: Vec::new(),
            reasons: Vec::new(),
            warnings: Vec::new(),
            original_name: display_name(&file_name),
            detected_type: None,
            original_sha256: sha256_hex(&bytes),
            library_file_sha256: None,
            size_bytes: bytes.len() as u64,
            triangle_count: None,
            bounds_mm: None,
            stripped: Vec::new(),
            scanner: ScannerInfo {
                engine: self.av.engine().to_owned(),
                signature_version: None,
                result: "skipped",
                signature: None,
            },
            blocklist_hit: false,
            quarantine_path: None,
            preview_path: None,
        };
        match self.run(&bytes, &file_name, &listing, &mut report).await {
            Ok((library_file, preview)) => {
                report.verdict = Verdict::Clean;
                ScanOutcome {
                    report,
                    library_file: Some(library_file),
                    preview_png: Some(preview),
                }
            }
            Err(r) => {
                if r.code == "scan_unavailable" {
                    report.verdict = Verdict::ScanUnavailable;
                }
                report.reason_codes.push(r.code);
                report.reasons.push(r.message);
                ScanOutcome {
                    report,
                    library_file: None,
                    preview_png: None,
                }
            }
        }
    }

    async fn av_scan(&self, bytes: &[u8], report: &mut ScanReport) -> Result<(), Reject> {
        match self.av.scan(bytes).await {
            Ok(AvVerdict::Clean) => {
                report.scanner.result = "clean";
                report.scanner.signature_version = self.av.version().await;
                Ok(())
            }
            Ok(AvVerdict::Infected(sig)) => {
                report.scanner.result = "infected";
                report.scanner.signature = Some(sig);
                Err(Reject::new("malware", "the malware scan flagged this file"))
            }
            Err(e) => {
                report.scanner.result = "unavailable";
                report.warnings.push(e.to_string());
                Err(Reject::new(
                    "scan_unavailable",
                    "the malware scanner could not check this file; it stays in quarantine and is scanned again",
                ))
            }
        }
    }

    fn blocked(&self, sha: &str, report: &mut ScanReport) -> Result<(), Reject> {
        if let Some(label) = self.blocklist.check(sha) {
            report.blocklist_hit = true;
            report
                .warnings
                .push(format!("blocklist entry: {}", clean_text(&label, 80)));
            return Err(Reject::new("blocklisted", "this file is on the blocklist"));
        }
        Ok(())
    }

    async fn run(
        &self,
        bytes: &[u8],
        file_name: &str,
        listing: &ListingMeta,
        report: &mut ScanReport,
    ) -> Result<(Vec<u8>, Vec<u8>), Reject> {
        self.limits.check_upload(&[bytes.len() as u64])?;
        if bytes.is_empty() {
            return Err(Reject::new("empty_file", "the file is empty"));
        }
        let original_sha = report.original_sha256.clone();
        self.blocked(&original_sha, report)?;
        // Malware first: it names known-bad files better than a type error
        // does, and nothing parses the bytes before the scanner has seen them.
        self.av_scan(bytes, report).await?;
        let sniffed = sniff::sniff(bytes, &self.limits)?;

        let limits = self.limits.clone();
        let listing = listing.clone();
        let owned = bytes.to_vec();
        let work = tokio::task::spawn_blocking(move || build(&owned, sniffed, &limits, &listing));
        let built = tokio::time::timeout(self.limits.process_timeout, work)
            .await
            .map_err(|_| Reject::new("timeout", "checking the file took too long"))?
            .map_err(|_| Reject::new("internal", "the file could not be checked"))??;

        report.detected_type = Some(built.detected);
        if let Some(w) = extension_warning(file_name, built.detected) {
            report.warnings.push(w);
        }
        report.triangle_count = Some(built.facts.triangle_count);
        report.bounds_mm = Some(Bounds {
            min: built.facts.min,
            max: built.facts.max,
        });
        report.stripped.clone_from(&built.stripped);
        self.blocked(&built.payload_sha256, report)?;
        let library_sha = sha256_hex(&built.library_file);
        report.library_file_sha256 = Some(library_sha.clone());
        self.blocked(&library_sha, report)?;
        self.av_scan(&built.library_file, report).await?;
        Ok((built.library_file, built.preview))
    }
}
