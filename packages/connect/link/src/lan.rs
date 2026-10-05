// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The opt-in LAN listener that lets a phone reach the paired app on this machine. It is a byte
//! pipe: a phone connects to `/pair`, and every text frame it sends is handed, unread, to the paired
//! localhost client as a `pair` event; frames the localhost client sends with `pair.send` go back to
//! that phone. All pairing cryptography lives in the app. Nothing else is served on this port: no
//! printer methods, no secrets, no pairing code.
//!
//! The listener stays up when the app disconnects, so the hub keeps its phone port while the app is
//! closed. Phone events that arrive with no app attached wait in a small backlog (oldest dropped
//! first) and go to the next client that pairs.
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::advert::{Advertiser, MdnsConfig};
use crate::net::origin_allowed;

/// Interface name prefixes of virtual, tunnel and container networks, which a phone cannot reach.
const VIRTUAL_PREFIXES: [&str; 15] = [
    "utun",
    "tun",
    "tap",
    "ppp",
    "wg",
    "ipsec",
    "tailscale",
    "zt",
    "docker",
    "veth",
    "br-",
    "vmnet",
    "vboxnet",
    "bridge",
    "awdl",
];

/// Whether an address on an interface is one a phone on the same network could use: private IPv4
/// or link-local IPv6, on a physical looking interface.
pub(crate) fn usable_address(name: &str, ip: IpAddr) -> bool {
    let lower = name.to_ascii_lowercase();
    if VIRTUAL_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return false;
    }
    match ip {
        IpAddr::V4(v4) => v4.is_private() && !v4.is_loopback(),
        IpAddr::V6(v6) => (v6.segments().first().copied().unwrap_or(0) & 0xffc0) == 0xfe80,
    }
}

/// The machine's addresses for the phone QR code: private IPv4 and link-local IPv6 (with the
/// interface as zone, `fe80::1%en0`) from active interfaces, IPv4 first. Loopback and tunnels are
/// left out.
pub(crate) fn lan_addresses() -> Vec<String> {
    let Ok(all) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let (mut v4, mut v6) = (Vec::new(), Vec::new());
    for i in all {
        let ip = i.ip();
        // Only interfaces that are up, and not point to point links (VPN tunnels).
        if i.is_loopback()
            || i.is_p2p
            || i.oper_status != if_addrs::IfOperStatus::Up
            || !usable_address(&i.name, ip)
        {
            continue;
        }
        match ip {
            IpAddr::V4(a) => v4.push(a.to_string()),
            IpAddr::V6(a) => v6.push(format!("{a}%{}", i.name)),
        }
    }
    v4.sort();
    v4.dedup();
    v6.sort();
    v6.dedup();
    v4.extend(v6);
    v4
}

/// Default port of the LAN listener.
pub const DEFAULT_PAIR_PORT: u16 = 47616;
/// Largest text frame in either direction.
pub const MAX_FRAME: usize = 1_500_000;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Phone events kept while no client is attached.
const BACKLOG_EVENTS: usize = 256;
/// Frame bytes kept while no client is attached.
const BACKLOG_BYTES: usize = 4 * 1024 * 1024;

/// Caps on the LAN port.
#[derive(Debug, Clone, Copy)]
pub struct PairLimits {
    /// Open phone connections at once.
    pub max_connections: usize,
    /// New connections per address in a minute.
    pub per_address_per_minute: usize,
}

impl Default for PairLimits {
    fn default() -> Self {
        Self {
            max_connections: 64,
            per_address_per_minute: 30,
        }
    }
}

pub(crate) struct Lan {
    limits: PairLimits,
    /// The address the listener binds: all addresses, or the one `LinkConfig::lan_bind` names.
    bind: IpAddr,
    extra_origins: Vec<String>,
    mdns: MdnsConfig,
    /// Complete event objects for the paired localhost clients.
    pub(crate) events: broadcast::Sender<Value>,
    state: Mutex<Option<Running>>,
    conns: Arc<StdMutex<HashMap<String, mpsc::UnboundedSender<Message>>>>,
    /// Events that arrived while no client was attached, and their frame bytes.
    backlog: StdMutex<(VecDeque<Value>, usize)>,
}

struct Running {
    port: u16,
    task: JoinHandle<()>,
    advert: Option<Advertiser>,
}

impl Lan {
    pub(crate) fn new(
        limits: PairLimits,
        extra_origins: Vec<String>,
        mdns: MdnsConfig,
        bind: Option<IpAddr>,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            limits,
            bind: bind.unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)),
            extra_origins,
            mdns,
            events,
            state: Mutex::new(None),
            conns: Arc::new(StdMutex::new(HashMap::new())),
            backlog: StdMutex::new((VecDeque::new(), 0)),
        }
    }

    /// Starts listening, on all addresses unless `LinkConfig::lan_bind` names one. `port` 0 picks a free port. Returns the port and whether
    /// it is announced over mDNS (best effort: it is not when mDNS is off or has no interface).
    pub(crate) async fn start(self: &Arc<Self>, port: u16) -> Result<(u16, bool), String> {
        let mut st = self.state.lock().await;
        if let Some(r) = st.as_ref() {
            return Ok((r.port, r.advert.is_some()));
        }
        let listener = TcpListener::bind((self.bind, port))
            .await
            .map_err(|e| format!("cannot listen on port {port}: {e}"))?;
        let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
        let me = self.clone();
        let task = tokio::spawn(async move {
            let recent: Arc<StdMutex<HashMap<IpAddr, VecDeque<Instant>>>> =
                Arc::new(StdMutex::new(HashMap::new()));
            let mut next = 0_u64;
            loop {
                let Ok((stream, peer)) = listener.accept().await else {
                    continue;
                };
                if !me.admit(&recent, peer) {
                    continue;
                }
                next += 1;
                let (me, id) = (me.clone(), format!("c{next}"));
                tokio::spawn(async move { me.serve(stream, id).await });
            }
        });
        let advert = if self.mdns.disabled {
            None
        } else {
            Advertiser::start(&self.mdns, bound, &lan_addresses()).ok()
        };
        let advertised = advert.is_some();
        *st = Some(Running {
            port: bound,
            task,
            advert,
        });
        Ok((bound, advertised))
    }

    /// Hands an event to the attached clients, or keeps it for the next one when none is attached.
    fn emit(&self, event: Value) {
        if self.events.receiver_count() > 0 && self.events.send(event.clone()).is_ok() {
            return;
        }
        let size = event.get("frame").and_then(Value::as_str).map_or(0, str::len);
        let mut b = self.backlog.lock().unwrap_or_else(PoisonError::into_inner);
        b.0.push_back(event);
        b.1 += size;
        while b.0.len() > BACKLOG_EVENTS || b.1 > BACKLOG_BYTES {
            let Some(old) = b.0.pop_front() else { break };
            b.1 -= old.get("frame").and_then(Value::as_str).map_or(0, str::len);
        }
    }

    /// Takes the events kept while no client was attached, oldest first.
    pub(crate) fn take_backlog(&self) -> Vec<Value> {
        let mut b = self.backlog.lock().unwrap_or_else(PoisonError::into_inner);
        b.1 = 0;
        b.0.drain(..).collect()
    }

    /// Stops listening and closes every phone connection.
    pub(crate) async fn stop(&self) {
        if let Some(r) = self.state.lock().await.take() {
            r.task.abort();
            if let Some(a) = r.advert {
                a.stop().await;
            }
        }
        let all: Vec<(String, mpsc::UnboundedSender<Message>)> = self
            .conns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .collect();
        for (_, tx) in all {
            let _ = tx.send(Message::Close(None));
        }
    }

    /// Applies the connection cap and the per-address rate limit before any handshake work.
    fn admit(&self, recent: &StdMutex<HashMap<IpAddr, VecDeque<Instant>>>, peer: SocketAddr) -> bool {
        if self.conns.lock().unwrap_or_else(PoisonError::into_inner).len() >= self.limits.max_connections {
            return false;
        }
        let mut map = recent.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        map.retain(|_, q| {
            q.back()
                .is_some_and(|t| now.duration_since(*t) < Duration::from_mins(1))
        });
        let q = map.entry(peer.ip()).or_default();
        while q
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_mins(1))
        {
            q.pop_front();
        }
        if q.len() >= self.limits.per_address_per_minute {
            return false;
        }
        q.push_back(now);
        true
    }

    #[allow(clippy::result_large_err)] // The error type is fixed by tungstenite's callback trait.
    fn handshake(&self, req: &Request, resp: Response) -> Result<Response, ErrorResponse> {
        let reject = |status: StatusCode| {
            let mut r = ErrorResponse::new(None);
            *r.status_mut() = status;
            r
        };
        if req.uri().path() != "/pair" {
            return Err(reject(StatusCode::NOT_FOUND));
        }
        // Phones send no Origin header. A web page in someone's browser does, and gets no access.
        if let Some(o) = req.headers().get("origin")
            && !origin_allowed(o.to_str().unwrap_or(""), &self.extra_origins)
        {
            return Err(reject(StatusCode::FORBIDDEN));
        }
        Ok(resp)
    }

    async fn serve(self: Arc<Self>, stream: TcpStream, id: String) {
        let mut cfg = WebSocketConfig::default();
        cfg.max_message_size = Some(MAX_FRAME);
        cfg.max_frame_size = Some(MAX_FRAME);
        let me = self.clone();
        #[allow(clippy::result_large_err)] // Same callback trait.
        let cb = move |req: &Request, resp: Response| me.handshake(req, resp);
        let accept = tokio_tungstenite::accept_hdr_async_with_config(stream, cb, Some(cfg));
        let Ok(Ok(ws)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, accept).await else {
            return;
        };
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        self.conns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.clone(), tx);
        let mut writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let close = matches!(m, Message::Close(_));
                if sink.send(m).await.is_err() || close {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        loop {
            tokio::select! {
                msg = source.next() => match msg {
                    Some(Ok(Message::Text(t))) if t.len() <= MAX_FRAME => {
                        self.emit(json!({ "event": "pair", "conn": id, "frame": t.as_str() }));
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    // Binary frames, oversize text, close frames and errors end the connection.
                    _ => break,
                },
                // The writer ends after it sent a close (pair.close, or the listener stopping):
                // do not wait for a phone that never answers.
                _ = &mut writer => break,
            }
        }
        self.conns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
        writer.abort();
        self.emit(json!({ "event": "pair.closed", "conn": id }));
    }

    /// Sends a text frame to one phone. `false` when the connection is unknown.
    pub(crate) fn send(&self, conn: &str, frame: &str) -> bool {
        let tx = self
            .conns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(conn)
            .cloned();
        tx.is_some_and(|tx| tx.send(Message::text(frame)).is_ok())
    }

    /// Closes one phone connection. `false` when it is unknown.
    pub(crate) fn close(&self, conn: &str) -> bool {
        let tx = self
            .conns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(conn)
            .cloned();
        tx.is_some_and(|tx| tx.send(Message::Close(None)).is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_can_reach_private_ipv4_and_link_local_ipv6_on_real_interfaces() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(usable_address("en0", ip("192.168.1.20")));
        assert!(usable_address("eth0", ip("10.0.0.5")));
        assert!(usable_address("en1", ip("172.20.1.9")));
        assert!(usable_address("en0", ip("fe80::1c2b:3d4e:5f60:7182")));
        // Loopback, public, carrier grade NAT (Tailscale), unique local and global IPv6.
        for bad in [
            "127.0.0.1",
            "8.8.8.8",
            "100.101.102.103",
            "169.254.1.1",
            "fd00::5",
            "2001:db8::1",
            "::1",
        ] {
            assert!(!usable_address("en0", ip(bad)), "{bad}");
        }
        // Tunnels and virtual networks, even with a private address.
        for name in [
            "utun3",
            "tun0",
            "wg0",
            "tailscale0",
            "docker0",
            "veth12ab",
            "br-1234",
            "vmnet8",
            "bridge100",
            "awdl0",
            "ppp0",
        ] {
            assert!(!usable_address(name, ip("192.168.64.1")), "{name}");
        }
    }

    #[test]
    fn the_machine_list_has_no_loopback() {
        for a in lan_addresses() {
            assert!(!a.starts_with("127.") && a != "::1", "{a}");
        }
    }
}
