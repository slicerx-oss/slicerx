// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Live camera frames. A printer's camera arrives as JPEG frames (MJPEG over HTTP, the Bambu Lab
//! port 6000 stream, polled snapshots) or as H.264 access units (RTSP). A [`FrameStream`] carries
//! them at the camera's own quality; `sx-link` decides how many to pass on.
use std::future::Future;
use std::time::Duration;

use futures::StreamExt;
use futures::stream::{BoxStream, unfold};
use reqwest::Client;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Jpeg,
    /// One access unit in Annex B form (start code delimited NAL units).
    H264,
}

#[derive(Debug, Clone)]
pub struct CameraFrame {
    pub kind: FrameKind,
    /// Decoding can start here: always true for JPEG, an IDR picture for H.264.
    pub key: bool,
    pub data: Vec<u8>,
}

pub type FrameStream = BoxStream<'static, CameraFrame>;

const MAX_JPEG: usize = 8 * 1024 * 1024;

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Runs `producer` on a task and turns what it sends into a stream. Dropping the stream stops the
/// task, which drops its connection to the printer.
pub(crate) fn spawn_stream<F, Fut>(producer: F) -> FrameStream
where
    F: FnOnce(mpsc::Sender<CameraFrame>) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = mpsc::channel(4);
    let guard = AbortOnDrop(tokio::spawn(producer(tx)));
    unfold((rx, guard), |(mut rx, guard)| async move {
        rx.recv().await.map(|f| (f, (rx, guard)))
    })
    .boxed()
}

/// Splits an MJPEG byte stream (multipart or bare) into JPEG frames. A part's `Content-Length` is
/// used when present, because a JPEG can hold embedded thumbnails with their own end marker.
#[derive(Default)]
pub(crate) struct MjpegParser {
    buf: Vec<u8>,
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn content_length(head: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    let rest = text
        .rsplit("content-length:")
        .next()
        .filter(|_| text.contains("content-length:"))?;
    rest.trim_start()
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

impl MjpegParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some(start) = find(&self.buf, &[0xff, 0xd8], 0) else {
                // Keep the last byte: it may be the first half of a start marker.
                let keep = self.buf.len().saturating_sub(1);
                self.buf.drain(..keep);
                break;
            };
            let head = self.buf.get(..start).unwrap_or(&[]);
            let declared = content_length(head).filter(|n| (2..=MAX_JPEG).contains(n));
            let end = match declared {
                Some(n) => {
                    if self.buf.len() < start + n {
                        break;
                    }
                    // Trust the length only when it lands on an end marker.
                    let tail = self.buf.get(start + n - 2..start + n);
                    if tail == Some(&[0xff, 0xd9]) {
                        start + n
                    } else {
                        match find(&self.buf, &[0xff, 0xd9], start + 2) {
                            Some(e) => e + 2,
                            None => break,
                        }
                    }
                }
                None => match find(&self.buf, &[0xff, 0xd9], start + 2) {
                    Some(e) => e + 2,
                    None => break,
                },
            };
            if let Some(frame) = self.buf.get(start..end) {
                out.push(frame.to_vec());
            }
            self.buf.drain(..end);
        }
        if self.buf.len() > MAX_JPEG {
            self.buf.clear();
        }
        out
    }
}

/// Streams the JPEG frames of an MJPEG URL. `None` when the camera does not answer with success.
pub(crate) async fn mjpeg_stream(client: &Client, url: &str) -> Option<FrameStream> {
    let resp = client
        .get(url)
        .timeout(Duration::from_hours(24))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    Some(spawn_stream(move |tx| async move {
        let mut parser = MjpegParser::default();
        let mut body = resp.bytes_stream();
        while let Some(Ok(chunk)) = body.next().await {
            for data in parser.push(&chunk) {
                let frame = CameraFrame {
                    kind: FrameKind::Jpeg,
                    key: true,
                    data,
                };
                if tx.send(frame).await.is_err() {
                    return;
                }
            }
        }
    }))
}

/// Turns repeated snapshots into a stream, for cameras that offer nothing else. `fetch` returns one
/// JPEG or `None` when the camera is not answering; three misses in a row end the stream.
pub(crate) fn poll_snapshots<F, Fut>(interval: Duration, fetch: F) -> FrameStream
where
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = Option<Vec<u8>>> + Send + 'static,
{
    spawn_stream(move |tx| async move {
        let mut misses = 0;
        loop {
            if let Some(data) = fetch().await {
                misses = 0;
                let frame = CameraFrame {
                    kind: FrameKind::Jpeg,
                    key: true,
                    data,
                };
                if tx.send(frame).await.is_err() {
                    return;
                }
            } else {
                misses += 1;
                if misses >= 3 {
                    return;
                }
            }
            tokio::time::sleep(interval).await;
        }
    })
}

/// Opens the camera named by `cfg.camera_url`: RTSP or RTSPS (H.264), an `onvif://` address, or an MJPEG URL. The login, when
/// there is one, comes from `cfg.camera_credential_ref` as `user:password`. `None` when there is no
/// such URL or the camera does not answer.
pub async fn open_url(
    cfg: &crate::types::PrinterConfig,
    secrets: &dyn crate::types::Secrets,
) -> Option<FrameStream> {
    let url = cfg.camera_url.as_deref()?;
    let login = cfg
        .camera_credential_ref
        .as_deref()
        .and_then(|r| secrets.get(r))
        .and_then(|v| v.split_once(':').map(|(u, p)| (u.to_owned(), p.to_owned())));
    if url.starts_with("rtsp://") || url.starts_with("rtsps://") {
        let mut target = crate::rtsp::parse_url(url, login)?;
        target.log_as.clone_from(&cfg.id);
        return crate::rtsp::open(&target).await.ok();
    }
    // `onvif://host[:port]`: ask the camera for its RTSP address, then play that with the same login.
    if let Some(rest) = url.strip_prefix("onvif://") {
        let (authority, path) = rest
            .find('/')
            .map_or((rest, "/onvif/device_service"), |i| rest.split_at(i));
        if authority.is_empty() || authority.contains('@') {
            return None;
        }
        let client = crate::http::client(cfg).ok()?;
        let rtsp =
            crate::onvif::stream_uri(&client, &format!("http://{authority}{path}"), login.as_ref()).await?;
        let mut target = crate::rtsp::parse_url(&rtsp, login)?;
        target.log_as.clone_from(&cfg.id);
        return crate::rtsp::open(&target).await.ok();
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        let rest = url.split_once("://")?.1;
        if rest.split(['/', '?', '#']).next()?.contains('@') {
            return None;
        }
        let client = crate::http::client(cfg).ok()?;
        return mjpeg_stream(&client, url).await;
    }
    None
}

/// How a camera's WebRTC service takes an offer. The offer goes out and the answer comes back in one
/// request, so the browser sends its offer with ICE candidates already gathered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signaling {
    /// crowsnest's camera-streamer: `POST` JSON `{"type":"offer","sdp"}`, answer `{"type":"answer","sdp"}`.
    CameraStreamer(String),
    /// WHEP as mediamtx and go2rtc serve it: `POST` the SDP as `application/sdp`, answer is the SDP.
    Whep(String),
    /// The Creality K2 web UI flow: `POST` the base64 of `{"type":"offer","sdp"}`, answer likewise.
    Creality(String),
}

impl Signaling {
    /// The signaling of a Moonraker webcam entry, by the `service` Mainsail and Fluidd record.
    pub fn from_webcam(service: &str, url: String) -> Option<Self> {
        match service {
            "webrtc-camerastreamer" => Some(Self::CameraStreamer(url)),
            "webrtc-mediamtx" | "webrtc-go2rtc" => Some(Self::Whep(url)),
            _ => None,
        }
    }
}

/// An SDP the printer may be sent: text, sane size, starts like SDP.
pub fn valid_sdp(sdp: &str) -> bool {
    sdp.starts_with("v=0") && sdp.len() <= 64 * 1024 && !sdp.contains('\0')
}

/// The SDP in a signaling reply: bare SDP, JSON with `sdp`, or base64 of that JSON.
pub(crate) fn extract_answer(body: &str) -> Option<String> {
    let body = body.trim_start();
    if body.starts_with("v=0") {
        return Some(crlf_end(body));
    }
    let from_json = |t: &str| {
        serde_json::from_str::<serde_json::Value>(t).ok().and_then(|v| {
            v.get("sdp")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
    };
    from_json(body.trim_end())
        .or_else(|| {
            let raw = crate::rtsp::b64_decode(body)?;
            from_json(&String::from_utf8(raw).ok()?)
        })
        .map(|sdp| crlf_end(&sdp))
}

/// SDP lines each end in CRLF, the last one too; a browser refuses an answer that stops short.
fn crlf_end(sdp: &str) -> String {
    format!("{}\r\n", sdp.trim_end())
}

/// Sends `offer` to the camera's WebRTC service and returns its answer SDP. `None` when the service
/// does not answer, refuses, or answers something that is not SDP.
pub async fn webrtc_answer(
    cfg: &crate::types::PrinterConfig,
    signaling: &Signaling,
    offer: &str,
) -> Option<String> {
    if !valid_sdp(offer) {
        return None;
    }
    let client = crate::http::client(cfg).ok()?;
    let req = match signaling {
        Signaling::CameraStreamer(url) => client
            .post(url)
            .json(&serde_json::json!({ "type": "offer", "sdp": offer })),
        Signaling::Whep(url) => client
            .post(url)
            .header("content-type", "application/sdp")
            .body(offer.to_owned()),
        Signaling::Creality(url) => {
            let payload = serde_json::json!({ "type": "offer", "sdp": offer }).to_string();
            client
                .post(url)
                .header("content-type", "plain/text")
                .body(crate::rtsp::b64_encode(payload.as_bytes()))
        }
    };
    let resp = req.timeout(Duration::from_secs(10)).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    extract_answer(&text).filter(|a| valid_sdp(a))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn jpeg(n: u8) -> Vec<u8> {
        vec![0xff, 0xd8, n, n, 0xff, 0xd9]
    }

    fn part(data: &[u8], with_len: bool) -> Vec<u8> {
        let mut p = b"--frame\r\nContent-Type: image/jpeg\r\n".to_vec();
        if with_len {
            p.extend_from_slice(format!("Content-Length: {}\r\n", data.len()).as_bytes());
        }
        p.extend_from_slice(b"\r\n");
        p.extend_from_slice(data);
        p.extend_from_slice(b"\r\n");
        p
    }

    #[test]
    fn answers_are_read_from_sdp_json_and_base64_json() {
        let sdp = "v=0\r\ns=x\r\n";
        assert_eq!(extract_answer(sdp).as_deref(), Some(sdp));
        let json = serde_json::json!({ "type": "answer", "sdp": sdp }).to_string();
        assert_eq!(extract_answer(&json).as_deref(), Some(sdp));
        assert_eq!(
            extract_answer(&crate::rtsp::b64_encode(json.as_bytes())).as_deref(),
            Some(sdp)
        );
        assert_eq!(extract_answer("<html>"), None);
        assert_eq!(extract_answer(r#"{"sdp":5}"#), None);
        assert!(valid_sdp("v=0\r\n") && !valid_sdp("hello") && !valid_sdp("v=0\0"));
        assert_eq!(
            Signaling::from_webcam("webrtc-go2rtc", "u".into()),
            Some(Signaling::Whep("u".into()))
        );
        assert_eq!(Signaling::from_webcam("mjpegstreamer", "u".into()), None);
    }

    #[test]
    fn frames_are_split_however_the_chunks_fall() {
        let mut all = Vec::new();
        for n in 1..=3 {
            all.extend(part(&jpeg(n), n != 2));
        }
        for size in [1, 2, 5, 7, 4096] {
            let mut p = MjpegParser::default();
            let mut got = Vec::new();
            for c in all.chunks(size) {
                got.extend(p.push(c));
            }
            assert_eq!(got, vec![jpeg(1), jpeg(2), jpeg(3)], "chunk size {size}");
        }
    }

    #[test]
    fn a_declared_length_survives_an_embedded_end_marker() {
        // A thumbnail inside the frame has its own SOI and EOI.
        let mut data = vec![0xff, 0xd8, 0xff, 0xe1, 0xff, 0xd8, 9, 0xff, 0xd9, 7, 7];
        data.extend_from_slice(&[0xff, 0xd9]);
        let mut p = MjpegParser::default();
        let got = p.push(&part(&data, true));
        assert_eq!(got, vec![data]);
    }

    #[test]
    fn garbage_and_oversize_input_do_not_grow_the_buffer() {
        let mut p = MjpegParser::default();
        assert!(p.push(&[1, 2, 3, 4]).is_empty());
        assert!(p.buf.len() <= 1);
        let mut big = vec![0xff, 0xd8];
        big.resize(MAX_JPEG + 10, 0);
        assert!(p.push(&big).is_empty());
        assert!(p.buf.is_empty());
    }
}
