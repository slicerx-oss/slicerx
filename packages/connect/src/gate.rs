// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Minted by the host (sx-permit) after the user approves. Single use. Mirrors
/// `ApprovalToken` in `packages/contracts/src/pilot.ts`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalToken {
    pub request_id: String,
    pub token: String,
    pub expires_at: String,
}

impl std::fmt::Debug for ApprovalToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalToken")
            .field("request_id", &self.request_id)
            .finish_non_exhaustive()
    }
}

/// What a token can authorize. `PluginCall` covers tools of service plugins that change something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Upload,
    Start,
    Pause,
    Resume,
    Cancel,
    Gcode,
    PluginCall,
    /// A change to a running print: fan, speed factor, nozzle or bed temperature.
    Adjust,
}

impl Action {
    /// The name the approval broker knows the action by.
    pub fn side_effect(self) -> &'static str {
        match self {
            Action::Upload => "printer.upload",
            Action::Start => "printer.start",
            Action::Pause => "printer.pause",
            Action::Resume => "printer.resume",
            Action::Cancel => "printer.cancel",
            Action::Gcode => "printer.gcode",
            Action::PluginCall => "plugin.call",
            Action::Adjust => "printer.adjust",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Action::Upload => "upload",
            Action::Start => "start",
            Action::Pause => "pause",
            Action::Resume => "resume",
            Action::Cancel => "cancel",
            Action::Gcode => "gcode",
            Action::PluginCall => "plugin_call",
            Action::Adjust => "adjust",
        }
    }
}

/// Canonical parameter strings, one per host call. They are the canonical JSON (sorted keys,
/// no whitespace) of the same objects the TS side hashes with `hashParams` in
/// `@slicerx/contracts`, so an adapter can compute `sha256(params)` and call
/// `sx_permit` with the hash. Shapes:
///
/// - upload: `{printerId, name, sha256}`
/// - start: `{printerId, name, opts}` (`opts` is `{}` when empty), plus `sha256` when the file's
///   content hash is known (it went up through SlicerX), so a token covers that content only
/// - pause, resume, cancel: `{printerId}`
/// - gcode: `{printerId, line}`
/// - plugin call: `{pluginId, tool, input}` (`tool` without the `<id>.` prefix)
/// - adjust: `{printerId, change}` with `change` as [`crate::Adjustment`] serializes it, or
///   `{printerId, slot}` with `slot` as [`crate::SlotSetting`] serializes it
pub mod params {
    use serde_json::{Value, json};

    use crate::types::{RemoteFile, StartOptions};

    fn canon(v: &Value) -> String {
        // serde_json keeps object keys sorted (no `preserve_order`), and `to_string` has no
        // whitespace, which is the canonical form.
        v.to_string()
    }

    pub fn upload(printer: &str, name: &str, sha256: &str) -> String {
        canon(&json!({ "printerId": printer, "name": name, "sha256": sha256 }))
    }

    pub fn start(printer: &str, file: &RemoteFile, opts: &StartOptions) -> String {
        let opts = serde_json::to_value(opts).unwrap_or_else(|_| json!({}));
        match &file.sha256 {
            Some(sha) => {
                canon(&json!({ "printerId": printer, "name": file.name, "opts": opts, "sha256": sha }))
            }
            None => canon(&json!({ "printerId": printer, "name": file.name, "opts": opts })),
        }
    }

    pub fn printer(printer: &str) -> String {
        canon(&json!({ "printerId": printer }))
    }

    pub fn gcode(printer: &str, line: &str) -> String {
        canon(&json!({ "printerId": printer, "line": line }))
    }

    pub fn adjust(printer: &str, change: &crate::types::Adjustment) -> String {
        let change = serde_json::to_value(change).unwrap_or(Value::Null);
        canon(&json!({ "printerId": printer, "change": change }))
    }

    /// The chamber light switched on or off, as a `printer.adjust`.
    pub fn light(printer: &str, on: bool) -> String {
        canon(&json!({ "printerId": printer, "light": on }))
    }

    /// A filament slot written to the printer, approved as a `printer.adjust`.
    pub fn slot(printer: &str, setting: &crate::types::SlotSetting) -> String {
        let slot = serde_json::to_value(setting).unwrap_or(Value::Null);
        canon(&json!({ "printerId": printer, "slot": slot }))
    }

    pub fn plugin(plugin: &str, tool: &str, input: &Value) -> String {
        canon(&json!({ "pluginId": plugin, "tool": tool, "input": input }))
    }
}

/// Longest G-code line a person may approve: short enough that every approval card shows it
/// whole (`WorkSummary` in packages/pair allows the same).
pub const MAX_GCODE_LINE: usize = 96;

/// Why `line` is not one G-code command a card can show whole, or `None` when it is: 1 to
/// [`MAX_GCODE_LINE`] printable ASCII characters. A line break would let a long first command hide
/// a second one that Moonraker and OctoPrint run as well; other control characters and non-ASCII
/// text (bidirectional overrides, zero-width marks) can change what the card appears to say.
#[must_use]
pub fn gcode_line_problem(line: &str) -> Option<&'static str> {
    if line.trim().is_empty() {
        Some("the G-code line is empty")
    } else if line.len() > MAX_GCODE_LINE {
        Some("one G-code line of at most 96 characters at a time")
    } else if !line.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        Some("one G-code line at a time, printable ASCII only (no line breaks or control characters)")
    } else {
        None
    }
}

/// [`gcode_line_problem`] as a driver error. Every driver calls it before the token check, so one
/// call sends one command whatever the caller let through.
pub(crate) fn one_gcode_line(printer: &str, line: &str) -> Result<()> {
    gcode_line_problem(line).map_or(Ok(()), |why| Err(Error::protocol(printer, why)))
}

/// Verifies and consumes an approval token. Every driver calls it before the first byte of
/// a side effect leaves the machine. `params` is a short description of the target of the
/// call, the canonical JSON built by [`params`], so a token for one target fails for another.
///
/// The app implements this over `sx_permit::ApprovalBroker::verify`.
pub trait ApprovalGate: Send + Sync {
    fn check(&self, token: &ApprovalToken, action: Action, printer: &str, params: &str) -> Result<()>;
}

/// In-process gate for tests and the demo: mints single-use tokens bound to an action,
/// a printer and a parameter string, valid for five minutes.
#[derive(Default)]
pub struct MemoryGate {
    inner: Mutex<MemoryGateInner>,
}

#[derive(Default)]
struct MemoryGateInner {
    counter: u64,
    live: HashMap<String, (Action, String, String, Instant)>,
}

impl MemoryGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mint(&self, action: Action, printer: &str, params: &str) -> ApprovalToken {
        let mut g = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        g.counter += 1;
        let token = format!("mem-{}-{}", g.counter, action.as_str());
        g.live.insert(
            token.clone(),
            (
                action,
                printer.to_owned(),
                params.to_owned(),
                Instant::now() + Duration::from_secs(300),
            ),
        );
        ApprovalToken {
            request_id: format!("req-{}", g.counter),
            token,
            expires_at: String::new(),
        }
    }
}

impl ApprovalGate for MemoryGate {
    fn check(&self, token: &ApprovalToken, action: Action, printer: &str, params: &str) -> Result<()> {
        let bad = |detail: &str| Error::ApprovalInvalid {
            action: action.as_str().to_owned(),
            detail: detail.to_owned(),
        };
        if token.token.is_empty() {
            return Err(Error::ApprovalRequired {
                action: action.as_str().to_owned(),
            });
        }
        let mut g = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some((a, p, prm, exp)) = g.live.remove(&token.token) else {
            return Err(bad("unknown or already used"));
        };
        if exp < Instant::now() {
            return Err(bad("expired"));
        }
        if a != action {
            return Err(bad("minted for another action"));
        }
        if p != printer {
            return Err(bad("minted for another printer"));
        }
        if prm != params {
            return Err(bad("minted for other parameters"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_use_and_bound() {
        let g = MemoryGate::new();
        let t = g.mint(Action::Start, "bay-1", "a");
        assert!(
            g.check(&t, Action::Pause, "bay-1", "a").is_err(),
            "wrong action consumed it"
        );
        let t = g.mint(Action::Start, "bay-1", "a");
        assert!(g.check(&t, Action::Start, "bay-2", "a").is_err());
        let t = g.mint(Action::Start, "bay-1", "a");
        assert!(g.check(&t, Action::Start, "bay-1", "b").is_err());
        let t = g.mint(Action::Start, "bay-1", "a");
        g.check(&t, Action::Start, "bay-1", "a").unwrap();
        assert!(
            g.check(&t, Action::Start, "bay-1", "a").is_err(),
            "reuse must fail"
        );
    }
}
