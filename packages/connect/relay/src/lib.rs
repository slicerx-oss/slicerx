// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! sx-relay: the hosted pairing relay. It forwards sealed frames between opaque routes, follows the
//! rules of `createMemoryRelay` in `packages/pair/src/relay.ts`, adds quotas, and keeps nothing on
//! disk. It never parses a body and never logs a route or a body; it logs counters only.
//!
//! Protocol (one JSON object per WebSocket text frame), as in `packages/pair/README.md`:
//! client `auth`, `sub`, `unsub`, `send`, plus `quota`; relay `msg`, `error`, plus replies to
//! `auth` and `quota`. See README.md next to this crate.

pub mod auth;
mod month;
pub mod quota;
pub mod route;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::auth::{AuthError, Session, Verifier};
use crate::quota::{Bucket, Limits, Meter, MeterKey, Refusal, TierLimits};

/// The WebSocket path the relay serves.
pub const PATH: &str = "/v1";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Wall time in Unix milliseconds. Injected so tests can move it.
pub trait Clock: Send + Sync + 'static {
    fn now_ms(&self) -> u64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    #[allow(clippy::cast_possible_truncation)]
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
}

/// A clock tests set by hand.
#[derive(Default)]
pub struct ManualClock(AtomicU64);

impl ManualClock {
    pub fn new(ms: u64) -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(ms)))
    }
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct RelayConfig {
    pub limits: Limits,
    /// Checks account sessions. Without one, `auth` is refused and only opaque routes work.
    pub verifier: Option<Verifier>,
    /// Take the client address from `X-Forwarded-For` when the connection comes from loopback
    /// (the TLS proxy in front of the relay).
    pub trust_proxy: bool,
    pub clock: Arc<dyn Clock>,
    /// The relay pings each connection this often and closes one silent for three times as long.
    pub ping_every: Duration,
    /// Print a line of counters this often (`None`: never).
    pub log_every: Option<Duration>,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            limits: Limits::default(),
            verifier: None,
            trust_proxy: false,
            clock: Arc::new(SystemClock),
            ping_every: Duration::from_secs(30),
            log_every: None,
        }
    }
}

/// Counters, the only thing the relay reports about its traffic.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub connections: usize,
    pub accounts_online: usize,
    pub routes: usize,
    pub queued_bytes: usize,
    pub frames: u64,
    pub bytes: u64,
    pub refused: u64,
}

struct Conn {
    tx: mpsc::UnboundedSender<Message>,
    pending: Arc<AtomicUsize>,
    /// The client's address, for the anonymous meter after a session expires.
    ip: IpAddr,
    meter: MeterKey,
    session: Option<Session>,
    subs: HashSet<String>,
    month_warned: bool,
    closing: bool,
    /// Refused frames in a row.
    strikes: u32,
}

struct Queued {
    body: Arc<str>,
    at: u64,
    /// Who sent it: each meter has its own share of the queue.
    meter: MeterKey,
}

#[derive(Default)]
struct State {
    conns: HashMap<u64, Conn>,
    routes: HashMap<String, HashSet<u64>>,
    queues: HashMap<String, VecDeque<Queued>>,
    queued_bytes: usize,
    queued_by: HashMap<MeterKey, usize>,
    meters: HashMap<MeterKey, Meter>,
    dialers: HashMap<IpAddr, Bucket>,
    /// Connections open per IPv6 /48.
    wide: HashMap<IpAddr, u32>,
    frames: u64,
    bytes: u64,
    refused: u64,
}

impl State {
    /// Takes one queued body off the counters.
    fn unqueued(&mut self, m: &Queued) {
        self.queued_bytes = self.queued_bytes.saturating_sub(m.body.len());
        if let Some(n) = self.queued_by.get_mut(&m.meter) {
            *n = n.saturating_sub(m.body.len());
            if *n == 0 {
                self.queued_by.remove(&m.meter);
            }
        }
    }
}

/// One client frame, read before the relay's lock is taken. Strings borrow from the frame where
/// they can, and fields the relay does not use are skipped without being built.
#[derive(serde::Deserialize)]
struct Frame<'a> {
    #[serde(borrow, default)]
    op: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    to: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    body: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    route: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    token: Option<Cow<'a, str>>,
}

struct Shared {
    cfg: RelayConfig,
    state: Mutex<State>,
    next_id: AtomicU64,
    /// Bytes waiting to be written over all connections.
    unsent: Arc<AtomicUsize>,
}

/// A running relay.
pub struct RelayHandle {
    pub addr: SocketAddr,
    shared: Arc<Shared>,
    tasks: Vec<JoinHandle<()>>,
}

impl RelayHandle {
    pub fn stats(&self) -> Stats {
        self.shared.stats()
    }

    /// Expires queued frames and forgets idle meters now, instead of at the next minute.
    pub fn sweep(&self) {
        self.shared.sweep();
    }

    pub fn stop(self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// Starts the relay on a bound listener.
pub fn spawn(listener: TcpListener, cfg: RelayConfig) -> std::io::Result<RelayHandle> {
    let addr = listener.local_addr()?;
    let log_every = cfg.log_every;
    let shared = Arc::new(Shared {
        cfg,
        state: Mutex::new(State::default()),
        next_id: AtomicU64::new(1),
        unsent: Arc::new(AtomicUsize::new(0)),
    });
    let s = shared.clone();
    let accept = tokio::spawn(async move {
        loop {
            let Ok((stream, peer)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            };
            let _ = stream.set_nodelay(true);
            tokio::spawn(s.clone().serve(stream, peer));
        }
    });
    let s = shared.clone();
    let sweeper = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        let mut last_log = tokio::time::Instant::now();
        loop {
            tick.tick().await;
            s.sweep();
            if let Some(every) = log_every
                && last_log.elapsed() >= every
            {
                last_log = tokio::time::Instant::now();
                let st = s.stats();
                eprintln!(
                    "sx-relay: {} connections, {} accounts online, {} routes, {} queued bytes, {} frames, {} bytes, {} refused",
                    st.connections,
                    st.accounts_online,
                    st.routes,
                    st.queued_bytes,
                    st.frames,
                    st.bytes,
                    st.refused
                );
            }
        }
    });
    Ok(RelayHandle {
        addr,
        shared,
        tasks: vec![accept, sweeper],
    })
}

fn error(code: &str, message: &str) -> String {
    json!({ "op": "error", "code": code, "message": message }).to_string()
}

fn refusal(r: Refusal) -> String {
    let message = match r {
        Refusal::Second | Refusal::Minute => "too many frames, slow down",
        Refusal::Month => "monthly relay traffic used up; it resets at the start of next month (UTC)",
        Refusal::Connections => "too many connections open",
    };
    json!({ "op": "error", "code": "rate_limited", "scope": r.scope(), "message": message }).to_string()
}

impl Shared {
    fn now(&self) -> u64 {
        self.cfg.clock.now_ms()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn tier(&self, key: &MeterKey) -> &TierLimits {
        match key {
            MeterKey::Account(_) => &self.cfg.limits.account,
            MeterKey::Address(_) => &self.cfg.limits.anonymous,
        }
    }

    fn stats(&self) -> Stats {
        let st = self.lock();
        Stats {
            connections: st.conns.len(),
            accounts_online: st
                .meters
                .iter()
                .filter(|(k, m)| matches!(k, MeterKey::Account(_)) && m.live > 0)
                .count(),
            routes: st.routes.len(),
            queued_bytes: st.queued_bytes,
            frames: st.frames,
            bytes: st.bytes,
            refused: st.refused,
        }
    }

    fn client_ip(&self, req: &Request, peer: SocketAddr) -> IpAddr {
        if self.cfg.trust_proxy && peer.ip().is_loopback() {
            let forwarded = req
                .headers()
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit(',').next())
                .and_then(|v| v.trim().parse::<IpAddr>().ok());
            if let Some(ip) = forwarded {
                return ip;
            }
        }
        peer.ip()
    }

    /// Path check and the per-address dial rate, before the WebSocket is accepted.
    fn admit(&self, req: &Request, peer: SocketAddr) -> Result<IpAddr, StatusCode> {
        if req.uri().path() != PATH {
            return Err(StatusCode::NOT_FOUND);
        }
        let ip = quota::address_key(self.client_ip(req, peer));
        let now = self.now();
        let per_min = u64::from(self.cfg.limits.new_connections_per_minute);
        let mut st = self.lock();
        if st.conns.len() >= self.cfg.limits.max_connections {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        let b = st.dialers.entry(ip).or_insert_with(|| Bucket::full(per_min, now));
        if !b.take(1, per_min, 60_000, now) {
            st.refused += 1;
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        Ok(ip)
    }

    async fn serve(self: Arc<Self>, stream: TcpStream, peer: SocketAddr) {
        let mut cfg = WebSocketConfig::default();
        cfg.max_message_size = Some(self.cfg.limits.max_body + 65_536);
        cfg.max_frame_size = Some(self.cfg.limits.max_body + 65_536);
        let admitted: Arc<Mutex<Option<IpAddr>>> = Arc::new(Mutex::new(None));
        let me = self.clone();
        let out = admitted.clone();
        #[allow(clippy::result_large_err)] // The callback type is tungstenite's.
        let cb = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            match me.admit(req, peer) {
                Ok(ip) => {
                    *out.lock().unwrap_or_else(PoisonError::into_inner) = Some(ip);
                    Ok(resp)
                }
                Err(status) => {
                    let mut r = ErrorResponse::new(None);
                    *r.status_mut() = status;
                    Err(r)
                }
            }
        };
        let accept = tokio_tungstenite::accept_hdr_async_with_config(stream, cb, Some(cfg));
        let Ok(Ok(ws)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, accept).await else {
            return;
        };
        let Some(ip) = *admitted.lock().unwrap_or_else(PoisonError::into_inner) else {
            return;
        };
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let pending = Arc::new(AtomicUsize::new(0));
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if !self.open(id, ip, tx.clone(), pending.clone()) {
            let _ = sink.send(Message::text(refusal(Refusal::Connections))).await;
            let _ = sink.close().await;
            return;
        }
        let (drained, unsent) = (pending.clone(), self.unsent.clone());
        let mut writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let n = if let Message::Text(t) = &m { t.len() } else { 0 };
                let close = matches!(m, Message::Close(_));
                let ok = sink.send(m).await.is_ok();
                drained.fetch_sub(n, Ordering::Relaxed);
                unsent.fetch_sub(n, Ordering::Relaxed);
                if !ok || close {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        let mut ping = tokio::time::interval(self.cfg.ping_every);
        ping.tick().await;
        let mut heard = tokio::time::Instant::now();
        loop {
            tokio::select! {
                msg = source.next() => match msg {
                    Some(Ok(Message::Text(t))) => {
                        heard = tokio::time::Instant::now();
                        self.handle(id, t.as_str());
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => heard = tokio::time::Instant::now(),
                    // Binary frames, oversize frames, close frames and errors end the connection.
                    _ => break,
                },
                _ = ping.tick() => {
                    if heard.elapsed() > self.cfg.ping_every * 3 {
                        break;
                    }
                    let _ = tx.send(Message::Ping(Vec::new().into()));
                }
                _ = &mut writer => break,
            }
        }
        self.close(id);
        drop(tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut writer).await;
        writer.abort();
        let _ = writer.await;
        // Whatever was never written leaves the relay-wide count with the connection.
        self.unsent
            .fetch_sub(pending.swap(0, Ordering::Relaxed), Ordering::Relaxed);
    }

    fn open(
        &self,
        id: u64,
        ip: IpAddr,
        tx: mpsc::UnboundedSender<Message>,
        pending: Arc<AtomicUsize>,
    ) -> bool {
        let now = self.now();
        let key = MeterKey::address(ip);
        let tier = *self.tier(&key);
        let mut st = self.lock();
        let wide = quota::wide_key(ip);
        if let Some(w) = wide
            && st.wide.get(&w).copied().unwrap_or(0) >= self.cfg.limits.connections_per_v6_48
        {
            st.refused += 1;
            return false;
        }
        let m = st
            .meters
            .entry(key.clone())
            .or_insert_with(|| Meter::new(&tier, now));
        if m.live >= tier.live_connections {
            st.refused += 1;
            return false;
        }
        m.live += 1;
        if let Some(w) = wide {
            *st.wide.entry(w).or_default() += 1;
        }
        st.conns.insert(
            id,
            Conn {
                tx,
                pending,
                ip,
                meter: key,
                session: None,
                subs: HashSet::new(),
                month_warned: false,
                closing: false,
                strikes: 0,
            },
        );
        true
    }

    fn close(&self, id: u64) {
        let mut st = self.lock();
        let Some(c) = st.conns.remove(&id) else { return };
        for r in &c.subs {
            if let Some(set) = st.routes.get_mut(r) {
                set.remove(&id);
                if set.is_empty() {
                    st.routes.remove(r);
                }
            }
        }
        if let Some(m) = st.meters.get_mut(&c.meter) {
            m.live = m.live.saturating_sub(1);
        }
        if let Some(w) = quota::wide_key(c.ip)
            && let Some(n) = st.wide.get_mut(&w)
        {
            *n = n.saturating_sub(1);
            if *n == 0 {
                st.wide.remove(&w);
            }
        }
    }

    fn handle(&self, id: u64, text: &str) {
        let now = self.now();
        // Every inbound frame, whatever it is, costs one from its meter's frame rate before it is
        // read, so frames that are not `send` cannot be streamed for free.
        {
            let mut st = self.lock();
            if !st.conns.contains_key(&id) {
                return;
            }
            self.demote_expired(&mut st, id, now);
            let Some(key) = st.conns.get(&id).map(|c| c.meter.clone()) else {
                return;
            };
            let tier = *self.tier(&key);
            let charged = st
                .meters
                .get_mut(&key)
                .map_or(Err(Refusal::Connections), |m| m.charge_frame(&tier, now));
            if let Err(r) = charged {
                self.refuse(&mut st, id, refusal(r));
                return;
            }
        }
        // Parsed and, for `auth`, verified without the lock: other connections keep moving.
        let Ok(f) = serde_json::from_str::<Frame<'_>>(text) else {
            let mut st = self.lock();
            self.refuse(&mut st, id, error("bad_request", "frames are JSON objects"));
            return;
        };
        let verified = match (f.op.as_deref(), f.token.as_deref(), &self.cfg.verifier) {
            (Some("auth"), Some(t), Some(v)) => Some(v.verify(t, now)),
            _ => None,
        };
        let mut st = self.lock();
        if !st.conns.contains_key(&id) {
            return;
        }
        let refused_before = st.refused;
        match f.op.as_deref() {
            Some("send") => match (f.to.as_deref(), f.body.as_deref()) {
                (Some(to), Some(body)) => self.send(&mut st, id, to, body, now),
                _ => self.refuse(&mut st, id, error("bad_request", "send needs to and body")),
            },
            Some("sub") => match f.route.as_deref() {
                Some(r) => self.subscribe(&mut st, id, r, now),
                None => self.refuse(&mut st, id, error("bad_request", "sub needs a route")),
            },
            Some("unsub") => {
                if let Some(r) = f.route.as_deref() {
                    Self::unsubscribe(&mut st, id, r);
                }
            }
            Some("auth") => match f.token {
                Some(_) => self.auth(&mut st, id, verified, now),
                None => self.refuse(&mut st, id, error("bad_request", "auth needs a token")),
            },
            Some("quota") => {
                let r = self.quota(&mut st, id, now);
                self.reply(&mut st, id, r);
            }
            _ => self.refuse(&mut st, id, error("bad_request", "unknown op")),
        }
        if st.refused == refused_before
            && let Some(c) = st.conns.get_mut(&id)
        {
            c.strikes = 0;
        }
    }

    /// Answers a refused frame. A connection whose frames keep being refused is closed.
    fn refuse(&self, st: &mut State, id: u64, text: String) {
        st.refused += 1;
        let Some(c) = st.conns.get_mut(&id) else { return };
        c.strikes += 1;
        let close = c.strikes >= self.cfg.limits.refusals_before_close;
        self.reply(st, id, text);
        if close
            && let Some(c) = st.conns.get_mut(&id)
            && !c.closing
        {
            c.closing = true;
            let _ = c.tx.send(Message::Close(None));
        }
    }

    /// A connection whose account session ran out goes back to its address's anonymous meter and
    /// loses its account routes, instead of keeping the account tier until it disconnects.
    fn demote_expired(&self, st: &mut State, id: u64, now: u64) {
        let Some(c) = st.conns.get_mut(&id) else { return };
        if c.session.as_ref().is_none_or(|s| s.expires_ms > now) {
            return;
        }
        c.session = None;
        let new = MeterKey::address(c.ip);
        let old = std::mem::replace(&mut c.meter, new.clone());
        let account_routes: Vec<String> = c.subs.iter().filter(|r| !route::is_opaque(r)).cloned().collect();
        if let Some(m) = st.meters.get_mut(&old) {
            m.live = m.live.saturating_sub(1);
        }
        let tier = self.cfg.limits.anonymous;
        st.meters
            .entry(new)
            .or_insert_with(|| Meter::new(&tier, now))
            .live += 1;
        for r in account_routes {
            Self::unsubscribe(st, id, &r);
        }
        self.reply(
            st,
            id,
            error("expired", "the account session expired; this connection is on the anonymous tier until it signs in again"),
        );
    }

    /// Queues a frame for one connection, or closes it when its send buffer is full.
    fn reply(&self, st: &mut State, id: u64, text: String) {
        let Some(c) = st.conns.get_mut(&id) else { return };
        if c.closing {
            return;
        }
        let n = text.len();
        // Past the relay-wide limit nothing more is buffered for anyone until writers catch up.
        if self.unsent.load(Ordering::Relaxed) + n > self.cfg.limits.send_buffer_total {
            return;
        }
        if c.pending.fetch_add(n, Ordering::Relaxed) + n > self.cfg.limits.send_buffer {
            // A connection that does not read is closed rather than buffered without end.
            c.pending.fetch_sub(n, Ordering::Relaxed);
            c.closing = true;
            let _ = c.tx.send(Message::Close(None));
            return;
        }
        self.unsent.fetch_add(n, Ordering::Relaxed);
        let _ = c.tx.send(Message::text(text));
    }

    fn account(st: &State, id: u64, now: u64) -> Option<&str> {
        st.conns
            .get(&id)?
            .session
            .as_ref()
            .filter(|s| s.expires_ms > now)
            .map(|s| s.account.as_str())
    }

    fn send(&self, st: &mut State, id: u64, to: &str, body: &str, now: u64) {
        if body.len() > self.cfg.limits.max_body {
            self.refuse(st, id, error("too_large", "body too large"));
            return;
        }
        if !route::allowed(to, Self::account(st, id, now)) {
            self.refuse(st, id, error("forbidden", "route not allowed"));
            return;
        }
        let Some(key) = st.conns.get(&id).map(|c| c.meter.clone()) else {
            return;
        };
        let tier = *self.tier(&key);
        let len = body.len() as u64;
        let subs: Vec<u64> = st
            .routes
            .get(to)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        // The sender pays the rate for every copy the relay writes, not for one.
        let copies = u64::try_from(subs.len().max(1)).unwrap_or(u64::MAX);
        let charged = st.meters.get_mut(&key).map_or(Err(Refusal::Connections), |m| {
            m.charge_bytes(&tier, len, len.saturating_mul(copies), now)
        });
        if let Err(r) = charged {
            self.refuse(st, id, refusal(r));
            return;
        }
        st.frames += 1;
        st.bytes += len;
        let body: Arc<str> = Arc::from(body);
        if subs.is_empty() {
            self.enqueue(st, to, body, key, now);
        } else {
            let text = json!({ "op": "msg", "route": to, "body": &*body }).to_string();
            for sub in subs {
                self.deliver(st, sub, &text, len, now);
            }
        }
    }

    /// Hands one `msg` frame to a subscriber, charging its monthly total.
    fn deliver(&self, st: &mut State, id: u64, text: &str, len: u64, now: u64) {
        let Some(key) = st.conns.get(&id).map(|c| c.meter.clone()) else {
            return;
        };
        let tier = *self.tier(&key);
        let charged = st
            .meters
            .get_mut(&key)
            .map_or(Err(Refusal::Connections), |m| m.charge_receive(&tier, len, now));
        if let Err(r) = charged {
            let warn = st
                .conns
                .get_mut(&id)
                .is_some_and(|c| !std::mem::replace(&mut c.month_warned, true));
            if warn {
                self.reply(st, id, refusal(r));
            }
            return;
        }
        self.reply(st, id, text.to_owned());
    }

    fn enqueue(&self, st: &mut State, route: &str, body: Arc<str>, meter: MeterKey, now: u64) {
        let lim = &self.cfg.limits;
        let mine = st.queued_by.get(&meter).copied().unwrap_or(0);
        // Each meter fills only its own share, so one sender cannot crowd out everyone's queue.
        if st.queued_bytes + body.len() > lim.queue_bytes_total
            || mine + body.len() > lim.queue_bytes_per_meter
        {
            return;
        }
        let mut gone = Vec::new();
        let q = st.queues.entry(route.to_owned()).or_default();
        while q
            .front()
            .is_some_and(|m| now.saturating_sub(m.at) >= lim.queue_ttl_ms)
        {
            gone.extend(q.pop_front());
        }
        let added = body.len();
        q.push_back(Queued {
            body,
            at: now,
            meter: meter.clone(),
        });
        while q.len() > lim.queue_per_route {
            gone.extend(q.pop_front());
        }
        st.queued_bytes += added;
        *st.queued_by.entry(meter).or_default() += added;
        for m in &gone {
            st.unqueued(m);
        }
    }

    fn subscribe(&self, st: &mut State, id: u64, route: &str, now: u64) {
        if !route::allowed(route, Self::account(st, id, now)) {
            self.refuse(st, id, error("forbidden", "route not allowed"));
            return;
        }
        let Some(c) = st.conns.get(&id) else { return };
        let new = !c.subs.contains(route);
        if new && c.subs.len() >= self.cfg.limits.subscriptions_per_connection {
            self.refuse(st, id, error("rate_limited", "too many subscriptions"));
            return;
        }
        // A pairing route has one or two listeners; many would multiply every frame sent to it.
        if new
            && route::is_opaque(route)
            && st
                .routes
                .get(route)
                .is_some_and(|s| s.len() >= self.cfg.limits.subscribers_per_route)
        {
            self.refuse(
                st,
                id,
                error("rate_limited", "too many subscribers on this route"),
            );
            return;
        }
        if let Some(c) = st.conns.get_mut(&id) {
            c.subs.insert(route.to_owned());
        }
        st.routes.entry(route.to_owned()).or_default().insert(id);
        if let Some(q) = st.queues.remove(route) {
            for m in q {
                st.unqueued(&m);
                if now.saturating_sub(m.at) < self.cfg.limits.queue_ttl_ms {
                    let text = json!({ "op": "msg", "route": route, "body": &*m.body }).to_string();
                    self.deliver(st, id, &text, m.body.len() as u64, now);
                }
            }
        }
    }

    fn unsubscribe(st: &mut State, id: u64, route: &str) {
        if let Some(c) = st.conns.get_mut(&id) {
            c.subs.remove(route);
        }
        if let Some(set) = st.routes.get_mut(route) {
            set.remove(&id);
            if set.is_empty() {
                st.routes.remove(route);
            }
        }
    }

    /// Applies an `auth` frame whose token was already verified outside the lock.
    fn auth(&self, st: &mut State, id: u64, verified: Option<Result<Session, AuthError>>, now: u64) {
        let Some(verified) = verified else {
            self.reply(
                st,
                id,
                error("forbidden", "this relay does not take account sessions"),
            );
            return;
        };
        let Ok(session) = verified else {
            self.refuse(st, id, error("forbidden", "invalid session"));
            return;
        };
        let Some(c) = st.conns.get(&id) else { return };
        if c.session.as_ref().is_some_and(|s| s.account != session.account) {
            self.reply(
                st,
                id,
                error("forbidden", "connection belongs to another account"),
            );
            return;
        }
        let old = c.meter.clone();
        let new = MeterKey::Account(session.account.clone());
        if old != new {
            let tier = self.cfg.limits.account;
            let m = st
                .meters
                .entry(new.clone())
                .or_insert_with(|| Meter::new(&tier, now));
            if m.live >= tier.live_connections {
                self.refuse(st, id, refusal(Refusal::Connections));
                return;
            }
            m.live += 1;
            if let Some(o) = st.meters.get_mut(&old) {
                o.live = o.live.saturating_sub(1);
            }
        }
        if let Some(c) = st.conns.get_mut(&id) {
            c.meter = new;
            c.session = Some(session);
            c.month_warned = false;
        }
        self.reply(
            st,
            id,
            json!({ "op": "auth", "ok": true, "tier": "account" }).to_string(),
        );
    }

    fn quota(&self, st: &mut State, id: u64, now: u64) -> String {
        let Some(key) = st.conns.get(&id).map(|c| c.meter.clone()) else {
            return String::new();
        };
        let tier = *self.tier(&key);
        let (live, used) = st.meters.get_mut(&key).map_or((0, 0), |m| (m.live, m.used(now)));
        json!({
            "op": "quota",
            "tier": if matches!(key, MeterKey::Account(_)) { "account" } else { "anonymous" },
            "used": used,
            "cap": tier.bytes_per_month,
            "resetsAt": month::next_start_ms(now),
            "connections": live,
            "maxConnections": tier.live_connections,
            "framesPerSecond": tier.frames_per_second,
            "bytesPerMinute": tier.bytes_per_minute,
            "maxBody": self.cfg.limits.max_body,
        })
        .to_string()
    }

    fn sweep(&self) {
        let now = self.now();
        let lim = self.cfg.limits;
        let mut st = self.lock();
        let mut gone = Vec::new();
        st.queues.retain(|_, q| {
            while q
                .front()
                .is_some_and(|m| now.saturating_sub(m.at) >= lim.queue_ttl_ms)
            {
                gone.extend(q.pop_front());
            }
            !q.is_empty()
        });
        for m in &gone {
            st.unqueued(m);
        }
        let ids: Vec<u64> = st.conns.keys().copied().collect();
        for id in ids {
            self.demote_expired(&mut st, id, now);
        }
        let per_min = u64::from(lim.new_connections_per_minute);
        st.dialers.retain(|_, b| !b.idle(per_min, 60_000, now));
        st.meters.retain(|_, m| !m.forgettable(now));
    }
}
