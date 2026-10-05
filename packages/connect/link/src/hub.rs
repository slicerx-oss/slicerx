// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The always-on hub: what the bridge keeps on disk, the bed state of every printer, and the print
//! queue and scheduled starts it runs itself, with the app closed.
//!
//! State lives in one directory (mode 0700): `hub.json` (printers, fleets, services, settings,
//! remembered clients, bed records, the phone listener's port), `queue.json` (queue items and their
//! standing approvals), `jobs/` (the G-code of queued plates, by SHA-256) and `pairing-code`. Every
//! file is written to a temporary name and renamed into place, mode 0600. No credential is ever
//! written here; printer secrets stay in the secret store.
//!
//! The watcher reads every printer's status on an interval and feeds [`sx_permit::BedRecord`], so
//! the bed state is current whether or not a client is connected. The queue runner then starts
//! any queued or scheduled plate whose standing approval allows it (`sx_permit::StandingApproval`).
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sx_connect::{JobFile, JobKind, PrinterConfig, PrinterState, PrinterStatus, RemoteFile, StartOptions};
use sx_permit::{
    ApprovalAction, ApprovalRequest, BedRecord, JobPhase, PermissionClass, Plate, StandingApproval,
    StandingCheck, StartOrigin, TOKEN_TTL, hash_params,
};
use tokio::sync::broadcast;

use crate::fleets::Fleets;

pub(crate) const HUB_FILE: &str = "hub.json";
pub(crate) const QUEUE_FILE: &str = "queue.json";
pub(crate) const CODE_FILE: &str = "pairing-code";
pub(crate) const AGENT_CODE_FILE: &str = "agent-code";
pub(crate) const WATCH_CODE_FILE: &str = "watch-code";
pub(crate) const AUDIT_FILE: &str = "audit.jsonl";
const JOBS_DIR: &str = "jobs";
/// Items kept in the queue, finished ones included.
const MAX_QUEUE: usize = 200;
/// Finished, expired, canceled and failed items stay listed this long.
const HISTORY_MS: u64 = 24 * 60 * 60 * 1000;
/// How far ahead a start can be scheduled.
const MAX_SCHEDULE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// How long a queue card waits for an answer before it is raised again.
const QUEUE_CARD_MS: u64 = 30 * 60 * 1000;
/// How often the watcher writes its heartbeat, so the next start can tell how long it was down.
pub(crate) const HEARTBEAT: Duration = Duration::from_secs(30);

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn ttl_ms() -> u64 {
    u64::try_from(TOKEN_TTL.as_millis()).unwrap_or(u64::MAX)
}

/// `2026-10-01T22:00:00.000Z` for milliseconds since the epoch.
pub(crate) fn iso(ms: u64) -> String {
    let days = i64::try_from(ms / 86_400_000).unwrap_or(i64::MAX);
    let rem = ms % 86_400_000;
    let z = days.saturating_add(719_468);
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff]Z` (UTC only, as `Date.toISOString` writes it).
#[allow(clippy::many_single_char_names)] // The usual names of the date fields and of the civil algorithm.
pub(crate) fn parse_iso(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b.last() != Some(&b'Z') {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse().ok() };
    let sep = |i: usize, c: u8| b.get(i) == Some(&c);
    if !(sep(4, b'-') && sep(7, b'-') && sep(10, b'T') && sep(13, b':') && sep(16, b':')) {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let frac = s.get(19..s.len() - 1)?;
    let ms = match frac {
        "" => 0,
        f if f.starts_with('.') && f.len() >= 2 && f.len() <= 4 => {
            let digits = f.get(1..)?;
            let v: i64 = digits.parse().ok()?;
            v * 10_i64.pow(u32::try_from(3 - digits.len()).ok()?)
        }
        _ => return None,
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = ((days * 24 + h) * 60 + mi) * 60 + sec;
    u64::try_from(total * 1000 + ms).ok()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// Random lowercase hex, `bytes` long before encoding.
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0_u8; bytes];
    // A failing OS random source leaves zeros; ids then collide and registration fails loudly.
    let _ = getrandom::fill(&mut buf);
    hex(&buf)
}

// ---- what is saved ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedPrinter {
    pub config: PrinterConfig,
    pub info: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedService {
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
}

/// User settings the hub honors.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubSettings {
    /// Show and allow the connectors that have not been tested on real printers yet.
    #[serde(default)]
    pub experimental_connectors: bool,
    /// Printers the person allowed the print watch to pause on its own, when a failure detector
    /// reports a finding at or above `WATCH_PAUSE_AT`. A standing permission per printer, off by default.
    #[serde(default)]
    pub watch_auto_pause_printers: Vec<String>,
    /// Printers where huginn, the detector's second look, checks a finding before it counts as
    /// confirmed. Set in the app, read by detectors (`watch.huginnPrinters`).
    #[serde(default)]
    pub watch_huginn_printers: Vec<String>,
    /// The bed area a detector looks at, per printer: a polygon in 0 to 1 frame coordinates,
    /// drawn by the person in the app.
    #[serde(default)]
    pub watch_masks: BTreeMap<String, Vec<[f64; 2]>>,
}

fn agent_role() -> crate::roles::Role {
    crate::roles::Role::Agent
}

/// State, layer and layer count a printer last reported.
pub(crate) type Observed = (PrinterState, Option<u32>, Option<u32>);

/// A print the watch paused: when, and which heater steps followed.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct AutoPaused {
    pub at_ms: u64,
    pub bed_off: bool,
    pub all_off: bool,
}

/// A file this hub put on a printer: its content hash, and the size and time the printer reported
/// right after, so a file changed behind the hub's back reads as unverified.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadRecord {
    pub printer_id: String,
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<f64>,
}

/// The objects of a plate this hub started, sent along by the app, for printers that cannot list
/// the objects of their running print (Bambu Lab). Valid while the printer runs that job: the name
/// matches and the bed epoch has not moved since the start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobObjects {
    /// The file name the hub started.
    pub job: String,
    /// The bed epoch right after the start.
    pub epoch: u64,
    pub objects: Vec<sx_connect::PrintObject>,
    /// Ids the hub skipped in this job.
    #[serde(default)]
    pub skipped: Vec<String>,
}

/// A client that asked to be remembered at pairing. Only the SHA-256 of its key is kept.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientRecord {
    pub id: String,
    pub name: String,
    pub key_hash: String,
    /// The role it paired with. Records from before roles existed read as `agent`, the narrower one.
    #[serde(default = "agent_role")]
    pub role: crate::roles::Role,
    pub created_at_ms: u64,
    #[serde(default)]
    pub last_seen_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub printers: Vec<SavedPrinter>,
    #[serde(default)]
    pub fleets: Fleets,
    #[serde(default)]
    pub services: BTreeMap<String, SavedService>,
    /// The phone listener's port while it is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lan_port: Option<u16>,
    #[serde(default)]
    pub settings: HubSettings,
    #[serde(default)]
    pub clients: Vec<ClientRecord>,
    #[serde(default)]
    pub beds: BTreeMap<String, BedRecord>,
    /// Phones that get alerts while the app is closed.
    #[serde(default)]
    pub push: Vec<crate::push::PushReg>,
    /// Files this hub uploaded, so starts stay bound after a restart.
    #[serde(default)]
    pub upload_records: Vec<UploadRecord>,
    /// The objects of the job each printer is running, when the hub started it with them.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub job_objects: BTreeMap<String, JobObjects>,
    /// Printers a jog may have left in relative mode: the next jog or start sends `G90` first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relative_left: Vec<String>,
    #[serde(default)]
    pub heartbeat_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct QueueFile {
    #[serde(default)]
    items: Vec<QueueItem>,
}

/// The state directory. Every file in it is private to the user that runs the hub.
#[derive(Debug, Clone)]
pub(crate) struct StateDir {
    path: PathBuf,
}

impl StateDir {
    pub(crate) fn open(path: &Path) -> std::io::Result<Self> {
        sx_connect::create_private_dir(path)?;
        sx_connect::create_private_dir(&path.join(JOBS_DIR))?;
        Ok(Self {
            path: path.to_owned(),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// `None` when the file is missing. A file that does not parse is moved aside (`.bad`) so a
    /// damaged state never stops the hub, and is never silently overwritten either.
    pub(crate) fn load<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Option<T> {
        let p = self.path.join(name);
        let bytes = std::fs::read(&p).ok()?;
        match serde_json::from_slice(&bytes) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!(
                    "sx-link: {} could not be read ({e}); kept as {name}.bad",
                    p.display()
                );
                let _ = std::fs::rename(&p, self.path.join(format!("{name}.bad")));
                None
            }
        }
    }

    pub(crate) fn save<T: Serialize>(&self, name: &str, value: &T) -> std::io::Result<()> {
        let body = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
        sx_connect::write_private(&self.path.join(name), &body)
    }

    pub(crate) fn write_code(&self, code: &str) -> std::io::Result<()> {
        sx_connect::write_private(&self.path.join(CODE_FILE), format!("{code}\n").as_bytes())
    }

    /// The app code moved to the keychain: leave no stale copy on disk.
    pub(crate) fn remove_code(&self) {
        let _ = std::fs::remove_file(self.path.join(CODE_FILE));
    }

    pub(crate) fn write_watch_code(&self, code: &str) -> std::io::Result<()> {
        sx_connect::write_private(&self.path.join(WATCH_CODE_FILE), format!("{code}\n").as_bytes())
    }

    pub(crate) fn write_agent_code(&self, code: &str) -> std::io::Result<()> {
        sx_connect::write_private(&self.path.join(AGENT_CODE_FILE), format!("{code}\n").as_bytes())
    }

    fn job_path(&self, sha256: &str) -> PathBuf {
        self.path.join(JOBS_DIR).join(sha256)
    }
}

// ---- the queue ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QueueState {
    /// Waiting for its turn (an earlier item, or the printer is busy).
    Waiting,
    /// A card is waiting for the person's answer.
    AwaitingApproval,
    /// Approved; waiting for its time or for the printer.
    Approved,
    /// Approved, but the bed has to be confirmed clear again before it can start.
    NeedsBed,
    Started,
    Expired,
    Canceled,
    Failed,
}

impl QueueState {
    fn is_final(self) -> bool {
        matches!(
            self,
            QueueState::Started | QueueState::Expired | QueueState::Canceled | QueueState::Failed
        )
    }
}

/// One plate waiting on the hub. The G-code is in `jobs/<sha256>`; the hub uploads it itself when
/// the item starts, so the plate that runs is exactly the plate that was approved.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueItem {
    pub id: String,
    pub printer_id: String,
    pub name: String,
    pub kind: JobKind,
    pub sha256: String,
    pub bytes: u64,
    #[serde(default)]
    pub opts: StartOptions,
    /// Scheduled start, ms since the epoch. Absent: start when its turn comes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_after_ms: Option<u64>,
    /// Shown on cards and lists, such as the plate's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub added_at_ms: u64,
    pub state: QueueState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The card waiting for an answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<StandingApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
}

impl QueueItem {
    fn origin(&self) -> StartOrigin {
        if self.start_after_ms.is_some() {
            StartOrigin::Schedule
        } else {
            StartOrigin::Queue
        }
    }

    pub(crate) fn opts_hash(&self) -> String {
        hash_params(&serde_json::to_value(&self.opts).unwrap_or_else(|_| json!({})))
    }

    /// What clients see: the item, with times as ISO strings next to the numbers.
    pub(crate) fn to_json(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            if let Some(at) = self.start_after_ms {
                o.insert("startAfter".into(), json!(iso(at)));
            }
            o.insert("addedAt".into(), json!(iso(self.added_at_ms)));
            if let Some(a) = &self.approval {
                o.insert("approvedUntil".into(), json!(iso(a.expires_at_ms)));
            }
        }
        v
    }
}

/// Where queued G-code is kept: the state directory, or memory for a bridge without one.
enum Jobs {
    Disk(StateDir),
    Memory(StdMutex<HashMap<String, Arc<Vec<u8>>>>),
}

impl Jobs {
    fn put(&self, sha256: &str, data: &[u8]) -> std::io::Result<()> {
        match self {
            Jobs::Disk(d) => sx_connect::write_private(&d.job_path(sha256), data),
            Jobs::Memory(m) => {
                m.lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(sha256.to_owned(), Arc::new(data.to_vec()));
                Ok(())
            }
        }
    }

    fn get(&self, sha256: &str) -> Option<Vec<u8>> {
        match self {
            Jobs::Disk(d) => std::fs::read(d.job_path(sha256)).ok(),
            Jobs::Memory(m) => m
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(sha256)
                .map(|v| v.as_ref().clone()),
        }
    }

    fn remove(&self, sha256: &str) {
        match self {
            Jobs::Disk(d) => {
                let _ = std::fs::remove_file(d.job_path(sha256));
            }
            Jobs::Memory(m) => {
                m.lock().unwrap_or_else(PoisonError::into_inner).remove(sha256);
            }
        }
    }
}

/// The hub's own state, beside the bridge's printer table.
pub(crate) struct Hub {
    pub dir: Option<StateDir>,
    jobs: Jobs,
    pub beds: StdMutex<HashMap<String, BedRecord>>,
    pub queue: StdMutex<Vec<QueueItem>>,
    pub settings: StdMutex<HubSettings>,
    pub clients: StdMutex<Vec<ClientRecord>>,
    pub lan_port: StdMutex<Option<u16>>,
    /// `queue`, `bed` and `approval` events for paired clients.
    pub events: broadcast::Sender<Value>,
    /// Printers with a start in flight, so two starts never race on one printer.
    starting: StdMutex<HashSet<String>>,
    pub watch_every: Duration,
    last_heartbeat: StdMutex<Option<Instant>>,
    /// Serializes writes of `hub.json` and `queue.json`.
    pub save_lock: tokio::sync::Mutex<()>,
    /// One queue round at a time, so an item can never be started twice.
    pub run_lock: tokio::sync::Mutex<()>,
    /// Bed records changed since `hub.json` was last written.
    dirty: AtomicBool,
    /// The state each printer was last seen in, for alerts.
    last_state: StdMutex<HashMap<String, PrinterState>>,
    /// Push registrations and the Expo client.
    pub push: crate::push::Pusher,
    /// Content hash of each file this hub put on a printer, by printer and path, so a start binds
    /// to what is in the file and not to a name the caller gives. Newest last, at most `MAX_UPLOADS`.
    uploads: StdMutex<Vec<UploadRecord>>,
    /// The objects of the job each printer runs, when the hub started it with them.
    job_objects: StdMutex<HashMap<String, JobObjects>>,
    /// Printers a failed jog may have left in relative mode.
    relative_left: StdMutex<HashSet<String>>,
    /// Starts not yet seen running on printers that report them late: when.
    start_pending: StdMutex<HashMap<String, u64>>,
    /// When each printer last raised a print watch alert.
    finding_alerts: StdMutex<HashMap<String, u64>>,
    /// When each printer last had a detector finding.
    last_finding: StdMutex<HashMap<String, u64>>,
    /// One lock per printer that uploads and starts hold for their whole run, so no file lands
    /// between a start's hash check and the start itself.
    printer_locks: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// After a watch pause nobody answered: (bed off after, both heaters off after).
    pub pause_steps: (Duration, Duration),
    /// Prints the watch paused, with the heater steps already taken.
    pub auto_paused: StdMutex<HashMap<String, AutoPaused>>,
    /// The last state, layer and layer count each printer reported, for detector frames.
    observed: StdMutex<HashMap<String, Observed>>,
    /// Detector subscriptions: id to the printers they cover (`None`: all).
    watchers: StdMutex<HashMap<u64, Option<Vec<String>>>>,
    next_watcher: std::sync::atomic::AtomicU64,
}

/// A finding keeps a printer at `attention` this long.
const ATTENTION_MS: u64 = 10 * 60 * 1000;

/// How long readings from before a start are ignored on printers that report starts late.
const START_GRACE_MS: u64 = 30_000;

/// Upload records kept for start binding.
const MAX_UPLOADS: usize = 500;

/// What the hub loaded from disk at start.
pub(crate) struct Loaded {
    pub printers: Vec<SavedPrinter>,
    pub fleets: Fleets,
    pub services: BTreeMap<String, SavedService>,
}

impl Hub {
    /// Opens the hub. With a state directory, loads what was saved; a hub that was down longer
    /// than the watch gap treats every printer as unwatched for that time.
    pub(crate) fn open(dir: Option<StateDir>, watch_every: Duration, push_url: &str) -> (Self, Loaded) {
        let (file, queue) = match &dir {
            Some(d) => (
                d.load::<HubFile>(HUB_FILE).unwrap_or_default(),
                d.load::<QueueFile>(QUEUE_FILE).unwrap_or_default(),
            ),
            None => (HubFile::default(), QueueFile::default()),
        };
        let mut beds: HashMap<String, BedRecord> = file.beds.into_iter().collect();
        if file.heartbeat_ms > 0 && now_ms().saturating_sub(file.heartbeat_ms) > sx_permit::WATCH_GAP_MS {
            for b in beds.values_mut() {
                b.unwatched();
            }
        }
        let jobs = match &dir {
            Some(d) => Jobs::Disk(d.clone()),
            None => Jobs::Memory(StdMutex::new(HashMap::new())),
        };
        let (events, _) = broadcast::channel(256);
        let hub = Self {
            dir,
            jobs,
            beds: StdMutex::new(beds),
            queue: StdMutex::new(queue.items),
            settings: StdMutex::new(file.settings),
            clients: StdMutex::new(file.clients),
            lan_port: StdMutex::new(file.lan_port),
            events,
            starting: StdMutex::new(HashSet::new()),
            watch_every,
            last_heartbeat: StdMutex::new(None),
            save_lock: tokio::sync::Mutex::new(()),
            run_lock: tokio::sync::Mutex::new(()),
            dirty: AtomicBool::new(false),
            last_state: StdMutex::new(HashMap::new()),
            push: crate::push::Pusher::new(push_url, file.push),
            uploads: StdMutex::new(file.upload_records),
            job_objects: StdMutex::new(file.job_objects.into_iter().collect()),
            relative_left: StdMutex::new(file.relative_left.into_iter().collect()),
            start_pending: StdMutex::new(HashMap::new()),
            finding_alerts: StdMutex::new(HashMap::new()),
            last_finding: StdMutex::new(HashMap::new()),
            watchers: StdMutex::new(HashMap::new()),
            printer_locks: StdMutex::new(HashMap::new()),
            pause_steps: (Duration::from_mins(30), Duration::from_hours(2)),
            auto_paused: StdMutex::new(HashMap::new()),
            observed: StdMutex::new(HashMap::new()),
            next_watcher: std::sync::atomic::AtomicU64::new(1),
        };
        (
            hub,
            Loaded {
                printers: file.printers,
                fleets: file.fleets,
                services: file.services,
            },
        )
    }

    pub(crate) fn emit(&self, event: &str, data: Value) {
        let mut m = serde_json::Map::new();
        m.insert("event".into(), json!(event));
        m.insert("data".into(), data);
        let _ = self.events.send(Value::Object(m));
    }

    pub(crate) fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub(crate) fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::Relaxed)
    }

    /// Notes a printer's state and returns the alert the change calls for, if any.
    pub(crate) fn alert(&self, st: &PrinterStatus) -> Option<&'static str> {
        let prev = lock(&self.last_state).insert(st.printer_id.clone(), st.state);
        alert_for(prev, st.state)
    }

    /// The hub started a job itself: the next reading that shows it ended raises an alert even if
    /// no reading in between showed it printing.
    pub(crate) fn note_started(&self, printer: &str) {
        lock(&self.last_state).insert(printer.to_owned(), PrinterState::Printing);
    }

    /// Records a file the hub just uploaded (`size` bytes; `modified` as the printer reports it).
    pub(crate) fn note_upload(&self, rf: &RemoteFile, size: u64, modified: Option<f64>) {
        let Some(sha) = &rf.sha256 else { return };
        let mut u = lock(&self.uploads);
        u.retain(|r| !(r.printer_id == rf.printer_id && r.path == rf.path));
        u.push(UploadRecord {
            printer_id: rf.printer_id.clone(),
            path: rf.path.clone(),
            sha256: sha.clone(),
            size,
            modified,
        });
        if u.len() > MAX_UPLOADS {
            u.remove(0);
        }
        drop(u);
        self.mark_dirty();
    }

    pub(crate) fn job_objects(&self, printer: &str) -> Option<JobObjects> {
        lock(&self.job_objects).get(printer).cloned()
    }

    pub(crate) fn all_job_objects(&self) -> BTreeMap<String, JobObjects> {
        lock(&self.job_objects)
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Sets (or with `None` clears) the object record of `printer`'s job.
    pub(crate) fn set_job_objects(&self, printer: &str, rec: Option<JobObjects>) {
        let mut m = lock(&self.job_objects);
        let changed = match rec {
            Some(r) => {
                m.insert(printer.to_owned(), r);
                true
            }
            None => m.remove(printer).is_some(),
        };
        drop(m);
        if changed {
            self.mark_dirty();
        }
    }

    pub(crate) fn note_skip(&self, printer: &str, id: &str) {
        if let Some(r) = lock(&self.job_objects).get_mut(printer)
            && !r.skipped.iter().any(|s| s == id)
        {
            r.skipped.push(id.to_owned());
        }
        self.mark_dirty();
    }

    /// Marks or clears a printer a jog may have left in relative mode.
    pub(crate) fn set_relative_left(&self, printer: &str, left: bool) {
        let mut s = lock(&self.relative_left);
        let changed = if left {
            s.insert(printer.to_owned())
        } else {
            s.remove(printer)
        };
        drop(s);
        if changed {
            self.mark_dirty();
        }
    }

    /// The hub started `job` on a printer that reports starts late.
    pub(crate) fn note_start_pending(&self, printer: &str) {
        lock(&self.start_pending).insert(printer.to_owned(), now_ms());
    }

    /// True for a reading that may still show the time before a start the hub just made: anything
    /// but running, within `START_GRACE_MS`, before the first running reading. A reprint of the same
    /// file shows the last job's name and `FINISH` until the printer has prepared the new one.
    pub(crate) fn stale_after_start(&self, st: &PrinterStatus) -> bool {
        let mut m = lock(&self.start_pending);
        let Some(at) = m.get(&st.printer_id).copied() else {
            return false;
        };
        let running = matches!(
            st.state,
            PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing
        );
        if running || now_ms().saturating_sub(at) > START_GRACE_MS {
            m.remove(&st.printer_id);
            return false;
        }
        st.state != PrinterState::Offline
    }

    pub(crate) fn relative_left(&self, printer: &str) -> bool {
        lock(&self.relative_left).contains(printer)
    }

    pub(crate) fn all_relative_left(&self) -> Vec<String> {
        let mut v: Vec<String> = lock(&self.relative_left).iter().cloned().collect();
        v.sort();
        v
    }

    pub(crate) fn uploads(&self) -> Vec<UploadRecord> {
        lock(&self.uploads).clone()
    }

    /// What this hub recorded for the file at `path`, if it put it there.
    pub(crate) fn upload_record(&self, printer: &str, path: &str) -> Option<UploadRecord> {
        lock(&self.uploads)
            .iter()
            .rev()
            .find(|r| r.printer_id == printer && r.path == path)
            .cloned()
    }

    /// True when a print watch alert for `printer` may go out now (one per `every_ms`).
    pub(crate) fn finding_alert_due(&self, printer: &str, now: u64, every_ms: u64) -> bool {
        let mut m = lock(&self.finding_alerts);
        match m.get(printer) {
            Some(last) if now.saturating_sub(*last) < every_ms => false,
            _ => {
                m.insert(printer.to_owned(), now);
                true
            }
        }
    }

    /// A detector started watching `only` (or every printer). Returns the id for `remove_watcher`.
    pub(crate) fn add_watcher(&self, only: Option<Vec<String>>) -> u64 {
        let id = self.next_watcher.fetch_add(1, Ordering::Relaxed);
        lock(&self.watchers).insert(id, only);
        id
    }

    pub(crate) fn remove_watcher(&self, id: u64) {
        lock(&self.watchers).remove(&id);
    }

    pub(crate) fn note_finding(&self, printer: &str, now: u64) {
        lock(&self.last_finding).insert(printer.to_owned(), now);
    }

    /// The print watch state for a printer: `attention` for ten minutes after a finding, `watching`
    /// while it prints (or is paused) and a detector covers it, else `off`.
    pub(crate) fn watch_state(&self, printer: &str, now: u64) -> &'static str {
        if lock(&self.last_finding)
            .get(printer)
            .is_some_and(|t| now.saturating_sub(*t) < ATTENTION_MS)
        {
            return "attention";
        }
        let running = matches!(
            self.state_of(printer),
            Some(PrinterState::Printing | PrinterState::Paused)
        );
        let covered = lock(&self.watchers)
            .values()
            .any(|only| only.as_ref().is_none_or(|o| o.iter().any(|p| p == printer)));
        if running && covered { "watching" } else { "off" }
    }

    pub(crate) fn note_observed(&self, st: &PrinterStatus) {
        lock(&self.observed).insert(st.printer_id.clone(), (st.state, st.layer, st.layer_count));
    }

    /// State, layer and layer count as last reported.
    pub(crate) fn observed(&self, printer: &str) -> Option<Observed> {
        lock(&self.observed).get(printer).copied()
    }

    pub(crate) fn clear_finding(&self, printer: &str) {
        lock(&self.last_finding).remove(printer);
    }

    /// The state the watcher last saw the printer in.
    pub(crate) fn state_of(&self, printer: &str) -> Option<PrinterState> {
        lock(&self.last_state).get(printer).copied()
    }

    pub(crate) fn bed(&self, printer: &str) -> BedRecord {
        lock(&self.beds).get(printer).cloned().unwrap_or_default()
    }

    pub(crate) fn experimental(&self) -> bool {
        lock(&self.settings).experimental_connectors
    }

    /// Appends one line to `audit.jsonl` (0600): something the hub did on its own authority, such
    /// as a pause by the print watch. Without a state directory the record goes to stderr.
    pub(crate) fn audit(&self, entry: Value) {
        let mut line = entry;
        if let Some(o) = line.as_object_mut() {
            o.insert("at".into(), json!(iso(now_ms())));
        }
        let text = format!("{line}\n");
        match &self.dir {
            Some(d) => {
                use std::io::Write as _;
                let path = d.path().join(AUDIT_FILE);
                let fresh = !path.exists();
                let opened = std::fs::OpenOptions::new().create(true).append(true).open(&path);
                match opened {
                    Ok(mut f) => {
                        #[cfg(unix)]
                        if fresh {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                        }
                        let _ = fresh;
                        let _ = f.write_all(text.as_bytes());
                    }
                    Err(e) => eprintln!("sx-link: cannot write the audit log: {e}"),
                }
            }
            None => eprint!("sx-link audit: {text}"),
        }
    }

    /// Writes `queue.json`. Errors are reported on stderr; the hub keeps running from memory.
    pub(crate) fn save_queue(&self) {
        if let Some(d) = &self.dir {
            let items = lock(&self.queue).clone();
            if let Err(e) = d.save(QUEUE_FILE, &QueueFile { items }) {
                eprintln!("sx-link: cannot save the queue: {e}");
            }
        }
    }

    pub(crate) fn heartbeat_due(&self) -> bool {
        let mut last = lock(&self.last_heartbeat);
        match *last {
            Some(t) if t.elapsed() < HEARTBEAT => false,
            _ => {
                *last = Some(Instant::now());
                true
            }
        }
    }

    // ---- remembered clients ----

    /// Remembers a client and returns its key (shown once) and id.
    pub(crate) fn remember_client(&self, name: &str, role: crate::roles::Role) -> (String, String) {
        let key = random_hex(32);
        let id = format!("client-{}", random_hex(6));
        lock(&self.clients).push(ClientRecord {
            id: id.clone(),
            name: name.chars().take(80).collect(),
            key_hash: sha256_hex(key.as_bytes()),
            role,
            created_at_ms: now_ms(),
            last_seen_ms: now_ms(),
        });
        (key, id)
    }

    /// The client id and role for a remembered key. Compares hashes in constant time.
    pub(crate) fn client_for_key(&self, key: &str) -> Option<(String, crate::roles::Role)> {
        let want = sha256_hex(key.as_bytes());
        let mut clients = lock(&self.clients);
        let mut found = None;
        for c in clients.iter_mut() {
            let same = c
                .key_hash
                .bytes()
                .zip(want.bytes())
                .fold(c.key_hash.len() ^ want.len(), |d, (a, b)| d | usize::from(a ^ b))
                == 0;
            if same {
                c.last_seen_ms = now_ms();
                found = Some((c.id.clone(), c.role));
            }
        }
        found
    }

    // ---- the queue ----

    pub(crate) fn add_item(&self, item: QueueItem, data: &[u8]) -> Result<(), String> {
        self.jobs
            .put(&item.sha256, data)
            .map_err(|e| format!("cannot store the file: {e}"))?;
        let mut q = lock(&self.queue);
        if q.iter().filter(|i| !i.state.is_final()).count() >= MAX_QUEUE {
            return Err(format!("the queue holds at most {MAX_QUEUE} plates"));
        }
        q.push(item);
        Ok(())
    }

    pub(crate) fn item(&self, id: &str) -> Option<QueueItem> {
        lock(&self.queue).iter().find(|i| i.id == id).cloned()
    }

    pub(crate) fn item_for_request(&self, request_id: &str) -> Option<QueueItem> {
        lock(&self.queue)
            .iter()
            .find(|i| i.request_id.as_deref() == Some(request_id))
            .cloned()
    }

    /// Changes one item in place. `false` when it is gone.
    pub(crate) fn update_item(&self, id: &str, f: impl FnOnce(&mut QueueItem)) -> Option<QueueItem> {
        let mut q = lock(&self.queue);
        let item = q.iter_mut().find(|i| i.id == id)?;
        f(item);
        Some(item.clone())
    }

    /// Removes an item and its file when no other item uses the same file.
    pub(crate) fn remove_item(&self, id: &str) -> Option<QueueItem> {
        let mut q = lock(&self.queue);
        let pos = q.iter().position(|i| i.id == id)?;
        let item = q.remove(pos);
        if !q.iter().any(|i| i.sha256 == item.sha256 && !i.state.is_final()) {
            self.jobs.remove(&item.sha256);
        }
        Some(item)
    }

    fn release_file(&self, sha256: &str) {
        let q = lock(&self.queue);
        if !q.iter().any(|i| i.sha256 == sha256 && !i.state.is_final()) {
            self.jobs.remove(sha256);
        }
    }

    pub(crate) fn job_data(&self, sha256: &str) -> Option<Vec<u8>> {
        self.jobs.get(sha256)
    }

    /// Drops finished items older than a day.
    pub(crate) fn prune(&self, now: u64) -> bool {
        let mut q = lock(&self.queue);
        let before = q.len();
        q.retain(|i| {
            !(i.state.is_final() && i.ended_at_ms.is_some_and(|t| now.saturating_sub(t) > HISTORY_MS))
        });
        before != q.len()
    }

    pub(crate) fn begin_start(&self, printer: &str) -> bool {
        lock(&self.starting).insert(printer.to_owned())
    }

    pub(crate) fn end_start(&self, printer: &str) {
        lock(&self.starting).remove(printer);
    }

    /// The lock uploads and starts on `printer` hold for their whole run.
    pub(crate) fn printer_lock(&self, printer: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.printer_locks)
            .entry(printer.to_owned())
            .or_default()
            .clone()
    }

    /// An event for one connection only.
    pub(crate) fn emit_to(&self, event: &str, data: Value, conn: u64) {
        let mut m = serde_json::Map::new();
        m.insert("event".into(), json!(event));
        m.insert("data".into(), data);
        m.insert("to".into(), json!(conn));
        let _ = self.events.send(Value::Object(m));
    }
}

pub(crate) fn lock<T>(m: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The alert a state change calls for: `finished`, `failed`, `canceled`, `paused` (a pause the
/// printer may have made itself, such as a filament runout) or `error`. Nothing on the first
/// reading, so a hub restart does not repeat old alerts.
pub(crate) fn alert_for(prev: Option<PrinterState>, now: PrinterState) -> Option<&'static str> {
    use PrinterState::{Error, Finished, Idle, Offline, Paused, Preparing, Printing};
    let prev = prev?;
    if prev == now || now == Offline {
        return None;
    }
    let was_running = matches!(prev, Preparing | Printing | Paused);
    match now {
        Finished if was_running => Some("finished"),
        Error if was_running => Some("failed"),
        Error => Some("error"),
        Idle if was_running => Some("canceled"),
        Paused if prev != Offline => Some("paused"),
        _ => None,
    }
}

/// Reduces a printer status to what the bed tracker needs.
pub(crate) fn job_phase(status: &PrinterStatus) -> JobPhase {
    match status.state {
        PrinterState::Offline => JobPhase::Offline,
        PrinterState::Preparing | PrinterState::Printing | PrinterState::Paused => JobPhase::Running,
        PrinterState::Finished => JobPhase::Ended,
        // An error with a job showing is a failed job; without one it is a printer fault.
        PrinterState::Error if status.job_name.is_some() => JobPhase::Ended,
        PrinterState::Error | PrinterState::Idle => JobPhase::Idle,
    }
}

/// The JSON the `bed.state` call and `bed` events carry.
pub(crate) fn bed_json(printer: &str, bed: &BedRecord) -> Value {
    let ask = sx_permit::start_requirement(Some(StartOrigin::LocalClick), bed.state).ask_bed;
    let mut v = json!({
        "printerId": printer,
        "state": bed.state,
        "askOnPrint": ask,
        "epoch": bed.epoch,
    });
    if let Some(o) = v.as_object_mut() {
        if let Some(j) = &bed.last_job {
            o.insert("lastJob".into(), json!(j));
        }
        if let Some(t) = bed.ended_at_ms {
            o.insert("endedAt".into(), json!(iso(t)));
        }
        if let Some(t) = bed.confirmed_at_ms {
            o.insert("confirmedAt".into(), json!(iso(t)));
        }
    }
    v
}

/// The approval card the hub raises for a queued or scheduled item.
pub(crate) fn card_for(item: &QueueItem, printer_name: &str, now: u64) -> ApprovalRequest {
    let origin = item.origin();
    let label = item.title.clone().unwrap_or_else(|| item.name.clone());
    let (title, when, expires) = match item.start_after_ms {
        Some(at) => (
            format!("Start {label} on {printer_name} at {}?", iso(at)),
            format!("Starts at {} with nobody at the printer", iso(at)),
            at,
        ),
        None => (
            format!("Start {label} on {printer_name} now?"),
            "Starts as soon as you approve, from the queue".to_owned(),
            now.saturating_add(QUEUE_CARD_MS),
        ),
    };
    let start = json!({ "printerId": item.printer_id, "name": item.name, "opts": item.opts });
    ApprovalRequest {
        id: format!("{}-card-{}", item.id, random_hex(4)),
        session_id: "hub".into(),
        tool: format!("{}.start", origin.as_str()),
        permission: PermissionClass::Start,
        title,
        lines: vec![
            format!("File {} ({} bytes)", item.name, item.bytes),
            format!("SHA-256 {}", item.sha256),
            when,
            "Confirm the build plate is clear: nobody may be at the printer when it starts".into(),
        ],
        printer_id: Some(item.printer_id.clone()),
        params_hash: hash_params(&json!({ "queueId": item.id })),
        actions: vec![ApprovalAction {
            action: "printer.start".into(),
            target: item.printer_id.clone(),
            params_hash: hash_params(&start),
        }],
        expires_at: iso(expires),
        origin: Some(origin),
    }
}

/// The internal request behind one upload or start the hub performs itself.
pub(crate) fn internal_request(
    origin: StartOrigin,
    printer: &str,
    action: &str,
    params: &Value,
    title: &str,
) -> ApprovalRequest {
    let now = now_ms();
    ApprovalRequest {
        id: format!(
            "{}-{}-{}",
            origin.as_str(),
            action.trim_start_matches("printer."),
            random_hex(8)
        ),
        session_id: "hub".into(),
        tool: format!("{}.{}", origin.as_str(), action.trim_start_matches("printer.")),
        permission: PermissionClass::Start,
        title: title.to_owned(),
        lines: Vec::new(),
        printer_id: Some(printer.to_owned()),
        params_hash: hash_params(params),
        actions: vec![ApprovalAction {
            action: action.to_owned(),
            target: printer.to_owned(),
            params_hash: hash_params(params),
        }],
        expires_at: iso(now.saturating_add(ttl_ms())),
        origin: Some(origin),
    }
}

/// A new queue item from a `queue.add` call. `start_after_ms` must be in the future and within a
/// week.
#[allow(clippy::too_many_arguments)] // The fields of one item.
pub(crate) fn new_item(
    printer: &str,
    name: &str,
    kind: JobKind,
    sha256: &str,
    bytes: u64,
    opts: StartOptions,
    start_after_ms: Option<u64>,
    title: Option<String>,
    now: u64,
) -> Result<QueueItem, String> {
    if let Some(at) = start_after_ms {
        if at <= now {
            return Err("the scheduled time has passed".into());
        }
        if at - now > MAX_SCHEDULE_MS {
            return Err("starts can be scheduled up to 7 days ahead".into());
        }
    }
    Ok(QueueItem {
        id: format!("q-{}", random_hex(6)),
        printer_id: printer.to_owned(),
        name: name.to_owned(),
        kind,
        sha256: sha256.to_owned(),
        bytes,
        opts,
        start_after_ms,
        title: title.map(|t| t.chars().take(120).collect()),
        added_at_ms: now,
        state: QueueState::Waiting,
        message: None,
        request_id: None,
        approval: None,
        ended_at_ms: None,
    })
}

/// What the runner decided for one item this tick.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Nothing,
    /// Start the item now.
    Start,
    /// Raise a card for it.
    Card,
    /// Change its state (and message).
    Set(QueueState, Option<&'static str>),
    /// End it for good.
    End(QueueState, &'static str),
}

/// The runner's decision for `item`. `first_unscheduled` is true for the first open item without a
/// time on its printer: only that one may raise a card.
pub(crate) fn decide(item: &QueueItem, bed: &BedRecord, first_unscheduled: bool, now: u64) -> Step {
    if item.state.is_final() {
        return Step::Nothing;
    }
    if let Some(a) = &item.approval {
        let plate = Plate {
            printer_id: &item.printer_id,
            file_name: &item.name,
            sha256: &item.sha256,
            opts_hash: &item.opts_hash(),
        };
        return match a.check(plate, bed, now) {
            StandingCheck::Ready => Step::Start,
            StandingCheck::Wait => Step::Set(QueueState::Approved, None),
            StandingCheck::NeedsBed => Step::Set(
                QueueState::NeedsBed,
                Some("confirm the build plate is clear so it can start"),
            ),
            StandingCheck::Expired if item.start_after_ms.is_some() => Step::End(
                QueueState::Expired,
                "the scheduled time passed before it could start",
            ),
            // A queued approval lasts five minutes; the card is raised again.
            StandingCheck::Expired => Step::Set(QueueState::Waiting, None),
            StandingCheck::Canceled(why) => Step::End(QueueState::Canceled, why),
        };
    }
    match item.start_after_ms {
        Some(at) if now >= at => Step::End(
            QueueState::Expired,
            "the scheduled start was not approved in time",
        ),
        None if first_unscheduled && bed.state != sx_permit::BedState::Busy => {
            if item.state == QueueState::AwaitingApproval && item.request_id.is_some() {
                Step::Nothing
            } else {
                Step::Card
            }
        }
        Some(_) | None => Step::Nothing,
    }
}

impl Hub {
    pub(crate) fn finish_item(
        &self,
        id: &str,
        state: QueueState,
        message: Option<String>,
    ) -> Option<QueueItem> {
        let item = self.update_item(id, |i| {
            i.state = state;
            i.message = message;
            i.request_id = None;
            i.ended_at_ms = Some(now_ms());
            if state != QueueState::Started {
                i.approval = None;
            }
        })?;
        self.release_file(&item.sha256);
        Some(item)
    }
}

/// What `start_plate` needs to send one plate.
pub(crate) struct Send<'a> {
    pub printer: &'a str,
    pub name: &'a str,
    pub kind: JobKind,
    pub data: Vec<u8>,
    pub sha256: &'a str,
    pub opts: StartOptions,
    pub origin: StartOrigin,
    pub title: &'a str,
}

/// The start params as the drivers bind them.
pub(crate) fn start_params(printer: &str, file: &RemoteFile, opts: &StartOptions) -> Value {
    serde_json::from_str(&sx_connect::params::start(printer, file, opts)).unwrap_or(Value::Null)
}

pub(crate) fn upload_params(printer: &str, name: &str, sha256: &str) -> Value {
    serde_json::from_str(&sx_connect::params::upload(printer, name, sha256)).unwrap_or(Value::Null)
}

pub(crate) fn job_file(s: &Send<'_>) -> JobFile {
    JobFile {
        name: s.name.to_owned(),
        kind: s.kind,
        data: s.data.clone(),
        sha256: s.sha256.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn n7_a_start_waits_for_an_upload_already_in_flight() {
        let (hub, _) = Hub::open(None, Duration::from_secs(5), "");
        let hub = Arc::new(hub);
        let upload = hub.printer_lock("bay-4");
        let held = upload.clone().lock_owned().await;
        // The upload is running; a start on the same printer must wait for it to finish.
        let h2 = hub.clone();
        let started = tokio::spawn(async move {
            let t = Instant::now();
            let lock = h2.printer_lock("bay-4");
            let _g = lock.lock().await;
            t.elapsed()
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(held);
        let waited = started.await.unwrap();
        assert!(
            waited >= Duration::from_millis(150),
            "the start ran during the upload: {waited:?}"
        );
        // Another printer is not held up.
        let other = hub.printer_lock("bay-5");
        assert!(other.try_lock().is_ok());
    }

    #[test]
    fn alerts_follow_state_changes_once() {
        use PrinterState::{Error, Finished, Idle, Offline, Paused, Printing};
        assert_eq!(
            alert_for(None, Finished),
            None,
            "no alert for what was already true"
        );
        assert_eq!(alert_for(Some(Printing), Finished), Some("finished"));
        assert_eq!(alert_for(Some(Paused), Error), Some("failed"));
        assert_eq!(alert_for(Some(Printing), Idle), Some("canceled"));
        assert_eq!(alert_for(Some(Printing), Paused), Some("paused"));
        assert_eq!(alert_for(Some(Idle), Error), Some("error"));
        assert_eq!(alert_for(Some(Printing), Printing), None);
        assert_eq!(alert_for(Some(Printing), Offline), None);
        assert_eq!(alert_for(Some(Offline), Paused), None);
        assert_eq!(alert_for(Some(Idle), Printing), None);
    }

    #[test]
    fn iso_round_trips() {
        for ms in [0_u64, 1_790_000_000_123, 951_782_400_000, 4_102_444_799_999] {
            assert_eq!(parse_iso(&iso(ms)), Some(ms), "{}", iso(ms));
        }
        assert_eq!(
            parse_iso("2026-10-01T22:00:00Z"),
            Some(parse_iso("2026-10-01T22:00:00.000Z").unwrap())
        );
        assert_eq!(
            parse_iso("2026-10-01T22:00:00.5Z"),
            Some(parse_iso("2026-10-01T22:00:00.500Z").unwrap())
        );
        for bad in [
            "",
            "2026-10-01",
            "2026-10-01T22:00:00+02:00",
            "2026-13-01T22:00:00Z",
            "2026-10-01T22:00:00.1234Z",
        ] {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
    }

    fn item(start_after: Option<u64>) -> QueueItem {
        new_item(
            "bay-1",
            "cube.gcode",
            JobKind::Gcode,
            "aa",
            10,
            StartOptions::default(),
            start_after,
            None,
            1000,
        )
        .unwrap()
    }

    fn clear() -> BedRecord {
        let mut b = BedRecord::new();
        b.observe(JobPhase::Idle, None, 1000);
        b.confirm_clear(1000).unwrap();
        b
    }

    #[test]
    fn scheduling_needs_a_future_time_within_a_week() {
        let now = 1000;
        assert!(
            new_item(
                "p",
                "a.gcode",
                JobKind::Gcode,
                "aa",
                1,
                StartOptions::default(),
                Some(now),
                None,
                now
            )
            .is_err()
        );
        assert!(
            new_item(
                "p",
                "a.gcode",
                JobKind::Gcode,
                "aa",
                1,
                StartOptions::default(),
                Some(now + MAX_SCHEDULE_MS + 1),
                None,
                now
            )
            .is_err()
        );
        assert!(
            new_item(
                "p",
                "a.gcode",
                JobKind::Gcode,
                "aa",
                1,
                StartOptions::default(),
                Some(now + 1),
                None,
                now
            )
            .is_ok()
        );
    }

    #[test]
    fn only_the_first_unscheduled_item_on_a_free_printer_raises_a_card() {
        let it = item(None);
        assert_eq!(decide(&it, &clear(), true, 2000), Step::Card);
        assert_eq!(decide(&it, &clear(), false, 2000), Step::Nothing);
        let mut busy = clear();
        busy.started("other.gcode", 1500);
        assert_eq!(decide(&it, &busy, true, 2000), Step::Nothing);
        let mut waiting = it.clone();
        waiting.state = QueueState::AwaitingApproval;
        waiting.request_id = Some("r".into());
        assert_eq!(decide(&waiting, &clear(), true, 2000), Step::Nothing);
    }

    #[test]
    fn an_unapproved_schedule_expires_at_its_time() {
        let it = item(Some(5000));
        assert_eq!(decide(&it, &clear(), false, 4999), Step::Nothing);
        assert!(matches!(
            decide(&it, &clear(), false, 5000),
            Step::End(QueueState::Expired, _)
        ));
    }

    #[test]
    fn approved_items_follow_their_standing_approval() {
        let bed = clear();
        let mut it = item(Some(60_000));
        let plate = Plate {
            printer_id: "bay-1",
            file_name: "cube.gcode",
            sha256: "aa",
            opts_hash: &it.opts_hash(),
        };
        it.approval = Some(
            StandingApproval::new("r", StartOrigin::Schedule, plate, Some(60_000), 2000, &bed, true).unwrap(),
        );
        assert_eq!(
            decide(&it, &bed, false, 30_000),
            Step::Set(QueueState::Approved, None)
        );
        assert_eq!(decide(&it, &bed, false, 60_000), Step::Start);
        assert!(matches!(
            decide(&it, &bed, false, 60_000 + ttl_ms()),
            Step::End(QueueState::Expired, _)
        ));
        let mut moved = bed.clone();
        moved.started("someone-else.gcode", 3000);
        moved.observe(JobPhase::Idle, None, 4000);
        assert!(matches!(
            decide(&it, &moved, false, 60_000),
            Step::End(QueueState::Canceled, _)
        ));
        let mut q = item(None);
        let plate = Plate {
            printer_id: "bay-1",
            file_name: "cube.gcode",
            sha256: "aa",
            opts_hash: &q.opts_hash(),
        };
        q.approval =
            Some(StandingApproval::new("r", StartOrigin::Queue, plate, None, 2000, &bed, true).unwrap());
        assert_eq!(
            decide(&q, &bed, true, 2000 + ttl_ms()),
            Step::Set(QueueState::Waiting, None)
        );
    }

    #[test]
    fn queue_cards_carry_the_origin_and_the_bed_question() {
        let card = card_for(&item(Some(90_000_000)), "Bay 1", 1000);
        assert_eq!(card.origin, Some(StartOrigin::Schedule));
        assert!(card.lines.iter().any(|l| l.contains("build plate is clear")));
        assert_eq!(card.actions.len(), 1);
        let card = card_for(&item(None), "Bay 1", 1000);
        assert_eq!(card.origin, Some(StartOrigin::Queue));
    }

    #[test]
    fn state_files_are_private_and_damaged_files_are_kept_aside() {
        let dir = std::env::temp_dir().join(format!("sx-hub-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let d = StateDir::open(&dir).unwrap();
        d.save(HUB_FILE, &HubFile::default()).unwrap();
        assert!(d.load::<HubFile>(HUB_FILE).is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(HUB_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::write(dir.join(HUB_FILE), b"{ broken").unwrap();
        assert!(d.load::<HubFile>(HUB_FILE).is_none());
        assert!(dir.join("hub.json.bad").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
