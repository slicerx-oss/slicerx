// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The camera guard, huginn's job beside the print watch: a hand inside a printing printer pauses
//! it, and the plate is checked for anything left on it before a print starts.
//!
//! A hand comes in as a `watch.report` of kind `hand`. Unlike a failure it pauses without huginn's
//! confirmation and without the auto-pause permission, on every printer the guard is on for (on
//! unless the person turned it off): the detector already needed two sightings, and a wrong pause
//! costs one press of Resume (reasons in packages/watch/src/policy.rs).
//!
//! The plate check compares a still of the plate with the person's empty-plate picture ("This plate
//! is clear"). The hub sends both to the detector (`watch.plate`) and waits for its answer
//! (`watch.plateResult`). A start the hub makes waits for it and is refused with `plate_check`
//! when something is found, unless the caller says `plateOk`. A print the printer started on its own
//! (its screen, Bambu Connect) is checked when the hub first sees it running and paused when
//! something is found. A printer that takes no commands (Bambu Lab with Developer Mode off) is
//! never paused: the guard alerts instead. Without a detector connected nothing is checked and
//! nothing is blocked.
//!
//! Every trip is a `watch.guard` event for the app (the printer card comes up with the frame), a
//! phone alert, and an audit line. The frame stays on the hub; the app reads it with
//! `watch.evidence`.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

use crate::hub::{iso, lock, now_ms, random_hex};
use crate::rpc::{Bridge, Rpc, RpcError, session, str_arg};
use crate::watch::{Still, sniff_image};

/// How long a start waits for the detector's answer about the plate.
const PLATE_WAIT: Duration = Duration::from_secs(8);
/// A detector's second look at a possible hand at most this often per printer, ms.
const GRAB_EVERY_MS: u64 = 1_200;
/// Spots per printer the person said are fine.
const MAX_IGNORED: usize = 32;

/// The guard's memory, beside the hub's.
#[derive(Default)]
pub(crate) struct GuardState {
    /// The last still each printer's detector was given, the evidence for a hand.
    last_still: std::sync::Mutex<HashMap<String, Still>>,
    /// The frame behind each printer's current trip.
    evidence: std::sync::Mutex<HashMap<String, Still>>,
    /// Each printer's current trip, as sent in `watch.guard`.
    trips: std::sync::Mutex<HashMap<String, Value>>,
    /// Empty-plate pictures read so far (the files are in the state directory).
    plates: std::sync::Mutex<HashMap<String, Still>>,
    /// Plate checks waiting for the detector, by check id.
    waits: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    /// When each printer last gave a detector a second look.
    grabbed: std::sync::Mutex<HashMap<String, u64>>,
}

/// Whether the guard watches this printer (on unless the person turned it off).
pub(crate) fn on(b: &Bridge, printer: &str) -> bool {
    !lock(&b.hub.settings).watch_guard_off.iter().any(|p| p == printer)
}

/// Remembers the still a detector was just given.
pub(crate) fn note_still(b: &Bridge, printer: &str, still: &Still) {
    lock(&b.hub.guard.last_still).insert(printer.to_owned(), still.clone());
}

fn plate_file(b: &Bridge, printer: &str) -> Option<std::path::PathBuf> {
    let hex: String = printer.bytes().fold(String::new(), |mut s, c| {
        use std::fmt::Write as _;
        let _ = write!(s, "{c:02x}");
        s
    });
    Some(
        b.hub
            .dir
            .as_ref()?
            .path()
            .join("plates")
            .join(format!("{hex}.img")),
    )
}

/// The person's empty-plate picture for a printer, if they took one.
fn plate(b: &Bridge, printer: &str) -> Option<Still> {
    if let Some(s) = lock(&b.hub.guard.plates).get(printer) {
        return Some(s.clone());
    }
    let at = lock(&b.hub.settings).watch_plates.get(printer).copied()?;
    let data = std::fs::read(plate_file(b, printer)?).ok()?;
    let still = Still {
        content_type: sniff_image(&data)?.to_owned(),
        data,
        captured_at_ms: at,
        source: "snapshot",
    };
    lock(&b.hub.guard.plates).insert(printer.to_owned(), still.clone());
    Some(still)
}

fn set_plate(b: &Bridge, printer: &str, still: Option<Still>) -> Rpc<()> {
    if let Some(path) = plate_file(b, printer) {
        match &still {
            Some(s) => {
                if let Some(dir) = path.parent() {
                    sx_connect::create_private_dir(dir)
                        .map_err(|e| RpcError::new("internal", e.to_string()))?;
                }
                sx_connect::write_private(&path, &s.data)
                    .map_err(|e| RpcError::new("internal", e.to_string()))?;
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    let mut settings = lock(&b.hub.settings);
    match &still {
        Some(s) => {
            settings.watch_plates.insert(printer.to_owned(), s.captured_at_ms);
            // A new empty plate: the spots marked on the old picture no longer apply, and the
            // picture is what holds a start from now on.
            settings.watch_plate_ignore.remove(printer);
            settings.watch_plate_model_off.retain(|x| x != printer);
        }
        None => {
            settings.watch_plates.remove(printer);
        }
    }
    drop(settings);
    let mut plates = lock(&b.hub.guard.plates);
    match still {
        Some(s) => plates.insert(printer.to_owned(), s),
        None => plates.remove(printer),
    };
    Ok(())
}

fn picture(s: &Still) -> Value {
    json!({ "contentType": s.content_type, "dataBase64": B64.encode(&s.data) })
}

/// Records a trip, tells the app and the phones, and logs it.
fn trip(b: &Bridge, printer: &str, mut event: serde_json::Map<String, Value>, evidence: Option<Still>) {
    event.insert("printerId".into(), json!(printer));
    event.insert("at".into(), json!(iso(now_ms())));
    event.insert("answered".into(), json!(false));
    event.insert("trippedMs".into(), json!(now_ms()));
    if let Some(s) = evidence {
        event.insert("capturedAt".into(), json!(iso(s.captured_at_ms)));
        lock(&b.hub.guard.evidence).insert(printer.to_owned(), s);
    }
    let event = Value::Object(event);
    let kind = event.get("kind").cloned().unwrap_or(Value::Null);
    let state = event.get("state").cloned().unwrap_or(Value::Null);
    b.hub.audit(
        json!({ "origin": "watch", "action": "guard", "printerId": printer, "kind": kind, "state": state }),
    );
    lock(&b.hub.guard.trips).insert(printer.to_owned(), event.clone());
    b.hub.emit("watch.guard", event);
    crate::push::alert(b, "watch", Some(printer), None);
}

/// Ends a printer's trip (dismissed, resumed by the person, a clear plate).
pub(crate) fn clear(b: &Bridge, printer: &str) {
    let had = lock(&b.hub.guard.trips).remove(printer).is_some();
    lock(&b.hub.guard.evidence).remove(printer);
    if had {
        b.hub.emit(
            "watch.guard",
            json!({ "printerId": printer, "state": "clear", "at": iso(now_ms()) }),
        );
    }
}

/// How long a paused card waits for the printer to report the pause before a running reading
/// ends it anyway (a pause and a resume both within one status poll).
const PAUSE_SEEN_MS: u64 = 20_000;

/// A status reading. A card for a print the guard paused ends only when the printer leaves the
/// paused state after the hub saw it paused (resumed by a person, or ended), never on an answer.
pub(crate) fn observed(
    b: &Bridge,
    printer: &str,
    prev: Option<sx_connect::PrinterState>,
    now: sx_connect::PrinterState,
) {
    use sx_connect::PrinterState::{Offline, Paused};
    let end = {
        let mut trips = lock(&b.hub.guard.trips);
        let Some(t) = trips.get_mut(printer) else { return };
        if t.get("state").and_then(Value::as_str) != Some("paused") {
            // Any other card for a print that was running ends with it.
            prev == Some(Paused) && now != Paused
        } else if now == Paused {
            if let Some(o) = t.as_object_mut() {
                o.insert("pauseSeen".into(), json!(true));
            }
            false
        } else if now == Offline {
            false
        } else {
            let seen = t.get("pauseSeen").and_then(Value::as_bool) == Some(true);
            let since = t.get("trippedMs").and_then(Value::as_u64).unwrap_or(0);
            seen || now_ms().saturating_sub(since) > PAUSE_SEEN_MS
        }
    };
    if end {
        clear(b, printer);
    }
}

/// The person answered a trip (dismissed it, the plate checked clean, a spot marked fine). A print
/// the guard paused stays paused: the card stays, marked answered, with Resume, until a person
/// resumes it (a physical machine never starts moving again on its own). Any other trip ends.
/// `by` says how, for the card's words: `dismissed`, `clear` (a new look found nothing), `fine` (a
/// spot marked as a plate mark) or `off` (the guard turned off). A clean look drops the spot.
pub(crate) fn answer(b: &Bridge, printer: &str, by: &str) {
    let updated = {
        let mut trips = lock(&b.hub.guard.trips);
        match trips.get_mut(printer) {
            Some(t) if t.get("state").and_then(Value::as_str) == Some("paused") => {
                if let Some(o) = t.as_object_mut() {
                    o.insert("answered".into(), json!(true));
                    o.insert("answeredBy".into(), json!(by));
                    o.insert("at".into(), json!(iso(now_ms())));
                    if by == "clear" {
                        o.remove("box");
                    }
                }
                Some(t.clone())
            }
            _ => None,
        }
    };
    match updated {
        Some(t) => b.hub.emit("watch.guard", t),
        None => clear(b, printer),
    }
}

/// True when the printer reports it takes no commands from other apps.
async fn monitor_only(b: &Arc<Bridge>, printer: &str) -> bool {
    crate::hub_rpc::observe(b, printer)
        .await
        .and_then(|st| st.live.and_then(|l| l.monitor_only))
        == Some(true)
}

/// Pauses for the guard, or says why it could not.
async fn stop(b: &Arc<Bridge>, printer: &str, kind: &str) -> (&'static str, bool) {
    if monitor_only(b, printer).await {
        return ("alert", true);
    }
    match crate::watch::auto_pause(b, printer, kind).await {
        Ok(()) => ("paused", false),
        Err(e) if e.code == "refused" => ("alert", true),
        Err(_) => ("alert", false),
    }
}

/// A detector saw a hand. Pauses when the printer prints and the guard is on; returns whether
/// it paused.
pub(crate) async fn hand(
    b: &Arc<Bridge>,
    printer: &str,
    confidence: f64,
    bbox: Option<[f64; 4]>,
    note: Option<&str>,
) -> bool {
    let printing = b.hub.state_of(printer) == Some(sx_connect::PrinterState::Printing);
    if !printing || !on(b, printer) {
        return false;
    }
    let (state, monitor) = stop(b, printer, "hand").await;
    let mut ev = serde_json::Map::new();
    ev.insert("kind".into(), json!("hand"));
    ev.insert("state".into(), json!(state));
    ev.insert("confidence".into(), json!(confidence));
    ev.insert("monitorOnly".into(), json!(monitor));
    if let Some(bx) = bbox {
        ev.insert("box".into(), json!(bx));
    }
    if let Some(n) = note {
        ev.insert("note".into(), json!(n));
    }
    let evidence = lock(&b.hub.guard.last_still).get(printer).cloned();
    trip(b, printer, ev, evidence);
    state == "paused"
}

/// What the detector said about the plate.
struct Plate {
    clear: Option<bool>,
    bbox: Option<[f64; 4]>,
    note: String,
    still: Still,
}

/// Checks the plate now. `None` when there is no detector or no picture.
async fn check_plate(b: &Arc<Bridge>, printer: &str) -> Option<Plate> {
    if !b.hub.has_watchers() {
        return None;
    }
    let still = crate::watch::grab(b, printer).await.ok().flatten()?;
    let id = random_hex(8);
    let (tx, rx) = tokio::sync::oneshot::channel();
    lock(&b.hub.guard.waits).insert(id.clone(), tx);
    let ignore = lock(&b.hub.settings)
        .watch_plate_ignore
        .get(printer)
        .cloned()
        .unwrap_or_default();
    let reference = plate(b, printer).map(|s| picture(&s));
    let has_reference = reference.is_some();
    b.hub.emit(
        "watch.plate",
        json!({ "checkId": id, "printerId": printer, "frame": picture(&still), "reference": reference, "ignore": ignore }),
    );
    let reply = tokio::time::timeout(PLATE_WAIT, rx).await;
    lock(&b.hub.guard.waits).remove(&id);
    let answer = reply.ok()?.ok()?;
    let bbox: Option<[f64; 4]> =
        serde_json::from_value(answer.get("box").cloned().unwrap_or(Value::Null)).ok();
    // The person said a finding of the model alone was wrong on this printer; only a picture
    // comparison holds it from now on.
    let model_only = bbox.is_none() && !has_reference;
    let overruled = model_only
        && lock(&b.hub.settings)
            .watch_plate_model_off
            .iter()
            .any(|x| x == printer);
    Some(Plate {
        clear: if overruled {
            Some(true)
        } else {
            answer.get("clear").and_then(Value::as_bool)
        },
        bbox,
        note: answer
            .get("note")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect(),
        still,
    })
}

fn plate_event(
    b: &Bridge,
    printer: &str,
    p: &Plate,
    state: &str,
    started_by: &str,
) -> serde_json::Map<String, Value> {
    let mut ev = serde_json::Map::new();
    ev.insert("kind".into(), json!("plate"));
    ev.insert("state".into(), json!(state));
    ev.insert("startedBy".into(), json!(started_by));
    ev.insert("note".into(), json!(p.note));
    if let Some(bx) = p.bbox {
        ev.insert("box".into(), json!(bx));
    }
    if let Some(at) = lock(&b.hub.settings).watch_plates.get(printer) {
        ev.insert("plateFrom".into(), json!(iso(*at)));
    }
    ev
}

/// The plate check before the hub starts a print. `plate_ok` is the person's "start anyway".
pub(crate) async fn before_start(b: &Arc<Bridge>, printer: &str, plate_ok: bool) -> Rpc<()> {
    if plate_ok || !on(b, printer) {
        return Ok(());
    }
    let Some(p) = check_plate(b, printer).await else {
        return Ok(());
    };
    if p.clear != Some(false) {
        clear(b, printer);
        return Ok(());
    }
    let ev = plate_event(b, printer, &p, "blocked", "slicerx");
    trip(b, printer, ev, Some(p.still));
    Err(RpcError::new(
        "plate_check",
        "Something is on the build plate. Look at the camera picture on the Printers tab, clear the plate, or start anyway.",
    ))
}

/// A printer started a print on its own (its screen, Bambu Connect, a phone app): check the
/// plate and pause when something is on it.
pub(crate) async fn job_began(b: Arc<Bridge>, printer: String) {
    if !on(&b, &printer) {
        return;
    }
    let Some(p) = check_plate(&b, &printer).await else {
        return;
    };
    if p.clear != Some(false) {
        return;
    }
    let (state, monitor) = stop(&b, &printer, "plate").await;
    let mut ev = plate_event(&b, &printer, &p, state, "printer");
    ev.insert("monitorOnly".into(), json!(monitor));
    trip(&b, &printer, ev, Some(p.still));
}

// ---- calls ----

/// `watch.grab {printerId}` (detectors): one frame now for a second look, shaped like a
/// `watch.frame`. Only while the printer prints, and at most every 1.2 s per printer.
pub(crate) async fn grab_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = str_arg(p, "printerId")?;
    if b.hub.state_of(&printer) != Some(sx_connect::PrinterState::Printing) {
        return Err(RpcError::new("busy", "the printer is not printing"));
    }
    {
        let now = now_ms();
        let mut g = lock(&b.hub.guard.grabbed);
        if g.get(&printer)
            .is_some_and(|t| now.saturating_sub(*t) < GRAB_EVERY_MS)
        {
            return Err(RpcError::new("busy", "a second look was just taken"));
        }
        g.insert(printer.clone(), now);
    }
    let Some(still) = crate::watch::grab(b, &printer).await? else {
        return Ok(Value::Null);
    };
    note_still(b, &printer, &still);
    let mut v = still.to_json();
    if let Some(o) = v.as_object_mut() {
        o.insert("printerId".into(), json!(printer));
        if let Some((state, layer, layer_count)) = b.hub.observed(&printer) {
            o.insert("state".into(), serde_json::to_value(state).unwrap_or(Value::Null));
            o.insert("layer".into(), json!(layer));
            o.insert("layerCount".into(), json!(layer_count));
        }
    }
    Ok(v)
}

/// `watch.plateResult` and `watch.lookResult {checkId, ...}` (detectors): the answer to a
/// `watch.plate` or a `watch.look`.
pub(crate) fn plate_result_call(b: &Bridge, p: &Value) -> Rpc<Value> {
    let id = str_arg(p, "checkId")?;
    let waiting = lock(&b.hub.guard.waits).remove(&id);
    if let Some(tx) = waiting {
        let _ = tx.send(p.clone());
    }
    Ok(json!({ "recorded": true }))
}

/// Asks the detector whether a new frame still shows a hand: `Some(hand)` with the frame, or
/// `None` when no detector answered (the frame is still returned for the card).
async fn look_again(b: &Arc<Bridge>, printer: &str) -> Rpc<(Option<bool>, Option<Still>)> {
    let Some(still) = crate::watch::grab(b, printer).await? else {
        return Ok((None, None));
    };
    if !b.hub.has_watchers() {
        return Ok((None, Some(still)));
    }
    let id = random_hex(8);
    let (tx, rx) = tokio::sync::oneshot::channel();
    lock(&b.hub.guard.waits).insert(id.clone(), tx);
    b.hub.emit(
        "watch.look",
        json!({ "checkId": id, "printerId": printer, "frame": picture(&still) }),
    );
    let reply = tokio::time::timeout(PLATE_WAIT, rx).await;
    lock(&b.hub.guard.waits).remove(&id);
    let hand = reply
        .ok()
        .and_then(Result::ok)
        .and_then(|a| a.get("hand").and_then(Value::as_bool));
    Ok((hand, Some(still)))
}

/// `watch.handCheck {printerId}` (app): "Check again" on a hand card. Takes a new frame, shows it
/// on the card, and asks the detector whether the hand is still there: gone answers the card
/// (the print stays paused until a person resumes it), still there keeps it as it was.
pub(crate) async fn hand_check_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = known(b, p).await?;
    let (hand, still) = look_again(b, &printer).await?;
    if let Some(s) = still {
        let at = s.captured_at_ms;
        lock(&b.hub.guard.evidence).insert(printer.clone(), s);
        let updated = {
            let mut trips = lock(&b.hub.guard.trips);
            trips.get_mut(&printer).and_then(|t| {
                let o = t.as_object_mut()?;
                o.insert("capturedAt".into(), json!(iso(at)));
                o.insert("at".into(), json!(iso(now_ms())));
                // A frame the detector judged has no spot of its own yet.
                o.remove("box");
                Some(t.clone())
            })
        };
        if hand == Some(false) {
            answer(b, &printer, "clear");
        } else if let Some(t) = updated {
            b.hub.emit("watch.guard", t);
        }
    }
    Ok(json!({ "printerId": printer, "checked": hand.is_some(), "hand": hand }))
}

/// `watch.resume {printerId}` (app, audited): Resume on the card of a print the guard paused.
/// The click is the person's approval for that resume, as Print is for a start: the hub mints
/// its own token, for this printer and this pause only (a card in the paused state, a printer
/// that reports paused), and no second approval is asked.
pub(crate) async fn resume_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = known(b, p).await?;
    let guarded = lock(&b.hub.guard.trips)
        .get(&printer)
        .is_some_and(|t| t.get("state").and_then(Value::as_str) == Some("paused"));
    let paused = crate::hub_rpc::observe(b, &printer)
        .await
        .is_some_and(|st| st.state == sx_connect::PrinterState::Paused);
    if !guarded || !paused {
        return Err(RpcError::new(
            "not_paused",
            "The guard has no paused print on this printer. Resume it from the printer's own controls.",
        ));
    }
    let broker = b
        .broker
        .as_ref()
        .ok_or_else(|| RpcError::new("not_supported", "this bridge has no approval broker"))?;
    let req = crate::hub::internal_request(
        sx_permit::StartOrigin::LocalClick,
        &printer,
        "printer.resume",
        &json!({ "printerId": printer }),
        &format!("Resume {printer} from the guard's card"),
    );
    let t = broker
        .mint(req, false)
        .map_err(|e| RpcError::new("approval_invalid", e.to_string()))?;
    let token = sx_connect::ApprovalToken {
        request_id: t.request_id,
        token: t.token,
        expires_at: t.expires_at,
    };
    session(b, &printer).await?.resume(&token).await?;
    b.hub.audit(json!({ "origin": "local_click", "action": "printer.resume", "printerId": printer, "requestId": token.request_id, "via": "guard" }));
    Ok(json!({ "printerId": printer, "resumed": true }))
}

async fn known(b: &Arc<Bridge>, p: &Value) -> Rpc<String> {
    let printer = str_arg(p, "printerId")?;
    if !b.has_printer(&printer).await {
        return Err(RpcError::new("not_found", format!("no printer {printer}")));
    }
    Ok(printer)
}

/// `watch.plateClear {printerId}` (app): "This plate is clear". Takes a new still, after the
/// person's click, as the printer's empty plate, replacing any earlier one and the spots marked
/// on it. Only while nothing runs on the printer: a running or paused print is on the plate, and
/// the frame that tripped the guard is never kept as the empty plate.
pub(crate) async fn plate_clear_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = known(b, p).await?;
    let running = crate::hub_rpc::observe(b, &printer).await.is_some_and(|st| {
        matches!(
            st.state,
            sx_connect::PrinterState::Preparing
                | sx_connect::PrinterState::Printing
                | sx_connect::PrinterState::Paused
        )
    });
    if running {
        return Err(RpcError::new(
            "busy",
            "The empty plate can only be taken while nothing is printing. Take it once this print is off the plate.",
        ));
    }
    let still = crate::watch::grab(b, &printer)
        .await?
        .ok_or_else(|| RpcError::new("not_supported", "this printer has no camera"))?;
    let at = still.captured_at_ms;
    set_plate(b, &printer, Some(still))?;
    clear(b, &printer);
    b.hub
        .audit(json!({ "origin": "local_click", "action": "watch.plateClear", "printerId": printer }));
    crate::hub_rpc::save(b).await;
    Ok(json!({ "printerId": printer, "plateFrom": iso(at) }))
}

/// `watch.plateCheck {printerId}` (app): "Check again". Runs the plate check now; a clear plate
/// ends the trip, a plate with something on it updates the card.
pub(crate) async fn plate_check_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = known(b, p).await?;
    let Some(plate) = check_plate(b, &printer).await else {
        return Ok(json!({ "printerId": printer, "checked": false }));
    };
    let clear_now = plate.clear != Some(false);
    if clear_now {
        answer(b, &printer, "clear");
    } else {
        let was = lock(&b.hub.guard.trips).get(&printer).cloned();
        let state = was
            .as_ref()
            .and_then(|t| t.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("blocked")
            .to_owned();
        let by = was
            .as_ref()
            .and_then(|t| t.get("startedBy"))
            .and_then(Value::as_str)
            .unwrap_or("slicerx")
            .to_owned();
        let mut ev = plate_event(b, &printer, &plate, &state, &by);
        // The same trip seen again: what it was, and whether the printer was seen paused, carry over.
        for key in ["monitorOnly", "pauseSeen"] {
            if let Some(v) = was.as_ref().and_then(|t| t.get(key)) {
                ev.insert(key.into(), v.clone());
            }
        }
        trip(b, &printer, ev, Some(plate.still));
    }
    Ok(json!({ "printerId": printer, "checked": true, "clear": clear_now }))
}

/// `watch.plateIgnore {printerId}` (app): "It's fine". The spot on the card is a plate mark:
/// it is left out of later checks on this printer. A trip without a spot (no empty-plate
/// picture yet, the model alone) stops the model alone from holding this printer until an
/// empty-plate picture is taken. The frame behind the trip is never kept.
pub(crate) async fn plate_ignore_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = known(b, p).await?;
    let trip = lock(&b.hub.guard.trips).get(&printer).cloned();
    let bbox: Option<[f64; 4]> = trip
        .as_ref()
        .filter(|t| t.get("kind").and_then(Value::as_str) == Some("plate"))
        .and_then(|t| serde_json::from_value(t.get("box").cloned()?).ok());
    let remembered = if let Some(bx) = bbox {
        let mut s = lock(&b.hub.settings);
        let list = s.watch_plate_ignore.entry(printer.clone()).or_default();
        list.push(bx);
        if list.len() > MAX_IGNORED {
            list.remove(0);
        }
        "spot"
    } else {
        let mut s = lock(&b.hub.settings);
        if !s.watch_plate_model_off.contains(&printer) {
            s.watch_plate_model_off.push(printer.clone());
        }
        "model"
    };
    answer(b, &printer, "fine");
    b.hub.audit(json!({ "origin": "local_click", "action": "watch.plateIgnore", "printerId": printer, "remembered": remembered }));
    crate::hub_rpc::save(b).await;
    Ok(json!({ "printerId": printer, "remembered": remembered }))
}

/// `watch.guard {printerId, enabled}` (app, audited): whether the guard watches this printer.
pub(crate) async fn guard_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = known(b, p).await?;
    let enabled = p
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| RpcError::new("bad_request", "enabled is true or false"))?;
    {
        let mut s = lock(&b.hub.settings);
        s.watch_guard_off.retain(|x| x != &printer);
        if !enabled {
            s.watch_guard_off.push(printer.clone());
        }
    }
    if !enabled {
        answer(b, &printer, "off");
    }
    b.hub.audit(
        json!({ "origin": "local_click", "action": "watch.guard", "printerId": printer, "enabled": enabled }),
    );
    crate::hub_rpc::save(b).await;
    Ok(json!({ "printerId": printer, "enabled": enabled }))
}

/// `watch.guardState` (app): current trips, printers the guard is off for, and when each
/// printer's empty plate was taken.
pub(crate) fn guard_state_call(b: &Bridge) -> Value {
    let trips: serde_json::Map<String, Value> = lock(&b.hub.guard.trips)
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let s = lock(&b.hub.settings);
    let plates: serde_json::Map<String, Value> = s
        .watch_plates
        .iter()
        .map(|(k, v)| (k.clone(), json!(iso(*v))))
        .collect();
    json!({ "trips": trips, "off": s.watch_guard_off, "plates": plates, "detector": b.hub.has_watchers() })
}

/// `watch.evidence {printerId, fresh?}` (app): the frame behind the printer's trip. `fresh`
/// takes a new still first ("Check again" on a hand), which then becomes the evidence.
pub(crate) async fn evidence_call(b: &Arc<Bridge>, p: &Value) -> Rpc<Value> {
    let printer = known(b, p).await?;
    if p.get("fresh").and_then(Value::as_bool) == Some(true)
        && let Some(s) = crate::watch::grab(b, &printer).await?
    {
        lock(&b.hub.guard.evidence).insert(printer.clone(), s);
    }
    Ok(lock(&b.hub.guard.evidence)
        .get(&printer)
        .map_or(Value::Null, Still::to_json))
}
