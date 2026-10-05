// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Live camera over a remote session when no direct path exists: one sealed JPEG a second, at most
//! 640 pixels wide, for at most 10 minutes a stream. Frames travel as `camera.frame` events inside
//! the pair session, so the relay carries ciphertext only. JPEG cameras are shrunk when wider; H.264
//! cameras give one key frame a second at most, decoded through the OS decoder.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures::StreamExt;
use serde_json::{Value, json};
use sx_connect::camera::FrameKind;

use crate::rpc::Bridge;

/// One frame a second at most.
const FRAME_EVERY: Duration = Duration::from_secs(1);
/// A stream ends after this long; the phone opens a new one if the person is still watching.
pub(crate) const MAX_STREAM: Duration = Duration::from_mins(10);
pub(crate) const MAX_WIDTH: usize = 640;
const QUALITY: u8 = 70;
/// Largest frame passed on unread when the decoder cannot read its size.
const UNREAD_MAX: usize = 100 * 1024;
/// Largest frame on the wire as base64 (`MAX_FRAME_B64` in packages/pair/src/rpc.ts).
const MAX_FRAME_B64: usize = 700_000;
/// Streams a session may have open, and the hub in all.
pub(crate) const STREAMS_PER_SESSION: usize = 1;

/// Sends `camera.*` events for one stream until the camera ends, the time is up or the task is
/// aborted. `emit(event, data)` seals and sends one event.
pub(crate) async fn run(
    b: Arc<Bridge>,
    printer: String,
    stream: u32,
    emit: impl Fn(&str, Value) + Send + 'static,
) {
    let reason = feed(&b, &printer, stream, &emit).await;
    emit("camera.ended", json!({ "stream": stream, "reason": reason }));
}

async fn feed(
    b: &Arc<Bridge>,
    printer: &str,
    stream: u32,
    emit: &(impl Fn(&str, Value) + Send),
) -> &'static str {
    let Ok(mut src) = crate::rpc::camera_source(b, printer, "remote frames").await else {
        return "ended";
    };
    let codecs = crate::h264::codec_dir(b.hub.dir.as_ref().map(crate::hub::StateDir::path));
    let end = tokio::time::Instant::now() + MAX_STREAM;
    let mut last: Option<tokio::time::Instant> = None;
    let mut stats_at = tokio::time::Instant::now();
    let (mut sent, mut bytes, mut dropped) = (0_u32, 0_usize, 0_u32);
    let mut codec_ready = false;
    loop {
        let Ok(next) = tokio::time::timeout_at(end, src.next()).await else {
            return "ended";
        };
        let Some(frame) = next else { return "ended" };
        let now = tokio::time::Instant::now();
        if last.is_some_and(|l| now.duration_since(l) < FRAME_EVERY)
            || (frame.kind == FrameKind::H264 && !frame.key)
        {
            dropped += 1;
            continue;
        }
        let data = frame.data;
        let jpeg = match frame.kind {
            // A frame the decoder cannot read (an unusual JPEG flavor) still goes out when it is small.
            FrameKind::Jpeg => tokio::task::spawn_blocking(move || {
                crate::h264::fit_jpeg(&data, MAX_WIDTH, QUALITY)
                    .or_else(|| (data.len() <= UNREAD_MAX).then_some(data))
            })
            .await
            .ok()
            .flatten(),
            FrameKind::H264 => {
                if !codec_ready {
                    codec_ready = crate::h264::ensure_codec(codecs.as_deref()).await;
                    if !codec_ready {
                        return "codec";
                    }
                }
                let dir = codecs.clone();
                tokio::task::spawn_blocking(move || {
                    crate::h264::still_from_key_frame_fit(&data, dir.as_deref(), MAX_WIDTH, QUALITY)
                })
                .await
                .ok()
                .flatten()
            }
        };
        let Some(jpeg) = jpeg else {
            dropped += 1;
            continue;
        };
        let b64 = STANDARD.encode(&jpeg);
        if b64.len() > MAX_FRAME_B64 {
            dropped += 1;
            continue;
        }
        last = Some(now);
        sent += 1;
        bytes += jpeg.len();
        emit(
            "camera.frame",
            json!({ "stream": stream, "capturedAt": crate::hub::now_ms(), "key": true, "kind": "jpeg", "dataB64": b64 }),
        );
        if now.duration_since(stats_at) >= Duration::from_secs(5) {
            let secs = now.duration_since(stats_at).as_secs_f64();
            #[allow(clippy::cast_precision_loss)]
            let (fps, kbps) = (f64::from(sent) / secs, bytes as f64 * 8.0 / 1000.0 / secs);
            emit(
                "camera.stats",
                json!({ "stream": stream, "fps": fps, "kbps": kbps, "dropped": dropped, "quality": "low" }),
            );
            (sent, bytes, dropped, stats_at) = (0, 0, 0, now);
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn width_of(jpeg: &[u8]) -> usize {
        use zune_jpeg::zune_core::bytestream::ZCursor;
        let mut d = zune_jpeg::JpegDecoder::new(ZCursor::new(jpeg));
        d.decode_headers().unwrap();
        usize::from(d.info().unwrap().width)
    }

    #[test]
    fn wide_frames_shrink_to_640_and_small_ones_pass_through() {
        let (w, h) = (1920, 1080);
        let rgb: Vec<u8> = (0..w * h * 3).map(|i| u8::try_from(i % 251).unwrap()).collect();
        let big = crate::jpeg::encode_rgb(&rgb, w, h, 80).unwrap();
        let fitted = crate::h264::fit_jpeg(&big, MAX_WIDTH, QUALITY).unwrap();
        assert!(width_of(&fitted) <= MAX_WIDTH, "{}", width_of(&fitted));
        assert!(fitted.len() < big.len());
        let small = crate::jpeg::encode_rgb(&rgb[..320 * 240 * 3], 320, 240, 80).unwrap();
        assert_eq!(crate::h264::fit_jpeg(&small, MAX_WIDTH, QUALITY).unwrap(), small);
        assert!(crate::h264::fit_jpeg(b"not a jpeg", MAX_WIDTH, QUALITY).is_none());
    }
}
