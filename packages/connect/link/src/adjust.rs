// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Changes to a running print: fans, speed factor, nozzle and bed temperature. Each needs an
//! approval card a person answered (`printer.adjust`), and the hub checks the value against the
//! safe limits before the printer sees it. A value outside them is refused with the allowed range,
//! never quietly clamped, so what runs is exactly what the card showed.
//!
//! The limits are relative to what the print is doing now, since a mid-print change should nudge a
//! print, not reslice it: nozzle within 20 °C of its current target (170 to 300 °C), bed within
//! 10 °C (at most 120 °C), speed factor 50 to 150 percent (Bambu Lab: its 50, 100, 124 and 166
//! percent levels), fans 0 to 100 percent. Only while the printer is printing or paused.
//!
//! The same card writes a filament slot to the printer (`adjust.slot`, Bambu Lab AMS
//! `ams_filament_setting`), from the app only and only while no print runs.
//!
//! The chamber light (`adjust.light`) needs no card: it is the app's own switch, like the one on
//! the printer's screen, and an agent connection cannot call it. The hub mints the token itself.
use std::sync::Arc;

use serde_json::{Value, json};
use std::time::Duration;

use sx_connect::{
    Adjustment, ApprovalToken, FanKind, FilamentSlot, PrinterState, PrinterStatus, SlotSetting,
};

use crate::rpc::{Bridge, Rpc, RpcError, arg, session, str_arg};

const NOZZLE_STEP: u16 = 20;
const NOZZLE_MIN: u16 = 170;
const NOZZLE_MAX: u16 = 300;
const BED_STEP: u16 = 10;
const BED_MAX: u16 = 120;
const SPEED_MIN: u16 = 50;
const SPEED_MAX: u16 = 150;
const BAMBU_SPEEDS: [u16; 4] = [50, 100, 124, 166];

/// The ranges a change may use on this printer right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Limits {
    pub running: bool,
    pub fans: Vec<FanKind>,
    pub speeds: Speeds,
    pub nozzle: Option<(u16, u16)>,
    pub bed: Option<(u16, u16)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Speeds {
    Range(u16, u16),
    Levels(Vec<u16>),
}

fn target(t: f64) -> Option<u16> {
    (0.0..1000.0).contains(&t).then(|| {
        // In range by the check above; rounding keeps 214.9 at 215.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let v = t.round() as u16;
        v
    })
}

pub(crate) fn limits(plugin: &str, st: &PrinterStatus) -> Limits {
    let bambu = plugin == "bambu";
    let nozzle = st
        .nozzles
        .first()
        .and_then(|n| target(n.target))
        .filter(|t| *t >= NOZZLE_MIN)
        .map(|t| {
            (
                t.saturating_sub(NOZZLE_STEP).max(NOZZLE_MIN),
                (t + NOZZLE_STEP).min(NOZZLE_MAX),
            )
        });
    let bed = st
        .bed
        .as_ref()
        .and_then(|b| target(b.target))
        .map(|t| (t.saturating_sub(BED_STEP), (t + BED_STEP).min(BED_MAX)));
    Limits {
        running: matches!(st.state, PrinterState::Printing | PrinterState::Paused),
        fans: if bambu {
            vec![FanKind::Part, FanKind::Aux, FanKind::Chamber]
        } else {
            vec![FanKind::Part]
        },
        speeds: if bambu {
            Speeds::Levels(BAMBU_SPEEDS.to_vec())
        } else {
            Speeds::Range(SPEED_MIN, SPEED_MAX)
        },
        nozzle,
        bed,
    }
}

impl Limits {
    pub(crate) fn to_json(&self) -> Value {
        let range = |r: Option<(u16, u16)>| r.map_or(Value::Null, |(a, z)| json!({ "min": a, "max": z }));
        json!({
            "running": self.running,
            "fan": { "fans": self.fans, "min": 0, "max": 100 },
            "speed": match &self.speeds {
                Speeds::Range(a, z) => json!({ "min": a, "max": z }),
                Speeds::Levels(l) => json!({ "levels": l }),
            },
            "nozzle": range(self.nozzle),
            "bed": range(self.bed),
        })
    }

    /// Ok when `change` is inside the limits; otherwise an `out_of_range` error naming the range.
    pub(crate) fn check(&self, change: Adjustment) -> Rpc<()> {
        let out = |what: String| Err(RpcError::new("out_of_range", what));
        if !self.running {
            return out("changes are only for a print that is running or paused".into());
        }
        match change {
            Adjustment::Fan { fan, percent } => {
                if !self.fans.contains(&fan) {
                    return out("this printer's fan cannot be set from SlicerX".into());
                }
                if percent > 100 {
                    return out("fan speed is 0 to 100 %".into());
                }
            }
            Adjustment::Speed { percent } => match &self.speeds {
                Speeds::Range(a, z) if !(a..=z).contains(&&percent) => {
                    return out(format!("speed is {a} to {z} %"));
                }
                Speeds::Levels(l) if !l.contains(&percent) => {
                    return out(format!("speed is one of {l:?} %"));
                }
                _ => {}
            },
            Adjustment::Nozzle { celsius } => match self.nozzle {
                Some((a, z)) if (a..=z).contains(&celsius) => {}
                Some((a, z)) => return out(format!("nozzle is {a} to {z} °C during this print")),
                None => return out("the nozzle is not at a printing temperature".into()),
            },
            Adjustment::Bed { celsius } => match self.bed {
                Some((a, z)) if (a..=z).contains(&celsius) => {}
                Some((a, z)) => return out(format!("bed is {a} to {z} °C during this print")),
                None => return out("the bed temperature is not known".into()),
            },
        }
        Ok(())
    }
}

async fn plugin_of(b: &Bridge, printer: &str) -> Rpc<String> {
    b.printers
        .lock()
        .await
        .get(printer)
        .map(|r| r.config.plugin.clone())
        .ok_or_else(|| RpcError::new("not_found", format!("no printer {printer}")))
}

/// Reads the printer and returns its limits now.
pub(crate) async fn limits_now(b: &Arc<Bridge>, printer: &str) -> Rpc<Limits> {
    let plugin = plugin_of(b, printer).await?;
    let st = session(b, printer).await?.status().await?;
    Ok(limits(&plugin, &st))
}

/// Checks `change` against the limits and sends it under `token`.
pub(crate) async fn apply(
    b: &Arc<Bridge>,
    printer: &str,
    change: &Adjustment,
    token: &ApprovalToken,
) -> Rpc<()> {
    limits_now(b, printer).await?.check(*change)?;
    session(b, printer).await?.adjust(change, token).await?;
    Ok(())
}

/// How long a slot write waits for the printer's report to show it.
const SLOT_SHOWN_WAIT: Duration = Duration::from_secs(5);

/// Whether a slot as the printer reports it holds what was written.
fn slot_shows(slot: &FilamentSlot, s: &SlotSetting) -> bool {
    slot.color
        .as_deref()
        .is_some_and(|c| c.eq_ignore_ascii_case(&s.color))
        && slot
            .material
            .as_deref()
            .is_some_and(|m| m.to_ascii_uppercase().contains(&s.material.to_ascii_uppercase()))
}

/// Writes a filament slot to the printer, a change a person approved as a `printer.adjust` card,
/// then reads the printer back. Not while a print runs or is paused: the slot may be feeding it.
/// Answers `{slot, shown}`: the slot as the printer now reports it, and whether that report shows
/// the change yet.
pub(crate) async fn set_slot(
    b: &Arc<Bridge>,
    printer: &str,
    setting: &SlotSetting,
    token: &ApprovalToken,
) -> Rpc<Value> {
    if let Some(p) = setting.problem() {
        return Err(RpcError::new("bad_request", p));
    }
    let s = session(b, printer).await?;
    let st = s.status().await?;
    if matches!(
        st.state,
        PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing
    ) {
        return Err(RpcError::new(
            "bad_state",
            "a slot is set while no print is running",
        ));
    }
    if !st.slots.iter().any(|x| x.id == setting.slot) {
        return Err(RpcError::new(
            "not_found",
            format!("the printer reports no slot {}", setting.slot),
        ));
    }
    s.set_slot(setting, token).await?;
    let end = tokio::time::Instant::now() + SLOT_SHOWN_WAIT;
    loop {
        let now = s.status().await?;
        let slot = now.slots.into_iter().find(|x| x.id == setting.slot);
        let shown = slot.as_ref().is_some_and(|x| slot_shows(x, setting));
        if shown || tokio::time::Instant::now() >= end {
            return Ok(json!({ "slot": slot, "shown": shown }));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Switches the chamber light under a token the hub mints for this one change.
async fn set_light(b: &Arc<Bridge>, printer: &str, on: bool) -> Rpc<()> {
    let s = session(b, printer).await?;
    let broker = b
        .broker
        .clone()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    let params = json!({ "printerId": printer, "light": on });
    let title = if on {
        "Turn the light on"
    } else {
        "Turn the light off"
    };
    let t = broker
        .mint(
            crate::hub::internal_request(
                sx_permit::StartOrigin::LocalClick,
                printer,
                "printer.adjust",
                &params,
                title,
            ),
            false,
        )
        .map_err(|e| RpcError::new("approval_invalid", e.to_string()))?;
    let token = ApprovalToken {
        request_id: t.request_id,
        token: t.token,
        expires_at: t.expires_at,
    };
    s.set_light(on, &token).await?;
    Ok(())
}

/// `adjust.limits {printerId}`, `adjust {printerId, change, token}`,
/// `adjust.slot {printerId, setting, token}` and `adjust.light {printerId, on}`.
pub(crate) async fn call(b: &Arc<Bridge>, method: &str, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    match method {
        "adjust.limits" => Ok(limits_now(b, &printer).await?.to_json()),
        "adjust.light" => {
            let on: bool = arg(p, "on")?;
            set_light(b, &printer, on).await?;
            Ok(json!({ "ok": true }))
        }
        "adjust.slot" => {
            let setting: SlotSetting = arg(p, "setting")?;
            let token: ApprovalToken = arg(p, "token")?;
            set_slot(b, &printer, &setting, &token).await
        }
        "adjust" => {
            let change: Adjustment = arg(p, "change")?;
            let token: ApprovalToken = arg(p, "token")?;
            apply(b, &printer, &change, &token).await?;
            Ok(json!({ "ok": true }))
        }
        other => Err(RpcError::new("bad_request", format!("unknown method {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use sx_connect::Temp;

    use super::*;

    fn printing(nozzle: f64, bed: f64) -> PrinterStatus {
        let mut s = PrinterStatus::offline("bay-1");
        s.state = PrinterState::Printing;
        s.nozzles = vec![Temp {
            current: nozzle,
            target: nozzle,
        }];
        s.bed = Some(Temp {
            current: bed,
            target: bed,
        });
        s
    }

    #[test]
    fn changes_stay_near_what_the_print_is_doing() {
        let l = limits("moonraker", &printing(215.0, 60.0));
        assert_eq!((l.nozzle, l.bed), (Some((195, 235)), Some((50, 70))));
        assert!(l.check(Adjustment::Nozzle { celsius: 235 }).is_ok());
        assert_eq!(
            l.check(Adjustment::Nozzle { celsius: 236 }).unwrap_err().code,
            "out_of_range"
        );
        assert!(l.check(Adjustment::Bed { celsius: 71 }).is_err());
        assert!(l.check(Adjustment::Speed { percent: 150 }).is_ok());
        assert!(l.check(Adjustment::Speed { percent: 151 }).is_err());
        assert!(l.check(Adjustment::Speed { percent: 49 }).is_err());
        assert!(
            l.check(Adjustment::Fan {
                fan: FanKind::Part,
                percent: 40
            })
            .is_ok()
        );
        assert!(
            l.check(Adjustment::Fan {
                fan: FanKind::Chamber,
                percent: 40
            })
            .is_err(),
            "only Bambu names other fans"
        );
        assert!(
            l.check(Adjustment::Fan {
                fan: FanKind::Part,
                percent: 101
            })
            .is_err()
        );
    }

    #[test]
    fn hard_caps_and_idle_printers() {
        let hot = limits("moonraker", &printing(290.0, 115.0));
        assert_eq!((hot.nozzle, hot.bed), (Some((270, 300)), Some((105, 120))));
        let cold = limits("moonraker", &printing(0.0, 0.0));
        assert_eq!(cold.nozzle, None);
        assert!(cold.check(Adjustment::Nozzle { celsius: 200 }).is_err());
        let mut idle = printing(215.0, 60.0);
        idle.state = PrinterState::Idle;
        assert!(
            limits("moonraker", &idle)
                .check(Adjustment::Fan {
                    fan: FanKind::Part,
                    percent: 0
                })
                .is_err()
        );
    }

    #[test]
    fn bambu_uses_its_speed_levels_and_three_fans() {
        let l = limits("bambu", &printing(220.0, 55.0));
        // The four levels of the printer's own speed menu, ludicrous included.
        for percent in [50, 100, 124, 166] {
            assert!(l.check(Adjustment::Speed { percent }).is_ok(), "{percent}");
        }
        assert!(l.check(Adjustment::Speed { percent: 110 }).is_err());
        assert!(
            l.check(Adjustment::Fan {
                fan: FanKind::Aux,
                percent: 60
            })
            .is_ok()
        );
    }
}
