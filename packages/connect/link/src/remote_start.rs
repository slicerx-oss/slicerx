// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Remote start: an approver phone away from home may approve a card that starts a print (an
//! agent's or partner's print, or a queued plate), but only when all of this holds (docs/safety.md,
//! owner decision 2026-11-05):
//!
//! - the person turned remote start on for that printer (`remoteStart.set`, off by default);
//! - the camera guard watches the printer, and its plate check compared a still of the plate with
//!   the person's empty-plate picture, found it clear, and took that still at most
//!   [`PLATE_PASS_MS`] ago and after the last print ended;
//! - the file heats the nozzle and bed no higher than the printer's remote start limits, the hub
//!   can read the nozzle temperature from it, and it heats no chamber;
//! - the person ticked that the plate is clear, signed with the decision.
//!
//! The phone shows the still beside the empty-plate picture (`plate.check` over the relay) before
//! the person approves. Pausing, stopping and skipping one object need none of this: they only stop
//! extrusion.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::hub::{iso, lock, now_ms};
use crate::rpc::{Bridge, Rpc, RpcError, str_arg};

/// How old the plate still a remote start relies on may be: 60 seconds. The check itself takes up
/// to 8 seconds, the relay round trip and reading two pictures side by side fit well inside a
/// minute, and anything longer gives someone time to put something on the plate after the picture.
/// The window also bounds a stale card: the phone takes a new look with Check again.
pub(crate) const PLATE_PASS_MS: u64 = 60_000;
/// The default limits for a remote start: PLA and PETG fit, while hotter materials (and a PTFE-lined
/// hotend above about 240 degrees) wait for someone at the printer unless the person raises them.
pub(crate) const DEFAULT_MAX_NOZZLE_C: u32 = 240;
pub(crate) const DEFAULT_MAX_BED_C: u32 = 80;
const NOZZLE_RANGE: std::ops::RangeInclusive<u32> = 150..=300;
const BED_RANGE: std::ops::RangeInclusive<u32> = 0..=120;

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

/// Why a remote start was refused. `reason()` is the machine word, `message()` what the phone says.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Why {
    Off,
    GuardOff,
    PlateMissing,
    PlateStale,
    PlateFailed,
    PlateNotCompared,
    BedAnswer,
    HeatUnknown,
    Chamber,
    TooHot {
        heater: &'static str,
        want: f64,
        max: u32,
    },
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
            Why::BedAnswer => "bed_answer",
            Why::HeatUnknown => "heat_unknown",
            Why::Chamber => "chamber",
            Why::TooHot { .. } => "too_hot",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            Why::Off => "remote start is off for this printer; turn it on in the printer's settings, or start it at home".into(),
            Why::GuardOff => "the camera guard is off for this printer, so nothing can check the plate".into(),
            Why::PlateMissing => "no plate check has passed yet; check the plate on the card first".into(),
            Why::PlateStale => format!(
                "the plate check is more than {} seconds old; check the plate again",
                PLATE_PASS_MS / 1000
            ),
            Why::PlateFailed => "the plate check found something on the plate, or could not tell".into(),
            Why::PlateNotCompared => "the plate check had no empty-plate picture to compare with; take one at the printer first".into(),
            Why::BedAnswer => "confirm on the card that the plate is clear".into(),
            Why::HeatUnknown => "the file's nozzle temperature cannot be read, so it waits for someone at the printer".into(),
            Why::Chamber => "the file heats the chamber, which waits for someone at the printer".into(),
            Why::TooHot { heater, want, max } => format!(
                "the file heats the {heater} to {want:.0} °C, above this printer's remote start limit of {max} °C"
            ),
        }
    }
}

/// The plate check a remote start relies on, as `plate_pass` reads it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Look {
    pub at_ms: u64,
    pub clear: Option<bool>,
    pub compared: bool,
}

impl From<&crate::guard::PlateLook> for Look {
    fn from(l: &crate::guard::PlateLook) -> Self {
        Self {
            at_ms: l.still.captured_at_ms,
            clear: l.clear,
            compared: l.compared,
        }
    }
}

/// Whether the last plate check is a pass a remote start may rely on now: clear, compared with the
/// empty-plate picture, taken after the last print ended and at most [`PLATE_PASS_MS`] ago.
pub(crate) fn plate_pass(look: Option<Look>, now: u64, ended_at: Option<u64>) -> Result<(), Why> {
    let l = look.ok_or(Why::PlateMissing)?;
    if l.clear != Some(true) {
        return Err(Why::PlateFailed);
    }
    if !l.compared {
        return Err(Why::PlateNotCompared);
    }
    // A still from before the last print ended shows the plate as it was before that print.
    if now.saturating_sub(l.at_ms) > PLATE_PASS_MS || ended_at.is_some_and(|e| l.at_ms <= e) {
        return Err(Why::PlateStale);
    }
    Ok(())
}

/// The temperature and chamber rule: no heated chamber, a nozzle temperature the hub can read, and
/// nozzle and bed within the printer's limits. A file that never sets the bed does not heat it.
pub(crate) fn heat_ok(limits: RemoteStart, heat: Option<sx_connect::JobHeat>) -> Result<(), Why> {
    let h = heat.ok_or(Why::HeatUnknown)?;
    if h.chamber.is_some_and(|c| c > 0.0) {
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

/// The printer's remote start setting, `None` while it is off.
pub(crate) fn policy(b: &Bridge, printer: &str) -> Option<RemoteStart> {
    lock(&b.hub.settings).remote_start.get(printer).copied()
}

/// What the rule reads about one start.
pub(crate) struct Facts {
    pub policy: Option<RemoteStart>,
    pub guard_on: bool,
    pub heat: Option<sx_connect::JobHeat>,
    pub look: Option<Look>,
    pub now: u64,
    pub ended_at: Option<u64>,
}

/// Everything about a start that can be checked before the plate: the setting, the guard and the
/// file's heat.
pub(crate) fn rule_before_plate(f: &Facts) -> Result<(), Why> {
    let limits = f.policy.ok_or(Why::Off)?;
    if !f.guard_on {
        return Err(Why::GuardOff);
    }
    heat_ok(limits, f.heat)
}

/// The whole rule for a start approved from afar, `bed_clear` being the person's signed answer.
pub(crate) fn rule(f: &Facts, bed_clear: bool) -> Result<(), Why> {
    rule_before_plate(f)?;
    plate_pass(f.look, f.now, f.ended_at)?;
    if !bed_clear {
        return Err(Why::BedAnswer);
    }
    Ok(())
}

/// The facts the hub holds now for a start on `printer` of a file with `heat`.
pub(crate) fn facts(b: &Bridge, printer: &str, heat: Option<sx_connect::JobHeat>) -> Facts {
    Facts {
        policy: policy(b, printer),
        guard_on: crate::guard::on(b, printer),
        heat,
        look: crate::guard::last_look(b, printer).as_ref().map(Look::from),
        now: now_ms(),
        ended_at: b.hub.bed(printer).ended_at_ms,
    }
}

fn row(b: &Bridge, printer: &str) -> Value {
    let p = policy(b, printer);
    let look = crate::guard::last_look(b, printer);
    let now = now_ms();
    let pass = plate_pass(look.as_ref().map(Look::from), now, b.hub.bed(printer).ended_at_ms);
    json!({
        "printerId": printer,
        "enabled": p.is_some(),
        "maxNozzleC": p.unwrap_or_default().max_nozzle_c,
        "maxBedC": p.unwrap_or_default().max_bed_c,
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

/// `remoteStart.get {printerId?}` (app and agents): each printer's remote start setting and its last
/// plate check, with the rule's fixed numbers. No picture.
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
    Ok(json!({
        "printers": ids.iter().map(|id| row(b, id)).collect::<Vec<_>>(),
        "plateWindowSeconds": PLATE_PASS_MS / 1000,
        "chamber": "never",
    }))
}

/// `remoteStart.set {printerId, enabled, maxNozzleC?, maxBedC?}` (app only, audited).
pub(crate) async fn set_call(b: &std::sync::Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    if !b.has_printer(&printer).await {
        return Err(RpcError::new("not_found", format!("no printer {printer}")));
    }
    let enabled = p
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::new("bad_request", "enabled is true or false"))?;
    let limit = |key: &str, range: &std::ops::RangeInclusive<u32>, default: u32| -> Rpc<u32> {
        match p.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(v) => v
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| range.contains(n))
                .ok_or_else(|| {
                    RpcError::new(
                        "bad_request",
                        format!(
                            "{key} is a whole number from {} to {}",
                            range.start(),
                            range.end()
                        ),
                    )
                }),
        }
    };
    let was = policy(b, &printer).unwrap_or_default();
    let next = RemoteStart {
        max_nozzle_c: limit("maxNozzleC", &NOZZLE_RANGE, was.max_nozzle_c)?,
        max_bed_c: limit("maxBedC", &BED_RANGE, was.max_bed_c)?,
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
    Ok(row(b, &printer))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000_000;

    #[allow(clippy::unnecessary_wraps, reason = "the rule takes the look as an Option")]
    fn look(age_ms: u64, clear: Option<bool>, compared: bool) -> Option<Look> {
        Some(Look {
            at_ms: NOW - age_ms,
            clear,
            compared,
        })
    }

    #[test]
    fn a_fresh_compared_clear_plate_passes() {
        assert_eq!(plate_pass(look(5_000, Some(true), true), NOW, None), Ok(()));
        assert_eq!(
            plate_pass(look(PLATE_PASS_MS, Some(true), true), NOW, Some(NOW - 600_000)),
            Ok(())
        );
    }

    #[test]
    fn a_stale_plate_check_refuses_the_start() {
        assert_eq!(
            plate_pass(look(PLATE_PASS_MS + 1, Some(true), true), NOW, None),
            Err(Why::PlateStale)
        );
        // A still from before the last print ended shows the plate under that print.
        assert_eq!(
            plate_pass(look(10_000, Some(true), true), NOW, Some(NOW - 5_000)),
            Err(Why::PlateStale)
        );
    }

    #[test]
    fn a_failed_or_missing_plate_check_refuses_the_start() {
        assert_eq!(plate_pass(None, NOW, None), Err(Why::PlateMissing));
        assert_eq!(
            plate_pass(look(1_000, Some(false), true), NOW, None),
            Err(Why::PlateFailed)
        );
        assert_eq!(
            plate_pass(look(1_000, None, true), NOW, None),
            Err(Why::PlateFailed)
        );
        // A look of the model alone, with no empty-plate picture, is no comparison.
        assert_eq!(
            plate_pass(look(1_000, Some(true), false), NOW, None),
            Err(Why::PlateNotCompared)
        );
    }

    #[test]
    fn the_temperature_and_chamber_rule_holds_hot_or_unreadable_files() {
        let limits = RemoteStart::default();
        let heat = |nozzle: Option<f64>, bed: Option<f64>, chamber: Option<f64>| {
            Some(sx_connect::JobHeat { nozzle, bed, chamber })
        };
        assert_eq!(heat_ok(limits, heat(Some(215.0), Some(60.0), None)), Ok(()));
        assert_eq!(heat_ok(limits, heat(Some(215.0), None, Some(0.0))), Ok(()));
        assert_eq!(
            heat_ok(limits, heat(Some(215.0), Some(60.0), Some(45.0))),
            Err(Why::Chamber)
        );
        assert_eq!(
            heat_ok(limits, heat(None, Some(60.0), None)),
            Err(Why::HeatUnknown)
        );
        assert_eq!(heat_ok(limits, None), Err(Why::HeatUnknown));
        assert_eq!(
            heat_ok(limits, heat(Some(260.0), Some(60.0), None)).map_err(|w| w.reason()),
            Err("too_hot")
        );
        assert_eq!(
            heat_ok(limits, heat(Some(230.0), Some(100.0), None)).map_err(|w| w.reason()),
            Err("too_hot")
        );
        let abs = RemoteStart {
            max_nozzle_c: 260,
            max_bed_c: 110,
        };
        assert_eq!(heat_ok(abs, heat(Some(255.0), Some(100.0), None)), Ok(()));
    }

    fn ready() -> Facts {
        Facts {
            policy: Some(RemoteStart::default()),
            guard_on: true,
            heat: Some(sx_connect::JobHeat {
                nozzle: Some(215.0),
                bed: Some(60.0),
                chamber: None,
            }),
            look: look(3_000, Some(true), true),
            now: NOW,
            ended_at: Some(NOW - 600_000),
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
            look: look(PLATE_PASS_MS + 500, Some(true), true),
            ..ready()
        };
        assert_eq!(rule(&stale, true), Err(Why::PlateStale));
    }

    #[test]
    fn the_setting_is_off_by_default() {
        let s: crate::hub::HubSettings = serde_json::from_value(json!({})).unwrap();
        assert!(s.remote_start.is_empty());
    }
}
