// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Turning a checked 3MF into the library's sx3mf: the same package with the
//! listing's `sx:` metadata in its model part and the preview as thumbnail.

use ::sx3mf::Sx3mfMetadata;

use crate::reject::Reject;

/// The listing an upload becomes. The store assigns the ids and slugs before
/// the scan, and the uploader supplies the title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingMeta {
    pub listing_id: String,
    pub listing_slug: String,
    pub version_id: String,
    /// The creator's id (`creators.id`), written as `sx:Creator`.
    pub creator_id: String,
    pub version_number: String,
    pub creator_slug: String,
    pub creator_name: String,
    pub title: String,
}

/// Removes control characters, collapses whitespace runs and cuts to `max`
/// characters.
pub fn clean_text(s: &str, max: usize) -> String {
    let joined: String = s
        .chars()
        .map(|c| {
            if c.is_control() || c.is_whitespace() {
                ' '
            } else {
                c
            }
        })
        .collect();
    joined
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

impl ListingMeta {
    /// Cleans the free-text fields. An empty title is an error.
    pub fn cleaned(&self) -> Result<Self, Reject> {
        let title = clean_text(&self.title, 120);
        if title.is_empty() {
            return Err(Reject::new("title_required", "the listing needs a title"));
        }
        Ok(Self {
            title,
            creator_name: clean_text(&self.creator_name, 80),
            ..self.clone()
        })
    }
}

/// True when a package is an sx3mf rather than a plain 3MF. Both are checked
/// the same way; this only names the detected type in the report.
pub fn is_sx3mf(bytes: &[u8]) -> bool {
    ::sx3mf::inspect(bytes).is_ok_and(|i| i.is_sx3mf)
}

/// Builds the library file: the sanitized 3MF with the listing's `sx:`
/// entries (any the uploader's file carried, including `sx:ExportedBy`, are
/// replaced) and the preview as package thumbnail. Every other part is kept
/// byte for byte. The result is read back with `sx3mf::inspect` before it is
/// returned.
pub fn build_library_file(
    sanitized_3mf: &[u8],
    listing: &ListingMeta,
    preview_png: Option<&[u8]>,
) -> Result<Vec<u8>, Reject> {
    let listing = listing.cleaned()?;
    let meta = Sx3mfMetadata {
        listing: Some(listing.listing_id),
        version: Some(listing.version_number),
        version_id: Some(listing.version_id),
        creator: Some(listing.creator_id),
        exported_by: None,
    };
    let bytes = ::sx3mf::stamp(sanitized_3mf, &meta, preview_png)
        .map_err(|e| Reject::new("convert_failed", format!("cannot write the sx3mf: {e}")))?;
    let info = ::sx3mf::inspect(&bytes)
        .map_err(|e| Reject::new("convert_failed", format!("the sx3mf did not read back: {e}")))?;
    if info.metadata != meta {
        return Err(Reject::new(
            "convert_failed",
            "the sx3mf metadata did not read back",
        ));
    }
    Ok(bytes)
}
