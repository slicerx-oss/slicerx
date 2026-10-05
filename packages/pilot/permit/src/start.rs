// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Who has to approve a print start, and when to ask whether the bed is clear.
//!
//! The person's own Print click in the app is the approval for a start on that app's printer
//! (`LocalClick`). Every other start (the Pilot assistant, MCP, a phone, the cloud inbox, a queued or a
//! scheduled start) needs an approval card, and the card always asks about the bed. A local click
//! asks about the bed only when the printer's last job ended and nobody has confirmed the plate was
//! removed since, or when the bed state is not known.
//!
//! [`BedRecord`] tracks that per printer from what the printer reports, and [`StandingApproval`]
//! holds a queued or scheduled approval until the hub uses it.
use serde::{Deserialize, Serialize};

use crate::broker::TOKEN_TTL;

/// Where a start came from. Shown on cards and audit records, and decides the rules in
/// [`start_requirement`]. Requests registered on the broker never carry `LocalClick`: the hub mints
/// local starts itself (`ApprovalBroker::mint`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartOrigin {
    /// The person pressed Print in the app's Print sheet.
    LocalClick,
    /// The Pilot assistant asked to start.
    Pilot,
    /// An MCP client asked to start.
    Mcp,
    /// A paired phone asked to start.
    Phone,
    /// A queued plate whose turn came.
    Queue,
    /// A plate scheduled for a set time.
    Schedule,
    /// A file the cloud inbox delivered.
    Inbox,
    /// The print watch: pausing a print a detector flagged, under the person's standing "pause on a
    /// failure" setting, and turning heaters off when nobody answered. Never a start.
    Watch,
}

impl StartOrigin {
    /// Everything but the local click: nobody may be standing at the printer.
    pub fn is_remote(self) -> bool {
        !matches!(self, StartOrigin::LocalClick)
    }

    /// An AI asked: the assistant (`Pilot`) or an outside agent (`Mcp`). A person still answers its
    /// card, but the hub starts only a file whose content it uploaded and checked itself, never a
    /// file it can bind by name only.
    pub fn is_ai(self) -> bool {
        matches!(self, StartOrigin::Pilot | StartOrigin::Mcp)
    }

    /// The wire name, as serde writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            StartOrigin::LocalClick => "local_click",
            StartOrigin::Pilot => "pilot",
            StartOrigin::Mcp => "mcp",
            StartOrigin::Phone => "phone",
            StartOrigin::Queue => "queue",
            StartOrigin::Schedule => "schedule",
            StartOrigin::Inbox => "inbox",
            StartOrigin::Watch => "watch",
        }
    }
}

/// What is known about a printer's build plate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BedState {
    /// Someone confirmed the plate is clear and no job has run since.
    Clear,
    /// A job ended and nobody has confirmed the plate was removed.
    NotCleared,
    /// Never watched, or the printer went unwatched long enough that a job could have run.
    Unknown,
    /// A job is running or paused.
    Busy,
}

/// What a start needs before it may go ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartRequirement {
    /// An approval card the person answered (with its token).
    pub card: bool,
    /// The person must say the bed is clear, on the Print sheet or on the card.
    pub ask_bed: bool,
}

/// The rule the owner set: a local click needs no card and asks about the bed only when the bed
/// is not known to be clear; every remote start needs a card that asks about the bed. `None` is a
/// request that did not say where it came from, which counts as remote.
pub fn start_requirement(origin: Option<StartOrigin>, bed: BedState) -> StartRequirement {
    match origin {
        Some(StartOrigin::LocalClick) => StartRequirement {
            card: false,
            ask_bed: bed != BedState::Clear,
        },
        _ => StartRequirement {
            card: true,
            ask_bed: true,
        },
    }
}

/// Why a start was refused before anything was sent to the printer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StartRefusal {
    /// A job is running or paused on the printer.
    #[error("the printer is busy with another job")]
    Busy,
    /// A remote start arrived without an approval card.
    #[error("a start from {origin} needs an approval card")]
    NeedsCard {
        /// The origin's wire name.
        origin: &'static str,
    },
    /// The bed has to be confirmed clear first.
    #[error("confirm the bed is clear before starting (bed is {bed})")]
    BedNotConfirmed {
        /// `not_cleared`, `unknown` or `clear`.
        bed: &'static str,
    },
}

impl StartRefusal {
    /// Short machine code for clients: `busy`, `needs_card` or `bed_check`.
    pub fn code(&self) -> &'static str {
        match self {
            StartRefusal::Busy => "busy",
            StartRefusal::NeedsCard { .. } => "needs_card",
            StartRefusal::BedNotConfirmed { .. } => "bed_check",
        }
    }
}

impl BedState {
    /// The wire name, as serde writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            BedState::Clear => "clear",
            BedState::NotCleared => "not_cleared",
            BedState::Unknown => "unknown",
            BedState::Busy => "busy",
        }
    }
}

/// Checks one start against [`start_requirement`]. `via_card` is true when an approval card the
/// person answered stands behind the start; `bed_confirmed` is true when the person said the bed is
/// clear for this start (on the Print sheet or on the card).
pub fn check_start(
    origin: Option<StartOrigin>,
    bed: BedState,
    via_card: bool,
    bed_confirmed: bool,
) -> Result<(), StartRefusal> {
    if bed == BedState::Busy {
        return Err(StartRefusal::Busy);
    }
    let need = start_requirement(origin, bed);
    if need.card && !via_card {
        return Err(StartRefusal::NeedsCard {
            origin: origin.map_or("an unknown source", StartOrigin::as_str),
        });
    }
    if need.ask_bed && !bed_confirmed {
        return Err(StartRefusal::BedNotConfirmed { bed: bed.as_str() });
    }
    Ok(())
}

/// How long the person's "the plate is clear" answer holds for a queued or scheduled start. A start
/// later than this after the answer asks again (the item waits as `needs_bed` and the hub sends an
/// alert), since something may have been put on an idle bed in between. Two hours covers a plate
/// queued behind a short job and a start scheduled for later the same afternoon; an overnight schedule
/// asks once more near its time.
pub const BED_ANSWER_FRESH_MS: u64 = 2 * 60 * 60 * 1000;

/// How long a printer may go unobserved before the bed counts as unknown and standing approvals
/// for it are void: a job could have been started from its own screen in that time.
pub const WATCH_GAP_MS: u64 = 10 * 60 * 1000;

/// A gap in readings longer than this, ended by a finished job of the same name on a clear bed, is
/// read as a possible reprint from the printer's own screen: the printer keeps showing the old
/// name, so only the gap gives it away. Readings normally come every few seconds.
pub const REPRINT_GAP_MS: u64 = 60 * 1000;

/// What the printer reports about its job, reduced to what the bed tracker needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobPhase {
    /// Idle with no job, or idle after a canceled job.
    Idle,
    /// Preparing, printing or paused.
    Running,
    /// Finished, failed or stopped with an error, as long as the printer still shows it.
    Ended,
    /// Did not answer. Says nothing about the bed.
    Offline,
}

/// Why a bed confirmation was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BedError {
    /// The printer is printing, so the plate cannot be clear.
    #[error("the printer is printing; the plate can be cleared once the job ends")]
    Busy,
}

/// The bed state of one printer, built from what the hub observes and what the person confirms.
/// Persisted by the hub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedRecord {
    pub state: BedState,
    /// Bumped whenever a job is seen starting and whenever the printer went unwatched, so a
    /// standing approval can tell that something else ran since it was given.
    pub epoch: u64,
    /// The job the printer last reported, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_job: Option<String>,
    /// When the last job was seen ending, ms since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
    /// When someone last confirmed the plate was clear.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at_ms: Option<u64>,
    /// When the printer last answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_at_ms: Option<u64>,
}

impl Default for BedRecord {
    fn default() -> Self {
        Self::new()
    }
}

impl BedRecord {
    /// A printer the hub has never watched: unknown.
    pub fn new() -> Self {
        Self {
            state: BedState::Unknown,
            epoch: 0,
            last_job: None,
            ended_at_ms: None,
            confirmed_at_ms: None,
            seen_at_ms: None,
        }
    }

    /// The printer went unwatched (hub stopped, computer asleep, printer unreachable): a job may
    /// have run, so a clear bed becomes unknown and standing approvals lapse.
    pub fn unwatched(&mut self) {
        self.epoch = self.epoch.saturating_add(1);
        if self.state == BedState::Clear {
            self.state = BedState::Unknown;
        }
    }

    /// Feeds one status reading. `job` is the job name the printer reports, if any.
    pub fn observe(&mut self, phase: JobPhase, job: Option<&str>, now_ms: u64) {
        if phase == JobPhase::Offline {
            return;
        }
        let gap = self.seen_at_ms.map_or(0, |seen| now_ms.saturating_sub(seen));
        if gap > WATCH_GAP_MS {
            self.unwatched();
        }
        self.seen_at_ms = Some(now_ms);
        match phase {
            JobPhase::Running => {
                if self.state != BedState::Busy {
                    // A job the hub did not start itself (from the printer's screen or another app).
                    self.epoch = self.epoch.saturating_add(1);
                    self.state = BedState::Busy;
                }
                if let Some(j) = job {
                    self.last_job = Some(j.to_owned());
                }
            }
            JobPhase::Ended => {
                let other_job = matches!((job, self.last_job.as_deref()), (Some(a), Some(b)) if a != b);
                match self.state {
                    BedState::Busy | BedState::Unknown => self.ended(now_ms),
                    // Printers keep showing a finished job after the plate was cleared; a different
                    // job name, or the same name after a gap in readings, means a job may have run
                    // unseen.
                    BedState::Clear if other_job || gap > REPRINT_GAP_MS => {
                        self.epoch = self.epoch.saturating_add(1);
                        self.ended(now_ms);
                    }
                    BedState::Clear | BedState::NotCleared => {}
                }
                if let Some(j) = job {
                    self.last_job = Some(j.to_owned());
                }
            }
            JobPhase::Idle => {
                // Canceled or aborted jobs often go straight back to idle.
                if self.state == BedState::Busy {
                    self.ended(now_ms);
                }
            }
            JobPhase::Offline => {}
        }
    }

    fn ended(&mut self, now_ms: u64) {
        self.state = BedState::NotCleared;
        self.ended_at_ms = Some(now_ms);
    }

    /// The person said the plate is clear.
    pub fn confirm_clear(&mut self, now_ms: u64) -> Result<(), BedError> {
        if self.state == BedState::Busy {
            return Err(BedError::Busy);
        }
        self.state = BedState::Clear;
        self.confirmed_at_ms = Some(now_ms);
        Ok(())
    }

    /// The hub started `job` itself. The epoch moves, so standing approvals given before this
    /// start lapse (a queued item that is being started is removed from the queue first).
    pub fn started(&mut self, job: &str, now_ms: u64) {
        self.epoch = self.epoch.saturating_add(1);
        self.state = BedState::Busy;
        self.last_job = Some(job.to_owned());
        self.seen_at_ms = Some(now_ms);
    }
}

/// A start the person approved ahead of time for the hub to run later: a scheduled start (valid
/// from the scheduled time until [`TOKEN_TTL`] after it) or a queued start (valid for
/// [`TOKEN_TTL`] from the approval, like any other approval). It covers one plate (file name,
/// SHA-256 and start options) on one printer, and lapses when the printer runs anything else first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingApproval {
    /// The card the person answered.
    pub request_id: String,
    /// `Queue` or `Schedule`.
    pub origin: StartOrigin,
    pub printer_id: String,
    pub file_name: String,
    pub sha256: String,
    /// `hash_params` of the start options.
    pub opts_hash: String,
    pub granted_at_ms: u64,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    /// The printer's [`BedRecord::epoch`] when the approval was given.
    pub epoch: u64,
    /// When the person said the plate is clear on the card. Kept here, not on the printer's bed
    /// record, and stale after [`BED_ANSWER_FRESH_MS`]. Records from before it existed read 0 (stale).
    #[serde(default)]
    pub bed_confirmed_at_ms: u64,
}

/// What a standing approval allows right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StandingCheck {
    /// Not yet: before the scheduled time, or the printer is still busy with the job that was
    /// running when the approval was given.
    Wait,
    /// Start now.
    Ready,
    /// The bed has to be confirmed clear again (a job ended since the approval, or the state is
    /// unknown). The approval holds until it expires.
    NeedsBed,
    /// Past its time.
    Expired,
    /// Void for good: the printer ran something else, or the plate is not the one approved.
    Canceled(&'static str),
}

/// Why a standing approval could not be created.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StandingError {
    /// Remote starts always ask about the bed.
    #[error("a queued or scheduled start needs the bed confirmed clear on the card")]
    BedNotConfirmed,
    /// A scheduled time in the past, or an origin other than queue or schedule.
    #[error("{0}")]
    Invalid(&'static str),
}

/// The plate a standing approval is for.
#[derive(Debug, Clone, Copy)]
pub struct Plate<'a> {
    pub printer_id: &'a str,
    pub file_name: &'a str,
    pub sha256: &'a str,
    pub opts_hash: &'a str,
}

impl StandingApproval {
    /// Turns an answered card into a standing approval. `start_at_ms` is the scheduled time
    /// (`Schedule`), ignored for `Queue`. `bed` is the printer's record at the time of approval.
    pub fn new(
        request_id: &str,
        origin: StartOrigin,
        plate: Plate<'_>,
        start_at_ms: Option<u64>,
        now_ms: u64,
        bed: &BedRecord,
        bed_confirmed: bool,
    ) -> Result<Self, StandingError> {
        if !bed_confirmed {
            return Err(StandingError::BedNotConfirmed);
        }
        let ttl = u64::try_from(TOKEN_TTL.as_millis()).unwrap_or(u64::MAX);
        let (not_before_ms, expires_at_ms) = match (origin, start_at_ms) {
            (StartOrigin::Schedule, Some(at)) if at > now_ms => (at, at.saturating_add(ttl)),
            (StartOrigin::Schedule, _) => {
                return Err(StandingError::Invalid(
                    "a scheduled start needs a time in the future",
                ));
            }
            (StartOrigin::Queue, _) => (now_ms, now_ms.saturating_add(ttl)),
            _ => {
                return Err(StandingError::Invalid(
                    "only queued and scheduled starts can be approved ahead of time",
                ));
            }
        };
        Ok(Self {
            request_id: request_id.to_owned(),
            origin,
            printer_id: plate.printer_id.to_owned(),
            file_name: plate.file_name.to_owned(),
            sha256: plate.sha256.to_owned(),
            opts_hash: plate.opts_hash.to_owned(),
            granted_at_ms: now_ms,
            not_before_ms,
            expires_at_ms,
            epoch: bed.epoch,
            bed_confirmed_at_ms: now_ms,
        })
    }

    /// Whether the hub may start `plate` now. Checks in this order: the plate, expiry, other jobs
    /// since the approval, the scheduled time, the printer being busy, the bed.
    pub fn check(&self, plate: Plate<'_>, bed: &BedRecord, now_ms: u64) -> StandingCheck {
        if plate.printer_id != self.printer_id
            || plate.file_name != self.file_name
            || plate.sha256 != self.sha256
            || plate.opts_hash != self.opts_hash
        {
            return StandingCheck::Canceled("the plate is not the one approved");
        }
        if now_ms >= self.expires_at_ms {
            return StandingCheck::Expired;
        }
        // Before the time check, so the person hears at once that the plan is off.
        if bed.epoch != self.epoch {
            return StandingCheck::Canceled("the printer ran another job since the approval");
        }
        if now_ms < self.not_before_ms {
            return StandingCheck::Wait;
        }
        // The newest "plate is clear": the card's, or a later Plate removed while the bed still reads clear.
        let latest = match bed.state {
            BedState::Busy => return StandingCheck::Wait,
            BedState::NotCleared => return StandingCheck::NeedsBed,
            BedState::Clear => self.bed_confirmed_at_ms.max(bed.confirmed_at_ms.unwrap_or(0)),
            BedState::Unknown => self.bed_confirmed_at_ms,
        };
        if now_ms.saturating_sub(latest) > BED_ANSWER_FRESH_MS {
            StandingCheck::NeedsBed
        } else {
            StandingCheck::Ready
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_790_000_000_000;
    const MIN: u64 = 60_000;

    const REMOTE: [StartOrigin; 6] = [
        StartOrigin::Pilot,
        StartOrigin::Mcp,
        StartOrigin::Phone,
        StartOrigin::Queue,
        StartOrigin::Schedule,
        StartOrigin::Inbox,
    ];

    #[test]
    fn local_click_needs_no_card_and_asks_only_when_the_bed_is_not_clear() {
        let local = Some(StartOrigin::LocalClick);
        assert_eq!(
            start_requirement(local, BedState::Clear),
            StartRequirement {
                card: false,
                ask_bed: false
            }
        );
        for bed in [BedState::NotCleared, BedState::Unknown] {
            assert!(start_requirement(local, bed).ask_bed, "{bed:?}");
            assert!(!start_requirement(local, bed).card, "{bed:?}");
        }
        assert_eq!(check_start(local, BedState::Clear, false, false), Ok(()));
        assert_eq!(
            check_start(local, BedState::NotCleared, false, false),
            Err(StartRefusal::BedNotConfirmed { bed: "not_cleared" })
        );
        assert_eq!(
            check_start(local, BedState::Unknown, false, false),
            Err(StartRefusal::BedNotConfirmed { bed: "unknown" })
        );
        assert_eq!(check_start(local, BedState::NotCleared, false, true), Ok(()));
        assert_eq!(check_start(local, BedState::Unknown, false, true), Ok(()));
    }

    #[test]
    fn every_remote_origin_needs_a_card_and_the_bed_question_even_when_clear() {
        for origin in REMOTE.map(Some).into_iter().chain([None]) {
            for bed in [BedState::Clear, BedState::NotCleared, BedState::Unknown] {
                let need = start_requirement(origin, bed);
                assert!(need.card && need.ask_bed, "{origin:?} {bed:?}");
                assert_eq!(
                    check_start(origin, bed, false, true).map_err(|e| e.code()),
                    Err("needs_card"),
                    "{origin:?} {bed:?}"
                );
                assert_eq!(
                    check_start(origin, bed, true, false).map_err(|e| e.code()),
                    Err("bed_check"),
                    "{origin:?} {bed:?}"
                );
                assert_eq!(check_start(origin, bed, true, true), Ok(()), "{origin:?} {bed:?}");
            }
            assert!(origin.is_none_or(StartOrigin::is_remote));
        }
    }

    #[test]
    fn nothing_starts_on_a_busy_printer() {
        for origin in REMOTE.into_iter().chain([StartOrigin::LocalClick]) {
            assert_eq!(
                check_start(Some(origin), BedState::Busy, true, true),
                Err(StartRefusal::Busy)
            );
        }
    }

    #[test]
    fn origins_serialize_as_snake_case() {
        for o in REMOTE.into_iter().chain([StartOrigin::LocalClick]) {
            assert_eq!(serde_json::to_value(o).unwrap(), o.as_str());
        }
        for b in [
            BedState::Clear,
            BedState::NotCleared,
            BedState::Unknown,
            BedState::Busy,
        ] {
            assert_eq!(serde_json::to_value(b).unwrap(), b.as_str());
        }
    }

    #[test]
    fn a_job_that_ends_leaves_the_bed_not_cleared_until_confirmed() {
        let mut bed = BedRecord::new();
        assert_eq!(bed.state, BedState::Unknown);
        bed.observe(JobPhase::Idle, None, T0);
        assert_eq!(bed.state, BedState::Unknown, "idle says nothing about the plate");
        bed.confirm_clear(T0).unwrap();
        assert_eq!(bed.state, BedState::Clear);
        bed.observe(JobPhase::Running, Some("cube.gcode"), T0 + MIN);
        assert_eq!((bed.state, bed.epoch), (BedState::Busy, 1));
        assert_eq!(bed.confirm_clear(T0 + MIN), Err(BedError::Busy));
        bed.observe(JobPhase::Ended, Some("cube.gcode"), T0 + 2 * MIN);
        assert_eq!(bed.state, BedState::NotCleared);
        assert_eq!(bed.ended_at_ms, Some(T0 + 2 * MIN));
        // The printer keeps reporting the finished job; once cleared, that does not undo it.
        bed.confirm_clear(T0 + 2 * MIN + 10_000).unwrap();
        bed.observe(JobPhase::Ended, Some("cube.gcode"), T0 + 2 * MIN + 30_000);
        assert_eq!(bed.state, BedState::Clear);
        // A different finished job means one ran unseen.
        bed.observe(JobPhase::Ended, Some("other.gcode"), T0 + 5 * MIN);
        assert_eq!((bed.state, bed.epoch), (BedState::NotCleared, 2));
    }

    #[test]
    fn a_canceled_job_that_returns_to_idle_counts_as_ended() {
        let mut bed = BedRecord::new();
        bed.confirm_clear(T0).unwrap();
        bed.started("cube.gcode", T0);
        assert_eq!((bed.state, bed.epoch), (BedState::Busy, 1));
        // The hub's own start is not counted twice when the printer reports it.
        bed.observe(JobPhase::Running, Some("cube.gcode"), T0 + 1000);
        assert_eq!(bed.epoch, 1);
        bed.observe(JobPhase::Idle, None, T0 + 2000);
        assert_eq!(bed.state, BedState::NotCleared);
    }

    #[test]
    fn a_finished_job_seen_first_is_not_cleared_and_offline_changes_nothing() {
        let mut bed = BedRecord::new();
        bed.observe(JobPhase::Ended, Some("old.gcode"), T0);
        assert_eq!(bed.state, BedState::NotCleared);
        let before = bed.clone();
        bed.observe(JobPhase::Offline, None, T0 + 60 * MIN);
        assert_eq!(bed, before);
    }

    #[test]
    fn going_unwatched_makes_a_clear_bed_unknown_and_moves_the_epoch() {
        let mut bed = BedRecord::new();
        bed.observe(JobPhase::Idle, None, T0);
        bed.confirm_clear(T0).unwrap();
        bed.observe(JobPhase::Idle, None, T0 + WATCH_GAP_MS);
        assert_eq!(
            (bed.state, bed.epoch),
            (BedState::Clear, 0),
            "a gap at the limit is fine"
        );
        bed.observe(JobPhase::Idle, None, T0 + 2 * WATCH_GAP_MS + 1);
        assert_eq!((bed.state, bed.epoch), (BedState::Unknown, 1));
        let mut ended = BedRecord::new();
        ended.observe(JobPhase::Ended, None, T0);
        ended.unwatched();
        assert_eq!(ended.state, BedState::NotCleared, "not cleared stays not cleared");
    }

    fn plate(sha: &str) -> Plate<'_> {
        Plate {
            printer_id: "bay-1",
            file_name: "lantern.gcode",
            sha256: sha,
            opts_hash: "opts",
        }
    }

    fn clear_bed() -> BedRecord {
        let mut bed = BedRecord::new();
        bed.observe(JobPhase::Idle, None, T0);
        bed.confirm_clear(T0).unwrap();
        bed
    }

    #[test]
    fn standing_approvals_need_the_bed_confirmed_and_a_remote_ahead_of_time_origin() {
        let bed = clear_bed();
        let p = plate("aa");
        assert_eq!(
            StandingApproval::new("r", StartOrigin::Schedule, p, Some(T0 + MIN), T0, &bed, false),
            Err(StandingError::BedNotConfirmed)
        );
        assert!(StandingApproval::new("r", StartOrigin::Schedule, p, Some(T0), T0, &bed, true).is_err());
        assert!(StandingApproval::new("r", StartOrigin::Schedule, p, None, T0, &bed, true).is_err());
        for o in [StartOrigin::LocalClick, StartOrigin::Pilot, StartOrigin::Phone] {
            assert!(
                StandingApproval::new("r", o, p, None, T0, &bed, true).is_err(),
                "{o:?}"
            );
        }
    }

    #[test]
    fn a_scheduled_start_runs_at_its_time_and_not_after_the_window() {
        let bed = clear_bed();
        let at = T0 + 8 * 60 * MIN;
        let s =
            StandingApproval::new("r", StartOrigin::Schedule, plate("aa"), Some(at), T0, &bed, true).unwrap();
        assert_eq!(s.check(plate("aa"), &bed, T0 + MIN), StandingCheck::Wait);
        // Eight hours after the card, its "plate is clear" is stale: the hub asks again.
        assert_eq!(s.check(plate("aa"), &bed, at), StandingCheck::NeedsBed);
        let mut fresh = bed.clone();
        fresh.confirm_clear(at - 30 * MIN).unwrap();
        assert_eq!(s.check(plate("aa"), &fresh, at), StandingCheck::Ready);
        assert_eq!(s.check(plate("aa"), &fresh, at + 4 * MIN), StandingCheck::Ready);
        assert_eq!(s.check(plate("aa"), &fresh, at + 5 * MIN), StandingCheck::Expired);
    }

    #[test]
    fn a_scheduled_bed_answer_goes_stale_after_the_limit() {
        let bed = clear_bed();
        let at = T0 + BED_ANSWER_FRESH_MS;
        let s =
            StandingApproval::new("r", StartOrigin::Schedule, plate("aa"), Some(at), T0, &bed, true).unwrap();
        assert_eq!(
            s.check(plate("aa"), &bed, at),
            StandingCheck::Ready,
            "at the limit it still holds"
        );
        assert_eq!(s.check(plate("aa"), &bed, at + 1), StandingCheck::NeedsBed);
        // An approval saved before the field existed reads as never confirmed.
        let mut old = serde_json::to_value(&s).unwrap();
        old.as_object_mut().unwrap().remove("bedConfirmedAtMs");
        let old: StandingApproval = serde_json::from_value(old).unwrap();
        assert_eq!(
            old.check(
                plate("aa"),
                &BedRecord {
                    confirmed_at_ms: None,
                    ..bed.clone()
                },
                at
            ),
            StandingCheck::NeedsBed
        );
    }

    #[test]
    fn the_same_job_name_after_a_gap_in_readings_counts_as_a_possible_reprint() {
        let mut bed = BedRecord::new();
        bed.observe(JobPhase::Running, Some("cube.gcode"), T0);
        bed.observe(JobPhase::Ended, Some("cube.gcode"), T0 + MIN);
        bed.observe(JobPhase::Ended, Some("cube.gcode"), T0 + 2 * MIN);
        bed.confirm_clear(T0 + 2 * MIN).unwrap();
        // Readings every few seconds: the printer still showing the old job changes nothing.
        bed.observe(JobPhase::Ended, Some("cube.gcode"), T0 + 2 * MIN + 5000);
        assert_eq!((bed.state, bed.epoch), (BedState::Clear, 1));
        // Then the hub misses readings for a few minutes (under the watch gap) and sees the same name.
        bed.observe(
            JobPhase::Ended,
            Some("cube.gcode"),
            T0 + 2 * MIN + 5000 + REPRINT_GAP_MS + 1,
        );
        assert_eq!((bed.state, bed.epoch), (BedState::NotCleared, 2));
    }

    #[test]
    fn a_scheduled_start_is_void_for_another_plate_or_after_another_job() {
        let mut bed = clear_bed();
        let at = T0 + 60 * MIN;
        let s =
            StandingApproval::new("r", StartOrigin::Schedule, plate("aa"), Some(at), T0, &bed, true).unwrap();
        assert!(matches!(
            s.check(plate("bb"), &bed, at),
            StandingCheck::Canceled(_)
        ));
        let mut other_printer = plate("aa");
        other_printer.printer_id = "bay-2";
        assert!(matches!(
            s.check(other_printer, &bed, at),
            StandingCheck::Canceled(_)
        ));
        let mut other_opts = plate("aa");
        other_opts.opts_hash = "timelapse";
        assert!(matches!(
            s.check(other_opts, &bed, at),
            StandingCheck::Canceled(_)
        ));
        // Someone prints a quick part in between and clears the plate again: still void.
        bed.observe(JobPhase::Running, Some("quick.gcode"), T0 + 10 * MIN);
        bed.observe(JobPhase::Ended, Some("quick.gcode"), T0 + 20 * MIN);
        bed.confirm_clear(T0 + 21 * MIN).unwrap();
        assert!(matches!(
            s.check(plate("aa"), &bed, at),
            StandingCheck::Canceled(_)
        ));
    }

    #[test]
    fn a_scheduled_start_waits_for_the_job_running_at_approval_then_needs_the_bed() {
        let mut bed = BedRecord::new();
        bed.observe(JobPhase::Running, Some("first.gcode"), T0);
        // Within the watch gap, so the printer counts as watched the whole time.
        let at = T0 + 9 * MIN;
        let s =
            StandingApproval::new("r", StartOrigin::Schedule, plate("aa"), Some(at), T0, &bed, true).unwrap();
        bed.observe(JobPhase::Running, Some("first.gcode"), at);
        assert_eq!(s.check(plate("aa"), &bed, at), StandingCheck::Wait);
        bed.observe(JobPhase::Ended, Some("first.gcode"), at + MIN);
        assert_eq!(s.check(plate("aa"), &bed, at + MIN), StandingCheck::NeedsBed);
        bed.confirm_clear(at + 2 * MIN).unwrap();
        assert_eq!(s.check(plate("aa"), &bed, at + 2 * MIN), StandingCheck::Ready);
    }

    #[test]
    fn an_unwatched_printer_voids_the_schedule() {
        let mut bed = clear_bed();
        let at = T0 + 60 * MIN;
        let s =
            StandingApproval::new("r", StartOrigin::Schedule, plate("aa"), Some(at), T0, &bed, true).unwrap();
        bed.unwatched();
        assert!(matches!(
            s.check(plate("aa"), &bed, at),
            StandingCheck::Canceled(_)
        ));
    }

    #[test]
    fn a_queued_approval_lasts_the_normal_five_minutes() {
        let bed = clear_bed();
        let s = StandingApproval::new("r", StartOrigin::Queue, plate("aa"), None, T0, &bed, true).unwrap();
        assert_eq!(s.check(plate("aa"), &bed, T0), StandingCheck::Ready);
        assert_eq!(s.check(plate("aa"), &bed, T0 + 5 * MIN), StandingCheck::Expired);
        // The card's answer stands for a printer never seen before, not for one with a finished job.
        let mut unknown = BedRecord::new();
        unknown.epoch = bed.epoch;
        assert_eq!(s.check(plate("aa"), &unknown, T0), StandingCheck::Ready);
        let mut ended = BedRecord::new();
        ended.observe(JobPhase::Ended, Some("old.gcode"), T0);
        ended.epoch = bed.epoch;
        assert_eq!(s.check(plate("aa"), &ended, T0), StandingCheck::NeedsBed);
    }

    #[test]
    fn records_round_trip_through_json() {
        let bed = clear_bed();
        let s = StandingApproval::new(
            "r",
            StartOrigin::Schedule,
            plate("aa"),
            Some(T0 + MIN),
            T0,
            &bed,
            true,
        )
        .unwrap();
        let back: StandingApproval = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        let back: BedRecord = serde_json::from_value(serde_json::to_value(&bed).unwrap()).unwrap();
        assert_eq!(back, bed);
        assert_eq!(serde_json::to_value(&bed).unwrap()["state"], "clear");
    }
}
