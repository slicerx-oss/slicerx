// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Direct live video from the hub to a phone away from home, over WebRTC (str0m, sans-IO). The
//! phone sends a complete offer (all its ICE candidates, no trickle) inside the pair session; the
//! hub answers with its own host candidates and, when a STUN server is set, its public address.
//! Media then goes peer to peer with DTLS-SRTP and never through our servers. H.264 cameras send
//! their own video without transcoding; JPEG cameras send pictures over a data channel.
//! When the peers cannot reach each other the phone falls back to `camera.open` (sealed JPEG, one a
//! second, through the relay).

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::{Value, json};
use str0m::change::SdpOffer;
use str0m::media::{Direction, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use sx_connect::camera::FrameKind;
use tokio::net::UdpSocket;

use crate::rpc::Bridge;

/// Direct streams the hub serves at once, over all sessions.
const MAX_RTC: usize = 4;
static OPEN: AtomicUsize = AtomicUsize::new(0);
/// A direct stream ends after this long; the phone opens a new one if the person still watches.
const MAX_STREAM: Duration = Duration::from_mins(30);
/// JPEG pictures over the data channel: at most this many a second, this wide and this large.
const JPEG_FPS: u32 = 10;
const JPEG_WIDTH: usize = 1280;
const JPEG_MAX: usize = 200 * 1024;
/// Largest offer accepted.
pub(crate) const MAX_SDP: usize = 20_000;

struct Slot;

impl Slot {
    fn take() -> Option<Self> {
        OPEN.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < MAX_RTC).then_some(n + 1)
        })
        .ok()
        .map(|_| Slot)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        OPEN.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Answers a phone's offer and starts the stream. Returns the answer SDP and the task.
pub(crate) async fn start(
    b: &Arc<Bridge>,
    printer: String,
    offer: &str,
    stun: Option<String>,
    on_end: impl FnOnce(&'static str) + Send + 'static,
) -> Result<(String, tokio::task::JoinHandle<()>), (&'static str, String)> {
    let slot = Slot::take().ok_or(("busy", "too many direct camera streams at once".to_owned()))?;
    // One socket on the address of the default route: str0m matches each packet's destination to a
    // local candidate, so the socket is bound to the exact address it announces.
    let ip = b
        .remote
        .rtc_bind()
        .or_else(default_route_ip)
        .ok_or(("unavailable", "this machine has no network address".to_owned()))?;
    // The phone's candidates say where the hub sends connectivity checks: never to this machine
    // itself or link-local addresses (loopback only when the hub itself is bound there, in tests).
    let offer = drop_inward_candidates(offer, ip.is_loopback());
    let offer = SdpOffer::from_sdp_string(&offer)
        .map_err(|_| ("bad_request", "sdp is not a WebRTC offer".to_owned()))?;
    let socket = UdpSocket::bind(SocketAddr::new(ip, 0))
        .await
        .map_err(|e| ("failed", format!("no UDP port: {e}")))?;
    let local = socket.local_addr().map_err(|e| ("failed", e.to_string()))?;
    let mut rtc = Rtc::builder().build(Instant::now());
    if let Ok(c) = Candidate::host(local, "udp") {
        rtc.add_local_candidate(c);
    }
    if let Some(server) = stun
        && let Some(public) = stun_binding(&socket, &server).await
        && public != local
        && let Ok(c) = Candidate::server_reflexive(public, local, "udp")
    {
        rtc.add_local_candidate(c);
    }
    let answer = rtc
        .sdp_api()
        .accept_offer(offer)
        .map_err(|e| ("bad_request", format!("the offer cannot be answered: {e}")))?;
    let sdp = answer.to_sdp_string();
    let b = b.clone();
    let task = tokio::spawn(async move {
        let _slot = slot;
        let reason = Box::pin(run(&b, &printer, rtc, socket)).await;
        on_end(reason);
    });
    Ok((sdp, task))
}

/// The offer without candidates that point back into this machine or its link: loopback (unless
/// `loopback_ok`), unspecified, link-local, multicast and broadcast addresses.
fn drop_inward_candidates(sdp: &str, loopback_ok: bool) -> String {
    let inward = |line: &str| {
        let Some(rest) = line.strip_prefix("a=candidate:") else {
            return false;
        };
        let Some(ip) = rest
            .split_whitespace()
            .nth(4)
            .and_then(|a| a.parse::<IpAddr>().ok())
        else {
            return false;
        };
        let link_local = match ip {
            IpAddr::V4(v4) => v4.is_link_local() || v4.is_broadcast(),
            IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
        };
        (ip.is_loopback() && !loopback_ok) || ip.is_unspecified() || ip.is_multicast() || link_local
    };
    let mut out = String::with_capacity(sdp.len());
    for line in sdp.split_inclusive('\n') {
        if !inward(line.trim_end()) {
            out.push_str(line);
        }
    }
    out
}

/// The IPv4 address of the interface the default route leaves by. Connecting a UDP socket sends
/// nothing; it only picks the route.
fn default_route_ip() -> Option<IpAddr> {
    let probe = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    probe.connect(("192.0.2.1", 9)).ok()?;
    let ip = probe.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// Drains the engine to its next timeout, sending what it asks to send. `Err` ends the stream.
fn drain(rtc: &mut Rtc, socket: &UdpSocket, st: &mut State) -> Result<Instant, &'static str> {
    loop {
        match rtc.poll_output() {
            Ok(Output::Timeout(t)) => return Ok(t),
            Ok(Output::Transmit(t)) => {
                let _ = socket.try_send_to(&t.contents, t.destination);
            }
            Ok(Output::Event(e)) => match e {
                Event::Connected => st.connected = true,
                Event::IceConnectionStateChange(IceConnectionState::Disconnected) => return Err("closed"),
                Event::MediaAdded(m)
                    if m.kind == MediaKind::Video
                        && matches!(m.direction, Direction::SendOnly | Direction::SendRecv) =>
                {
                    st.video = Some(m.mid);
                }
                Event::ChannelOpen(id, _) => st.channel = Some(id),
                Event::ChannelClose(_) => st.channel = None,
                Event::KeyframeRequest(_) => st.want_key = true,
                _ => {}
            },
            Err(_) => return Err("ended"),
        }
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Default)]
struct State {
    connected: bool,
    video: Option<Mid>,
    channel: Option<str0m::channel::ChannelId>,
    want_key: bool,
}

async fn run(b: &Arc<Bridge>, printer: &str, mut rtc: Rtc, socket: UdpSocket) -> &'static str {
    let mut st = State::default();
    let Ok(local) = socket.local_addr() else {
        return "ended";
    };
    // The camera opens beside the engine, so ICE answers while it connects. Frames that find the
    // queue full are dropped; the picture stays current.
    let (tx, mut frames) = tokio::sync::mpsc::channel::<sx_connect::camera::CameraFrame>(8);
    let (bridge, id) = (b.clone(), printer.to_owned());
    let feeder = tokio::spawn(async move {
        let Ok(mut src) = crate::rpc::camera_source(&bridge, &id, "remote video").await else {
            return;
        };
        let mut last_jpeg: Option<Instant> = None;
        while let Some(mut f) = src.next().await {
            if tx.is_closed() {
                break;
            }
            if f.kind == FrameKind::Jpeg {
                // Pictures are shrunk here, at the data channel's rate and on the blocking pool, so a
                // large or hostile camera picture never stalls the engine or the runtime.
                let now = Instant::now();
                if last_jpeg.is_some_and(|l| now.duration_since(l) < Duration::from_secs(1) / JPEG_FPS) {
                    continue;
                }
                last_jpeg = Some(now);
                let data = std::mem::take(&mut f.data);
                let fitted = tokio::task::spawn_blocking(move || {
                    crate::h264::fit_jpeg(&data, JPEG_WIDTH, 75)
                        .or_else(|| (data.len() <= JPEG_MAX).then_some(data))
                })
                .await
                .ok()
                .flatten()
                .filter(|j| j.len() <= JPEG_MAX);
                let Some(jpeg) = fitted else { continue };
                f.data = jpeg;
            }
            let _ = tx.try_send(f);
        }
    });
    let _feeder = AbortOnDrop(feeder);
    let end = tokio::time::Instant::now() + MAX_STREAM;
    let started = Instant::now();
    let mut last_jpeg: Option<Instant> = None;
    let mut buf = vec![0u8; 2000];
    let mut deadline = match drain(&mut rtc, &socket, &mut st) {
        Ok(t) => t,
        Err(r) => return r,
    };
    loop {
        let wait = deadline.saturating_duration_since(Instant::now());
        tokio::select! {
            () = tokio::time::sleep_until(end) => return "ended",
            r = socket.recv_from(&mut buf) => {
                let Ok((n, source)) = r else { return "ended" };
                let Some(data) = buf.get(..n) else { continue };
                let Ok(contents) = data.try_into() else { continue };
                let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: local, contents });
                if rtc.handle_input(input).is_err() {
                    return "ended";
                }
            }
            () = tokio::time::sleep(wait) => {
                if rtc.handle_input(Input::Timeout(Instant::now())).is_err() {
                    return "ended";
                }
            }
            frame = frames.recv(), if st.connected => {
                let Some(frame) = frame else { return "ended" };
                if !send_frame(&mut rtc, &mut st, frame, started, &mut last_jpeg) {
                    continue;
                }
            }
        }
        deadline = match drain(&mut rtc, &socket, &mut st) {
            Ok(t) => t,
            Err(r) => return r,
        };
    }
}

/// One camera frame into the engine. False when nothing was written.
fn send_frame(
    rtc: &mut Rtc,
    st: &mut State,
    frame: sx_connect::camera::CameraFrame,
    started: Instant,
    last_jpeg: &mut Option<Instant>,
) -> bool {
    match frame.kind {
        FrameKind::H264 => {
            let Some(mid) = st.video else { return false };
            // Start at a key frame, and again after the phone asked for one.
            if st.want_key && !frame.key {
                return false;
            }
            let Some(writer) = rtc.writer(mid) else {
                return false;
            };
            let Some(pt) = writer
                .payload_params()
                .find(|p| p.spec().codec == str0m::format::Codec::H264)
                .map(str0m::format::PayloadParams::pt)
            else {
                return false;
            };
            let elapsed = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
            let rtp_time = MediaTime::from_90khz(elapsed.saturating_mul(9) / 100);
            if writer.write(pt, Instant::now(), rtp_time, frame.data).is_ok() && frame.key {
                st.want_key = false;
            }
            true
        }
        FrameKind::Jpeg => {
            let Some(id) = st.channel else { return false };
            let now = Instant::now();
            if last_jpeg.is_some_and(|l| now.duration_since(l) < Duration::from_secs(1) / JPEG_FPS) {
                return false;
            }
            // Already shrunk by the feeder.
            if frame.data.len() > JPEG_MAX {
                return false;
            }
            *last_jpeg = Some(now);
            rtc.channel(id)
                .is_some_and(|mut c| c.write(true, &frame.data).is_ok())
        }
    }
}

/// One STUN binding request (RFC 5389) through the stream's own socket: the public address and
/// port the phone can reach. `None` when the server does not answer within a second and a half.
async fn stun_binding(socket: &UdpSocket, server: &str) -> Option<SocketAddr> {
    const MAGIC: u32 = 0x2112_A442;
    let target = tokio::net::lookup_host(server)
        .await
        .ok()?
        .find(SocketAddr::is_ipv4)?;
    let mut id = [0u8; 12];
    getrandom::fill(&mut id).ok()?;
    let mut req = Vec::with_capacity(20);
    req.extend_from_slice(&0x0001_u16.to_be_bytes());
    req.extend_from_slice(&0_u16.to_be_bytes());
    req.extend_from_slice(&MAGIC.to_be_bytes());
    req.extend_from_slice(&id);
    let end = tokio::time::Instant::now() + Duration::from_millis(1500);
    let mut buf = [0u8; 512];
    for _ in 0..3 {
        socket.send_to(&req, target).await.ok()?;
        let step = tokio::time::Instant::now() + Duration::from_millis(500);
        while let Ok(Ok((n, from))) = tokio::time::timeout_at(step.min(end), socket.recv_from(&mut buf)).await
        {
            if from == target
                && let Some(addr) = buf.get(..n).and_then(|m| parse_binding_response(m, &id))
            {
                return Some(addr);
            }
        }
        if tokio::time::Instant::now() >= end {
            break;
        }
    }
    None
}

/// The XOR-MAPPED-ADDRESS (IPv4) of a binding success response for transaction `id`.
fn parse_binding_response(m: &[u8], id: &[u8; 12]) -> Option<SocketAddr> {
    const MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
    if m.get(0..2)? != [0x01, 0x01] || m.get(4..8)? != MAGIC || m.get(8..20)? != id {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([*m.get(2)?, *m.get(3)?]));
    let mut at = 20;
    while at + 4 <= 20 + len {
        let kind = u16::from_be_bytes([*m.get(at)?, *m.get(at + 1)?]);
        let alen = usize::from(u16::from_be_bytes([*m.get(at + 2)?, *m.get(at + 3)?]));
        let v = m.get(at + 4..at + 4 + alen)?;
        if kind == 0x0020 && alen == 8 && v.get(1) == Some(&0x01) {
            let port = u16::from_be_bytes([*v.get(2)?, *v.get(3)?]) ^ 0x2112;
            let ip = [
                *v.get(4)? ^ MAGIC[0],
                *v.get(5)? ^ MAGIC[1],
                *v.get(6)? ^ MAGIC[2],
                *v.get(7)? ^ MAGIC[3],
            ];
            return Some(SocketAddr::new(IpAddr::from(ip), port));
        }
        at += 4 + alen.div_ceil(4) * 4;
    }
    None
}

/// The `camera.rtc` reply shape.
pub(crate) fn reply(stream: u32, sdp: &str) -> Value {
    json!({ "stream": stream, "sdp": sdp })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_mapped_address_of_a_binding_response() {
        let id = [7u8; 12];
        let mut m = vec![0x01, 0x01, 0x00, 0x0c, 0x21, 0x12, 0xA4, 0x42];
        m.extend_from_slice(&id);
        // XOR-MAPPED-ADDRESS for 203.0.113.5:40000.
        let port = 0x9C40_u16 ^ 0x2112; // 40000
        m.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
        m.extend_from_slice(&port.to_be_bytes());
        m.extend_from_slice(&[0xCB ^ 0x21, 0x12, 0x71 ^ 0xA4, 0x05 ^ 0x42]); // 203.0.113.5
        assert_eq!(
            parse_binding_response(&m, &id),
            Some("203.0.113.5:40000".parse().unwrap_or_else(|_| unreachable!()))
        );
        assert_eq!(parse_binding_response(&m, &[8u8; 12]), None);
        assert_eq!(parse_binding_response(&m[..10], &id), None);
    }
}
