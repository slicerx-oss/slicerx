// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The crate error. Messages name request ids and action indexes, never tokens or secrets.

/// Result alias for this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Everything the broker can refuse.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// `register` was called twice with the same request id.
    #[error("approval request {request_id} is already registered")]
    Duplicate {
        /// The repeated id.
        request_id: String,
    },
    /// An action in the request has an empty target or a parameter hash that is not
    /// 64 lowercase hex characters.
    #[error("approval request {request_id} has a malformed action at index {index}")]
    MalformedAction {
        /// The request id.
        request_id: String,
        /// Position of the first bad action in `actions`.
        index: usize,
    },
    /// No request with this id was registered, or it was never granted.
    #[error("unknown approval request {request_id}")]
    Unknown {
        /// The id the caller passed.
        request_id: String,
    },
    /// `grant` was called on a request that is no longer pending.
    #[error("approval request {request_id} was already {state}")]
    NotPending {
        /// The request id.
        request_id: String,
        /// `granted` or `denied`.
        state: &'static str,
    },
    /// The user denied the request, or it was revoked after the grant.
    #[error("approval request {request_id} was denied")]
    Denied {
        /// The request id.
        request_id: String,
    },
    /// The token does not carry this broker's signature for the request.
    #[error("approval token signature does not match")]
    BadSignature,
    /// The token is past its expiry.
    #[error("approval token has expired")]
    Expired,
    /// The request does not list this action, target and parameter hash.
    #[error("approval token does not cover {action} on {target} with these parameters")]
    Mismatch {
        /// The action the host asked for.
        action: String,
        /// The target the host asked for.
        target: String,
    },
    /// This action was already verified once with the token.
    #[error("approval token was already used for {action} on {target}")]
    Used {
        /// The action the host asked for.
        action: String,
        /// The target the host asked for.
        target: String,
    },
    /// `register` got a `local_click` request, or `mint` a request whose origin needs a card.
    #[error("approval request {request_id} has an origin that cannot be used this way")]
    Origin {
        /// The request id.
        request_id: String,
    },
    /// The operating system random source failed while creating the broker secret.
    #[error("system random source unavailable")]
    Random,
}

impl Error {
    /// The `ApprovalFailure` string from `packages/contracts/src/pilot.ts` for a failed
    /// `verify`, or `None` for errors `verify` does not return.
    pub fn failure_reason(&self) -> Option<&'static str> {
        match self {
            Error::Unknown { .. } => Some("unknown"),
            Error::Denied { .. } => Some("denied"),
            Error::BadSignature => Some("bad_signature"),
            Error::Expired => Some("expired"),
            Error::Mismatch { .. } => Some("mismatch"),
            Error::Used { .. } => Some("used"),
            Error::Duplicate { .. }
            | Error::MalformedAction { .. }
            | Error::NotPending { .. }
            | Error::Origin { .. }
            | Error::Random => None,
        }
    }
}
