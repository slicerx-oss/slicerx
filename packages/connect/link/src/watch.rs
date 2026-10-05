// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Print watch: single stills from a printer's camera, for the assistant's "how is my print going?"
//! and for failure detectors.
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures::StreamExt;
use serde_json::{Value, json};
use sx_connect::camera::FrameKind;

use crate::hub::{iso, now_ms};
use crate::rpc::{Bridge, Rpc, RpcError, camera_source, session, str_arg};

/// How long a grab may wait for the printer's snapshot, then for a frame from the live stream.
const SNAPSHOT_WAIT: Duration = Duration::from_secs(8);
const STREAM_WAIT: Duration = Duration::from_secs(8);
/// Largest still handed out. Picture readers (the assistant's print check) take up to 5 MB; the
/// phone channel applies its own smaller limit.
pub(crate) const MAX_STILL: usize = 5 * 1024 * 1024;

/// The raster type of an image from its first bytes: JPEG, PNG or WebP. Printers' own content
/// type headers are not trusted (some cameras send `application/octet-stream`).
pub(crate) fn sniff_image(data: &[u8]) -> Option<&'static str> {
    match data {
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("image/png"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// One still from a printer's camera.
#[derive(Debug, Clone)]
pub(crate) struct Still {
    pub content_type: String,
    pub data: Vec<u8>,
    pub captured_at_ms: u64,
    /// `snapshot` (the printer's own still) or `stream` (the first JPEG frame of the live video).
    pub source: &'static str,
}

impl Still {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "contentType": self.content_type,
            "dataBase64": B64.encode(&self.data),
            "capturedAt": iso(self.captured_at_ms),
            "source": self.source,
        })
    }
}

/// Takes one still: the printer's snapshot when it has one, else the first JPEG frame of its live
/// stream, else the first H.264 key frame decoded to JPEG (Bambu Lab X1 and H2). `None` when the
/// printer has no camera.
pub(crate) async fn grab(b: &Arc<Bridge>, printer: &str) -> Rpc<Option<Still>> {
    let snap = async {
        session(b, printer)
            .await?
            .snapshot()
            .await
            .map_err(RpcError::from)
    };
    match tokio::time::timeout(SNAPSHOT_WAIT, snap).await {
        Ok(Ok(Some(img))) if img.data.len() <= MAX_STILL && sniff_image(&img.data).is_some() => {
            return Ok(Some(Still {
                content_type: sniff_image(&img.data).unwrap_or("image/jpeg").to_owned(),
                data: img.data,
                captured_at_ms: now_ms(),
                source: "snapshot",
            }));
        }
        // A missing printer is an error; anything else falls through to the stream.
        Ok(Err(e)) if e.code == "not_found" => return Err(e),
        _ => {}
    }
    still_from_stream(b, printer).await
}

/// A still from the camera's video: its first JPEG, or its first H.264 key frame decoded.
async fn still_from_stream(b: &Arc<Bridge>, printer: &str) -> Rpc<Option<Still>> {
    let mut src = match camera_source(b, printer, "still").await {
        Ok(s) => s,
        Err(e) if e.code == "not_supported" => return Ok(None),
        Err(e) => return Err(e),
    };
    // The first frame that is a picture on its own: a JPEG, or an H.264 key frame (the feed's last
    // one at once when a live view has the camera open). Then the reader lets go, so the camera
    // connection closes unless someone else is watching.
    let end = tokio::time::Instant::now() + STREAM_WAIT;
    let mut saw_video = false;
    let mut picture = None;
    while let Ok(Some(f)) = tokio::time::timeout_at(end, src.next()).await {
        match f.kind {
            FrameKind::Jpeg if f.data.len() <= MAX_STILL && sniff_image(&f.data) == Some("image/jpeg") => {
                picture = Some(f);
                break;
            }
            FrameKind::Jpeg => {}
            FrameKind::H264 => {
                saw_video = true;
                if f.key {
                    picture = Some(f);
                    break;
                }
            }
        }
    }
    drop(src);
    let still = |data: Vec<u8>| Still {
        content_type: "image/jpeg".into(),
        data,
        captured_at_ms: now_ms(),
        source: "stream",
    };
    let Some(f) = picture else {
        sx_connect::trace(printer, "still: no picture from the camera in 8 s");
        return Err(if saw_video {
            RpcError::new(
                "not_supported",
                "this camera's video did not give a picture in time",
            )
        } else {
            RpcError::new("unreachable", "the camera sent no picture in time")
        });
    };
    if f.kind == FrameKind::Jpeg {
        return Ok(Some(still(f.data)));
    }
    // A key frame (with its SPS and PPS) decodes on its own.
    let codecs = crate::h264::codec_dir(b.hub.dir.as_ref().map(crate::hub::StateDir::path));
    if !crate::h264::ensure_codec(codecs.as_deref()).await {
        sx_connect::trace(printer, "still: no H.264 decoder here");
        return Err(RpcError::new(
            "not_supported",
            "no decoder for this camera's video here",
        ));
    }
    let started = std::time::Instant::now();
    let size = f.data.len();
    let unit = f.data;
    let jpeg =
        tokio::task::spawn_blocking(move || crate::h264::still_from_key_frame(&unit, codecs.as_deref()))
            .await
            .ok()
            .flatten()
            .filter(|j| j.len() <= MAX_STILL);
    let ms = started.elapsed().as_millis();
    let Some(data) = jpeg else {
        sx_connect::trace(
            printer,
            format_args!("still: key frame of {size} bytes did not decode ({ms} ms)"),
        );
        return Err(RpcError::new(
            "not_supported",
            "this camera's video did not give a picture",
        ));
    };
    sx_connect::trace(
        printer,
        format_args!(
            "still: key frame of {size} bytes decoded in {ms} ms, JPEG of {} bytes",
            data.len()
        ),
    );
    Ok(Some(still(data)))
}

/// `snapshot {printerId}`: the same still as `camera.grab`, in the older reply shape
/// `{contentType, dataBase64}` (plus `capturedAt` and `source`). Always JPEG, PNG or WebP.
pub(crate) async fn snapshot_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    grab_call(b, p).await
}

/// `camera.grab {printerId}`: one still, or null when the printer has no camera.
pub(crate) async fn grab_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    Ok(grab(b, &printer).await?.map_or(Value::Null, |s| s.to_json()))
}

// ---- failure detectors ----

/// How often a detector may ask for frames, in ms.
pub(crate) const MIN_EVERY_MS: u64 = 2_000;
pub(crate) const MAX_EVERY_MS: u64 = 120_000;
/// A finding at or above this confidence pauses the print when the person turned that on.
pub(crate) const WATCH_PAUSE_AT: f64 = 0.8;
/// At most one alert per printer in this time, however many findings come in.
const ALERT_EVERY_MS: u64 = 5 * 60 * 1000;

/// The frame feed for one detector subscription: while a printer prints, one still every `every`,
/// sent to this connection as `watch.frame`. Ends when the connection goes.
pub(crate) async fn feed(
    b: Arc<Bridge>,
    subscription: u64,
    every: Duration,
    only: Option<Vec<String>>,
    tx: tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
) {
    /// Removes the subscription from the hub's watch state when the feed ends or is aborted.
    struct Registered<'a>(&'a Bridge, u64);
    impl Drop for Registered<'_> {
        fn drop(&mut self) {
            self.0.hub.remove_watcher(self.1);
        }
    }
    let _registered = Registered(&b, b.hub.add_watcher(only.clone()));
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let ids: Vec<String> = b.printers.lock().await.keys().cloned().collect();
        for id in ids {
            if only.as_ref().is_some_and(|o| !o.contains(&id)) {
                continue;
            }
            if b.hub.state_of(&id) != Some(sx_connect::PrinterState::Printing) {
                continue;
            }
            let Ok(Some(still)) = grab(&b, &id).await else {
                continue;
            };
            let mut ev = still.to_json();
            if let Some(o) = ev.as_object_mut() {
                o.insert("subscription".into(), json!(subscription));
                o.insert("printerId".into(), json!(id));
                // What the detector needs to judge the frame without asking for status.
                if let Some((state, layer, layer_count)) = b.hub.observed(&id) {
                    o.insert("state".into(), serde_json::to_value(state).unwrap_or(Value::Null));
                    o.insert("layer".into(), json!(layer));
                    o.insert("layerCount".into(), json!(layer_count));
                }
            }
            let msg = json!({ "event": "watch.frame", "data": ev }).to_string();
            if tx
                .send(tokio_tungstenite::tungstenite::Message::text(msg))
                .is_err()
            {
                return;
            }
        }
    }
}

/// `watch.subscribe {everyMs?, printerIds?}` parameters.
pub(crate) fn subscribe_args(p: &Value) -> Rpc<(Duration, Option<Vec<String>>)> {
    let every = p
        .get("everyMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
        .clamp(MIN_EVERY_MS, MAX_EVERY_MS);
    let only = match p.get("printerIds") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            serde_json::from_value::<Vec<String>>(v.clone())
                .map_err(|_| RpcError::new("bad_request", "printerIds is malformed"))?,
        ),
    };
    Ok((Duration::from_millis(every), only))
}

/// `watch.report {printerId, kind, confidence, note?}`: a detector saw something. The hub tells the
/// app (`watch.finding`), alerts the phones (content-free push), and pauses the print when the
/// person turned on `watchAutoPause` and the confidence is at least `WATCH_PAUSE_AT`.
pub(crate) async fn report(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    if !b.has_printer(&printer).await {
        return Err(RpcError::new("not_found", format!("no printer {printer}")));
    }
    let kind = str_arg(p, "kind")?;
    if !matches!(
        kind.as_str(),
        "spaghetti" | "first_layer" | "detached" | "nozzle_blob" | "other"
    ) {
        return Err(RpcError::new(
            "bad_request",
            "kind is spaghetti, first_layer, detached, nozzle_blob or other",
        ));
    }
    let confidence = p
        .get("confidence")
        .and_then(Value::as_f64)
        .filter(|c| (0.0..=1.0).contains(c))
        .ok_or_else(|| RpcError::new("bad_request", "confidence is 0 to 1"))?;
    // huginn, the detector's second look, agreed. Only a confirmed finding may pause (owner's rule);
    // an unconfirmed one notifies.
    let confirmed = match p.get("confirmed") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(c)) => *c,
        Some(_) => return Err(RpcError::new("bad_request", "confirmed is true or false")),
    };
    let note: Option<String> = p
        .get("note")
        .and_then(Value::as_str)
        .map(|n| n.chars().take(300).collect());
    let now = now_ms();
    let mut finding = serde_json::Map::new();
    finding.insert("printerId".into(), json!(printer));
    finding.insert("kind".into(), json!(kind));
    finding.insert("confidence".into(), json!(confidence));
    finding.insert("confirmed".into(), json!(confirmed));
    finding.insert("at".into(), json!(iso(now)));
    if let Some(n) = &note {
        finding.insert("note".into(), json!(n));
    }
    b.hub.emit("watch.finding", Value::Object(finding));
    b.hub.note_finding(&printer, now);
    if b.hub.finding_alert_due(&printer, now, ALERT_EVERY_MS) {
        b.hub.emit(
            "alert",
            json!({ "printerId": printer, "kind": "watch", "at": iso(now) }),
        );
        crate::push::alert(b, "watch", Some(&printer), None);
    }
    let printing = b.hub.state_of(&printer) == Some(sx_connect::PrinterState::Printing);
    let auto = crate::hub::lock(&b.hub.settings)
        .watch_auto_pause_printers
        .iter()
        .any(|p| p == &printer);
    let mut paused = false;
    if auto && printing && confirmed && confidence >= WATCH_PAUSE_AT {
        paused = auto_pause(b, &printer, &kind).await.is_ok();
    }
    Ok(json!({ "recorded": true, "paused": paused, "confirmed": confirmed }))
}

/// Pauses under a token the hub mints for the watch (origin `watch`, a pause and nothing else).
async fn auto_pause(b: &Arc<Bridge>, printer: &str, kind: &str) -> Rpc<()> {
    let broker = b
        .broker
        .as_ref()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    let title = format!("Pause {printer}: the print watch saw {kind}");
    let req = crate::hub::internal_request(
        sx_permit::StartOrigin::Watch,
        printer,
        "printer.pause",
        &json!({ "printerId": printer }),
        &title,
    );
    let t = broker
        .mint(req, false)
        .map_err(|e| RpcError::new("approval_invalid", e.to_string()))?;
    let token = sx_connect::ApprovalToken {
        request_id: t.request_id,
        token: t.token,
        expires_at: t.expires_at,
    };
    session(b, printer).await?.pause(&token).await?;
    b.hub.audit(json!({ "origin": "watch", "action": "printer.pause", "printerId": printer, "requestId": token.request_id, "finding": kind }));
    crate::hub::lock(&b.hub.auto_paused).insert(
        printer.to_owned(),
        crate::hub::AutoPaused {
            at_ms: now_ms(),
            ..crate::hub::AutoPaused::default()
        },
    );
    b.hub.emit(
        "alert",
        json!({ "printerId": printer, "kind": "paused", "at": iso(now_ms()), "by": "watch" }),
    );
    Ok(())
}

/// `watch.autoPause {printerId, enabled}`: the person's standing permission for the watch to pause
/// this printer on a failure. App only. Recorded in the audit log.
pub(crate) async fn auto_pause_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    if !b.has_printer(&printer).await {
        return Err(RpcError::new("not_found", format!("no printer {printer}")));
    }
    let enabled = p
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::new("bad_request", "enabled is true or false"))?;
    {
        let mut s = crate::hub::lock(&b.hub.settings);
        s.watch_auto_pause_printers.retain(|x| x != &printer);
        if enabled {
            s.watch_auto_pause_printers.push(printer.clone());
        }
    }
    b.hub.audit(json!({ "origin": "local_click", "action": "watch.autoPause", "printerId": printer, "enabled": enabled }));
    crate::hub_rpc::save(b).await;
    Ok(json!({ "printerId": printer, "enabled": enabled }))
}

/// `watch.huginn {printerId, enabled}` (app only, audited): whether huginn double-checks findings
/// on this printer. Without it no finding is confirmed, so the watch never pauses that printer.
pub(crate) async fn huginn_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    if !b.has_printer(&printer).await {
        return Err(RpcError::new("not_found", format!("no printer {printer}")));
    }
    let enabled = p
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::new("bad_request", "enabled is true or false"))?;
    {
        let mut s = crate::hub::lock(&b.hub.settings);
        s.watch_huginn_printers.retain(|x| x != &printer);
        if enabled {
            s.watch_huginn_printers.push(printer.clone());
        }
    }
    b.hub.audit(json!({ "origin": "local_click", "action": "watch.huginn", "printerId": printer, "enabled": enabled }));
    crate::hub_rpc::save(b).await;
    Ok(json!({ "printerId": printer, "enabled": enabled }))
}

/// `watch.huginnPrinters`: the printers huginn checks, for detectors.
pub(crate) fn huginn_printers(b: &Bridge) -> Value {
    json!(crate::hub::lock(&b.hub.settings).watch_huginn_printers)
}

// ---- bed masks, "this is fine", and heaters after an unanswered pause ----

/// `watch.mask {printerId, polygon}` (app only): the bed area the detector looks at, as 3 to 64
/// points in 0 to 1 frame coordinates. `polygon: null` removes it.
pub(crate) async fn mask_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    if !b.has_printer(&printer).await {
        return Err(RpcError::new("not_found", format!("no printer {printer}")));
    }
    let polygon: Option<Vec<[f64; 2]>> = match p.get("polygon") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            serde_json::from_value(v.clone())
                .map_err(|_| RpcError::new("bad_request", "polygon is a list of [x, y] points"))?,
        ),
    };
    if let Some(poly) = &polygon
        && (!(3..=64).contains(&poly.len()) || poly.iter().flatten().any(|c| !(0.0..=1.0).contains(c)))
    {
        return Err(RpcError::new(
            "bad_request",
            "polygon has 3 to 64 points with coordinates from 0 to 1",
        ));
    }
    {
        let mut s = crate::hub::lock(&b.hub.settings);
        match &polygon {
            Some(poly) => s.watch_masks.insert(printer.clone(), poly.clone()),
            None => s.watch_masks.remove(&printer),
        };
    }
    crate::hub_rpc::save(b).await;
    Ok(json!({ "printerId": printer, "polygon": polygon }))
}

/// `watch.masks`: every printer's bed mask, for the detector.
pub(crate) fn masks_call(b: &Bridge) -> Value {
    serde_json::to_value(&crate::hub::lock(&b.hub.settings).watch_masks).unwrap_or(Value::Null)
}

/// `watch.dismiss {printerId, kind}` (app only): the person answered "this is fine". The hub tells
/// detectors (`watch.dismissed`), ends the attention state and logs it.
pub(crate) fn dismiss_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    let kind = str_arg(p, "kind")?;
    let at = iso(now_ms());
    b.hub.clear_finding(&printer);
    b.hub.audit(
        json!({ "origin": "local_click", "action": "watch.dismiss", "printerId": printer, "kind": kind }),
    );
    b.hub.emit(
        "watch.dismissed",
        json!({ "printerId": printer, "kind": kind, "at": at }),
    );
    Ok(json!({ "dismissed": true }))
}

/// One round of the heater steps after a watch pause nobody answered: bed off (nozzle held) after
/// the first limit, both heaters off after the second. A printer that left the paused state was
/// answered and is forgotten. Each step is in the audit log with origin `watch`.
pub(crate) async fn heater_steps(b: &Arc<Bridge>) {
    let (bed_after, all_after) = b.hub.pause_steps;
    let now = now_ms();
    let waiting: Vec<(String, crate::hub::AutoPaused)> = crate::hub::lock(&b.hub.auto_paused)
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    for (printer, rec) in waiting {
        if b.hub.state_of(&printer) != Some(sx_connect::PrinterState::Paused) {
            crate::hub::lock(&b.hub.auto_paused).remove(&printer);
            continue;
        }
        let elapsed = Duration::from_millis(now.saturating_sub(rec.at_ms));
        let step = if !rec.bed_off && elapsed >= bed_after {
            Some(("bed_off", sx_connect::Adjustment::Bed { celsius: 0 }))
        } else if rec.bed_off && !rec.all_off && elapsed >= all_after {
            Some(("heaters_off", sx_connect::Adjustment::Nozzle { celsius: 0 }))
        } else {
            None
        };
        let Some((name, change)) = step else { continue };
        let out = heater_off(b, &printer, &change).await;
        b.hub.audit(json!({
            "origin": "watch", "action": "printer.adjust", "step": name, "printerId": printer,
            "ok": out.is_ok(), "error": out.as_ref().err().map(|e| e.message.clone()),
        }));
        if let Some(r) = crate::hub::lock(&b.hub.auto_paused).get_mut(&printer) {
            if name == "bed_off" {
                r.bed_off = true;
            } else {
                r.all_off = true;
            }
        }
    }
}

/// Adds `pauseNote` to a status object (`status` call, printer events): a paused print with a heater
/// on, on a printer whose firmware does not turn heaters off by itself while paused (`keeps_heat`).
/// The hub sends nothing for a person's pause; it says so in plain words instead.
pub(crate) fn note_paused_heat(
    b: &Bridge,
    printer: &str,
    keeps_heat: bool,
    st: &mut serde_json::Map<String, Value>,
) {
    let watch_paused = crate::hub::lock(&b.hub.auto_paused).contains_key(printer);
    if let Some(note) = pause_note(keeps_heat, watch_paused, b.hub.pause_steps, st) {
        st.insert("pauseNote".into(), json!(note));
    }
}

fn pause_note(
    keeps_heat: bool,
    watch_paused: bool,
    steps: (Duration, Duration),
    st: &serde_json::Map<String, Value>,
) -> Option<String> {
    if !keeps_heat || st.get("state").and_then(Value::as_str) != Some("paused") {
        return None;
    }
    let target = |t: &Value| t.get("target").and_then(Value::as_f64).unwrap_or(0.0) > 0.0;
    let nozzle_on = st
        .get("nozzles")
        .and_then(Value::as_array)
        .is_some_and(|n| n.iter().any(target));
    let bed_on = st.get("bed").is_some_and(target);
    if !nozzle_on && !bed_on {
        return None;
    }
    Some(if watch_paused {
        format!(
            "Paused with the heaters on. This printer does not turn them off by itself while paused. If nobody answers, SlicerX turns the bed off {} after the pause and the nozzle {} after it.",
            span_words(steps.0),
            span_words(steps.1)
        )
    } else {
        "Paused with the heaters on. This printer does not turn them off by itself while paused, so resume or cancel the print when you can.".to_owned()
    })
}

fn span_words(d: Duration) -> String {
    let s = d.as_secs();
    let unit = |n: u64, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    if s >= 3600 && s.is_multiple_of(3600) {
        unit(s / 3600, "hour")
    } else if s >= 60 {
        unit(s / 60, "minute")
    } else {
        unit(s, "second")
    }
}

/// Turns one heater off under a token the hub mints for the watch. Heaters off is the safe
/// direction, so it skips the mid-print limits a person's change goes through.
async fn heater_off(b: &Arc<Bridge>, printer: &str, change: &sx_connect::Adjustment) -> Rpc<()> {
    let broker = b
        .broker
        .as_ref()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    let params: Value =
        serde_json::from_str(&sx_connect::params::adjust(printer, change)).unwrap_or(Value::Null);
    let req = crate::hub::internal_request(
        sx_permit::StartOrigin::Watch,
        printer,
        "printer.adjust",
        &params,
        "Heater off after an unanswered watch pause",
    );
    let t = broker
        .mint(req, false)
        .map_err(|e| RpcError::new("approval_invalid", e.to_string()))?;
    let token = sx_connect::ApprovalToken {
        request_id: t.request_id,
        token: t.token,
        expires_at: t.expires_at,
    };
    session(b, printer).await?.adjust(change, &token).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{pause_note, sniff_image};
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn a_paused_print_with_heat_on_gets_a_note_only_where_the_firmware_keeps_it_on() {
        let steps = (Duration::from_mins(30), Duration::from_hours(2));
        let paused = json!({ "state": "paused", "nozzles": [{ "current": 215.0, "target": 215.0 }], "bed": { "current": 60.0, "target": 60.0 } });
        let st = paused.as_object().unwrap();
        // A person's pause on a printer with no idle timeout: a note, and no step of its own.
        let note = pause_note(true, false, steps, st).unwrap();
        assert!(note.starts_with("Paused with the heaters on."), "{note}");
        assert!(!note.contains("SlicerX turns"), "{note}");
        // The watch's own pause: the note names the hub's existing steps.
        let note = pause_note(true, true, steps, st).unwrap();
        assert!(
            note.contains("bed off 30 minutes after the pause and the nozzle 2 hours after"),
            "{note}"
        );
        // Firmware that turns heaters off itself (Klipper idle_timeout, Prusa): nothing to say.
        assert_eq!(pause_note(false, false, steps, st), None);
        // Heaters already off, or not paused: nothing to say.
        let cold = json!({ "state": "paused", "nozzles": [{ "current": 40.0, "target": 0.0 }], "bed": { "current": 30.0, "target": 0.0 } });
        assert_eq!(pause_note(true, false, steps, cold.as_object().unwrap()), None);
        let printing = json!({ "state": "printing", "nozzles": [{ "current": 215.0, "target": 215.0 }] });
        assert_eq!(
            pause_note(true, false, steps, printing.as_object().unwrap()),
            None
        );
    }

    #[test]
    fn only_raster_stills_pass() {
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff_image(b""), None);
    }
}
