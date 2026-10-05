// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The connectors' [`ApprovalGate`] over `sx-permit`'s broker.
use std::sync::Arc;

use serde_json::Value;
use sx_connect::{Action, ApprovalGate, ApprovalToken, Error, Result};
use sx_permit::ApprovalBroker;

/// Verifies tokens minted by the broker. `params` from the connectors is canonical JSON; it is
/// parsed and hashed with the broker's own `hash_params`, so the hash matches what Pilot computes
/// in TypeScript (`hashParams`).
pub struct BrokerGate(pub Arc<ApprovalBroker>);

impl ApprovalGate for BrokerGate {
    fn check(&self, token: &ApprovalToken, action: Action, printer: &str, params: &str) -> Result<()> {
        let name = action.as_str().to_owned();
        if token.token.is_empty() {
            return Err(Error::ApprovalRequired { action: name });
        }
        let invalid = |detail: String| Error::ApprovalInvalid {
            action: name.clone(),
            detail,
        };
        let value: Value =
            serde_json::from_str(params).map_err(|_| invalid("parameters are not JSON".to_owned()))?;
        let token = sx_permit::ApprovalToken {
            request_id: token.request_id.clone(),
            token: token.token.clone(),
            expires_at: token.expires_at.clone(),
        };
        self.0
            .verify(
                &token,
                action.side_effect(),
                printer,
                &sx_permit::hash_params(&value),
            )
            .map_err(|e| invalid(e.failure_reason().unwrap_or("rejected").to_owned()))
    }
}
