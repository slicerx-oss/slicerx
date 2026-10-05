// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Live camera streams to a paired client. Frames go out as binary WebSocket messages on the
//! loopback connection, so no video is decoded or re-encoded here; the client decodes (JPEG with
//! `createImageBitmap`, H.264 with `WebCodecs`). What the bridge does is keep the picture current:
//! it caps the frame rate for the chosen quality, and when the client falls behind it drops frames
//! (for H.264, everything until the next key frame) instead of queueing them, and steps the
//! quality down on its own until the queue drains.
//!
//! Binary frame, 16 byte header then the payload:
//! `[0]` 0xC1, `[1]` kind (1 JPEG, 2 H.264 Annex B), `[2]` bit 0 key frame, `[3]` 0,
//! `[4..8]` stream id (u32), `[8..16]` milliseconds since the epoch when the bridge got the frame (u64).
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use serde_json::{Value, json};
use sx_connect::camera::{CameraFrame, FrameKind, FrameStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub(crate) const MAGIC: u8 = 0xC1;
/// Bytes waiting to be written above which new frames are dropped.
const QUEUE_LIMIT: usize = 3 * 1024 * 1024;
/// Streams one connection may have open.
pub(crate) const MAX_STREAMS: usize = 4;

pub(crate) const LOW: u8 = 0;
pub(crate) const MEDIUM: u8 = 1;
pub(crate) const HIGH: u8 = 2;

pub(crate) fn parse_quality(s: &str) -> Option<u8> {
    match s {
        "low" => Some(LOW),
        "medium" => Some(MEDIUM),
        "high" | "auto" => Some(HIGH),
        _ => None,
    }
}

pub(crate) fn quality_name(q: u8) -> &'static str {
    match q {
        LOW => "low",
        MEDIUM => "medium",
        _ => "high",
    }
}

/// Frames per second allowed for JPEG at each quality; `None` is the camera's own rate.
fn fps_cap(q: u8) -> Option<u32> {
    match q {
        LOW => Some(10),
        MEDIUM => Some(15),
        _ => None,
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0))
}

pub(crate) fn frame_message(id: u32, f: &CameraFrame, ts_ms: u64) -> Message {
    let mut b = Vec::with_capacity(16 + f.data.len());
    b.push(MAGIC);
    b.push(match f.kind {
        FrameKind::Jpeg => 1,
        FrameKind::H264 => 2,
    });
    b.push(u8::from(f.key));
    b.push(0);
    b.extend_from_slice(&id.to_be_bytes());
    b.extend_from_slice(&ts_ms.to_be_bytes());
    b.extend_from_slice(&f.data);
    Message::binary(b)
}

/// State shared between a stream task and the requests that steer it.
pub(crate) struct Control {
    /// The quality in force now.
    pub quality: AtomicU8,
    /// The most the bridge may raise it to. The client sets it; automatic steps stay below it.
    pub ceiling: AtomicU8,
    /// The client draws JPEG only (the phone): H.264 key frames are decoded to JPEG here (through
    /// the OS decoder, `sx-stills`) and other H.264 frames are left out.
    pub jpeg_only: bool,
    /// Where Cisco's decoder lives on Linux (`<state dir>/codecs`).
    pub codecs: Option<std::path::PathBuf>,
}

/// Sends `src` to the client as stream `id` until the source ends or the connection goes.
/// `queued` counts bytes handed to the connection but not yet written.
#[allow(clippy::too_many_lines)] // One select loop: frames, quality steps, stats and the log.
pub(crate) async fn run(
    id: u32,
    printer: String,
    mut feed_state: Option<tokio::sync::watch::Receiver<crate::feeds::FeedStatus>>,
    mut src: FrameStream,
    tx: mpsc::UnboundedSender<Message>,
    queued: Arc<AtomicUsize>,
    ctl: Arc<Control>,
) {
    let mut last_sent: Option<Instant> = None;
    let mut need_key = false;
    let (mut sent, mut dropped, mut bytes) = (0_u32, 0_u32, 0_usize);
    let mut clean_seconds = 0_u32;
    let mut total_sent = 0_u64;
    sx_connect::trace(&printer, format_args!("camera stream {id} started"));
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.tick().await;
    // Tell the viewer where the feed stands now (it may already be retrying), then each change.
    if let Some(r) = feed_state.as_mut() {
        r.mark_changed();
    }
    loop {
        // The feed's state changes: retrying after the camera dropped the connection, live again.
        let changed = async {
            match feed_state.as_mut() {
                Some(r) => r.changed().await.is_ok(),
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            ok = changed => {
                if !ok {
                    feed_state = None;
                    continue;
                }
                let Some(r) = feed_state.as_ref() else { continue };
                let body = status_event(id, &printer, &r.borrow());
                if tx.send(Message::text(body.to_string())).is_err() {
                    return;
                }
            }
            f = src.next() => {
                let Some(mut f) = f else {
                    // A feed that failed ends right after saying so; make sure the viewer heard why.
                    if let Some(r) = feed_state.as_ref()
                        && matches!(*r.borrow(), crate::feeds::FeedStatus::Failed { .. })
                    {
                        let _ = tx.send(Message::text(status_event(id, &printer, &r.borrow()).to_string()));
                    }
                    sx_connect::trace(&printer, format_args!("live view {id} closed (the stream ended: the camera stopped sending, after {total_sent} frames)"));
                    let _ = tx.send(Message::text(json!({ "event": "camera.ended", "stream": id, "printerId": printer }).to_string()));
                    return;
                };
                if ctl.jpeg_only && f.kind == FrameKind::H264 {
                    if !f.key {
                        continue;
                    }
                    let codecs = ctl.codecs.clone();
                    let ready = crate::h264::ensure_codec(codecs.as_deref()).await;
                    let unit = std::mem::take(&mut f.data);
                    let jpeg = if ready {
                        tokio::task::spawn_blocking(move || crate::h264::still_from_key_frame(&unit, codecs.as_deref()))
                            .await
                            .ok()
                            .flatten()
                    } else {
                        None
                    };
                    let Some(jpeg) = jpeg else {
                        // No decoder here: the client falls back to stills.
                        sx_connect::trace(&printer, format_args!("live view {id} closed (fallback to stills: no H.264 decoder for a JPEG-only viewer)"));
                        let _ = tx.send(Message::text(json!({ "event": "camera.ended", "stream": id, "printerId": printer, "reason": "codec" }).to_string()));
                        return;
                    };
                    f = CameraFrame { kind: FrameKind::Jpeg, key: true, data: jpeg };
                }
                let q = ctl.quality.load(Ordering::Relaxed);
                let allowed = match f.kind {
                    FrameKind::Jpeg => match (fps_cap(q), last_sent) {
                        (Some(cap), Some(t)) => t.elapsed() >= Duration::from_millis(1000 / u64::from(cap)),
                        _ => true,
                    },
                    // Delta frames depend on the ones before them, so the lowest quality sends key frames only.
                    FrameKind::H264 => q != LOW || f.key,
                };
                if !allowed {
                    continue;
                }
                let backed_up = queued.load(Ordering::Relaxed) > QUEUE_LIMIT;
                if backed_up || (need_key && !f.key) {
                    dropped += 1;
                    if f.kind == FrameKind::H264 {
                        need_key = true;
                    }
                    continue;
                }
                need_key = false;
                let msg = frame_message(id, &f, now_ms());
                queued.fetch_add(f.data.len() + 16, Ordering::Relaxed);
                bytes += f.data.len();
                sent += 1;
                if total_sent == 0 {
                    sx_connect::trace(&printer, format_args!(
                        "camera stream {id}: first frame to the viewer, {}, {} bytes",
                        if f.kind == FrameKind::Jpeg { "JPEG" } else if f.key { "H.264 key frame" } else { "H.264 delta frame" },
                        f.data.len(),
                    ));
                }
                total_sent += 1;
                last_sent = Some(Instant::now());
                if tx.send(msg).is_err() {
                    sx_connect::trace(&printer, format_args!("live view {id} closed (the app's connection to the bridge closed)"));
                    return;
                }
            }
            _ = tick.tick() => {
                let q = ctl.quality.load(Ordering::Relaxed);
                let total = sent + dropped;
                // Step down when a fifth of the frames could not be delivered; step back up after ten clean seconds.
                let mut new_q = q;
                if total > 0 && dropped * 5 > total && q > LOW {
                    new_q = q - 1;
                    clean_seconds = 0;
                } else if dropped == 0 {
                    clean_seconds += 1;
                    if clean_seconds >= 10 && q < ctl.ceiling.load(Ordering::Relaxed) {
                        new_q = q + 1;
                        clean_seconds = 0;
                    }
                } else {
                    clean_seconds = 0;
                }
                if new_q != q {
                    ctl.quality.store(new_q, Ordering::Relaxed);
                }
                let stats = json!({
                    "event": "camera.stats", "stream": id, "printerId": printer,
                    "fps": sent, "kbps": bytes * 8 / 1000, "dropped": dropped,
                    "quality": quality_name(new_q),
                });
                if tx.send(Message::text(stats.to_string())).is_err() {
                    return;
                }
                (sent, dropped, bytes) = (0, 0, 0);
            }
        }
    }
}

/// Why the app closed a live view, in its own words (`reason`), for the connection log only: letters,
/// digits, spaces and plain punctuation, at most 80 characters.
pub(crate) fn close_reason(p: &Value) -> String {
    let r: String = p
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || " ,:-".contains(*c))
        .take(80)
        .collect();
    if r.trim().is_empty() {
        "no reason given".to_owned()
    } else {
        r
    }
}

/// `camera.status`: what the stream's camera feed is doing. `state` is `live`, `retrying` (with
/// `attempt`, `retryInMs` and the `reason` in plain words) or `failed` (with the `reason`; the
/// stream ends after it).
pub(crate) fn status_event(id: u32, printer: &str, s: &crate::feeds::FeedStatus) -> Value {
    match s {
        crate::feeds::FeedStatus::Live => {
            json!({ "event": "camera.status", "stream": id, "printerId": printer, "state": "live" })
        }
        crate::feeds::FeedStatus::Retrying {
            attempt,
            in_ms,
            reason,
        } => json!({
            "event": "camera.status", "stream": id, "printerId": printer, "state": "retrying",
            "attempt": attempt, "retryInMs": in_ms, "reason": reason,
        }),
        crate::feeds::FeedStatus::Failed { reason } => json!({
            "event": "camera.status", "stream": id, "printerId": printer, "state": "failed",
            "reason": reason,
        }),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_close_reason_is_plain_words_only() {
        let r = |v: Value| close_reason(&json!({ "stream": 1, "reason": v }));
        assert_eq!(
            r(json!("the view closed or the app navigated away")),
            "the view closed or the app navigated away"
        );
        assert_eq!(r(json!("x\r\nevil\u{1b}[2J")), "xevil2J");
        assert_eq!(r(json!(7)), "no reason given");
        assert_eq!(close_reason(&json!({ "stream": 1 })), "no reason given");
        assert_eq!(r(json!("a".repeat(200))).len(), 80);
    }

    #[test]
    fn frame_header_layout() {
        let f = CameraFrame {
            kind: FrameKind::H264,
            key: true,
            data: vec![9, 8, 7],
        };
        let Message::Binary(b) = frame_message(0x0102_0304, &f, 5) else {
            panic!("binary")
        };
        assert_eq!(&b[..8], &[0xC1, 2, 1, 0, 1, 2, 3, 4]);
        assert_eq!(u64::from_be_bytes(b[8..16].try_into().unwrap()), 5);
        assert_eq!(&b[16..], &[9, 8, 7]);
    }

    fn frame(kind: FrameKind, key: bool, size: usize) -> CameraFrame {
        CameraFrame {
            kind,
            key,
            data: vec![7; size],
        }
    }

    fn source(frames: Vec<CameraFrame>) -> FrameStream {
        // Yields the frames, then waits, like a camera that keeps streaming.
        futures::stream::iter(frames)
            .chain(futures::stream::pending())
            .boxed()
    }

    fn ctl(q: u8) -> Arc<Control> {
        ctl_with(q, false)
    }

    fn ctl_with(q: u8, jpeg_only: bool) -> Arc<Control> {
        Arc::new(Control {
            quality: AtomicU8::new(q),
            ceiling: AtomicU8::new(q),
            jpeg_only,
            codecs: None,
        })
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_that_falls_behind_gets_dropped_frames_and_a_lower_quality() {
        // Nothing drains `rx`, so the queue only grows: a client that has stopped reading.
        let (tx, mut rx) = mpsc::unbounded_channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let c = ctl(HIGH);
        let frames: Vec<CameraFrame> = (0..12)
            .map(|_| frame(FrameKind::Jpeg, true, 500 * 1024))
            .collect();
        let task = tokio::spawn(run(
            1,
            "p".into(),
            None,
            source(frames),
            tx,
            queued.clone(),
            c.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(1100)).await;
        // About six frames fit under the limit; the rest were dropped, not queued.
        let held = queued.load(Ordering::Relaxed);
        assert!(held <= QUEUE_LIMIT + 500 * 1024 + 16, "{held}");
        assert!(held > QUEUE_LIMIT / 2, "{held}");
        assert_eq!(
            c.quality.load(Ordering::Relaxed),
            MEDIUM,
            "stepped down one level"
        );
        let mut stats = None;
        while let Ok(m) = rx.try_recv() {
            if let Message::Text(t) = m {
                stats = Some(serde_json::from_str::<serde_json::Value>(t.as_str()).unwrap());
            }
        }
        let stats = stats.expect("a stats event");
        assert_eq!(stats["event"], "camera.stats");
        assert!(stats["dropped"].as_u64().unwrap() > 0, "{stats}");
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn after_a_drop_h264_waits_for_a_key_frame() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let frames = vec![
            frame(FrameKind::H264, false, 100),
            frame(FrameKind::H264, true, 100),
            frame(FrameKind::H264, false, 100),
        ];
        // One drop first (queue full), then room: the delta frame after the drop is skipped.
        let queued = Arc::new(AtomicUsize::new(QUEUE_LIMIT + 1));
        let q2 = queued.clone();
        let src = futures::stream::iter(frames)
            .then(move |f| {
                let q2 = q2.clone();
                async move {
                    if f.key {
                        q2.store(0, Ordering::Relaxed);
                    }
                    f
                }
            })
            .chain(futures::stream::pending())
            .boxed();
        let task = tokio::spawn(run(1, "p".into(), None, src, tx, queued, ctl(HIGH)));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut kinds = Vec::new();
        while let Ok(Message::Binary(b)) = rx.try_recv() {
            kinds.push(b[2]);
        }
        assert_eq!(
            kinds,
            vec![1, 0],
            "key frame, then the delta frame that follows it"
        );
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn low_quality_caps_jpeg_and_sends_only_key_frames_of_h264() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let jpegs: Vec<CameraFrame> = (0..30).map(|_| frame(FrameKind::Jpeg, true, 10)).collect();
        let task = tokio::spawn(run(
            1,
            "p".into(),
            None,
            source(jpegs),
            tx,
            Arc::new(AtomicUsize::new(0)),
            ctl(LOW),
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut n = 0;
        while let Ok(Message::Binary(_)) = rx.try_recv() {
            n += 1;
        }
        // All 30 arrive at once; at 10 fps only the first passes.
        assert_eq!(n, 1);
        task.abort();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let h264 = vec![
            frame(FrameKind::H264, true, 10),
            frame(FrameKind::H264, false, 10),
            frame(FrameKind::H264, false, 10),
            frame(FrameKind::H264, true, 10),
        ];
        let task = tokio::spawn(run(
            1,
            "p".into(),
            None,
            source(h264),
            tx,
            Arc::new(AtomicUsize::new(0)),
            ctl(LOW),
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut keys = 0;
        while let Ok(Message::Binary(b)) = rx.try_recv() {
            assert_eq!(b[2], 1);
            keys += 1;
        }
        assert_eq!(keys, 2);
        task.abort();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_jpeg_only_client_gets_key_frames_as_jpeg_and_no_other_h264() {
        use openh264::encoder::Encoder;
        use openh264::formats::{RgbSliceU8, YUVBuffer};
        let rgb = vec![120_u8; 160 * 96 * 3];
        let yuv = YUVBuffer::from_rgb8_source(RgbSliceU8::new(&rgb, (160, 96)));
        let key = Encoder::new().unwrap().encode(&yuv).unwrap().to_vec();
        let frames = vec![
            CameraFrame {
                kind: FrameKind::H264,
                key: true,
                data: key,
            },
            CameraFrame {
                kind: FrameKind::H264,
                key: false,
                data: vec![0, 0, 0, 1, 0x41, 1],
            },
        ];
        let (tx, mut rx) = mpsc::unbounded_channel();
        // A finite source, so `run` ends when the frames do.
        run(
            1,
            "p".into(),
            None,
            futures::stream::iter(frames).boxed(),
            tx,
            Arc::new(AtomicUsize::new(0)),
            ctl_with(HIGH, true),
        )
        .await;
        let mut kinds = Vec::new();
        while let Ok(m) = rx.try_recv() {
            if let Message::Binary(b) = m {
                kinds.push(b[1]);
                assert_eq!(&b[16..19], &[0xFF, 0xD8, 0xFF], "a JPEG");
            }
        }
        assert_eq!(kinds, vec![1], "one JPEG frame, the delta frame left out");
    }

    #[tokio::test]
    async fn a_jpeg_only_client_hears_codec_when_nothing_decodes() {
        let frames = vec![CameraFrame {
            kind: FrameKind::H264,
            key: true,
            data: vec![0, 0, 0, 1, 0x65, 1, 2],
        }];
        let (tx, mut rx) = mpsc::unbounded_channel();
        // A finite source, so `run` ends when the frames do.
        run(
            1,
            "p".into(),
            None,
            futures::stream::iter(frames).boxed(),
            tx,
            Arc::new(AtomicUsize::new(0)),
            ctl_with(HIGH, true),
        )
        .await;
        let mut ended = None;
        while let Ok(m) = rx.try_recv() {
            if let Message::Text(t) = m {
                ended = Some(t.to_string());
            }
        }
        assert!(ended.unwrap().contains("\"reason\":\"codec\""));
    }

    #[test]
    fn qualities_parse() {
        assert_eq!(parse_quality("low"), Some(LOW));
        assert_eq!(parse_quality("auto"), Some(HIGH));
        assert_eq!(parse_quality("ultra"), None);
        assert_eq!(quality_name(MEDIUM), "medium");
    }
}
