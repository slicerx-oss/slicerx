// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Wire types mirroring the approval section of `packages/contracts/src/pilot.ts`.
use serde::{Deserialize, Serialize};

/// Permission class of the tool that asked for approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionClass {
    /// Always allowed.
    Read,
    /// Slice and arrange in the project.
    Slice,
    /// Send plates to a printer queue.
    Queue,
    /// Heat or move a printer.
    Start,
    /// Write saved profiles.
    Profile,
    /// Change printer firmware or config settings, such as failure detection.
    PrinterConfig,
    /// Send or publish something outside the app.
    Share,
}

/// One host call an approval covers. `params_hash` is [`crate::hash_params`] of the
/// parameters the host itself sees for that call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAction {
    /// A `SideEffectAction` such as `printer.start` or `profile.write`.
    pub action: String,
    /// Printer id, plugin id, profile id or project id. Never empty.
    pub target: String,
    /// 64 lowercase hex characters.
    pub params_hash: String,
}

/// A pending approval shown on the approval card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    /// Unique per broker.
    pub id: String,
    /// Pilot session that asked.
    pub session_id: String,
    /// Tool name, such as `moonraker.start`.
    pub tool: String,
    /// Permission class of the tool.
    pub permission: PermissionClass,
    /// One line question shown on the card.
    pub title: String,
    /// Detail lines shown under the title.
    pub lines: Vec<String>,
    /// Fleet printer the request is about, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub printer_id: Option<String>,
    /// SHA-256 of the canonical JSON of the tool input as the model sent it.
    pub params_hash: String,
    /// Every host call the approval unlocks, each usable once.
    pub actions: Vec<ApprovalAction>,
    /// When the card stops waiting for a decision, ISO 8601.
    pub expires_at: String,
    /// Where a print start came from (`pilot`, `mcp`, `phone`, `queue`, `schedule`, `inbox`).
    /// Absent counts as remote. `local_click` is refused here: the hub mints local starts itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<crate::start::StartOrigin>,
}

/// Minted by [`crate::ApprovalBroker::grant`]. Never shown to the model and never written
/// to a session log. `Debug` leaves the token out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalToken {
    /// The request this token was granted for.
    pub request_id: String,
    /// Base64url (no padding) HMAC-SHA256 over the request and the expiry.
    pub token: String,
    /// Expiry, ISO 8601 with milliseconds in UTC, as `Date.toISOString()` writes it.
    pub expires_at: String,
}

impl std::fmt::Debug for ApprovalToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalToken")
            .field("request_id", &self.request_id)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}
