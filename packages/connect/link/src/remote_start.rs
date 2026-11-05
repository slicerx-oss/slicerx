// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Remote start: an approver phone away from home may approve a card that starts a print (an
//! agent's or partner's print, or a queued plate), but only when all of this holds (docs/safety.md,
//! owner decision 2026-11-05):
//!
//! - the person turned remote start on for that printer (`remoteStart.set`, off by default), with
//!   nozzle and bed limits no higher than the printer catalog's for that model;
//! - the camera guard watches the printer, and the guard's own detector compared a still of the plate
//!   with the person's empty-plate picture and found it clear. The still is at most [`PLATE_PASS`]
//!   old on the hub's monotonic clock, was taken after the last print ended, and is not the same
//!   bytes as the look before it or the empty-plate picture (a frozen feed);
//! - a second such check at the approval passes too;
//! - the file was read once (capped in size and time) and heats the nozzle and bed within the limits,
//!   names no chamber and nothing the reader cannot vouch for;
//! - the person ticked that the plate is clear, signed with the decision.
//!
//! Then, right before the start command (after the upload, or when a queued plate's turn comes), a
//! third fresh check must pass the same way, and the start must come within [`START_WITHIN`] of the
//! approval; no answer, "cannot tell", a failed comparison or a frozen feed refuses it. The phone
//! shows the still beside the empty-plate picture (`plate.check`) before the person approves.
//! Pausing, stopping and skipping one object need none of this: they only stop extrusion.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::hub::{iso, lock};
use crate::rpc::{Bridge, Rpc, RpcError, str_arg};

/// How old the plate still a remote start relies on may be: 60 seconds. The check itself takes up
/// to 8 seconds, the relay round trip and reading two pictures side by side fit well inside a
/// minute, and anything longer gives someone time to put something on the plate after the picture.
/// The window also bounds a stale card: the phone takes a new look with Check again.
pub(crate) const PLATE_PASS: Duration = Duration::from_secs(60);
/// The longest from a remote approval to the start command: three minutes, room for an upload over
/// the network. A start that comes later is refused and the person approves again.
pub(crate) const START_WITHIN: Duration = Duration::from_secs(180);
/// The default limits for a remote start: PLA and PETG fit, while hotter materials (and a PTFE-lined
/// hotend above about 240 degrees) wait for someone at the printer unless the person raises them.
pub(crate) const DEFAULT_MAX_NOZZLE_C: u32 = 240;
pub(crate) const DEFAULT_MAX_BED_C: u32 = 80;
const NOZZLE_RANGE: std::ops::RangeInclusive<u32> = 150..=300;
const BED_RANGE: std::ops::RangeInclusive<u32> = 0..=120;
/// Files whose heat is kept, at most.
const HEAT_KEPT: usize = 256;
/// The longest a file read may take before it counts as unreadable.
const HEAT_WAIT: Duration = Duration::from_secs(15);

/// One printer's remote start setting. Present in the hub's settings only while it is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteStart {
    pub max_nozzle_c: u32,
    pub max_bed_c: u32,
}

impl Default for RemoteStart {
    fn default() -> Self {
        Self {
            max_nozzle_c: DEFAULT_MAX_NOZZLE_C,
            max_bed_c: DEFAULT_MAX_BED_C,
        }
    }
}

/// A start approved from afar, waiting for its start command.
struct Approved {
    at: Instant,
}

/// Remote start's working state on the hub.
#[derive(Default)]
pub(crate) struct State {
    /// What each file heats, by content hash: `None` while it is being read.
    heat: Mutex<HashMap<String, Option<sx_connect::JobHeat>>>,
    /// Starts approved from afar, by request id (an agent's print) or queue item id.
    approved: Mutex<HashMap<String, Approved>>,
    /// Cards for queued plates a client asked for (`queue.start`), by request id, with who asked.
    /// Denying one leaves the plate in the queue.
    pub(crate) asked: Mutex<HashMap<String, String>>,
    /// Each printer's hard cap on the limits, from the catalog for its vendor and model, or the
    /// defaults when the catalog does not know it. A printer not looked up yet gets the defaults.
    caps: Mutex<HashMap<String, (u32, u32)>>,
}

/// Why a remote start was refused. `reason()` is the machine word, `message()` what the phone says.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Why {
    Off,
    GuardOff,
    PlateMissing,
    PlateStale,
    PlateFailed,
    PlateNotCompared,
    PlateFrozen,
    NoAnswer,
    BedAnswer,
    HeatPending,
    HeatUnknown,
    Chamber,
    TooHot {
        heater: &'static str,
        want: f64,
        max: u32,
    },
    StartLate,
}

impl Why {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Why::Off => "off",
            Why::GuardOff => "guard_off",
            Why::PlateMissing => "plate_missing",
            Why::PlateStale => "plate_stale",
            Why::PlateFailed => "plate_failed",
            Why::PlateNotCompared => "plate_not_compared",
            Why::PlateFrozen => "plate_frozen",
            Why::NoAnswer => "no_answer",
            Why::BedAnswer => "bed_answer",
            Why::HeatPending => "heat_pending",
            Why::HeatUnknown => "heat_unknown",
            Why::Chamber => "chamber",
            Why::TooHot { .. } => "too_hot",
            Why::StartLate => "start_late",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Why::Off => "remote start is off for this printer; turn it on in the printer's settings, or start it at home".into(),
            Why::GuardOff => "the camera guard is off for this printer, so nothing can check the plate".into(),
            Why::PlateMissing => "no plate check has passed yet; check the plate on the card first".into(),
            Why::PlateStale => format!(
                "the plate check is more than {} seconds old; check the plate again",
                PLATE_PASS.as_secs()
            ),
            Why::PlateFailed => "the plate check found something on the plate, or could not tell".into(),
            Why::PlateNotCompared => "the plate check did not compare the plate with an empty-plate picture; take one at the printer first".into(),
            Why::PlateFrozen => "the camera sent the same picture again, so it may have stopped; check the camera".into(),
            Why::NoAnswer => "the camera guard did not answer the plate check".into(),
            Why::BedAnswer => "confirm on the card that the plate is clear".into(),
            Why::HeatPending => "the file is still being checked; try again in a moment".into(),
            Why::HeatUnknown => "the file's temperatures cannot all be read, so it waits for someone at the printer".into(),
            Why::Chamber => "the file sets a chamber heater, which waits for someone at the printer".into(),
            Why::TooHot { heater, want, max } => format!(
                "the file heats the {heater} to {want:.0} °C, above this printer's remote start limit of {max} °C"
            ),
            Why::StartLate => format!(
                "the start did not come within {} minutes of the approval; approve it again",
                START_WITHIN.as_secs() / 60
            ),
        }
    }

    /// The phone's error code: `not_supported` for what a new look cannot change, else `forbidden`.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Why::Off | Why::GuardOff | Why::HeatUnknown | Why::Chamber | Why::TooHot { .. } => {
                "not_supported"
            }
            _ => "forbidden",
        }
    }
}

/// The plate check a remote start relies on, as `plate_pass` reads it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Look {
    /// How long ago the hub took the still, on its monotonic clock.
    pub age: Duration,
    /// When the hub took it on the wall clock, against the last print's end.
    pub taken_ms: u64,
    pub clear: Option<bool>,
    pub compared: bool,
    pub frozen: bool,
}

impl From<&crate::guard::PlateLook> for Look {
    fn from(l: &crate::guard::PlateLook) -> Self {
        Self {
            age: l.taken.elapsed(),
            taken_ms: l.still.captured_at_ms,
            clear: l.clear,
            compared: l.compared,
            frozen: l.frozen,
        }
    }
}

/// Whether a plate check is a pass a remote start may rely on now: clear, compared by the detector
/// with the empty-plate picture, a still that moved, taken after the last print ended and at most
/// [`PLATE_PASS`] ago.
pub(crate) fn plate_pass(look: Option<Look>, ended_at: Option<u64>) -> Result<(), Why> {
    let l = look.ok_or(Why::PlateMissing)?;
    if l.clear != Some(true) {
        return Err(Why::PlateFailed);
    }
    if !l.compared {
        return Err(Why::PlateNotCompared);
    }
    if l.frozen {
        return Err(Why::PlateFrozen);
    }
    // A still from before the last print ended shows the plate as it was before that print.
    if l.age > PLATE_PASS || ended_at.is_some_and(|e| l.taken_ms <= e) {
        return Err(Why::PlateStale);
    }
    Ok(())
}

/// The temperature and chamber rule. `None` is a file still being read. Anything the reader could
/// not vouch for, any chamber command and an unreadable nozzle refuse; nozzle and bed must be within
/// the limits. A file that never sets the bed does not heat it.
pub(crate) fn heat_ok(limits: RemoteStart, heat: Option<&sx_connect::JobHeat>) -> Result<(), Why> {
    let h = heat.ok_or(Why::HeatPending)?;
    if h.unknown.is_some() {
        return Err(Why::HeatUnknown);
    }
    if h.chamber.is_some() {
        return Err(Why::Chamber);
    }
    let nozzle = h.nozzle.ok_or(Why::HeatUnknown)?;
    if nozzle > f64::from(limits.max_nozzle_c) {
        return Err(Why::TooHot {
            heater: "nozzle",
            want: nozzle,
            max: limits.max_nozzle_c,
        });
    }
    if let Some(bed) = h.bed
        && bed > f64::from(limits.max_bed_c)
    {
        return Err(Why::TooHot {
            heater: "bed",
            want: bed,
            max: limits.max_bed_c,
        });
    }
    Ok(())
}

/// The printer's remote start setting, `None` while it is off, clamped again to the printer's cap on
/// every read (a setting from an older hub, or a printer whose model changed, never goes above it).
pub(crate) fn policy(b: &Bridge, printer: &str) -> Option<RemoteStart> {
    let stored = lock(&b.hub.settings).remote_start.get(printer).copied()?;
    let held = lock(&b.remote_start.caps).get(printer).copied();
    Some(clamp(stored, Some(held.unwrap_or_else(|| cap(None)))))
}

/// The hard cap on a printer's limits: the catalog's for its vendor and model, else the defaults.
pub(crate) fn cap(catalog: Option<(u32, u32)>) -> (u32, u32) {
    catalog.unwrap_or((DEFAULT_MAX_NOZZLE_C, DEFAULT_MAX_BED_C))
}

/// Looks the printer up in the catalog and keeps its cap for the rule's reads.
pub(crate) async fn refresh_cap(b: &Bridge, printer: &str) -> Option<(u32, u32)> {
    let catalog = catalog_for(b, printer).await;
    lock(&b.remote_start.caps).insert(printer.to_owned(), cap(catalog));
    catalog
}

/// What the rule reads about one start.
pub(crate) struct Facts {
    pub policy: Option<RemoteStart>,
    pub guard_on: bool,
    /// `None` while the file is being read.
    pub heat: Option<sx_connect::JobHeat>,
    pub look: Option<Look>,
    pub ended_at: Option<u64>,
}

/// Everything about a start that can be checked before the plate: the setting, the guard and the
/// file's heat.
pub(crate) fn rule_before_plate(f: &Facts) -> Result<(), Why> {
    let limits = f.policy.ok_or(Why::Off)?;
    if !f.guard_on {
        return Err(Why::GuardOff);
    }
    heat_ok(limits, f.heat.as_ref())
}

/// The whole rule for a start approved from afar, `bed_clear` being the person's signed answer.
pub(crate) fn rule(f: &Facts, bed_clear: bool) -> Result<(), Why> {
    rule_before_plate(f)?;
    plate_pass(f.look, f.ended_at)?;
    if !bed_clear {
        return Err(Why::BedAnswer);
    }
    Ok(())
}

/// The facts the hub holds now for a start on `printer` of the file with content hash `sha256`.
pub(crate) fn facts(b: &Bridge, printer: &str, sha256: &str) -> Facts {
    Facts {
        policy: policy(b, printer),
        guard_on: crate::guard::on(b, printer),
        heat: cached_heat(b, sha256),
        look: crate::guard::last_look(b, printer).as_ref().map(Look::from),
        ended_at: b.hub.bed(printer).ended_at_ms,
    }
}

/// What a file heats, when it was read already.
pub(crate) fn cached_heat(b: &Bridge, sha256: &str) -> Option<sx_connect::JobHeat> {
    lock(&b.remote_start.heat).get(sha256).cloned().flatten()
}

/// Reads what a file heats once, off the async threads, within [`HEAT_WAIT`], and keeps it by content
/// hash. A read that does not finish in time counts as unreadable. `data` is asked for only when the
/// file was not read yet.
pub(crate) async fn read_heat(b: &Arc<Bridge>, sha256: &str, data: impl FnOnce() -> Option<Vec<u8>>) {
    {
        let mut h = lock(&b.remote_start.heat);
        if h.contains_key(sha256) {
            return;
        }
        if h.len() >= HEAT_KEPT {
            h.clear();
        }
        h.insert(sha256.to_owned(), None);
    }
    let data = data();
    let (b2, sha) = (b.clone(), sha256.to_owned());
    // The read finishes and is kept even when the caller stops waiting for it.
    let done = tokio::spawn(async move {
        let heat = match data {
            Some(d) => {
                let read = tokio::task::spawn_blocking(move || sx_connect::job_heat(&d));
                match tokio::time::timeout(HEAT_WAIT, read).await {
                    Ok(Ok(h)) => h,
                    _ => sx_connect::JobHeat {
                        unknown: Some("reading the file took too long".into()),
                        ..sx_connect::JobHeat::default()
                    },
                }
            }
            None => sx_connect::JobHeat {
                unknown: Some("the file is not on the hub".into()),
                ..sx_connect::JobHeat::default()
            },
        };
        lock(&b2.remote_start.heat).insert(sha, Some(heat));
    });
    let _ = done.await;
}

/// A start approved from afar: `key` is the card's request id (an agent's print) or the queue item id.
pub(crate) fn approved(b: &Bridge, key: &str) {
    lock(&b.remote_start.approved).insert(key.to_owned(), Approved { at: Instant::now() });
}

/// Drops a remote approval that will not start (its card's work was dropped, the plate left the queue).
pub(crate) fn forget(b: &Bridge, key: &str) {
    lock(&b.remote_start.approved).remove(key);
}

/// Whether a start needs the remote start check, from the queued plate's mark (`Some`, which decides:
/// a local approval never counts an old remote one) or, for an agent's print (`None`), the approval
/// the hub holds. `Ok(Some(at))` is a remote approval given at `at`; a queued plate marked remote whose
/// approval the hub no longer holds (a restart) is refused.
pub(crate) fn needs_check(mark: Option<bool>, held: Option<Instant>) -> Result<Option<Instant>, Why> {
    match (mark, held) {
        (Some(false), _) | (None, None) => Ok(None),
        (Some(true), None) => Err(Why::StartLate),
        (_, Some(at)) => Ok(Some(at)),
    }
}

/// Right before the start command of a start approved from afar: it must come within
/// [`START_WITHIN`] of the approval, and a fresh plate check must pass as at the approval. `mark` is a
/// queued plate's own word on whether a phone approved it (see [`needs_check`]). `Ok(false)` for a
/// start that was not approved from afar.
pub(crate) async fn before_start(
    b: &Arc<Bridge>,
    key: &str,
    printer: &str,
    mark: Option<bool>,
) -> Result<bool, Why> {
    let held = lock(&b.remote_start.approved).remove(key).map(|a| a.at);
    let Some(at) = needs_check(mark, held)? else {
        return Ok(false);
    };
    let outcome = async {
        if at.elapsed() > START_WITHIN {
            return Err(Why::StartLate);
        }
        let look = crate::guard::look_now(b, printer).await.ok_or(Why::NoAnswer)?;
        plate_pass(Some(Look::from(&look)), b.hub.bed(printer).ended_at_ms)?;
        Ok(look)
    }
    .await;
    b.hub.audit(json!({
        "origin": "remote_start", "action": "printer.start.check", "printerId": printer, "key": key,
        "ok": outcome.is_ok(), "reason": outcome.as_ref().err().map(Why::reason),
        "look": outcome.as_ref().ok().map(look_audit),
    }));
    outcome.map(|_| true)
}

/// A plate check as the audit keeps it: when, the still's hash and what the detector said.
pub(crate) fn look_audit(l: &crate::guard::PlateLook) -> Value {
    json!({
        "takenAt": iso(l.still.captured_at_ms),
        "ageMs": u64::try_from(l.taken.elapsed().as_millis()).unwrap_or(u64::MAX),
        "sha256": l.sha256,
        "clear": l.clear,
        "compared": l.compared,
        "frozen": l.frozen,
    })
}

/// One printer of the catalog: normalized vendor and model, nozzle and bed maximums.
struct CatalogPrinter {
    vendor: String,
    model: String,
    nozzle: Option<u32>,
    bed: Option<u32>,
}

/// Lowercase letters and digits only, so "A1 mini" matches "A1-Mini".
fn norm(s: &str) -> String {
    s.chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase()
}

/// The printer catalog's nozzle and bed maximums for a printer's vendor and model, when the catalog
/// has that model.
pub(crate) fn catalog_limits(vendor: &str, model: &str) -> Option<(u32, u32)> {
    static CATALOG: std::sync::OnceLock<Vec<CatalogPrinter>> = std::sync::OnceLock::new();
    let list = CATALOG.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../settings/profiles/printers.json"))
            .unwrap_or(Value::Null);
        let field = |p: &Value, k: &str| p.get(k).and_then(Value::as_str).map(norm).unwrap_or_default();
        let limit = |p: &Value, k: &str| {
            p.get("limits")
                .and_then(|l| l.get(k))
                .and_then(Value::as_u64)
                .and_then(|t| u32::try_from(t).ok())
        };
        v.get("printers")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|p| CatalogPrinter {
                        vendor: field(p, "vendor"),
                        model: field(p, "model"),
                        nozzle: limit(p, "hotendMaxTemp"),
                        bed: limit(p, "bedMaxTemp"),
                    })
                    .collect()
            })
            .unwrap_or_default()
    });
    let (v, m) = (norm(vendor), norm(model));
    // Vendor and model together, never a model name alone: another maker's printer could share it.
    if v.is_empty() || m.is_empty() {
        return None;
    }
    let found = list.iter().find(|c| c.vendor == v && c.model == m)?;
    Some((found.nozzle?, found.bed?))
}

async fn catalog_for(b: &Bridge, printer: &str) -> Option<(u32, u32)> {
    let info = b.printers.lock().await.get(printer).map(|r| r.info.clone())?;
    catalog_limits(
        info.get("vendor").and_then(Value::as_str).unwrap_or_default(),
        info.get("model").and_then(Value::as_str).unwrap_or_default(),
    )
}

fn row(b: &Bridge, printer: &str, catalog: Option<(u32, u32)>) -> Value {
    let p = policy(b, printer);
    let look = crate::guard::last_look(b, printer);
    let pass = plate_pass(look.as_ref().map(Look::from), b.hub.bed(printer).ended_at_ms);
    let limits = p.unwrap_or_else(|| clamp(RemoteStart::default(), Some(cap(catalog))));
    json!({
        "printerId": printer,
        "enabled": p.is_some(),
        "maxNozzleC": limits.max_nozzle_c,
        "maxBedC": limits.max_bed_c,
        "catalogMaxNozzleC": catalog.map(|c| c.0),
        "catalogMaxBedC": catalog.map(|c| c.1),
        "guard": crate::guard::on(b, printer),
        "plateCheck": look.map(|l| json!({
            "checkedAt": iso(l.still.captured_at_ms),
            "clear": l.clear,
            "compared": l.compared,
            "passes": pass.is_ok(),
            "reason": pass.as_ref().err().map(Why::reason),
        })),
    })
}

/// Limits no higher than the catalog's for the printer's model.
fn clamp(limits: RemoteStart, catalog: Option<(u32, u32)>) -> RemoteStart {
    match catalog {
        Some((n, b)) => RemoteStart {
            max_nozzle_c: limits.max_nozzle_c.min(n),
            max_bed_c: limits.max_bed_c.min(b),
        },
        None => limits,
    }
}

/// `remoteStart.get {printerId?}` (app and agents): each printer's remote start setting, the
/// catalog's limits for its model, and its last plate check, with the rule's fixed numbers. No picture.
pub(crate) async fn get_call(b: &Bridge, p: &Value) -> Rpc<Value> {
    let ids: Vec<String> = match p.get("printerId").and_then(Value::as_str) {
        Some(id) => {
            if !b.has_printer(id).await {
                return Err(RpcError::new("not_found", format!("no printer {id}")));
            }
            vec![id.to_owned()]
        }
        None => b.printers.lock().await.keys().cloned().collect(),
    };
    let mut rows = Vec::new();
    for id in &ids {
        let catalog = refresh_cap(b, id).await;
        rows.push(row(b, id, catalog));
    }
    Ok(json!({
        "printers": rows,
        "plateWindowSeconds": PLATE_PASS.as_secs(),
        "startWithinSeconds": START_WITHIN.as_secs(),
        "chamber": "never",
    }))
}

/// `remoteStart.set {printerId, enabled, maxNozzleC?, maxBedC?}` (app only, audited). Limits above the
/// printer's cap (the catalog's for its vendor and model, else the defaults) are refused.
pub(crate) async fn set_call(b: &std::sync::Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    if !b.has_printer(&printer).await {
        return Err(RpcError::new("not_found", format!("no printer {printer}")));
    }
    let enabled = p
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::new("bad_request", "enabled is true or false"))?;
    let catalog = refresh_cap(b, &printer).await;
    let (cap_nozzle, cap_bed) = cap(catalog);
    let why = if catalog.is_some() {
        ", the printer's own limit"
    } else {
        ", the cap for a printer the catalog does not know"
    };
    let limit = |key: &str, range: &std::ops::RangeInclusive<u32>, cap: u32, default: u32| -> Rpc<u32> {
        let hi = cap.min(*range.end());
        match p.get(key) {
            None | Some(Value::Null) => Ok(default.min(hi)),
            Some(v) => v
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n >= *range.start() && *n <= hi)
                .ok_or_else(|| {
                    RpcError::new(
                        "bad_request",
                        format!("{key} is a whole number from {} to {hi}{why}", range.start()),
                    )
                }),
        }
    };
    let was = policy(b, &printer).unwrap_or_default();
    let next = RemoteStart {
        max_nozzle_c: limit("maxNozzleC", &NOZZLE_RANGE, cap_nozzle, was.max_nozzle_c)?,
        max_bed_c: limit("maxBedC", &BED_RANGE, cap_bed, was.max_bed_c)?,
    };
    {
        let mut s = lock(&b.hub.settings);
        if enabled {
            s.remote_start.insert(printer.clone(), next);
        } else {
            s.remote_start.remove(&printer);
        }
    }
    b.hub.audit(json!({
        "origin": "local_click", "action": "remoteStart.set", "printerId": printer, "enabled": enabled,
        "maxNozzleC": next.max_nozzle_c, "maxBedC": next.max_bed_c,
    }));
    crate::hub_rpc::save(b).await;
    Ok(row(b, &printer, catalog))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::unnecessary_wraps, reason = "the rule takes the look as an Option")]
    fn look(age_s: u64, clear: Option<bool>, compared: bool) -> Option<Look> {
        Some(Look {
            age: Duration::from_secs(age_s),
            taken_ms: 1_000_000,
            clear,
            compared,
            frozen: false,
        })
    }

    #[test]
    fn a_fresh_compared_clear_plate_passes() {
        assert_eq!(plate_pass(look(5, Some(true), true), None), Ok(()));
        assert_eq!(plate_pass(look(60, Some(true), true), Some(999_999)), Ok(()));
    }

    #[test]
    fn a_stale_plate_check_refuses_the_start() {
        assert_eq!(plate_pass(look(61, Some(true), true), None), Err(Why::PlateStale));
        // A still from before the last print ended shows the plate under that print.
        assert_eq!(
            plate_pass(look(10, Some(true), true), Some(1_000_000)),
            Err(Why::PlateStale)
        );
    }

    #[test]
    fn a_failed_missing_uncompared_or_frozen_plate_check_refuses_the_start() {
        assert_eq!(plate_pass(None, None), Err(Why::PlateMissing));
        assert_eq!(
            plate_pass(look(1, Some(false), true), None),
            Err(Why::PlateFailed)
        );
        assert_eq!(plate_pass(look(1, None, true), None), Err(Why::PlateFailed));
        assert_eq!(
            plate_pass(look(1, Some(true), false), None),
            Err(Why::PlateNotCompared)
        );
        let frozen = look(1, Some(true), true).map(|l| Look { frozen: true, ..l });
        assert_eq!(plate_pass(frozen, None), Err(Why::PlateFrozen));
    }

    fn heat(nozzle: Option<f64>, bed: Option<f64>, chamber: Option<f64>) -> sx_connect::JobHeat {
        sx_connect::JobHeat {
            nozzle,
            bed,
            chamber,
            unknown: None,
        }
    }

    #[test]
    fn the_temperature_and_chamber_rule_holds_hot_or_unreadable_files() {
        let limits = RemoteStart::default();
        assert_eq!(
            heat_ok(limits, Some(&heat(Some(215.0), Some(60.0), None))),
            Ok(())
        );
        assert_eq!(
            heat_ok(limits, Some(&heat(Some(215.0), None, Some(0.0)))),
            Err(Why::Chamber)
        );
        assert_eq!(
            heat_ok(limits, Some(&heat(None, Some(60.0), None))),
            Err(Why::HeatUnknown)
        );
        assert_eq!(heat_ok(limits, None), Err(Why::HeatPending));
        let odd = sx_connect::JobHeat {
            unknown: Some("x".into()),
            ..heat(Some(200.0), None, None)
        };
        assert_eq!(heat_ok(limits, Some(&odd)), Err(Why::HeatUnknown));
        assert_eq!(
            heat_ok(limits, Some(&heat(Some(260.0), Some(60.0), None))).map_err(|w| w.reason()),
            Err("too_hot")
        );
        assert_eq!(
            heat_ok(limits, Some(&heat(Some(230.0), Some(100.0), None))).map_err(|w| w.reason()),
            Err("too_hot")
        );
        let abs = RemoteStart {
            max_nozzle_c: 260,
            max_bed_c: 110,
        };
        assert_eq!(heat_ok(abs, Some(&heat(Some(255.0), Some(100.0), None))), Ok(()));
    }

    fn ready() -> Facts {
        Facts {
            policy: Some(RemoteStart::default()),
            guard_on: true,
            heat: Some(heat(Some(215.0), Some(60.0), None)),
            look: look(3, Some(true), true),
            ended_at: Some(500_000),
        }
    }

    #[test]
    fn an_opted_out_printer_refuses_the_start_whatever_the_plate() {
        assert_eq!(rule(&ready(), true), Ok(()));
        let off = Facts {
            policy: None,
            ..ready()
        };
        assert_eq!(rule(&off, true), Err(Why::Off));
        assert_eq!(rule_before_plate(&off), Err(Why::Off));
        let guard_off = Facts {
            guard_on: false,
            ..ready()
        };
        assert_eq!(rule(&guard_off, true), Err(Why::GuardOff));
        // The person still ticks that the plate is clear, signed with the decision.
        assert_eq!(rule(&ready(), false), Err(Why::BedAnswer));
        let stale = Facts {
            look: look(61, Some(true), true),
            ..ready()
        };
        assert_eq!(rule(&stale, true), Err(Why::PlateStale));
    }

    #[test]
    fn the_setting_is_off_by_default() {
        let s: crate::hub::HubSettings = serde_json::from_value(json!({})).unwrap();
        assert!(s.remote_start.is_empty());
    }

    /// What the temperature and chamber rule says about a file.
    fn verdict(g: &[u8]) -> Result<(), Why> {
        heat_ok(RemoteStart::default(), Some(&sx_connect::job_heat(g)))
    }

    #[test]
    fn the_heat_rule_fails_closed_on_what_it_cannot_read() {
        assert_eq!(verdict(b"M140 S60\nM104 S215\n"), Ok(()));
        for g in [
            &b"M104S300\n"[..],
            b"N7 M104 S290*71\n",
            b"M104.1 S290\n",
            b"G10 P0 S290\n",
            b"M303 E0 S240 C8\n",
            b"M104 S215\nM104 S{first_layer_temperature[0]}\n",
            b"M104 S215\nSET_HEATER_TEMPERATURE HEATER=enclosure TARGET=60\n",
            b"M104 S215\nPRINT_START KEEP_WARM_TEMP=60\n",
        ] {
            assert!(verdict(g).is_err(), "{}", String::from_utf8_lossy(g));
        }
        // NOZZLE_DIAMETER is not a temperature: the nozzle here is 215.
        assert_eq!(
            verdict(b"PRINT_START NOZZLE_DIAMETER=0.4 NOZZLE_TEMP=215 BED_TEMP=60\n"),
            Ok(())
        );
    }

    #[test]
    fn limits_follow_the_printer_catalog() {
        assert_eq!(catalog_limits("Bambu Lab", "X1 Carbon"), Some((300, 110)));
        assert_eq!(catalog_limits("", "Unknown Printer 9000"), None);
        // A model name alone never matches: the vendor has to agree.
        assert_eq!(catalog_limits("", "X1 Carbon"), None);
        assert_eq!(catalog_limits("Someone Else", "X1 Carbon"), None);
        assert_eq!(cap(None), (240, 80));
        let x1 = catalog_limits("Bambu Lab", "X1 Carbon");
        assert_eq!(
            clamp(
                RemoteStart {
                    max_nozzle_c: 320,
                    max_bed_c: 120
                },
                x1
            ),
            RemoteStart {
                max_nozzle_c: 300,
                max_bed_c: 110
            }
        );
        assert_eq!(clamp(RemoteStart::default(), x1), RemoteStart::default());
    }

    #[test]
    fn a_local_approval_never_counts_an_old_remote_one() {
        let then = Some(Instant::now());
        // A queued plate the person approved in the app: an approval left from afar does not hold it.
        assert_eq!(needs_check(Some(false), then), Ok(None));
        assert_eq!(needs_check(Some(true), then), Ok(then));
        assert_eq!(needs_check(Some(true), None), Err(Why::StartLate));
        assert_eq!(needs_check(None, then), Ok(then));
        assert_eq!(needs_check(None, None), Ok(None));
    }

    #[test]
    fn autotemp_counts_chamber_off_is_fine_and_a_bare_start_macro_is_unknown() {
        // Marlin's autotemp raises the nozzle to B.
        assert!(verdict(b"M104 S200 B260\n").is_err());
        assert_eq!(verdict(b"M104 S215\nM141 S0\nM191 S0\n"), Ok(()));
        assert!(verdict(b"M104 S215\nM141 S40\n").is_err());
        // A start macro with no temperature arguments heats from its own defaults.
        assert!(verdict(b"PRINT_START\nM104 S215\n").is_err());
        assert!(verdict(b"START_PRINT\nM104 S215\n").is_err());
    }
}
