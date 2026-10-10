// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The methods a paired phone or remote agent may call over the relay, in the envelope and with
//! the names of `packages/pair/src/rpc.ts`. Read: host info, printers, fleets, status, printer
//! events, stills, the relay quota. Act: pause or cancel through a card, and (phones with the
//! approve right) answer cards with a decision signed by the phone's identity key. Over the relay a
//! phone approves only pause and cancel cards; it may deny any card it sees. Starts (agent, queued
//! or scheduled), resume, raw G-code and adjustments are approved in the app or at the printer, and
//! a bed answer sent over the relay is ignored. Never remote: `print.local`, `bed.confirmClear`
//! (the person must be at the printer), resume, uploads and starts, secrets, printer setup,
//! clients and settings.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures::StreamExt;
use serde_json::{Value, json};
use sx_permit::{ApprovalAction, ApprovalRequest, PermissionClass, StartOrigin, canonical_json, hash_params};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::agent_work::Work;
use crate::hub::lock;
use crate::pair_session as ps;
use crate::remote::{PeerKind, RemotePairing};
use crate::rpc::{Bridge, RpcError};

pub(crate) type Reply = Result<Value, (&'static str, String)>;

/// Printers one session may watch at once.
const WATCHES_PER_SESSION: usize = 8;
/// A remote card waits this long for an answer.
const CARD_TTL_MS: u64 = 10 * 60 * 1000;
/// Largest still on the wire, as base64 (`MAX_FRAME_B64` in rpc.ts).
const MAX_STILL_B64: usize = 700_000;
/// A still is shared by every remote request for that printer this long, and only one fetch per
/// printer runs at a time, so remote requests cannot crowd out the camera.
const STILL_FRESH_MS: u64 = 2_000;
/// Requests one session may have running at once; more are refused with `busy`.
pub(crate) const IN_FLIGHT: usize = 4;

/// The state of one remote session: its printer watches, the jobs it asked for, and the task
/// that forwards hub events to it. Everything stops when the session ends.
pub(crate) struct SessCtx {
    pub sid: String,
    pub pairing_id: String,
    out: mpsc::UnboundedSender<(String, String)>,
    watches: StdMutex<HashMap<String, JoinHandle<()>>>,
    /// Live camera streams (the sealed 1 frame a second fallback), by stream id.
    streams: StdMutex<HashMap<u32, JoinHandle<()>>>,
    next_stream: std::sync::atomic::AtomicU32,
    /// Request id to (job id, printer id), for `job` updates.
    jobs: Arc<StdMutex<HashMap<String, (String, String)>>>,
    forwarder: StdMutex<Option<JoinHandle<()>>>,
    /// Requests running now (`IN_FLIGHT` at most).
    pub inflight: std::sync::atomic::AtomicUsize,
}

impl SessCtx {
    pub(crate) fn new(
        b: &Arc<Bridge>,
        sid: String,
        pairing: &RemotePairing,
        out: mpsc::UnboundedSender<(String, String)>,
    ) -> Arc<Self> {
        let ctx = Arc::new(Self {
            sid: sid.clone(),
            pairing_id: pairing.pairing_id.clone(),
            out: out.clone(),
            watches: StdMutex::new(HashMap::new()),
            streams: StdMutex::new(HashMap::new()),
            next_stream: std::sync::atomic::AtomicU32::new(1),
            jobs: Arc::new(StdMutex::new(HashMap::new())),
            forwarder: StdMutex::new(None),
            inflight: std::sync::atomic::AtomicUsize::new(0),
        });
        let approver = pairing.kind == PeerKind::Phone && pairing.rights.approve;
        let task = tokio::spawn(forward(b.clone(), sid, out, ctx.jobs.clone(), approver));
        *lock(&ctx.forwarder) = Some(task);
        ctx
    }

    fn emit(&self, event: &str, data: Value) {
        emit(&self.out, &self.sid, event, data);
    }

    pub(crate) fn close(&self) {
        for (_, h) in lock(&self.watches).drain() {
            h.abort();
        }
        for (_, h) in lock(&self.streams).drain() {
            h.abort();
        }
        if let Some(h) = lock(&self.forwarder).take() {
            h.abort();
        }
    }
}

impl Drop for SessCtx {
    fn drop(&mut self) {
        self.close();
    }
}

fn emit(out: &mpsc::UnboundedSender<(String, String)>, sid: &str, event: &str, data: Value) {
    let mut msg = serde_json::Map::new();
    msg.insert("t".into(), json!("ev"));
    msg.insert("ev".into(), json!(event));
    msg.insert("d".into(), data);
    let _ = out.send((sid.to_owned(), Value::Object(msg).to_string()));
}

/// Hub events a remote session cares about: new cards and answered ones (for approver phones), the
/// outcome of the pause or cancel it asked for, and the relay quota.
async fn forward(
    b: Arc<Bridge>,
    sid: String,
    out: mpsc::UnboundedSender<(String, String)>,
    jobs: Arc<StdMutex<HashMap<String, (String, String)>>>,
    approver: bool,
) {
    let mut rx = b.hub.events.subscribe();
    loop {
        let ev = match rx.recv().await {
            Ok(v) => v,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => break,
        };
        if ev.get("to").is_some() {
            continue;
        }
        let data = ev.get("data").cloned().unwrap_or(Value::Null);
        match ev.get("event").and_then(Value::as_str) {
            Some("approval") if approver => {
                if let Some(id) = data.get("id").and_then(Value::as_str)
                    && decidable(&b, id)
                    && let Some(view) = card_view(&b, id)
                {
                    emit(&out, &sid, "approval.request", view);
                }
            }
            Some("approval.resolved") if approver => {
                if let Some(r) = phone_resolved(&data) {
                    emit(&out, &sid, "approval.resolved", r);
                }
            }
            Some("remote.quota") => emit(&out, &sid, "remote.quota", data),
            Some("approval.done") => {
                let Some(rid) = data.get("requestId").and_then(Value::as_str) else {
                    continue;
                };
                let Some((job, printer)) = lock(&jobs).remove(rid) else {
                    continue;
                };
                let ok = data.get("ok").and_then(Value::as_bool) == Some(true);
                let mut update = json!({ "jobId": job, "state": if ok { "done" } else { "failed" }, "printerId": printer });
                if let (Some(m), Some(o)) = (
                    data.get("message").and_then(Value::as_str),
                    update.as_object_mut(),
                ) {
                    o.insert("message".into(), json!(m.chars().take(500).collect::<String>()));
                }
                emit(&out, &sid, "job", update);
            }
            _ => {}
        }
    }
}

/// The hub's `approval.resolved` as a phone reads it (`approval.resolved` in rpc.ts): `decision`
/// is `approve` or `deny`, `by` names who answered (a partner app's name, else `app`, `phone` or
/// `agent`, at most 64 UTF-16 units) and `via` says which kind of client it was. The phone closes
/// the card if it still shows it.
fn phone_resolved(d: &Value) -> Option<Value> {
    let id = d.get("requestId")?.as_str()?;
    let decision = match d.get("decision")?.as_str()? {
        "granted" => "approve",
        "denied" => "deny",
        _ => return None,
    };
    let via = d.get("via")?.as_str()?;
    let name = d.get("by").and_then(Value::as_str).filter(|_| via == "partner");
    let mut units = 0;
    let by: String = name
        .unwrap_or(via)
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 64
        })
        .collect();
    Some(json!({ "requestId": id, "decision": decision, "by": by, "via": via }))
}

fn err(code: &'static str, message: impl Into<String>) -> (&'static str, String) {
    (code, message.into())
}

/// Maps the hub's error codes onto the pair protocol's (`RPC_ERROR_CODES` in rpc.ts).
fn from_rpc(e: &RpcError) -> (&'static str, String) {
    let code = match e.code.as_str() {
        "bad_request" => "bad_request",
        "forbidden" => "forbidden",
        "not_found" => "not_found",
        "not_supported" => "not_supported",
        "unreachable" | "offline" | "tls" => "unavailable",
        "busy" => "busy",
        "timeout" => "timeout",
        _ => "failed",
    };
    (code, e.message.chars().take(500).collect())
}

fn printer_arg(p: &Value) -> Result<String, (&'static str, String)> {
    p.get("printerId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| err("bad_request", "printerId is required"))
}

async fn known_printer(b: &Bridge, id: &str) -> Result<(), (&'static str, String)> {
    if b.printers.lock().await.contains_key(id) {
        Ok(())
    } else {
        Err(err("not_found", format!("no printer {id}")))
    }
}

pub(crate) async fn handle(b: &Arc<Bridge>, ctx: &Arc<SessCtx>, method: &str, p: Value) -> Reply {
    let pairing = b
        .remote
        .pairing(&ctx.pairing_id)
        .ok_or_else(|| err("forbidden", "this device is no longer paired"))?;
    match method {
        "host.info" => host_info(b, &pairing),
        "printers.list" => Ok(Value::Array(
            b.printers.lock().await.values().map(|r| r.info.clone()).collect(),
        )),
        "fleets.list" => {
            serde_json::to_value(b.fleets.lock().await.all()).map_err(|_| err("failed", "fleets"))
        }
        "printers.status" => {
            let id = printer_arg(&p)?;
            known_printer(b, &id).await?;
            crate::rpc::printer_status(b, &id).await.map_err(|e| from_rpc(&e))
        }
        "printers.watch" => watch(b, ctx, &p).await,
        "printers.unwatch" => {
            let id = p.get("watchId").and_then(Value::as_str).unwrap_or_default();
            if let Some(h) = lock(&ctx.watches).remove(id) {
                h.abort();
            }
            Ok(json!({}))
        }
        "printers.snapshot" => {
            let id = printer_arg(&p)?;
            known_printer(b, &id).await?;
            let still = still(b, &id).await?;
            Ok(still.filter(|s| s.data.len() <= 512 * 1024).map_or(
                Value::Null,
                |s| json!({ "contentType": s.content_type, "dataB64": ps::b64(&s.data) }),
            ))
        }
        "camera.grab" => {
            let id = printer_arg(&p)?;
            known_printer(b, &id).await?;
            let still = still(b, &id).await?;
            Ok(still.map_or(Value::Null, |s| {
                let data = STANDARD.encode(&s.data);
                if data.len() > MAX_STILL_B64 {
                    return Value::Null;
                }
                let source = if s.source == "snapshot" { "snapshot" } else { "stream" };
                json!({ "contentType": s.content_type, "dataB64": data, "capturedAt": s.captured_at_ms, "source": source })
            }))
        }
        "camera.open" => camera_open(b, ctx, &pairing, &p).await,
        "camera.rtc" => camera_rtc(b, ctx, &pairing, &p).await,
        "camera.quality" => {
            let id = p.get("stream").and_then(Value::as_u64).unwrap_or(0);
            if u32::try_from(id).is_ok_and(|id| lock(&ctx.streams).contains_key(&id)) {
                // Remote streams have one setting: one small frame a second.
                Ok(json!({ "quality": "low" }))
            } else {
                Err(err("not_found", "no such camera stream"))
            }
        }
        "camera.close" => {
            let id = p
                .get("stream")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .unwrap_or(0);
            if let Some(h) = lock(&ctx.streams).remove(&id) {
                h.abort();
            }
            Ok(json!({}))
        }
        "approvals.list" => Ok(approvals_list(b, &pairing)),
        // The relay's numbers for this hub (tier, used, cap), as Settings shows them.
        "remote.quota" => Ok(b.remote.quota().unwrap_or(Value::Null)),
        "approvals.decide" => decide(b, ctx, &pairing, &p).await,
        "jobs.control" => control(b, ctx, &pairing, &p).await,
        "pairing.revoke" => {
            // Reply first: removing the pairing ends the session the reply travels on.
            let (b, id) = (b.clone(), pairing.pairing_id.clone());
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                if crate::remote::call(&b, "remote.pairings.remove", &json!({ "pairingId": id }), None)
                    .is_ok()
                {
                    // The app forgets the phone too, or its next sync would hand the pairing back.
                    b.hub.emit("remote.pairing.revoked", json!({ "pairingId": id }));
                }
            });
            Ok(json!({}))
        }
        _ => Err(err(
            "not_supported",
            format!("{method} is not available over remote access"),
        )),
    }
}

/// Live camera for phones: sealed JPEG frames, one a second, 640 pixels wide, ten minutes a stream.
/// Agents get stills only.
async fn camera_open(b: &Arc<Bridge>, ctx: &Arc<SessCtx>, pairing: &RemotePairing, p: &Value) -> Reply {
    if pairing.kind == PeerKind::Agent {
        return Err(err(
            "forbidden",
            "agents get stills (camera.grab), not live video",
        ));
    }
    let printer = printer_arg(p)?;
    known_printer(b, &printer).await?;
    let id = reserve_stream(ctx)?;
    let (out, sid) = (ctx.out.clone(), ctx.sid.clone());
    let task = tokio::spawn(crate::remote_cam::run(
        b.clone(),
        printer,
        id,
        move |event, data| {
            emit(&out, &sid, event, data);
        },
    ));
    fill_stream(ctx, id, task)?;
    Ok(json!({ "stream": id, "quality": "low" }))
}

/// Direct video: answers the phone's WebRTC offer (complete, no trickle). Phones only, one stream
/// a session, shared with `camera.open`; `camera.close` ends it.
async fn camera_rtc(b: &Arc<Bridge>, ctx: &Arc<SessCtx>, pairing: &RemotePairing, p: &Value) -> Reply {
    if pairing.kind == PeerKind::Agent {
        return Err(err(
            "forbidden",
            "agents get stills (camera.grab), not live video",
        ));
    }
    let printer = printer_arg(p)?;
    known_printer(b, &printer).await?;
    let sdp = p
        .get("sdp")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= crate::remote_rtc::MAX_SDP)
        .ok_or_else(|| err("bad_request", "sdp is the phone's offer"))?;
    // The slot is taken before the await, so two calls at once cannot both pass the check.
    let id = reserve_stream(ctx)?;
    let (out, sid) = (ctx.out.clone(), ctx.sid.clone());
    let started = crate::remote_rtc::start(b, printer, sdp, b.remote.stun(), move |reason| {
        emit(
            &out,
            &sid,
            "camera.ended",
            json!({ "stream": id, "reason": reason }),
        );
    })
    .await;
    let (answer, task) = match started {
        Ok(v) => v,
        Err(e) => {
            if let Some(h) = lock(&ctx.streams).remove(&id) {
                h.abort();
            }
            return Err(e);
        }
    };
    fill_stream(ctx, id, task)?;
    Ok(crate::remote_rtc::reply(id, &answer))
}

/// Takes a live camera slot for this session (one at a time) and returns its stream id. The slot
/// holds a placeholder until `fill_stream` puts the stream's task there.
fn reserve_stream(ctx: &SessCtx) -> Result<u32, (&'static str, String)> {
    let mut streams = lock(&ctx.streams);
    streams.retain(|_, h| !h.is_finished());
    if streams.len() >= crate::remote_cam::STREAMS_PER_SESSION {
        return Err(err("busy", "one live camera at a time over remote access"));
    }
    let id = ctx.next_stream.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    streams.insert(id, tokio::spawn(std::future::pending::<()>()));
    Ok(id)
}

/// Puts a started stream into its reserved slot. A slot closed meanwhile ends the stream.
fn fill_stream(ctx: &SessCtx, id: u32, task: JoinHandle<()>) -> Result<(), (&'static str, String)> {
    let mut streams = lock(&ctx.streams);
    if let Some(slot) = streams.get_mut(&id) {
        std::mem::replace(slot, task).abort();
        return Ok(());
    }
    task.abort();
    Err(err("not_found", "the camera was closed while it opened"))
}

/// A still for remote requests: one fetch per printer at a time, shared for `STILL_FRESH_MS`.
async fn still(b: &Arc<Bridge>, id: &str) -> Result<Option<crate::watch::Still>, (&'static str, String)> {
    let slot = b.remote.still_slot(id);
    let mut cached = slot.lock().await;
    if let Some((at, s)) = cached.as_ref()
        && crate::hub::now_ms().saturating_sub(*at) < STILL_FRESH_MS
    {
        return Ok(s.clone());
    }
    let s = crate::watch::grab(b, id).await.map_err(|e| from_rpc(&e))?;
    *cached = Some((crate::hub::now_ms(), s.clone()));
    Ok(s)
}

fn host_info(b: &Bridge, p: &RemotePairing) -> Reply {
    let identity = b
        .remote
        .host_identity()
        .ok_or_else(|| err("failed", "remote access is not set up"))?;
    Ok(json!({
        "identity": identity,
        "kind": "link",
        "slicing": [],
        "printers": true,
        "camera": true,
        "push": false,
        "rights": {
            "request": p.rights.request,
            "approve": p.rights.approve && p.kind == PeerKind::Phone,
            "introduce": false,
        },
        // The STUN server direct video uses (our own, next to the relay), so the phone does not
        // need a third party's.
        "stun": b.remote.stun(),
    }))
}

async fn watch(b: &Arc<Bridge>, ctx: &Arc<SessCtx>, p: &Value) -> Reply {
    let id = printer_arg(p)?;
    known_printer(b, &id).await?;
    if lock(&ctx.watches).len() >= WATCHES_PER_SESSION {
        return Err(err("busy", "too many printers watched at once"));
    }
    let mut events = Box::pin(
        crate::rpc::printer_events(b, &id)
            .await
            .map_err(|e| from_rpc(&e))?,
    );
    let mut raw = [0u8; 9];
    getrandom::fill(&mut raw).map_err(|_| err("failed", "no randomness"))?;
    let watch_id = ps::b64(&raw);
    let (out, sid, wid, printer) = (ctx.out.clone(), ctx.sid.clone(), watch_id.clone(), id.clone());
    let task = tokio::spawn(async move {
        while let Some(event) = events.next().await {
            emit(
                &out,
                &sid,
                "printer",
                json!({ "watchId": wid, "printerId": printer, "event": event }),
            );
        }
    });
    lock(&ctx.watches).insert(watch_id.clone(), task);
    Ok(json!({ "watchId": watch_id }))
}

/// Cards a phone sees from afar: ones whose work the hub runs itself after a person's answer
/// (agent work, remote pause and cancel) and queued or scheduled plates. Cards whose token goes
/// back to the app that raised them are answered in the app.
fn decidable(b: &Bridge, id: &str) -> bool {
    b.agent_work.holds(id) || b.hub.item_for_request(id).is_some()
}

/// Cards a phone may approve over the relay: pausing or stopping a print, nothing that heats,
/// moves or starts the printer (`docs/safety.md`). Every other card it sees it may only deny.
fn approvable_remotely(b: &Bridge, id: &str) -> bool {
    matches!(b.agent_work.kind(id), Some("pause" | "cancel"))
}

/// A card as a remote device gets it: the broker's request exactly as the phone signs it, and next
/// to it (not inside, so the signed hash is unchanged) the hub's checked summary of the work. The
/// phone recomputes each action's parameter hash from the summary and shows it only on a match.
fn card_view(b: &Bridge, id: &str) -> Option<Value> {
    let request = serde_json::to_value(b.broker.as_ref()?.request(id)?).ok()?;
    let mut view = json!({ "request": request, "source": "host" });
    if let (Some(work), Some(o)) = (b.agent_work.summary(id), view.as_object_mut()) {
        o.insert("work".into(), work);
    }
    if let (Some(name), Some(o)) = (lock(&b.card_partners).get(id).cloned(), view.as_object_mut()) {
        o.insert("partner".into(), json!(name));
    }
    Some(view)
}

fn approvals_list(b: &Bridge, p: &RemotePairing) -> Value {
    let Some(broker) = &b.broker else { return json!([]) };
    if !(p.kind == PeerKind::Phone && p.rights.approve) {
        return json!([]);
    }
    Value::Array(
        broker
            .pending()
            .iter()
            .filter(|id| decidable(b, id))
            .take(200)
            .filter_map(|id| card_view(b, id))
            .collect(),
    )
}

/// The bytes a phone signs for a decision (`decisionBytes` in approval.ts).
fn decision_bytes(p: &Value) -> Option<Vec<u8>> {
    let mut body = json!({
        "requestId": p.get("requestId")?.as_str()?,
        "decision": p.get("decision")?.as_str()?,
        "requestHash": p.get("requestHash")?.as_str()?,
        "at": p.get("at")?.as_u64()?,
    });
    if p.get("bedClear").and_then(Value::as_bool) == Some(true)
        && let Some(o) = body.as_object_mut()
    {
        o.insert("bedClear".into(), json!(true));
    }
    Some(canonical_json(&body).into_bytes())
}

async fn decide(b: &Arc<Bridge>, ctx: &Arc<SessCtx>, pairing: &RemotePairing, p: &Value) -> Reply {
    if !(pairing.kind == PeerKind::Phone && pairing.rights.approve) {
        return Err(err("forbidden", "this device may not approve"));
    }
    let broker = b
        .broker
        .as_ref()
        .ok_or_else(|| err("not_supported", "this hub has no approval broker"))?;
    let id = p
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let request = broker
        .request(&id)
        .filter(|_| broker.pending().contains(&id) && decidable(b, &id))
        .ok_or_else(|| err("not_found", "this request was already decided or has expired"))?;
    let hash = hash_params(&serde_json::to_value(&request).map_err(|_| err("failed", "request"))?);
    let sig = p.get("sig").and_then(Value::as_str).and_then(ps::unb64);
    let public = pairing
        .peer
        .get("signPub")
        .and_then(Value::as_str)
        .and_then(ps::unb64);
    let bytes = decision_bytes(p);
    let signed = match (sig, public, bytes) {
        (Some(sig), Some(public), Some(bytes)) => {
            p.get("requestHash").and_then(Value::as_str) == Some(hash.as_str())
                && ps::verify_sig(&public, "approval", &bytes, &sig)
        }
        _ => false,
    };
    if !signed {
        return Err(err("forbidden", "the decision does not match the request"));
    }
    let decision = p.get("decision").and_then(Value::as_str).unwrap_or_default();
    if decision == "approve" && !approvable_remotely(b, &id) {
        return Err(err(
            "not_supported",
            "approve this in the SlicerX app or at the printer; away from home a phone approves only pausing or stopping a print",
        ));
    }
    let device = pairing.peer.get("deviceId").cloned().unwrap_or(Value::Null);
    b.hub.audit(json!({
        "origin": "phone",
        "via": "relay",
        "action": "approvals.decide",
        "requestId": id,
        "decision": decision,
        "deviceId": device,
        "requestHash": hash,
        "sig": p.get("sig"),
    }));
    if decision == "approve" {
        // A bed answer given from afar is never taken: nobody there can see the plate.
        let out = crate::hub_rpc::grant(b, broker, &json!({ "requestId": id, "bedClear": false }))
            .await
            .map_err(|e| from_rpc(&e))?;
        crate::hub_rpc::resolved(b, &id, true, "phone", None);
        if let Some((owner, work)) = b.agent_work.take(&id) {
            let token = serde_json::from_value(out).map_err(|_| err("failed", "the broker gave no token"))?;
            crate::agent_work::run(b, id.clone(), work, token, owner);
        }
    } else {
        crate::hub_rpc::declined(b, &id);
        broker.deny(&id).map_err(|e| err("bad_request", e.to_string()))?;
        crate::hub_rpc::resolved(b, &id, false, "phone", None);
        let _ = b.agent_work.take(&id);
        if let Some(owner) = lock(&b.card_owners).get(&id).copied() {
            b.hub
                .emit_to("approval.denied", json!({ "requestId": id }), owner);
        }
        if let Some((job, printer)) = lock(&ctx.jobs).remove(&id) {
            ctx.emit(
                "job",
                json!({ "jobId": job, "state": "denied", "printerId": printer }),
            );
        }
    }
    Ok(json!({}))
}

/// The work a remote pause or cancel asks for, and its verb for the approval card.
fn control_work(p: &Value, printer: &str) -> Result<(Work, &'static str), (&'static str, String)> {
    match p.get("action").and_then(Value::as_str) {
        Some("pause") => Ok((
            Work::Pause {
                printer: printer.to_owned(),
            },
            "Pause",
        )),
        Some("cancel") => Ok((
            Work::Cancel {
                printer: printer.to_owned(),
            },
            "Cancel",
        )),
        // Resuming heats and moves the printer, which only a person at the app or the printer may do.
        Some("resume") => Err(err(
            "not_supported",
            "resuming heats and moves the printer; resume it in the app or at the printer",
        )),
        _ => Err(err("bad_request", "action is pause or cancel")),
    }
}

async fn control(b: &Arc<Bridge>, ctx: &Arc<SessCtx>, pairing: &RemotePairing, p: &Value) -> Reply {
    if !pairing.rights.request {
        return Err(err("forbidden", "this device may not send jobs"));
    }
    let broker = b
        .broker
        .as_ref()
        .ok_or_else(|| err("not_supported", "this hub has no approval broker"))?;
    let printer = printer_arg(p)?;
    known_printer(b, &printer).await?;
    let (work, verb) = control_work(p, &printer)?;
    let name = b
        .printers
        .lock()
        .await
        .get(&printer)
        .and_then(|r| r.info.get("name").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| printer.clone());
    let who = pairing
        .peer
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("A paired device")
        .to_owned();
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|_| err("failed", "no randomness"))?;
    let request_id = format!("remote-{}", ps::b64(&raw));
    let job_id = ps::b64(&raw);
    let actions = work
        .actions()
        .into_iter()
        .map(|(action, target, params_hash)| ApprovalAction {
            action,
            target,
            params_hash,
        })
        .collect();
    let now = crate::hub::now_ms();
    let request = ApprovalRequest {
        id: request_id.clone(),
        session_id: format!("remote-{}", ctx.pairing_id),
        tool: if verb == "Pause" {
            "printer.pause"
        } else {
            "printer.cancel"
        }
        .to_owned(),
        permission: PermissionClass::Start,
        title: format!("{verb} the print on {name}?"),
        lines: vec![format!("Asked by {who} over remote access")],
        printer_id: Some(printer.clone()),
        params_hash: hash_params(&json!({ "printerId": printer, "action": verb.to_lowercase() })),
        actions,
        expires_at: crate::hub::iso(now + CARD_TTL_MS),
        origin: Some(if pairing.kind == PeerKind::Agent {
            StartOrigin::Mcp
        } else {
            StartOrigin::Phone
        }),
    };
    let summary = work.summary();
    b.agent_work
        .hold(&request, 0, work, Some(&ctx.pairing_id), |id| broker.is_open(id))
        .map_err(|e| from_rpc(&e))?;
    let mut card = serde_json::to_value(&request).unwrap_or(Value::Null);
    if let Some(o) = card.as_object_mut() {
        o.insert("work".into(), summary);
    }
    if let Err(e) = broker.register(request) {
        let _ = b.agent_work.take(&request_id);
        return Err(err("bad_request", e.to_string()));
    }
    lock(&ctx.jobs).insert(request_id.clone(), (job_id.clone(), printer.clone()));
    b.hub.emit("approval", card);
    b.hub.emit(
        "alert",
        json!({ "printerId": printer, "kind": "approval_waiting", "requestId": request_id, "at": crate::hub::iso(now) }),
    );
    crate::push::alert(b, "approval_waiting", Some(&printer), Some(&request_id));
    ctx.emit(
        "job",
        json!({ "jobId": job_id, "state": "awaiting_approval", "printerId": printer }),
    );
    Ok(json!({ "jobId": job_id, "requestId": request_id }))
}
