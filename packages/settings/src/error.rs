// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Errors for profile and preset bundle import.

/// Why a profile could not be imported.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("profile is not a JSON object")]
    NotObject,
    #[error("inherits cycle at \"{0}\"")]
    Cycle(String),
    #[error("parent profile \"{parent}\" not found (needed by \"{child}\")")]
    MissingParent { parent: String, child: String },
    #[error("inherits chain is too deep")]
    TooDeep,
    #[error("invalid request: {0}")]
    Request(String),
    /// A preset bundle that holds nothing to import; the text is for a person.
    #[error("{0}")]
    Bundle(String),
}
