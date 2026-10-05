// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/// Errors from the backend and the HTTP handlers. Messages are safe to show to
/// the caller; `Backend` keeps the detail for the log and shows a generic line.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sign in, or pass an sxk_ API token")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("cloud slicing is invite only, and this account is not on the list")]
    NotInvited,
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Limit(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("this token has made too many requests this minute; retry in {0} s")]
    RateLimited(u64),
    #[error("backend: {0}")]
    Backend(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden(_) => "forbidden",
            Self::NotInvited => "not_invited",
            Self::NotFound(_) => "not_found",
            Self::BadRequest(_) => "bad_request",
            Self::Conflict(_) => "conflict",
            Self::Limit(_) | Self::TooLarge(_) | Self::RateLimited(_) => "limit",
            Self::Backend(_) => "unavailable",
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        // Without the URL: it can carry storage paths.
        Self::Backend(e.without_url().to_string())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
