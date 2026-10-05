// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The scan report the moderation queue stores. JSON field names are camelCase.

use serde::Serialize;

/// The result of the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Every check passed. A converted file exists and waits for a moderator.
    Clean,
    /// A check failed. Nothing is stored except the report.
    Rejected,
    /// The malware scanner did not answer. The file is not approved and the
    /// upload is scanned again.
    ScanUnavailable,
}

/// The type found from content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectedType {
    Stl,
    #[serde(rename = "3mf")]
    ThreeMf,
    Sx3mf,
}

impl DetectedType {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Stl => "stl",
            Self::ThreeMf => "3mf",
            Self::Sx3mf => "sx3mf",
        }
    }
}

/// Axis-aligned bounds in millimeters.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Bounds {
    pub min: [f32; 3],
    pub max: [f32; 3],
}

/// What the malware scanner said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerInfo {
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature_version: Option<String>,
    /// `clean`, `infected`, `unavailable` or `skipped`.
    pub result: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Everything the pipeline learned about one upload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub verdict: Verdict,
    /// Stable codes, one per failed check.
    pub reason_codes: Vec<&'static str>,
    /// The same reasons in words for the uploader and the moderator.
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub original_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_type: Option<DetectedType>,
    pub original_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_file_sha256: Option<String>,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triangle_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_mm: Option<Bounds>,
    /// Entries removed from the archive, as `name: reason`.
    pub stripped: Vec<String>,
    pub scanner: ScannerInfo,
    pub blocklist_hit: bool,
    /// Filled in by the service when it stores the files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quarantine_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_path: Option<String>,
}
