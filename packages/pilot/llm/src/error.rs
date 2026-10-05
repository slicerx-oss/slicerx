// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The crate error. No variant ever holds the API key, a request header value or a body.

/// Result alias for this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Everything the transport can refuse or fail with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The provider id is not one this transport knows.
    #[error("unknown LLM provider {provider}")]
    UnknownProvider {
        /// The id from the request.
        provider: String,
    },
    /// The URL does not parse.
    #[error("request URL for {provider} is not a valid URL")]
    InvalidUrl {
        /// The provider id.
        provider: String,
    },
    /// The URL's scheme, host, port or user info is outside the provider's allowlist.
    #[error("request URL host {host} is not allowed for {provider}")]
    UrlNotAllowed {
        /// The provider id.
        provider: String,
        /// Host of the refused URL, empty when it has none.
        host: String,
    },
    /// The request carries a header the transport sets itself, such as `authorization`.
    #[error("request must not set the {name} header")]
    ForbiddenHeader {
        /// Lowercase header name.
        name: String,
    },
    /// A header name or value is not valid HTTP.
    #[error("request header {name} is not valid")]
    InvalidHeader {
        /// The header name as given.
        name: String,
    },
    /// No key for the provider in the keychain or the environment.
    #[error("no API key for {provider}")]
    MissingKey {
        /// The provider id.
        provider: String,
    },
    /// The stored key cannot be sent in an HTTP header (control characters, for example).
    #[error("the stored API key for {provider} is not a valid header value")]
    InvalidKey {
        /// The provider id.
        provider: String,
    },
    /// The provider answered with a non-2xx status.
    #[error("{status}: {message}")]
    Http {
        /// HTTP status code.
        status: u16,
        /// At most 300 characters of the provider's error message, with anything shaped
        /// like a key replaced by `[redacted]`.
        message: String,
    },
    /// Connecting, sending or reading the stream failed.
    #[error("LLM transport failed: {0}")]
    Transport(String),
}

impl Error {
    /// Keeps the kind of failure and its cause chain (TLS, DNS, I/O). reqwest errors never
    /// hold header values; the URL is dropped anyway.
    pub(crate) fn transport(e: reqwest::Error) -> Self {
        let what = if e.is_timeout() {
            "timed out"
        } else if e.is_connect() {
            "could not connect"
        } else if e.is_body() || e.is_decode() {
            "reading the response failed"
        } else if e.is_builder() {
            "could not build the request"
        } else {
            "request failed"
        };
        let e = e.without_url();
        let mut text = what.to_owned();
        let mut source = std::error::Error::source(&e);
        while let Some(cause) = source {
            text.push_str(": ");
            text.push_str(&cause.to_string());
            source = cause.source();
        }
        Error::Transport(text)
    }
}
