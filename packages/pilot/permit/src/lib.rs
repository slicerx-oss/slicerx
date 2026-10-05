// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-permit. See README.md for the public API.
//!
//! The approval broker behind every Pilot side effect. A pending [`ApprovalRequest`] is
//! registered when the permission gate asks the user, [`ApprovalBroker::grant`] mints an
//! HMAC-signed [`ApprovalToken`] when the user presses the approve button, and every host
//! call with a side effect runs [`ApprovalBroker::verify`] before it acts. Each action a
//! request lists verifies once, and the token dies 5 minutes after the grant.
//!
//! The TypeScript mirror is `packages/pilot/src/permit/broker.ts`; both follow the same rules.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

mod broker;
mod canonical;
mod error;
mod start;
mod types;

pub use broker::{ApprovalBroker, Clock, GrantInfo, SystemClock, TOKEN_TTL};
pub use canonical::{canonical_json, hash_params};
pub use error::{Error, Result};
pub use start::{
    BED_ANSWER_FRESH_MS, BedError, BedRecord, BedState, JobPhase, Plate, REPRINT_GAP_MS, StandingApproval,
    StandingCheck, StandingError, StartOrigin, StartRefusal, StartRequirement, WATCH_GAP_MS, check_start,
    start_requirement,
};
pub use types::{ApprovalAction, ApprovalRequest, ApprovalToken, PermissionClass};
