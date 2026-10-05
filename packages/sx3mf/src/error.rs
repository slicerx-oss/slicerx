// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The single error type of the crate.

/// Everything that can go wrong reading or writing an .sx3mf file.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The zip structure could not be read or written.
    #[error("zip container error: {0}")]
    Zip(#[from] zip::result::ZipError),
    /// An I/O error while reading or writing zip data.
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    /// An XML part is not well formed.
    #[error("XML error in {part}: {source}")]
    Xml {
        /// Part name.
        part: String,
        /// The underlying parser error.
        #[source]
        source: quick_xml::Error,
    },
    /// An XML part uses a DOCTYPE or an entity other than the five predefined ones.
    #[error("{part} uses a DOCTYPE or a custom entity, which the format does not allow")]
    ForbiddenXml {
        /// Part name.
        part: String,
    },
    /// A part is well formed XML but does not follow the format.
    #[error("{part} is malformed: {reason}")]
    Malformed {
        /// Part name.
        part: String,
        /// What is wrong.
        reason: &'static str,
    },
    /// A required part is not in the package.
    #[error("missing part {0}")]
    MissingPart(String),
    /// A part name is empty, absolute, or tries to leave the package.
    #[error("unsafe part name {0:?}")]
    UnsafePartName(String),
    /// The package has more entries than the reader accepts.
    #[error("package has {count} entries, the limit is {max}")]
    TooManyEntries {
        /// Entries in the archive.
        count: usize,
        /// Reader limit.
        max: usize,
    },
    /// A part is larger than its limit.
    #[error("{part} is larger than the limit of {max} bytes")]
    PartTooLarge {
        /// Part name.
        part: String,
        /// Limit in bytes.
        max: u64,
    },
    /// A value to be written contains a character the format does not allow.
    #[error("value of {field} contains a character that is not allowed")]
    InvalidValue {
        /// Field name.
        field: &'static str,
    },
}
