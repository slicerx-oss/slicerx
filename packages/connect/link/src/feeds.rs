// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! One camera connection per printer, shared. Live views, probes and stills all read the same
//! feed, so a printer whose camera takes one client at a time (live555 on Bambu Lab printers)
//! never sees a second login while the first is open. A feed keeps the frames since its last key
//! frame: a reader that joins gets them first, so its decoder starts at once even when the camera
//! sends key frames rarely (the H2D), and a still asked for while the feed runs is that key frame,
//! with no new connection.
//!
//! A feed a viewer reads that gets no frame for [`STALL`], or whose viewer waits that long for a key
//! frame that does not come, is dead: it ends the session and opens a new one through the retry path.
//!
//! live555 on the H2D drops a new session at PLAY for a while after the last one ended. So a feed a
//! viewer (a live view, a probe) has read stays open [`LINGER`] after its last reader leaves, for the
//! next view or still to reuse; a feed only stills read closes as soon as they let go, and for
//! [`COOLDOWN`] after a feed closes a still gets its last key frame, or waits the rest out, instead
//! of starting a session the camera would drop. With no feed open, stills open a session at most
//! every [`STILL_EVERY`] and are the last key frame in between. A viewer's feed whose camera drops the connection,
//! or stops, tries again after 5 s, 10 s, then every 15 s for as long as a viewer reads it, and
//! tells its readers through [`FeedStatus`].
//!
//! One PLAY the camera closes is routine, and a prompt retry usually gets in. A run of them is not:
//! on the H2D, after three closes in a row nearly every quick retry was closed too, and only a quiet
//! gap brought the camera back. So from the second close in a row the printer's camera is held for
//! [`HOLDS`] (growing, the last repeated) before anything opens it again: live views, probes and
//! stills alike. A still in that time gets the last key frame, or the busy error; a viewer's feed
//! waits it out and says the camera is busy. The first PLAY that plays ends the hold.
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::Duration;

use futures::StreamExt;
use futures::future::BoxFuture;
use futures::stream::unfold;
use sx_connect::camera::{CameraFrame, FrameKind, FrameStream};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, watch};
use tokio::time::Instant;

use crate::rpc::RpcError;

/// How long a feed a viewer read stays open with no reader.
pub(crate) const LINGER: Duration = Duration::from_secs(12);
/// How long after a feed closes a still does not start a new session: the H2D drops PLAY 5 to
/// 10 s after a TEARDOWN, and still refused about one new session a minute at 10 s (rc15).
pub(crate) const COOLDOWN: Duration = Duration::from_secs(15);
/// With no feed open, a still opens a camera session at most this often per printer; in between it
/// is the last key frame seen. A still while a feed is open reads that feed, however often.
pub(crate) const STILL_EVERY: Duration = Duration::from_secs(30);
/// The window the refusal rate is counted over.
const REFUSALS_OVER: Duration = Duration::from_secs(600);
/// The waits before each new try to open a camera that dropped the connection; the last repeats.
/// The first is past the moment right after a TEARDOWN when the H2D drops a new session.
pub(crate) const BACKOFF: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(15),
];
/// How long the camera is left alone after its 2nd, 3rd, 4th, and each later PLAY in a row that it
/// closed. The last, just past the 65 s after which live555 ends a session nobody tore down, repeats.
pub(crate) const HOLDS: [Duration; 4] = [
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(70),
];
/// Frames a slow reader may fall behind before it skips to the next key frame.
const BACKLOG: usize = 64;
/// How long a viewer's feed may go without a frame before it counts as dead.
pub(crate) const STALL: Duration = Duration::from_secs(3);
/// How long a new session may take to its first frame (the H2D takes about 2.5 s).
const FIRST_FRAME: Duration = Duration::from_secs(8);
/// How often an open feed logs its frame rate.
const RATE_EVERY: Duration = Duration::from_secs(10);
/// The most a feed keeps of the frames since its last key frame for readers that join. Past it
/// only the key frame is kept, and a joining viewer waits for the next one.
const GOP_FRAMES: usize = 900;
const GOP_BYTES: usize = 24 * 1024 * 1024;

/// The frames since the last key frame, first the key frame.
#[derive(Default)]
struct Gop {
    frames: Vec<CameraFrame>,
    bytes: usize,
    /// False once it outgrew [`GOP_FRAMES`] or [`GOP_BYTES`] and kept only the key frame.
    whole: bool,
}

impl Gop {
    fn push(&mut self, f: &CameraFrame) {
        if f.key {
            self.frames.clear();
            self.bytes = 0;
            self.whole = true;
        } else if self.frames.is_empty() || !self.whole {
            return;
        }
        if self.frames.len() >= GOP_FRAMES || self.bytes + f.data.len() > GOP_BYTES {
            self.frames.truncate(1);
            self.whole = false;
            return;
        }
        self.bytes += f.data.len();
        self.frames.push(f.clone());
    }

    fn key(&self) -> Option<CameraFrame> {
        self.frames.first().cloned()
    }
}

/// Frames counted since a moment, for the feed's rate.
struct Rate {
    since: Instant,
    frames: u64,
    keys: u64,
    /// The rate over the last full window, frames a second; `None` before the first.
    last: Option<f64>,
    /// When the last frame came.
    latest: Option<Instant>,
}

/// What a feed is doing, for its readers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FeedStatus {
    /// Frames are coming (or the camera was just opened).
    Live,
    /// The camera dropped the connection or stopped; the next try is `in_ms` away, try `attempt`.
    Retrying {
        attempt: u32,
        in_ms: u64,
        reason: String,
        /// The camera closed several PLAYs in a row and is left alone until the next try.
        busy: bool,
    },
    /// The camera will not open by waiting (a refused login, liveview off); the feed ends.
    Failed { reason: String },
}

/// The camera sessions a printer opened, and how many the camera refused.
#[derive(Default)]
struct Sessions {
    tries: u64,
    refused: u64,
    /// The last 10 minutes of tries: when, and whether refused.
    recent: std::collections::VecDeque<(Instant, bool)>,
    /// PLAYs in a row the camera closed, since the last one that played.
    closes_in_a_row: u32,
    /// No new session before this, after [`HOLDS`] closes in a row.
    held_until: Option<Instant>,
}

/// What a still gets while the camera rests between sessions.
#[derive(Debug)]
pub(crate) enum Rest {
    /// The last session's last key frame.
    Frame(CameraFrame),
    /// No frame to give: wait this long before opening a session.
    Wait(Duration),
}

/// Opens the printer's camera source again, for a retry.
pub(crate) type Opener = Arc<dyn Fn() -> BoxFuture<'static, Result<FrameStream, RpcError>> + Send + Sync>;

/// A failure worth trying again: the camera or printer did not answer, or dropped the connection.
pub(crate) fn retryable(e: &RpcError) -> bool {
    matches!(e.code.as_str(), "timeout" | "unreachable")
}

struct Feed {
    generation: u64,
    tx: broadcast::Sender<CameraFrame>,
    gop: Arc<StdMutex<Gop>>,
    rate: Arc<StdMutex<Rate>>,
    /// Set by a viewer that waited [`STALL`] for a key frame.
    want_key: Arc<AtomicBool>,
    /// Set once a viewer reads it: then it lingers after its last reader, and retries.
    viewed: Arc<AtomicBool>,
    status: watch::Receiver<FeedStatus>,
}

#[derive(Default)]
pub(crate) struct Feeds {
    live: StdMutex<HashMap<String, Feed>>,
    /// Per printer: held while its source is being opened, so two readers open one connection.
    opening: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Per printer: when its last feed closed, and that feed's last key frame.
    closed: StdMutex<HashMap<String, (Instant, Option<CameraFrame>)>>,
    /// Per printer: when a still last opened a camera session.
    still_opened: StdMutex<HashMap<String, Instant>>,
    /// Per printer: the camera sessions it opened and refused.
    sessions: StdMutex<HashMap<String, Sessions>>,
    /// The holds after closes in a row, when not [`HOLDS`] (tests shorten them).
    holds: StdMutex<Option<Vec<Duration>>>,
    next: StdMutex<u64>,
}

fn lock<T>(m: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Feeds {
    /// A reader of the printer's running feed, or `None` when it has none. `viewer`: a live view
    /// or probe, after which the feed lingers; a still does not keep it open.
    pub(crate) fn subscribe(&self, printer: &str, viewer: bool) -> Option<FrameStream> {
        let live = lock(&self.live);
        let feed = live.get(printer)?;
        if viewer {
            feed.viewed.store(true, Ordering::Relaxed);
        }
        // Under the lock the pump sends under, so the replay and the live frames meet exactly.
        let gop = lock(&feed.gop);
        let replay = if gop.whole {
            gop.frames.clone()
        } else {
            gop.key().into_iter().collect()
        };
        let need_key = !gop.whole && replay.first().is_some_and(|f| f.kind == FrameKind::H264);
        let rx = feed.tx.subscribe();
        drop(gop);
        Some(reader(rx, replay, need_key, feed.want_key.clone()))
    }

    /// The feed's frame rate over the last 10 s (or since it opened), and whether a frame came in
    /// the last [`STALL`], once it has run a second: what a probe that joined it reports, since the
    /// frames it gets first are a replay. A feed with no recent frame is not healthy, whatever
    /// the probe got from the replay.
    pub(crate) fn health(&self, printer: &str) -> Option<(f64, bool)> {
        let live = lock(&self.live);
        let r = lock(&live.get(printer)?.rate);
        let fresh = r.latest.is_some_and(|t| t.elapsed() < STALL);
        let rate = r.last.or_else(|| {
            let secs = r.since.elapsed().as_secs_f64();
            #[allow(clippy::cast_precision_loss, reason = "a frame count")]
            (secs >= 1.0).then(|| r.frames as f64 / secs)
        })?;
        Some((if fresh { rate } else { 0.0 }, fresh))
    }

    /// What the printer's feed is doing, while it has one.
    pub(crate) fn status(&self, printer: &str) -> Option<watch::Receiver<FeedStatus>> {
        lock(&self.live).get(printer).map(|f| f.status.clone())
    }

    /// For a still while the camera rests after a feed closed less than [`COOLDOWN`] ago: that
    /// feed's last key frame, or how long to wait. `None` when the camera is not resting.
    pub(crate) fn resting(&self, printer: &str) -> Option<Rest> {
        let closed = lock(&self.closed);
        let (at, frame) = closed.get(printer)?;
        let left = COOLDOWN.checked_sub(at.elapsed()).filter(|d| !d.is_zero())?;
        Some(frame.clone().map_or(Rest::Wait(left), Rest::Frame))
    }

    /// For a still with no feed open, when a still opened a session less than [`STILL_EVERY`] ago:
    /// the last key frame seen, and how long ago that session opened.
    pub(crate) fn paced_still(&self, printer: &str) -> Option<(CameraFrame, Duration)> {
        let ago = lock(&self.still_opened).get(printer)?.elapsed();
        if ago >= STILL_EVERY {
            return None;
        }
        let frame = lock(&self.closed).get(printer)?.1.clone()?;
        Some((frame, ago))
    }

    /// Notes that a still is opening a camera session now.
    pub(crate) fn still_opening(&self, printer: &str) {
        lock(&self.still_opened).insert(printer.to_owned(), Instant::now());
    }

    /// Counts one try to open the printer's camera, refused (the camera closed it at PLAY) or not,
    /// and says how it stands: all tries and refusals since the bridge started, those of the last
    /// 10 minutes, and any hold the refusals in a row started. A session that opened ends the hold.
    pub(crate) fn count_open(&self, printer: &str, refused: bool) -> String {
        let holds = self.holds();
        let mut all = lock(&self.sessions);
        let s = all.entry(printer.to_owned()).or_default();
        s.tries += 1;
        s.refused += u64::from(refused);
        s.recent.push_back((Instant::now(), refused));
        while s.recent.front().is_some_and(|(t, _)| t.elapsed() > REFUSALS_OVER) {
            s.recent.pop_front();
        }
        let recent_refused = s.recent.iter().filter(|(_, r)| *r).count();
        let mut out = format!(
            "{} of {} camera sessions refused, {recent_refused} of {} in the last 10 min",
            s.refused,
            s.tries,
            s.recent.len()
        );
        if !refused {
            s.closes_in_a_row = 0;
            s.held_until = None;
            return out;
        }
        s.closes_in_a_row += 1;
        let step = usize::try_from(s.closes_in_a_row.saturating_sub(2)).unwrap_or(usize::MAX);
        if s.closes_in_a_row >= 2
            && let Some(hold) = holds.get(step).or(holds.last()).copied()
        {
            s.held_until = Some(Instant::now() + hold);
            let _ = write!(
                out,
                "; {} in a row, the camera is left alone for {} s",
                s.closes_in_a_row,
                hold.as_secs()
            );
        }
        out
    }

    /// How long the printer's camera is still held after closing PLAYs in a row, if it is.
    pub(crate) fn held(&self, printer: &str) -> Option<Duration> {
        let until = lock(&self.sessions).get(printer)?.held_until?;
        until
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
    }

    /// Replaces [`HOLDS`]; empty keeps them (tests shorten them).
    pub(crate) fn set_holds(&self, holds: Vec<Duration>) {
        *lock(&self.holds) = (!holds.is_empty()).then_some(holds);
    }

    fn holds(&self) -> Vec<Duration> {
        lock(&self.holds).clone().unwrap_or_else(|| HOLDS.to_vec())
    }

    /// The printer's last key frame: its feed's, else that of the feed that closed last.
    pub(crate) fn last_key(&self, printer: &str) -> Option<CameraFrame> {
        let live = lock(&self.live).get(printer).and_then(|f| lock(&f.gop).key());
        live.or_else(|| lock(&self.closed).get(printer)?.1.clone())
    }

    /// The wait before a viewer's feed tries again: `backoff`, or the rest of the camera's hold
    /// when that is longer; and whether the camera is held.
    fn retry_wait(&self, printer: &str, backoff: Duration) -> (Duration, bool) {
        match self.held(printer) {
            Some(h) => (h.max(backoff), true),
            None => (backoff, false),
        }
    }

    /// The lock to hold while opening the printer's source.
    pub(crate) fn opener(&self, printer: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.opening).entry(printer.to_owned()).or_default().clone()
    }

    /// Starts a feed and returns its first reader, a viewer or a still. `first` is the source when
    /// it opened, else the error; a viewer's feed then retries through `reopen`.
    pub(crate) fn start(
        self: &Arc<Self>,
        printer: &str,
        first: Result<FrameStream, RpcError>,
        viewer: bool,
        reopen: Opener,
    ) -> FrameStream {
        let generation = {
            let mut n = lock(&self.next);
            *n += 1;
            *n
        };
        let (tx, rx) = broadcast::channel(BACKLOG);
        let gop = Arc::new(StdMutex::new(Gop::default()));
        let rate = Arc::new(StdMutex::new(Rate {
            since: Instant::now(),
            frames: 0,
            keys: 0,
            last: None,
            latest: None,
        }));
        let want_key = Arc::new(AtomicBool::new(false));
        let lingers = Arc::new(AtomicBool::new(viewer));
        // A viewer's feed that did not open starts out retrying, so its first reader hears so.
        let initial = match &first {
            Err(e) if viewer => {
                let (wait, busy) = self.retry_wait(printer, BACKOFF[0]);
                FeedStatus::Retrying {
                    attempt: 1,
                    in_ms: u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
                    reason: if busy { BUSY.to_owned() } else { e.message.clone() },
                    busy,
                }
            }
            _ => FeedStatus::Live,
        };
        let (status_tx, status) = watch::channel(initial);
        lock(&self.live).insert(
            printer.to_owned(),
            Feed {
                generation,
                tx: tx.clone(),
                gop: gop.clone(),
                rate: rate.clone(),
                want_key: want_key.clone(),
                viewed: lingers.clone(),
                status,
            },
        );
        let pump = Pump {
            feeds: self.clone(),
            printer: printer.to_owned(),
            generation,
            tx,
            gop,
            rate,
            want_key: want_key.clone(),
            viewed: lingers,
            status: status_tx,
            reopen,
        };
        tokio::spawn(pump.run(first));
        reader(rx, Vec::new(), false, want_key)
    }

    /// Ends the feed when nobody reads it. Done under the same lock subscribers take, so none can
    /// join a feed that is closing.
    fn close_if_idle(&self, printer: &str, generation: u64) -> bool {
        let mut live = lock(&self.live);
        let idle = live
            .get(printer)
            .is_some_and(|f| f.generation == generation && f.tx.receiver_count() == 0);
        if idle {
            live.remove(printer);
        }
        idle
    }

    fn forget(&self, printer: &str, generation: u64, last_key: Option<CameraFrame>) {
        let mut live = lock(&self.live);
        if live.get(printer).is_some_and(|f| f.generation == generation) {
            live.remove(printer);
        }
        lock(&self.closed).insert(printer.to_owned(), (Instant::now(), last_key));
    }
}

/// The task behind one feed.
struct Pump {
    feeds: Arc<Feeds>,
    printer: String,
    generation: u64,
    tx: broadcast::Sender<CameraFrame>,
    gop: Arc<StdMutex<Gop>>,
    rate: Arc<StdMutex<Rate>>,
    want_key: Arc<AtomicBool>,
    viewed: Arc<AtomicBool>,
    status: watch::Sender<FeedStatus>,
    reopen: Opener,
}

enum Ended {
    /// Nobody reads it any more.
    Idle,
    /// The camera stopped sending.
    Stopped,
    /// A viewer reads it but no frame came, or no key frame for a viewer that needs one.
    Stalled(String),
}

impl Pump {
    /// Reads sources into the feed until nobody reads it. A viewer's feed whose camera dropped the
    /// connection or stopped tries again with [`BACKOFF`]; a still's feed, or a failure that will not
    /// change by waiting (a refused login, liveview off), ends it.
    async fn run(self, first: Result<FrameStream, RpcError>) {
        let mut next = first;
        let mut attempt = 0_u32;
        let why = loop {
            let reason = match next {
                Ok(src) => match self.read(src).await {
                    Ended::Idle => break "no one watching".to_owned(),
                    Ended::Stopped => {
                        attempt = 0;
                        "the camera stopped sending".to_owned()
                    }
                    Ended::Stalled(why) => {
                        attempt = 0;
                        sx_connect::trace(&self.printer, format_args!("camera feed stalled: {why}"));
                        why
                    }
                },
                Err(e) => {
                    if !retryable(&e) {
                        self.tell(FeedStatus::Failed {
                            reason: e.message.clone(),
                        });
                        break format!("the camera did not open: {}", e.message);
                    }
                    e.message
                }
            };
            if !self.viewed.load(Ordering::Relaxed) {
                break reason;
            }
            let backoff = BACKOFF
                .get(usize::try_from(attempt).unwrap_or(usize::MAX))
                .or(BACKOFF.last())
                .copied()
                .unwrap_or(Duration::from_secs(15));
            // A camera held after closing PLAYs in a row is left alone for the rest of the hold.
            let (wait, busy) = self.feeds.retry_wait(&self.printer, backoff);
            attempt += 1;
            let in_ms = u64::try_from(wait.as_millis()).unwrap_or(u64::MAX);
            sx_connect::trace(
                &self.printer,
                format_args!(
                    "camera feed: {reason}; try {} in {} s{}",
                    attempt + 1,
                    wait.as_secs(),
                    if busy { " (the camera is held)" } else { "" }
                ),
            );
            self.tell(FeedStatus::Retrying {
                attempt,
                in_ms,
                reason: if busy { BUSY.to_owned() } else { reason.clone() },
                busy,
            });
            if !self.wait(wait).await {
                break "no one watching".to_owned();
            }
            next = (self.reopen)().await;
            if next.is_ok() {
                self.tell(FeedStatus::Live);
            }
        };
        let last = lock(&self.gop).key();
        self.feeds.forget(&self.printer, self.generation, last);
        sx_connect::trace(&self.printer, format_args!("camera feed closed: {why}"));
    }

    /// Reads one source until it ends or nobody reads the feed: at once when only stills read it,
    /// after [`LINGER`] once a viewer did. Dropping the source on return ends its camera session.
    async fn read(&self, mut src: FrameStream) -> Ended {
        let mut idle_since: Option<Instant> = None;
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let opened = Instant::now();
        let mut last_frame: Option<Instant> = None;
        self.want_key.store(false, Ordering::Relaxed);
        {
            let mut r = lock(&self.rate);
            *r = Rate {
                since: Instant::now(),
                frames: 0,
                keys: 0,
                last: None,
                latest: None,
            };
        }
        loop {
            tokio::select! {
                f = src.next() => {
                    let Some(f) = f else { return Ended::Stopped };
                    last_frame = Some(Instant::now());
                    {
                        let mut r = lock(&self.rate);
                        r.frames += 1;
                        r.keys += u64::from(f.key);
                        r.latest = last_frame;
                    }
                    // The replay buffer and the send under one lock: see `Feeds::subscribe`.
                    let mut gop = lock(&self.gop);
                    gop.push(&f);
                    let _ = self.tx.send(f);
                }
                _ = tick.tick() => {}
            }
            self.log_rate();
            let watched = self.tx.receiver_count() > 0 && self.viewed.load(Ordering::Relaxed);
            if watched {
                match last_frame {
                    Some(t) if t.elapsed() >= STALL => {
                        return Ended::Stalled(format!("no frame for {} s", t.elapsed().as_secs()));
                    }
                    None if opened.elapsed() >= FIRST_FRAME => {
                        return Ended::Stalled(format!("no first frame in {} s", opened.elapsed().as_secs()));
                    }
                    _ => {}
                }
                if self.want_key.swap(false, Ordering::Relaxed) {
                    return Ended::Stalled(format!("a viewer waited {} s for a key frame", STALL.as_secs()));
                }
            }
            if self.tx.receiver_count() > 0 {
                idle_since = None;
                continue;
            }
            let since = *idle_since.get_or_insert_with(Instant::now);
            let wait = if self.viewed.load(Ordering::Relaxed) {
                LINGER
            } else {
                Duration::ZERO
            };
            if since.elapsed() >= wait && self.feeds.close_if_idle(&self.printer, self.generation) {
                return Ended::Idle;
            }
        }
    }

    /// Every [`RATE_EVERY`]: the frames, key frames and rate of the last window, and the readers.
    fn log_rate(&self) {
        let mut r = lock(&self.rate);
        let secs = r.since.elapsed();
        if secs < RATE_EVERY {
            return;
        }
        #[allow(clippy::cast_precision_loss, reason = "a frame count")]
        let fps = r.frames as f64 / secs.as_secs_f64();
        sx_connect::trace(
            &self.printer,
            format_args!(
                "camera feed: {} frames ({} key) in {} s, {fps:.1} fps, {} readers",
                r.frames,
                r.keys,
                secs.as_secs(),
                self.tx.receiver_count()
            ),
        );
        let latest = r.latest;
        *r = Rate {
            since: Instant::now(),
            frames: 0,
            keys: 0,
            last: Some(fps),
            latest,
        };
    }

    /// Sets the status when it changes.
    fn tell(&self, s: FeedStatus) {
        self.status.send_if_modified(|now| {
            let changed = *now != s;
            *now = s;
            changed
        });
    }

    /// Waits `d` before a retry; false when the last reader left meanwhile (the feed is closed).
    async fn wait(&self, d: Duration) -> bool {
        let end = Instant::now() + d;
        while Instant::now() < end {
            if self.tx.receiver_count() == 0 && self.feeds.close_if_idle(&self.printer, self.generation) {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(250).min(end - Instant::now())).await;
        }
        true
    }
}

/// The reason a viewer's feed gives while the camera is held; `retryInMs` says when it tries again.
pub(crate) const BUSY: &str = "The camera is busy.";

/// What a still or other one-off reader gets while the camera is held, with the `timeout` code: the
/// camera is fine, and trying again after the wait is the remedy.
pub(crate) fn busy_error(left: Duration) -> RpcError {
    RpcError::new(
        "timeout",
        format!("The camera is busy. Try again in {} s.", whole_secs(left)),
    )
}

/// Seconds rounded up, at least 1, so a wait is never shown as 0 s.
fn whole_secs(d: Duration) -> u64 {
    u64::try_from(d.as_millis().div_ceil(1000).max(1)).unwrap_or(u64::MAX)
}

/// A reader: `replay` first (the frames since the last key frame, or that key frame alone), then
/// the frames as they come. One that needs a key frame (only the key frame replayed, or it fell
/// behind) skips the frames before the next one, since they depend on ones it never got; after
/// [`STALL`] of that it sets `want_key`, and the feed starts a new session for a fresh key frame.
fn reader(
    rx: broadcast::Receiver<CameraFrame>,
    replay: Vec<CameraFrame>,
    need_key: bool,
    want_key: Arc<AtomicBool>,
) -> FrameStream {
    struct State {
        rx: broadcast::Receiver<CameraFrame>,
        replay: std::vec::IntoIter<CameraFrame>,
        need_key: bool,
        waiting_since: Option<Instant>,
        want_key: Arc<AtomicBool>,
    }
    let state = State {
        rx,
        replay: replay.into_iter(),
        need_key,
        waiting_since: need_key.then(Instant::now),
        want_key,
    };
    unfold(state, |mut st| async move {
        if let Some(f) = st.replay.next() {
            return Some((f, st));
        }
        loop {
            match st.rx.recv().await {
                Ok(f) if st.need_key && !f.key => {
                    let since = *st.waiting_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= STALL {
                        st.want_key.store(true, Ordering::Relaxed);
                        st.waiting_since = Some(Instant::now());
                    }
                }
                Ok(f) => {
                    st.need_key = false;
                    st.waiting_since = None;
                    return Some((f, st));
                }
                Err(RecvError::Lagged(_)) => {
                    st.need_key = true;
                    st.waiting_since.get_or_insert_with(Instant::now);
                }
                Err(RecvError::Closed) => return None,
            }
        }
    })
    .boxed()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::atomic::AtomicU32;

    use super::*;

    fn frame(key: bool, n: u8) -> CameraFrame {
        CameraFrame {
            kind: FrameKind::H264,
            key,
            data: vec![n],
        }
    }

    /// A source that sends `frames` one every 10 ms, then a delta frame every 100 ms for good, and
    /// marks when it is dropped.
    fn source(frames: Vec<CameraFrame>, dropped: Arc<StdMutex<bool>>) -> FrameStream {
        let more = futures::stream::repeat_with(|| frame(false, 0)).then(|f| async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            f
        });
        with_mark(
            futures::stream::iter(frames)
                .then(|f| async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    f
                })
                .chain(more)
                .boxed(),
            dropped,
        )
    }

    /// A source that sends `frames` one every 10 ms, then nothing, with the connection still open:
    /// the camera that stopped in rc14.
    fn silent(frames: Vec<CameraFrame>, dropped: Arc<StdMutex<bool>>) -> FrameStream {
        with_mark(
            futures::stream::iter(frames)
                .then(|f| async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    f
                })
                .chain(futures::stream::pending())
                .boxed(),
            dropped,
        )
    }

    fn with_mark(s: FrameStream, dropped: Arc<StdMutex<bool>>) -> FrameStream {
        struct Mark(Arc<StdMutex<bool>>);
        impl Drop for Mark {
            fn drop(&mut self) {
                *lock(&self.0) = true;
            }
        }
        let mark = Mark(dropped);
        s.map(move |f| {
            let _ = &mark;
            f
        })
        .boxed()
    }

    fn never() -> Opener {
        Arc::new(|| Box::pin(async { Err(RpcError::new("timeout", "unused")) }))
    }

    #[tokio::test(start_paused = true)]
    async fn readers_share_one_source_and_a_late_one_starts_on_the_last_key_frame() {
        let feeds = Arc::new(Feeds::default());
        let dropped = Arc::new(StdMutex::new(false));
        let frames = vec![frame(true, 1), frame(false, 2), frame(false, 3)];
        let mut a = feeds.start("p", Ok(source(frames, dropped.clone())), true, never());
        assert_eq!(a.next().await.unwrap().data, [1]);
        assert_eq!(a.next().await.unwrap().data, [2]);
        assert_eq!(a.next().await.unwrap().data, [3]);
        // A second reader gets the frames since the last key frame at once, then the live ones,
        // from the same source: its decoder starts without waiting for the camera's next key frame.
        let mut b = feeds.subscribe("p", true).expect("the feed is running");
        let f = b.next().await.unwrap();
        assert!(f.key);
        assert_eq!(f.data, [1]);
        assert_eq!(b.next().await.unwrap().data, [2]);
        assert_eq!(b.next().await.unwrap().data, [3]);
        assert_eq!(b.next().await.unwrap().data, [0], "then live");
        drop(a);
        drop(b);
        // Nobody reads: the feed lingers, then closes and drops the source.
        tokio::time::sleep(LINGER / 2).await;
        assert!(!*lock(&dropped));
        assert!(
            feeds.subscribe("p", true).is_some(),
            "still open while it lingers"
        );
        tokio::time::sleep(LINGER * 2).await;
        assert!(*lock(&dropped));
        assert!(feeds.subscribe("p", true).is_none());
    }

    // A still takes its key frame and lets go; with no viewer the feed closes right away. For the
    // cooldown after, a still gets that key frame instead of a new session.
    #[tokio::test(start_paused = true)]
    async fn a_feed_only_stills_read_closes_at_once_and_rests() {
        let feeds = Arc::new(Feeds::default());
        let dropped = Arc::new(StdMutex::new(false));
        let mut still = feeds.start(
            "p",
            Ok(source(vec![frame(true, 1), frame(false, 2)], dropped.clone())),
            false,
            never(),
        );
        assert!(still.next().await.unwrap().key);
        drop(still);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(*lock(&dropped), "closed within a tick, not after the linger");
        assert!(feeds.subscribe("p", false).is_none());
        let Some(Rest::Frame(f)) = feeds.resting("p") else {
            panic!("resting, with the last key frame")
        };
        assert_eq!(f.data, [1]);
        tokio::time::sleep(COOLDOWN).await;
        assert!(feeds.resting("p").is_none(), "rested long enough");
    }

    // A feed that closed with no key frame to reuse: a still waits the rest out.
    #[tokio::test(start_paused = true)]
    async fn with_no_frame_to_reuse_a_still_waits_out_the_rest() {
        let feeds = Arc::new(Feeds::default());
        let dropped = Arc::new(StdMutex::new(false));
        let still = feeds.start("p", Ok(silent(Vec::new(), dropped.clone())), false, never());
        drop(still);
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(*lock(&dropped));
        let Some(Rest::Wait(left)) = feeds.resting("p") else {
            panic!("resting, with nothing to give")
        };
        assert!(
            left + Duration::from_secs(1) > COOLDOWN && left <= COOLDOWN,
            "{left:?}"
        );
        tokio::time::sleep(COOLDOWN).await;
        assert!(feeds.resting("p").is_none());
    }

    // Stills with no feed open: one session per 30 s; in between, the last key frame.
    #[tokio::test(start_paused = true)]
    async fn stills_open_a_session_at_most_every_30_s() {
        let feeds = Arc::new(Feeds::default());
        assert!(feeds.paced_still("p").is_none(), "never opened");
        feeds.still_opening("p");
        let still = feeds.start(
            "p",
            Ok(source(vec![frame(true, 4)], Arc::new(StdMutex::new(false)))),
            false,
            never(),
        );
        let mut still = still;
        assert_eq!(still.next().await.unwrap().data, [4]);
        drop(still);
        tokio::time::sleep(COOLDOWN + Duration::from_secs(1)).await;
        assert!(feeds.resting("p").is_none(), "past the rest");
        let (f, ago) = feeds.paced_still("p").expect("paced");
        assert_eq!(f.data, [4]);
        assert!(ago < STILL_EVERY);
        tokio::time::sleep(STILL_EVERY).await;
        assert!(feeds.paced_still("p").is_none(), "time for a new session");
    }

    #[test]
    fn refusals_are_counted_per_printer() {
        let feeds = Feeds::default();
        feeds.count_open("p", false);
        feeds.count_open("p", true);
        assert_eq!(
            feeds.count_open("p", false),
            "1 of 3 camera sessions refused, 1 of 3 in the last 10 min"
        );
        assert_eq!(
            feeds.count_open("q", true),
            "1 of 1 camera sessions refused, 1 of 1 in the last 10 min"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_reader_returning_within_the_linger_keeps_the_feed() {
        let feeds = Arc::new(Feeds::default());
        let dropped = Arc::new(StdMutex::new(false));
        let a = feeds.start(
            "p",
            Ok(source(vec![frame(true, 1)], dropped.clone())),
            true,
            never(),
        );
        drop(a);
        tokio::time::sleep(LINGER / 2).await;
        let b = feeds.subscribe("p", true).expect("reused");
        tokio::time::sleep(LINGER * 2).await;
        assert!(!*lock(&dropped), "a reader is on it");
        drop(b);
        tokio::time::sleep(LINGER * 2).await;
        assert!(*lock(&dropped));
    }

    // rc13: the camera dropped PLAY and the view sat on "did not start" for good. A viewer's feed
    // tries again after 5 s, 10 s, then 15 s, says so to its readers, and goes live when it opens.
    #[tokio::test(start_paused = true)]
    async fn a_viewer_feed_retries_with_backoff_until_the_camera_opens() {
        let feeds = Arc::new(Feeds::default());
        let tries = Arc::new(AtomicU32::new(0));
        let dropped = Arc::new(StdMutex::new(false));
        let reopen: Opener = {
            let (tries, dropped) = (tries.clone(), dropped.clone());
            Arc::new(move || {
                let n = tries.fetch_add(1, Ordering::Relaxed);
                let dropped = dropped.clone();
                Box::pin(async move {
                    if n < 2 {
                        Err(RpcError::new(
                            "timeout",
                            "the camera closed the connection at PLAY",
                        ))
                    } else {
                        Ok(source(vec![frame(true, 7)], dropped))
                    }
                })
            })
        };
        let started = Instant::now();
        let mut view = feeds.start(
            "p",
            Err(RpcError::new("timeout", "dropped at PLAY")),
            true,
            reopen,
        );
        let status = feeds.status("p").unwrap();
        assert_eq!(
            *status.borrow(),
            FeedStatus::Retrying {
                attempt: 1,
                in_ms: 5000,
                reason: "dropped at PLAY".into(),
                busy: false,
            }
        );
        let f = view.next().await.unwrap();
        assert_eq!(f.data, [7]);
        // 5 s, then 10 s, then 15 s before the third reopen, which opened.
        assert_eq!(started.elapsed().as_secs(), 30);
        assert_eq!(tries.load(Ordering::Relaxed), 3);
        assert_eq!(*status.borrow(), FeedStatus::Live);
    }

    /// Reopens with a live source, counting the tries.
    fn live_reopen(tries: Arc<AtomicU32>) -> Opener {
        Arc::new(move || {
            tries.fetch_add(1, Ordering::Relaxed);
            let dropped = Arc::new(StdMutex::new(false));
            Box::pin(async move { Ok(source(vec![frame(true, 9)], dropped)) })
        })
    }

    // rc14: the camera stopped sending with the connection still open, and the view sat on one
    // frame. A viewer's feed with no frame for 3 s ends that session (TEARDOWN), says retrying,
    // and opens a new one after the rest; then frames come again and it says live.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_feed_is_ended_and_opened_again() {
        let feeds = Arc::new(Feeds::default());
        let dropped = Arc::new(StdMutex::new(false));
        let tries = Arc::new(AtomicU32::new(0));
        let mut view = feeds.start(
            "p",
            Ok(silent(vec![frame(true, 1), frame(false, 2)], dropped.clone())),
            true,
            live_reopen(tries.clone()),
        );
        let mut status = feeds.status("p").unwrap();
        assert_eq!(view.next().await.unwrap().data, [1]);
        assert_eq!(view.next().await.unwrap().data, [2]);
        status.changed().await.unwrap();
        assert!(
            matches!(&*status.borrow(), FeedStatus::Retrying { reason, .. } if reason == "no frame for 3 s"),
            "{:?}",
            *status.borrow()
        );
        assert!(*lock(&dropped), "the stalled session was ended");
        assert_eq!(view.next().await.unwrap().data, [9], "a new session");
        assert_eq!(*status.borrow(), FeedStatus::Live);
        assert_eq!(tries.load(Ordering::Relaxed), 1);
    }

    // A viewer that joins after the feed's replay buffer overflowed gets the key frame alone and
    // waits for the next; when none comes in 3 s, the feed opens a new session for one.
    #[tokio::test(start_paused = true)]
    async fn a_viewer_waiting_for_a_key_frame_gets_a_new_session() {
        let feeds = Arc::new(Feeds::default());
        let dropped = Arc::new(StdMutex::new(false));
        let tries = Arc::new(AtomicU32::new(0));
        let first = feeds.start(
            "p",
            Ok(source(vec![frame(true, 1)], dropped.clone())),
            true,
            live_reopen(tries.clone()),
        );
        // More delta frames than the buffer keeps: about 100 s of them at 10 a second.
        let mut first = first;
        for _ in 0..=GOP_FRAMES {
            first.next().await.unwrap();
        }
        let mut late = feeds.subscribe("p", true).unwrap();
        assert!(late.next().await.unwrap().key, "the key frame alone");
        drop(first);
        let f = tokio::time::timeout(Duration::from_secs(20), late.next())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(f.data, [9], "the new session's key frame");
        assert!(*lock(&dropped));
        assert_eq!(tries.load(Ordering::Relaxed), 1);
    }

    // One close at PLAY is routine and holds nothing. From the second in a row the camera is held,
    // longer each time up to the cap, and the first session that opens ends it.
    #[tokio::test(start_paused = true)]
    async fn closes_in_a_row_hold_the_camera_longer_each_time_until_one_opens() {
        let feeds = Feeds::default();
        feeds.count_open("p", true);
        assert!(feeds.held("p").is_none(), "a single close is tried again at once");
        let mut holds = Vec::new();
        for _ in 0..5 {
            let tally = feeds.count_open("p", true);
            assert!(
                tally.contains("in a row, the camera is left alone for"),
                "{tally}"
            );
            holds.push(feeds.held("p").unwrap().as_secs());
        }
        assert_eq!(holds, [15, 30, 60, 70, 70]);
        assert!(feeds.held("q").is_none(), "per printer");
        tokio::time::sleep(Duration::from_secs(71)).await;
        assert!(feeds.held("p").is_none(), "the hold runs out");
        // A session that opens resets the run: the next close is a single one again.
        feeds.count_open("p", true);
        assert_eq!(feeds.held("p").unwrap().as_secs(), 70, "still in a run");
        feeds.count_open("p", false);
        assert!(feeds.held("p").is_none(), "an open ends the hold at once");
        feeds.count_open("p", true);
        assert!(feeds.held("p").is_none());
        feeds.count_open("p", true);
        assert_eq!(feeds.held("p").unwrap().as_secs(), 15);
        // The wait a still is told rounds up and is never 0 s.
        assert_eq!(
            busy_error(Duration::from_millis(14_200)).message,
            "The camera is busy. Try again in 15 s."
        );
        assert_eq!(
            busy_error(Duration::from_millis(3)).message,
            "The camera is busy. Try again in 1 s."
        );
        assert_eq!(busy_error(Duration::from_secs(1)).code, "timeout");
    }

    /// Opens as `open_camera_source` does, against a camera that closes every PLAY until `opens`:
    /// refused while held (no session), else one try counted.
    fn closing_camera(feeds: Arc<Feeds>, tries: Arc<StdMutex<Vec<u64>>>, opens: Arc<AtomicBool>) -> Opener {
        let started = Instant::now();
        Arc::new(move || {
            let (feeds, tries, opens) = (feeds.clone(), tries.clone(), opens.clone());
            Box::pin(async move {
                if let Some(left) = feeds.held("p") {
                    return Err(busy_error(left));
                }
                lock(&tries).push(started.elapsed().as_secs());
                let ok = opens.load(Ordering::Relaxed);
                feeds.count_open("p", !ok);
                if ok {
                    Ok(source(vec![frame(true, 5)], Arc::new(StdMutex::new(false))))
                } else {
                    Err(RpcError::new(
                        "timeout",
                        "the camera closed the connection at PLAY",
                    ))
                }
            })
        })
    }

    // The H2D: after a few closes in a row, quick tries kept it closing. A viewer's feed now leaves
    // the camera alone for the growing hold, says it is busy, and opens once the camera takes it.
    #[tokio::test(start_paused = true)]
    async fn a_viewer_feed_leaves_a_camera_that_keeps_closing_alone() {
        let feeds = Arc::new(Feeds::default());
        let tries = Arc::new(StdMutex::new(Vec::new()));
        let opens = Arc::new(AtomicBool::new(false));
        let reopen = closing_camera(feeds.clone(), tries.clone(), opens.clone());
        let first = reopen().await;
        let mut view = feeds.start("p", first, true, reopen);
        let mut status = feeds.status("p").unwrap();
        let mut seen = vec![status.borrow().clone()];
        let watch = tokio::spawn(async move {
            while status.changed().await.is_ok() {
                seen.push(status.borrow().clone());
            }
            seen
        });
        tokio::time::sleep(Duration::from_secs(185)).await;
        // Tries at 0 and 5 s (a single close is tried again soon), then 15, 30 and 60 s apart,
        // 70 s after that: 6 in 3 minutes, where the plain backoff would have made 13.
        assert_eq!(*lock(&tries), [0, 5, 20, 50, 110, 180]);
        opens.store(true, Ordering::Relaxed);
        let f = view.next().await.unwrap();
        assert_eq!(f.data, [5]);
        assert_eq!(lock(&tries).last().copied(), Some(250), "after the 70 s hold");
        assert!(feeds.held("p").is_none(), "the open ended the hold");
        drop(view);
        tokio::time::sleep(LINGER * 2).await;
        let seen = watch.await.unwrap();
        let retrying: Vec<(u64, bool, String)> = seen
            .iter()
            .filter_map(|s| match s {
                FeedStatus::Retrying {
                    in_ms, busy, reason, ..
                } => Some((in_ms / 1000, *busy, reason.clone())),
                _ => None,
            })
            .collect();
        let busy = |s: u64| (s, true, BUSY.to_owned());
        assert_eq!(
            retrying,
            [
                (5, false, "the camera closed the connection at PLAY".to_owned()),
                busy(15),
                busy(30),
                busy(60),
                busy(70),
                busy(70),
            ]
        );
        assert_eq!(seen.last(), Some(&FeedStatus::Live));
    }

    // A still's feed does not retry, and a viewer that leaves stops the retries.
    #[tokio::test(start_paused = true)]
    async fn retries_stop_without_a_viewer() {
        let feeds = Arc::new(Feeds::default());
        let tries = Arc::new(AtomicU32::new(0));
        let reopen: Opener = {
            let tries = tries.clone();
            Arc::new(move || {
                tries.fetch_add(1, Ordering::Relaxed);
                Box::pin(async { Err(RpcError::new("timeout", "dropped")) })
            })
        };
        let still = feeds.start(
            "s",
            Err(RpcError::new("timeout", "dropped")),
            false,
            reopen.clone(),
        );
        let view = feeds.start("v", Err(RpcError::new("timeout", "dropped")), true, reopen);
        tokio::time::sleep(Duration::from_secs(6)).await;
        assert_eq!(
            tries.load(Ordering::Relaxed),
            1,
            "only the viewer's feed tried again"
        );
        drop(view);
        drop(still);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(tries.load(Ordering::Relaxed), 1);
        assert!(feeds.status("v").is_none() && feeds.status("s").is_none());
    }
}
