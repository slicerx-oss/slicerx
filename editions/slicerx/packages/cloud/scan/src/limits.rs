// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Every size and count the pipeline enforces, in one place.

const MIB: u64 = 1024 * 1024;

/// Limits for one upload. The defaults are the production values.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Largest single file.
    pub max_file_bytes: u64,
    /// Largest total of all files in one upload request.
    pub max_upload_bytes: u64,
    /// Most entries in a zip archive.
    pub max_entries: usize,
    /// Largest uncompressed size of one archive entry.
    pub max_entry_bytes: u64,
    /// Largest declared uncompressed total of one archive.
    pub max_total_bytes: u64,
    /// Highest uncompressed-to-compressed ratio of one entry or of the whole
    /// archive. Entries under `ratio_floor_bytes` are exempt: a 4 KB XML file
    /// can honestly compress 1000 to 1.
    pub max_ratio: u64,
    /// Uncompressed size below which the ratio check does not apply.
    pub ratio_floor_bytes: u64,
    /// Longest entry name, in bytes.
    pub max_name_bytes: usize,
    /// Deepest entry path.
    pub max_path_depth: usize,
    /// Largest XML part other than a model part.
    pub max_xml_part_bytes: u64,
    /// Deepest element nesting in any XML part.
    pub max_xml_depth: usize,
    /// Longest side of a thumbnail or texture PNG, in pixels.
    pub max_png_side: u32,
    /// Most triangles in a model.
    pub max_triangles: usize,
    /// Longest side of the model bounds, in millimeters.
    pub max_extent_mm: f32,
    /// Wall-clock budget for parsing, checking and converting one upload.
    pub process_timeout: std::time::Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 150 * MIB,
            max_upload_bytes: 300 * MIB,
            max_entries: 256,
            max_entry_bytes: 256 * MIB,
            max_total_bytes: 512 * MIB,
            max_ratio: 200,
            ratio_floor_bytes: MIB,
            max_name_bytes: 255,
            max_path_depth: 16,
            max_xml_part_bytes: 4 * MIB,
            max_xml_depth: 64,
            max_png_side: 2048,
            max_triangles: 5_000_000,
            max_extent_mm: 10_000.0,
            process_timeout: std::time::Duration::from_secs(60),
        }
    }
}

impl Limits {
    /// Checks the sizes of all files of one upload request against the
    /// per-file and per-upload caps.
    pub fn check_upload(&self, sizes: &[u64]) -> Result<(), crate::Reject> {
        let mut total: u64 = 0;
        for &s in sizes {
            if s > self.max_file_bytes {
                return Err(crate::Reject::new(
                    "file_too_large",
                    format!("a file is {s} bytes, the limit is {} bytes", self.max_file_bytes),
                ));
            }
            total = total.saturating_add(s);
        }
        if total > self.max_upload_bytes {
            return Err(crate::Reject::new(
                "upload_too_large",
                format!(
                    "the upload is {total} bytes, the limit is {} bytes",
                    self.max_upload_bytes
                ),
            ));
        }
        Ok(())
    }
}
