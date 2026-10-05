// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx3mf: the open `.sx3mf` project format.
//!
//! An `.sx3mf` file is a complete 3MF project (geometry, plates, settings and
//! thumbnails, laid out as Bambu Studio and `OrcaSlicer` write them) whose model part
//! carries a few `sx:` metadata entries: the library model id, its creator and
//! the person who exported it. Nothing in the geometry changes, so every 3MF
//! reader opens it. This crate reads those entries, writes them into a model
//! part, and stamps them into an existing 3MF package. `SPEC.md` is the format
//! description.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

mod error;
mod package;
mod xml;

#[cfg(test)]
mod tests;

use serde::Serialize;

pub use error::Error;
pub use package::{
    MAX_ENTRIES, MAX_METADATA_BYTES, MAX_MODEL_PART_BYTES, MAX_THUMBNAIL_BYTES, MAX_XML_PART_BYTES, inspect,
    stamp,
};

/// XML namespace bound to the `sx` prefix in the model part.
pub const NAMESPACE: &str = "https://slicerx.app/schemas/sx3mf/2026";
/// Default part name of the 3MF model.
pub const MODEL_PART: &str = "/3D/3dmodel.model";
/// Part name the package thumbnail is written to by [`stamp`].
pub const THUMBNAIL_PART: &str = "/Metadata/thumbnail.png";
/// Relationship type of the 3MF model.
pub const MODEL_REL: &str = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
/// Relationship type of the package thumbnail.
pub const THUMBNAIL_REL: &str =
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail";

/// The `sx:` metadata entries of the model part. `None` entries are omitted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sx3mfMetadata {
    /// `sx:Listing`: the library model id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing: Option<String>,
    /// `sx:Version`: the listing version number, for example `1.2.0`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// `sx:VersionId`: the listing version id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    /// `sx:Creator`: the creator id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    /// `sx:ExportedBy`: the id of the account that exported the file. Empty
    /// when exported signed out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exported_by: Option<String>,
}

impl Sx3mfMetadata {
    /// The entries in the order they are written.
    pub(crate) fn entries(&self) -> [(&'static str, Option<&str>); 5] {
        [
            ("sx:Listing", self.listing.as_deref()),
            ("sx:Version", self.version.as_deref()),
            ("sx:VersionId", self.version_id.as_deref()),
            ("sx:Creator", self.creator.as_deref()),
            ("sx:ExportedBy", self.exported_by.as_deref()),
        ]
    }

    pub(crate) fn set(&mut self, name: &str, value: String) {
        let slot = match name {
            "sx:Listing" => &mut self.listing,
            "sx:Version" => &mut self.version,
            "sx:VersionId" => &mut self.version_id,
            "sx:Creator" => &mut self.creator,
            "sx:ExportedBy" => &mut self.exported_by,
            _ => return,
        };
        *slot = Some(value);
    }

    /// True when no entry is set.
    pub fn is_empty(&self) -> bool {
        self.entries().iter().all(|(_, v)| v.is_none())
    }
}

/// What [`inspect`] learns from a 3MF or .sx3mf package.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sx3mfInfo {
    /// True when the model part binds the `sx` prefix to [`NAMESPACE`] or
    /// carries any `sx:` entry. A plain 3MF reads as `false`.
    pub is_sx3mf: bool,
    /// Part name of the root model, for example `/3D/3dmodel.model`.
    pub model_part: String,
    /// The `sx:` entries.
    #[serde(flatten)]
    pub metadata: Sx3mfMetadata,
    /// The standard 3MF `Title` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The standard 3MF `Designer` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub designer: Option<String>,
    /// The standard 3MF `Application` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    /// Bytes of the package thumbnail, when the package has one. Not part of
    /// the JSON form.
    #[serde(skip)]
    pub thumbnail_png: Option<Vec<u8>>,
}

/// Inserts or replaces the `sx:` metadata entries in an existing 3MF model
/// XML, binding `xmlns:sx` to [`NAMESPACE`]. Everything else in the document
/// is kept. Entries that are `None` in `meta` are removed, so calling this
/// twice with the same input gives the same output.
pub fn write_metadata(model_xml: &str, meta: &Sx3mfMetadata) -> Result<String, Error> {
    xml::rewrite_model(model_xml, meta)
}
