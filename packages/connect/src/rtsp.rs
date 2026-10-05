// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A small RTSP client for printer cameras: RTSP over TCP or TLS (`rtsps`, Bambu Lab X1 and H2),
//! Basic and Digest login, RTP interleaved on the same connection, and H.264 depacketizing
//! (RFC 6184). It reads one video track and hands out Annex B access units.
use std::fmt::Write as _;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::camera::{CameraFrame, FrameKind, FrameStream, spawn_stream};
use crate::digest::{Challenge, authorization};

const START_CODE: [u8; 4] = [0, 0, 0, 1];
const MAX_HEADERS: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
const MAX_FRAME: usize = 8 * 1024 * 1024;
const KEEPALIVE: Duration = Duration::from_secs(25);
const STEP_TIMEOUT: Duration = Duration::from_secs(5);

/// Where a camera is and how to log in. The login is never part of the URL.
#[derive(Clone)]
pub(crate) struct Target {
    pub host: String,
    pub port: u16,
    /// Path and query, starting with `/`.
    pub path: String,
    pub tls: bool,
    /// offer only TLS 1.2, as Bambu Lab printers need (`tls::bambu_lan_config`)
    pub tls12_only: bool,
    pub login: Option<(String, String)>,
    /// The name connection log lines go under (`SX_CONNECT_LOG`): the printer id, else the host.
    pub log_as: String,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Target")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("path", &self.path)
            .field("tls", &self.tls)
            .finish_non_exhaustive()
    }
}

/// Parses `rtsp://host[:port]/path` or `rtsps://...`. A URL with a user name in it is refused, so a
/// password never sits in a config file.
pub(crate) fn parse_url(url: &str, login: Option<(String, String)>) -> Option<Target> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("rtsps://") {
        (true, r)
    } else {
        (false, url.strip_prefix("rtsp://")?)
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (rest.get(..i)?, rest.get(i..)?),
        None => (rest, "/"),
    };
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if p.bytes().all(|b| b.is_ascii_digit()) && !p.is_empty() => (h, p.parse().ok()?),
        _ => (authority, if tls { 322 } else { 554 }),
    };
    let host = host.trim_matches(['[', ']']);
    if host.is_empty() {
        return None;
    }
    Some(Target {
        host: host.to_owned(),
        port,
        path: path.to_owned(),
        tls,
        tls12_only: false,
        login,
        log_as: String::new(),
    })
}

pub(crate) fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = c
            .iter()
            .enumerate()
            .fold(0_u32, |a, (i, b)| a | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= c.len() {
                let idx = usize::try_from((n >> (18 - 6 * i)) & 63).unwrap_or(0);
                out.push(char::from(T.get(idx).copied().unwrap_or(b'A')));
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub(crate) fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0_u32, 0_u32);
    for b in s.trim().bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

/// What SDP says about the video track.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Sdp {
    pub control: Option<String>,
    pub payload_type: Option<u8>,
    pub sps_pps: Vec<Vec<u8>>,
}

pub(crate) fn parse_sdp(sdp: &str) -> Option<Sdp> {
    let mut out = Sdp::default();
    let mut in_video = false;
    let mut found = false;
    for line in sdp.lines().map(str::trim) {
        if let Some(m) = line.strip_prefix("m=") {
            in_video = m.starts_with("video");
            found |= in_video;
            if in_video {
                out.payload_type = m.split_whitespace().nth(3).and_then(|p| p.parse().ok());
            }
        } else if in_video {
            if let Some(c) = line.strip_prefix("a=control:") {
                out.control = Some(c.trim().to_owned());
            } else if let Some(f) = line.strip_prefix("a=fmtp:") {
                let params = f.split_once(' ').map_or("", |(_, p)| p);
                for kv in params.split(';') {
                    if let Some(v) = kv.trim().strip_prefix("sprop-parameter-sets=") {
                        out.sps_pps = v.split(',').filter_map(b64_decode).collect();
                    }
                }
            }
        }
    }
    found.then_some(out)
}

/// RTP payloads of one H.264 stream to Annex B access units.
#[derive(Default)]
pub(crate) struct H264Depay {
    fu: Vec<u8>,
    nals: Vec<Vec<u8>>,
    /// The parameter sets from the SDP, used until the stream sends its own.
    sps_pps: Vec<Vec<u8>>,
    /// The last SPS and PPS the stream sent.
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    size: usize,
    /// The RTP timestamp of the access unit being collected.
    ts: Option<u32>,
}

impl H264Depay {
    pub(crate) fn new(sps_pps: Vec<Vec<u8>>) -> Self {
        Self {
            sps_pps,
            ..Self::default()
        }
    }

    fn add(&mut self, nal: Vec<u8>) {
        self.size += nal.len();
        if self.size > MAX_FRAME {
            self.nals.clear();
            self.size = 0;
            return;
        }
        self.nals.push(nal);
    }

    /// Feeds one RTP packet and returns the access units it completes: the one it ends (marker bit),
    /// and the one before it when the timestamp moved on without a marker.
    pub(crate) fn push(&mut self, rtp: &[u8]) -> Vec<CameraFrame> {
        let mut out = Vec::new();
        let Some((marker, ts, payload)) = rtp_payload(rtp) else {
            return out;
        };
        if self.ts.is_some_and(|t| t != ts) {
            out.extend(self.finish());
        }
        self.ts = Some(ts);
        self.take(payload);
        if marker {
            out.extend(self.finish());
        }
        out
    }

    fn take(&mut self, payload: &[u8]) -> Option<()> {
        let hdr = *payload.first()?;
        match hdr & 0x1f {
            1..=23 => self.add(payload.to_vec()),
            24 => {
                // STAP-A: 16 bit sizes, each followed by a NAL unit.
                let mut i = 1;
                while i + 2 <= payload.len() {
                    let n = usize::from(u16::from_be_bytes([*payload.get(i)?, *payload.get(i + 1)?]));
                    let nal = payload.get(i + 2..i + 2 + n)?;
                    self.add(nal.to_vec());
                    i += 2 + n;
                }
            }
            28 => {
                let fu = *payload.get(1)?;
                let body = payload.get(2..)?;
                if fu & 0x80 != 0 {
                    self.fu.clear();
                    self.fu.push((hdr & 0xe0) | (fu & 0x1f));
                }
                if self.fu.is_empty() {
                    return None;
                }
                self.fu.extend_from_slice(body);
                if self.fu.len() > MAX_FRAME {
                    self.fu.clear();
                    return None;
                }
                if fu & 0x40 != 0 {
                    let nal = std::mem::take(&mut self.fu);
                    self.add(nal);
                }
            }
            _ => {}
        }
        Some(())
    }

    /// The collected access unit as Annex B. A key frame without its parameter sets gets the
    /// latest ones: the stream's own, else the SDP's, so a decoder can start on it. Parameter sets
    /// that come as a unit of their own are kept for the picture after them, not handed out.
    fn finish(&mut self) -> Option<CameraFrame> {
        let nals = std::mem::take(&mut self.nals);
        self.size = 0;
        let kind = |n: &Vec<u8>| n.first().map_or(0, |b| b & 0x1f);
        for n in &nals {
            match kind(n) {
                7 => self.sps = Some(n.clone()),
                8 => self.pps = Some(n.clone()),
                _ => {}
            }
        }
        // Only SEI, SPS, PPS or access unit delimiters: no picture.
        if nals.iter().all(|n| matches!(kind(n), 6..=9)) {
            return None;
        }
        let has = |t: u8| nals.iter().any(|n| kind(n) == t);
        let key = has(5);
        let mut data = Vec::new();
        if key && !has(7) {
            let sets: Vec<&Vec<u8>> = match (&self.sps, &self.pps) {
                (Some(s), Some(p)) => vec![s, p],
                _ => self.sps_pps.iter().collect(),
            };
            for ps in sets {
                data.extend_from_slice(&START_CODE);
                data.extend_from_slice(ps);
            }
        }
        for n in &nals {
            data.extend_from_slice(&START_CODE);
            data.extend_from_slice(n);
        }
        Some(CameraFrame {
            kind: FrameKind::H264,
            key,
            data,
        })
    }
}

/// The marker bit, timestamp and payload of an RTP packet (RFC 3550): version 2, past the CSRC
/// list and any header extension, without padding.
fn rtp_payload(rtp: &[u8]) -> Option<(bool, u32, &[u8])> {
    let b0 = *rtp.first()?;
    if b0 >> 6 != 2 {
        return None;
    }
    let marker = rtp.get(1)? & 0x80 != 0;
    let ts = u32::from_be_bytes(rtp.get(4..8)?.try_into().ok()?);
    let csrc = usize::from(b0 & 0x0f);
    let mut off = 12 + 4 * csrc;
    if b0 & 0x10 != 0 {
        let words = usize::from(u16::from_be_bytes([*rtp.get(off + 2)?, *rtp.get(off + 3)?]));
        off += 4 + 4 * words;
    }
    let mut end = rtp.len();
    if b0 & 0x20 != 0 {
        end = end.checked_sub(usize::from(*rtp.last()?))?;
    }
    Some((marker, ts, rtp.get(off..end)?))
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

async fn read_response<R: AsyncRead + Unpin>(r: &mut R) -> Option<Response> {
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        r.read_exact(&mut byte).await.ok()?;
        head.push(byte[0]);
        if head.len() > MAX_HEADERS {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = text.split("\r\n");
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let len = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return None;
    }
    let mut body = vec![0_u8; len];
    r.read_exact(&mut body).await.ok()?;
    Some(Response {
        status,
        headers,
        body,
    })
}

enum Auth {
    None,
    Basic,
    Digest(Challenge),
}

impl Auth {
    fn header(&self, user: &str, pass: &str, method: &str, uri: &str, nc: u32) -> Option<String> {
        match self {
            Auth::None => None,
            Auth::Basic => Some(format!(
                "Basic {}",
                b64_encode(format!("{user}:{pass}").as_bytes())
            )),
            Auth::Digest(ch) => {
                let mut raw = [0_u8; 8];
                getrandom::fill(&mut raw).ok()?;
                let cnonce = crate::types::hex(&raw);
                Some(authorization(ch, user, pass, method, uri, nc, &cnonce))
            }
        }
    }
}

struct Client {
    /// For the connection log.
    who: Target,
    io: Box<dyn Io>,
    cseq: u32,
    auth: Auth,
    login: Option<(String, String)>,
    session: Option<String>,
}

impl Client {
    async fn request(&mut self, method: &str, uri: &str, extra: &[(&str, &str)]) -> Option<Response> {
        for attempt in 0..2 {
            self.cseq += 1;
            let mut req = format!(
                "{method} {uri} RTSP/1.0\r\nCSeq: {}\r\nUser-Agent: SlicerX\r\n",
                self.cseq
            );
            for (k, v) in extra {
                let _ = write!(req, "{k}: {v}\r\n");
            }
            if let Some(s) = &self.session {
                let _ = write!(req, "Session: {s}\r\n");
            }
            if let Some((u, p)) = &self.login
                && let Some(h) = self.auth.header(u, p, method, uri, self.cseq)
            {
                trace(
                    &self.who,
                    format_args!(
                        "{method} login: {}, code {}",
                        login_words(&h),
                        crate::trace::fingerprint(p)
                    ),
                );
                let _ = write!(req, "Authorization: {h}\r\n");
            }
            req.push_str("\r\n");
            if let Err(e) = self.io.write_all(req.as_bytes()).await {
                trace(&self.who, format_args!("{method}: not sent: {e}"));
                return None;
            }
            let resp = match tokio::time::timeout(STEP_TIMEOUT, read_response(&mut self.io)).await {
                Ok(Some(r)) => r,
                Ok(None) => {
                    trace(
                        &self.who,
                        format_args!("{method}: the camera closed the connection or sent no RTSP reply"),
                    );
                    return None;
                }
                Err(_) => {
                    trace(&self.who, format_args!("{method}: no reply in 5 s"));
                    return None;
                }
            };
            let sent_auth = match self.auth {
                Auth::None => "",
                Auth::Basic => " with basic login",
                Auth::Digest(_) => " with digest login",
            };
            trace(
                &self.who,
                format_args!("{method}{sent_auth}: {}", status_words(&resp)),
            );
            if resp.status == 401 && attempt == 0 && self.login.is_some() {
                let challenge = resp
                    .headers
                    .iter()
                    .filter(|(k, _)| k.eq_ignore_ascii_case("www-authenticate"))
                    .map(|(_, v)| v.as_str())
                    .find_map(|v| {
                        Challenge::parse(v).map(Auth::Digest).or_else(|| {
                            v.trim()
                                .to_ascii_lowercase()
                                .starts_with("basic")
                                .then_some(Auth::Basic)
                        })
                    });
                if let Some(a) = challenge {
                    match &a {
                        Auth::Digest(ch) => {
                            trace(&self.who, format_args!("challenge: digest, {}", ch.describe()));
                        }
                        _ => trace(&self.who, "challenge: basic"),
                    }
                    self.auth = a;
                    continue;
                }
            }
            return Some(resp);
        }
        None
    }
}

/// An `Authorization` value for the log: the digest fields without `response`, or only the scheme
/// for Basic, whose value is the login itself.
fn login_words(h: &str) -> String {
    let Some(fields) = h.strip_prefix("Digest ") else {
        return "basic".to_owned();
    };
    let kept: Vec<&str> = fields
        .split(", ")
        .filter(|f| !f.trim_start().starts_with("response="))
        .collect();
    format!("digest {}", kept.join(", "))
}

/// Why a stream did not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Failure {
    /// No TCP or TLS connection.
    Unreachable,
    /// The camera answered 401 to the login it asked for.
    LoginRefused,
    /// A request got no answer: the camera closed the connection or stayed silent.
    NoAnswer,
    /// Anything else: no answer, another status, no video track.
    Other,
}

/// The TCP and TLS connection, or what went wrong in words for the connection log.
async fn connect(t: &Target) -> Result<Box<dyn Io>, String> {
    let tcp = tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect((t.host.as_str(), t.port)),
    )
    .await
    .map_err(|_| "TCP: no answer in 3 s".to_owned())?
    .map_err(|e| format!("TCP: {e}"))?;
    let _ = tcp.set_nodelay(true);
    if !t.tls {
        return Ok(Box::new(tcp));
    }
    let name = rustls::pki_types::ServerName::try_from(t.host.clone()).map_err(|e| format!("TLS: {e}"))?;
    let config = if t.tls12_only {
        crate::tls::bambu_lan_config()
    } else {
        crate::tls::lan_client_config()
    }
    .map_err(|e| format!("TLS: {e}"))?;
    let tls = tokio::time::timeout(
        STEP_TIMEOUT,
        tokio_rustls::TlsConnector::from(config).connect(name, tcp),
    )
    .await
    .map_err(|_| "TLS: no handshake in 5 s".to_owned())?
    .map_err(|e| format!("TLS: {e}"))?;
    let version = tls
        .get_ref()
        .1
        .protocol_version()
        .map_or_else(|| "unknown".to_owned(), |v| format!("{v:?}"));
    trace(t, format_args!("TLS up ({version})"));
    Ok(Box::new(tls))
}

/// One camera line in the connection log.
fn trace(t: &Target, line: impl std::fmt::Display) {
    let who = if t.log_as.is_empty() {
        t.host.as_str()
    } else {
        t.log_as.as_str()
    };
    crate::trace(who, format_args!("camera rtsp {line}"));
}

/// What a response's status line says, for the log: `200`, `401 (digest)`.
fn status_words(r: &Response) -> String {
    let scheme = r
        .header("WWW-Authenticate")
        .and_then(|v| v.split_whitespace().next())
        .map(str::to_ascii_lowercase);
    match scheme {
        Some(s) if r.status == 401 => format!("401 ({s})"),
        _ => r.status.to_string(),
    }
}

fn track_uri(base: &str, control: Option<&str>) -> String {
    match control {
        None | Some("*" | "") => base.to_owned(),
        Some(c) if c.starts_with("rtsp://") || c.starts_with("rtsps://") => c.to_owned(),
        Some(c) => format!("{}/{}", base.trim_end_matches('/'), c.trim_start_matches('/')),
    }
}

/// Connects, negotiates and starts playing. Fails when the camera does not answer, refuses the login,
/// or has no H.264 video track. Each step goes to the connection log.
pub(crate) async fn open(target: &Target) -> Result<FrameStream, Failure> {
    trace(
        target,
        format_args!(
            "connect {}:{} {}",
            target.host,
            target.port,
            if target.tls { "TLS" } else { "plain" }
        ),
    );
    let io = match connect(target).await {
        Ok(io) => io,
        Err(e) => {
            trace(target, format_args!("failed: {e}"));
            // A port that does not answer is a camera that is off; a TLS failure is not.
            return Err(if e.starts_with("TCP") {
                Failure::Unreachable
            } else {
                Failure::Other
            });
        }
    };
    let host = if target.host.contains(':') {
        format!("[{}]", target.host)
    } else {
        target.host.clone()
    };
    let scheme = if target.tls { "rtsps" } else { "rtsp" };
    let base = format!("{scheme}://{host}:{}{}", target.port, target.path);
    let mut client = Client {
        who: target.clone(),
        io,
        cseq: 0,
        auth: Auth::None,
        login: target.login.clone(),
        session: None,
    };
    client
        .request("OPTIONS", &base, &[])
        .await
        .ok_or_else(|| step_failed(target, "OPTIONS"))?;
    let describe = client
        .request("DESCRIBE", &base, &[("Accept", "application/sdp")])
        .await
        .ok_or_else(|| step_failed(target, "DESCRIBE"))?;
    refused(&describe)?;
    let Some(sdp) = parse_sdp(&String::from_utf8_lossy(&describe.body)) else {
        trace(target, "the description has no video track");
        return Err(Failure::Other);
    };
    trace(
        target,
        format_args!(
            "video payload {:?} control {:?}, {} parameter sets in the description",
            sdp.payload_type,
            sdp.control,
            sdp.sps_pps.len()
        ),
    );
    let content_base = describe
        .header("Content-Base")
        .map_or(base.clone(), str::to_owned);
    let track = track_uri(content_base.trim_end_matches('/'), sdp.control.as_deref());
    let setup = client
        .request(
            "SETUP",
            &track,
            &[("Transport", "RTP/AVP/TCP;unicast;interleaved=0-1")],
        )
        .await
        .ok_or_else(|| step_failed(target, "SETUP"))?;
    refused(&setup)?;
    client.session = setup
        .header("Session")
        .map(|v| v.split(';').next().unwrap_or(v).trim().to_owned());
    let playing = client
        .request("PLAY", &base, &[("Range", "npt=0.000-")])
        .await
        .ok_or_else(|| step_failed(target, "PLAY"))?;
    refused(&playing)?;
    let target = target.clone();
    let sps_pps = sdp.sps_pps;
    Ok(spawn_stream(move |tx| play(target, client, base, sps_pps, tx)))
}

/// Reads a playing stream into frames until it ends, with a keepalive every [`KEEPALIVE`], and logs
/// the first frames and why it ended.
async fn play(
    target: Target,
    client: Client,
    base: String,
    sps_pps: Vec<Vec<u8>>,
    tx: tokio::sync::mpsc::Sender<CameraFrame>,
) {
    let Client {
        who: _,
        io,
        auth,
        login,
        session,
        cseq,
    } = client;
    let (mut rd, wr) = tokio::io::split(io);
    let mut ctl = Control {
        wr: Some(wr),
        target: target.clone(),
        base,
        session,
        auth,
        login,
        cseq,
    };
    let mut depay = H264Depay::new(sps_pps);
    let mut keepalive = tokio::time::interval(KEEPALIVE);
    keepalive.tick().await;
    let mut buf = Vec::new();
    let mut note = EndNote {
        target: &target,
        frames: 0,
        why: None,
    };
    let mut keys = 0_u64;
    let codec = |f: &CameraFrame| avc_codec(&f.data).unwrap_or_else(|| "no parameter sets".to_owned());
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                let req = ctl.request("OPTIONS");
                let Some(wr) = ctl.wr.as_mut() else { return };
                if let Err(e) = wr.write_all(req.as_bytes()).await {
                    note.why = Some(format!("keepalive not sent: {e}"));
                    return;
                }
            }
            got = read_interleaved(&mut rd, &mut buf) => {
                let (channel, data) = match got {
                    Ok(p) => p,
                    Err(e) => {
                        note.why = Some(if e.kind() == std::io::ErrorKind::UnexpectedEof {
                            "the camera closed the connection".to_owned()
                        } else {
                            format!("read failed: {e}")
                        });
                        return;
                    }
                };
                if channel != 0 {
                    continue;
                }
                for frame in depay.push(&data) {
                    let frames = note.frames;
                    if frames == 0 {
                        let kind = if frame.key { "key frame" } else { "delta frame" };
                        trace(&target, format_args!("first frame: H.264 {kind}, {} bytes, {}", frame.data.len(), codec(&frame)));
                    } else if frame.key && keys == 0 {
                        trace(&target, format_args!("first key frame after {frames} frames, {}", codec(&frame)));
                    }
                    keys += u64::from(frame.key);
                    note.frames += 1;
                    if tx.send(frame).await.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

/// The writing side of a playing session. However the stream ends, a viewer dropping it included
/// (which aborts the reading task), dropping this sends TEARDOWN and closes the connection, so the
/// camera frees the session at once. live555 on Bambu Lab printers refuses a new session while an
/// old one it was not told about is still open.
struct Control {
    wr: Option<tokio::io::WriteHalf<Box<dyn Io>>>,
    target: Target,
    base: String,
    session: Option<String>,
    auth: Auth,
    login: Option<(String, String)>,
    cseq: u32,
}

impl Control {
    /// The next request on this session, with its CSeq, session and login.
    fn request(&mut self, method: &str) -> String {
        self.cseq += 1;
        let mut req = format!(
            "{method} {} RTSP/1.0\r\nCSeq: {}\r\nUser-Agent: SlicerX\r\n",
            self.base, self.cseq
        );
        if let Some(s) = &self.session {
            let _ = write!(req, "Session: {s}\r\n");
        }
        if let Some((u, p)) = &self.login
            && let Some(h) = self.auth.header(u, p, method, &self.base, self.cseq)
        {
            let _ = write!(req, "Authorization: {h}\r\n");
        }
        req.push_str("\r\n");
        req
    }
}

impl Drop for Control {
    fn drop(&mut self) {
        let Some(mut wr) = self.wr.take() else { return };
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let req = self.request("TEARDOWN");
        let target = self.target.clone();
        rt.spawn(async move {
            let sent = tokio::time::timeout(STEP_TIMEOUT, async {
                wr.write_all(req.as_bytes()).await?;
                wr.shutdown().await
            })
            .await;
            match sent {
                Ok(Ok(())) => trace(&target, "TEARDOWN sent"),
                Ok(Err(e)) => trace(&target, format_args!("TEARDOWN not sent: {e}")),
                Err(_) => trace(&target, "TEARDOWN not sent in 5 s"),
            }
        });
    }
}

/// Logs why a stream ended when it does. A stream the viewer drops is aborted mid-read, so the
/// note is written on drop; with no other reason given, the viewer closed it.
struct EndNote<'a> {
    target: &'a Target,
    frames: u64,
    why: Option<String>,
}

impl Drop for EndNote<'_> {
    fn drop(&mut self) {
        let why = self.why.as_deref().unwrap_or("the viewer closed it");
        trace(
            self.target,
            format_args!("stream ended after {} frames: {why}", self.frames),
        );
    }
}

/// Logs a request that got no answer, and gives the failure that ends the open.
fn step_failed(t: &Target, method: &str) -> Failure {
    trace(t, format_args!("{method}: no answer"));
    Failure::NoAnswer
}

/// A response other than 200 as a failure: 401 here comes after the login was sent, so it is a
/// refused login.
fn refused(r: &Response) -> Result<(), Failure> {
    match r.status {
        200 => Ok(()),
        401 => Err(Failure::LoginRefused),
        _ => Err(Failure::Other),
    }
}

/// `avc1.PPCCLL` from the first SPS of an Annex B access unit, as the browser's decoder is set up.
fn avc_codec(annex_b: &[u8]) -> Option<String> {
    nal_units(annex_b)
        .into_iter()
        .find(|n| n.first().is_some_and(|b| b & 0x1f == 7))
        .and_then(|sps| match sps.get(1..4) {
            Some(&[p, c, l]) => Some(format!("avc1.{p:02x}{c:02x}{l:02x}")),
            _ => None,
        })
}

/// The NAL units of an Annex B access unit, split on 3 and 4 byte start codes.
fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let starts: Vec<usize> = data
        .windows(3)
        .enumerate()
        .filter(|(_, w)| *w == [0, 0, 1])
        .map(|(i, _)| i + 3)
        .collect();
    starts
        .iter()
        .enumerate()
        .filter_map(|(k, &s)| {
            let next = starts.get(k + 1);
            let mut e = next.map_or(data.len(), |n| n - 3);
            // A 4 byte start code leaves its leading zero at the end of the unit before it.
            while next.is_some() && e > s && data.get(e - 1) == Some(&0) {
                e -= 1;
            }
            data.get(s..e)
        })
        .collect()
}

/// The next interleaved `$` packet. Text that a server sends in between (keepalive replies) is skipped.
async fn read_interleaved<R: AsyncRead + Unpin>(
    r: &mut R,
    scratch: &mut Vec<u8>,
) -> std::io::Result<(u8, Vec<u8>)> {
    let mut b = [0_u8; 1];
    loop {
        r.read_exact(&mut b).await?;
        if b[0] == b'$' {
            break;
        }
        scratch.push(b[0]);
        if scratch.ends_with(b"\r\n\r\n") || scratch.len() > MAX_HEADERS {
            scratch.clear();
        }
    }
    let mut h = [0_u8; 3];
    r.read_exact(&mut h).await?;
    let len = usize::from(u16::from_be_bytes([h[1], h[2]]));
    let mut data = vec![0_u8; len];
    r.read_exact(&mut data).await?;
    Ok((h[0], data))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    /// A scripted camera on a plain TCP port: OPTIONS 200, DESCRIBE 401 with a live555 challenge,
    /// then it hands back every request it read and closes.
    async fn live555_camera() -> (u16, tokio::task::JoinHandle<Vec<String>>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (mut sock, _) = l.accept().await.unwrap();
            let mut seen = Vec::new();
            for reply in [
                "RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n",
                "RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\nWWW-Authenticate: Digest realm=\"LIVE555 Streaming Media\", nonce=\"3f2a9c\"\r\n\r\n",
                "RTSP/1.0 404 Not Found\r\nCSeq: 3\r\n\r\n",
            ] {
                let mut req = Vec::new();
                let mut b = [0_u8; 1];
                while !req.ends_with(b"\r\n\r\n") {
                    if sock.read_exact(&mut b).await.is_err() {
                        return seen;
                    }
                    req.push(b[0]);
                }
                seen.push(String::from_utf8(req).unwrap());
                sock.write_all(reply.as_bytes()).await.unwrap();
            }
            seen
        });
        (port, h)
    }

    // The request our real open sends after a live555 401, byte for byte with the hash masked: the
    // same header that got DESCRIBE 200 from the H2D in a separate script, no algorithm, and the URI
    // in the request line and in the digest identical.
    #[tokio::test]
    async fn the_digest_describe_is_the_header_the_h2d_accepted() {
        let (port, seen) = live555_camera().await;
        let target = Target {
            host: "127.0.0.1".to_owned(),
            port,
            path: "/streaming/live/1".to_owned(),
            tls: false,
            tls12_only: false,
            login: Some(("bblp".to_owned(), "12345678".to_owned())),
            log_as: String::new(),
        };
        assert!(open(&target).await.is_err());
        let seen = seen.await.unwrap();
        let req = seen.get(2).expect("a second DESCRIBE");
        let uri = format!("rtsp://127.0.0.1:{port}/streaming/live/1");
        let line = req.lines().next().unwrap();
        assert_eq!(line, format!("DESCRIBE {uri} RTSP/1.0"));
        let auth = req
            .lines()
            .find_map(|l| l.strip_prefix("Authorization: "))
            .unwrap();
        let ha1 = md5_hex("bblp:LIVE555 Streaming Media:12345678");
        let ha2 = md5_hex(&format!("DESCRIBE:{uri}"));
        let response = md5_hex(&format!("{ha1}:3f2a9c:{ha2}"));
        assert_eq!(
            auth.replace(&response, "<hash>"),
            format!(
                "Digest username=\"bblp\", realm=\"LIVE555 Streaming Media\", nonce=\"3f2a9c\", uri=\"{uri}\", response=\"<hash>\""
            ),
            "the response is MD5(MD5(bblp:realm:code):nonce:MD5(DESCRIBE:uri))"
        );
        let headers: Vec<&str> = req.lines().skip(1).filter(|l| !l.is_empty()).collect();
        assert_eq!(
            headers
                .iter()
                .map(|l| l.split(':').next().unwrap())
                .collect::<Vec<_>>(),
            ["CSeq", "User-Agent", "Accept", "Authorization"]
        );
        assert!(
            req.contains("CSeq: 3\r\n"),
            "the retry takes the next CSeq: {req}"
        );
    }

    fn md5_hex(s: &str) -> String {
        use md5::{Digest, Md5};
        crate::types::hex(&Md5::digest(s.as_bytes()))
    }

    fn rtp(marker: bool, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![
            0x80,
            if marker { 0xe0 } else { 0x60 },
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
        ];
        p.extend_from_slice(payload);
        p
    }

    #[test]
    fn urls_are_parsed_and_logins_refused() {
        let t = parse_url("rtsps://192.168.1.4/streaming/live/1", None).unwrap();
        assert_eq!(
            (t.host.as_str(), t.port, t.tls, t.path.as_str()),
            ("192.168.1.4", 322, true, "/streaming/live/1")
        );
        let t = parse_url("rtsp://cam.local:8554", None).unwrap();
        assert_eq!((t.port, t.path.as_str()), (8554, "/"));
        assert!(parse_url("rtsp://bblp:secret@192.168.1.4/x", None).is_none());
        assert!(parse_url("http://192.168.1.4/x", None).is_none());
    }

    #[test]
    fn base64_round_trips() {
        for s in ["", "a", "ab", "abc", "abcd", "bblp:12345678"] {
            assert_eq!(b64_decode(&b64_encode(s.as_bytes())).unwrap(), s.as_bytes());
        }
        assert_eq!(b64_encode(b"Man"), "TWFu");
        assert!(b64_decode("!!").is_none());
    }

    #[test]
    fn sdp_gives_the_track_and_parameter_sets() {
        let sdp = "v=0\r\nm=audio 0 RTP/AVP 8\r\na=control:audio\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;sprop-parameter-sets=Z0IAH5WoFAFuQA==,aM4G4g==\r\na=control:track1\r\n";
        let s = parse_sdp(sdp).unwrap();
        assert_eq!(s.control.as_deref(), Some("track1"));
        assert_eq!(s.payload_type, Some(96));
        assert_eq!(s.sps_pps.len(), 2);
        assert_eq!(s.sps_pps[0][0] & 0x1f, 7);
        assert_eq!(s.sps_pps[1][0] & 0x1f, 8);
        assert!(parse_sdp("v=0\r\nm=audio 0 RTP/AVP 8\r\n").is_none());
        assert_eq!(track_uri("rtsp://h/x", Some("track1")), "rtsp://h/x/track1");
        assert_eq!(track_uri("rtsp://h/x", Some("*")), "rtsp://h/x");
    }

    #[test]
    fn single_nal_stap_and_fragmented_units_become_annex_b_frames() {
        let mut d = H264Depay::new(vec![vec![0x67, 1], vec![0x68, 2]]);
        // A P frame in one packet.
        let f = d.push(&rtp(true, &[0x41, 9, 9])).pop().unwrap();
        assert!(!f.key);
        assert_eq!(f.data, [0, 0, 0, 1, 0x41, 9, 9]);
        // STAP-A of SPS and PPS, then an IDR split over three FU-A packets: the marker ends it.
        let stap = [24, 0, 2, 0x67, 5, 0, 2, 0x68, 6];
        assert!(d.push(&rtp(false, &stap)).is_empty());
        assert!(d.push(&rtp(false, &[0x7c, 0x85, 1, 1])).is_empty());
        assert!(d.push(&rtp(false, &[0x7c, 0x05, 2, 2])).is_empty());
        let f = d.push(&rtp(true, &[0x7c, 0x45, 3])).pop().unwrap();
        assert!(f.key);
        let expect: Vec<u8> = [
            &[0, 0, 0, 1, 0x67, 5][..],
            &[0, 0, 0, 1, 0x68, 6],
            &[0, 0, 0, 1, 0x65, 1, 1, 2, 2, 3],
        ]
        .concat();
        assert_eq!(f.data, expect);
        // An IDR without parameter sets gets the last ones the stream sent.
        let f = d.push(&rtp(true, &[0x65, 4])).pop().unwrap();
        assert_eq!(
            f.data,
            [0, 0, 0, 1, 0x67, 5, 0, 0, 0, 1, 0x68, 6, 0, 0, 0, 1, 0x65, 4]
        );
        // Before the stream sent any, the ones from the SDP.
        let mut d = H264Depay::new(vec![vec![0x67, 1], vec![0x68, 2]]);
        let f = d.push(&rtp(true, &[0x65, 4])).pop().unwrap();
        assert_eq!(
            f.data,
            [0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 4]
        );
    }

    fn rtp_at(ts: u32, marker: bool, payload: &[u8]) -> Vec<u8> {
        let mut p = rtp(marker, payload);
        p[4..8].copy_from_slice(&ts.to_be_bytes());
        p
    }

    // Cameras that send SPS and PPS as packets of their own with the marker bit set, and leave
    // them out of the SDP: the key frame after them must still carry them, or no decoder starts.
    #[test]
    fn parameter_sets_sent_on_their_own_go_with_the_next_key_frame() {
        let mut d = H264Depay::default();
        assert!(d.push(&rtp_at(1, true, &[0x67, 0x64, 0x00, 0x28])).is_empty());
        assert!(d.push(&rtp_at(1, true, &[0x68, 7])).is_empty());
        let f = d.push(&rtp_at(1, true, &[0x65, 8])).pop().unwrap();
        assert!(f.key);
        assert_eq!(
            f.data,
            [
                0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0, 0, 0, 1, 0x68, 7, 0, 0, 0, 1, 0x65, 8
            ]
        );
        assert_eq!(avc_codec(&f.data).as_deref(), Some("avc1.640028"));
    }

    // A camera that never sets the marker bit: a new timestamp ends the access unit before it.
    #[test]
    fn a_new_timestamp_ends_an_access_unit_without_a_marker() {
        let mut d = H264Depay::default();
        assert!(d.push(&rtp_at(10, false, &[0x41, 1])).is_empty());
        let got = d.push(&rtp_at(20, false, &[0x41, 2]));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].data, [0, 0, 0, 1, 0x41, 1]);
        // The next one ends with a marker in the same packet that starts it.
        let got = d.push(&rtp_at(30, true, &[0x41, 3]));
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].data, [0, 0, 0, 1, 0x41, 3]);
    }

    #[test]
    fn annex_b_units_split_on_both_start_codes() {
        let au = [0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 1, 0x68, 4, 0, 0, 0, 1, 0x65, 5];
        let units = nal_units(&au);
        assert_eq!(units, [&[0x67, 1, 2, 3][..], &[0x68, 4], &[0x65, 5]]);
        assert_eq!(avc_codec(&au).as_deref(), Some("avc1.010203"));
        assert!(avc_codec(&[0, 0, 0, 1, 0x65, 5]).is_none());
    }

    #[test]
    fn bad_packets_are_ignored() {
        let mut d = H264Depay::default();
        assert!(d.push(&[]).is_empty());
        assert!(d.push(&[0x40; 20]).is_empty());
        assert!(d.push(&rtp(true, &[])).is_empty());
        // A continuation fragment with no start.
        assert!(d.push(&rtp(true, &[0x7c, 0x05, 1])).is_empty());
        // A STAP-A whose length runs past the packet.
        assert!(d.push(&rtp(true, &[24, 0, 50, 1])).is_empty());
    }
}
